/** Anthropic Messages adapter: the only canonical↔Anthropic translation boundary. */

import * as anthropic from './anthropic-wire';
import type {
  ContentBlock,
  MessageParam,
  MessagesPayload,
  TextBlock,
  Usage,
} from './anthropic-wire';
import type {
  CacheIntent,
  FilePolicy,
  InferenceContent,
  InferenceEvent,
  InferenceRequest,
  InferenceResult,
  InferenceStopReason,
  InferenceToolCall,
  InferenceUsage,
  ProviderContinuationState,
} from '../../lib/inference-types';
import type { Env } from '../../config';
import { silentLogger, type Logger } from '../../lib/logger';
import { manageCacheControl } from './anthropic-cache';
import {
  InferenceFailure,
  type InferenceProviderAdapter,
  type ProviderFileMetadata,
  type ProviderUploadRequest,
  type ProviderUploadResult,
} from '../adapter';

interface AnthropicResponseBody {
  id?: string;
  type?: string;
  role?: string;
  model?: string;
  content?: unknown;
  stop_reason?: string | null;
  stop_sequence?: string | null;
  usage?: unknown;
  error?: { type?: string; message?: string };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: Record<string, unknown> & { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
    thinking?: string;
    signature?: string;
    citation?: Record<string, unknown>;
  };
  usage?: unknown;
  message?: { usage?: unknown; [member: string]: unknown };
  error?: { type?: string; message?: string };
}

interface PendingBlock {
  type: string;
  text?: string;
  id?: string | undefined;
  name?: string | undefined;
  inputJson?: string;
  raw: Record<string, unknown>;
}

