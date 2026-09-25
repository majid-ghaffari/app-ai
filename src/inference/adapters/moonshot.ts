import { inlineEvidenceBucket, kimiEvidenceMaxBytes, type Env } from '../../config';
import type {
  CanonicalToolDefinition,
  FilePolicy,
  InferenceContent,
  InferenceEvent,
  InferenceMessage,
  InferenceRequest,
  InferenceResult,
  InferenceStopReason,
  InferenceToolCall,
  InferenceToolResult,
  InferenceBackendName,
  InferenceUsage,
  ModelProfile,
  ProviderContinuationState,
  ProviderName,
} from '../../lib/inference-types';
import {
  InferenceFailure,
  type InferenceProviderAdapter,
  type ProviderFileMetadata,
  type ProviderUploadRequest,
  type ProviderUploadResult,
} from '../adapter';
import { WorkerError } from '../../lib/responses';
import * as kimi from './kimi-wire';
import * as moonshot from './moonshot-wire';
import {
  deleteInlineEvidence,
  getInlineEvidenceMetadata,
  invalidateHostedImages,
  materializeInlineEvidence,
  preflightInlineEvidence,
  uploadInlineEvidence,
} from '../kimi/evidence';
import {
  collectKimiHtmlFragments,
  createKimiHtmlFragmentSelection,
  executeKimiHtmlTool,
  KIMI_HTML_TOOLS,
  prepareKimiHtmlToolRequest,
  replaceKimiHtmlEvidence,
  unicodeSafeSlice,
  type KimiHtmlToolRequest,
} from '../kimi/html-tools';
import { kimiHtmlRetrieval } from '../../prompts';

interface ChatCompletionsFileSupport {
  readonly purpose: string;
  uploadFile(body: FormData, env: Env, abortSignal?: AbortSignal): Promise<Response>;
  getFileMetadata(id: string, env: Env, abortSignal?: AbortSignal): Promise<Response>;
  deleteFile(id: string, env: Env, abortSignal?: AbortSignal): Promise<Response>;
}

export interface ChatCompletionsAccount {
  readonly provider: Extract<ProviderName, 'moonshot' | 'kimi'>;
  readonly backend: InferenceBackendName;
  readonly label: string;
  createChatCompletion(
    payload: Readonly<Record<string, unknown>>,
    env: Env,
    abortSignal?: AbortSignal,
  ): Promise<Response>;
  fileAccountScope(env: Env): Promise<string>;
  readonly modelProfiles: Readonly<Record<string, KimiModelFamily>>;
  readonly files: ChatCompletionsFileSupport | null;
}

type KimiModelFamily = 'k3' | 'k28' | 'k26' | 'k27';
const KIMI_MESSAGE_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_KIMI_HTML_TOOL_TURNS = 8;
const KIMI_IMAGE_ATTEMPTS = 2;
const KIMI_HTML_USER_CONTEXT_CHARACTERS = 100_000;
const KIMI_HTML_TASK_CHARACTERS = 12_000;
const KIMI_HTML_SELECTION_OUTPUT_TOKENS = 2048;

const MOONSHOT_METERED_ACCOUNT: ChatCompletionsAccount = {
  provider: 'moonshot',
  backend: 'moonshot',
  label: 'Moonshot',
  createChatCompletion: moonshot.createChatCompletion,
  fileAccountScope: moonshot.fileAccountScope,
  modelProfiles: {
    'kimi-metered-k3': 'k3',
    'kimi-metered-k26': 'k26',
    'kimi-metered-k27': 'k27',
    'kimi-metered-k27-highspeed': 'k27',
  },
  files: {
    purpose: 'image',
    uploadFile: moonshot.uploadFile,
    getFileMetadata: moonshot.getFileMetadata,
    deleteFile: moonshot.deleteFile,
  },
};

const KIMI_SUBSCRIPTION_ACCOUNT: ChatCompletionsAccount = {
  provider: 'kimi',
  backend: 'kimi',
  label: 'Kimi Code',
  createChatCompletion: kimi.createChatCompletion,
  fileAccountScope: kimi.fileAccountScope,
  modelProfiles: {
    'kimi-code-k3': 'k3',
    'kimi-code-coding': 'k28',
    'kimi-code-highspeed': 'k27',
  },
  files: null,
};

export function listChatCompletionsProfileNames(
  provider: ChatCompletionsAccount['provider'],
): readonly string[] {
  return Object.keys(
    provider === 'moonshot'
      ? MOONSHOT_METERED_ACCOUNT.modelProfiles
      : KIMI_SUBSCRIPTION_ACCOUNT.modelProfiles,
  );
}

interface MoonshotErrorBody {
  error?: { message?: unknown; type?: unknown; code?: unknown } | null;
}

interface MoonshotUsage extends Readonly<Record<string, unknown>> {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface MoonshotAssistantMessage extends Readonly<Record<string, unknown>> {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: readonly MoonshotToolCall[];
}

interface MoonshotToolCall extends Readonly<Record<string, unknown>> {
  id: string;
  type: 'function';
  function: { readonly name: string; readonly arguments: string };
}

interface MoonshotCompletion extends MoonshotErrorBody, Readonly<Record<string, unknown>> {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: readonly [
    {
      readonly index: 0;
      readonly message: MoonshotAssistantMessage;
      readonly finish_reason: string;
    },
  ];
  usage: MoonshotUsage;
}

interface MoonshotChunk extends MoonshotErrorBody, Readonly<Record<string, unknown>> {
  id?: unknown;
  object?: unknown;
  created?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface MoonshotPublicAssistant {
  readonly text: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
}

interface MoonshotContinuationSegment {
  readonly transcript: readonly Record<string, unknown>[];
  readonly publicAssistant: MoonshotPublicAssistant;
}

interface MoonshotContinuationData {
  readonly segments: readonly MoonshotContinuationSegment[];
}

interface MoonshotStateBase {
  readonly priorSegments: readonly MoonshotContinuationSegment[];
  readonly currentSegment: MoonshotContinuationSegment;
}

interface MoonshotTranslation {
  readonly payload: Record<string, unknown>;
  readonly stateBase: MoonshotStateBase;
}

const KIMI_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/heic',
  'image/heif',
]);

export class ChatCompletionsAdapter implements InferenceProviderAdapter {
  readonly provider: ChatCompletionsAccount['provider'];
  readonly apiFamily = 'moonshot-chat-completions' as const;
  readonly requiresOrdinaryTurnContinuation = false;
  readonly continuationOwnsAgentHistory = true;

  constructor(
    protected readonly env: Env,
    private readonly account: ChatCompletionsAccount,
  ) {
    this.provider = account.provider;
  }

  aggregateAgentUsage(usages: readonly InferenceUsage[]): InferenceUsage {
    return aggregateKimiUsage(usages);
  }

