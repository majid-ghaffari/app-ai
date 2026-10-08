import { fetchProvider } from './provider-fetch';
import { kimiApiBase, kimiApiKey, type Env } from '../../config';

function jsonHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${kimiApiKey(env)}`,
    'Content-Type': 'application/json',
  };
}

export async function fileAccountScope(env: Env): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(kimiApiKey(env)));
  const prefix = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `kimi:${prefix}`;
}

export function createChatCompletion(
  payload: Readonly<Record<string, unknown>>,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Kimi Code', `${kimiApiBase(env)}/v1/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders(env),
    body: JSON.stringify(payload),
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}

export function uploadImage(
  body: FormData,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<Response> {
  return fetchProvider('Kimi Code', `${kimiApiBase(env)}/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kimiApiKey(env)}` },
    body,
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
}