/** Anthropic adapter bound to one worker environment. */
export class AnthropicMessagesAdapter implements InferenceProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly apiFamily = 'anthropic-messages' as const;

  constructor(private readonly env: Env) {}

  /** Bounded passthrough for a request whose selector names no registered prompt. */
  async completePassthrough(
    payload: Record<string, unknown>,
    abortSignal?: AbortSignal,
    log: Logger = silentLogger,
  ): Promise<unknown> {
    const compatiblePayload = payload as anthropic.ClientMessagesPayload;
    manageCacheControl(compatiblePayload, 0, log);
    const response = await callAnthropic(
      () => anthropic.createMessage(compatiblePayload, this.env, abortSignal),
      abortSignal,
    );
    const data = await readAnthropicJson<AnthropicResponseBody>(response);
    if (!response.ok) throw anthropicFailure(response.status, data);
    return data;
  }

  /** Best-effort count for the bounded unregistered-selector passthrough. */
  async countPassthroughTokens(
    payload: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ): Promise<number | null> {
    const response = await callAnthropic(
      () =>
        anthropic.countTokens(payload as anthropic.ClientMessagesPayload, this.env, abortSignal),
      abortSignal,
    );
    if (!response.ok) return null;
    const data = await readAnthropicJson<{ input_tokens?: unknown }>(response);
    if (
      !isJsonObject(data) ||
      typeof data.input_tokens !== 'number' ||
      !Number.isSafeInteger(data.input_tokens) ||
      data.input_tokens < 0
    ) {
      throw invalidAnthropicResponse('Anthropic token-count response was invalid');
    }
    return data.input_tokens;
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    const response = await callAnthropic(
      () => anthropic.createMessage(toAnthropicPayload(request), this.env, request.abortSignal),
      request.abortSignal,
    );
    const data = await readAnthropicJson<AnthropicResponseBody>(response);
    if (!response.ok) throw anthropicFailure(response.status, data);
    return responseResult(data);
  }

  async *stream(request: InferenceRequest): AsyncIterable<InferenceEvent> {
    const response = await callAnthropic(
      () => anthropic.streamMessage(toAnthropicPayload(request), this.env, request.abortSignal),
      request.abortSignal,
    );
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw anthropicFailure(response.status, undefined, detail);
    }

    yield { type: 'message-start' };
    const blocks: PendingBlock[] = [];
    let stopReason: string | null = null;
    let usage: Usage | undefined;
    let sawMessageStart = false;
    let sawMessageDelta = false;
    let sawMessageStop = false;
    const openBlocks = new Set<number>();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw anthropicTransportFailure(error, request.abortSignal);
      }
      const { value, done } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        let parsedEvent: unknown;
        try {
          parsedEvent = JSON.parse(json) as unknown;
        } catch (error) {
          throw invalidAnthropicResponse('Anthropic stream contained invalid JSON', error);
        }
        if (!isJsonObject(parsedEvent)) {
          throw invalidAnthropicResponse('Anthropic stream event was not an object');
        }
        const event = parsedEvent as AnthropicStreamEvent;

        if (event.type === 'error') throw anthropicStreamFailure(event.error);
        if (event.type === 'ping') continue;
        if (sawMessageStop) {
          throw invalidAnthropicResponse('Anthropic stream emitted data after message_stop');
        }
        if (event.type === 'message_start') {
          if (sawMessageStart || !validMessageStart(event.message)) {
            throw invalidAnthropicResponse('Anthropic stream contained an invalid message_start');
          }
          sawMessageStart = true;
          validateUsage(event.message.usage, true);
          usage = event.message.usage;
        } else if (event.type === 'content_block_start') {
          if (
            !sawMessageStart ||
            sawMessageDelta ||
            !Number.isInteger(event.index) ||
            (event.index ?? -1) < 0 ||
            event.index !== blocks.length ||
            openBlocks.has(event.index ?? -1) ||
            typeof event.content_block?.type !== 'string'
          ) {
            throw invalidAnthropicResponse(
              'Anthropic stream contained an invalid content_block_start',
            );
          }
          const index = event.index as number;
          const contentBlock = event.content_block ?? {};
          openBlocks.add(index);
          blocks[index] = isAnthropicToolUseType(contentBlock.type ?? '')
            ? {
                type: contentBlock.type ?? 'unknown',
                id: contentBlock.id,
                name: contentBlock.name,
                inputJson: '',
                raw: { ...contentBlock },
              }
            : {
                type: contentBlock.type ?? 'unknown',
                text: '',
                raw: { ...contentBlock },
              };
        } else if (event.type === 'content_block_delta') {
          if (!Number.isInteger(event.index) || !openBlocks.has(event.index ?? -1)) {
            throw invalidAnthropicResponse(
              'Anthropic stream delta did not match an open content block',
            );
          }
          const block = blocks[event.index as number];
          if (!block || typeof event.delta?.type !== 'string') {
            throw invalidAnthropicResponse('Anthropic stream contained an invalid content delta');
          }
          if (event.delta?.type === 'text_delta') {
            if (block.type !== 'text' || typeof event.delta.text !== 'string') {
              throw invalidAnthropicResponse('Anthropic stream contained an invalid text delta');
            }
            const delta = event.delta.text;
            block.text = (block.text ?? '') + delta;
            block.raw.text = block.text;
            yield { type: 'text-delta', delta };
          } else if (event.delta?.type === 'input_json_delta') {
            if (
              !isAnthropicToolUseType(block.type) ||
              typeof event.delta.partial_json !== 'string'
            ) {
              throw invalidAnthropicResponse(
                'Anthropic stream contained an invalid tool-input delta',
              );
            }
            block.inputJson = (block.inputJson ?? '') + event.delta.partial_json;
          } else if (event.delta?.type === 'thinking_delta') {
            if (block.type !== 'thinking' || typeof event.delta.thinking !== 'string') {
              throw invalidAnthropicResponse(
                'Anthropic stream contained an invalid thinking delta',
              );
            }
            const thinking = event.delta.thinking;
            block.raw.thinking = `${typeof block.raw.thinking === 'string' ? block.raw.thinking : ''}${thinking}`;
          } else if (event.delta?.type === 'signature_delta') {
            if (block.type !== 'thinking' || typeof event.delta.signature !== 'string') {
              throw invalidAnthropicResponse(
                'Anthropic stream contained an invalid signature delta',
              );
            }
            block.raw.signature = event.delta.signature;
          } else if (event.delta?.type === 'citations_delta') {
            if (!isJsonObject(event.delta.citation) || block.type !== 'text') {
              throw invalidAnthropicResponse('Anthropic stream contained an invalid citation');
            }
            const citations = Array.isArray(block.raw.citations) ? block.raw.citations : [];
            block.raw.citations = [...citations, event.delta.citation];
          } else {
            throw invalidAnthropicResponse('Anthropic stream contained an unknown content delta');
          }
        } else if (event.type === 'content_block_stop') {
          if (!Number.isInteger(event.index) || !openBlocks.delete(event.index ?? -1)) {
            throw invalidAnthropicResponse(
              'Anthropic stream stop did not match an open content block',
            );
          }
        } else if (event.type === 'message_delta') {
          if (
            !sawMessageStart ||
            sawMessageDelta ||
            openBlocks.size > 0 ||
            typeof event.delta?.stop_reason !== 'string'
          ) {
            throw invalidAnthropicResponse('Anthropic stream contained an invalid message_delta');
          }
          sawMessageDelta = true;
          stopReason = event.delta.stop_reason;
          validateStreamDeltaUsage(event.usage);
          usage = { ...(usage ?? {}), ...event.usage };
          validateUsage(usage, true);
          yield { type: 'usage', usage: normalizeUsage(usage) };
        } else if (event.type === 'message_stop') {
          if (!sawMessageStart || !sawMessageDelta || openBlocks.size > 0) {
            throw invalidAnthropicResponse('Anthropic stream contained an invalid message_stop');
          }
          sawMessageStop = true;
        } else {
          throw invalidAnthropicResponse(
            `Anthropic stream contained unknown ${String(event.type)} event`,
          );
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      throw invalidAnthropicResponse('Anthropic stream ended with a truncated event');
    }
    if (!sawMessageStart || !sawMessageDelta || !sawMessageStop || stopReason === null) {
      throw invalidAnthropicResponse('Anthropic stream ended before the terminal message_stop');
    }
    validateUsage(usage, true);

    const content = blocks.flatMap(finalizePendingBlock);
    const toolCalls = content.filter(
      (item): item is InferenceToolCall => item.type === 'tool-call',
    );
    for (const call of toolCalls) yield { type: 'tool-call', call };
    const result: InferenceResult = {
      content,
      toolCalls,
      usage: normalizeUsage(usage),
      stopReason: normalizeStopReason(stopReason),
      providerStopReason: stopReason,
      providerState: anthropicState({
        contentBlocks: blocks.map((block) => block.raw),
        stopReason,
      }),
    };
    yield { type: 'complete', result };
  }

  async countTokens(request: InferenceRequest): Promise<number | null> {
    const response = await callAnthropic(
      () => anthropic.countTokens(toAnthropicPayload(request), this.env, request.abortSignal),
      request.abortSignal,
    );
    if (!response.ok) return null;
    const data = await readAnthropicJson<{ input_tokens?: unknown }>(response);
    return typeof data.input_tokens === 'number' ? data.input_tokens : null;
  }

  async getFileScope(policy: FilePolicy): Promise<string> {
    validateFilePolicy(policy);
    return anthropic.fileAccountScope(this.env);
  }

  async uploadFile(request: ProviderUploadRequest): Promise<ProviderUploadResult> {
    validateFilePolicy(request.policy);
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([request.bytes], { type: request.mediaType }),
      request.filename,
    );
    const response = await callAnthropic(
      () => anthropic.uploadFile(formData, this.env, request.abortSignal),
      request.abortSignal,
    );
    const data = await readAnthropicJson<{
      id?: string;
      mime_type?: string;
      size_bytes?: number;
    }>(response);
    if (!response.ok) throw anthropicUploadFailure(response.status, data);
    validateAnthropicFileRecord(data);
    return {
      id: data.id,
      mediaType: data.mime_type,
      sizeBytes: data.size_bytes,
      expiresAt: null,
    };
  }

  async getFileMetadata(
    id: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderFileMetadata | null> {
    const response = await callAnthropic(
      () => anthropic.getFileMetadata(id, this.env, abortSignal),
      abortSignal,
    );
    if (response.status === 404) return null;
    const data = await readAnthropicJson<{
      id?: string;
      mime_type?: string;
      size_bytes?: number;
    }>(response);
    if (!response.ok) throw anthropicFailure(response.status, data);
    validateAnthropicFileRecord(data, id);
    return {
      id: data.id,
      mediaType: data.mime_type,
      sizeBytes: data.size_bytes,
      expiresAt: null,
    };
  }

  async deleteFile(id: string, abortSignal?: AbortSignal): Promise<void> {
    const response = await callAnthropic(
      () => anthropic.deleteFile(id, this.env, abortSignal),
      abortSignal,
    );
    if (!response.ok && response.status !== 204) {
      const data = await response.json().catch(() => undefined);
      throw anthropicFailure(response.status, data);
    }
  }
}

