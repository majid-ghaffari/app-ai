/**
 * Local-development inference tracing.
 *
 * The trace records the model-visible request content and the returned assistant content so a local
 * Studio run can be diagnosed from the configured sinks. Model-visible content is preserved in full,
 * including file references; worker credentials live outside model payloads and the logger redacts
 * secret-bearing fields from any structured detail.
 *
 * The configured TRACE level decides where these records go. Production can ignore TRACE while a
 * local deployment fans it out to console and Seq; the helper has no environment-name policy.
 */

import type { CacheableBlock } from './anthropic';
import type { Logger } from './logger';

export interface DevelopmentInferenceTrace {
  record(event: string, fields?: Record<string, unknown>): void;
}

interface InferenceTraceEvent extends Record<string, unknown> {
  traceId: string;
  route: string;
  prompt: string | null;
  event: string;
  elapsedMs: number;
}

/** Retain model-visible text, tool decisions, file references, and cache metadata. */
function traceableBlock(block: CacheableBlock): Record<string, unknown> {
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  if (type === 'text') {
    return { type, text: typeof block.text === 'string' ? block.text : '' };
  }
  if (type === 'tool_use') {
    return {
      type,
      name: typeof block.name === 'string' ? block.name : undefined,
      input: block.input,
    };
  }
  if (type === 'tool_result') {
    return {
      type,
      content: block.content,
      isError: block.is_error === true,
    };
  }
  if (type === 'image' || type === 'document') {
    return { ...block };
  }
  return { type };
}

/** A log-safe structural view of model content, preserving the full diagnostic text. */
export function traceableContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((block) =>
    block && typeof block === 'object'
      ? traceableBlock(block as CacheableBlock)
      : { type: 'invalid' },
  );
}

/** Preserve roles and full model-visible content for each turn. */
export function traceableMessages(payload: { messages?: unknown }): unknown[] {
  if (!Array.isArray(payload.messages)) return [];
  return payload.messages.map((message) => {
    const record =
      message && typeof message === 'object' ? (message as Record<string, unknown>) : {};
    return {
      role: typeof record.role === 'string' ? record.role : 'unknown',
      content: traceableContent(record.content),
    };
  });
}

/** Preserve the full model-visible system payload. */
export function traceableSystem(system: unknown): unknown {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return system;
  return system.map((block) =>
    block && typeof block === 'object'
      ? traceableBlock(block as CacheableBlock)
      : { type: 'invalid' },
  );
}

/** Create one correlated, elapsed-time-aware trace for a local inference request. */
export function createDevelopmentInferenceTrace(
  logger: Logger,
  route: string,
  prompt: string | null,
): DevelopmentInferenceTrace {
  const traceId = crypto.randomUUID();
  const startedAt = Date.now();
  return {
    record(event, fields = {}) {
      const traceEvent: InferenceTraceEvent = {
        traceId,
        route,
        prompt,
        event,
        elapsedMs: Date.now() - startedAt,
        ...fields,
      };
      logger.trace(`inference.${event}`, traceEvent);
    },
  };
}
