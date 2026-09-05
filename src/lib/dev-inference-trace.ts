/**
 * Local-development inference tracing.
 *
 * The trace records the model-visible request content and the returned assistant content so a local
 * Studio run can be diagnosed from the configured sinks. Diagnostic text and tool decisions are
 * preserved while opaque file references, encoded media, and provider continuation state are
 * redacted centrally before they reach any logger sink.
 *
 * The configured TRACE level decides where these records go. Production can ignore TRACE while a
 * local deployment fans it out to console and Seq; the helper has no environment-name policy.
 */

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

/** Recursively retain tool diagnostics while removing opaque ids and encoded media. */
export function redactInferenceTraceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactInferenceTraceValue);
  if (typeof value === 'string') {
    return value.replace(/\bfile[-_][A-Za-z0-9_-]{6,}\b/g, '[opaque-file]');
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.type === 'file') return { type: 'file' };
  if (record.type === 'base64') {
    return {
      type: 'base64',
      ...(typeof record.media_type === 'string' ? { media_type: record.media_type } : {}),
      ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
    };
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key]) =>
          !['file_id', 'fileId', 'upstreamFileId', 'continuation', 'providerState'].includes(key),
      )
      .map(([key, item]) => [key, redactInferenceTraceValue(item)]),
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
      const safeFields = redactInferenceTraceValue(fields) as Record<string, unknown>;
      const traceEvent: InferenceTraceEvent = {
        traceId,
        route,
        prompt,
        event,
        elapsedMs: Date.now() - startedAt,
        ...safeFields,
      };
      logger.trace(`inference.${event}`, traceEvent);
    },
  };
}
