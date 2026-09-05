/** Translation for the existing `/messages` request/response compatibility contract. */

import type {
  CacheIntent,
  CanonicalClientToolDefinition,
  CanonicalHostedToolDefinition,
  CanonicalToolDefinition,
  CanonicalToolChoice,
  InferenceContent,
  InferenceBackendName,
  InferenceMessage,
  InferenceResult,
  InferenceSampling,
  ProviderContinuationState,
  StructuredOutputRequirement,
} from '../lib/inference-types';
import { STABLE_CACHE_PREFIX_MARKER } from './cache';

/** Parse the existing external message blocks into canonical content. */
export function parseCompatibilityMessages(
  raw: unknown,
  backend: InferenceBackendName,
): InferenceMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): InferenceMessage[] => {
    if (!item || typeof item !== 'object') return [];
    const message = item as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const content = parseContent(message.content);
    const providerState = reconstructCompatibilityProviderState(
      message.role,
      message.content,
      backend,
    );
    return [
      {
        role: message.role,
        content,
        ...(providerState ? { providerState } : {}),
      },
    ];
  });
}

/**
 * Whether any block, at any depth of a raw Messages body, names a provider
 * file (`source.type === 'file'`). Tool-result content nests media, so the scan
 * is structural rather than schema-aware: a provider file id is refused wherever
 * it sits.
 */
export function hasProviderFileSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProviderFileSource);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (source && typeof source === 'object' && (source as Record<string, unknown>).type === 'file') {
    return true;
  }
  return Object.values(record).some(hasProviderFileSource);
}

/** Recover provider-owned history only at the bounded compatibility boundary. */
export function reconstructCompatibilityProviderState(
  role: 'user' | 'assistant',
  rawContent: unknown,
  backend: InferenceBackendName,
): ProviderContinuationState | undefined {
  return backend === 'anthropic' && role === 'assistant' && Array.isArray(rawContent)
    ? { backend, value: { contentBlocks: rawContent } }
    : undefined;
}

/** Translate caller-supplied custom tools without granting them execution in app-ai. */
export function parseCompatibilityTools(
  raw: unknown,
  backend: InferenceBackendName,
): readonly CanonicalToolDefinition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('Messages tools must be an array');
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Messages tool was invalid');
    const tool = item as Record<string, unknown>;
    if (typeof tool.name !== 'string') throw new Error('Messages tool definition was invalid');
    const schema = tool.input_schema;
    if (schema === undefined) {
      if (typeof tool.type !== 'string') throw new Error('Messages tool definition was invalid');
      const providerState = {
        backend,
        value: Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'cache_control')),
      };
      return {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        execution: 'provider',
        providerState,
      } satisfies CanonicalHostedToolDefinition;
    }
    if (
      !schema ||
      typeof schema !== 'object' ||
      Array.isArray(schema) ||
      (schema as Record<string, unknown>).type !== 'object' ||
      ((schema as Record<string, unknown>).properties !== undefined &&
        (typeof (schema as Record<string, unknown>).properties !== 'object' ||
          Array.isArray((schema as Record<string, unknown>).properties)))
    ) {
      throw new Error('Messages tool definition was invalid');
    }
    const allowedCallers = optionalStringArray(tool.allowed_callers, 'allowed_callers');
    const inputExamples = optionalObjectArray(tool.input_examples, 'input_examples');
    return {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      execution: 'client',
      inputSchema: schema as CanonicalClientToolDefinition['inputSchema'],
      ...(typeof tool.type === 'string' ? { kind: tool.type } : {}),
      ...(typeof tool.strict === 'boolean' ? { strict: tool.strict } : {}),
      ...(allowedCallers ? { allowedCallers } : {}),
      ...(typeof tool.defer_loading === 'boolean' ? { deferLoading: tool.defer_loading } : {}),
      ...(inputExamples ? { inputExamples } : {}),
      ...(typeof tool.eager_input_streaming === 'boolean'
        ? { eagerInputStreaming: tool.eager_input_streaming }
        : {}),
    };
  });
}

