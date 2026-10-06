import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { RESERVATION_FINALIZE_GRACE_MILLISECONDS } from '../src/lib/audit-session-authority';
import { STORED_FILE_DELETE_TIMEOUT_MILLISECONDS } from '../src/lib/file-dedup';
import { UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS } from '../src/inference/deadline';
import type { Env } from '../src/config';
import {
  AUDIT_STATUS_CALLBACK_URL,
  anthropicFileRecord,
  anthropicMessage,
  kvMock,
  stubFetch,
} from './helpers';
import {
  STORE_ORIGIN,
  USABLE_PROPOSAL,
  activationToken,
  deliverStatusEvents,
  durableEnv,
  exchange,
  messageRequest,
  storageFor,
  uploadRequest,
} from './audit-harness';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const LEASE = UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS + RESERVATION_FINALIZE_GRACE_MILLISECONDS;
const SESSION_LIFETIME = 30 * DAY;
const KIMI_ROUTE = 'onboarding-visual=kimi-for-coding,onboarding-qc-gate=kimi-for-coding';

interface SessionRecordView {
  readonly sessionIdentifier: string;
  readonly expiresAt: number;
  readonly completedAttempts: number;
  readonly consumedActivationIdentifiers: readonly string[];
  readonly captureReleases?: readonly {
    readonly sessionIdentifier: string;
    readonly failures: number;
    readonly dueAt?: number;
  }[];
}

interface ProviderFiles {
  readonly uploads: string[];
  readonly deletes: string[];
  readonly live: Map<string, Record<string, unknown>>;
  readonly failingDeletes: Map<string, number>;
  readonly hangingDeletes: Set<string>;
  readonly abortedDeletes: string[];
  readonly hangingDeleteArrivals: Arrivals;
  readonly gatedUploads: Map<string, { arrived: () => void; gate: Promise<void> }>;
  expiresAt: () => string | null;
}

interface Arrivals {
  readonly arrive: () => void;
  readonly next: () => Promise<void>;
}

function arrivals(): Arrivals {
  let arrived = 0;
  let awaited = 0;
  const waiting: (() => void)[] = [];
  return {
    arrive: () => {
      arrived += 1;
      waiting.shift()?.();
    },
    next: () => {
      awaited += 1;
      return awaited <= arrived
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
}

async function timeOutHangingDeletes(arrived: Arrivals, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await arrived.next();
    await vi.advanceTimersByTimeAsync(STORED_FILE_DELETE_TIMEOUT_MILLISECONDS);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isoAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function providerFiles(): ProviderFiles {
  const files: ProviderFiles = {
    uploads: [],
    deletes: [],
    live: new Map(),
    failingDeletes: new Map(),
    hangingDeletes: new Set(),
    abortedDeletes: [],
    hangingDeleteArrivals: arrivals(),
    gatedUploads: new Map(),
    expiresAt: () => isoAt(Date.now() + SESSION_LIFETIME),
  };
  stubFetch().mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 204 });
    if (url.endsWith('/v1/files') && method === 'POST') {
      const body = init?.body;
      const filename = body instanceof FormData ? (body.get('file') as File | null)?.name : null;
      const gated = filename ? files.gatedUploads.get(filename) : undefined;
      if (gated) {
        gated.arrived();
        await gated.gate;
      }
      const id = `file-capture-${files.uploads.length + 1}`;
      const record = anthropicFileRecord(id, { expires_at: files.expiresAt() });
      files.uploads.push(id);
      files.live.set(id, record);
      return json(record);
    }
    const fileMatch = url.match(/\/v1\/files\/([^/?]+)$/);
    if (fileMatch?.[1]) {
      const id = decodeURIComponent(fileMatch[1]);
      if (method === 'DELETE') {
        files.deletes.push(id);
        if (files.hangingDeletes.has(id)) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => {
                files.abortedDeletes.push(id);
                reject(new DOMException('The delete was aborted', 'AbortError'));
              },
              { once: true },
            );
            files.hangingDeleteArrivals.arrive();
          });
        }
        const failures = files.failingDeletes.get(id) ?? 0;
        if (failures > 0) {
          files.failingDeletes.set(id, failures - 1);
          return json({ type: 'error', error: { type: 'api_error', message: 'unavailable' } }, 500);
        }
        if (!files.live.delete(id)) {
          return json({ type: 'error', error: { type: 'not_found_error', message: 'gone' } }, 404);
        }
        return json({ id, type: 'file_deleted' });
      }
      const record = files.live.get(id);
      return record
        ? json(record)
        : json({ type: 'error', error: { type: 'not_found_error', message: 'gone' } }, 404);
    }
    return json(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }]));
  });
  return files;
}