function toAnthropicPayload(request: InferenceRequest): MessagesPayload {
  if (request.continuation && request.continuation.backend !== 'anthropic') {
    throw new Error(`Anthropic cannot continue ${request.continuation.backend} provider state`);
  }
  const system: TextBlock[] = [
    {
      type: 'text',
      text: request.prompt,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];
  const messages: MessageParam[] = [];
  let latestAssistantIndex = -1;
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === 'assistant') {
      latestAssistantIndex = index;
      break;
    }
  }
  if (request.continuation && latestAssistantIndex < 0) {
    throw new Error('Anthropic continuation requires a corresponding assistant message');
  }
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === 'system') {
      for (const content of message.content) {
        if (content.type !== 'text') throw new Error('Anthropic system content must be text');
        const control = cacheControl(content.cache);
        system.push({
          type: 'text',
          text: content.text,
          ...(control ? { cache_control: control } : {}),
        });
      }
      continue;
    }
    const providerState =
      message.role === 'assistant'
        ? messageIndex === latestAssistantIndex && request.continuation
          ? request.continuation
          : message.providerState
        : undefined;
    if (providerState) {
      const content = anthropicContinuationContent(providerState, message.content);
      messages.push({ role: message.role, content });
    } else {
      messages.push({ role: message.role, content: message.content.map(toAnthropicContent) });
    }
  }
  const payload: MessagesPayload = {
    model: request.modelProfile.model,
    max_tokens: request.maxOutputTokens,
    system,
    messages,
  };
  if (request.tools.length > 0) payload.tools = anthropic.serializeToolDefinitions(request.tools);
  if (request.toolChoice) payload.tool_choice = toAnthropicToolChoice(request.toolChoice);
  const effort =
    request.effort && anthropic.supportsEffort(request.modelProfile.model)
      ? request.effort
      : undefined;
  const format = request.structuredOutput
    ? { type: 'json_schema' as const, schema: request.structuredOutput.schema }
    : undefined;
  if (effort || format) {
    payload.output_config = {
      ...(effort ? { effort } : {}),
      ...(format ? { format } : {}),
    };
  }
  if (request.sampling) {
    if (request.sampling.temperature !== undefined) {
      payload.temperature = request.sampling.temperature;
    }
    if (request.sampling.topP !== undefined) payload.top_p = request.sampling.topP;
    if (request.sampling.topK !== undefined) payload.top_k = request.sampling.topK;
  }
  if (request.stopSequences) payload.stop_sequences = request.stopSequences;
  if (request.metadata) payload.metadata = request.metadata;
  if (request.serviceTier) payload.service_tier = request.serviceTier;
  assertAnthropicCacheLimit(payload);
  return payload;
}

