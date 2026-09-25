/** Authenticated app-ai to website audit-attempt status callbacks. */

import { auditStatusSigningSecret, type Env } from '../config';

const CALLBACK_TIMEOUT_MILLISECONDS = 5_000;

export type AuditStatus = 'started' | 'completed' | 'failed';

/**
 * What one delivery attempt established: the website recorded the event, the website refused it for
 * good (so resending the same event cannot succeed), or it may succeed on a later attempt.
 */
export type AuditStatusDelivery = 'delivered' | 'rejected' | 'retry';

const RETRYABLE_CLIENT_STATUSES = new Set([401, 408, 425, 429]);

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
 * and this deployment allowlisted. Callers retain it for retry only while this
 * returns `retry`.
 */
export async function deliverAuditStatusEvent(
  event: AuditStatusEvent,
  statusCallbackUrl: string,
  env: Env,
): Promise<AuditStatusDelivery> {
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
      if (response.ok) return 'delivered';
      return response.status >= 400 &&
        response.status < 500 &&
        !RETRYABLE_CLIENT_STATUSES.has(response.status)
        ? 'rejected'
        : 'retry';
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return 'retry';
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
