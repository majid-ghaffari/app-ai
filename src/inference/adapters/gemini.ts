/** Gemini generateContent adapter: canonical translation, SSE, files, and failures. */

import type { Env } from '../../config';
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
  InferenceUsage,
  ProviderContinuationState,
} from '../../lib/inference-types';
import {
  InferenceFailure,
  type InferenceProviderAdapter,
  type ProviderFileMetadata,
  type ProviderUploadRequest,
  type ProviderUploadResult,
} from '../adapter';
import * as gemini from './gemini-wire';
import {
  GEMINI_DEFAULT_THINKING_LEVEL,
  geminiSharedOutputBudget,
  type GeminiThinkingLevel,
} from './gemini-output-budget';

interface GeminiFunctionCall extends Readonly<Record<string, unknown>> {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

interface GeminiUsageMetadata extends Readonly<Record<string, unknown>> {
  readonly promptTokenCount: number;
  readonly candidatesTokenCount: number;
  readonly totalTokenCount: number;
  readonly cachedContentTokenCount?: number;
  readonly thoughtsTokenCount?: number;
}

/** One assembled assistant part; streamed text fragments merge into one entry. */
type AssembledPart =
  | { kind: 'text'; text: string; signature: string | null }
  | {
      kind: 'call';
      id: string;
      name: string;
      args: Readonly<Record<string, unknown>>;
      signature: string | null;
    };

interface GeminiPublicAssistant {
  readonly text: string;
  readonly toolCalls: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
}

/**
 * One public assistant turn plus the exact provider `contents` entries behind
 * it. The transcript is what carries `thoughtSignature` values across a public
 * HTTP boundary; Gemini 3 rejects a replayed `functionCall` part whose
 * signature is missing.
 */
interface GeminiContinuationSegment {
  readonly transcript: readonly Record<string, unknown>[];
  readonly publicAssistant: GeminiPublicAssistant;
}

interface GeminiContinuationData {
  readonly segments: readonly GeminiContinuationSegment[];
}

interface GeminiStateBase {
  readonly priorSegments: readonly GeminiContinuationSegment[];
  readonly currentSegment: GeminiContinuationSegment;
}

interface GeminiTranslation {
  readonly payload: Record<string, unknown>;
  readonly stateBase: GeminiStateBase;
}

/** Inline and uploaded image media types documented for `generateContent`. */
const GEMINI_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

/** Document media types documented for `generateContent`. */
const GEMINI_DOCUMENT_MEDIA_TYPES = new Set(['application/pdf', 'text/plain']);

/**
 * The Gemini 3 family is the only generation this adapter serves: it is the one
 * with a documented `thinkingLevel` control, a documented `functionCall.id`, and
 * the mandatory `thoughtSignature` replay this adapter implements. Earlier
 * generations correlate tool results by function name instead and fail closed
 * here rather than run an unverified second contract.
 */
const GEMINI_SUPPORTED_MODEL_PREFIX = 'gemini-3';

/**
 * Modality markers excluded from `generateContent` routing. Image, speech,
 * audio, embedding, live and transcription models publish other methods, so
 * binding one to a chat profile is a configuration error, not a runtime degrade.
 */
const NON_GENERATE_CONTENT_MODEL_MARKERS = [
  'image',
  'tts',
  'audio',
  'robotics',
  'computer-use',
  'embedding',
  'live',
  'omni',
  'transcribe',
];

/** Terminal `File.state` values; a file is referenced only once it is ACTIVE. */
const FILE_STATE_ACTIVE = 'ACTIVE';
const FILE_STATE_PROCESSING = 'PROCESSING';
const FILE_STATE_FAILED = 'FAILED';

/**
 * A freshly uploaded image is normally ACTIVE immediately; a bounded poll covers
 * the documented PROCESSING state without letting one upload hold a Worker
 * request open.
 */
const FILE_ACTIVATION_POLL_ATTEMPTS = 4;
const FILE_ACTIVATION_POLL_DELAY_MILLISECONDS = 250;

/** Gemini adapter bound to one Worker request environment. */
export class GeminiGenerateContentAdapter implements InferenceProviderAdapter {
  readonly provider = 'gemini' as const;
  readonly apiFamily = 'gemini-generate-content' as const;
  /**
   * Every successful turn must round-trip its sealed provider state: the
   * `thoughtSignature` values live only there, and a client-tool continuation
   * crosses two separate public HTTP requests.
   */
  readonly requiresOrdinaryTurnContinuation = true;

  constructor(private readonly env: Env) {}