  finalizeAgentContinuation(
    state: ProviderContinuationState,
    results: readonly InferenceToolResult[],
  ): ProviderContinuationState {
    const account = this.account;
    const data = continuationData(account, state);
    const current = data.segments.at(-1);
    if (!current) throw new Error(`${account.label} continuation omitted its terminal segment`);
    const terminal = current.transcript.at(-1);
    const expectedCalls =
      terminal?.role === 'assistant'
        ? ((terminal as MoonshotAssistantMessage).tool_calls ?? []).map((call) => call.id)
        : [];
    if (
      expectedCalls.length !== results.length ||
      expectedCalls.some((id, index) => results[index]?.toolCallId !== id)
    ) {
      throw new Error(`${account.label} terminal tool results did not match continuation state`);
    }
    return moonshotState(account, {
      segments: [
        ...data.segments.slice(0, -1),
        {
          publicAssistant: { text: current.publicAssistant.text, toolCalls: [] },
          transcript: [
            ...current.transcript.map((message) => cloneJsonObject(message)),
            ...results.map((result) => ({
              role: 'tool',
              tool_call_id: result.toolCallId,
              content: toolResultText(account, result),
            })),
          ],
        },
      ],
    });
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const account = this.account;
    validateMoonshotPreflight(account, request);
    const translated = toMoonshotPayload(account, request, false);
    const response = await callMoonshot(
      account,
      () => account.createChatCompletion(translated.payload, this.env, request.abortSignal),
      request.abortSignal,
    );
    const data = await readMoonshotJson<unknown>(account, response, request.abortSignal);
    if (!response.ok) throw moonshotFailure(account, response.status, data);
    return completionResult(account, data, request.modelProfile.model, translated.stateBase);
  }

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    const account = this.account;
    validateMoonshotPreflight(account, request);
    const translated = toMoonshotPayload(account, request, true);
    const response = await callMoonshot(
      account,
      () => account.createChatCompletion(translated.payload, this.env, request.abortSignal),
      request.abortSignal,
    );
    if (!response.ok) {
      const data = await readMoonshotJson<unknown>(account, response, request.abortSignal);
      throw moonshotFailure(account, response.status, data);
    }
    if (!response.body)
      throw invalidMoonshotResponse(account, `${account.label} stream omitted a response body`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunk = true;
    let done = false;
    let finishReason: string | null = null;
    let streamId: string | null = null;
    let streamCreated: number | null = null;
    let text = '';
    let reasoning: string | null | undefined;
    let usage: MoonshotUsage | null = null;
    let usageOnlySeen = false;
    let visibleContentStarted = false;
    const calls = new Map<number, AccumulatedToolCall>();

    const processEvent = function* (json: string): Generator<InferenceEvent> {
      if (done)
        throw invalidMoonshotResponse(account, `${account.label} stream emitted data after [DONE]`);
      if (json === '[DONE]') {
        if (finishReason === null) {
          throw invalidMoonshotResponse(
            account,
            `${account.label} stream ended before a finish reason`,
          );
        }
        if (!usage)
          throw invalidMoonshotResponse(
            account,
            `${account.label} stream ended without final usage`,
          );
        if (reasoning === undefined) {
          throw invalidMoonshotResponse(
            account,
            `${account.label} stream omitted required reasoning content`,
          );
        }
        done = true;
        const message = accumulatedAssistantMessage(account, text, reasoning, calls);
        const result = resultFromChoice(
          account,
          message,
          finishReason,
          usage,
          translated.stateBase,
        );
        for (const call of result.toolCalls) yield { type: 'tool-call', call };
        yield { type: 'usage', usage: result.usage };
        yield { type: 'complete', result };
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(json) as unknown;
      } catch (error) {
        throw invalidMoonshotResponse(
          account,
          `${account.label} stream contained invalid JSON`,
          error,
        );
      }
      if (isJsonObject(parsed) && isJsonObject(parsed.error)) {
        throw moonshotFailure(account, null, parsed);
      }
      const chunk = validateChunkEnvelope(
        account,
        parsed,
        streamId,
        request.modelProfile.model,
        streamCreated,
      );
      streamId = chunk.id as string;
      streamCreated = chunk.created as number;

      const choices = chunk.choices as unknown[];
      if (choices.length === 0) {
        if (
          chunk.usage === undefined ||
          chunk.usage === null ||
          usageOnlySeen ||
          finishReason === null
        ) {
          throw invalidMoonshotResponse(
            account,
            `${account.label} emitted an invalid usage-only chunk`,
          );
        }
        const reportedUsage = validateUsage(account, chunk.usage);
        if (usage && !sameJsonValue(usage, reportedUsage)) {
          throw invalidMoonshotResponse(
            account,
            `${account.label} reported conflicting terminal usage`,
          );
        }
        usage = reportedUsage;
        usageOnlySeen = true;
        return;
      }
      if (finishReason !== null) {
        throw invalidMoonshotResponse(
          account,
          `${account.label} stream emitted a choice after its finish reason`,
        );
      }
      const choice = validateStreamChoice(account, choices[0], firstChunk);
      if (
        chunk.usage !== undefined &&
        chunk.usage !== null &&
        choice.usage !== undefined &&
        choice.usage !== null
      ) {
        throw invalidMoonshotResponse(
          account,
          `${account.label} stream reported usage in two locations`,
        );
      }
      const reportedUsage = choice.usage ?? chunk.usage;
      if (reportedUsage !== undefined && reportedUsage !== null) {
        if (usage || choice.finish_reason === null) {
          throw invalidMoonshotResponse(
            account,
            `${account.label} stream reported usage outside its terminal chunk`,
          );
        }
        usage = validateUsage(account, reportedUsage);
      }
      const delta = choice.delta;
      if (firstChunk) {
        firstChunk = false;
        yield { type: 'message-start' };
      }
      if (delta.reasoning_content !== undefined) {
        if (
          (visibleContentStarted || calls.size > 0) &&
          typeof delta.reasoning_content === 'string' &&
          delta.reasoning_content.length > 0
        ) {
          throw invalidMoonshotResponse(
            account,
            `${account.label} reasoning appeared after visible content`,
          );
        }
        reasoning =
          delta.reasoning_content === null
            ? (reasoning ?? null)
            : `${reasoning ?? ''}${delta.reasoning_content}`;
      }
      if (typeof delta.content === 'string') {
        text += delta.content;
        if (delta.content.length > 0) {
          visibleContentStarted = true;
          yield { type: 'text-delta', delta: delta.content };
        }
      }
      if (Array.isArray(delta.tool_calls))
        accumulateToolCallDeltas(account, calls, delta.tool_calls);
      if (choice.finish_reason !== null) finishReason = choice.finish_reason;
    };

    let reachedEof = false;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw moonshotTransportFailure(account, error, request.abortSignal);
        }
        if (chunk.done) {
          reachedEof = true;
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = sseBoundary(buffer)) !== -1) {
          const separatorLength = buffer.startsWith('\r\n\r\n', boundary) ? 4 : 2;
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + separatorLength);
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
            .trim();
          if (!data) continue;
          yield* processEvent(data);
        }
      }
    } finally {
      if (!reachedEof) void reader.cancel().catch(() => undefined);
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      throw invalidMoonshotResponse(
        account,
        `${account.label} stream ended with a truncated event`,
      );
    }
    if (!done)
      throw invalidMoonshotResponse(account, `${account.label} stream ended before data: [DONE]`);
  }

  async getFileScope(policy: FilePolicy): Promise<string> {
    const account = this.account;
    validateFilePolicy(account, policy);
    return account.fileAccountScope(this.env);
  }

  validateUpload(request: { readonly mediaType: string; readonly policy: FilePolicy }): void {
    const account = this.account;
    validateFilePolicy(account, request.policy);
    requireFileSupport(account);
    validateKimiImageMediaType(account, request.mediaType);
  }

  async uploadFile(request: ProviderUploadRequest): Promise<ProviderUploadResult> {
    const account = this.account;
    const files = requireFileSupport(account);
    validateFilePolicy(account, request.policy);
    validateKimiImageMediaType(account, request.mediaType);
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([request.bytes], { type: request.mediaType }),
      request.filename,
    );
    formData.append('purpose', files.purpose);
    const response = await callMoonshot(
      account,
      () => files.uploadFile(formData, this.env, request.abortSignal),
      request.abortSignal,
    );
    const data = await readMoonshotJson<unknown>(account, response, request.abortSignal);
    if (!response.ok) throw moonshotFailure(account, response.status, data);
    const file = validateFileRecord(account, data, undefined, files.purpose);
    return {
      id: file.id,
      mediaType: request.mediaType,
      sizeBytes: file.bytes,
      expiresAt: null,
    };
  }

  async getFileMetadata(
    id: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderFileMetadata | null> {
    const account = this.account;
    const files = requireFileSupport(account);
    const response = await callMoonshot(
      account,
      () => files.getFileMetadata(id, this.env, abortSignal),
      abortSignal,
    );
    if (response.status === 404) return null;
    const data = await readMoonshotJson<unknown>(account, response, abortSignal);
    if (!response.ok) throw moonshotFailure(account, response.status, data);
    const file = validateFileRecord(account, data, id, files.purpose);
    return { id: file.id, mediaType: null, sizeBytes: file.bytes, expiresAt: null };
  }

  async deleteFile(id: string, abortSignal?: AbortSignal): Promise<void> {
    const account = this.account;
    const files = requireFileSupport(account);
    const response = await callMoonshot(
      account,
      () => files.deleteFile(id, this.env, abortSignal),
      abortSignal,
    );
    const data = await readMoonshotJson<unknown>(account, response, abortSignal);
    if (!response.ok) throw moonshotFailure(account, response.status, data);
    if (!isJsonObject(data) || data.id !== id || data.object !== 'file' || data.deleted !== true) {
      throw invalidMoonshotResponse(account, `${account.label} file deletion response was invalid`);
    }
  }
}

export class MoonshotChatCompletionsAdapter extends ChatCompletionsAdapter {
  constructor(env: Env) {
    super(env, MOONSHOT_METERED_ACCOUNT);
  }
}

export class KimiChatCompletionsAdapter extends ChatCompletionsAdapter {
  private readonly htmlDocuments = new Map<string, Promise<string>>();
  private readonly htmlSelections = new Map<
    string,
    {
      readonly selection: Promise<{
        readonly fragments: ReadonlyMap<string, readonly string[]>;
        readonly usages: readonly InferenceUsage[];
      }>;
      usageClaimed: boolean;
    }
  >();

  constructor(env: Env) {
    super(env, KIMI_SUBSCRIPTION_ACCOUNT);
  }

  override async complete(request: InferenceRequest): Promise<InferenceResult> {
    validateMoonshotPreflight(KIMI_SUBSCRIPTION_ACCOUNT, request);
    preflightInlineEvidence(this.env, request);
    const html = await prepareKimiHtmlToolRequest(this.env, request, this.htmlDocuments);
    const source = html?.request ?? request;
    for (let attempt = 0; attempt < KIMI_IMAGE_ATTEMPTS; attempt += 1) {
      const prepared = await materializeInlineEvidence(this.env, source, this.uploadHostedImage);
      try {
        if (html) {
          const selected = await this.selectLargeHtml(prepared, html);
          const result = await super.complete(selected.request);
          const completed = {
            ...result,
            usage: aggregateKimiUsage([...selected.usages, result.usage]),
          };
          this.claimHtmlSelectionUsage(html.cacheKey);
          return completed;
        }
        return await super.complete(prepared);
      } catch (error) {
        if (attempt + 1 >= KIMI_IMAGE_ATTEMPTS || !(await this.retryExpiredImage(error, request)))
          throw error;
      }
    }
    throw new Error('Kimi Code image recovery exhausted its retry');
  }