function toAnthropicContent(content: InferenceContent): ContentBlock {
  const cache = cacheControl(content.cache);
  if (content.type === 'text') {
    return {
      type: 'text',
      text: content.text,
      ...(content.citations
        ? { citations: content.citations.map((citation) => ({ ...citation })) }
        : {}),
      ...(cache ? { cache_control: cache } : {}),
    };
  }
  if (content.type === 'image' || content.type === 'document') {
    return {
      type: content.type,
      source: toAnthropicMediaSource(content),
      ...(content.type === 'document' && content.title ? { title: content.title } : {}),
      ...(content.type === 'document' && content.context ? { context: content.context } : {}),
      ...(content.type === 'document' && content.citations
        ? { citations: { ...content.citations } }
        : {}),
      ...(cache ? { cache_control: cache } : {}),
    };
  }
  if (content.type === 'tool-call') {
    return {
      type: 'tool_use',
      id: content.id,
      name: content.name,
      input: content.input,
      ...(cache ? { cache_control: cache } : {}),
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: content.toolCallId,
    content:
      content.content.length === 1 && content.content[0]?.type === 'text'
        ? content.content[0].text
        : content.content.map((item) => {
            const translated = toAnthropicContent(item);
            if (translated.type === 'tool_use' || translated.type === 'tool_result') {
              throw new Error('Anthropic tool results cannot contain nested tool blocks');
            }
            return translated;
          }),
    is_error: content.isError,
    ...(cache ? { cache_control: cache } : {}),
  };
}

function toAnthropicMediaSource(
  content: Extract<InferenceContent, { type: 'image' | 'document' }>,
): Extract<ContentBlock, { type: 'image' | 'document' }>['source'] {
  const source = content.source;
  if (source.type === 'file') {
    throw new Error('Anthropic received an unresolved public file reference');
  }
  if (source.type === 'provider-file') {
    if (source.reference.provider !== 'anthropic') {
      throw new Error(`Anthropic cannot consume ${source.reference.provider} file references`);
    }
    return { type: 'file', file_id: source.reference.upstreamFileId };
  }
  if (source.type === 'base64') {
    return { type: 'base64', media_type: source.mediaType, data: source.data };
  }
  if (source.type === 'url') return { type: 'url', url: source.url };
  if (source.type === 'content') {
    return {
      type: 'content',
      content:
        typeof source.content === 'string'
          ? source.content
          : source.content.map((block) => {
              const translated = toAnthropicContent(block);
              if (translated.type !== 'text' && translated.type !== 'image') {
                throw new Error('Anthropic content documents accept only text and image blocks');
              }
              return translated;
            }),
    };
  }
  return { type: 'text', media_type: source.mediaType, data: source.text };
}

function responseResult(data: AnthropicResponseBody): InferenceResult {
  if (
    !isJsonObject(data) ||
    data.type !== 'message' ||
    data.role !== 'assistant' ||
    typeof data.id !== 'string' ||
    typeof data.model !== 'string' ||
    typeof data.stop_reason !== 'string' ||
    !data.usage
  ) {
    throw invalidAnthropicResponse('Anthropic returned an incomplete message response');
  }
  validateUsage(data.usage, true);
  const content = parseResponseContent(data.content);
  const toolCalls = content.filter((item): item is InferenceToolCall => item.type === 'tool-call');
  return {
    content,
    toolCalls,
    usage: normalizeUsage(data.usage),
    stopReason: normalizeStopReason(data.stop_reason),
    providerStopReason: data.stop_reason,
    providerState: anthropicState({
      contentBlocks: data.content,
      rawResponse: data,
      stopReason: data.stop_reason,
    }),
  };
}

function parseResponseContent(raw: unknown): InferenceContent[] {
  if (!Array.isArray(raw)) {
    throw invalidAnthropicResponse('Anthropic message response omitted content');
  }
  return raw.flatMap((item): InferenceContent[] => {
    if (!item || typeof item !== 'object') {
      throw invalidAnthropicResponse('Anthropic message contained an invalid content block');
    }
    const block = item as Record<string, unknown>;
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        throw invalidAnthropicResponse('Anthropic text block omitted text');
      }
      if (
        block.citations !== undefined &&
        (!Array.isArray(block.citations) || !block.citations.every(isJsonObject))
      ) {
        throw invalidAnthropicResponse('Anthropic text block contained invalid citations');
      }
      return [
        {
          type: 'text',
          text: block.text,
          ...(Array.isArray(block.citations)
            ? { citations: block.citations.map((citation) => ({ ...citation })) }
            : {}),
          cache: 'none',
        },
      ];
    }
    if (block.type === 'tool_use') {
      if (
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        !isJsonObject(block.input)
      ) {
        throw invalidAnthropicResponse('Anthropic tool_use block was incomplete');
      }
      return [
        {
          type: 'tool-call',
          id: block.id,
          name: block.name,
          input: block.input,
          cache: 'none',
        },
      ];
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return [];
    if (isAnthropicOpaqueResponseBlock(block.type)) return [];
    throw invalidAnthropicResponse(
      `Anthropic message contained unknown ${String(block.type)} block`,
    );
  });
}

