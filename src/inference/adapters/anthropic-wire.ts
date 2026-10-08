/**
 * Anthropic API client — the ONE place the worker talks to the Anthropic API.
 *
 * Centralizes the API base (the `ANTHROPIC_API_BASE` config variable, see
 * src/config.ts), the `anthropic-version`, the beta flags, and the `x-api-key`
 * injection so no handler re-implements the fetch/header dance. Only this
 * module reads the `CLAUDE_API_KEY` secret (via `claudeApiKey`) — the key
 * never leaves the worker.
 *
 * Surface:
 *   - uploadFile / getFileMetadata / deleteFile → Files API (/v1/files)
 *   - createMessage                        → Messages API, non-streaming
 *   - streamMessage                        → Messages API, streaming (returns the raw Response)
 *   - countTokens                          → free pre-flight estimate
 *
 * Beta flags live here: Messages API calls send
 * `prompt-caching-2024-07-31,files-api-2025-04-14`. Files API calls send no
 * beta flag, because the Files API is generally available and the beta flag
 * hides each file's `expires_at`.
 *
 * Every client function is async, so a config failure (e.g. a missing
 * CLAUDE_API_KEY) surfaces as a rejected promise — one failure channel for
 * callers, whether the error is config or network.
 *
 * This module also owns the shared Anthropic Messages wire types (content
 * blocks, payloads) consumed by the handlers and the cache modules.
 */

import { fetchProvider } from './provider-fetch';
import { anthropicApiBase, claudeApiKey, type Env } from '../../config';
import type { CanonicalToolDefinition } from '../../lib/inference-types';

const ANTHROPIC_VERSION = '2023-06-01';
const MESSAGES_BETA = 'prompt-caching-2024-07-31,files-api-2025-04-14';

/** The shortest and longest `expires_in_seconds` the Files API accepts on an upload. */
export const FILE_LIFETIME_BOUNDS_SECONDS = { minimum: 3600, maximum: 7776000 } as const;

// ── Messages wire types ──────────────────────────────────────────────────────

/** A prompt-cache breakpoint (`ttl` present only on the extended 1h variant). */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

/**
 * The minimal structural view of any content block the cache modules touch:
 * a `type` discriminator plus the optional `cache_control` marker. Client
 * payloads (/messages proxies arbitrary bodies) are handled through this view.
 */
export interface CacheableBlock {
  type?: string;
  cache_control?: CacheControl;
  [member: string]: unknown;
}

export interface TextBlock {
  type: 'text';
  text: string;
  citations?: readonly Record<string, unknown>[];
  cache_control?: CacheControl;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string | undefined;
  name: string | undefined;
  input: unknown;
  cache_control?: CacheControl;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string | undefined;
  content: string | Array<TextBlock | FileBlock>;
  is_error: boolean;
  cache_control?: CacheControl;
}

/** An uploaded file referenced as a content block (`image` for `image/*` mimes). */
interface FileBlock {
  type: 'image' | 'document';
  source:
    | { type: 'file'; file_id: string }
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
    | { type: 'text'; media_type: string; data: string }
    | { type: 'content'; content: string | Array<TextBlock | FileBlock> };
  title?: string;
  context?: string;
  citations?: { enabled: boolean };
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | FileBlock;
export type AnyContentBlock = ContentBlock | CacheableBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | AnyContentBlock[];
}

/** Anthropic custom-tool schema (sent in the `tools` array). */
interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown> & {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: readonly string[];
  };
  [member: string]: unknown;
}

/** Serialize canonical tool definitions to Anthropic's `input_schema` wire shape. */
export function serializeToolDefinitions(
  definitions: readonly CanonicalToolDefinition[],
): ToolDefinition[] {
  return definitions.map((definition) => {
    if (definition.execution === 'provider') {
      if (definition.providerState.backend !== 'anthropic') {
        throw new Error(
          `Anthropic cannot serialize ${definition.providerState.backend} hosted tool state`,
        );
      }
      const value = definition.providerState.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Anthropic hosted tool state was malformed');
      }
      const wire = { ...(value as Record<string, unknown>) } as ToolDefinition;
      delete wire.cache_control;
      return wire;
    }
    return {
      ...(definition.kind ? { type: definition.kind } : {}),
      name: definition.name,
      description: definition.description,
      input_schema: {
        ...definition.inputSchema,
        ...(definition.inputSchema.properties
          ? { properties: { ...definition.inputSchema.properties } }
          : {}),
        ...(definition.inputSchema.required
          ? { required: [...definition.inputSchema.required] }
          : {}),
      },
      ...(definition.strict !== undefined ? { strict: definition.strict } : {}),
      ...(definition.allowedCallers ? { allowed_callers: [...definition.allowedCallers] } : {}),
      ...(definition.deferLoading !== undefined ? { defer_loading: definition.deferLoading } : {}),
      ...(definition.inputExamples
        ? { input_examples: definition.inputExamples.map((example) => ({ ...example })) }
        : {}),
      ...(definition.eagerInputStreaming !== undefined
        ? { eager_input_streaming: definition.eagerInputStreaming }
        : {}),
    };
  });
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/** A Messages API request body built by the worker (the /chat agent loop). */
export interface MessagesPayload {
  model: string;
  max_tokens: number;
  system?: TextBlock[];
  messages: MessageParam[];
  tools?: ToolDefinition[];
  tool_choice?:
    | { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean }
    | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };
  output_config?: {
    effort?: Effort;
    format?: {
      type: 'json_schema';
      schema: Readonly<Record<string, unknown>>;
    };
  };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
  service_tier?: string;
  stream?: boolean;
}

