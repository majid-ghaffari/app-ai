/** Authenticated app-ai to website audit-attempt status callbacks. */

import { demoAuditStatusSigningSecret, demoAuditStatusUrl, type Env } from '../config';

const CALLBACK_TIMEOUT_MILLISECONDS = 5_000;

export type DemoAuditStatus = 'started' | 'completed' | 'failed';

export interface DemoAuditStatusEvent {
  readonly version: 1;
  readonly eventIdentifier: string;
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  readonly attemptNumber: number;
  readonly status: DemoAuditStatus;
  readonly occurredAt: number;
}

/** Deliver one immutable event. Callers retain it for retry unless this returns true. */
export async function deliverDemoAuditStatusEvent(
  event: DemoAuditStatusEvent,
  env: Env,
): Promise<boolean> {
  try {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(`${timestamp}.${body}`, demoAuditStatusSigningSecret(env));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MILLISECONDS);
    try {
      const response = await fetch(demoAuditStatusUrl(env), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LimeSpot-Audit-Timestamp': timestamp,
          'X-LimeSpot-Audit-Signature': `v1=${signature}`,
        },
        body,
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
  );
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