/** Translate Anthropic-compatible tool choice into the canonical selection contract. */
export function parseCompatibilityToolChoice(raw: unknown): CanonicalToolChoice | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Messages tool_choice was invalid');
  }
  const choice = raw as Record<string, unknown>;
  const parallel =
    typeof choice.disable_parallel_tool_use === 'boolean'
      ? { disableParallel: choice.disable_parallel_tool_use }
      : {};
  if (choice.type === 'auto' || choice.type === 'none') {
    return { mode: choice.type, ...parallel };
  }
  if (choice.type === 'any') return { mode: 'required', ...parallel };
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { mode: 'specific', name: choice.name, ...parallel };
  }
  throw new Error('Messages tool_choice was invalid');
}

/** Preserve provider-neutral sampling controls from the existing request body. */
export function parseSampling(
  body: Readonly<Record<string, unknown>>,
): InferenceSampling | undefined {
  const temperature = finiteNumber(body.temperature);
  const topP = finiteNumber(body.top_p);
  const topK = finiteNumber(body.top_k);
  if (temperature === undefined && topP === undefined && topK === undefined) return undefined;
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
  };
}

/** Preserve string stop sequences from the existing request body. */
export function parseStopSequences(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) return undefined;
  return raw;
}

/** Preserve request metadata without granting it routing authority. */
export function parseInferenceMetadata(
  raw: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Readonly<Record<string, unknown>>)
    : undefined;
}

/** Preserve the existing provider service-tier request control. */
export function parseServiceTier(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Parse the stable subset of the existing output-format contract. */
export function parseStructuredOutput(raw: unknown): StructuredOutputRequirement | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const outputConfig = raw as Record<string, unknown>;
  if (!outputConfig.format || typeof outputConfig.format !== 'object') return undefined;
  const format = outputConfig.format as Record<string, unknown>;
  if (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object') {
    return undefined;
  }
  return {
    name: 'messages-output',
    schema: format.schema as Readonly<Record<string, unknown>>,
    strict: true,
  };
}

/** Preserve Anthropic raw parity or synthesize the existing `/messages` envelope canonically. */
export function messagesCompatibilityResponse(
  result: InferenceResult,
  model: string,
  continuation?: string,
): unknown {
  const value = result.providerState?.value;
  if (value && typeof value === 'object' && 'rawResponse' in value) {
    return (value as { rawResponse: unknown }).rawResponse;
  }
  const content = result.content.flatMap((item): Record<string, unknown>[] => {
    if (item.type === 'text') {
      return [
        {
          type: 'text',
          text: item.text,
          ...(item.citations
            ? { citations: item.citations.map((citation) => ({ ...citation })) }
            : {}),
        },
      ];
    }
    if (item.type === 'tool-call') {
      return [{ type: 'tool_use', id: item.id, name: item.name, input: item.input }];
    }
    return [];
  });
  return {
    id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    ...(continuation ? { continuation } : {}),
    stop_reason: compatibilityStopReason(result),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
      ...(result.usage.cachedInputTokens !== null
        ? { cache_read_input_tokens: result.usage.cachedInputTokens }
        : {}),
      ...(result.usage.cacheWriteInputTokens !== null
        ? { cache_creation_input_tokens: result.usage.cacheWriteInputTokens }
        : {}),
    },
  };
}

function compatibilityStopReason(result: InferenceResult): string | null {
  if (result.stopReason === 'tool-call') return 'tool_use';
  if (result.stopReason === 'completed') return 'end_turn';
  if (result.stopReason === 'max-output-tokens') return 'max_tokens';
  if (result.stopReason === 'content-filter') return 'refusal';
  return result.providerStopReason ?? null;
}

function parseContent(raw: unknown): InferenceContent[] {
  if (typeof raw === 'string') return [{ type: 'text', text: raw, cache: 'none' }];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): InferenceContent[] => {
    if (!item || typeof item !== 'object') return [];
    const block = item as Record<string, unknown>;
    const cache: CacheIntent = block[STABLE_CACHE_PREFIX_MARKER] === true ? 'extended' : 'none';
    if (block.type === 'text') {
      return [{ type: 'text', text: typeof block.text === 'string' ? block.text : '', cache }];
    }
    if (block.type === 'image' || block.type === 'document') {
      const media = parseMedia(block.type, block, cache);
      return media ? [media] : [];
    }
    if (block.type === 'tool_use') {
      return [
        {
          type: 'tool-call',
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          input: block.input,
          cache,
        },
      ];
    }
    if (block.type === 'tool_result') {
      return [
        {
          type: 'tool-result',
          toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: parseToolResultContent(block.content),
          isError: block.is_error === true,
          cache,
        },
      ];
    }
    return [];
  });
}