function finalizePendingBlock(block: PendingBlock): InferenceContent[] {
  if (block.type === 'text') {
    if (
      block.raw.citations !== undefined &&
      (!Array.isArray(block.raw.citations) || !block.raw.citations.every(isJsonObject))
    ) {
      throw invalidAnthropicResponse('Anthropic streamed text block contained invalid citations');
    }
    return [
      {
        type: 'text',
        text: block.text ?? '',
        ...(Array.isArray(block.raw.citations)
          ? { citations: block.raw.citations.map((citation) => ({ ...citation })) }
          : {}),
        cache: 'none',
      },
    ];
  }
  if (isAnthropicToolUseType(block.type)) {
    if (!block.id || !block.name) {
      throw invalidAnthropicResponse('Anthropic streamed tool-use block was incomplete');
    }
    let input: unknown;
    try {
      input = block.inputJson ? (JSON.parse(block.inputJson) as unknown) : {};
    } catch (error) {
      throw invalidAnthropicResponse('Anthropic streamed tool arguments were invalid JSON', error);
    }
    if (!isJsonObject(input)) {
      throw invalidAnthropicResponse('Anthropic streamed tool arguments were not an object');
    }
    block.raw.input = input;
    if (block.type !== 'tool_use') return [];
    return [{ type: 'tool-call', id: block.id, name: block.name, input, cache: 'none' }];
  }
  if (block.type === 'thinking' || block.type === 'redacted_thinking') return [];
  if (isAnthropicOpaqueResponseBlock(block.type)) return [];
  throw invalidAnthropicResponse(`Anthropic stream contained unknown ${block.type} block`);
}