  finalizeAgentContinuation(
    state: ProviderContinuationState,
    results: readonly InferenceToolResult[],
  ): ProviderContinuationState {
    const data = continuationData(state);
    const current = data.segments.at(-1);
    if (!current) throw new Error('Gemini continuation omitted its terminal segment');
    const terminal = current.transcript.at(-1);
    const expectedCalls = terminal ? functionCallsOf(terminal) : [];
    if (
      expectedCalls.length !== results.length ||
      expectedCalls.some((call, index) => results[index]?.toolCallId !== call.id)
    ) {
      throw new Error('Gemini terminal tool results did not match continuation state');
    }
    return geminiState({
      segments: [
        ...data.segments.slice(0, -1),
        {
          publicAssistant: { text: current.publicAssistant.text, toolCalls: [] },
          transcript: [
            ...current.transcript.map((content) => cloneJsonObject(content)),
            toolResultContent(results, new Map(expectedCalls.map((call) => [call.id, call.name]))),
          ],
        },
      ],
    });
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    validateRequestRoute(request);
    const translated = toGeminiPayload(request, this.env);
    const response = await callGemini(
      () =>
        gemini.generateContent(
          request.modelProfile.model,
          translated.payload,
          this.env,
          request.abortSignal,
        ),
      request.abortSignal,
    );
    const data = await readGeminiJson<unknown>(response, request.abortSignal);
    if (!response.ok) throw geminiFailure(response.status, data);
    return completionResult(data, translated.stateBase);
  }

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    validateRequestRoute(request);
    const translated = toGeminiPayload(request, this.env);
    const response = await callGemini(
      () =>
        gemini.streamGenerateContent(
          request.modelProfile.model,
          translated.payload,
          this.env,
          request.abortSignal,
        ),
      request.abortSignal,
    );
    if (!response.ok) {
      const data = await readGeminiJson<unknown>(response, request.abortSignal);
      throw geminiFailure(response.status, data);
    }
    if (!response.body) throw invalidGeminiResponse('Gemini stream omitted a response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstChunk = true;
    let responseId: string | null = null;
    let finishReason: string | null = null;
    let blockReason: string | null = null;
    let usage: GeminiUsageMetadata | null = null;
    const parts: AssembledPart[] = [];

    const processEvent = function* (json: string): Generator<InferenceEvent> {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json) as unknown;
      } catch (error) {
        throw invalidGeminiResponse('Gemini stream contained invalid JSON', error);
      }
      if (isJsonObject(parsed) && isJsonObject(parsed.error)) throw geminiFailure(null, parsed);
      const chunk = validateChunkEnvelope(parsed, responseId);
      if (typeof chunk.responseId === 'string') responseId = chunk.responseId;
      if (chunk.usageMetadata !== undefined) usage = validateUsage(chunk.usageMetadata);
      if (firstChunk) {
        firstChunk = false;
        yield { type: 'message-start' };
      }
      const feedbackBlock = promptBlockReason(chunk);
      if (feedbackBlock !== null) blockReason = feedbackBlock;
      const candidate = chunk.candidates === undefined ? null : validateCandidate(chunk.candidates);
      if (!candidate) return;
      // A trailing usage-only chunk is legal; further model content after the
      // stream already reported a finish reason is not.
      if (finishReason !== null) {
        throw invalidGeminiResponse('Gemini stream emitted a candidate after its finish reason');
      }
      for (const part of candidate.parts) {
        const emitted = appendPart(parts, part);
        if (emitted !== null) yield { type: 'text-delta', delta: emitted };
      }
      if (candidate.finishReason !== null) finishReason = candidate.finishReason;
    };

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw geminiTransportFailure(error, request.abortSignal);
      }
      if (chunk.done) break;
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
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      throw invalidGeminiResponse('Gemini stream ended with a truncated event');
    }
    // Gemini publishes no terminal sentinel: a clean close after a chunk that
    // carried a finish reason IS the success condition, and a close without one
    // is a truncated stream rather than a short completion.
    if (finishReason === null && blockReason === null) {
      throw invalidGeminiResponse('Gemini stream ended before a finish reason');
    }
    if (!usage) throw invalidGeminiResponse('Gemini stream ended without usage metadata');
    const result = resultFromParts(parts, finishReason, blockReason, usage, translated.stateBase);
    for (const call of result.toolCalls) yield { type: 'tool-call', call };
    yield { type: 'usage', usage: result.usage };
    yield { type: 'complete', result };
  }

  async countTokens(request: InferenceRequest): Promise<number | null> {
    validateRequestRoute(request);
    const translated = toGeminiPayload(request, this.env);
    const response = await callGemini(
      () =>
        gemini.countTokens(
          request.modelProfile.model,
          countTokensPayload(request.modelProfile.model, translated.payload),
          this.env,
          request.abortSignal,
        ),
      request.abortSignal,
    );
    const data = await readGeminiJson<unknown>(response, request.abortSignal);
    if (!response.ok) throw geminiFailure(response.status, data);
    if (!isJsonObject(data) || !isNonNegativeInteger(data.totalTokens)) {
      throw invalidGeminiResponse('Gemini token count response was invalid');
    }
    return data.totalTokens;
  }

  async getFileScope(policy: FilePolicy): Promise<string> {
    validateFilePolicy(policy);
    return gemini.fileAccountScope(this.env);
  }

  async uploadFile(request: ProviderUploadRequest): Promise<ProviderUploadResult> {
    validateFilePolicy(request.policy);
    validateGeminiUploadMediaType(request.mediaType);
    const started = await callGemini(
      () =>
        gemini.startResumableUpload(
          request.filename,
          request.bytes.byteLength,
          request.mediaType,
          this.env,
          request.abortSignal,
        ),
      request.abortSignal,
    );
    if (!started.ok) {
      const data = await readGeminiJson<unknown>(started, request.abortSignal);
      throw geminiFailure(started.status, data);
    }
    const uploadUrl = started.headers.get(gemini.UPLOAD_URL_HEADER);
    if (!uploadUrl) {
      throw invalidGeminiResponse('Gemini resumable upload omitted its upload endpoint');
    }
    const endpoint = gemini.uploadEndpoint(uploadUrl, this.env);
    const finished = await callGemini(
      () => gemini.finishResumableUpload(endpoint, request.bytes, request.abortSignal),
      request.abortSignal,
    );
    const finishedBody = await readGeminiJson<unknown>(finished, request.abortSignal);
    if (!finished.ok) throw geminiFailure(finished.status, finishedBody);
    if (!isJsonObject(finishedBody) || !isJsonObject(finishedBody.file)) {
      throw invalidGeminiResponse('Gemini upload response omitted its file resource');
    }
    const file = validateFileRecord(finishedBody.file, this.env, request.mediaType);
    return this.activatedFile(file, request.abortSignal);
  }

  async getFileMetadata(
    id: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderFileMetadata | null> {
    const response = await callGemini(() => gemini.getFile(id, this.env, abortSignal), abortSignal);
    if (response.status === 404) return null;
    const data = await readGeminiJson<unknown>(response, abortSignal);
    if (!response.ok) throw geminiFailure(response.status, data);
    const file = validateFileRecord(data, this.env, null, id);
    return {
      id: file.id,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      expiresAt: file.expiresAt,
    };
  }

  async deleteFile(id: string, abortSignal?: AbortSignal): Promise<void> {
    const response = await callGemini(
      () => gemini.deleteFile(id, this.env, abortSignal),
      abortSignal,
    );
    const data = await readGeminiJson<unknown>(response, abortSignal);
    if (!response.ok) throw geminiFailure(response.status, data);
    if (!isJsonObject(data) || Object.keys(data).length > 0) {
      throw invalidGeminiResponse('Gemini file deletion response was invalid');
    }
  }

  /** Never hand a PROCESSING file URI to `generateContent`; poll until terminal. */
  private async activatedFile(
    file: ValidatedGeminiFile,
    abortSignal?: AbortSignal,
  ): Promise<ProviderUploadResult> {
    let current = file;
    for (let attempt = 0; current.state === FILE_STATE_PROCESSING; attempt += 1) {
      if (attempt >= FILE_ACTIVATION_POLL_ATTEMPTS) {
        throw invalidGeminiResponse('Gemini upload did not become active');
      }
      await delay(FILE_ACTIVATION_POLL_DELAY_MILLISECONDS, abortSignal);
      const response = await callGemini(
        () => gemini.getFile(current.id, this.env, abortSignal),
        abortSignal,
      );
      const data = await readGeminiJson<unknown>(response, abortSignal);
      if (!response.ok) throw geminiFailure(response.status, data);
      current = validateFileRecord(data, this.env, null, current.id);
    }
    if (current.state !== FILE_STATE_ACTIVE) {
      throw invalidGeminiResponse(`Gemini upload reported state ${current.state}`);
    }
    return {
      id: current.id,
      mediaType: current.mediaType,
      sizeBytes: current.sizeBytes,
      expiresAt: current.expiresAt,
    };
  }
}