  private async selectLargeHtml(
    prepared: InferenceRequest,
    html: KimiHtmlToolRequest,
  ): Promise<{ request: InferenceRequest; usages: readonly InferenceUsage[] }> {
    let entry = this.htmlSelections.get(html.cacheKey);
    const created = !entry;
    if (!entry) {
      entry = { selection: this.collectLargeHtml(prepared, html), usageClaimed: false };
      this.htmlSelections.set(html.cacheKey, entry);
    }
    try {
      const selected = await entry.selection;
      return {
        request: replaceKimiHtmlEvidence(html, prepared, selected.fragments),
        usages: entry.usageClaimed ? [] : selected.usages,
      };
    } catch (error) {
      if (created) this.htmlSelections.delete(html.cacheKey);
      throw error;
    }
  }

  private claimHtmlSelectionUsage(cacheKey: string): void {
    const entry = this.htmlSelections.get(cacheKey);
    if (entry) entry.usageClaimed = true;
  }

  private async collectLargeHtml(
    prepared: InferenceRequest,
    html: KimiHtmlToolRequest,
  ): Promise<{
    readonly fragments: ReadonlyMap<string, readonly string[]>;
    readonly usages: readonly InferenceUsage[];
  }> {
    const selection = createKimiHtmlFragmentSelection(html.documents.keys());
    const fragments = selection.fragments;
    const imageParts = prepared.messages
      .flatMap((message) => message.content)
      .filter(
        (part): part is Extract<InferenceContent, { type: 'image' }> => part.type === 'image',
      );
    const userText = prepared.messages
      .flatMap((message) => message.content)
      .filter((part): part is Extract<InferenceContent, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const userContext = unicodeSafeSlice(
      userText,
      Math.max(0, userText.length - KIMI_HTML_USER_CONTEXT_CHARACTERS),
      userText.length,
    );
    const seed: InferenceRequest = {
      prompt: kimiHtmlRetrieval,
      promptGroup: prepared.promptGroup,
      modelProfile: prepared.modelProfile,
      filePolicy: prepared.filePolicy,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Task instructions: ${unicodeSafeSlice(prepared.prompt, 0, KIMI_HTML_TASK_CHARACTERS)}\nUser context: ${userContext}\n` +
                [...html.documents]
                  .map(([name, text]) => `Stored HTML ${name}: ${text.length} characters`)
                  .join('\n'),
              cache: 'none',
            },
            ...imageParts,
          ],
        },
      ],
      maxOutputTokens: KIMI_HTML_SELECTION_OUTPUT_TOKENS,
      tools: KIMI_HTML_TOOLS,
      toolChoice: { mode: 'auto' },
      ...(prepared.effort ? { effort: prepared.effort } : {}),
      ...(prepared.abortSignal ? { abortSignal: prepared.abortSignal } : {}),
    };
    let messages: readonly InferenceMessage[] = seed.messages;
    let continuation: ProviderContinuationState | undefined;
    const usages: InferenceUsage[] = [];
    let inspected = false;
    for (let turn = 0; turn < MAX_KIMI_HTML_TOOL_TURNS; turn += 1) {
      const result = await super.complete({
        ...seed,
        messages,
        ...(continuation ? { continuation } : {}),
      });
      usages.push(result.usage);
      if (result.toolCalls.length === 0) {
        if (
          !inspected ||
          result.stopReason !== 'completed' ||
          [...fragments.values()].some((selected) => selected.length === 0)
        ) {
          throw invalidMoonshotResponse(
            KIMI_SUBSCRIPTION_ACCOUNT,
            'Kimi Code did not inspect every stored HTML document',
          );
        }
        return { fragments, usages };
      }
      if (!result.providerState || result.stopReason !== 'tool-call') {
        throw invalidMoonshotResponse(
          KIMI_SUBSCRIPTION_ACCOUNT,
          'Kimi Code HTML retrieval omitted continuation state',
        );
      }
      const toolResults = result.toolCalls
        .map((call) => executeKimiHtmlTool(call, html.documents))
        .map((toolResult) => collectKimiHtmlFragments(toolResult, selection));
      inspected ||= toolResults.some((toolResult) => !toolResult.isError);
      messages = [
        ...seed.messages,
        { role: 'assistant', content: result.content, providerState: result.providerState },
        { role: 'user', content: toolResults },
      ];
      continuation = result.providerState;
    }
    throw invalidMoonshotResponse(
      KIMI_SUBSCRIPTION_ACCOUNT,
      'Kimi Code HTML retrieval exceeded its tool-turn limit',
    );
  }

  override async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    validateMoonshotPreflight(KIMI_SUBSCRIPTION_ACCOUNT, request);
    preflightInlineEvidence(this.env, request);
    const html = await prepareKimiHtmlToolRequest(this.env, request, this.htmlDocuments);
    const source = html?.request ?? request;
    let retried = false;
    while (true) {
      let emitted = false;
      try {
        const prepared = await materializeInlineEvidence(this.env, source, this.uploadHostedImage);
        const selected = html ? await this.selectLargeHtml(prepared, html) : null;
        for await (const event of super.stream(selected?.request ?? prepared)) {
          emitted = true;
          if (selected && event.type === 'usage') {
            yield { ...event, usage: aggregateKimiUsage([...selected.usages, event.usage]) };
          } else if (selected && event.type === 'complete') {
            yield {
              ...event,
              result: {
                ...event.result,
                usage: aggregateKimiUsage([...selected.usages, event.result.usage]),
              },
            };
          } else {
            yield event;
          }
        }
        if (html) this.claimHtmlSelectionUsage(html.cacheKey);
        return;
      } catch (error) {
        if (emitted || retried || !(await this.retryExpiredImage(error, request))) throw error;
        retried = true;
      }
    }
  }

  private async retryExpiredImage(error: unknown, request: InferenceRequest): Promise<boolean> {
    return (
      error instanceof InferenceFailure &&
      error.inferenceError.status === 404 &&
      error.inferenceError.code === 'resource_not_found_error' &&
      (await invalidateHostedImages(this.env, request))
    );
  }

  private readonly uploadHostedImage = async (
    bytes: Uint8Array,
    mediaType: string,
    abortSignal?: AbortSignal,
  ): Promise<string> => {
    validateKimiImageMediaType(KIMI_SUBSCRIPTION_ACCOUNT, mediaType);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mediaType }), 'evidence');
    form.append('purpose', 'image');
    const response = await callMoonshot(
      KIMI_SUBSCRIPTION_ACCOUNT,
      () => kimi.uploadImage(form, this.env, abortSignal),
      abortSignal,
    );
    const data = await readMoonshotJson<unknown>(KIMI_SUBSCRIPTION_ACCOUNT, response, abortSignal);
    if (!response.ok) throw moonshotFailure(KIMI_SUBSCRIPTION_ACCOUNT, response.status, data);
    return validateFileRecord(KIMI_SUBSCRIPTION_ACCOUNT, data, undefined, 'image').id;
  };

  override validateUpload(request: {
    readonly sizeBytes: number;
    readonly mediaType: string;
    readonly policy: FilePolicy;
  }): void {
    this.validateEvidenceUpload(request.sizeBytes, request.mediaType, request.policy);
  }

  override async uploadFile(request: ProviderUploadRequest): Promise<ProviderUploadResult> {
    const mediaType = request.mediaType.toLowerCase();
    this.validateEvidenceUpload(request.bytes.byteLength, mediaType, request.policy);
    if (mediaType === 'text/plain') validateUtf8Evidence(request.bytes);
    return uploadInlineEvidence(this.env, request.bytes, mediaType, request.abortSignal);
  }

  private validateEvidenceUpload(sizeBytes: number, mediaType: string, policy: FilePolicy): void {
    if (policy.name !== 'kimi-stored-evidence' || policy.inputMode !== 'worker-file') {
      throw new WorkerError('Kimi Code requires its worker-managed evidence policy', {
        status: 400,
        exceptionType: 'ArgumentException',
      });
    }
    if (sizeBytes > kimiEvidenceMaxBytes(this.env)) {
      throw new WorkerError('Kimi Code evidence exceeds the configured upload limit', {
        status: 413,
        exceptionType: 'ArgumentException',
      });
    }
    if (
      mediaType.toLowerCase() !== 'text/plain' &&
      !KIMI_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())
    ) {
      throw new WorkerError(`Kimi Code evidence does not support ${mediaType}`, {
        status: 400,
        exceptionType: 'ArgumentException',
      });
    }
    inlineEvidenceBucket(this.env);
  }

  override getFileMetadata(id: string): Promise<ProviderFileMetadata | null> {
    return getInlineEvidenceMetadata(this.env, id);
  }

  override deleteFile(id: string): Promise<void> {
    return deleteInlineEvidence(this.env, id);
  }
}

function requireFileSupport(account: ChatCompletionsAccount): ChatCompletionsFileSupport {
  if (!account.files) {
    throw new Error(`${account.label} does not expose a managed file lifecycle for this policy`);
  }
  return account.files;
}

function argumentError(message: string, status = 400): WorkerError {
  return new WorkerError(message, { status, exceptionType: 'ArgumentException' });
}

function validateMoonshotPreflight(
  account: ChatCompletionsAccount,
  request: InferenceRequest,
): void {
  validateRequestRoute(account, request);
  const modelFamily = kimiModelFamily(account, request.modelProfile);
  if (request.effort && modelFamily !== 'k3' && modelFamily !== 'k28') {
    throw argumentError(
      'Canonical semantic effort is supported only by the Kimi K3 and K2.8 candidates',
    );
  }
  request.tools.forEach((tool) => toMoonshotTool(account, tool));
  if (request.toolChoice) {
    if (request.toolChoice.mode === 'specific' && modelFamily !== 'k3') {
      throw argumentError('Specific tool choice is supported only by the Kimi K3 candidate');
    }
    if (request.toolChoice.mode === 'required' && modelFamily !== 'k3') {
      throw argumentError('Required tool choice is supported only by the Kimi K3 candidate');
    }
    if (request.toolChoice.disableParallel !== undefined) {
      throw argumentError(
        `${account.label} does not expose a documented parallel-tool-call control`,
      );
    }
  }
  if (request.sampling) {
    throw argumentError(
      `${account.label} model sampling values are provider-fixed and cannot be overridden`,
    );
  }
  if (request.stopSequences && request.stopSequences.length > 5) {
    throw argumentError(`${account.label} Chat Completions supports at most 5 stop sequences`);
  }
  for (const stop of request.stopSequences ?? []) {
    if (new TextEncoder().encode(stop).length > 32) {
      throw argumentError(`${account.label} stop sequences cannot exceed 32 bytes`);
    }
  }
  if (request.metadata) {
    throw argumentError(`${account.label} Chat Completions does not support canonical metadata`);
  }
  if (request.serviceTier) {
    throw argumentError(
      `${account.label} Chat Completions does not support canonical service tiers`,
    );
  }
  request.messages.forEach((message) =>
    message.content.forEach((content) => validateContentBeforeEvidence(account, content)),
  );
}

function validateContentBeforeEvidence(
  account: ChatCompletionsAccount,
  content: InferenceContent,
): void {
  if (content.type === 'tool-result') {
    if (content.content.some((part) => part.type !== 'text')) {
      throw argumentError(`${account.label} tool results support only text content`);
    }
    return;
  }
  if (content.type === 'image') {
    if (content.source.type === 'url') {
      throw argumentError(`${account.label} vision does not support external image URLs`);
    }
    if (content.source.type === 'base64') {
      validateKimiImageMediaType(account, content.source.mediaType);
    }
    if (content.source.type === 'provider-file' && content.source.reference.mediaType) {
      validateKimiImageMediaType(account, content.source.reference.mediaType);
    }
    return;
  }
  if (content.type !== 'document') return;
  if (content.citations !== undefined) {
    throw argumentError(
      `${account.label} direct document input does not support citation controls`,
    );
  }
  if (content.source.type === 'content' && Array.isArray(content.source.content)) {
    content.source.content.forEach((part) => validateContentBeforeEvidence(account, part));
    return;
  }
  if (content.source.type === 'base64') {
    if (!content.source.mediaType.startsWith('image/')) {
      throw argumentError(
        `${account.label} direct document input supports only text or image content`,
      );
    }
    validateKimiImageMediaType(account, content.source.mediaType);
    return;
  }
  if (content.source.type === 'url') {
    throw argumentError(`${account.label} direct document input does not support external URLs`);
  }
  if (content.source.type === 'file') {
    throw argumentError(`${account.label} received an unresolved public file reference`);
  }
  if (
    content.source.type === 'provider-file' &&
    content.source.reference.mediaType?.startsWith('image/')
  ) {
    validateKimiImageMediaType(account, content.source.reference.mediaType);
  }
}

function toMoonshotPayload(
  account: ChatCompletionsAccount,
  request: InferenceRequest,
  stream: boolean,
): MoonshotTranslation {
  const modelFamily = kimiModelFamily(account, request.modelProfile);
  const translatedMessages = toMoonshotMessages(account, request);
  const payload: Record<string, unknown> = {
    model: request.modelProfile.model,
    messages: [{ role: 'system', content: request.prompt }, ...translatedMessages.messages],
    max_completion_tokens: request.maxOutputTokens,
  };
  if (stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  if (modelFamily === 'k26') payload.thinking = { type: 'enabled', keep: 'all' };
  if (modelFamily === 'k27') payload.thinking = { type: 'enabled', keep: 'all' };
  if (request.effort) payload.reasoning_effort = moonshotEffort(request.effort);
  if (request.structuredOutput) {
    payload.response_format = {
      type: 'json_schema',
      json_schema: {
        name: request.structuredOutput.name,
        schema: request.structuredOutput.schema,
        strict: request.structuredOutput.strict,
      },
    };
  }
  if (request.tools.length > 0)
    payload.tools = request.tools.map((tool) => toMoonshotTool(account, tool));
  if (request.toolChoice) {
    payload.tool_choice = toMoonshotToolChoice(request.toolChoice);
  }
  if (request.stopSequences?.length) {
    payload.stop = [...request.stopSequences];
  }
  if (
    account.provider === 'kimi' &&
    new TextEncoder().encode(JSON.stringify(payload)).byteLength > KIMI_MESSAGE_LIMIT_BYTES
  ) {
    throw new WorkerError('Kimi Code request exceeds the 2 MiB message limit', {
      status: 413,
      exceptionType: 'ArgumentException',
    });
  }
  return { payload, stateBase: translatedMessages.stateBase };
}

function toMoonshotMessages(
  account: ChatCompletionsAccount,
  request: InferenceRequest,
): {
  messages: Record<string, unknown>[];
  stateBase: MoonshotStateBase;
} {
  const messages: Record<string, unknown>[] = [];
  const continuation = continuationData(account, request.continuation);
  const segments = continuation.segments;
  const assistantIndexes = request.messages.flatMap((message, index) =>
    message.role === 'assistant' ? [index] : [],
  );
  const internalContinuation = request.messages.some(
    (message) => message.providerState !== undefined,
  );
  const hasToolHistory = request.messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.content.some((content) => content.type === 'tool-call'),
  );
  if (hasToolHistory && !request.continuation && !internalContinuation) {
    throw argumentError(
      `${account.label} assistant history requires authenticated continuation state`,
    );
  }
  if (segments.length > 0 && !internalContinuation) {
    if (segments.length > assistantIndexes.length) {
      throw new Error(`${account.label} continuation could not be attached to request history`);
    }
    const segmentByIndex = new Map<number, MoonshotContinuationSegment>();
    const start = assistantIndexes.length - segments.length;
    segments.forEach((segment, index) => {
      const messageIndex = assistantIndexes[start + index];
      if (messageIndex === undefined) {
        throw new Error(`${account.label} continuation could not be attached to request history`);
      }
      segmentByIndex.set(messageIndex, segment);
    });
    request.messages.forEach((message, index) => {
      const segment = segmentByIndex.get(index);
      if (segment) {
        if (
          message.role !== 'assistant' ||
          !assistantMatchesPublic(message, segment.publicAssistant)
        ) {
          throw new Error(`${account.label} continuation did not match its public assistant turn`);
        }
        messages.push(...segment.transcript.map((item) => cloneJsonObject(item)));
        return;
      }
      messages.push(...toMoonshotMessage(account, message));
    });
    return {
      messages,
      stateBase: { priorSegments: segments, currentSegment: emptyContinuationSegment() },
    };
  }
  if (segments.length === 0) {
    request.messages.forEach((message) => messages.push(...toMoonshotMessage(account, message)));
    return {
      messages,
      stateBase: { priorSegments: [], currentSegment: emptyContinuationSegment() },
    };
  }
  const currentSegment = segments.at(-1);
  if (!currentSegment)
    throw new Error(`${account.label} continuation state omitted its current segment`);
  const currentAssistant = currentSegment.transcript.at(-1);
  if (!currentAssistant || currentAssistant.role !== 'assistant') {
    throw new Error(
      `${account.label} continuation current segment did not end in an assistant message`,
    );
  }
  const stateOwnerIndexes = request.messages.flatMap((message, index) =>
    message.providerState !== undefined ? [index] : [],
  );
  if (stateOwnerIndexes.length !== 1) {
    throw new Error(`${account.label} continuation requires exactly one assistant-owned state`);
  }
  const stateOwnerIndex = stateOwnerIndexes[0];
  if (stateOwnerIndex === undefined || request.messages[stateOwnerIndex]?.role !== 'assistant') {
    throw new Error(`${account.label} continuation state belongs only to assistant messages`);
  }
  const priorSegments = segments.slice(0, -1);
  const priorAssistantIndexes = assistantIndexes.filter((index) => index < stateOwnerIndex);
  if (priorSegments.length > priorAssistantIndexes.length) {
    throw new Error(`${account.label} prior continuation could not be attached to request history`);
  }
  const priorSegmentByIndex = new Map<number, MoonshotContinuationSegment>();
  const priorStart = priorAssistantIndexes.length - priorSegments.length;
  priorSegments.forEach((segment, index) => {
    const messageIndex = priorAssistantIndexes[priorStart + index];
    if (messageIndex === undefined) {
      throw new Error(
        `${account.label} prior continuation could not be attached to request history`,
      );
    }
    priorSegmentByIndex.set(messageIndex, segment);
  });
  let stateAssistantIndex = -1;
  request.messages.forEach((message, index) => {
    const priorSegment = priorSegmentByIndex.get(index);
    if (priorSegment) {
      if (
        message.role !== 'assistant' ||
        !assistantMatchesPublic(message, priorSegment.publicAssistant)
      ) {
        throw new Error(
          `${account.label} prior continuation did not match its public assistant turn`,
        );
      }
      messages.push(...priorSegment.transcript.map((item) => cloneJsonObject(item)));
      return;
    }
    const stateAssistant = message.providerState
      ? continuationData(account, message.providerState).segments.at(-1)?.transcript.at(-1)
      : undefined;
    if (stateAssistant) {
      if (message.role !== 'assistant') {
        throw new Error(`${account.label} continuation state belongs only to assistant messages`);
      }
      if (canonicalJson(stateAssistant) !== canonicalJson(currentAssistant)) {
        throw new Error(
          `${account.label} continuation did not match assistant-owned provider state`,
        );
      }
      const transcript = currentSegment.transcript.map((item) => cloneJsonObject(item));
      const terminal = transcript.at(-1);
      if (!terminal || terminal.role !== 'assistant') {
        throw new Error(`${account.label} continuation transcript omitted its terminal assistant`);
      }
      transcript[transcript.length - 1] = assistantMessageFromState(
        account,
        stateAssistant as MoonshotAssistantMessage,
        message,
      );
      messages.push(...transcript);
      stateAssistantIndex = messages.length - 1;
      return;
    }
    messages.push(...toMoonshotMessage(account, message));
  });
  if (stateAssistantIndex < 0) {
    throw new Error(`${account.label} continuation could not be attached to assistant-owned state`);
  }
  return {
    messages,
    stateBase: {
      priorSegments,
      currentSegment: {
        publicAssistant: currentSegment.publicAssistant,
        transcript: [
          ...currentSegment.transcript.map((item) => cloneJsonObject(item)),
          ...messages.slice(stateAssistantIndex + 1).map((item) => cloneJsonObject(item)),
        ],
      },
    },
  };
}

function toMoonshotMessage(
  account: ChatCompletionsAccount,
  message: InferenceMessage,
): Record<string, unknown>[] {
  if (message.role === 'assistant') return [canonicalAssistantMessage(account, message)];
  const output: Record<string, unknown>[] = [];
  let content: Record<string, unknown>[] = [];
  const flush = () => {
    if (content.length === 0) return;
    output.push({ role: message.role, content: collapseContent(content) });
    content = [];
  };
  for (const item of message.content) {
    if (item.type === 'tool-call') {
      throw new Error(`${account.label} tool calls must belong to assistant messages`);
    }
    if (item.type === 'tool-result') {
      flush();
      output.push({
        role: 'tool',
        tool_call_id: item.toolCallId,
        content: toolResultText(account, item),
      });
      continue;
    }
    content.push(...toMoonshotContent(account, item));
  }
  flush();
  if (output.length === 0) output.push({ role: message.role, content: '' });
  return output;
}

function canonicalAssistantMessage(
  account: ChatCompletionsAccount,
  message: InferenceMessage,
): Record<string, unknown> {
  const texts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const item of message.content) {
    if (item.type === 'text') {
      texts.push(item.text);
      continue;
    }
    if (item.type === 'tool-call') {
      toolCalls.push({
        id: item.id,
        type: 'function',
        function: { name: item.name, arguments: JSON.stringify(item.input) },
      });
      continue;
    }
    throw new Error(`${account.label} assistant messages cannot contain ${item.type}`);
  }
  return {
    role: 'assistant',
    content: texts.join(''),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function assistantMessageFromState(
  account: ChatCompletionsAccount,

  assistant: MoonshotAssistantMessage,
  canonical: InferenceMessage,
): Record<string, unknown> {
  if (!assistantMatchesCanonical(assistant, canonical)) {
    throw new Error(
      `${account.label} continuation state did not match its canonical assistant message`,
    );
  }
  return cloneJsonObject(assistant);
}

function assistantMatchesCanonical(
  assistant: MoonshotAssistantMessage,
  canonical: InferenceMessage,
): boolean {
  const text: string[] = [];
  const canonicalCalls: Extract<InferenceContent, { type: 'tool-call' }>[] = [];
  for (const item of canonical.content) {
    if (item.type === 'text') {
      text.push(item.text);
      continue;
    }
    if (item.type === 'tool-call') {
      canonicalCalls.push(item);
      continue;
    }
    return false;
  }
  if ((assistant.content ?? '') !== text.join('')) return false;
  const providerCalls = assistant.tool_calls ?? [];
  if (providerCalls.length !== canonicalCalls.length) return false;
  return providerCalls.every((providerCall, index) => {
    const canonicalCall = canonicalCalls[index];
    if (
      !canonicalCall ||
      providerCall.id !== canonicalCall.id ||
      providerCall.function.name !== canonicalCall.name
    ) {
      return false;
    }
    try {
      const input = JSON.parse(providerCall.function.arguments) as unknown;
      return isJsonObject(input) && canonicalJson(input) === canonicalJson(canonicalCall.input);
    } catch {
      return false;
    }
  });
}

function assistantMatchesPublic(
  canonical: InferenceMessage,
  expected: MoonshotPublicAssistant,
): boolean {
  const text: string[] = [];
  const toolCalls: MoonshotPublicAssistant['toolCalls'][number][] = [];
  for (const item of canonical.content) {
    if (item.type === 'text') {
      text.push(item.text);
      continue;
    }
    if (item.type === 'tool-call') {
      toolCalls.push({ id: item.id, name: item.name, input: item.input });
      continue;
    }
    return false;
  }
  return (
    text.join('') === expected.text &&
    canonicalJson(toolCalls) === canonicalJson(expected.toolCalls)
  );
}

function toMoonshotContent(
  account: ChatCompletionsAccount,

  item: Exclude<InferenceContent, { type: 'tool-call' | 'tool-result' }>,
): Record<string, unknown>[] {
  if (item.type === 'text') return [{ type: 'text', text: item.text }];
  if (item.type === 'image') return [toMoonshotImage(account, item)];
  if (item.citations !== undefined) {
    throw argumentError(
      `${account.label} direct document input does not support citation controls`,
    );
  }
  const prefix = [item.title, item.context].filter(Boolean).join('\n');
  if (item.source.type === 'text') {
    return [{ type: 'text', text: `${prefix ? `${prefix}\n` : ''}${item.source.text}` }];
  }
  if (item.source.type === 'content') {
    const nested =
      typeof item.source.content === 'string'
        ? [{ type: 'text', text: item.source.content }]
        : item.source.content.flatMap((content) => toMoonshotContent(account, content));
    return prefix ? [{ type: 'text', text: prefix }, ...nested] : nested;
  }
  if (item.source.type === 'base64' && item.source.mediaType.startsWith('image/')) {
    validateKimiImageMediaType(account, item.source.mediaType);
    return [
      ...(prefix ? [{ type: 'text', text: prefix }] : []),
      {
        type: 'image_url',
        image_url: { url: `data:${item.source.mediaType};base64,${item.source.data}` },
      },
    ];
  }
  if (
    item.source.type === 'provider-file' &&
    item.source.reference.mediaType?.startsWith('image/')
  ) {
    validateKimiImageMediaType(account, item.source.reference.mediaType);
    if (
      account.provider !== 'kimi' ||
      item.source.reference.filePolicy !== 'kimi-stored-evidence'
    ) {
      requireFileSupport(account);
    }
    if (item.source.reference.provider !== account.provider) {
      throw argumentError(
        `${account.label} cannot consume ${item.source.reference.provider} file references`,
      );
    }
    return [
      ...(prefix ? [{ type: 'text', text: prefix }] : []),
      {
        type: 'image_url',
        image_url: { url: `ms://${item.source.reference.upstreamFileId}` },
      },
    ];
  }
  throw argumentError(`${account.label} direct document input supports only text or image content`);
}

