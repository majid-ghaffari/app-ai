/** OpenAI Responses adapter: canonical translation, streaming, files, and failures. */

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
import * as openai from './openai-wire';

interface OpenAIErrorBody {
  error?: {
    code?: string | null;
    type?: string;
    message?: string;
    param?: string | null;
  } | null;
}

interface OpenAIResponseBody extends OpenAIErrorBody {
  id?: string;
  object?: string;
  created_at?: number;
  model?: string;
  status?: string;
  output?: unknown;
  usage?: unknown;
  incomplete_details?: { reason?: string } | null;
}

interface OpenAIStreamEvent extends OpenAIErrorBody {
  [member: string]: unknown;
  type?: string;
  sequence_number?: number;
  delta?: unknown;
  response?: unknown;
}

interface OpenAIUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
  [member: string]: unknown;
}

type OpenAIInputContent = Readonly<Record<string, unknown>>;
type OpenAIInputItem = Readonly<Record<string, unknown>>;

/** OpenAI adapter bound to one Worker environment. */
export class OpenAIResponsesAdapter implements InferenceProviderAdapter {
  readonly provider = 'openai' as const;
  readonly apiFamily = 'openai-responses' as const;

  constructor(private readonly env: Env) {}

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    validateRequestRoute(request);
    const response = await callOpenAI(
      () => openai.createResponse(toOpenAIPayload(request), this.env, request.abortSignal),
      request.abortSignal,
    );
    const data = await readOpenAIJson<OpenAIResponseBody>(response);
    if (!response.ok) throw openAIFailure(response.status, data);
    if (isJsonObject(data) && data.status === 'failed') throw responseFailure(data);
    if (isJsonObject(data) && data.status === 'cancelled') {
      throw cancelledResponseFailure(data);
    }
    return responseResult(data);
  }

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    validateRequestRoute(request);
    const response = await callOpenAI(
      () =>
        openai.createResponse(
          { ...toOpenAIPayload(request), stream: true },
          this.env,
          request.abortSignal,
        ),
      request.abortSignal,
    );
    if (!response.ok) {
      const data = await readOpenAIJson<OpenAIResponseBody>(response);
      throw openAIFailure(response.status, data);
    }
    if (!response.body) throw invalidOpenAIResponse('OpenAI stream omitted a response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let createdId: string | null = null;
    let terminal = false;
    let lastSequence = -1;
    const lifecycle = new OpenAIStreamLifecycle();

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw openAITransportFailure(error, request.abortSignal);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trimEnd();
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(json) as unknown;
        } catch (error) {
          throw invalidOpenAIResponse('OpenAI stream contained invalid JSON', error);
        }
        if (!isJsonObject(parsed)) {
          throw invalidOpenAIResponse('OpenAI stream event was not an object');
        }
        const event = parsed as OpenAIStreamEvent;
        if (typeof event.type !== 'string') {
          throw invalidOpenAIResponse('OpenAI stream event omitted its type');
        }
        if (!isNonNegativeInteger(event.sequence_number) || event.sequence_number <= lastSequence) {
          throw invalidOpenAIResponse('OpenAI stream event sequence was invalid');
        }
        lastSequence = event.sequence_number;
        if (terminal) {
          throw invalidOpenAIResponse('OpenAI stream emitted data after its terminal event');
        }

        if (event.type === 'error') throw openAIEventFailure(event);
        if (event.type === 'response.created') {
          if (createdId !== null || !validCreatedResponse(event.response)) {
            throw invalidOpenAIResponse('OpenAI stream contained an invalid response.created');
          }
          createdId = event.response.id;
          lifecycle.start(event.response.status);
          yield { type: 'message-start' };
          continue;
        }
        if (createdId === null) {
          throw invalidOpenAIResponse('OpenAI stream emitted output before response.created');
        }
        if (event.type === 'response.output_text.delta') {
          validateIndexedTextEvent(event, 'delta');
          lifecycle.textDelta(event, 'output_text');
          yield { type: 'text-delta', delta: event.delta as string };
          continue;
        }
        if (event.type === 'response.refusal.delta') {
          validateIndexedTextEvent(event, 'delta');
          lifecycle.textDelta(event, 'refusal');
          yield { type: 'text-delta', delta: event.delta as string };
          continue;
        }
        if (event.type === 'response.completed') {
          const result = responseResult(event.response, createdId, 'completed');
          lifecycle.terminal(event.response);
          terminal = true;
          for (const call of result.toolCalls) yield { type: 'tool-call', call };
          yield { type: 'usage', usage: result.usage };
          yield { type: 'complete', result };
          continue;
        }
        if (event.type === 'response.incomplete') {
          const result = responseResult(event.response, createdId, 'incomplete');
          lifecycle.terminal(event.response);
          terminal = true;
          for (const call of result.toolCalls) yield { type: 'tool-call', call };
          yield { type: 'usage', usage: result.usage };
          yield { type: 'complete', result };
          continue;
        }
        if (event.type === 'response.failed') {
          terminal = true;
          throw responseFailure(event.response, createdId);
        }
        if (event.type === 'response.cancelled') {
          terminal = true;
          throw cancelledResponseFailure(event.response, createdId);
        }
        if (isProgressEvent(event.type)) {
          validateProgressEvent(event, createdId, lifecycle);
          continue;
        }
        throw invalidOpenAIResponse(`OpenAI stream contained unknown ${event.type} event`);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      throw invalidOpenAIResponse('OpenAI stream ended with a truncated event');
    }
    if (!terminal) throw invalidOpenAIResponse('OpenAI stream ended before a terminal event');
  }

  async getFileScope(policy: FilePolicy): Promise<string> {
    validateFilePolicy(policy);
    return openai.fileAccountScope(this.env);
  }

  async uploadFile(request: ProviderUploadRequest): Promise<ProviderUploadResult> {
    validateFilePolicy(request.policy);
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([request.bytes], { type: request.mediaType }),
      request.filename,
    );
    formData.append('purpose', request.policy.purpose as string);
    const response = await callOpenAI(
      () => openai.uploadFile(formData, this.env, request.abortSignal),
      request.abortSignal,
    );
    const data = await readOpenAIJson<unknown>(response);
    if (!response.ok) throw openAIFailure(response.status, data);
    validateOpenAIFileRecord(data, undefined, request.policy.purpose as string);
    return {
      id: data.id,
      mediaType: request.mediaType,
      sizeBytes: data.bytes,
      expiresAt: expiryFrom(data.expires_at),
    };
  }

  async getFileMetadata(
    id: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderFileMetadata | null> {
    const response = await callOpenAI(
      () => openai.getFileMetadata(id, this.env, abortSignal),
      abortSignal,
    );
    if (response.status === 404) return null;
    const data = await readOpenAIJson<unknown>(response);
    if (!response.ok) throw openAIFailure(response.status, data);
    validateOpenAIFileRecord(data, id, 'user_data');
    return {
      id: data.id,
      mediaType: null,
      sizeBytes: data.bytes,
      expiresAt: expiryFrom(data.expires_at),
    };
  }

  async deleteFile(id: string, abortSignal?: AbortSignal): Promise<void> {
    const response = await callOpenAI(
      () => openai.deleteFile(id, this.env, abortSignal),
      abortSignal,
    );
    const data = await readOpenAIJson<unknown>(response);
    if (!response.ok) throw openAIFailure(response.status, data);
    if (!isJsonObject(data) || data.object !== 'file' || data.id !== id || data.deleted !== true) {
      throw invalidOpenAIResponse('OpenAI file deletion response was invalid');
    }
  }
}

