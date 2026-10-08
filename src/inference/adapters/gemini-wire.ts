/** Gemini generateContent/Files transport: the only module that reads Gemini config. */

import { fetchProvider } from './provider-fetch';
import { geminiApiBase, geminiApiKey, type Env } from '../../config';

/**
 * Gemini authenticates with its own header rather than a bearer token; the API
 * version is a path segment inside `GEMINI_API_BASE`, so no version header
 * exists. Contract facts, not deploy-time tunables.
 */
const API_KEY_HEADER = 'x-goog-api-key';

/** Server-Sent Events selector for `:streamGenerateContent`. */
const STREAM_QUERY = 'alt=sse';

/**
 * The Files upload endpoint sits under an `/upload` prefix placed AHEAD of the
 * version segment carried by `GEMINI_API_BASE`, so the upload origin is derived
 * from the configured base rather than configured a second time.
 */
const UPLOAD_PATH_PREFIX = '/upload';

/** Resumable-upload protocol headers (the only documented upload protocol). */
const UPLOAD_PROTOCOL_HEADER = 'X-Goog-Upload-Protocol';
const UPLOAD_COMMAND_HEADER = 'X-Goog-Upload-Command';
const UPLOAD_OFFSET_HEADER = 'X-Goog-Upload-Offset';
const UPLOAD_CONTENT_LENGTH_HEADER = 'X-Goog-Upload-Header-Content-Length';
const UPLOAD_CONTENT_TYPE_HEADER = 'X-Goog-Upload-Header-Content-Type';

/** Response header carrying the one-shot upload endpoint for the finalize call. */
export const UPLOAD_URL_HEADER = 'X-Goog-Upload-URL';

function jsonHeaders(env: Env): Record<string, string> {
  return { [API_KEY_HEADER]: geminiApiKey(env), 'Content-Type': 'application/json' };
}

function readHeaders(env: Env): Record<string, string> {
  return { [API_KEY_HEADER]: geminiApiKey(env) };
}

/** Stable non-secret account scope for file dedup/reference isolation. */
export async function fileAccountScope(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(geminiApiKey(env)));
  const prefix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `gemini:${prefix}`;
}

/**
 * The absolute `fileData.fileUri` for one stored file resource name. Gemini
 * accepts the FULL resource URI here, never the bare `files/{id}` name.
 */
export function fileUri(name: string, env: Env): string {
  return `${geminiApiBase(env)}/${name}`;
}

export function generateContent(
  model: string,
  payload: Readonly<Record<string, unknown>>,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider(
    'Gemini',
    `${geminiApiBase(env)}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: jsonHeaders(env),
      body: JSON.stringify(payload),
      ...(abortSignal ? { signal: abortSignal } : {}),
    },
  );
}

export function streamGenerateContent(
  model: string,
  payload: Readonly<Record<string, unknown>>,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider(
    'Gemini',
    `${geminiApiBase(env)}/models/${encodeURIComponent(model)}:streamGenerateContent?${STREAM_QUERY}`,
    {
      method: 'POST',
      headers: jsonHeaders(env),
      body: JSON.stringify(payload),
      ...(abortSignal ? { signal: abortSignal } : {}),
    },
  );
}

export function countTokens(
  model: string,
  payload: Readonly<Record<string, unknown>>,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider(
    'Gemini',
    `${geminiApiBase(env)}/models/${encodeURIComponent(model)}:countTokens`,
    {
      method: 'POST',
      headers: jsonHeaders(env),
      body: JSON.stringify(payload),
      ...(abortSignal ? { signal: abortSignal } : {}),
    },
  );
}

/**
 * Step one of the documented resumable upload: register the file's size and
 * media type and receive the one-shot upload endpoint in a response header.
 */
export function startResumableUpload(
  displayName: string,
  byteLength: number,
  mediaType: string,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Gemini', `${uploadBase(env)}/files`, {
    method: 'POST',
    headers: {
      ...jsonHeaders(env),
      [UPLOAD_PROTOCOL_HEADER]: 'resumable',
      [UPLOAD_COMMAND_HEADER]: 'start',
      [UPLOAD_CONTENT_LENGTH_HEADER]: String(byteLength),
      [UPLOAD_CONTENT_TYPE_HEADER]: mediaType,
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

/**
 * A provider-returned upload endpoint, validated before it is used as a
 * destination: it arrives in a response header and stays on the configured
 * Gemini origin or the upload is refused.
 */
export function uploadEndpoint(uploadUrl: string, env: Env): string {
  let target: URL;
  try {
    target = new URL(uploadUrl);
  } catch {
    throw new Error('Gemini upload endpoint was not an absolute URL');
  }
  if (target.origin !== new URL(geminiApiBase(env)).origin) {
    throw new Error('Gemini upload endpoint left the configured Gemini origin');
  }
  return target.toString();
}

/**
 * Step two: send the bytes to the validated endpoint and finalize in the same
 * request. The documented finalize call carries no API-key header — the
 * returned endpoint is itself the authorization — so none is sent.
 */
export function finishResumableUpload(
  uploadEndpointUrl: string,
  bytes: Uint8Array,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Gemini', uploadEndpointUrl, {
    method: 'POST',
    headers: {
      [UPLOAD_OFFSET_HEADER]: '0',
      [UPLOAD_COMMAND_HEADER]: 'upload, finalize',
    },
    body: bytes,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function getFile(name: string, env: Env, abortSignal?: AbortSignal): Promise<Response> {
  return fetchProvider('Gemini', `${geminiApiBase(env)}/${encodeFileName(name)}`, {
    headers: readHeaders(env),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function deleteFile(name: string, env: Env, abortSignal?: AbortSignal): Promise<Response> {
  return fetchProvider('Gemini', `${geminiApiBase(env)}/${encodeFileName(name)}`, {
    method: 'DELETE',
    headers: readHeaders(env),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

/** The configured origin plus version path, prefixed with the upload segment. */
function uploadBase(env: Env): string {
  const base = new URL(geminiApiBase(env));
  base.pathname = `${UPLOAD_PATH_PREFIX}${base.pathname}`;
  return base.toString().replace(/\/$/, '');
}

/** Encode a `files/{id}` resource name without escaping its path separator. */
function encodeFileName(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}