function toMoonshotImage(
  account: ChatCompletionsAccount,

  item: Extract<InferenceContent, { type: 'image' }>,
): Record<string, unknown> {
  const source = item.source;
  if (source.type === 'base64') {
    validateKimiImageMediaType(account, source.mediaType);
    return {
      type: 'image_url',
      image_url: { url: `data:${source.mediaType};base64,${source.data}` },
    };
  }
  if (source.type === 'url') {
    throw argumentError(`${account.label} vision does not support external image URLs`);
  }
  if (source.type === 'provider-file') {
    if (account.provider !== 'kimi' || source.reference.filePolicy !== 'kimi-stored-evidence') {
      requireFileSupport(account);
    }
    if (source.reference.provider !== account.provider) {
      throw argumentError(
        `${account.label} cannot consume ${source.reference.provider} file references`,
      );
    }
    if (source.reference.mediaType === null) {
      throw argumentError(`${account.label} image file reference omitted its validated media type`);
    }
    validateKimiImageMediaType(account, source.reference.mediaType);
    return {
      type: 'image_url',
      image_url: { url: `ms://${source.reference.upstreamFileId}` },
    };
  }
  throw new Error(`${account.label} received an unresolved public file reference`);
}

function collapseContent(
  content: readonly Record<string, unknown>[],
): string | Record<string, unknown>[] {
  return content.length === 1 && content[0]?.type === 'text'
    ? String(content[0].text ?? '')
    : [...content];
}