function toGeminiPayload(request: InferenceRequest, env: Env): GeminiTranslation {
  assertSupportedGeminiModel(request.modelProfile.model);
  const translated = toGeminiContents(request, env);
  const level = thinkingLevel(request);
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: geminiSharedOutputBudget(request.maxOutputTokens, level),
    thinkingConfig: { thinkingLevel: level },
  };
  if (request.stopSequences?.length) generationConfig.stopSequences = [...request.stopSequences];
  if (request.structuredOutput) {
    if (request.structuredOutput.strict) {
      throw new Error('Gemini structured output guarantees syntax only and cannot be strict');
    }
    // Two current official pages disagree on the structured-output shape: the
    // REST reference lists the flat `responseMimeType`/`responseSchema` fields
    // used here, while the structured-output guide's REST tab shows a nested
    // `responseFormat.text.{mimeType,schema}` wrapper. The normative reference
    // shape is sent; the nested wrapper is UNVERIFIED and closed by the
    // `verify:gemini` probe.
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = request.structuredOutput.schema;
  }
  // STABLE-PREFIX ORDER. Gemini caches a repeated request prefix implicitly and
  // exposes no per-block marker, so a canonical cache intent is honoured here by
  // ORDER instead of by a field: everything that repeats across calls of one
  // prompt — the system instruction, the tool declarations and their config, and
  // the generation config — is emitted BEFORE `contents`, and the canonical
  // block order inside `contents` is preserved exactly, because that is where
  // the handlers already place reusable evidence first and per-call content
  // last. The consequence is a request whose leading bytes are identical across
  // two calls that share a prompt, so nothing emitted before the volatile tail
  // may vary per request: no timestamp, no re-serialization difference, and no
  // iteration-order churn.
  const payload: Record<string, unknown> = {};
  if (translated.systemInstruction) {
    payload.systemInstruction = { parts: [{ text: translated.systemInstruction }] };
  }
  if (request.tools.length > 0) {
    payload.tools = [{ functionDeclarations: request.tools.map(toGeminiFunctionDeclaration) }];
  }
  if (request.toolChoice) {
    if (request.toolChoice.disableParallel !== undefined) {
      throw new Error('Gemini does not expose a documented parallel-tool-call control');
    }
    payload.toolConfig = { functionCallingConfig: toGeminiToolConfig(request.toolChoice) };
  }
  payload.generationConfig = generationConfig;
  payload.contents = translated.contents;
  if (request.sampling) {
    // Gemini 3 is documented as expecting its default temperature; lowering it
    // "may cause unexpected behavior in reasoning tasks".
    throw new Error('Gemini 3 sampling values are provider-fixed and cannot be overridden');
  }
  if (request.metadata)
    throw new Error('Gemini generateContent does not support canonical metadata');
  if (request.serviceTier) {
    throw new Error('Gemini generateContent does not support canonical service tiers');
  }
  return { payload, stateBase: translated.stateBase };
}

/**
 * `countTokens` accepts the whole completion body under `generateContentRequest`,
 * which keeps the estimate inclusive of the system instruction and tools. The
 * wrapper field is documented on the REST reference; its acceptance on this path
 * is closed by the `verify:gemini` probe.
 */
function countTokensPayload(
  model: string,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return { generateContentRequest: { model: `models/${model}`, ...payload } };
}

/**
 * Gemini's ladder tops out at `high`; canonical `xhigh` maps onto it rather than
 * silently becoming a different allowance. A request that declares no effort
 * resolves to the default level, the most expensive one the model could pick.
 */
function thinkingLevel(request: InferenceRequest): GeminiThinkingLevel {
  const effort = request.effort;
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return GEMINI_DEFAULT_THINKING_LEVEL;
}

interface GeminiContentTranslation {
  readonly contents: Record<string, unknown>[];
  readonly systemInstruction: string | null;
  readonly stateBase: GeminiStateBase;
}

function toGeminiContents(request: InferenceRequest, env: Env): GeminiContentTranslation {
  const systemTexts = [request.prompt];
  const conversation = request.messages.filter((message) => {
    if (message.role !== 'system') return true;
    systemTexts.push(systemMessageText(message));
    return false;
  });
  const toolNames = toolNameIndex(conversation);
  const contents: Record<string, unknown>[] = [];
  const continuation = continuationData(request.continuation);
  const segments = continuation.segments;
  const assistantIndexes = conversation.flatMap((message, index) =>
    message.role === 'assistant' ? [index] : [],
  );
  const internalContinuation = conversation.some((message) => message.providerState !== undefined);
  if (assistantIndexes.length > 0 && !request.continuation && !internalContinuation) {
    throw new Error('Gemini assistant history requires authenticated continuation state');
  }
  const systemInstruction = systemTexts.filter((text) => text.length > 0).join('\n\n');
  const finish = (stateBase: GeminiStateBase): GeminiContentTranslation => ({
    contents: contents.filter(hasParts),
    systemInstruction: systemInstruction.length > 0 ? systemInstruction : null,
    stateBase,
  });

  if (segments.length > 0 && !internalContinuation) {
    if (segments.length !== assistantIndexes.length) {
      throw new Error('Gemini continuation could not be attached to request history');
    }
    const segmentByIndex = new Map<number, GeminiContinuationSegment>();
    const start = assistantIndexes.length - segments.length;
    segments.forEach((segment, index) => {
      const messageIndex = assistantIndexes[start + index];
      if (messageIndex === undefined) {
        throw new Error('Gemini continuation could not be attached to request history');
      }
      segmentByIndex.set(messageIndex, segment);
    });
    conversation.forEach((message, index) => {
      const segment = segmentByIndex.get(index);
      if (segment) {
        if (
          message.role !== 'assistant' ||
          !assistantMatchesPublic(message, segment.publicAssistant)
        ) {
          throw new Error('Gemini continuation did not match its public assistant turn');
        }
        contents.push(...replayedTranscript(segment));
        return;
      }
      contents.push(...toGeminiMessage(message, toolNames, env));
    });
    return finish({ priorSegments: segments, currentSegment: emptyContinuationSegment() });
  }

  if (segments.length === 0) {
    conversation.forEach((message) => contents.push(...toGeminiMessage(message, toolNames, env)));
    return finish({ priorSegments: [], currentSegment: emptyContinuationSegment() });
  }

  const currentSegment = segments.at(-1);
  if (!currentSegment) throw new Error('Gemini continuation state omitted its current segment');
  const currentModel = currentSegment.transcript.at(-1);
  if (!currentModel || currentModel.role !== 'model') {
    throw new Error('Gemini continuation current segment did not end in a model turn');
  }
  const stateOwnerIndexes = conversation.flatMap((message, index) =>
    message.providerState !== undefined ? [index] : [],
  );
  if (stateOwnerIndexes.length !== 1) {
    throw new Error('Gemini continuation requires exactly one assistant-owned state');
  }
  const stateOwnerIndex = stateOwnerIndexes[0];
  if (stateOwnerIndex === undefined || conversation[stateOwnerIndex]?.role !== 'assistant') {
    throw new Error('Gemini continuation state belongs only to assistant messages');
  }
  const priorSegments = segments.slice(0, -1);
  const priorAssistantIndexes = assistantIndexes.filter((index) => index < stateOwnerIndex);
  if (priorSegments.length !== priorAssistantIndexes.length) {
    throw new Error('Gemini prior continuation could not be attached to request history');
  }
  const priorSegmentByIndex = new Map<number, GeminiContinuationSegment>();
  const priorStart = priorAssistantIndexes.length - priorSegments.length;
  priorSegments.forEach((segment, index) => {
    const messageIndex = priorAssistantIndexes[priorStart + index];
    if (messageIndex === undefined) {
      throw new Error('Gemini prior continuation could not be attached to request history');
    }
    priorSegmentByIndex.set(messageIndex, segment);
  });
  let stateContentIndex = -1;
  conversation.forEach((message, index) => {
    const priorSegment = priorSegmentByIndex.get(index);
    if (priorSegment) {
      if (
        message.role !== 'assistant' ||
        !assistantMatchesPublic(message, priorSegment.publicAssistant)
      ) {
        throw new Error('Gemini prior continuation did not match its public assistant turn');
      }
      contents.push(...replayedTranscript(priorSegment));
      return;
    }
    const stateModel = message.providerState
      ? continuationData(message.providerState).segments.at(-1)?.transcript.at(-1)
      : undefined;
    if (stateModel) {
      if (message.role !== 'assistant') {
        throw new Error('Gemini continuation state belongs only to assistant messages');
      }
      if (canonicalJson(stateModel) !== canonicalJson(currentModel)) {
        throw new Error('Gemini continuation did not match assistant-owned provider state');
      }
      contents.push(modelContentFromState(stateModel, message));
      stateContentIndex = contents.length - 1;
      return;
    }
    contents.push(...toGeminiMessage(message, toolNames, env));
  });
  if (stateContentIndex < 0) {
    throw new Error('Gemini continuation could not be attached to assistant-owned state');
  }
  return finish({
    priorSegments,
    currentSegment: {
      publicAssistant: currentSegment.publicAssistant,
      transcript: [
        ...currentSegment.transcript.map((content) => cloneJsonObject(content)),
        ...contents.slice(stateContentIndex + 1).map((content) => cloneJsonObject(content)),
      ],
    },
  });
}