interface EvidenceBucket {
  readonly stored: Map<string, Uint8Array>;
  readonly bucket: R2Bucket;
  readonly hangingDeleteArrivals: Arrivals;
  hanging: boolean;
}

function evidenceBucket(): EvidenceBucket {
  const evidence: EvidenceBucket = {
    stored: new Map(),
    hangingDeleteArrivals: arrivals(),
    hanging: false,
    bucket: {
      put: vi.fn(async (key: string, bytes: Uint8Array) => {
        evidence.stored.set(key, bytes);
        return { key };
      }),
      head: vi.fn(async (key: string) => (evidence.stored.has(key) ? { key } : null)),
      get: vi.fn(async () => null),
      delete: vi.fn((key: string) => {
        if (evidence.hanging) {
          evidence.hangingDeleteArrivals.arrive();
          return new Promise<void>(() => undefined);
        }
        evidence.stored.delete(key);
        return Promise.resolve();
      }),
    } as unknown as R2Bucket,
  };
  return evidence;
}

function activationFor(env: Env, auditIdentifier: string, label: string): Promise<string> {
  return activationToken(
    env,
    `${auditIdentifier}-${label}`,
    { type: 'store-origin', storeOrigin: STORE_ORIGIN },
    'merchant@example.com',
    auditIdentifier,
  );
}