function toOpenAIPayload(request: InferenceRequest): Record<string, unknown> {
  const continuationId = continuationResponseId(request.continuation);
  const input: OpenAIInputItem[] = [
    ...(continuationId
      ? []
      : [
          {
            type: 'message',
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: request.prompt,
                prompt_cache_breakpoint: { mode: 'explicit' },
              },
            ],
          },
        ]),
    ...toOpenAIInput(request.messages, continuationId),
  ];
  const payload: Record<string, unknown> = {
    model: request.modelProfile.model,
    input,
    max_output_tokens: request.maxOutputTokens,
    store: true,
  };
  const breakpoints = countPromptCacheBreakpoints(input);
  if (breakpoints > 4) {
    throw new Error('OpenAI Responses supports at most 4 writable prompt-cache breakpoints');
  }
  if (!request.modelProfile.capabilities.inlineCacheBreakpoints) {
    throw new Error(`OpenAI model profile ${request.modelProfile.name} cannot cache prompts`);
  }
  payload.prompt_cache_key = `app-ai:${request.promptGroup}:${request.modelProfile.name}`;
  payload.prompt_cache_options = { mode: 'explicit', ttl: '30m' };
  if (continuationId) payload.previous_response_id = continuationId;
  if (request.effort) payload.reasoning = { effort: request.effort };
  if (request.structuredOutput) {
    payload.text = {
      format: {
        type: 'json_schema',
        name: request.structuredOutput.name,
        ...(request.structuredOutput.description
          ? { description: request.structuredOutput.description }
          : {}),
        schema: request.structuredOutput.schema,
        strict: request.structuredOutput.strict,
      },
    };
  }
  if (request.tools.length > 0) payload.tools = request.tools.map(toOpenAITool);
  if (request.toolChoice) {
    payload.tool_choice = toOpenAIToolChoice(request.toolChoice);
    if (request.toolChoice.disableParallel !== undefined) {
      payload.parallel_tool_calls = !request.toolChoice.disableParallel;
    }
  }
  if (request.sampling) {
    if (request.sampling.temperature !== undefined) {
      payload.temperature = request.sampling.temperature;
    }
    if (request.sampling.topP !== undefined) payload.top_p = request.sampling.topP;
    if (request.sampling.topK !== undefined) {
      throw new Error('OpenAI Responses does not support canonical topK sampling');
    }
  }
  if (request.stopSequences?.length) {
    throw new Error('OpenAI Responses does not support canonical stop sequences');
  }
  if (request.metadata) payload.metadata = request.metadata;
  if (request.serviceTier) payload.service_tier = request.serviceTier;
  return payload;
}

function toOpenAIInput(
  messages: readonly InferenceMessage[],
  continuationId: string | null,
): OpenAIInputItem[] {
  let selected = messages;
  if (continuationId) {
    let boundary = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message?.role === 'assistant' &&
        (!message.providerState || continuationResponseId(message.providerState) === continuationId)
      ) {
        boundary = index;
        break;
      }
    }
    if (boundary >= 0) selected = messages.slice(boundary + 1);
  }
  return selected.flatMap(toOpenAIMessageItems);
}

function toOpenAIMessageItems(message: InferenceMessage): OpenAIInputItem[] {
  const items: OpenAIInputItem[] = [];
  let messageContent: OpenAIInputContent[] = [];
  const flushMessage = () => {
    if (messageContent.length === 0) return;
    items.push({ type: 'message', role: message.role, content: messageContent });
    messageContent = [];
  };
  for (const content of message.content) {
    if (content.type === 'tool-call') {
      flushMessage();
      items.push({
        type: 'function_call',
        call_id: content.id,
        name: content.name,
        arguments: JSON.stringify(content.input),
      });
      continue;
    }
    if (content.type === 'tool-result') {
      flushMessage();
      items.push({
        type: 'function_call_output',
        call_id: content.toolCallId,
        output: toOpenAIToolOutput(content),
      });
      continue;
    }
    messageContent.push(...toOpenAIInputContent(content));
  }
  flushMessage();
  return items;
}

function toOpenAIInputContent(
  content: Exclude<InferenceContent, { type: 'tool-call' | 'tool-result' }>,
): OpenAIInputContent[] {
  if (content.type === 'text') {
    return withPromptCacheBreakpoint([{ type: 'input_text', text: content.text }], content.cache);
  }
  if (content.type === 'image') {
    return withPromptCacheBreakpoint([toOpenAIImage(content)], content.cache);
  }
  const prefix = [content.title, content.context].filter(Boolean).join('\n');
  if (content.source.type === 'content') {
    const nested =
      typeof content.source.content === 'string'
        ? [{ type: 'input_text', text: content.source.content }]
        : content.source.content.flatMap((item) => toOpenAIInputContent(item));
    return withPromptCacheBreakpoint(
      prefix ? [{ type: 'input_text', text: prefix }, ...nested] : nested,
      content.cache,
    );
  }
  if (content.source.type === 'text') {
    return withPromptCacheBreakpoint(
      [
        {
          type: 'input_text',
          text: `${prefix ? `${prefix}\n` : ''}${content.source.text}`,
        },
      ],
      content.cache,
    );
  }
  const file: Record<string, unknown> = { type: 'input_file' };
  if (content.source.type === 'provider-file') {
    if (content.source.reference.provider !== 'openai') {
      throw new Error(`OpenAI cannot consume ${content.source.reference.provider} file references`);
    }
    file.file_id = content.source.reference.upstreamFileId;
  } else if (content.source.type === 'base64') {
    file.filename = content.title || filenameFor(content.source.mediaType);
    file.file_data = `data:${content.source.mediaType};base64,${content.source.data}`;
  } else if (content.source.type === 'url') {
    file.file_url = content.source.url;
  } else {
    throw new Error('OpenAI received an unresolved public file reference');
  }
  return withPromptCacheBreakpoint(
    prefix ? [{ type: 'input_text', text: prefix }, file] : [file],
    content.cache,
  );
}