function anthropicContinuationContent(
  state: ProviderContinuationState,
  canonicalContent: readonly InferenceContent[],
): anthropic.CacheableBlock[] {
  if (state.backend !== 'anthropic') {
    throw new Error(`Anthropic cannot continue ${state.backend} provider state`);
  }
  const value = state.value;
  if (!value || typeof value !== 'object') {
    throw invalidAnthropicResponse('Anthropic continuation state was malformed');
  }
  const contentBlocks = (value as { contentBlocks?: unknown }).contentBlocks;
  if (
    !Array.isArray(contentBlocks) ||
    contentBlocks.some((block) => !block || typeof block !== 'object')
  ) {
    throw invalidAnthropicResponse('Anthropic continuation state omitted assistant content blocks');
  }
  const cloned = contentBlocks.map(
    (block) => cloneAnthropicContentBlockWithoutCache(block) as Record<string, unknown>,
  );
  const lastCache = canonicalContent.at(-1)?.cache;
  const last = cloned.at(-1);
  if (last && lastCache) {
    const control = cacheControl(lastCache);
    if (control) last.cache_control = control;
    else delete last.cache_control;
  }
  return cloned;
}

function normalizeUsage(usage?: Usage): InferenceUsage {
  const outputDetails = isJsonObject(usage?.output_tokens_details)
    ? usage.output_tokens_details
    : undefined;
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    cachedInputTokens: usage?.cache_read_input_tokens ?? null,
    cacheWriteInputTokens: usage?.cache_creation_input_tokens ?? null,
    reasoningTokens:
      typeof outputDetails?.thinking_tokens === 'number' ? outputDetails.thinking_tokens : null,
    ...(usage ? { providerDetails: { ...usage } } : {}),
  };
}

function validateUsage(usage: unknown, requireComplete: boolean): asserts usage is Usage {
  if (!isJsonObject(usage)) {
    throw invalidAnthropicResponse('Anthropic usage was not an object');
  }
  if (requireComplete && (usage.input_tokens === undefined || usage.output_tokens === undefined)) {
    throw invalidAnthropicResponse('Anthropic usage omitted required token counts');
  }
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const) {
    const value = usage[key];
    const nullable = key === 'cache_creation_input_tokens' || key === 'cache_read_input_tokens';
    if (
      value !== undefined &&
      ((value === null && !nullable) ||
        (value !== null &&
          (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)))
    ) {
      throw invalidAnthropicResponse('Anthropic usage contained an invalid token count');
    }
  }
  const outputDetails = usage.output_tokens_details;
  if (outputDetails !== undefined && outputDetails !== null) {
    if (!isJsonObject(outputDetails)) {
      throw invalidAnthropicResponse('Anthropic output token details were invalid');
    }
    const thinkingTokens = outputDetails.thinking_tokens;
    if (
      thinkingTokens !== undefined &&
      (typeof thinkingTokens !== 'number' ||
        !Number.isSafeInteger(thinkingTokens) ||
        thinkingTokens < 0)
    ) {
      throw invalidAnthropicResponse('Anthropic thinking token count was invalid');
    }
  }
}

