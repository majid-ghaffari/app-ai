import { fetchProvider } from './provider-fetch';
import { moonshotApiBase, moonshotApiKey, type Env } from '../../config';

function jsonHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${moonshotApiKey(env)}`,
    'Content-Type': 'application/json',
  };
}

function fileHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${moonshotApiKey(env)}` };
}

export async function fileAccountScope(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(moonshotApiKey(env)),
  );
  const prefix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `moonshot:${prefix}`;
}

export function createChatCompletion(
  payload: Readonly<Record<string, unknown>>,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Moonshot', `${moonshotApiBase(env)}/v1/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders(env),
    body: JSON.stringify(payload),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function uploadFile(body: FormData, env: Env, abortSignal?: AbortSignal): Promise<Response> {
  return fetchProvider('Moonshot', `${moonshotApiBase(env)}/v1/files`, {
    method: 'POST',
    headers: fileHeaders(env),
    body,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function getFileMetadata(
  id: string,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Moonshot', `${moonshotApiBase(env)}/v1/files/${encodeURIComponent(id)}`, {
    headers: fileHeaders(env),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function deleteFile(id: string, env: Env, abortSignal?: AbortSignal): Promise<Response> {
  return fetchProvider('Moonshot', `${moonshotApiBase(env)}/v1/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: fileHeaders(env),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}