function toolResultText(
  account: ChatCompletionsAccount,
  item: Extract<InferenceContent, { type: 'tool-result' }>,
): string {
  const parts: string[] = [];
  for (const content of item.content) {
    if (content.type !== 'text') {
      throw argumentError(`${account.label} tool results support only text content`);
    }
    parts.push(content.text);
  }
  const text = parts.join('\n');
  return item.isError ? `[tool error]\n${text}` : text;
}

function toMoonshotTool(
  account: ChatCompletionsAccount,
  tool: CanonicalToolDefinition,
): Record<string, unknown> {
  if (tool.execution === 'provider') {
    throw argumentError(
      `${account.label} provider-hosted tools are not supported by this candidate profile`,
    );
  }
  if (
    tool.kind !== undefined ||
    tool.allowedCallers !== undefined ||
    tool.deferLoading !== undefined ||
    tool.inputExamples !== undefined ||
    tool.eagerInputStreaming !== undefined
  ) {
    throw argumentError(
      `${account.label} cannot serialize provider-specific options for tool ${tool.name}`,
    );
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

function toMoonshotToolChoice(
  choice: NonNullable<InferenceRequest['toolChoice']>,
): string | Record<string, unknown> {
  if (choice.mode === 'specific') {
    return { type: 'function', function: { name: choice.name } };
  }
  return choice.mode;
}

function moonshotEffort(effort: NonNullable<InferenceRequest['effort']>): 'low' | 'high' | 'max' {
  if (effort === 'low') return 'low';
  if (effort === 'xhigh') return 'max';
  return 'high';
}

function completionResult(
  account: ChatCompletionsAccount,

  raw: unknown,
  expectedModel: string,
  stateBase: MoonshotStateBase,
): InferenceResult {
  const data = validateCompletion(account, raw, expectedModel);
  const choice = data.choices[0];
  return resultFromChoice(account, choice.message, choice.finish_reason, data.usage, stateBase);
}

function resultFromChoice(
  account: ChatCompletionsAccount,

  message: MoonshotAssistantMessage,
  finishReason: string,
  usage: MoonshotUsage,
  stateBase: MoonshotStateBase,
): InferenceResult {
  const content: InferenceContent[] = [];
  if (message.content) content.push({ type: 'text', text: message.content, cache: 'none' });
  const calls = (message.tool_calls ?? []).map((call) => parseToolCall(account, call));
  if ((finishReason === 'tool_calls') !== calls.length > 0) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} finish reason did not match its tool calls`,
    );
  }
  if (finishReason === 'stop' && !message.content && calls.length === 0) {
    throw invalidMoonshotResponse(account, `${account.label} returned an empty terminal turn`);
  }
  const publicText = [stateBase.currentSegment.publicAssistant.text, message.content ?? '']
    .filter((value) => value.length > 0)
    .join('\n');
  const state = moonshotState(account, {
    segments: [
      ...stateBase.priorSegments,
      {
        transcript: [...stateBase.currentSegment.transcript, cloneJsonObject(message)],
        publicAssistant: {
          text: publicText,
          toolCalls:
            finishReason === 'tool_calls'
              ? [
                  ...stateBase.currentSegment.publicAssistant.toolCalls,
                  ...calls.map((call) => ({ id: call.id, name: call.name, input: call.input })),
                ]
              : [],
        },
      },
    ],
  });
  const callsWithState = calls.map((call) => ({ ...call, providerState: state }));
  content.push(...callsWithState);
  return {
    content,
    toolCalls: callsWithState,
    usage: normalizeUsage(usage),
    stopReason: normalizeStopReason(finishReason),
    providerStopReason: finishReason,
    providerState: state,
  };
}

function validateCompletion(
  account: ChatCompletionsAccount,
  raw: unknown,
  expectedModel: string,
): MoonshotCompletion {
  if (!isJsonObject(raw))
    throw invalidMoonshotResponse(account, `${account.label} returned a non-object response`);
  if (
    raw.object !== 'chat.completion' ||
    typeof raw.id !== 'string' ||
    raw.id.length === 0 ||
    !isNonNegativeInteger(raw.created) ||
    typeof raw.model !== 'string' ||
    raw.model.length === 0 ||
    raw.model !== expectedModel ||
    !Array.isArray(raw.choices) ||
    raw.choices.length !== 1
  ) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} returned an incomplete completion envelope`,
    );
  }
  const choice = raw.choices[0];
  if (
    !isJsonObject(choice) ||
    choice.index !== 0 ||
    !validFinishReason(choice.finish_reason) ||
    !isJsonObject(choice.message)
  ) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} returned an invalid completion choice`,
    );
  }
  validateAssistantMessage(account, choice.message);
  validateUsage(account, raw.usage);
  return raw as unknown as MoonshotCompletion;
}

function validateAssistantMessage(
  account: ChatCompletionsAccount,
  raw: unknown,
): MoonshotAssistantMessage {
  if (
    !isJsonObject(raw) ||
    raw.role !== 'assistant' ||
    (typeof raw.content !== 'string' && raw.content !== null) ||
    !('reasoning_content' in raw) ||
    (typeof raw.reasoning_content !== 'string' && raw.reasoning_content !== null) ||
    (raw.tool_calls !== undefined &&
      (!Array.isArray(raw.tool_calls) || raw.tool_calls.length === 0))
  ) {
    throw invalidMoonshotResponse(account, `${account.label} assistant message was invalid`);
  }
  if (Array.isArray(raw.tool_calls)) {
    raw.tool_calls.forEach((call) => validateToolCall(account, call));
    validateUniqueToolCallIds(account, raw.tool_calls as readonly MoonshotToolCall[]);
  }
  return raw as unknown as MoonshotAssistantMessage;
}

function validateToolCall(account: ChatCompletionsAccount, raw: unknown): MoonshotToolCall {
  if (
    !isJsonObject(raw) ||
    typeof raw.id !== 'string' ||
    raw.id.length === 0 ||
    raw.type !== 'function' ||
    !isJsonObject(raw.function) ||
    typeof raw.function.name !== 'string' ||
    raw.function.name.length === 0 ||
    typeof raw.function.arguments !== 'string'
  ) {
    throw invalidMoonshotResponse(account, `${account.label} tool call was invalid`);
  }
  return raw as unknown as MoonshotToolCall;
}

function parseToolCall(account: ChatCompletionsAccount, call: MoonshotToolCall): InferenceToolCall {
  let input: unknown;
  try {
    input = JSON.parse(call.function.arguments) as unknown;
  } catch (error) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} tool arguments were invalid JSON`,
      error,
    );
  }
  if (!isJsonObject(input)) {
    throw invalidMoonshotResponse(account, `${account.label} tool arguments were not an object`);
  }
  return {
    type: 'tool-call',
    id: call.id,
    name: call.function.name,
    input,
    cache: 'none',
  };
}