/** Replay a sealed segment, rejecting a tool turn whose signature was lost. */
function replayedTranscript(
  segment: GeminiContinuationSegment,
): readonly Record<string, unknown>[] {
  return segment.transcript.map((content) => {
    const calls = functionCallsOf(content);
    if (calls.length > 0 && !firstFunctionCallSignature(content)) {
      throw new Error('Gemini function-call replay is missing its thought signature');
    }
    return cloneJsonObject(content);
  });
}

function systemMessageText(message: InferenceMessage): string {
  const texts: string[] = [];
  for (const item of message.content) {
    if (item.type !== 'text') {
      throw new Error('Gemini system instructions accept only text content');
    }
    texts.push(item.text);
  }
  return texts.join('\n\n');
}

/** Correlate a canonical tool result back to the function name Gemini requires. */
function toolNameIndex(messages: readonly InferenceMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const item of message.content) {
      if (item.type === 'tool-call') names.set(item.id, item.name);
    }
  }
  return names;
}

function toGeminiMessage(
  message: InferenceMessage,
  toolNames: ReadonlyMap<string, string>,
  env: Env,
): Record<string, unknown>[] {
  if (message.role === 'system') {
    throw new Error('Gemini system instructions are carried outside the conversation');
  }
  if (message.role === 'assistant') return [canonicalModelContent(message, env)];
  const output: Record<string, unknown>[] = [];
  let parts: Record<string, unknown>[] = [];
  const results: InferenceToolResult[] = [];
  const flush = () => {
    if (parts.length === 0) return;
    output.push({ role: 'user', parts });
    parts = [];
  };
  for (const item of message.content) {
    if (item.type === 'tool-call') {
      throw new Error('Gemini tool calls must belong to assistant messages');
    }
    if (item.type === 'tool-result') {
      flush();
      results.push(item);
      continue;
    }
    if (results.length > 0) {
      output.push(toolResultContent(results, toolNames));
      results.length = 0;
    }
    parts.push(...toGeminiContentParts(item, env));
  }
  if (results.length > 0) output.push(toolResultContent(results, toolNames));
  flush();
  if (output.length === 0) output.push({ role: 'user', parts: [{ text: '' }] });
  return output;
}

/** Gemini takes tool results as `functionResponse` parts inside a USER turn. */
function toolResultContent(
  results: readonly InferenceToolResult[],
  toolNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    role: 'user',
    parts: results.map((result) => {
      const name = toolNames.get(result.toolCallId);
      if (!name) {
        throw new Error('Gemini tool results must follow their function call in the same request');
      }
      return {
        functionResponse: {
          id: result.toolCallId,
          name,
          response: { output: toolResultText(result) },
        },
      };
    }),
  };
}

function canonicalModelContent(message: InferenceMessage, env: Env): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  for (const item of message.content) {
    if (item.type === 'text') {
      parts.push({ text: item.text });
      continue;
    }
    if (item.type === 'tool-call') {
      parts.push({ functionCall: { id: item.id, name: item.name, args: item.input } });
      continue;
    }
    if (item.type === 'image' || item.type === 'document') {
      parts.push(...toGeminiContentParts(item, env));
      continue;
    }
    throw new Error(`Gemini model turns cannot contain ${item.type}`);
  }
  return { role: 'model', parts };
}

function modelContentFromState(
  stored: Record<string, unknown>,
  canonical: InferenceMessage,
): Record<string, unknown> {
  if (!modelContentMatchesCanonical(stored, canonical)) {
    throw new Error('Gemini continuation state did not match its canonical assistant message');
  }
  const calls = functionCallsOf(stored);
  if (calls.length > 0 && !firstFunctionCallSignature(stored)) {
    throw new Error('Gemini function-call replay is missing its thought signature');
  }
  return cloneJsonObject(stored);
}

function modelContentMatchesCanonical(
  stored: Record<string, unknown>,
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
  if (storedText(stored) !== text.join('')) return false;
  const storedCalls = functionCallsOf(stored);
  if (storedCalls.length !== canonicalCalls.length) return false;
  return storedCalls.every((storedCall, index) => {
    const canonicalCall = canonicalCalls[index];
    return (
      !!canonicalCall &&
      storedCall.id === canonicalCall.id &&
      storedCall.name === canonicalCall.name &&
      canonicalJson(storedCall.args) === canonicalJson(canonicalCall.input)
    );
  });
}

