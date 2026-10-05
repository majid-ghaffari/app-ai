/**
 * Shared test utilities: the complete typed `Env` fixture (every required
 * config variable present — src/config.ts throws on a missing one), typed
 * fetch-mock accessors, and the worker-SSE parser.
 */

import { vi, type Mock } from 'vitest';
import * as anthropic from '../src/inference/adapters/anthropic-wire';
import { fileTenantScope, mintOpaqueFileReference } from '../src/inference/file-references';
import type { Env } from '../src/config';

const auditSessionFetch = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
const auditSessionNamespace = {
  idFromName: vi.fn().mockReturnValue({}),
  get: vi.fn().mockReturnValue({ fetch: auditSessionFetch }),
} as unknown as DurableObjectNamespace;

/** A complete Env fixture — all required config variables set. */
export const ENV: Env = {
  ENVIRONMENT: 'test',
  AI_CHANNEL: 'prod',
  CLAUDE_API_KEY: 'test-key',
  TOKEN_ENCRYPTION_SECRET: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  PERSONALIZER_INTEGRATION_BRIDGE_TOKEN: 'svc-token-256bit-opaque',
  PERSONALIZER_API_URL: 'https://brain.test',
  ANTHROPIC_API_BASE: 'https://api.anthropic.com',
  OPENAI_API_BASE: 'https://api.openai.com',
  OPENAI_API_KEY: 'test-openai-key',
  MOONSHOT_API_BASE: 'https://api.moonshot.ai',
  MOONSHOT_API_KEY: 'test-moonshot-key',
  KIMI_API_BASE: 'https://api.kimi.com/coding',
  KIMI_EVIDENCE_MAX_BYTES: '8000000',
  KIMI_EVIDENCE_MAX_TOTAL_BYTES: '64000000',
  KIMI_EVIDENCE_MAX_TEXT_BYTES: '16000000',
  KIMI_API_KEY: 'test-kimi-key',
  GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
  GEMINI_API_KEY: 'test-gemini-key',
  LOG_TARGETS_TRACE: 'ignore',
  LOG_TARGETS_DEBUG: 'ignore',
  LOG_TARGETS_INFO: 'ignore',
  LOG_TARGETS_WARN: 'ignore',
  LOG_TARGETS_ERROR: 'ignore',
  LOG_TARGETS_FATAL: 'ignore',
  LOG_SEQ_INGEST_URL: 'https://seq.test/ingest/clef',
  CREDENTIALED_ORIGINS:
    'https://local-app.limespot.com,http://localhost:4200,http://localhost:3000',
  MASTER_SUBSCRIBER_ID: '1',
  MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS: '15000',
  MODEL_FAST: 'claude-haiku-4-5',
  MODEL_BALANCED: 'claude-sonnet-5',
  MODEL_FRONTIER: 'claude-opus-4-8',
  MODEL_OVERRIDES: 'free-render-verification=@cf/qwen/qwen3.8-27b',
  FREE_VISUAL_VERIFY_ENABLED: 'true',
  FREE_VISUAL_VERIFY_DAILY_LIMIT: '8',
  FREE_VISUAL_VERIFY_ACCEPTANCE_RESERVE: '4',
  INFERENCE_QUOTA_INTERNAL_ORIGIN: 'https://inference-quota.internal',
  AI: { run: vi.fn() },
  AUDIT_SESSIONS: auditSessionNamespace,
  AUDIT_ACTIVATION_SIGNING_SECRET: 'test-activation-signing-secret-with-32-bytes',
  AUDIT_SESSION_SIGNING_SECRET: 'test-session-signing-secret-distinct-32-bytes',
  AUDIT_STATUS_SIGNING_SECRET: 'test-audit-status-signing-secret-distinct-32-bytes',
  AUDIT_STATUS_ORIGINS: 'https://limespot.test',
  AUDIT_SESSION_TTL_SECONDS: '2592000',
  AUDIT_MAX_RUNS: '4',
  AUDIT_RUN_HEADROOM: '2',
  AUDIT_MAX_UPLOAD_BYTES: '8000000',
  AUDIT_MAX_MESSAGE_BYTES: '1000000',
  GRADER_CHAT_ENABLED: 'true',
  GRADER_CHAT_MESSAGES_PER_AUDIT: '25',
  GRADER_CHAT_MESSAGES_PER_VISITOR_PER_DAY: '50',
  GRADER_CHAT_MESSAGES_PER_DAY: '10000',
  GRADER_CHAT_MAX_INPUT_CHARACTERS: '500',
  GRADER_CHAT_MAX_REPLY_TOKENS: '600',
  GRADER_CHAT_EFFORT: 'low',
  GRADER_CHAT_BOOKLET_VERSION: '3',
  GRADER_CHAT_ALERT_EVERY: '500',
  GRADER_RUNS_VALID_FROM: '2026-01-01T00:00:00Z',
  GRADER_EXTENSION_BUILT_AFTER: '2026-01-01T00:00:00Z',
};