function toOpenAIImage(content: Extract<InferenceContent, { type: 'image' }>): OpenAIInputContent {
  const source = content.source;
  if (source.type === 'provider-file') {
    if (source.reference.provider !== 'openai') {
      throw new Error(`OpenAI cannot consume ${source.reference.provider} file references`);
    }
    return { type: 'input_image', file_id: source.reference.upstreamFileId, detail: 'auto' };
  }
  if (source.type === 'base64') {
    return {
      type: 'input_image',
      image_url: `data:${source.mediaType};base64,${source.data}`,
      detail: 'auto',
    };
  }
  if (source.type === 'url') return { type: 'input_image', image_url: source.url, detail: 'auto' };
  throw new Error('OpenAI received an unresolved public file reference');
}

function toOpenAIToolOutput(content: Extract<InferenceContent, { type: 'tool-result' }>): unknown {
  const parts = withPromptCacheBreakpoint(
    content.content.flatMap((item) => toOpenAIInputContent(item)),
    content.cache,
  );
  if (
    parts.length === 1 &&
    parts[0]?.type === 'input_text' &&
    parts[0].prompt_cache_breakpoint === undefined
  ) {
    const text = String(parts[0].text ?? '');
    return content.isError ? `[tool error]\n${text}` : text;
  }
  return content.isError ? [{ type: 'input_text', text: '[tool error]' }, ...parts] : parts;
}

function withPromptCacheBreakpoint(
  blocks: readonly OpenAIInputContent[],
  cache: InferenceContent['cache'],
): OpenAIInputContent[] {
  const cloned = blocks.map((block) => ({ ...block }));
  if (cache === 'none' || cloned.length === 0) return cloned;
  const last = cloned.at(-1);
  if (last) last.prompt_cache_breakpoint = { mode: 'explicit' };
  return cloned;
}

function countPromptCacheBreakpoints(input: readonly OpenAIInputItem[]): number {
  let count = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isJsonObject(value)) return;
    if (value.prompt_cache_breakpoint !== undefined) count += 1;
    Object.values(value).forEach(visit);
  };
  visit(input);
  return count;
}

function toOpenAITool(tool: CanonicalToolDefinition): Record<string, unknown> {
  if (tool.execution === 'provider') {
    throw new Error('OpenAI provider-hosted tools are not supported by this candidate profile');
  }
  if (
    tool.kind !== undefined ||
    tool.allowedCallers !== undefined ||
    tool.deferLoading !== undefined ||
    tool.inputExamples !== undefined ||
    tool.eagerInputStreaming !== undefined
  ) {
    throw new Error(`OpenAI cannot serialize provider-specific options for tool ${tool.name}`);
  }
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
}

function toOpenAIToolChoice(
  choice: NonNullable<InferenceRequest['toolChoice']>,
): string | Record<string, unknown> {
  if (choice.mode === 'specific') return { type: 'function', name: choice.name };
  return choice.mode;
}

function responseResult(
  raw: unknown,
  expectedId?: string,
  expectedStatus?: 'completed' | 'incomplete',
): InferenceResult {
  if (!isJsonObject(raw)) throw invalidOpenAIResponse('OpenAI returned a non-object response');
  const data = raw as OpenAIResponseBody;
  if (
    data.object !== 'response' ||
    typeof data.id !== 'string' ||
    data.id.length === 0 ||
    (expectedId !== undefined && data.id !== expectedId) ||
    typeof data.model !== 'string' ||
    data.model.length === 0 ||
    !isNonNegativeInteger(data.created_at) ||
    (data.status !== 'completed' && data.status !== 'incomplete') ||
    (expectedStatus !== undefined && data.status !== expectedStatus) ||
    !Array.isArray(data.output)
  ) {
    throw invalidOpenAIResponse('OpenAI returned an incomplete Responses envelope');
  }
  if (data.error !== undefined && data.error !== null) {
    throw responseFailure(data, expectedId);
  }
  if (
    (data.status === 'completed' &&
      data.incomplete_details !== undefined &&
      data.incomplete_details !== null) ||
    (data.status === 'incomplete' &&
      data.incomplete_details !== undefined &&
      data.incomplete_details !== null &&
      (!isJsonObject(data.incomplete_details) ||
        (data.incomplete_details.reason !== undefined &&
          (typeof data.incomplete_details.reason !== 'string' ||
            data.incomplete_details.reason.length === 0))))
  ) {
    throw invalidOpenAIResponse('OpenAI response contained invalid incomplete details');
  }
  if (data.usage === null && data.status === 'incomplete') {
    // OpenAI may terminate an incomplete response before token accounting exists.
  } else {
    validateUsage(data.usage);
  }
  const continuation = openAIState(data.id);
  const content: InferenceContent[] = [];
  let refused = false;
  for (const item of data.output) {
    if (!isJsonObject(item) || typeof item.type !== 'string') {
      throw invalidOpenAIResponse('OpenAI output contained an invalid item');
    }
    if (item.type === 'reasoning') {
      validateReasoningItem(item);
      continue;
    }
    if (item.type === 'message') {
      if (
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        item.role !== 'assistant' ||
        (item.status !== 'completed' && item.status !== 'incomplete') ||
        !Array.isArray(item.content)
      ) {
        throw invalidOpenAIResponse('OpenAI output message was incomplete');
      }
      for (const part of item.content) {
        if (!isJsonObject(part)) {
          throw invalidOpenAIResponse('OpenAI output message contained an invalid part');
        }
        if (part.type === 'output_text') {
          if (
            typeof part.text !== 'string' ||
            (part.annotations !== undefined &&
              (!Array.isArray(part.annotations) || !part.annotations.every(isJsonObject)))
          ) {
            throw invalidOpenAIResponse('OpenAI output_text part was invalid');
          }
          content.push({
            type: 'text',
            text: part.text,
            ...(Array.isArray(part.annotations) && part.annotations.length > 0
              ? { citations: part.annotations.map((annotation) => ({ ...annotation })) }
              : {}),
            cache: 'none',
          });
        } else if (part.type === 'refusal') {
          if (typeof part.refusal !== 'string') {
            throw invalidOpenAIResponse('OpenAI refusal part was invalid');
          }
          refused = true;
          content.push({ type: 'text', text: part.refusal, cache: 'none' });
        } else {
          throw invalidOpenAIResponse(`OpenAI message contained unknown ${String(part.type)} part`);
        }
      }
      continue;
    }
    if (item.type === 'function_call') {
      if (data.status !== 'completed') {
        throw invalidOpenAIResponse('OpenAI incomplete response contained a function call');
      }
      const call = parseFunctionCall(item, continuation);
      content.push(call);
      continue;
    }
    throw invalidOpenAIResponse(`OpenAI output contained unsupported ${item.type} item`);
  }
  const toolCalls = content.filter((item): item is InferenceToolCall => item.type === 'tool-call');
  const providerReason =
    data.status === 'incomplete' ? (data.incomplete_details?.reason ?? 'incomplete') : null;
  return {
    content,
    toolCalls,
    usage: normalizeUsage(data.usage === null ? null : data.usage),
    stopReason:
      toolCalls.length > 0
        ? 'tool-call'
        : refused
          ? 'content-filter'
          : normalizeStopReason(providerReason),
    providerStopReason:
      toolCalls.length > 0 ? 'function_call' : refused ? 'refusal' : providerReason,
    providerState: continuation,
  };
}