function parseMedia(
  type: 'image' | 'document',
  raw: unknown,
  cache: CacheIntent,
): Extract<InferenceContent, { type: 'image' | 'document' }> | null {
  const block = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const source =
    block.source && typeof block.source === 'object'
      ? (block.source as Record<string, unknown>)
      : {};
  const documentFields =
    type === 'document'
      ? {
          ...(typeof block.title === 'string' ? { title: block.title } : {}),
          ...(typeof block.context === 'string' ? { context: block.context } : {}),
          ...(block.citations &&
          typeof block.citations === 'object' &&
          (block.citations as Record<string, unknown>).enabled === true
            ? { citations: { enabled: true } }
            : {}),
        }
      : {};
  if (source.type === 'file' && typeof source.file_id === 'string') {
    return {
      type,
      source: { type: 'file', reference: { id: source.file_id, type: 'file' } },
      ...documentFields,
      cache,
    };
  }
  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return {
      type,
      source: { type: 'base64', mediaType: source.media_type, data: source.data },
      ...documentFields,
      cache,
    };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type, source: { type: 'url', url: source.url }, ...documentFields, cache };
  }
  if (
    type === 'document' &&
    source.type === 'text' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return {
      type,
      source: { type: 'text', mediaType: source.media_type, text: source.data },
      ...documentFields,
      cache,
    };
  }
  if (type === 'document' && source.type === 'content' && typeof source.content === 'string') {
    return {
      type,
      source: { type: 'content', content: source.content },
      ...documentFields,
      cache,
    };
  }
  if (type === 'document' && source.type === 'content' && Array.isArray(source.content)) {
    const content = source.content.map((item) => {
      if (!item || typeof item !== 'object') {
        throw new Error('Messages content-document block was invalid');
      }
      const nested = item as Record<string, unknown>;
      const nestedCache = cacheIntentFromWire(nested.cache_control);
      if (nested.type === 'image') {
        const image = parseMedia('image', nested, nestedCache);
        if (image?.type === 'image') return image;
      }
      if (nested.type === 'text' && typeof nested.text === 'string') {
        return {
          type: 'text' as const,
          text: nested.text,
          ...(Array.isArray(nested.citations)
            ? {
                citations: nested.citations as readonly Readonly<Record<string, unknown>>[],
              }
            : {}),
          cache: nestedCache,
        };
      }
      throw new Error('Messages content-document block was invalid');
    });
    return {
      type,
      source: { type: 'content', content },
      ...documentFields,
      cache,
    };
  }
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cacheIntentFromWire(raw: unknown): CacheIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'none';
  const control = raw as Record<string, unknown>;
  if (control.type !== 'ephemeral') return 'none';
  return control.ttl === '1h' ? 'extended' : 'short';
}

function optionalStringArray(raw: unknown, field: string): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    throw new Error(`Messages tool ${field} was invalid`);
  }
  return raw;
}

function optionalObjectArray(
  raw: unknown,
  field: string,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => !item || typeof item !== 'object')) {
    throw new Error(`Messages tool ${field} was invalid`);
  }
  return raw as readonly Readonly<Record<string, unknown>>[];
}

function parseToolResultContent(
  raw: unknown,
): Array<Extract<InferenceContent, { type: 'text' | 'image' | 'document' }>> {
  if (typeof raw === 'string') return [{ type: 'text', text: raw, cache: 'none' }];
  return parseContent(raw).filter(
    (content): content is Extract<InferenceContent, { type: 'text' | 'image' | 'document' }> =>
      content.type === 'text' || content.type === 'image' || content.type === 'document',
  );
}
