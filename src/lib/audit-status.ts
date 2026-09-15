/** Authenticated app-ai to website audit-attempt status callbacks. */

import { auditStatusSigningSecret, type Env } from '../config';

const CALLBACK_TIMEOUT_MILLISECONDS = 5_000;

export type AuditStatus = 'started' | 'completed' | 'failed';

export interface AuditStatusEvent {
  readonly version: 1;
  readonly eventIdentifier: string;
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  readonly attemptNumber: number;
  readonly status: AuditStatus;
  readonly occurredAt: number;
}

/**
 * Deliver one immutable event to the destination the audit's activation signed
 * and this deployment allowlisted. Callers retain it for retry unless this
 * returns true.
 */
export async function deliverAuditStatusEvent(
  event: AuditStatusEvent,
  statusCallbackUrl: string,
  env: Env,
): Promise<boolean> {
  try {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(`${timestamp}.${body}`, auditStatusSigningSecret(env));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MILLISECONDS);
    try {
      const response = await fetch(statusCallbackUrl, {
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