function parseFunctionCall(
  item: Readonly<Record<string, unknown>>,
  continuation: ProviderContinuationState,
): InferenceToolCall {
  if (
    typeof item.call_id !== 'string' ||
    item.call_id.length === 0 ||
    typeof item.name !== 'string' ||
    item.name.length === 0 ||
    typeof item.arguments !== 'string' ||
    (item.id !== undefined && (typeof item.id !== 'string' || item.id.length === 0)) ||
    (item.status !== undefined && item.status !== 'completed')
  ) {
    throw invalidOpenAIResponse('OpenAI function call was incomplete');
  }
  let input: unknown;
  try {
    input = JSON.parse(item.arguments) as unknown;
  } catch (error) {
    throw invalidOpenAIResponse('OpenAI function arguments were invalid JSON', error);
  }
  if (!isJsonObject(input)) {
    throw invalidOpenAIResponse('OpenAI function arguments were not an object');
  }
  return {
    type: 'tool-call',
    id: item.call_id,
    name: item.name,
    input,
    cache: 'none',
    providerState: continuation,
  };
}

function validateReasoningItem(item: Readonly<Record<string, unknown>>): void {
  if (
    typeof item.id !== 'string' ||
    item.id.length === 0 ||
    !Array.isArray(item.summary) ||
    !item.summary.every(
      (part) => isJsonObject(part) && part.type === 'summary_text' && typeof part.text === 'string',
    ) ||
    (item.content !== undefined &&
      (!Array.isArray(item.content) ||
        !item.content.every(
          (part) =>
            isJsonObject(part) && part.type === 'reasoning_text' && typeof part.text === 'string',
        )))
  ) {
    throw invalidOpenAIResponse('OpenAI reasoning item was invalid');
  }
}

function validateUsage(value: unknown): asserts value is OpenAIUsage {
  if (!isJsonObject(value)) throw invalidOpenAIResponse('OpenAI usage was not an object');
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    if (!isNonNegativeInteger(value[key])) {
      throw invalidOpenAIResponse('OpenAI usage contained an invalid token count');
    }
  }
  if (value.input_tokens_details !== undefined && value.input_tokens_details !== null) {
    if (
      !isJsonObject(value.input_tokens_details) ||
      (value.input_tokens_details.cached_tokens !== undefined &&
        !isNonNegativeInteger(value.input_tokens_details.cached_tokens)) ||
      (value.input_tokens_details.cache_write_tokens !== undefined &&
        !isNonNegativeInteger(value.input_tokens_details.cache_write_tokens))
    ) {
      throw invalidOpenAIResponse('OpenAI cached-token usage was invalid');
    }
  }
  if (value.output_tokens_details !== undefined && value.output_tokens_details !== null) {
    if (
      !isJsonObject(value.output_tokens_details) ||
      (value.output_tokens_details.reasoning_tokens !== undefined &&
        !isNonNegativeInteger(value.output_tokens_details.reasoning_tokens))
    ) {
      throw invalidOpenAIResponse('OpenAI reasoning-token usage was invalid');
    }
  }
}

function normalizeUsage(usage: OpenAIUsage | null): InferenceUsage {
  if (usage === null) {
    return {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      reasoningTokens: null,
    };
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
    providerDetails: { ...usage },
  };
}

function normalizeStopReason(reason: string | null): InferenceStopReason {
  if (reason === null) return 'completed';
  if (reason === 'max_tokens') return 'max-output-tokens';
  if (reason === 'max_output_tokens') return 'max-output-tokens';
  if (reason === 'content_filter') return 'content-filter';
  if (reason === 'max_tool_calls') return 'max-iterations';
  return 'unknown';
}

function continuationResponseId(state?: ProviderContinuationState): string | null {
  if (!state) return null;
  if (state.backend !== 'openai' || !isJsonObject(state.value)) {
    throw new Error(`OpenAI cannot continue ${state.backend} provider state`);
  }
  const id = state.value.previousResponseId;
  if (typeof id !== 'string' || id.length === 0) {
    throw invalidOpenAIResponse('OpenAI continuation state omitted previousResponseId');
  }
  return id;
}

function openAIState(previousResponseId: string): ProviderContinuationState {
  return { backend: 'openai', value: { previousResponseId } };
}

function validCreatedResponse(
  value: unknown,
): value is { id: string; status: 'queued' | 'in_progress' } {
  return (
    isJsonObject(value) &&
    value.object === 'response' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.model === 'string' &&
    value.model.length > 0 &&
    isNonNegativeInteger(value.created_at) &&
    Array.isArray(value.output) &&
    value.output.length === 0 &&
    value.error === null &&
    value.incomplete_details === null &&
    value.usage === null &&
    (value.status === 'in_progress' || value.status === 'queued')
  );
}

const PROGRESS_EVENTS = new Set([
  'response.queued',
  'response.in_progress',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.done',
  'response.refusal.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.output_text.annotation.added',
]);

function isProgressEvent(type: string): boolean {
  return PROGRESS_EVENTS.has(type);
}