function moonshotState(
  account: ChatCompletionsAccount,
  data: MoonshotContinuationData,
): ProviderContinuationState {
  const assistantMessages = data.segments.flatMap((segment) =>
    segment.transcript.filter(
      (message): message is MoonshotAssistantMessage => message.role === 'assistant',
    ),
  );
  const requiredOnNextTurn = data.segments.some((segment) =>
    segment.transcript.some(
      (message) => message.role === 'tool' || (message.role === 'assistant' && message.tool_calls),
    ),
  );
  return {
    backend: account.backend,
    value: {
      assistantMessages: assistantMessages.map((message) => cloneJsonObject(message)),
      segments: data.segments.map((segment) => ({
        transcript: segment.transcript.map((message) => cloneJsonObject(message)),
        publicAssistant: cloneJson(segment.publicAssistant),
      })),
    },
    ...(requiredOnNextTurn ? { requiredOnNextTurn: true } : {}),
  };
}

function emptyContinuationData(): MoonshotContinuationData {
  return { segments: [] };
}

function emptyContinuationSegment(): MoonshotContinuationSegment {
  return { transcript: [], publicAssistant: { text: '', toolCalls: [] } };
}

function continuationData(
  account: ChatCompletionsAccount,
  continuation?: ProviderContinuationState,
): MoonshotContinuationData {
  if (!continuation) return emptyContinuationData();
  if (continuation.backend !== account.backend) {
    throw new Error(`${account.label} cannot consume ${continuation.backend} continuation state`);
  }
  if (!isJsonObject(continuation.value)) {
    throw new Error(`${account.label} continuation state did not contain assistant history`);
  }
  const messages = continuation.value.assistantMessages;
  const segments = continuation.value.segments;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !Array.isArray(segments) ||
    segments.length === 0
  ) {
    throw new Error(`${account.label} continuation state did not contain assistant history`);
  }
  const assistantMessages = messages.map((message) => validateAssistantMessage(account, message));
  const validatedSegments = segments.map((segment) =>
    validateContinuationSegment(account, segment),
  );
  const transcriptAssistants = validatedSegments.flatMap((segment) =>
    segment.transcript.filter((message) => message.role === 'assistant'),
  );
  if (canonicalJson(transcriptAssistants) !== canonicalJson(assistantMessages)) {
    throw new Error(`${account.label} continuation transcript did not match assistant history`);
  }
  return {
    segments: validatedSegments,
  };
}