function validateAnthropicFileRecord(
  data: unknown,
  expectedId?: string,
): asserts data is {
  id: string;
  type: 'file';
  mime_type: string;
  size_bytes: number;
} {
  if (
    !isJsonObject(data) ||
    data.type !== 'file' ||
    typeof data.id !== 'string' ||
    data.id.length === 0 ||
    (expectedId !== undefined && data.id !== expectedId) ||
    typeof data.mime_type !== 'string' ||
    data.mime_type.length === 0 ||
    typeof data.size_bytes !== 'number' ||
    !Number.isSafeInteger(data.size_bytes) ||
    data.size_bytes < 0
  ) {
    throw invalidAnthropicResponse('Anthropic file response was invalid');
  }
}

function normalizeStopReason(reason: string | null | undefined): InferenceStopReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'completed';
  if (reason === 'max_tokens') return 'max-output-tokens';
  if (reason === 'tool_use') return 'tool-call';
  if (reason === 'refusal') return 'content-filter';
  if (reason === 'pause_turn') return 'paused';
  if (reason === 'model_context_window_exceeded') return 'context-window';
  return 'unknown';
}

function toAnthropicToolChoice(
  choice: NonNullable<InferenceRequest['toolChoice']>,
): NonNullable<MessagesPayload['tool_choice']> {
  const parallel =
    choice.disableParallel !== undefined
      ? { disable_parallel_tool_use: choice.disableParallel }
      : {};
  if (choice.mode === 'specific') return { type: 'tool', name: choice.name, ...parallel };
  if (choice.mode === 'required') return { type: 'any', ...parallel };
  return { type: choice.mode, ...parallel };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAnthropicToolUseType(type: string): boolean {
  return type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use';
}

function isAnthropicOpaqueResponseBlock(type: unknown): boolean {
  return (
    type === 'server_tool_use' ||
    type === 'mcp_tool_use' ||
    type === 'mcp_tool_result' ||
    type === 'tool_reference' ||
    type === 'container_upload' ||
    (typeof type === 'string' && type.endsWith('_tool_result'))
  );
}

function validMessageStart(message: AnthropicStreamEvent['message']): message is {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: unknown[];
  stop_reason: null;
  stop_sequence: null;
  usage: Usage;
} {
  if (
    !isJsonObject(message) ||
    typeof message.id !== 'string' ||
    message.type !== 'message' ||
    message.role !== 'assistant' ||
    typeof message.model !== 'string' ||
    !Array.isArray(message.content) ||
    message.content.length !== 0 ||
    message.stop_reason !== null ||
    message.stop_sequence !== null
  ) {
    return false;
  }
  validateUsage(message.usage, true);
  return true;
}

function validateStreamDeltaUsage(usage: unknown): asserts usage is Usage {
  validateUsage(usage, false);
  if ((usage as Usage).output_tokens === undefined) {
    throw invalidAnthropicResponse('Anthropic message_delta usage omitted output_tokens');
  }
}

function cacheControl(cache: CacheIntent): { type: 'ephemeral'; ttl?: '1h' } | null {
  if (cache === 'extended') return { type: 'ephemeral', ttl: '1h' };
  if (cache === 'short') return { type: 'ephemeral' };
  return null;
}

function assertAnthropicCacheLimit(payload: MessagesPayload): void {
  const systemCount = countCacheControls(payload.system ?? []);
  const messageCount = payload.messages.reduce(
    (total, message) =>
      total + (Array.isArray(message.content) ? countCacheControls(message.content) : 0),
    0,
  );
  if (systemCount + messageCount > 4) {
    throw new Error("Canonical cache allocation exceeds Anthropic's four-breakpoint limit");
  }
}

function countCacheControls(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((total, item) => total + countCacheControls(item), 0);
  if (!isJsonObject(value)) return 0;
  let total = value.cache_control === undefined ? 0 : 1;
  if (value.type === 'document' && isJsonObject(value.source)) {
    const source = value.source;
    if (source.type === 'content' && Array.isArray(source.content)) {
      total += countCacheControls(source.content);
    }
  }
  if (value.type === 'tool_result' && Array.isArray(value.content)) {
    total += countCacheControls(value.content);
  }
  return total;
}

function cloneAnthropicContentBlockWithoutCache(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  const cloned = { ...value };
  delete cloned.cache_control;
  if (cloned.type === 'document' && isJsonObject(cloned.source)) {
    const source = { ...cloned.source };
    if (source.type === 'content' && Array.isArray(source.content)) {
      source.content = source.content.map(cloneAnthropicContentBlockWithoutCache);
    }
    cloned.source = source;
  }
  if (cloned.type === 'tool_result' && Array.isArray(cloned.content)) {
    cloned.content = cloned.content.map(cloneAnthropicContentBlockWithoutCache);
  }
  return cloned;
}

function anthropicState(value: unknown): ProviderContinuationState {
  return { backend: 'anthropic', value };
}

function anthropicFailure(
  status: number | null,
  data?: unknown,
  detail?: string,
): InferenceFailure {
  const error = (data as AnthropicResponseBody | undefined)?.error;
  return new InferenceFailure({
    backend: 'anthropic',
    status,
    code: error?.type ?? 'anthropic_error',
    message: error?.message ?? `Anthropic request failed${status == null ? '' : ` (${status})`}`,
    ...(detail || data !== undefined ? { detail: detail || JSON.stringify(data) } : {}),
    retryable: status === 429 || status === 529 || (status !== null && status >= 500),
    failureClass: status === null ? 'invalid-response' : 'http',
  });
}

/**
 * What a Files API 500 most often means for an account. The provider's own
 * message stays first; this rides after it so a caller reads the likely cause
 * without app-ai's handlers knowing which provider spoke.
 */
const FILES_API_BETA_HINT =
  '\n\nThe Files API may not be available for your account yet. It is currently in beta and requires special access.';

function anthropicUploadFailure(status: number, data?: unknown): InferenceFailure {
  const failure = anthropicFailure(status, data);
  if (status !== 500) return failure;
  return new InferenceFailure({
    ...failure.inferenceError,
    message: `${failure.inferenceError.message}${FILES_API_BETA_HINT}`,
  });
}

function anthropicStreamFailure(error?: { type?: string; message?: string }): InferenceFailure {
  const code = error?.type ?? 'anthropic_stream_error';
  const retryable =
    code === 'overloaded_error' || code === 'rate_limit_error' || code === 'api_error';
  return new InferenceFailure({
    backend: 'anthropic',
    status: null,
    code,
    message: `Anthropic stream error: ${error?.message ?? 'unknown'}`,
    retryable,
    failureClass: 'http',
  });
}

async function callAnthropic(
  operation: () => Promise<Response>,
  abortSignal?: AbortSignal,
): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    throw anthropicTransportFailure(error, abortSignal);
  }
}