function validateProgressEvent(
  event: OpenAIStreamEvent,
  responseId: string,
  lifecycle: OpenAIStreamLifecycle,
): void {
  switch (event.type) {
    case 'response.queued':
      validateProgressResponse(event.response, responseId, 'queued');
      lifecycle.responsePhase('queued');
      return;
    case 'response.in_progress':
      validateProgressResponse(event.response, responseId, 'in_progress');
      lifecycle.responsePhase('in_progress');
      return;
    case 'response.output_item.added':
      requireIndex(event, 'output_index');
      validateProgressOutputItem(event.item, 'added');
      lifecycle.itemAdded(event);
      return;
    case 'response.output_item.done':
      requireIndex(event, 'output_index');
      validateProgressOutputItem(event.item, 'done');
      lifecycle.itemDone(event);
      return;
    case 'response.content_part.added':
      requireItemCoordinates(event, true);
      validateProgressContentPart(event.part);
      lifecycle.contentAdded(event);
      return;
    case 'response.content_part.done':
      requireItemCoordinates(event, true);
      validateProgressContentPart(event.part);
      lifecycle.contentDone(event);
      return;
    case 'response.output_text.done':
      validateIndexedTextEvent(event, 'text');
      lifecycle.textDone(event, 'output_text');
      return;
    case 'response.refusal.done':
      validateIndexedTextEvent(event, 'refusal');
      lifecycle.textDone(event, 'refusal');
      return;
    case 'response.function_call_arguments.delta':
      requireItemCoordinates(event, false);
      if (typeof event.delta !== 'string') {
        throw invalidOpenAIResponse('OpenAI function argument delta was invalid');
      }
      lifecycle.functionArguments(event, false);
      return;
    case 'response.function_call_arguments.done':
      requireItemCoordinates(event, false);
      if (typeof event.arguments !== 'string' || typeof event.name !== 'string') {
        throw invalidOpenAIResponse('OpenAI function argument terminal event was invalid');
      }
      lifecycle.functionArguments(event, true);
      return;
    case 'response.reasoning_summary_part.added':
      requireItemCoordinates(event, false);
      requireIndex(event, 'summary_index');
      if (
        !isJsonObject(event.part) ||
        event.part.type !== 'summary_text' ||
        typeof event.part.text !== 'string'
      ) {
        throw invalidOpenAIResponse('OpenAI reasoning summary part event was invalid');
      }
      lifecycle.summaryPart(event, false);
      return;
    case 'response.reasoning_summary_part.done':
      requireItemCoordinates(event, false);
      requireIndex(event, 'summary_index');
      if (
        !isJsonObject(event.part) ||
        event.part.type !== 'summary_text' ||
        typeof event.part.text !== 'string'
      ) {
        throw invalidOpenAIResponse('OpenAI reasoning summary part event was invalid');
      }
      lifecycle.summaryPart(event, true);
      return;
    case 'response.reasoning_summary_text.delta':
      requireItemCoordinates(event, false);
      requireIndex(event, 'summary_index');
      if (typeof event.delta !== 'string') {
        throw invalidOpenAIResponse('OpenAI reasoning summary delta was invalid');
      }
      lifecycle.summaryText(event, false);
      return;
    case 'response.reasoning_summary_text.done':
      requireItemCoordinates(event, false);
      requireIndex(event, 'summary_index');
      if (typeof event.text !== 'string') {
        throw invalidOpenAIResponse('OpenAI reasoning summary terminal event was invalid');
      }
      lifecycle.summaryText(event, true);
      return;
    case 'response.reasoning_text.delta':
      requireItemCoordinates(event, true);
      if (typeof event.delta !== 'string') {
        throw invalidOpenAIResponse('OpenAI reasoning text delta was invalid');
      }
      lifecycle.textDelta(event, 'reasoning_text');
      return;
    case 'response.reasoning_text.done':
      requireItemCoordinates(event, true);
      if (typeof event.text !== 'string') {
        throw invalidOpenAIResponse('OpenAI reasoning text terminal event was invalid');
      }
      lifecycle.textDone(event, 'reasoning_text');
      return;
    case 'response.output_text.annotation.added':
      requireItemCoordinates(event, true);
      requireIndex(event, 'annotation_index');
      if (!isJsonObject(event.annotation)) {
        throw invalidOpenAIResponse('OpenAI output annotation event was invalid');
      }
      lifecycle.annotation(event);
      return;
    default:
      throw invalidOpenAIResponse(`OpenAI stream contained unknown ${String(event.type)} event`);
  }
}

function validateProgressResponse(
  value: unknown,
  responseId: string,
  status: 'queued' | 'in_progress',
): void {
  if (
    !isJsonObject(value) ||
    value.object !== 'response' ||
    value.id !== responseId ||
    value.status !== status ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    !isNonNegativeInteger(value.created_at) ||
    !Array.isArray(value.output) ||
    value.error !== null ||
    value.incomplete_details !== null ||
    value.usage !== null
  ) {
    throw invalidOpenAIResponse(`OpenAI response.${status} envelope was invalid`);
  }
}

function validateProgressOutputItem(value: unknown, phase: 'added' | 'done'): void {
  if (!isJsonObject(value) || typeof value.type !== 'string') {
    throw invalidOpenAIResponse('OpenAI output item event was invalid');
  }
  if (value.type === 'message') {
    if (
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      value.role !== 'assistant' ||
      (phase === 'added'
        ? value.status !== 'in_progress'
        : value.status !== 'completed' && value.status !== 'incomplete') ||
      !Array.isArray(value.content)
    ) {
      throw invalidOpenAIResponse('OpenAI output message event was invalid');
    }
    value.content.forEach(validateProgressContentPart);
    return;
  }
  if (value.type === 'function_call') {
    if (
      (value.status !== undefined &&
        (phase === 'added'
          ? value.status !== 'in_progress'
          : value.status !== 'completed' && value.status !== 'incomplete')) ||
      (value.id !== undefined && (typeof value.id !== 'string' || value.id.length === 0)) ||
      typeof value.call_id !== 'string' ||
      value.call_id.length === 0 ||
      typeof value.name !== 'string' ||
      value.name.length === 0 ||
      typeof value.arguments !== 'string'
    ) {
      throw invalidOpenAIResponse('OpenAI function-call item event was invalid');
    }
    return;
  }
  if (value.type === 'reasoning') {
    if (
      value.status !== undefined &&
      (phase === 'added'
        ? value.status !== 'in_progress'
        : value.status !== 'completed' && value.status !== 'incomplete')
    ) {
      throw invalidOpenAIResponse('OpenAI reasoning item event had an invalid status');
    }
    validateReasoningItem(value);
    return;
  }
  throw invalidOpenAIResponse(`OpenAI output item event contained unsupported ${value.type}`);
}

function validateProgressContentPart(value: unknown): void {
  if (!isJsonObject(value)) {
    throw invalidOpenAIResponse('OpenAI content part event was invalid');
  }
  if (value.type === 'output_text') {
    if (
      typeof value.text !== 'string' ||
      !Array.isArray(value.annotations) ||
      !value.annotations.every(isJsonObject)
    ) {
      throw invalidOpenAIResponse('OpenAI output-text part event was invalid');
    }
    return;
  }
  if (value.type === 'refusal') {
    if (typeof value.refusal !== 'string') {
      throw invalidOpenAIResponse('OpenAI refusal part event was invalid');
    }
    return;
  }
  if (value.type === 'reasoning_text') {
    if (typeof value.text !== 'string') {
      throw invalidOpenAIResponse('OpenAI reasoning-text part event was invalid');
    }
    return;
  }
  throw invalidOpenAIResponse(
    `OpenAI content part event contained unsupported ${String(value.type)}`,
  );
}

interface OpenAIStreamItemState {
  readonly index: number;
  readonly id: string | null;
  readonly type: string;
  done: boolean;
  functionArgumentsDone: boolean;
  functionCall?: { readonly callId: string; readonly name: string; arguments: string };
  finalizedSignature?: string;
}