export const CORS = { 'Access-Control-Allow-Origin': '*' };

/** A callback path under the one origin `ENV.AUDIT_STATUS_ORIGINS` allowlists. */
export const AUDIT_STATUS_CALLBACK_URL = 'https://limespot.test/studio/activate/api/status';

/** Brain AI-tool capabilities used by tests that intentionally exercise the full data-tool set. */
export const AVAILABLE_AI_TOOLS = [
  'get_store_analytics',
  'list_segments',
  'list_campaigns',
  'get_store_config',
] as const;

/** Complete Anthropic success envelope; use overrides for count-token dual fixtures. */
export function anthropicMessage(
  content: readonly Record<string, unknown>[] = [],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: ENV.MODEL_BALANCED,
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides,
  };
}

/** Complete Anthropic message_start envelope for strict streaming fixtures. */
export function anthropicMessageStart(
  usage: Readonly<Record<string, unknown>> = { input_tokens: 1, output_tokens: 0 },
): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: 'msg_stream_test',
      type: 'message',
      role: 'assistant',
      model: ENV.MODEL_BALANCED,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { output_tokens: 0, ...usage },
    },
  };
}

export type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;

/** An Anthropic `expires_at` far enough ahead that dedup reuses the file at any test clock. */
export const DISTANT_FILE_EXPIRY = '2099-01-01T00:00:00.000Z';

/** Complete Anthropic Files API record; the adapter validates every member. */
export function anthropicFileRecord(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    type: 'file',
    filename: `${id}.webp`,
    mime_type: 'image/webp',
    size_bytes: 32,
    created_at: '2026-01-01T00:00:00Z',
    downloadable: false,
    expires_at: DISTANT_FILE_EXPIRY,
    ...overrides,
  };
}

/**
 * Create a typed fetch mock and install it as the global `fetch`. The mock plays the provider:
 * a test answers with the Anthropic message it wants the model to return, and when the request
 * asked for `stream: true` the provider delivers that message as the Messages API event stream,
 * exactly as the real API renders one answer in the transport the request chose.
 */
export function stubFetch(): FetchMock {
  const fetchMock: FetchMock = vi.fn();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
    inRequestedTransport(await fetchMock(input, init), init),
  );
  return fetchMock;
}

async function inRequestedTransport(
  response: Response | undefined,
  init: RequestInit | undefined,
): Promise<Response | undefined> {
  if (!response || response.bodyUsed || response.status !== 200 || !requestsStream(init)) {
    return response;
  }
  if (response.headers.get('Content-Type')?.includes('text/event-stream')) return response;
  let message: unknown;
  try {
    message = JSON.parse(await response.clone().text()) as unknown;
  } catch {
    return response;
  }
  if (!isRecord(message) || message.type !== 'message') return response;
  return anthropicStreamResponse(message);
}