/**
 * A CLIENT-supplied Messages body (the /messages proxy forwards it as-is after
 * the additive levers). Members are structurally loose — the client owns the
 * payload; the worker only touches the members it manages.
 */
export interface ClientMessagesPayload {
  model?: string;
  system?: unknown;
  messages?: Array<{ role?: string; content?: string | CacheableBlock[] }>;
  tools?: unknown;
  output_config?: unknown;
  [member: string]: unknown;
}

/** Token-usage accounting as reported by the Messages API. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [member: string]: unknown;
}

// ── Effort capability gate ───────────────────────────────────────────────────

/**
 * Model-id PREFIXES whose models accept `output_config.effort`. The effort lever
 * is a real token-saving control, but sending it to a model without it returns a
 * 400 `invalid_request_error: "This model does not support the effort parameter."`.
 *
 * Prefixes, not exact ids: a new release inside a supporting family keeps the
 * lever instead of silently losing it. Each prefix is drawn at the boundary where
 * support actually starts, which is why Sonnet is listed by generation — Sonnet
 * 4.5 does not accept effort while 4.6 and 5 do — and Haiku is absent entirely.
 */
const EFFORT_SUPPORTED_MODEL_PREFIXES = [
  'claude-fable-',
  'claude-opus-',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
];

/**
 * Whether a model accepts the `output_config.effort` parameter. Callers use
 * this to gate attaching `output_config: { effort }` to a Messages payload, so
 * the effort lever is applied on supporting models and silently omitted (no
 * 400) on models that don't support it.
 */
export function supportsEffort(model: string): boolean {
  return EFFORT_SUPPORTED_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

/** Headers for Files API requests (no Content-Type — set by FormData / method). */
function filesHeaders(env: Env): Record<string, string> {
  return {
    'x-api-key': claudeApiKey(env),
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

/** Headers for Messages API requests (JSON body). */
function messagesHeaders(env: Env): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': claudeApiKey(env),
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': MESSAGES_BETA,
  };
}

/** Stable non-secret account scope for provider-file dedup/reference isolation. */
export async function fileAccountScope(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(claudeApiKey(env)));
  const prefix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `anthropic:${prefix}`;
}

/**
 * Upload a file to the Anthropic Files API. `formData` carries the `file` part
 * and the `expires_in_seconds` field that schedules its deletion.
 */
export async function uploadFile(
  formData: FormData,
  env: Env,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Anthropic', `${anthropicApiBase(env)}/v1/files`, {
    method: 'POST',
    headers: filesHeaders(env),
    body: formData,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Fetch a file's metadata from the Anthropic Files API (GET /v1/files/{id}).
 * Returns 404 once the file is deleted, and 200 otherwise — including for up to
 * 30 days after its `expires_at`, when its content is already gone. Used by the
 * dedup layer to verify a cached file_id before reuse so a stale id is never
 * vended downstream.
 */
export async function getFileMetadata(
  fileId: string,
  env: Env,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Anthropic', `${anthropicApiBase(env)}/v1/files/${fileId}`, {
    headers: filesHeaders(env),
    ...(signal ? { signal } : {}),
  });
}

/** Delete a file from the Anthropic Files API. */
export async function deleteFile(
  fileId: string,
  env: Env,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Anthropic', `${anthropicApiBase(env)}/v1/files/${fileId}`, {
    method: 'DELETE',
    headers: filesHeaders(env),
    ...(signal ? { signal } : {}),
  });
}

/** Call the Messages API non-streaming. Returns the raw Anthropic `Response`. */
export async function createMessage(
  payload: ClientMessagesPayload | MessagesPayload,
  env: Env,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Anthropic', `${anthropicApiBase(env)}/v1/messages`, {
    method: 'POST',
    headers: messagesHeaders(env),
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Pre-flight token count via the free `/v1/messages/count_tokens` endpoint.
 * Returns the exact model-specific `input_tokens` a prospective request would
 * cost. Pass the SAME model id you'll infer with. Only the count-accepted
 * fields are forwarded (model / system / messages / tools) — `max_tokens`,
 * `stream`, `output_config` and any other inference-only fields are stripped.
 * Returns the raw `Response` (consistent with createMessage); callers `.json()`.
 */
export async function countTokens(
  payload: ClientMessagesPayload | MessagesPayload,
  env: Env,
  signal?: AbortSignal,
): Promise<Response> {
  const body: Record<string, unknown> = { model: payload.model, messages: payload.messages };
  if (payload.system) body.system = payload.system;
  if (payload.tools) body.tools = payload.tools;
  return fetchProvider('Anthropic', `${anthropicApiBase(env)}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: messagesHeaders(env),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Call the Messages API with `stream: true`. Returns the raw `Response` so the
 * caller can read the SSE body itself.
 */
export async function streamMessage(
  payload: MessagesPayload,
  env: Env,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Anthropic', `${anthropicApiBase(env)}/v1/messages`, {
    method: 'POST',
    headers: messagesHeaders(env),
    body: JSON.stringify({ ...payload, stream: true }),
    ...(signal ? { signal } : {}),
  });
}