interface OpenAIStreamPartState {
  readonly item: OpenAIStreamItemState;
  readonly index: number;
  readonly type: string;
  done: boolean;
  textDone: boolean;
  text: string;
  annotations: readonly Readonly<Record<string, unknown>>[];
  finalizedSignature?: string;
}

interface OpenAIStreamSummaryState {
  readonly item: OpenAIStreamItemState;
  readonly index: number;
  done: boolean;
  textDone: boolean;
  text: string;
  finalizedSignature?: string;
}

/** Correlate otherwise-valid SSE envelopes into one legal Responses lifecycle. */
class OpenAIStreamLifecycle {
  private phase: 'queued' | 'in_progress' | null = null;
  private readonly seenPhases = new Set<string>();
  private readonly itemsByIndex = new Map<number, OpenAIStreamItemState>();
  private readonly itemsById = new Map<string, OpenAIStreamItemState>();
  private readonly parts = new Map<string, OpenAIStreamPartState>();
  private readonly summaries = new Map<string, OpenAIStreamSummaryState>();

  start(status: 'queued' | 'in_progress'): void {
    this.phase = status;
  }

  responsePhase(status: 'queued' | 'in_progress'): void {
    if (
      this.phase === null ||
      (status === 'queued' && this.phase !== 'queued') ||
      this.seenPhases.has(status)
    ) {
      throw invalidOpenAIResponse('OpenAI response progress phase regressed or repeated');
    }
    this.phase = status;
    this.seenPhases.add(status);
  }

  itemAdded(event: OpenAIStreamEvent): void {
    const index = event.output_index as number;
    const item = event.item as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : null;
    if (this.itemsByIndex.has(index) || (id !== null && this.itemsById.has(id))) {
      throw invalidOpenAIResponse('OpenAI stream added an output item more than once');
    }
    const state: OpenAIStreamItemState = {
      index,
      id,
      type: item.type as string,
      done: false,
      functionArgumentsDone: false,
      ...(item.type === 'function_call'
        ? {
            functionCall: {
              callId: item.call_id as string,
              name: item.name as string,
              arguments: item.arguments as string,
            },
          }
        : {}),
    };
    this.itemsByIndex.set(index, state);
    if (id !== null) this.itemsById.set(id, state);
  }

  itemDone(event: OpenAIStreamEvent): void {
    const item = event.item as Record<string, unknown>;
    const state = this.itemsByIndex.get(event.output_index as number);
    const id = typeof item.id === 'string' ? item.id : null;
    if (
      !state ||
      state.done ||
      state.type !== item.type ||
      (state.id !== null && state.id !== id) ||
      (state.type === 'function_call' && !state.functionArgumentsDone) ||
      [...this.parts.values()].some((part) => part.item === state && !part.done) ||
      [...this.summaries.values()].some((part) => part.item === state && !part.done)
    ) {
      throw invalidOpenAIResponse('OpenAI stream completed an invalid output item lifecycle');
    }
    const signature = this.itemSignature(item, state);
    if (signature === null) {
      throw invalidOpenAIResponse('OpenAI output-item result changed its streamed content');
    }
    state.finalizedSignature = signature;
    state.done = true;
  }

  contentAdded(event: OpenAIStreamEvent): void {
    const item = this.openItem(event);
    const index = event.content_index as number;
    const key = this.partKey(item, index);
    if (this.parts.has(key)) {
      throw invalidOpenAIResponse('OpenAI stream added a content part more than once');
    }
    const part = event.part as Record<string, unknown>;
    if (
      (item.type === 'message' && part.type === 'reasoning_text') ||
      (item.type === 'reasoning' && part.type !== 'reasoning_text') ||
      (item.type !== 'message' && item.type !== 'reasoning')
    ) {
      throw invalidOpenAIResponse('OpenAI content part did not belong to its output item');
    }
    this.parts.set(key, {
      item,
      index,
      type: part.type as string,
      done: false,
      textDone: false,
      text:
        part.type === 'refusal'
          ? (part.refusal as string)
          : part.type === 'output_text' || part.type === 'reasoning_text'
            ? (part.text as string)
            : '',
      annotations:
        part.type === 'output_text'
          ? (part.annotations as readonly Readonly<Record<string, unknown>>[])
          : [],
    });
  }

  contentDone(event: OpenAIStreamEvent): void {
    const state = this.openPart(event);
    const part = event.part as Record<string, unknown>;
    const signature = contentPartSignature(part);
    if (
      state.done ||
      state.type !== part.type ||
      !state.textDone ||
      signature !== this.partSignature(state)
    ) {
      throw invalidOpenAIResponse('OpenAI stream completed an invalid content-part lifecycle');
    }
    state.finalizedSignature = signature;
    state.done = true;
  }

  textDelta(event: OpenAIStreamEvent, type: string): void {
    const state = this.openPart(event);
    if (state.type !== type || state.textDone) {
      throw invalidOpenAIResponse('OpenAI stream emitted text outside an open content part');
    }
    state.text += event.delta as string;
  }

  textDone(event: OpenAIStreamEvent, type: string): void {
    const state = this.openPart(event);
    const text = type === 'refusal' ? event.refusal : event.text;
    if (state.type !== type || state.textDone || state.text !== text) {
      throw invalidOpenAIResponse('OpenAI stream completed text outside an open content part');
    }
    state.textDone = true;
  }

  annotation(event: OpenAIStreamEvent): void {
    const state = this.openPart(event);
    if (
      state.type !== 'output_text' ||
      state.textDone ||
      event.annotation_index !== state.annotations.length
    ) {
      throw invalidOpenAIResponse('OpenAI stream emitted an annotation outside output text');
    }
    state.annotations = [
      ...state.annotations,
      event.annotation as Readonly<Record<string, unknown>>,
    ];
  }

  functionArguments(event: OpenAIStreamEvent, done: boolean): void {
    const state = this.openItem(event);
    const call = state.functionCall;
    if (state.type !== 'function_call' || !call || state.functionArgumentsDone) {
      throw invalidOpenAIResponse('OpenAI stream emitted function arguments outside an open call');
    }
    if (done) {
      if (event.name !== call.name || event.arguments !== call.arguments) {
        throw invalidOpenAIResponse('OpenAI function arguments changed at completion');
      }
      state.functionArgumentsDone = true;
    } else {
      call.arguments += event.delta as string;
    }
  }

