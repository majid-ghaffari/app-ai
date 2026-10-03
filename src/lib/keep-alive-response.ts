import { messagesKeepAliveIntervalMilliseconds, type Env } from '../config';
import { errorResponseFrom, type CorsHeaders } from './responses';
import type { BackgroundTaskScheduler } from './logger';
import type { JsonBody } from './request-body';

/** The `/messages` JSON request-body member a caller sets to ask for a keep-alive answer. */
export const RESPONSE_MODE_FIELD = 'responseMode';

/** The one `responseMode` value app-ai serves; it also names the answer's envelope. */
export const KEEP_ALIVE_RESPONSE_MODE = 'keep-alive';

const KEEP_ALIVE_BYTE = ' ';

/** The keep-alive answer a caller opted in to: a whitespace byte every `intervalMilliseconds`. */
export interface KeepAlive {
  readonly intervalMilliseconds: number;
}

/** A read request body without its keep-alive opt-in, and that opt-in, or `null` without one. */
export interface KeepAliveOptIn {
  readonly body: JsonBody;
  readonly keepAlive: KeepAlive | null;
}

type KeepAliveEnvelope =
  | {
      readonly responseMode: typeof KEEP_ALIVE_RESPONSE_MODE;
      readonly status: number;
      readonly result: unknown;
    }
  | {
      readonly responseMode: typeof KEEP_ALIVE_RESPONSE_MODE;
      readonly status: number;
      readonly error: unknown;
    };

/**
 * Separate the keep-alive opt-in from an authenticated caller's JSON body, read once. Only an object
 * whose `responseMode` is exactly `keep-alive` opts in, and loses that member; any other body, a
 * failed read included, is returned exactly as it was given.
 */
export function readKeepAliveOptIn(body: JsonBody, env: Env): KeepAliveOptIn {
  if (!('value' in body)) return { body, keepAlive: null };
  const { value } = body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { body, keepAlive: null };
  const { [RESPONSE_MODE_FIELD]: responseMode, ...rest } = value as Record<string, unknown>;
  if (responseMode !== KEEP_ALIVE_RESPONSE_MODE) return { body, keepAlive: null };
  return {
    body: { value: rest },
    keepAlive: { intervalMilliseconds: messagesKeepAliveIntervalMilliseconds(env) },
  };
}

/**
 * Answer at once with status 200, write a whitespace byte immediately and then every interval
 * while `outcome` is pending, and finish with its keep-alive envelope. The pending work is handed
 * to `schedule` so a caller that disconnects leaves it the runtime's grace to settle what it holds.
 */
export function keepAliveResponse(
  outcome: Promise<Response>,
  corsHeaders: CorsHeaders,
  keepAlive: KeepAlive,
  schedule?: BackgroundTaskScheduler,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const keepAliveChunk = encoder.encode(KEEP_ALIVE_BYTE);
  let connected = true;
  const write = (chunk: Uint8Array): Promise<void> =>
    writer.write(chunk).catch(() => {
      connected = false;
    });
  void write(keepAliveChunk);
  const timer = setInterval(() => {
    if (connected) void write(keepAliveChunk);
  }, keepAlive.intervalMilliseconds);
  const delivery = outcome
    .catch((error: unknown) => errorResponseFrom(error, corsHeaders))
    .then(keepAliveEnvelope)
    .then(async (envelope) => {
      clearInterval(timer);
      if (!connected) return;
      await write(encoder.encode(envelope));
      await writer.close();
    })
    .catch(() => writer.abort().catch(() => undefined))
    .finally(() => clearInterval(timer));
  schedule?.(delivery);
  return new Response(readable, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-transform',
    },
  });
}

async function keepAliveEnvelope(response: Response): Promise<string> {
  const body = parsedBody(await response.text());
  const envelope: KeepAliveEnvelope = response.ok
    ? { responseMode: KEEP_ALIVE_RESPONSE_MODE, status: response.status, result: body }
    : { responseMode: KEEP_ALIVE_RESPONSE_MODE, status: response.status, error: body };
  return JSON.stringify(envelope);
}

function parsedBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