async function upload(env: Env, accessToken: string, name: string): Promise<string> {
  const response = await worker.fetch(uploadRequest(accessToken, name), env);
  expect(response.status, name).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

async function sessionRecord(env: Env, auditIdentifier: string): Promise<SessionRecordView> {
  const record = await storageFor(env, auditIdentifier).get<SessionRecordView>('session');
  if (!record) throw new Error(`No session record for ${auditIdentifier}`);
  return record;
}

function captureKeys(env: Env, auditIdentifier: string, sessionIdentifier = ''): string[] {
  return storageFor(env, auditIdentifier)
    .keys()
    .filter((key) => key.startsWith(`capture-file:${sessionIdentifier}`));
}

function deleteCount(files: ProviderFiles, id: string): number {
  return files.deletes.filter((deleted) => deleted === id).length;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a Grader session deletes its capture files when it ends', () => {
  it('deletes every upload and its dedup record a lease after the session expires, and nothing before', async () => {
    const { kv } = kvMock();
    const env = durableEnv({ FILES_KV: kv as unknown as KVNamespace });
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-expiry';
    const session = await exchange(env, await activationFor(env, auditIdentifier, 'only'));
    vi.setSystemTime(NOW + DAY);
    const tiles = [
      await upload(env, session.accessToken, 'home.webp'),
      await upload(env, session.accessToken, 'product.webp'),
    ];
    expect((await worker.fetch(messageRequest(session.accessToken, tiles), env)).status).toBe(200);

    const live = await sessionRecord(env, auditIdentifier);
    expect(live.captureReleases).toEqual([
      { sessionIdentifier: session.sessionIdentifier, failures: 0 },
    ]);
    expect(captureKeys(env, auditIdentifier, session.sessionIdentifier)).toHaveLength(2);
    expect((await kv.list({ prefix: '' })).keys).toHaveLength(2);

    const expiresAt = live.expiresAt * 1000;
    vi.setSystemTime(expiresAt + LEASE - 1_000);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual([]);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: session.sessionIdentifier, failures: 0, dueAt: expiresAt + LEASE },
    ]);

    vi.setSystemTime(expiresAt + LEASE);
    await deliverStatusEvents(env);
    expect(new Set(files.deletes)).toEqual(new Set(files.uploads));
    expect(files.live.size).toBe(0);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    expect((await kv.list({ prefix: '' })).keys).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('deletes a superseded session’s uploads a lease after the new activation and keeps the new session’s', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-superseded';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    await upload(env, first.accessToken, 'first.webp');
    vi.setSystemTime(NOW + 60_000);
    const second = await exchange(env, await activationFor(env, auditIdentifier, 'second'));
    await upload(env, second.accessToken, 'second.webp');
    const [firstFile, secondFile] = files.uploads;
    if (!firstFile || !secondFile) throw new Error('Both sessions must have uploaded a file');

    vi.setSystemTime(NOW + 60_000 + LEASE - 1_000);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual([]);

    vi.setSystemTime(NOW + 60_000 + LEASE);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual([firstFile]);
    expect(captureKeys(env, auditIdentifier, first.sessionIdentifier)).toEqual([]);
    expect(captureKeys(env, auditIdentifier, second.sessionIdentifier)).toHaveLength(1);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: second.sessionIdentifier, failures: 0 },
    ]);
    expect(files.live.has(secondFile)).toBe(true);
  });

  it('deletes the upload a superseded session finishes after the new activation replaced it', async () => {
    const env = durableEnv();
    const files = providerFiles();
    let arrived = (): void => {};
    let release = (): void => {};
    const uploadArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    files.gatedUploads.set('in-flight.webp', {
      arrived,
      gate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    const auditIdentifier = 'audit-capture-carried';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    const inFlight = worker.fetch(uploadRequest(first.accessToken, 'in-flight.webp'), env);
    await uploadArrived;
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));
    vi.setSystemTime(NOW + LEASE);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual([]);

    release();
    expect((await inFlight).status).toBe(200);
    expect(captureKeys(env, auditIdentifier, first.sessionIdentifier)).toHaveLength(1);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: first.sessionIdentifier, failures: 0, dueAt: NOW + 2 * LEASE },
    ]);

    vi.setSystemTime(NOW + 2 * LEASE);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual(files.uploads);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
  });

  it('retries a delete that fails, a minute and then two later, and counts a file its provider reports gone as deleted', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-retry';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    await upload(env, first.accessToken, 'failing.webp');
    await upload(env, first.accessToken, 'gone.webp');
    const [failing, gone] = files.uploads;
    if (!failing || !gone) throw new Error('Both uploads must have reached the provider');
    files.failingDeletes.set(failing, 2);
    files.live.delete(gone);
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));

    const firstPass = NOW + LEASE;
    vi.setSystemTime(firstPass);
    await deliverStatusEvents(env);
    expect(deleteCount(files, failing)).toBe(1);
    expect(deleteCount(files, gone)).toBe(1);
    expect(captureKeys(env, auditIdentifier, first.sessionIdentifier)).toHaveLength(1);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: first.sessionIdentifier, failures: 1, dueAt: firstPass + 60_000 },
    ]);

    vi.setSystemTime(firstPass + 60_000);
    await deliverStatusEvents(env);
    expect(deleteCount(files, failing)).toBe(2);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: first.sessionIdentifier, failures: 2, dueAt: firstPass + 180_000 },
    ]);

    vi.setSystemTime(firstPass + 179_000);
    await deliverStatusEvents(env);
    expect(deleteCount(files, failing)).toBe(2);

    vi.setSystemTime(firstPass + 180_000);
    await deliverStatusEvents(env);
    expect(deleteCount(files, failing)).toBe(3);
    expect(deleteCount(files, gone)).toBe(1);
    expect(files.live.size).toBe(0);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('abandons a delete that settles only when aborted, records its retry, and deletes the upload on a later alarm', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-hung-delete';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    await upload(env, first.accessToken, 'hung.webp');
    const [hung] = files.uploads;
    if (!hung) throw new Error('The upload must have reached the provider');
    files.hangingDeletes.add(hung);
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));

    vi.useFakeTimers({ now: NOW + LEASE });
    const alarm = deliverStatusEvents(env);
    await timeOutHangingDeletes(files.hangingDeleteArrivals, 1);
    await alarm;
    const retryAt = NOW + LEASE + STORED_FILE_DELETE_TIMEOUT_MILLISECONDS + 60_000;
    expect(files.abortedDeletes).toEqual([hung]);
    expect(captureKeys(env, auditIdentifier, first.sessionIdentifier)).toHaveLength(1);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: first.sessionIdentifier, failures: 1, dueAt: retryAt },
    ]);

    files.hangingDeletes.delete(hung);
    vi.setSystemTime(retryAt);
    await deliverStatusEvents(env);
    expect(deleteCount(files, hung)).toBe(2);
    expect(files.live.has(hung)).toBe(false);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('starts no further delete once a pass has spent its minute, so the alarm still records the retry', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-pass-budget';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    for (let index = 0; index < 8; index += 1) {
      await upload(env, first.accessToken, `hung-${index}.webp`);
    }
    for (const id of files.uploads) files.hangingDeletes.add(id);
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));

    vi.useFakeTimers({ now: NOW + LEASE });
    const alarm = deliverStatusEvents(env);
    await timeOutHangingDeletes(files.hangingDeleteArrivals, 6);
    await alarm;
    expect(files.deletes).toHaveLength(6);
    expect(files.abortedDeletes).toHaveLength(6);
    expect(captureKeys(env, auditIdentifier, first.sessionIdentifier)).toHaveLength(8);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: first.sessionIdentifier, failures: 1, dueAt: NOW + LEASE + 120_000 },
    ]);
  });

  it('makes no call for an upload its provider expiry has already deleted', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-expired-upload';
    const session = await exchange(env, await activationFor(env, auditIdentifier, 'only'));
    files.expiresAt = () => isoAt(NOW + SESSION_LIFETIME);
    await upload(env, session.accessToken, 'early.webp');

    const expiresAt = (await sessionRecord(env, auditIdentifier)).expiresAt * 1000;
    vi.setSystemTime(expiresAt + LEASE);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual([]);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('keeps an upload whose route moved to another provider until its provider expiry, never deleting through the new route', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-moved-route';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    files.expiresAt = () => isoAt(NOW + 20 * DAY);
    await upload(env, first.accessToken, 'moved.webp');
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));
    Object.assign(env, { MODEL_OVERRIDES: KIMI_ROUTE });

    vi.setSystemTime(NOW + LEASE);
    await deliverStatusEvents(env);
    expect(captureKeys(env, auditIdentifier, first.sessionIdentifier)).toHaveLength(1);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: first.sessionIdentifier, failures: 1, dueAt: NOW + LEASE + 60_000 },
    ]);

    vi.setSystemTime(NOW + 20 * DAY);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual([]);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('deletes more uploads than one alarm pass takes, over consecutive passes', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-many';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    for (let index = 0; index < 51; index += 1) {
      await upload(env, first.accessToken, `tile-${index}.webp`);
    }
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));

    vi.setSystemTime(NOW + LEASE);
    await deliverStatusEvents(env);
    expect(files.deletes).toHaveLength(51);
    expect(new Set(files.deletes)).toEqual(new Set(files.uploads));
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
  });

  it('deletes the upload a session kept under a discard key, and the key with it', async () => {
    const { kv } = kvMock();
    const env = durableEnv({ FILES_KV: kv as unknown as KVNamespace });
    const files = providerFiles();
    const auditIdentifier = 'audit-capture-discard';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    const discarded = 'file-capture-1';
    files.expiresAt = () => null;
    files.failingDeletes.set(discarded, 2);
    const refused = await worker.fetch(uploadRequest(first.accessToken, 'no-expiry.webp'), env);
    expect(refused.status).toBeGreaterThanOrEqual(500);
    expect(files.uploads).toEqual([discarded]);
    expect(deleteCount(files, discarded)).toBe(2);
    expect((await kv.list({ prefix: 'discard:' })).keys).toHaveLength(1);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));

    vi.setSystemTime(NOW + LEASE);
    await deliverStatusEvents(env);
    expect(deleteCount(files, discarded)).toBe(3);
    expect(files.live.has(discarded)).toBe(false);
    expect((await kv.list({ prefix: '' })).keys).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('abandons an R2 delete that never settles and ignores its abort, records the retry, and deletes the evidence on a later alarm', async () => {
    const evidence = evidenceBucket();
    const env = durableEnv({ MODEL_OVERRIDES: KIMI_ROUTE, INLINE_EVIDENCE_R2: evidence.bucket });
    providerFiles();
    const auditIdentifier = 'audit-capture-kimi-hung';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    await upload(env, first.accessToken, 'tile.webp');
    expect(evidence.stored.size).toBe(1);
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));
    evidence.hanging = true;

    vi.useFakeTimers({ now: NOW + LEASE });
    const alarm = deliverStatusEvents(env);
    await timeOutHangingDeletes(evidence.hangingDeleteArrivals, 1);
    await alarm;
    const retryAt = NOW + LEASE + STORED_FILE_DELETE_TIMEOUT_MILLISECONDS + 60_000;
    expect(evidence.stored.size).toBe(1);
    expect((await sessionRecord(env, auditIdentifier)).captureReleases).toEqual([
      { sessionIdentifier: first.sessionIdentifier, failures: 1, dueAt: retryAt },
    ]);

    evidence.hanging = false;
    vi.setSystemTime(retryAt);
    await deliverStatusEvents(env);
    expect(evidence.stored.size).toBe(0);
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('deletes Kimi evidence whose reference expired while the bucket still holds the object', async () => {
    const evidence = evidenceBucket();
    const env = durableEnv({ MODEL_OVERRIDES: KIMI_ROUTE, INLINE_EVIDENCE_R2: evidence.bucket });
    providerFiles();
    const auditIdentifier = 'audit-capture-kimi-expired-reference';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    await upload(env, first.accessToken, 'tile.webp');
    const [evidenceKey] = [...evidence.stored.keys()];
    const [captureKey] = captureKeys(env, auditIdentifier, first.sessionIdentifier);
    if (!evidenceKey || !captureKey) throw new Error('The upload must have stored its evidence');
    const capture = await storageFor(env, auditIdentifier).get<{ expiresAt: string }>(captureKey);
    const referenceExpiresAt = Date.parse(capture?.expiresAt ?? '');
    const bucketDeletesAt = NOW + 16 * DAY;
    const supersededAt = referenceExpiresAt + 60 * 60 * 1000;
    expect(referenceExpiresAt).toBeGreaterThan(NOW);
    expect(supersededAt + LEASE).toBeLessThan(bucketDeletesAt);

    vi.setSystemTime(supersededAt);
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));
    vi.setSystemTime(supersededAt + LEASE);
    await deliverStatusEvents(env);
    expect(evidence.stored.size).toBe(0);
    expect(vi.mocked(evidence.bucket.delete).mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([evidenceKey, `${evidenceKey}.hosted`]),
    );
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
    expect(await sessionRecord(env, auditIdentifier)).not.toHaveProperty('captureReleases');
  });

  it('deletes an upload’s encrypted R2 evidence when the audit route is configured onto Kimi', async () => {
    const { stored, bucket } = evidenceBucket();
    const env = durableEnv({ MODEL_OVERRIDES: KIMI_ROUTE, INLINE_EVIDENCE_R2: bucket });
    providerFiles();
    const auditIdentifier = 'audit-capture-kimi';
    const first = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    await upload(env, first.accessToken, 'tile.webp');
    expect(stored.size).toBe(1);
    const [evidenceKey] = [...stored.keys()];
    await exchange(env, await activationFor(env, auditIdentifier, 'second'));

    vi.setSystemTime(NOW + LEASE);
    await deliverStatusEvents(env);
    expect(stored.size).toBe(0);
    expect(vi.mocked(bucket.delete).mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([evidenceKey, `${evidenceKey}.hosted`]),
    );
    expect(captureKeys(env, auditIdentifier)).toEqual([]);
  });
});