function validateContinuationSegment(
  account: ChatCompletionsAccount,
  raw: unknown,
): MoonshotContinuationSegment {
  if (!isJsonObject(raw) || !Array.isArray(raw.transcript) || raw.transcript.length === 0) {
    throw new Error(`${account.label} continuation state contained an invalid transcript segment`);
  }
  const transcript = raw.transcript.map((message) => validateTranscriptMessage(account, message));
  if (transcript[0]?.role !== 'assistant') {
    throw new Error(`${account.label} continuation transcript must start with an assistant`);
  }
  const availableCalls = new Set<string>();
  for (const message of transcript) {
    if (message.role === 'assistant') {
      const assistant = message as MoonshotAssistantMessage;
      for (const call of assistant.tool_calls ?? []) availableCalls.add(call.id);
      continue;
    }
    if (message.role === 'tool' && !availableCalls.delete(String(message.tool_call_id))) {
      throw new Error(
        `${account.label} continuation transcript contained an unmatched tool result`,
      );
    }
  }
  if (!validPublicAssistant(raw.publicAssistant)) {
    throw new Error(`${account.label} continuation state contained an invalid public assistant`);
  }
  return { transcript, publicAssistant: raw.publicAssistant };
}

function validPublicAssistant(raw: unknown): raw is MoonshotPublicAssistant {
  if (!isJsonObject(raw) || typeof raw.text !== 'string' || !Array.isArray(raw.toolCalls)) {
    return false;
  }
  return raw.toolCalls.every(
    (call) =>
      isJsonObject(call) &&
      typeof call.id === 'string' &&
      call.id.length > 0 &&
      typeof call.name === 'string' &&
      call.name.length > 0 &&
      isJsonObject(call.input),
  );
}

function validateTranscriptMessage(
  account: ChatCompletionsAccount,
  raw: unknown,
): Record<string, unknown> {
  if (!isJsonObject(raw)) {
    throw new Error(`${account.label} continuation transcript contained an invalid message`);
  }
  if (raw.role === 'assistant')
    return validateAssistantMessage(account, raw) as Record<string, unknown>;
  if (
    raw.role === 'tool' &&
    typeof raw.tool_call_id === 'string' &&
    raw.tool_call_id.length > 0 &&
    typeof raw.content === 'string'
  ) {
    return raw;
  }
  throw new Error(`${account.label} continuation transcript contained an invalid message`);
}

function accumulatedAssistantMessage(
  account: ChatCompletionsAccount,

  text: string,
  reasoning: string | null | undefined,
  calls: ReadonlyMap<number, AccumulatedToolCall>,
): MoonshotAssistantMessage {
  const indexes = [...calls.keys()].sort((left, right) => left - right);
  if (indexes.some((value, index) => value !== index)) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} stream tool-call indexes were not contiguous`,
    );
  }
  const toolCalls = indexes.map((index) => {
    const call = calls.get(index);
    if (!call)
      throw invalidMoonshotResponse(account, `${account.label} stream omitted a tool call`);
    return validateToolCall(account, {
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    });
  });
  validateUniqueToolCallIds(account, toolCalls);
  return {
    role: 'assistant',
    content: text,
    ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function validateUniqueToolCallIds(
  account: ChatCompletionsAccount,
  calls: readonly MoonshotToolCall[],
): void {
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw invalidMoonshotResponse(account, `${account.label} returned duplicate tool-call IDs`);
  }
}

function validateChunkEnvelope(
  account: ChatCompletionsAccount,

  raw: unknown,
  expectedId: string | null,
  expectedModel: string,
  expectedCreated: number | null,
): MoonshotChunk {
  if (
    !isJsonObject(raw) ||
    raw.object !== 'chat.completion.chunk' ||
    typeof raw.id !== 'string' ||
    raw.id.length === 0 ||
    (expectedId !== null && raw.id !== expectedId) ||
    !isNonNegativeInteger(raw.created) ||
    typeof raw.model !== 'string' ||
    raw.model.length === 0 ||
    raw.model !== expectedModel ||
    (expectedCreated !== null && raw.created !== expectedCreated) ||
    !Array.isArray(raw.choices) ||
    raw.choices.length > 1 ||
    (raw.usage !== undefined && raw.usage !== null && !isJsonObject(raw.usage))
  ) {
    throw invalidMoonshotResponse(account, `${account.label} stream chunk envelope was invalid`);
  }
  return raw as MoonshotChunk;
}

function validateStreamChoice(
  account: ChatCompletionsAccount,

  raw: unknown,
  first: boolean,
): {
  delta: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: readonly unknown[] | null;
  };
  finish_reason: string | null;
  usage?: unknown;
} {
  if (!isJsonObject(raw) || raw.index !== 0 || !isJsonObject(raw.delta)) {
    throw invalidMoonshotResponse(account, `${account.label} stream choice was invalid`);
  }
  const delta = raw.delta;
  if (
    (first ? delta.role !== 'assistant' : delta.role !== undefined) ||
    (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') ||
    (delta.reasoning_content !== undefined &&
      delta.reasoning_content !== null &&
      typeof delta.reasoning_content !== 'string') ||
    (delta.tool_calls !== undefined &&
      delta.tool_calls !== null &&
      (!Array.isArray(delta.tool_calls) || delta.tool_calls.length === 0)) ||
    !validNullableFinishReason(raw.finish_reason) ||
    (raw.usage !== undefined && raw.usage !== null && !isJsonObject(raw.usage))
  ) {
    throw invalidMoonshotResponse(account, `${account.label} stream delta was invalid`);
  }
  const allowed = new Set(['role', 'content', 'reasoning_content', 'tool_calls']);
  if (Object.keys(delta).some((key) => !allowed.has(key))) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} stream delta contained an unknown field`,
    );
  }
  return raw as {
    delta: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: readonly unknown[] | null;
    };
    finish_reason: string | null;
    usage?: unknown;
  };
}

function accumulateToolCallDeltas(
  account: ChatCompletionsAccount,

  calls: Map<number, AccumulatedToolCall>,
  deltas: readonly unknown[],
): void {
  for (const raw of deltas) {
    if (!isJsonObject(raw) || !isNonNegativeInteger(raw.index)) {
      throw invalidMoonshotResponse(account, `${account.label} stream tool-call delta was invalid`);
    }
    const existing = calls.get(raw.index);
    if (!existing) {
      if (
        typeof raw.id !== 'string' ||
        raw.id.length === 0 ||
        raw.type !== 'function' ||
        !isJsonObject(raw.function) ||
        typeof raw.function.name !== 'string' ||
        raw.function.name.length === 0 ||
        (raw.function.arguments !== undefined && typeof raw.function.arguments !== 'string')
      ) {
        throw invalidMoonshotResponse(
          account,
          `${account.label} initial tool-call delta was incomplete`,
        );
      }
      calls.set(raw.index, {
        id: raw.id,
        name: raw.function.name,
        arguments: typeof raw.function.arguments === 'string' ? raw.function.arguments : '',
      });
      continue;
    }
    if (
      (raw.id !== undefined && raw.id !== null && raw.id !== existing.id) ||
      (raw.type !== undefined && raw.type !== null && raw.type !== 'function') ||
      !isJsonObject(raw.function) ||
      (raw.function.name !== undefined &&
        raw.function.name !== null &&
        raw.function.name !== existing.name) ||
      typeof raw.function.arguments !== 'string'
    ) {
      throw invalidMoonshotResponse(account, `${account.label} tool-call delta changed identity`);
    }
    existing.arguments += raw.function.arguments;
  }
}

function sseBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function validateUsage(account: ChatCompletionsAccount, raw: unknown): MoonshotUsage {
  if (!isJsonObject(raw))
    throw invalidMoonshotResponse(account, `${account.label} usage was not an object`);
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    if (!isNonNegativeInteger(raw[key])) {
      throw invalidMoonshotResponse(account, `${account.label} usage.${key} was invalid`);
    }
  }
  const promptTokens = raw.prompt_tokens as number;
  const completionTokens = raw.completion_tokens as number;
  if (raw.total_tokens !== promptTokens + completionTokens) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} usage total did not match input plus output`,
    );
  }
  if (raw.cached_tokens !== undefined && !isNonNegativeInteger(raw.cached_tokens)) {
    throw invalidMoonshotResponse(account, `${account.label} cached token usage was invalid`);
  }
  const promptDetails = raw.prompt_tokens_details;
  if (
    promptDetails !== undefined &&
    (!isJsonObject(promptDetails) ||
      (promptDetails.cached_tokens !== undefined &&
        !isNonNegativeInteger(promptDetails.cached_tokens)) ||
      (promptDetails.cache_write_tokens !== undefined &&
        !isNonNegativeInteger(promptDetails.cache_write_tokens)))
  ) {
    throw invalidMoonshotResponse(account, `${account.label} prompt token details were invalid`);
  }
  const completionDetails = raw.completion_tokens_details;
  if (
    completionDetails !== undefined &&
    (!isJsonObject(completionDetails) ||
      (completionDetails.reasoning_tokens !== undefined &&
        !isNonNegativeInteger(completionDetails.reasoning_tokens)))
  ) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} completion token details were invalid`,
    );
  }
  if (
    isJsonObject(promptDetails) &&
    raw.cached_tokens !== undefined &&
    promptDetails.cached_tokens !== undefined &&
    raw.cached_tokens !== promptDetails.cached_tokens
  ) {
    throw invalidMoonshotResponse(account, `${account.label} cached token counts disagreed`);
  }
  const cachedTokens =
    (raw.cached_tokens as number | undefined) ??
    (isJsonObject(promptDetails) ? ((promptDetails.cached_tokens as number | undefined) ?? 0) : 0);
  const cacheWriteTokens = isJsonObject(promptDetails)
    ? ((promptDetails.cache_write_tokens as number | undefined) ?? 0)
    : 0;
  if (cachedTokens + cacheWriteTokens > promptTokens) {
    throw invalidMoonshotResponse(
      account,
      `${account.label} cache token usage exceeded prompt tokens`,
    );
  }
  return raw as MoonshotUsage;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]),
      )
    );
  }
  return false;
}

