/** OpenAI Responses/Files transport: the only module that reads OpenAI config. */

import { fetchProvider } from './provider-fetch';
import { openaiApiBase, openaiApiKey, type Env } from '../../config';

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${openaiApiKey(env)}`,
    'Content-Type': 'application/json',
  };
}

function filesHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${openaiApiKey(env)}` };
}

/** Stable non-secret account scope for file dedup/reference isolation. */
export async function fileAccountScope(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(openaiApiKey(env)));
  const prefix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `openai:${prefix}`;
}

export function createResponse(
  payload: Readonly<Record<string, unknown>>,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('OpenAI', `${openaiApiBase(env)}/v1/responses`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify(payload),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function uploadFile(body: FormData, env: Env, abortSignal?: AbortSignal): Promise<Response> {
  return fetchProvider('OpenAI', `${openaiApiBase(env)}/v1/files`, {
    method: 'POST',
    headers: filesHeaders(env),
    body,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function getFileMetadata(
  id: string,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('OpenAI', `${openaiApiBase(env)}/v1/files/${encodeURIComponent(id)}`, {
    headers: filesHeaders(env),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function deleteFile(id: string, env: Env, abortSignal?: AbortSignal): Promise<Response> {
  return fetchProvider('OpenAI', `${openaiApiBase(env)}/v1/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: filesHeaders(env),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}
