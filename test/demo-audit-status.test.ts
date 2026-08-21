import { afterEach, describe, expect, it, vi } from 'vitest';

import { deliverDemoAuditStatusEvent } from '../src/lib/demo-audit-status';
import { ENV } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('demo audit status callback', () => {
  it('signs the exact immutable JSON body and required headers', async () => {
    const event = {
      version: 1 as const,
      eventIdentifier: 'event-1',
      auditIdentifier: 'audit-1',
      sessionIdentifier: 'session-1',
      storeOrigin: 'https://store.example',
      attemptNumber: 1,
      status: 'completed' as const,
      occurredAt: 1_777_000_000,
    };
    vi.spyOn(Date, 'now').mockReturnValue(1_777_000_123_000);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deliverDemoAuditStatusEvent(event, ENV)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(ENV.DEMO_AUDIT_STATUS_URL);
    const body = JSON.stringify(event);
    expect(init?.body).toBe(body);
    const headers = new Headers(init?.headers);
    const timestamp = '1777000123';
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-LimeSpot-Audit-Timestamp')).toBe(timestamp);
    expect(headers.get('X-LimeSpot-Audit-Signature')).toBe(
      `v1=${await expectedSignature(`${timestamp}.${body}`, ENV.DEMO_AUDIT_STATUS_SIGNING_SECRET ?? '')}`,
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps delivery retryable when the endpoint is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
    await expect(
      deliverDemoAuditStatusEvent(
        {
          version: 1,
          eventIdentifier: 'event-2',
          auditIdentifier: 'audit-2',
          sessionIdentifier: 'session-2',
          storeOrigin: 'https://store.example',
          attemptNumber: 2,
          status: 'failed',
          occurredAt: 1_777_000_001,
        },
        ENV,
      ),
    ).resolves.toBe(false);
  });
});

async function expectedSignature(value: string, secret: string): Promise<string> {
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