  summaryPart(event: OpenAIStreamEvent, done: boolean): void {
    const item = this.openItem(event);
    if (item.type !== 'reasoning') {
      throw invalidOpenAIResponse('OpenAI stream emitted a summary outside reasoning');
    }
    const index = event.summary_index as number;
    const key = this.summaryKey(item, index);
    const existing = this.summaries.get(key);
    if (!done) {
      if (existing)
        throw invalidOpenAIResponse('OpenAI stream added a summary part more than once');
      const part = event.part as Record<string, unknown>;
      this.summaries.set(key, {
        item,
        index,
        done: false,
        textDone: false,
        text: part.text as string,
      });
      return;
    }
    const part = event.part as Record<string, unknown>;
    const signature = summaryPartSignature(part);
    if (
      !existing ||
      existing.done ||
      !existing.textDone ||
      signature !== canonicalJson({ type: 'summary_text', text: existing.text })
    ) {
      throw invalidOpenAIResponse('OpenAI stream completed an invalid summary lifecycle');
    }
    existing.finalizedSignature = signature;
    existing.done = true;
  }

  summaryText(event: OpenAIStreamEvent, done: boolean): void {
    const item = this.openItem(event);
    const state = this.summaries.get(this.summaryKey(item, event.summary_index as number));
    if (!state || state.done || state.textDone) {
      throw invalidOpenAIResponse('OpenAI stream emitted text outside an open summary');
    }
    if (done) {
      if (event.text !== state.text) {
        throw invalidOpenAIResponse('OpenAI reasoning summary changed at completion');
      }
      state.textDone = true;
    } else {
      state.text += event.delta as string;
    }
  }

  terminal(value: unknown): void {
    if (!isJsonObject(value) || !Array.isArray(value.output)) {
      throw invalidOpenAIResponse('OpenAI terminal response omitted its output');
    }
    if ([...this.itemsByIndex.values()].some((item) => !item.done)) {
      throw invalidOpenAIResponse('OpenAI terminal response preceded output-item completion');
    }
    if (this.itemsByIndex.size === 0) {
      if (value.output.length > 0) {
        throw invalidOpenAIResponse('OpenAI terminal output skipped its item lifecycle');
      }
      return;
    }
    if (value.output.length !== this.itemsByIndex.size) {
      throw invalidOpenAIResponse('OpenAI terminal output did not match streamed items');
    }
    for (const [index, item] of this.itemsByIndex) {
      const terminal = value.output[index];
      if (
        !isJsonObject(terminal) ||
        terminal.type !== item.type ||
        (item.id !== null && terminal.id !== item.id) ||
        item.finalizedSignature === undefined ||
        this.itemSignature(terminal, item) !== item.finalizedSignature
      ) {
        throw invalidOpenAIResponse('OpenAI terminal output changed a streamed item');
      }
    }
  }

  private openItem(event: OpenAIStreamEvent): OpenAIStreamItemState {
    const index = event.output_index as number;
    const id = event.item_id as string;
    const state = this.itemsByIndex.get(index);
    if (!state || state.done || state.id !== id || this.itemsById.get(id) !== state) {
      throw invalidOpenAIResponse('OpenAI stream referenced an unknown or completed output item');
    }
    return state;
  }

  private openPart(event: OpenAIStreamEvent): OpenAIStreamPartState {
    const item = this.openItem(event);
    const state = this.parts.get(this.partKey(item, event.content_index as number));
    if (!state || state.done) {
      throw invalidOpenAIResponse('OpenAI stream referenced an unknown or completed content part');
    }
    return state;
  }

  private partKey(item: OpenAIStreamItemState, index: number): string {
    return `${item.index}:${index}`;
  }

  private summaryKey(item: OpenAIStreamItemState, index: number): string {
    return `${item.index}:${index}`;
  }

  private partSignature(state: OpenAIStreamPartState): string {
    return canonicalJson(
      state.type === 'refusal'
        ? { type: state.type, refusal: state.text }
        : state.type === 'output_text'
          ? { type: state.type, text: state.text, annotations: state.annotations }
          : { type: state.type, text: state.text },
    );
  }

  private itemSignature(
    value: Readonly<Record<string, unknown>>,
    state: OpenAIStreamItemState,
  ): string | null {
    if (state.type === 'message') {
      const valueContent = value.content;
      if (!Array.isArray(valueContent)) return null;
      const streamed = [...this.parts.values()]
        .filter((part) => part.item === state)
        .sort((left, right) => left.index - right.index);
      if (
        streamed.length !== valueContent.length ||
        streamed.some(
          (part, index) =>
            part.index !== index ||
            part.finalizedSignature === undefined ||
            contentPartSignature(valueContent[index]) !== part.finalizedSignature,
        )
      ) {
        return null;
      }
      return canonicalJson({
        type: 'message',
        id: value.id,
        role: value.role,
        status: value.status,
        content: valueContent,
      });
    }
    if (state.type === 'function_call') {
      const call = state.functionCall;
      if (
        !call ||
        value.call_id !== call.callId ||
        value.name !== call.name ||
        value.arguments !== call.arguments
      ) {
        return null;
      }
      return canonicalJson({
        type: 'function_call',
        id: value.id,
        call_id: value.call_id,
        name: value.name,
        arguments: value.arguments,
        status: value.status,
      });
    }
    if (state.type === 'reasoning') {
      const valueSummary = value.summary;
      const valueContent = value.content;
      const summaries = [...this.summaries.values()]
        .filter((part) => part.item === state)
        .sort((left, right) => left.index - right.index);
      const content = [...this.parts.values()]
        .filter((part) => part.item === state)
        .sort((left, right) => left.index - right.index);
      if (
        !Array.isArray(valueSummary) ||
        summaries.length !== valueSummary.length ||
        summaries.some(
          (part, index) =>
            part.index !== index ||
            part.finalizedSignature === undefined ||
            summaryPartSignature(valueSummary[index]) !== part.finalizedSignature,
        ) ||
        (valueContent === undefined && content.length > 0) ||
        (valueContent !== undefined &&
          (!Array.isArray(valueContent) ||
            content.length !== valueContent.length ||
            content.some(
              (part, index) =>
                part.index !== index ||
                part.finalizedSignature === undefined ||
                contentPartSignature(valueContent[index]) !== part.finalizedSignature,
            )))
      ) {
        return null;
      }
      return canonicalJson({
        type: 'reasoning',
        id: value.id,
        status: value.status,
        summary: valueSummary,
        content: valueContent ?? [],
      });
    }
    return null;
  }
}

function contentPartSignature(value: unknown): string | null {
  if (!isJsonObject(value)) return null;
  if (value.type === 'output_text') {
    return canonicalJson({ type: value.type, text: value.text, annotations: value.annotations });
  }
  if (value.type === 'refusal') {
    return canonicalJson({ type: value.type, refusal: value.refusal });
  }
  if (value.type === 'reasoning_text') {
    return canonicalJson({ type: value.type, text: value.text });
  }
  return null;
}