function anthropicTransportFailure(error: unknown, abortSignal?: AbortSignal): InferenceFailure {
  if (error instanceof InferenceFailure) return error;
  const name = error instanceof Error ? error.name : '';
  const timedOut = name === 'TimeoutError';
  const cancelled = !timedOut && (abortSignal?.aborted === true || name === 'AbortError');
  return new InferenceFailure({
    backend: 'anthropic',
    status: null,
    code: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network_error',
    message: cancelled
      ? 'Anthropic request was cancelled'
      : timedOut
        ? 'Anthropic request timed out'
        : error instanceof Error
          ? error.message
          : 'Anthropic network request failed',
    retryable: !cancelled,
    failureClass: cancelled ? 'cancelled' : timedOut ? 'timeout' : 'network',
  });
}

async function readAnthropicJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new InferenceFailure({
      backend: 'anthropic',
      status: response.status,
      code: 'invalid_response',
      message: 'Anthropic returned an invalid JSON response',
      detail: error instanceof Error ? error.message : String(error),
      retryable: response.status >= 500,
      failureClass: 'invalid-response',
    });
  }
}

function invalidAnthropicResponse(message: string, detail?: unknown): InferenceFailure {
  return new InferenceFailure({
    backend: 'anthropic',
    status: null,
    code: 'invalid_response',
    message,
    ...(detail !== undefined
      ? { detail: detail instanceof Error ? detail.message : String(detail) }
      : {}),
    retryable: true,
    failureClass: 'invalid-response',
  });
}

function validateFilePolicy(policy: FilePolicy): void {
  if (
    policy.provider !== 'anthropic' ||
    !policy.compatibleApiFamilies.includes('anthropic-messages')
  ) {
    throw new Error(`File policy ${policy.name} is incompatible with Anthropic Messages`);
  }
}
