/**
 * Shared HTTP response helpers — one place for the response/error JSON shape so
 * handlers never copy-paste `new Response(JSON.stringify(...), { headers: {...} })`.
 *
 * The error shape is Brain's wire format (`GlobalExceptionHandlerMiddleware` in
 * the brain repo): a flat PascalCase object, `MessageDetail` omitted when absent
 * (Brain serializes with `NullValueHandling.Ignore`):
 *
 *   { "Message": "...", "ExceptionType": "...", "MessageDetail": "..." }
 *
 * app-ai errors are structurally identical to Brain errors, so clients keep ONE
 * parser for both backends. SSE `error` events carry the same payload as their
 * `data` (see handlers/chat.ts).
 */

/** CORS headers built by lib/cors.ts and spread onto every `Response`. */
export type CorsHeaders = Record<string, string>;

/**
 * Brain's wire error envelope — mirrors `HttpError` as serialized by Brain's
 * `GlobalExceptionHandlerMiddleware` (flat PascalCase, field order
 * Message → ExceptionType → MessageDetail, `MessageDetail` omitted when absent).
 */
export interface BrainErrorEnvelope {
  Message: string;
  ExceptionType: string;
  MessageDetail?: string;
}

/** Build a JSON `Response` (body = `data` serialized). */
export function jsonResponse(data: unknown, corsHeaders: CorsHeaders, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export interface WorkerErrorOptions {
  status?: number;
  exceptionType?: string;
  messageDetail?: string;
  /** Raw upstream Brain body to relay unchanged (status + body passthrough). */
  passthroughBody?: string;
}

/**
 * An `Error` that carries the Brain-shaped wire fields, so a throw site can pin
 * the HTTP status, the stable `ExceptionType` identifier, and an optional
 * `MessageDetail`. When `passthroughBody` is set (a raw JSON string relayed from
 * a forwarded Brain call), `errorResponseFrom` returns that body + status
 * UNCHANGED instead of building a new envelope.
 */
export class WorkerError extends Error {
  readonly status: number;
  readonly exceptionType: string;
  readonly messageDetail: string | undefined;
  readonly passthroughBody: string | undefined;

  constructor(message: string, options: WorkerErrorOptions = {}) {
    super(message);
    this.name = 'WorkerError';
    this.status = options.status ?? 500;
    this.exceptionType = options.exceptionType ?? 'Exception';
    this.messageDetail = options.messageDetail;
    this.passthroughBody = options.passthroughBody;
  }
}

/**
 * Build the Brain-shaped error payload object (used as an HTTP error body and
 * as the SSE `error` event data). Field order matches Brain's `HttpError`
 * model; `MessageDetail` is omitted when absent.
 */
export function errorPayload(
  message: string,
  exceptionType = 'Exception',
  messageDetail?: string,
): BrainErrorEnvelope {
  const payload: BrainErrorEnvelope = { Message: message, ExceptionType: exceptionType };
  if (messageDetail != null) payload.MessageDetail = messageDetail;
  return payload;
}

/** Build a JSON error `Response` with the Brain-shaped body. */
export function errorResponse(
  message: string,
  corsHeaders: CorsHeaders,
  status = 500,
  exceptionType = 'Exception',
  messageDetail?: string,
): Response {
  return jsonResponse(errorPayload(message, exceptionType, messageDetail), corsHeaders, status);
}

/** Anthropic's own error body shape (`{ error: { type, message } }`). */
interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}

/**
 * Build the Brain-shaped error `Response` for a non-ok Anthropic response:
 * Anthropic's status is kept, `Message` comes from Anthropic's
 * `error.message`, `ExceptionType` is `AnthropicApiException`, and the raw
 * upstream body rides in `MessageDetail`.
 */
export function anthropicErrorResponse(
  data: unknown,
  status: number,
  fallbackMessage: string,
  corsHeaders: CorsHeaders,
): Response {
  const upstreamMessage = (data as AnthropicErrorBody | null)?.error?.message;
  const message = upstreamMessage || fallbackMessage;
  return errorResponse(message, corsHeaders, status, 'AnthropicApiException', JSON.stringify(data));
}

/**
 * The Brain-envelope fields extracted from any caught value: a `WorkerError`
 * supplies its own `ExceptionType` / `MessageDetail`; a plain `Error` supplies
 * its message; anything else falls back entirely. Shared by
 * `errorResponseFrom` (HTTP bodies) and the SSE `error` event
 * (handlers/chat.ts) so both carry the identical payload.
 */
export function errorEnvelopeFrom(error: unknown, fallbackMessage: string): BrainErrorEnvelope {
  if (error instanceof WorkerError) {
    return errorPayload(error.message || fallbackMessage, error.exceptionType, error.messageDetail);
  }
  const message = error instanceof Error && error.message ? error.message : fallbackMessage;
  return errorPayload(message);
}

/**
 * Build the error `Response` for a caught error. A `WorkerError` supplies its
 * own status / `ExceptionType` / `MessageDetail`; a Brain passthrough relays
 * Brain's status + body unchanged; anything else becomes the default
 * 500 `Exception` envelope.
 */
export function errorResponseFrom(
  error: unknown,
  corsHeaders: CorsHeaders,
  fallbackMessage = 'Internal server error',
): Response {
  if (error instanceof WorkerError && error.passthroughBody) {
    return new Response(error.passthroughBody, {
      status: error.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const status = error instanceof WorkerError ? error.status : 500;
  return jsonResponse(errorEnvelopeFrom(error, fallbackMessage), corsHeaders, status);
}