function assistantMatchesPublic(
  canonical: InferenceMessage,
  expected: GeminiPublicAssistant,
): boolean {
  const text: string[] = [];
  const toolCalls: GeminiPublicAssistant['toolCalls'][number][] = [];
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

function toGeminiContentParts(
  item: Exclude<InferenceContent, { type: 'tool-call' | 'tool-result' }>,
  env: Env,
): Record<string, unknown>[] {
  if (item.type === 'text') return [{ text: item.text }];
  if (item.type === 'image') return [toGeminiImagePart(item, env)];
  if (item.citations !== undefined) {
    throw new Error('Gemini direct document input does not support citation controls');
  }
  const prefix = [item.title, item.context].filter(Boolean).join('\n');
  const prefixParts = prefix ? [{ text: prefix }] : [];
  if (item.source.type === 'text') {
    return [{ text: `${prefix ? `${prefix}\n` : ''}${item.source.text}` }];
  }
  if (item.source.type === 'content') {
    const nested =
      typeof item.source.content === 'string'
        ? [{ text: item.source.content }]
        : item.source.content.flatMap((content) => toGeminiContentParts(content, env));
    return [...prefixParts, ...nested];
  }
  if (item.source.type === 'base64') {
    validateGeminiDocumentMediaType(item.source.mediaType);
    return [
      ...prefixParts,
      { inlineData: { mimeType: item.source.mediaType, data: item.source.data } },
    ];
  }
  if (item.source.type === 'provider-file') {
    const mediaType = item.source.reference.mediaType;
    if (mediaType === null) {
      throw new Error('Gemini document file reference omitted its validated media type');
    }
    validateGeminiDocumentMediaType(mediaType);
    return [...prefixParts, toGeminiFilePart(item.source.reference, mediaType, env)];
  }
  throw new Error('Gemini direct document input supports only text, inline, or uploaded content');
}

function toGeminiImagePart(
  item: Extract<InferenceContent, { type: 'image' }>,
  env: Env,
): Record<string, unknown> {
  const source = item.source;
  if (source.type === 'base64') {
    validateGeminiImageMediaType(source.mediaType);
    // The normative REST reference spells these fields in camelCase; several
    // guide pages show the snake_case aliases. camelCase is sent, and the
    // snake_case acceptance stays UNVERIFIED.
    return { inlineData: { mimeType: source.mediaType, data: source.data } };
  }
  if (source.type === 'url') {
    throw new Error('Gemini vision does not support external image URLs');
  }
  if (source.type === 'provider-file') {
    if (source.reference.mediaType === null) {
      throw new Error('Gemini image file reference omitted its validated media type');
    }
    validateGeminiImageMediaType(source.reference.mediaType);
    return toGeminiFilePart(source.reference, source.reference.mediaType, env);
  }
  throw new Error('Gemini received an unresolved public file reference');
}

function toGeminiFilePart(
  reference: Extract<
    Extract<InferenceContent, { type: 'image' }>['source'],
    { type: 'provider-file' }
  >['reference'],
  mediaType: string,
  env: Env,
): Record<string, unknown> {
  if (reference.provider !== 'gemini') {
    throw new Error(`Gemini cannot consume ${reference.provider} file references`);
  }
  // `fileData.fileUri` takes the FULL resource URI, never the bare resource name.
  return {
    fileData: { mimeType: mediaType, fileUri: gemini.fileUri(reference.upstreamFileId, env) },
  };
}

function toolResultText(item: InferenceToolResult): string {
  const parts: string[] = [];
  for (const content of item.content) {
    if (content.type !== 'text') {
      throw new Error('Gemini tool results support only text content');
    }
    parts.push(content.text);
  }
  const text = parts.join('\n');
  return item.isError ? `[tool error]\n${text}` : text;
}

function toGeminiFunctionDeclaration(tool: CanonicalToolDefinition): Record<string, unknown> {
  if (tool.execution === 'provider') {
    throw new Error('Gemini provider-hosted tools are not supported by this profile');
  }
  if (tool.strict === true) {
    throw new Error(`Gemini function parameters are an OpenAPI subset and cannot be strict`);
  }
  if (
    tool.kind !== undefined ||
    tool.allowedCallers !== undefined ||
    tool.deferLoading !== undefined ||
    tool.inputExamples !== undefined ||
    tool.eagerInputStreaming !== undefined
  ) {
    throw new Error(`Gemini cannot serialize provider-specific options for tool ${tool.name}`);
  }
  return { name: tool.name, description: tool.description, parameters: tool.inputSchema };
}

function toGeminiToolConfig(
  choice: NonNullable<InferenceRequest['toolChoice']>,
): Record<string, unknown> {
  if (choice.mode === 'specific') {
    return { mode: 'ANY', allowedFunctionNames: [choice.name] };
  }
  if (choice.mode === 'required') return { mode: 'ANY' };
  return { mode: choice.mode === 'none' ? 'NONE' : 'AUTO' };
}

function completionResult(raw: unknown, stateBase: GeminiStateBase): InferenceResult {
  if (!isJsonObject(raw)) throw invalidGeminiResponse('Gemini returned a non-object response');
  if (isJsonObject(raw.error)) throw geminiFailure(null, raw);
  const envelope = validateChunkEnvelope(raw, null);
  if (envelope.usageMetadata === undefined) {
    throw invalidGeminiResponse('Gemini response omitted usage metadata');
  }
  const usage = validateUsage(envelope.usageMetadata);
  const blockReason = promptBlockReason(envelope);
  const candidate =
    envelope.candidates === undefined ? null : validateCandidate(envelope.candidates);
  if (!candidate && blockReason === null) {
    throw invalidGeminiResponse('Gemini response contained no candidate');
  }
  const parts: AssembledPart[] = [];
  for (const part of candidate?.parts ?? []) appendPart(parts, part);
  return resultFromParts(parts, candidate?.finishReason ?? null, blockReason, usage, stateBase);
}

function resultFromParts(
  parts: readonly AssembledPart[],
  finishReason: string | null,
  blockReason: string | null,
  usage: GeminiUsageMetadata,
  stateBase: GeminiStateBase,
): InferenceResult {
  const calls = parts.filter(
    (part): part is Extract<AssembledPart, { kind: 'call' }> => part.kind === 'call',
  );
  if (calls.length > 0 && !calls[0]?.signature) {
    throw invalidGeminiResponse('Gemini function call omitted its thought signature');
  }
  const text = parts
    .filter((part): part is Extract<AssembledPart, { kind: 'text' }> => part.kind === 'text')
    .map((part) => part.text)
    .join('');
  // A shared output budget lets a turn spend every token on thinking and still
  // terminate with HTTP 200, a terminal `finishReason`, and only `thought: true`
  // parts. An empty success is indistinguishable downstream from a model that
  // legitimately said nothing, so a turn carrying neither visible text nor a
  // tool call fails here instead. A prompt-level block is excluded: that is a
  // rejected REQUEST, already carried as the `content-filter` stop reason.
  if (text.length === 0 && calls.length === 0 && blockReason === null) {
    throw emptyGeminiTurn(finishReason);
  }
  const content: InferenceContent[] = [];
  if (text.length > 0) content.push({ type: 'text', text, cache: 'none' });
  const toolCalls: InferenceToolCall[] = calls.map((call) => ({
    type: 'tool-call',
    id: call.id,
    name: call.name,
    input: call.args,
    cache: 'none',
  }));
  const publicText = [stateBase.currentSegment.publicAssistant.text, text]
    .filter((value) => value.length > 0)
    .join('\n');
  const state = geminiState({
    segments: [
      ...stateBase.priorSegments,
      {
        transcript: [...stateBase.currentSegment.transcript, storedModelContent(parts)],
        publicAssistant: {
          text: publicText,
          toolCalls:
            calls.length > 0
              ? [
                  ...stateBase.currentSegment.publicAssistant.toolCalls,
                  ...toolCalls.map((call) => ({
                    id: call.id,
                    name: call.name,
                    input: call.input,
                  })),
                ]
              : [],
        },
      },
    ],
  });
  const callsWithState = toolCalls.map((call) => ({ ...call, providerState: state }));
  content.push(...callsWithState);
  return {
    content,
    toolCalls: callsWithState,
    usage: normalizeUsage(usage),
    stopReason: normalizeStopReason(finishReason, blockReason, calls.length > 0),
    providerStopReason: blockReason ?? finishReason,
    providerState: state,
  };
}

/** The exact `role:"model"` content replayed next turn, signatures preserved. */
function storedModelContent(parts: readonly AssembledPart[]): Record<string, unknown> {
  return {
    role: 'model',
    parts: parts.map((part) => ({
      ...(part.kind === 'text'
        ? { text: part.text }
        : { functionCall: { id: part.id, name: part.name, args: part.args } }),
      ...(part.signature ? { thoughtSignature: part.signature } : {}),
    })),
  };
}

/** Merge a streamed or whole response part into the assembled turn. */
function appendPart(parts: AssembledPart[], part: Record<string, unknown>): string | null {
  const signature = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : null;
  if (isJsonObject(part.functionCall)) {
    const call = validateFunctionCall(part.functionCall);
    parts.push({ kind: 'call', id: call.id, name: call.name, args: call.args, signature });
    return null;
  }
  if (typeof part.text !== 'string') {
    throw invalidGeminiResponse('Gemini returned an unsupported content part');
  }
  // A part flagged `thought: true` is a reasoning summary — transcript-display
  // material that is never replayed and never joined to the assistant text.
  if (part.thought === true) return null;
  const last = parts.at(-1);
  if (last && last.kind === 'text') {
    last.text += part.text;
    if (!last.signature && signature) last.signature = signature;
  } else {
    parts.push({ kind: 'text', text: part.text, signature });
  }
  return part.text.length > 0 ? part.text : null;
}

interface ValidatedCandidate {
  readonly parts: readonly Record<string, unknown>[];
  readonly finishReason: string | null;
}

function validateCandidate(raw: unknown): ValidatedCandidate | null {
  if (!Array.isArray(raw)) {
    throw invalidGeminiResponse('Gemini returned an unexpected candidate list');
  }
  if (raw.length === 0) return null;
  if (raw.length !== 1) {
    throw invalidGeminiResponse('Gemini returned an unexpected candidate list');
  }
  const candidate = raw[0];
  if (!isJsonObject(candidate)) {
    throw invalidGeminiResponse('Gemini returned an invalid candidate');
  }
  if (candidate.index !== undefined && candidate.index !== 0) {
    throw invalidGeminiResponse('Gemini returned an unexpected candidate index');
  }
  if (
    candidate.finishReason !== undefined &&
    (typeof candidate.finishReason !== 'string' || candidate.finishReason.length === 0)
  ) {
    throw invalidGeminiResponse('Gemini returned an invalid finish reason');
  }
  let parts: readonly Record<string, unknown>[] = [];
  if (candidate.content !== undefined) {
    if (!isJsonObject(candidate.content)) {
      throw invalidGeminiResponse('Gemini returned an invalid candidate content');
    }
    if (candidate.content.role !== undefined && candidate.content.role !== 'model') {
      throw invalidGeminiResponse('Gemini returned a candidate outside the model role');
    }
    if (candidate.content.parts !== undefined) {
      if (!Array.isArray(candidate.content.parts)) {
        throw invalidGeminiResponse('Gemini returned invalid candidate parts');
      }
      parts = candidate.content.parts.map((part) => {
        if (!isJsonObject(part)) throw invalidGeminiResponse('Gemini returned an invalid part');
        return part;
      });
    }
  }
  return {
    parts,
    finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : null,
  };
}

interface ValidatedEnvelope extends Readonly<Record<string, unknown>> {
  readonly responseId?: string;
  readonly candidates?: unknown;
  readonly usageMetadata?: unknown;
}

function validateChunkEnvelope(raw: unknown, expectedResponseId: string | null): ValidatedEnvelope {
  if (!isJsonObject(raw)) throw invalidGeminiResponse('Gemini returned a non-object chunk');
  if (
    raw.responseId !== undefined &&
    (typeof raw.responseId !== 'string' ||
      raw.responseId.length === 0 ||
      (expectedResponseId !== null && raw.responseId !== expectedResponseId))
  ) {
    throw invalidGeminiResponse('Gemini stream chunk changed its response identity');
  }
  if (raw.modelVersion !== undefined && typeof raw.modelVersion !== 'string') {
    throw invalidGeminiResponse('Gemini returned an invalid model version');
  }
  if (raw.usageMetadata !== undefined && !isJsonObject(raw.usageMetadata)) {
    throw invalidGeminiResponse('Gemini returned invalid usage metadata');
  }
  if (raw.candidates !== undefined && !Array.isArray(raw.candidates)) {
    throw invalidGeminiResponse('Gemini returned an invalid candidate list');
  }
  return raw as ValidatedEnvelope;
}

function promptBlockReason(envelope: ValidatedEnvelope): string | null {
  const feedback = envelope.promptFeedback;
  if (feedback === undefined) return null;
  if (!isJsonObject(feedback)) {
    throw invalidGeminiResponse('Gemini returned invalid prompt feedback');
  }
  if (feedback.blockReason === undefined) return null;
  if (typeof feedback.blockReason !== 'string' || feedback.blockReason.length === 0) {
    throw invalidGeminiResponse('Gemini returned an invalid prompt block reason');
  }
  return feedback.blockReason;
}

function validateFunctionCall(raw: Record<string, unknown>): GeminiFunctionCall {
  if (
    typeof raw.id !== 'string' ||
    raw.id.length === 0 ||
    typeof raw.name !== 'string' ||
    raw.name.length === 0 ||
    (raw.args !== undefined && !isJsonObject(raw.args))
  ) {
    throw invalidGeminiResponse('Gemini function call was invalid');
  }
  return { id: raw.id, name: raw.name, args: isJsonObject(raw.args) ? raw.args : {} };
}

function validateUsage(raw: unknown): GeminiUsageMetadata {
  if (!isJsonObject(raw)) throw invalidGeminiResponse('Gemini usage metadata was not an object');
  for (const key of ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount'] as const) {
    if (!isNonNegativeInteger(raw[key])) {
      throw invalidGeminiResponse(`Gemini usageMetadata.${key} was invalid`);
    }
  }
  for (const key of ['cachedContentTokenCount', 'thoughtsTokenCount'] as const) {
    if (raw[key] !== undefined && !isNonNegativeInteger(raw[key])) {
      throw invalidGeminiResponse(`Gemini usageMetadata.${key} was invalid`);
    }
  }
  return raw as unknown as GeminiUsageMetadata;
}

/**
 * Gemini counts a cache hit INSIDE `promptTokenCount`, unlike Anthropic's
 * disjoint `cache_read_input_tokens`. `cachedInputTokens` therefore reports a
 * subset of `inputTokens` here, and cache writes are billed on the separate
 * `cachedContents` resource rather than on a completion.
 */
function normalizeUsage(usage: GeminiUsageMetadata): InferenceUsage {
  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    cachedInputTokens: usage.cachedContentTokenCount ?? null,
    cacheWriteInputTokens: null,
    reasoningTokens: usage.thoughtsTokenCount ?? null,
    providerDetails: { ...usage },
  };
}