function requestsStream(init: RequestInit | undefined): boolean {
  if (typeof init?.body !== 'string') return false;
  try {
    const body = JSON.parse(init.body) as unknown;
    return isRecord(body) && body.stream === true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function anthropicStreamResponse(message: Readonly<Record<string, unknown>>): Response {
  const { stop_details: _terminalOnly, ...started } = message;
  const usage = isRecord(message.usage) ? message.usage : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        ...started,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 0 },
      },
    },
  ];
  content.forEach((raw: unknown, index) => {
    const block = isRecord(raw) ? raw : {};
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
      for (const citation of Array.isArray(block.citations) ? block.citations : []) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'citations_delta', citation },
        });
      }
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    } else if (block.type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: message.stop_sequence ?? null,
      ...(message.stop_details === undefined ? {} : { stop_details: message.stop_details }),
    },
    usage: { output_tokens: usage.output_tokens },
  });
  events.push({ type: 'message_stop' });
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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
  list: Mock<
    (options: {
      prefix: string;
      limit?: number;
      cursor?: string;
    }) => Promise<
      | { keys: { name: string }[]; list_complete: true }
      | { keys: { name: string }[]; list_complete: false; cursor: string }
    >
  >;
}

/**
 * Build a KV mock (get resolves `storedValue`, put/delete/list act on the keys it stores) and an
 * Env carrying it as FILES_KV.
 */
export function kvMock(storedValue: string | null = null): { kv: KvMock; env: Env } {
  const stored = new Map<string, string>();
  const kv: KvMock = {
    get: vi.fn(async (key) => stored.get(key) ?? storedValue),
    put: vi.fn(async (key, value) => {
      stored.set(key, value);
    }),
    delete: vi.fn(async (key) => {
      stored.delete(key);
    }),
    list: vi.fn(async ({ prefix, limit = 1000, cursor }) => {
      const matching = [...stored.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor === undefined ? 0 : Number(cursor);
      const keys = matching.slice(start, start + limit).map((name) => ({ name }));
      return start + limit < matching.length
        ? { keys, list_complete: false as const, cursor: String(start + limit) }
        : { keys, list_complete: true as const };
    }),
  };
  return { kv, env: { ...ENV, FILES_KV: kv as unknown as KVNamespace } };
}

/** Build metadata-only opaque references for routed file-input integration tests. */
export async function opaqueFileEnv(
  files: readonly { upstreamFileId: string; mediaType: string | null }[],
  compatibleGroups: readonly [string, ...string[]],
  contextId = 'ctx',
  baseEnv: Env = ENV,
): Promise<{ env: Env; ids: string[] }> {
  const accountScope = await anthropic.fileAccountScope(baseEnv);
  const tenantScope = await fileTenantScope(contextId, baseEnv);
  if (!tenantScope) throw new Error('test tenant scope missing');
  const ids = await Promise.all(
    files.map(async (file, index) => {
      const opaque = await mintOpaqueFileReference(
        {
          provider: 'anthropic',
          accountScope,
          tenantScope,
          filePolicy: 'anthropic-provider-files',
          compatibleGroups,
          upstreamFileId: file.upstreamFileId,
          contentHash: `test:${index}`,
          mediaType: file.mediaType,
          sizeBytes: 1,
          expiresAt: null,
        },
        baseEnv,
      );
      return opaque.id;
    }),
  );
  return { env: baseEnv, ids };
}

/** How often a request was cloned and how often a body-reading method consumed it. */
export interface BodyReads {
  clones: number;
  reads: number;
}

/** A request that counts its clones and body reads; a stream read through `body` is not counted. */
export function countedRequest(
  url: string,
  init: RequestInit,
): { readonly request: Request; readonly counts: BodyReads } {
  const counts: BodyReads = { clones: 0, reads: 0 };
  class CountedRequest extends Request {
    override clone(): Request {
      counts.clones += 1;
      return super.clone();
    }
    override json<T>(): Promise<T> {
      counts.reads += 1;
      return super.json<T>();
    }
    override text(): Promise<string> {
      counts.reads += 1;
      return super.text();
    }
    override arrayBuffer(): Promise<ArrayBuffer> {
      counts.reads += 1;
      return super.arrayBuffer();
    }
    override formData(): Promise<FormData> {
      counts.reads += 1;
      return super.formData();
    }
    override blob(): Promise<Blob> {
      counts.reads += 1;
      return super.blob();
    }
  }
  return { request: new CountedRequest(url, init), counts };
}

/** How many times a `JSON.parse` spy parsed exactly `text`. */
export function parsesOf(parse: { mock: { calls: unknown[][] } }, text: string): number {
  return parse.mock.calls.filter(([parsed]) => parsed === text).length;
}