describe('an audit record is deleted a session lifetime after its latest session expired', () => {
  it('deletes the record and every key of the audit, after which a new activation starts afresh', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-record-deleted';
    const session = await exchange(env, await activationFor(env, auditIdentifier, 'first'));
    files.expiresAt = () => isoAt(NOW + 400 * DAY);
    const tile = await upload(env, session.accessToken, 'home.webp');
    expect((await worker.fetch(messageRequest(session.accessToken, [tile]), env)).status).toBe(200);
    await storageFor(env, auditIdentifier).put(`chat-outcome:${crypto.randomUUID()}`, {});
    const record = await sessionRecord(env, auditIdentifier);
    expect(record.completedAttempts).toBe(1);
    const deletionAt = record.expiresAt * 1000 + SESSION_LIFETIME;

    vi.setSystemTime(deletionAt - 1_000);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual(files.uploads);
    expect(storageFor(env, auditIdentifier).keys().sort()).toEqual([
      expect.stringMatching(/^chat-outcome:/),
      'session',
    ]);

    vi.setSystemTime(deletionAt);
    await deliverStatusEvents(env);
    expect(storageFor(env, auditIdentifier).keys()).toEqual([]);

    await exchange(env, await activationFor(env, auditIdentifier, 'returning'));
    const fresh = await sessionRecord(env, auditIdentifier);
    expect(fresh.completedAttempts).toBe(0);
    expect(fresh.consumedActivationIdentifiers).toHaveLength(1);
  });

  it('keeps the record while an upload it still has to delete is undeleted, then deletes both', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-record-waits';
    const session = await exchange(env, await activationFor(env, auditIdentifier, 'only'));
    files.expiresAt = () => isoAt(NOW + 400 * DAY);
    await upload(env, session.accessToken, 'home.webp');
    const [stubborn] = files.uploads;
    if (!stubborn) throw new Error('The upload must have reached the provider');
    files.failingDeletes.set(stubborn, Number.POSITIVE_INFINITY);
    const deletionAt =
      (await sessionRecord(env, auditIdentifier)).expiresAt * 1000 + SESSION_LIFETIME;

    vi.setSystemTime(deletionAt);
    await deliverStatusEvents(env);
    expect(captureKeys(env, auditIdentifier)).toHaveLength(1);
    const waiting = await sessionRecord(env, auditIdentifier);
    const [release] = waiting.captureReleases ?? [];
    if (release?.dueAt === undefined) throw new Error('The failed delete must be scheduled again');

    files.failingDeletes.delete(stubborn);
    vi.setSystemTime(release.dueAt);
    await deliverStatusEvents(env);
    expect(files.live.has(stubborn)).toBe(false);
    expect(storageFor(env, auditIdentifier).keys()).toEqual([]);
  });

  it('deletes the uploads a rolled-back worker left untracked before it deletes the record', async () => {
    const env = durableEnv();
    const files = providerFiles();
    const auditIdentifier = 'audit-record-untracked';
    const session = await exchange(env, await activationFor(env, auditIdentifier, 'only'));
    files.expiresAt = () => isoAt(NOW + 400 * DAY);
    await upload(env, session.accessToken, 'home.webp');
    const storage = storageFor(env, auditIdentifier);
    const { captureReleases: _untracked, ...rolledBack } = await sessionRecord(
      env,
      auditIdentifier,
    );
    await storage.put('session', rolledBack);
    const expiresAt = rolledBack.expiresAt * 1000;

    vi.setSystemTime(expiresAt + LEASE);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual([]);

    vi.setSystemTime(expiresAt + SESSION_LIFETIME);
    await deliverStatusEvents(env);
    expect(storage.keys()).toContain('session');
    expect(files.deletes).toEqual([]);

    vi.setSystemTime(expiresAt + SESSION_LIFETIME + LEASE);
    await deliverStatusEvents(env);
    expect(files.deletes).toEqual(files.uploads);
    expect(storage.keys()).toEqual([]);
  });
});