/**
 * A `functionCall` part means the model wants tools whatever `finishReason`
 * says — Gemini returns `STOP` alongside function calls. The published
 * `finishReason` enum cannot be closed from documentation, so an unrecognized
 * value degrades to `unknown` and keeps its raw string in `providerStopReason`.
 */
function normalizeStopReason(
  finishReason: string | null,
  blockReason: string | null,
  sawToolCall: boolean,
): InferenceStopReason {
  if (sawToolCall) return 'tool-call';
  if (blockReason !== null) return 'content-filter';
  if (finishReason === 'STOP') return 'completed';
  if (finishReason === 'MAX_TOKENS') return 'max-output-tokens';
  if (
    finishReason === 'SAFETY' ||
    finishReason === 'RECITATION' ||
    finishReason === 'LANGUAGE' ||
    finishReason === 'PROHIBITED_CONTENT' ||
    finishReason === 'BLOCKLIST' ||
    finishReason === 'SPII' ||
    finishReason === 'IMAGE_SAFETY'
  ) {
    return 'content-filter';
  }
  if (
    finishReason === 'MALFORMED_FUNCTION_CALL' ||
    finishReason === 'MALFORMED_TOOL_CALL' ||
    finishReason === 'UNEXPECTED_TOOL_CALL' ||
    finishReason === 'TOO_MANY_TOOL_CALLS' ||
    finishReason === 'MISSING_THOUGHT_SIGNATURE'
  ) {
    return 'error';
  }
  return 'unknown';
}