function normalizeUsage(usage: MoonshotUsage): InferenceUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedInputTokens: usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? null,
    cacheWriteInputTokens: usage.prompt_tokens_details?.cache_write_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    providerDetails: { ...usage },
  };
}

function aggregateKimiUsage(usages: readonly InferenceUsage[]): InferenceUsage {
  const only = usages.length === 1 ? usages[0] : undefined;
  if (only) return only;
  const total = (read: (usage: InferenceUsage) => number | null): number | null => {
    const values = usages.map(read);
    return values.some((value) => value === null)
      ? null
      : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  };
  const inputTokens = total((usage) => usage.inputTokens);
  const outputTokens = total((usage) => usage.outputTokens);
  const cachedInputTokens = total((usage) => usage.cachedInputTokens);
  const cacheWriteInputTokens = total((usage) => usage.cacheWriteInputTokens);
  const reasoningTokens = total((usage) => usage.reasoningTokens);
  const providerDetails: Record<string, unknown> = { ...usages.at(-1)?.providerDetails };
  if (inputTokens !== null) providerDetails.prompt_tokens = inputTokens;
  if (outputTokens !== null) providerDetails.completion_tokens = outputTokens;
  if (inputTokens !== null && outputTokens !== null) {
    providerDetails.total_tokens = inputTokens + outputTokens;
  }
  if (cachedInputTokens !== null && 'cached_tokens' in providerDetails) {
    providerDetails.cached_tokens = cachedInputTokens;
  }
  if (isJsonObject(providerDetails.prompt_tokens_details)) {
    const promptDetails = { ...providerDetails.prompt_tokens_details };
    if (cachedInputTokens !== null) promptDetails.cached_tokens = cachedInputTokens;
    if (cacheWriteInputTokens !== null) promptDetails.cache_write_tokens = cacheWriteInputTokens;
    providerDetails.prompt_tokens_details = promptDetails;
  }
  if (isJsonObject(providerDetails.completion_tokens_details)) {
    const completionDetails = { ...providerDetails.completion_tokens_details };
    if (reasoningTokens !== null) completionDetails.reasoning_tokens = reasoningTokens;
    providerDetails.completion_tokens_details = completionDetails;
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    ...(Object.keys(providerDetails).length > 0 ? { providerDetails } : {}),
  };
}

function normalizeStopReason(reason: string): InferenceStopReason {
  if (reason === 'stop') return 'completed';
  if (reason === 'length') return 'max-output-tokens';
  if (reason === 'tool_calls') return 'tool-call';
  if (reason === 'content_filter') return 'content-filter';
  return 'unknown';
}

function validFinishReason(value: unknown): value is string {
  return (
    value === 'stop' || value === 'length' || value === 'tool_calls' || value === 'content_filter'
  );
}

function validNullableFinishReason(value: unknown): value is string | null {
  return value === null || validFinishReason(value);
}

function kimiModelFamily(account: ChatCompletionsAccount, profile: ModelProfile): KimiModelFamily {
  const family = account.modelProfiles[profile.name];
  if (!family)
    throw new Error(`${account.label} candidate does not support profile ${profile.name}`);
  return family;
}

function validateKimiImageMediaType(account: ChatCompletionsAccount, mediaType: string): void {
  if (!KIMI_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())) {
    throw new WorkerError(`${account.label} image input does not support media type ${mediaType}`, {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
}

function validateUtf8Evidence(bytes: Uint8Array): void {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new WorkerError('Kimi Code text evidence must be valid UTF-8', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
}

function validateRequestRoute(account: ChatCompletionsAccount, request: InferenceRequest): void {
  const profile = request.modelProfile;
  if (profile.provider !== account.provider || profile.apiFamily !== 'moonshot-chat-completions') {
    throw new Error(
      `${account.label} adapter cannot serve ${profile.provider}/${profile.apiFamily} (${profile.name})`,
    );
  }
  validateFilePolicy(account, request.filePolicy);
}

function validateFilePolicy(account: ChatCompletionsAccount, policy: FilePolicy): void {
  if (
    account.provider === 'kimi' &&
    policy.name === 'kimi-stored-evidence' &&
    policy.provider === 'kimi' &&
    policy.compatibleApiFamilies.includes('moonshot-chat-completions') &&
    policy.inputMode === 'worker-file' &&
    policy.lifecycle === 'worker-managed' &&
    policy.purpose === null
  )
    return;
  if (
    policy.provider !== account.provider ||
    !policy.compatibleApiFamilies.includes('moonshot-chat-completions') ||
    policy.inputMode !== (account.files ? 'provider-file' : 'inline') ||
    policy.lifecycle !== (account.files ? 'provider-managed' : 'request-scoped') ||
    policy.purpose !== (account.files ? account.files.purpose : null)
  ) {
    throw new Error(`${account.label} cannot use file policy ${policy.name}`);
  }
}

function validateFileRecord(
  account: ChatCompletionsAccount,

  raw: unknown,
  expectedId?: string,
  expectedPurpose?: string,
  requireReady = true,
): { id: string; bytes: number } {
  if (
    !isJsonObject(raw) ||
    raw.object !== 'file' ||
    typeof raw.id !== 'string' ||
    raw.id.length === 0 ||
    (expectedId !== undefined && raw.id !== expectedId) ||
    !isNonNegativeInteger(raw.bytes) ||
    !isNonNegativeInteger(raw.created_at) ||
    typeof raw.filename !== 'string' ||
    raw.filename.length === 0 ||
    !['file-extract', 'image', 'video', 'batch'].includes(String(raw.purpose)) ||
    (expectedPurpose !== undefined && raw.purpose !== expectedPurpose) ||
    typeof raw.status !== 'string' ||
    raw.status.length === 0 ||
    (requireReady && raw.status !== 'ready' && raw.status !== 'ok') ||
    (raw.status_details !== undefined && typeof raw.status_details !== 'string')
  ) {
    throw invalidMoonshotResponse(account, `${account.label} file response was invalid`);
  }
  return { id: raw.id, bytes: raw.bytes };
}

async function callMoonshot(
  account: ChatCompletionsAccount,

  operation: () => Promise<Response>,
  abortSignal?: AbortSignal,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    throw moonshotTransportFailure(account, error, abortSignal);
  }
}

function moonshotTransportFailure(
  account: ChatCompletionsAccount,
  error: unknown,
  abortSignal?: AbortSignal,
): InferenceFailure {
  if (error instanceof InferenceFailure) return error;
  const name = error instanceof Error ? error.name : '';
  const timedOut = name === 'TimeoutError';
  const cancelled = !timedOut && (abortSignal?.aborted === true || name === 'AbortError');
  return new InferenceFailure({
    backend: account.backend,
    status: null,
    code: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network_error',
    message: cancelled
      ? `${account.label} request was cancelled`
      : timedOut
        ? `${account.label} request timed out`
        : `${account.label} network request failed`,
    retryable: !cancelled,
    failureClass: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network',
  });
}

function moonshotFailure(
  account: ChatCompletionsAccount,
  status: number | null,
  raw: unknown,
): InferenceFailure {
  const root = isJsonObject(raw) ? raw : undefined;
  const error = root && isJsonObject(root.error) ? root.error : undefined;
  const code =
    typeof error?.code === 'string'
      ? error.code
      : typeof error?.type === 'string'
        ? error.type
        : 'moonshot_error';
  const permanent429 = new Set([
    'exceeded_current_quota_error',
    'insufficient_quota',
    'credit_balance_exhausted',
  ]).has(code);
  return new InferenceFailure({
    backend: account.backend,
    status,
    code,
    message: `${account.label} request failed${status === null ? '' : ` (${status})`}`,
    retryable:
      !permanent429 &&
      (status === 408 ||
        status === 429 ||
        (status !== null && status >= 500) ||
        new Set([
          'rate_limit_reached_error',
          'engine_overloaded_error',
          'rate_limit_error',
          'server_error',
          'overloaded_error',
        ]).has(code)),
    failureClass: 'http',
  });
}

async function readMoonshotJson<T>(
  account: ChatCompletionsAccount,
  response: Response,
  abortSignal?: AbortSignal,
): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        abortSignal?.aborted === true)
    ) {
      throw moonshotTransportFailure(account, error, abortSignal);
    }
    throw new InferenceFailure({
      backend: account.backend,
      status: response.status,
      code: 'invalid_response',
      message: `${account.label} returned an invalid JSON response`,
      detail: error instanceof Error ? error.message : String(error),
      retryable: response.status >= 500,
      failureClass: 'invalid-response',
    });
  }
}

function invalidMoonshotResponse(
  account: ChatCompletionsAccount,
  message: string,
  cause?: unknown,
): InferenceFailure {
  return new InferenceFailure({
    backend: account.backend,
    status: null,
    code: 'invalid_response',
    message,
    ...(cause !== undefined
      ? { detail: cause instanceof Error ? cause.message : String(cause) }
      : {}),
    retryable: false,
    failureClass: 'invalid-response',
  });
}

function cloneJsonObject<T extends Readonly<Record<string, unknown>>>(value: T): T {
  return cloneJson(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
