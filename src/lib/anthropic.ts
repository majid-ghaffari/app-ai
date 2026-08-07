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
 *   - uploadFile / listFiles / getFileMetadata / deleteFile → Files API (/v1/files)
 *   - createMessage                        → Messages API, non-streaming
 *   - streamMessage                        → Messages API, streaming (returns the raw Response)
 *   - countTokens                          → free pre-flight estimate
 *
 * Beta flags live here: Files API calls send `files-api-2025-04-14`; Messages
 * API calls send `prompt-caching-2024-07-31,files-api-2025-04-14`.
 *
 * Every client function is async, so a config failure (e.g. a missing
 * CLAUDE_API_KEY) surfaces as a rejected promise — one failure channel for
 * callers, whether the error is config or network.
 *
 * This module also owns the shared Anthropic Messages wire types (content
 * blocks, payloads) consumed by the handlers and the cache modules.
 */

import { anthropicApiBase, claudeApiKey, type Env } from '../config';

const ANTHROPIC_VERSION = '2023-06-01';
const FILES_BETA = 'files-api-2025-04-14';
const MESSAGES_BETA = 'prompt-caching-2024-07-31,files-api-2025-04-14';

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
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string | undefined;
  name: string | undefined;
  input: unknown;
  cache_control?: CacheControl;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string | undefined;
  content: string;
  is_error: boolean;
  cache_control?: CacheControl;
}

/** An uploaded file referenced as a content block (`image` for `image/*` mimes). */
export interface FileBlock {
  type: 'image' | 'document';
  source: { type: 'file'; file_id: string };
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | FileBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/** Anthropic custom-tool schema (sent in the `tools` array). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/** A Messages API request body built by the worker (the /chat agent loop). */
export interface MessagesPayload {
  model: string;
  max_tokens: number;
  system?: TextBlock[];
  messages: MessageParam[];
  tools?: ToolDefinition[];
  output_config?: { effort: Effort };
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
}

// ── Effort capability gate ───────────────────────────────────────────────────

/**
 * Models that accept `output_config.effort`. The effort lever is a real
 * token-saving control, but it is only valid on this set — sending it to any
 * other model (e.g. Haiku 4.5, Sonnet 4.5) returns a 400
 * `invalid_request_error: "This model does not support the effort parameter."`.
 * Keep this list in lockstep with the Anthropic model catalog.
 */
const EFFORT_SUPPORTED_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

/**
 * Whether a model accepts the `output_config.effort` parameter. Callers use
 * this to gate attaching `output_config: { effort }` to a Messages payload, so
 * the effort lever is applied on supporting models and silently omitted (no
 * 400) on models that don't support it.
 */
export function supportsEffort(model: string): boolean {
  return EFFORT_SUPPORTED_MODELS.has(model);
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

/** Headers for Files API requests (no Content-Type — set by FormData / method). */
function filesHeaders(env: Env): Record<string, string> {
  return {
    'x-api-key': claudeApiKey(env),
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_BETA,
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

/** Upload a file to the Anthropic Files API (`formData` must contain `file`). */
export async function uploadFile(formData: FormData, env: Env): Promise<Response> {
  return fetch(`${anthropicApiBase(env)}/v1/files`, {
    method: 'POST',
    headers: filesHeaders(env),
    body: formData,
  });
}

/** List files in the Anthropic Files API. */
export async function listFiles(env: Env): Promise<Response> {
  return fetch(`${anthropicApiBase(env)}/v1/files`, { headers: filesHeaders(env) });
}

/**
 * Fetch a file's metadata from the Anthropic Files API (GET /v1/files/{id}).
 * Returns 200 when the file still exists, 404 when it has been deleted or is
 * otherwise gone. Used by the dedup layer to verify a cached file_id before
 * reuse so a stale id is never vended downstream.
 */
export async function getFileMetadata(fileId: string, env: Env): Promise<Response> {
  return fetch(`${anthropicApiBase(env)}/v1/files/${fileId}`, { headers: filesHeaders(env) });
}

/** Delete a file from the Anthropic Files API. */
export async function deleteFile(fileId: string, env: Env): Promise<Response> {
  return fetch(`${anthropicApiBase(env)}/v1/files/${fileId}`, {
    method: 'DELETE',
    headers: filesHeaders(env),
  });
}

/** Call the Messages API non-streaming. Returns the raw Anthropic `Response`. */
export async function createMessage(payload: ClientMessagesPayload, env: Env): Promise<Response> {
  return fetch(`${anthropicApiBase(env)}/v1/messages`, {
    method: 'POST',
    headers: messagesHeaders(env),
    body: JSON.stringify(payload),
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
export async function countTokens(payload: ClientMessagesPayload, env: Env): Promise<Response> {
  const body: Record<string, unknown> = { model: payload.model, messages: payload.messages };
  if (payload.system) body.system = payload.system;
  if (payload.tools) body.tools = payload.tools;
  return fetch(`${anthropicApiBase(env)}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: messagesHeaders(env),
    body: JSON.stringify(body),
  });
}

/**
 * Call the Messages API with `stream: true`. Returns the raw `Response` so the
 * caller can read the SSE body itself.
 */
export async function streamMessage(payload: MessagesPayload, env: Env): Promise<Response> {
  return fetch(`${anthropicApiBase(env)}/v1/messages`, {
    method: 'POST',
    headers: messagesHeaders(env),
    body: JSON.stringify({ ...payload, stream: true }),
  });
}