function geminiState(data: GeminiContinuationData): ProviderContinuationState {
  return {
    backend: 'gemini',
    value: {
      segments: data.segments.map((segment) => ({
        transcript: segment.transcript.map((content) => cloneJsonObject(content)),
        publicAssistant: cloneJson(segment.publicAssistant),
      })),
    },
    requiredOnNextTurn: true,
  };
}

function emptyContinuationSegment(): GeminiContinuationSegment {
  return { transcript: [], publicAssistant: { text: '', toolCalls: [] } };
}

function continuationData(continuation?: ProviderContinuationState): GeminiContinuationData {
  if (!continuation) return { segments: [] };
  if (continuation.backend !== 'gemini') {
    throw new Error(`Gemini cannot consume ${continuation.backend} continuation state`);
  }
  if (!isJsonObject(continuation.value) || !Array.isArray(continuation.value.segments)) {
    throw new Error('Gemini continuation state did not contain model history');
  }
  const segments = continuation.value.segments;
  if (segments.length === 0) {
    throw new Error('Gemini continuation state did not contain model history');
  }
  return { segments: segments.map(validateContinuationSegment) };
}

function validateContinuationSegment(raw: unknown): GeminiContinuationSegment {
  if (!isJsonObject(raw) || !Array.isArray(raw.transcript) || raw.transcript.length === 0) {
    throw new Error('Gemini continuation state contained an invalid transcript segment');
  }
  const transcript = raw.transcript.map(validateTranscriptContent);
  if (transcript[0]?.role !== 'model') {
    throw new Error('Gemini continuation transcript must start with a model turn');
  }
  const availableCalls = new Set<string>();
  for (const content of transcript) {
    if (content.role === 'model') {
      for (const call of functionCallsOf(content)) availableCalls.add(call.id);
      continue;
    }
    for (const response of functionResponsesOf(content)) {
      if (!availableCalls.delete(response.id)) {
        throw new Error('Gemini continuation transcript contained an unmatched tool result');
      }
    }
  }
  if (!validPublicAssistant(raw.publicAssistant)) {
    throw new Error('Gemini continuation state contained an invalid public assistant');
  }
  return { transcript, publicAssistant: raw.publicAssistant };
}

function validPublicAssistant(raw: unknown): raw is GeminiPublicAssistant {
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

function validateTranscriptContent(raw: unknown): Record<string, unknown> {
  if (
    !isJsonObject(raw) ||
    (raw.role !== 'model' && raw.role !== 'user') ||
    !Array.isArray(raw.parts)
  ) {
    throw new Error('Gemini continuation transcript contained an invalid content entry');
  }
  for (const part of raw.parts) {
    if (!isJsonObject(part)) {
      throw new Error('Gemini continuation transcript contained an invalid part');
    }
    if (isJsonObject(part.functionCall)) {
      validateFunctionCall(part.functionCall);
      continue;
    }
    if (isJsonObject(part.functionResponse)) {
      const response = part.functionResponse;
      if (
        typeof response.id !== 'string' ||
        response.id.length === 0 ||
        typeof response.name !== 'string' ||
        response.name.length === 0 ||
        !isJsonObject(response.response)
      ) {
        throw new Error('Gemini continuation transcript contained an invalid tool result');
      }
      continue;
    }
    if (typeof part.text !== 'string') {
      throw new Error('Gemini continuation transcript contained an invalid part');
    }
  }
  return raw;
}

function functionCallsOf(content: Record<string, unknown>): readonly GeminiFunctionCall[] {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.flatMap((part) =>
    isJsonObject(part) && isJsonObject(part.functionCall)
      ? [validateFunctionCall(part.functionCall)]
      : [],
  );
}

function functionResponsesOf(content: Record<string, unknown>): readonly { id: string }[] {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.flatMap((part) =>
    isJsonObject(part) &&
    isJsonObject(part.functionResponse) &&
    typeof part.functionResponse.id === 'string'
      ? [{ id: part.functionResponse.id }]
      : [],
  );
}

function firstFunctionCallSignature(content: Record<string, unknown>): string | null {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  for (const part of parts) {
    if (!isJsonObject(part) || !isJsonObject(part.functionCall)) continue;
    return typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
      ? part.thoughtSignature
      : null;
  }
  return null;
}

function storedText(content: Record<string, unknown>): string {
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .flatMap((part) => (isJsonObject(part) && typeof part.text === 'string' ? [part.text] : []))
    .join('');
}

function hasParts(content: Record<string, unknown>): boolean {
  return Array.isArray(content.parts) && content.parts.length > 0;
}

function assertSupportedGeminiModel(model: string): void {
  if (!model.startsWith(GEMINI_SUPPORTED_MODEL_PREFIX)) {
    throw new Error(`Gemini adapter does not support model ${model}`);
  }
  if (NON_GENERATE_CONTENT_MODEL_MARKERS.some((marker) => model.includes(marker))) {
    throw new Error(`Gemini model ${model} does not serve generateContent`);
  }
}

function validateGeminiImageMediaType(mediaType: string): void {
  if (!GEMINI_IMAGE_MEDIA_TYPES.has(mediaType.toLowerCase())) {
    throw new Error(`Gemini image input does not support media type ${mediaType}`);
  }
}

function validateGeminiDocumentMediaType(mediaType: string): void {
  const normalized = mediaType.toLowerCase();
  if (!GEMINI_DOCUMENT_MEDIA_TYPES.has(normalized) && !GEMINI_IMAGE_MEDIA_TYPES.has(normalized)) {
    throw new Error(`Gemini document input does not support media type ${mediaType}`);
  }
}

function validateGeminiUploadMediaType(mediaType: string): void {
  const normalized = mediaType.toLowerCase();
  if (!GEMINI_IMAGE_MEDIA_TYPES.has(normalized) && !GEMINI_DOCUMENT_MEDIA_TYPES.has(normalized)) {
    throw new Error(`Gemini file upload does not support media type ${mediaType}`);
  }
}

function validateRequestRoute(request: InferenceRequest): void {
  const profile = request.modelProfile;
  if (profile.provider !== 'gemini' || profile.apiFamily !== 'gemini-generate-content') {
    throw new Error(
      `Gemini adapter cannot serve ${profile.provider}/${profile.apiFamily} (${profile.name})`,
    );
  }
  validateFilePolicy(request.filePolicy);
}

function validateFilePolicy(policy: FilePolicy): void {
  if (
    policy.provider !== 'gemini' ||
    !policy.compatibleApiFamilies.includes('gemini-generate-content') ||
    policy.inputMode !== 'provider-file' ||
    policy.lifecycle !== 'provider-managed' ||
    // The Gemini File resource has no `purpose` concept at all.
    policy.purpose !== null
  ) {
    throw new Error(`Gemini cannot use file policy ${policy.name}`);
  }
}

interface ValidatedGeminiFile {
  readonly id: string;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
  readonly expiresAt: string | null;
  readonly state: string;
}

function validateFileRecord(
  raw: unknown,
  env: Env,
  expectedMediaType: string | null,
  expectedId?: string,
  requireUri = true,
): ValidatedGeminiFile {
  if (
    !isJsonObject(raw) ||
    typeof raw.name !== 'string' ||
    raw.name.length === 0 ||
    (expectedId !== undefined && raw.name !== expectedId) ||
    typeof raw.mimeType !== 'string' ||
    raw.mimeType.length === 0 ||
    (expectedMediaType !== null && raw.mimeType !== expectedMediaType) ||
    typeof raw.state !== 'string' ||
    raw.state.length === 0 ||
    (raw.sizeBytes !== undefined && !isNumericString(raw.sizeBytes)) ||
    (raw.expirationTime !== undefined && typeof raw.expirationTime !== 'string')
  ) {
    throw invalidGeminiResponse('Gemini file response was invalid');
  }
  if (raw.state === FILE_STATE_FAILED) {
    throw invalidGeminiResponse('Gemini file upload failed to process');
  }
  // Files are referenced by their FULL uri; pin that the reconstructed uri is
  // exactly what the provider returned so a stored resource name stays valid.
  if (requireUri && raw.uri !== gemini.fileUri(raw.name, env)) {
    throw invalidGeminiResponse('Gemini file uri did not match its resource name');
  }
  return {
    id: raw.name,
    mediaType: raw.mimeType,
    sizeBytes: typeof raw.sizeBytes === 'string' ? Number(raw.sizeBytes) : null,
    expiresAt: typeof raw.expirationTime === 'string' ? raw.expirationTime : null,
    state: raw.state,
  };
}

function delay(milliseconds: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(geminiTransportFailure(new DOMException('Aborted', 'AbortError'), abortSignal));
      return;
    }
    setTimeout(resolve, milliseconds);
  });
}