function summaryPartSignature(value: unknown): string | null {
  return isJsonObject(value) && value.type === 'summary_text'
    ? canonicalJson({ type: value.type, text: value.text })
    : null;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function validateIndexedTextEvent(
  event: OpenAIStreamEvent,
  member: 'delta' | 'text' | 'refusal',
): void {
  requireItemCoordinates(event, true);
  if (typeof event[member] !== 'string') {
    throw invalidOpenAIResponse(`OpenAI ${member} event omitted text`);
  }
}

function requireItemCoordinates(event: OpenAIStreamEvent, content: boolean): void {
  if (typeof event.item_id !== 'string' || event.item_id.length === 0) {
    throw invalidOpenAIResponse('OpenAI stream event omitted its item ID');
  }
  requireIndex(event, 'output_index');
  if (content) requireIndex(event, 'content_index');
}

function requireIndex(event: OpenAIStreamEvent, member: string): void {
  if (!isNonNegativeInteger(event[member])) {
    throw invalidOpenAIResponse(`OpenAI stream event contained an invalid ${member}`);
  }
}

function validateRequestRoute(request: InferenceRequest): void {
  if (
    request.modelProfile.provider !== 'openai' ||
    request.modelProfile.apiFamily !== 'openai-responses'
  ) {
    throw new Error('OpenAI adapter received an incompatible model profile');
  }
  validateFilePolicy(request.filePolicy);
}

function validateFilePolicy(policy: FilePolicy): void {
  if (
    policy.provider !== 'openai' ||
    !policy.compatibleApiFamilies.includes('openai-responses') ||
    policy.inputMode !== 'provider-file' ||
    policy.lifecycle !== 'provider-managed' ||
    policy.purpose !== 'user_data'
  ) {
    throw new Error(`OpenAI adapter cannot use file policy ${policy.name}`);
  }
}

function validateOpenAIFileRecord(
  value: unknown,
  expectedId?: string,
  expectedPurpose?: string,
): asserts value is {
  id: string;
  object: 'file';
  bytes: number;
  filename: string;
  purpose: string;
  created_at: number;
  expires_at?: number;
} {
  if (
    !isJsonObject(value) ||
    value.object !== 'file' ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    (expectedId !== undefined && value.id !== expectedId) ||
    !isNonNegativeInteger(value.bytes) ||
    typeof value.filename !== 'string' ||
    value.filename.length === 0 ||
    typeof value.purpose !== 'string' ||
    (expectedPurpose !== undefined && value.purpose !== expectedPurpose) ||
    !isEpochSeconds(value.created_at) ||
    (value.expires_at !== undefined && !isEpochSeconds(value.expires_at))
  ) {
    throw invalidOpenAIResponse('OpenAI file response was invalid');
  }
}

function expiryFrom(value?: number): string | null {
  return value === undefined ? null : new Date(value * 1000).toISOString();
}

function filenameFor(mediaType: string): string {
  const extension =
    mediaType
      .split('/')[1]
      ?.split('+')[0]
      ?.replace(/[^a-z0-9]/gi, '') || 'bin';
  return `document.${extension}`;
}

function responseFailure(value: unknown, expectedId?: string): InferenceFailure {
  if (
    !isJsonObject(value) ||
    value.object !== 'response' ||
    value.status !== 'failed' ||
    typeof value.id !== 'string' ||
    !isJsonObject(value.error)
  ) {
    return invalidOpenAIResponse('OpenAI failed with a malformed response');
  }
  if (expectedId !== undefined && value.id !== expectedId) {
    return invalidOpenAIResponse('OpenAI failed response ID did not match response.created');
  }
  return openAIFailure(null, value, 'OpenAI response failed');
}

function cancelledResponseFailure(value: unknown, expectedId?: string): InferenceFailure {
  if (
    !isJsonObject(value) ||
    value.object !== 'response' ||
    value.status !== 'cancelled' ||
    typeof value.id !== 'string' ||
    (expectedId !== undefined && value.id !== expectedId)
  ) {
    return invalidOpenAIResponse('OpenAI cancelled response was malformed');
  }
  return new InferenceFailure({
    backend: 'openai',
    status: null,
    code: 'cancelled',
    message: 'OpenAI response was cancelled',
    retryable: false,
    failureClass: 'cancelled',
  });
}

function openAIEventFailure(event: OpenAIStreamEvent): InferenceFailure {
  return openAIFailure(null, event, 'OpenAI stream failed');
}

function openAIFailure(
  status: number | null,
  value?: unknown,
  fallback?: string,
): InferenceFailure {
  const root = isJsonObject(value) ? value : undefined;
  const nested = root && isJsonObject(root.error) ? root.error : root;
  const code =
    typeof nested?.code === 'string'
      ? nested.code
      : typeof nested?.type === 'string'
        ? nested.type
        : 'openai_error';
  const message =
    typeof nested?.message === 'string'
      ? nested.message
      : (fallback ?? `OpenAI request failed${status === null ? '' : ` (${status})`}`);
  const permanent429 = new Set([
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ]).has(code);
  const transientCode = new Set([
    'server_error',
    'rate_limit_error',
    'rate_limit_exceeded',
    'timeout',
  ]).has(code);
  return new InferenceFailure({
    backend: 'openai',
    status,
    code,
    message,
    ...(value !== undefined ? { detail: safeJson(value) } : {}),
    retryable:
      !permanent429 &&
      (transientCode ||
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status !== null && status >= 500)),
    failureClass: 'http',
  });
}

async function callOpenAI(
  operation: () => Promise<Response>,
  abortSignal?: AbortSignal,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    throw openAITransportFailure(error, abortSignal);
  }
}

function openAITransportFailure(error: unknown, abortSignal?: AbortSignal): InferenceFailure {
  if (error instanceof InferenceFailure) return error;
  const name = error instanceof Error ? error.name : '';
  const timedOut = name === 'TimeoutError';
  const cancelled = !timedOut && (abortSignal?.aborted === true || name === 'AbortError');
  return new InferenceFailure({
    backend: 'openai',
    status: null,
    code: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network_error',
    message: cancelled
      ? 'OpenAI request was cancelled'
      : timedOut
        ? 'OpenAI request timed out'
        : error instanceof Error
          ? error.message
          : 'OpenAI network request failed',
    retryable: !cancelled,
    failureClass: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network',
  });
}

async function readOpenAIJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new InferenceFailure({
      backend: 'openai',
      status: response.status,
      code: 'invalid_response',
      message: 'OpenAI returned an invalid JSON response',
      detail: error instanceof Error ? error.message : String(error),
      retryable: response.status >= 500,
      failureClass: 'invalid-response',
    });
  }
}

function invalidOpenAIResponse(message: string, cause?: unknown): InferenceFailure {
  return new InferenceFailure({
    backend: 'openai',
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEpochSeconds(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 8_640_000_000;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
