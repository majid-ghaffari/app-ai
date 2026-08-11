/**
 * Shared test utilities: the complete typed `Env` fixture (every required
 * config variable present — src/config.ts throws on a missing one), typed
 * fetch-mock accessors, and the worker-SSE parser.
 */

import { vi, type Mock } from 'vitest';
import type { Env } from '../src/config';

/** A complete Env fixture — all required config variables set. */
export const ENV: Env = {
  ENVIRONMENT: 'test',
  CLAUDE_API_KEY: 'test-key',
  PERSONALIZER_INTEGRATION_BRIDGE_TOKEN: 'svc-token-256bit-opaque',
  PERSONALIZER_API_URL: 'https://brain.test',
  ANTHROPIC_API_BASE: 'https://api.anthropic.com',
  LOG_TARGETS_TRACE: 'ignore',
  LOG_TARGETS_DEBUG: 'ignore',
  LOG_TARGETS_INFO: 'ignore',
  LOG_TARGETS_WARN: 'ignore',
  LOG_TARGETS_ERROR: 'ignore',
  LOG_TARGETS_FATAL: 'ignore',
  LOG_SEQ_INGEST_URL: 'https://seq.test/ingest/clef',
  CREDENTIALED_ORIGINS:
    'https://local-app.limespot.com,http://localhost:4200,http://localhost:3000',
  MODEL_FAST: 'claude-haiku-4-5',
  MODEL_BALANCED: 'claude-sonnet-5',
  MODEL_FRONTIER: 'claude-opus-4-8',
};

export const CORS = { 'Access-Control-Allow-Origin': '*' };

export type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

/** Create a typed fetch mock and install it as the global `fetch`. */
export function stubFetch(): FetchMock {
  const fetchMock: FetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The nth fetch call's `(url, init)` — throws if that call was never made. */
export function fetchCall(fetchMock: FetchMock, index: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(index);
  if (!call) {
    throw new Error(`fetch call ${index} was not made (${fetchMock.mock.calls.length} total)`);
  }
  const [input, init] = call;
  return { url: String(input), init: init ?? {} };
}

/** Every fetched URL, in call order. */
export function fetchedUrls(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

/** A request header sent with a fetch call (mocked inits carry plain objects). */
export function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

/** A cache_control marker as tests assert it. */
export interface CacheControlView {
  type: string;
  ttl?: string;
}

/** A content block as tests inspect it (structural view over the wire JSON). */
export interface BlockView {
  type?: string;
  text?: string;
  cache_control?: CacheControlView;
  source?: { type: string; file_id: string };
  tool_use_id?: string;
  is_error?: boolean;
  [member: string]: unknown;
}

/** The Anthropic Messages body a handler sent, as tests inspect it. */
export interface SentBody {
  model?: string;
  stream?: boolean;
  apiKey?: unknown;
  system?: BlockView[];
  messages?: Array<{ role?: string; content?: string | BlockView[] }>;
  tools?: Array<{ name: string }>;
  output_config?: { effort?: string };
  [member: string]: unknown;
}

/** Parse a fetch call's JSON string body. Throws when the body isn't a string. */
export function sentBody(init: RequestInit): SentBody {
  if (typeof init.body !== 'string') {
    throw new Error('fetch call body is not a JSON string');
  }
  return JSON.parse(init.body) as SentBody;
}

/** One parsed worker SSE event. */
export interface WorkerSseEvent {
  type: string;
  data: {
    text?: string;
    stopReason?: string;
    iterations?: number;
    delta?: string;
    id?: string;
    name?: string;
    ok?: boolean;
    summary?: string;
    error?: unknown;
    input?: unknown;
    toolCalls?: Array<{ id: string; name: string; input: unknown }>;
    Message?: string;
    ExceptionType?: string;
    MessageDetail?: string;
    message?: unknown;
    [member: string]: unknown;
  };
}

/** Parse the worker's SSE output into `[{ type, data }]`. */
export async function readWorkerSse(response: Response): Promise<WorkerSseEvent[]> {
  const text = await response.text();
  const events: WorkerSseEvent[] = [];
  for (const chunk of text.split('\n\n')) {
    const eventLine = chunk.match(/^event: (.+)$/m);
    const dataLine = chunk.match(/^data: (.+)$/m);
    if (eventLine?.[1] && dataLine?.[1]) {
      events.push({
        type: eventLine[1],
        data: JSON.parse(dataLine[1]) as WorkerSseEvent['data'],
      });
    }
  }
  return events;
}

/** The first event of a type — throws when the stream never emitted it. */
export function eventOf(events: WorkerSseEvent[], type: string): WorkerSseEvent {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) {
    throw new Error(`no "${type}" event in [${events.map((e) => e.type).join(', ')}]`);
  }
  return event;
}

/** A minimal KVNamespace stand-in for the FILES_KV binding. */
export interface KvMock {
  get: Mock<(key: string) => Promise<string | null>>;
  put: Mock<(key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>>;
  delete: Mock<(key: string) => Promise<void>>;
}

/**
 * Build a KV mock (get resolves `storedValue`, put/delete resolve) and an Env
 * carrying it as FILES_KV.
 */
export function kvMock(storedValue: string | null = null): { kv: KvMock; env: Env } {
  const kv: KvMock = {
    get: vi.fn(async () => storedValue),
    put: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  return { kv, env: { ...ENV, FILES_KV: kv as unknown as KVNamespace } };
}