function sseBoundary(buffer: string): number {
  const lineFeed = buffer.indexOf('\n\n');
  const carriageReturn = buffer.indexOf('\r\n\r\n');
  if (lineFeed === -1) return carriageReturn;
  if (carriageReturn === -1) return lineFeed;
  return Math.min(lineFeed, carriageReturn);
}

async function callGemini(
  operation: () => Promise<Response>,
  abortSignal?: AbortSignal,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    throw geminiTransportFailure(error, abortSignal);
  }
}

function geminiTransportFailure(error: unknown, abortSignal?: AbortSignal): InferenceFailure {
  if (error instanceof InferenceFailure) return error;
  const name = error instanceof Error ? error.name : '';
  const timedOut = name === 'TimeoutError';
  const cancelled = !timedOut && (abortSignal?.aborted === true || name === 'AbortError');
  return new InferenceFailure({
    backend: 'gemini',
    status: null,
    code: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network_error',
    message: cancelled
      ? 'Gemini request was cancelled'
      : timedOut
        ? 'Gemini request timed out'
        : 'Gemini network request failed',
    retryable: !cancelled,
    failureClass: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network',
  });
}

/**
 * The published error envelope is UNVERIFIED between two current shapes: a
 * lowercase string `code`, and the classic integer `code` plus an uppercase
 * `status`. Both are parsed; the normalized code prefers `status`, then a
 * string `code`.
 */
function geminiFailure(status: number | null, raw: unknown): InferenceFailure {
  const root = isJsonObject(raw) ? raw : undefined;
  const error = root && isJsonObject(root.error) ? root.error : undefined;
  const code =
    typeof error?.status === 'string' && error.status.length > 0
      ? error.status
      : typeof error?.code === 'string' && error.code.length > 0
        ? error.code
        : 'gemini_error';
  return new InferenceFailure({
    backend: 'gemini',
    status,
    code,
    message: `Gemini request failed${status === null ? '' : ` (${status})`}`,
    retryable: isRetryableGeminiFailure(status, code),
    failureClass: 'http',
  });
}

/**
 * 429 is overloaded on this API: a per-minute rate limit recovers quickly while
 * an exhausted daily quota does not, so only the transient codes retry.
 */
function isRetryableGeminiFailure(status: number | null, code: string): boolean {
  const exhausted = new Set(['quota_exceeded', 'QUOTA_EXCEEDED']);
  if (exhausted.has(code)) return false;
  if (code === 'unimplemented' || code === 'UNIMPLEMENTED') return false;
  if (status === 408 || status === 429) return true;
  if (status !== null && status >= 500) return true;
  return new Set([
    'rate_limit_exceeded',
    'too_many_requests',
    'RESOURCE_EXHAUSTED',
    'api_error',
    'INTERNAL',
    'service_unavailable',
    'UNAVAILABLE',
    'deadline_exceeded',
    'DEADLINE_EXCEEDED',
    'aborted',
    'ABORTED',
  ]).has(code);
}

async function readGeminiJson<T>(response: Response, abortSignal?: AbortSignal): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        abortSignal?.aborted === true)
    ) {
      throw geminiTransportFailure(error, abortSignal);
    }
    throw new InferenceFailure({
      backend: 'gemini',
      status: response.status,
      code: 'invalid_response',
      message: 'Gemini returned an invalid JSON response',
      detail: error instanceof Error ? error.message : String(error),
      retryable: response.status >= 500,
      failureClass: 'invalid-response',
    });
  }
}

/**
 * A terminal turn that produced nothing a caller can use. The provider's finish
 * reason rides in the detail, so a budget starvation (`MAX_TOKENS`) stays
 * distinguishable from a terminal refusal in one normalized failure.
 */
function emptyGeminiTurn(finishReason: string | null): InferenceFailure {
  return new InferenceFailure({
    backend: 'gemini',
    status: null,
    code: 'empty_response',
    message: 'Gemini returned no visible assistant content',
    detail: `finishReason ${finishReason ?? 'absent'}`,
    retryable: false,
    failureClass: 'invalid-response',
  });
}

function invalidGeminiResponse(message: string, cause?: unknown): InferenceFailure {
  return new InferenceFailure({
    backend: 'gemini',
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

function isNumericString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
