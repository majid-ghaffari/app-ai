import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import {
  AuditSessionAuthority,
  RESERVATION_FINALIZE_GRACE_MILLISECONDS,
} from '../src/lib/audit-session-authority';
import { PLANNED_AUDIT_RUN } from '../src/lib/audit-plan';
import { UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS } from '../src/inference/deadline';
import { ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import type { Env } from '../src/config';
import {
  anthropicFileRecord,
  anthropicMessage,
  AUDIT_STATUS_CALLBACK_URL,
  ENV,
  stubFetch,
  fetchedUrls,
  fetchCall,
  sentBody,
} from './helpers';

const STORE_ORIGIN = 'https://lsdev.myshopline.com';
const MAX_STATUS_CALLBACK_URL_LENGTH = 2048;
const PAST_ACTIVATION_CEILING_MILLISECONDS = 1_000_000;

interface NamedDurableObjectId {
  readonly name: string;
}

const AUTHORITIES_BY_ENV = new WeakMap<Env, Map<string, AuditSessionAuthority>>();
const AUTHORITY_GATES = new WeakMap<Env, (path: string) => Promise<void>>();
const STORAGES_BY_ENV = new WeakMap<Env, Map<string, MemoryDurableStorage>>();

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  private transactionTail: Promise<void> = Promise.resolve();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }

  private alarmAt: number | null = null;

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
  }

  takeDueAlarm(): boolean {
    if (this.alarmAt === null || this.alarmAt > Date.now()) return false;
    this.alarmAt = null;
    return true;
  }

  async transaction<T>(callback: (storage: MemoryDurableStorage) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release = (): void => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
}

function durableEnv(overrides: Partial<Env> = {}): Env {
  const authorities = new Map<string, AuditSessionAuthority>();
  const storages = new Map<string, MemoryDurableStorage>();
  const resolveEnv = (): Env => env;
  const namespace = {
    idFromName(name: string): DurableObjectId {
      return { name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const name = (id as unknown as NamedDurableObjectId).name;
      let authority = authorities.get(name);
      if (!authority) {
        const storage = new MemoryDurableStorage();
        const state = { storage } as unknown as DurableObjectState;
        authority = new AuditSessionAuthority(state, resolveEnv());
        authorities.set(name, authority);
        storages.set(name, storage);
      }
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          await AUTHORITY_GATES.get(resolveEnv())?.(new URL(request.url).pathname);
          return authority.fetch(request);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const env: Env = { ...ENV, ...overrides, AUDIT_SESSIONS: namespace };
  AUTHORITIES_BY_ENV.set(env, authorities);
  STORAGES_BY_ENV.set(env, storages);
  return env;
}

function authorityFor(env: Env, auditIdentifier: string): AuditSessionAuthority {
  const authority = AUTHORITIES_BY_ENV.get(env)?.get(auditIdentifier);
  if (!authority) throw new Error(`Missing test authority for ${auditIdentifier}`);
  return authority;
}

function storageFor(env: Env, auditIdentifier: string): MemoryDurableStorage {
  const storage = STORAGES_BY_ENV.get(env)?.get(auditIdentifier);
  if (!storage) throw new Error(`Missing test storage for ${auditIdentifier}`);
  return storage;
}

async function deliverStatusEvents(env: Env): Promise<void> {
  for (const [auditIdentifier, storage] of STORAGES_BY_ENV.get(env) ?? []) {
    while (storage.takeDueAlarm()) await authorityFor(env, auditIdentifier).alarm();
  }
}

async function activationToken(
  env: Env,
  tokenIdentifier = crypto.randomUUID(),
  entitlement: object = { type: 'store-origin', storeOrigin: STORE_ORIGIN },
  email = 'merchant@example.com',
  auditIdentifier = `audit-${tokenIdentifier}`,
  attemptLimit?: 2 | null,
  statusCallbackUrl: string = AUDIT_STATUS_CALLBACK_URL,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const staff = (entitlement as { type?: unknown }).type === 'limespot-staff-multi-store';
  return signWebsiteActivation(
    {
      version: 1,
      kind: 'activation',
      issuer: 'limespot-website',
      audience: 'app-ai',
      tokenIdentifier,
      auditIdentifier,
      attemptLimit: attemptLimit === undefined ? (staff ? null : 2) : attemptLimit,
      email,
      emailVerified: true,
      entitlement,
      statusCallbackUrl,
      issuedAt: now,
      expiresAt: now + 600,
    },
    env,
  );
}

async function signWebsiteActivation(claims: object, env: Env): Promise<string> {
  const secret = env.AUDIT_ACTIVATION_SIGNING_SECRET;
  if (!secret) throw new Error('test activation signing secret is missing');
  const encode = (value: object): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  };
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(unsigned)),
  );
  let signatureBinary = '';
  for (const byte of signature) signatureBinary += String.fromCharCode(byte);
  const encodedSignature = btoa(signatureBinary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `${unsigned}.${encodedSignature}`;
}

async function exchange(
  env: Env,
  token?: string,
): Promise<{ accessToken: string; sessionIdentifier: string }> {
  const resolvedToken = token ?? (await activationToken(env));
  const response = await worker.fetch(
    new Request('https://app-ai.test/audit/session/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.limespot.com' },
      body: JSON.stringify({
        activationToken: resolvedToken,
        storeUrl: `${STORE_ORIGIN}/products/example?campaign=grader`,
      }),
    }),
    env,
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<{ accessToken: string; sessionIdentifier: string }>;
}

function auditHeaders(
  accessToken: string,
  prompt?: string,
  jsonContent = true,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Origin: STORE_ORIGIN,
    'X-LimeSpot-Audit-Store-Origin': STORE_ORIGIN,
    ...(prompt
      ? {
          ...(jsonContent ? { 'Content-Type': 'application/json' } : {}),
          'X-Personalizer-System-Prompt': prompt,
          'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
        }
      : {}),
  };
}

function uploadRequest(
  accessToken: string,
  name: string,
  content = name,
  prompts: readonly string[] = [
    'onboarding-batch-all',
    'onboarding-batch',
    'onboarding-review-all',
    'onboarding-review-gate-all',
    'onboarding-currency-recovery',
  ],
): Request {
  const formData = new FormData();
  formData.set('file', new File([content], name, { type: 'image/webp' }));
  for (const prompt of prompts) formData.append('prompt', prompt);
  return new Request('https://app-ai.test/files', {
    method: 'POST',
    headers: auditHeaders(accessToken),
    body: formData,
  });
}

function messageRequest(accessToken: string, fileIdentifiers: readonly string[]): Request {
  return new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: auditHeaders(accessToken, 'onboarding-batch-all'),
    body: JSON.stringify({
      model: 'caller-chosen-expensive-model',
      tools: [{ name: 'caller_tool' }],
      output_config: { effort: 'xhigh' },
      messages: [
        {
          role: 'user',
          content: [
            ...fileIdentifiers.map((fileIdentifier) => ({
              type: 'image',
              source: { type: 'file', file_id: fileIdentifier },
            })),
            { type: 'text', text: 'Analyze this store.' },
          ],
        },
      ],
    }),
  });
}

async function uploadTiles(env: Env, accessToken: string, count: number): Promise<string[]> {
  const identifiers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await worker.fetch(uploadRequest(accessToken, `tile-${index}.webp`), env);
    expect(response.status).toBe(200);
    identifiers.push(((await response.json()) as { id: string }).id);
  }
  return identifiers;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('audit session authorization', () => {
  it('exchanges an email-verified activation exactly once and scopes a prefixed session', async () => {
    const env = durableEnv();
    const token = await activationToken(env, 'activation-one');
    const request = () =>
      worker.fetch(
        new Request('https://app-ai.test/audit/session/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ activationToken: token, storeUrl: `${STORE_ORIGIN}/x` }),
        }),
        env,
      );

    const first = await request();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      sessionIdentifier: expect.any(String),
      accessToken: expect.stringMatching(/^ls_audit_/u),
      expiresAt: expect.any(Number),
    });

    const second = await request();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      ExceptionType: 'AuditActivationConsumedException',
    });
  });

  it('requires a bounded, bare, signed callback URL whose origin this deployment allowlists', async () => {
    const env = durableEnv();
    const now = Math.floor(Date.now() / 1000);
    const claims = (
      tokenIdentifier: string,
      statusCallbackUrl?: string,
    ): Record<string, unknown> => ({
      version: 1,
      kind: 'activation',
      issuer: 'limespot-website',
      audience: 'app-ai',
      tokenIdentifier,
      auditIdentifier: `audit-${tokenIdentifier}`,
      attemptLimit: 2,
      email: 'merchant@example.com',
      emailVerified: true,
      entitlement: { type: 'store-origin', storeOrigin: STORE_ORIGIN },
      ...(statusCallbackUrl === undefined ? {} : { statusCallbackUrl }),
      issuedAt: now,
      expiresAt: now + 600,
    });
    const exchangeClaims = async (payload: Record<string, unknown>): Promise<Response> =>
      worker.fetch(
        new Request('https://app-ai.test/audit/session/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            activationToken: await signWebsiteActivation(payload, env),
            storeUrl: `${STORE_ORIGIN}/products/example`,
          }),
        }),
        env,
      );

    const absent = await exchangeClaims(claims('callback-absent'));
    expect(absent.status).toBe(401);
    expect(await absent.json()).toMatchObject({ ExceptionType: 'AuditAuthorizationException' });

    const foreignHost = await exchangeClaims(
      claims('callback-foreign', 'https://evil.example/studio/activate/api/status'),
    );
    expect(foreignHost.status).toBe(401);

    const insecure = await exchangeClaims(
      claims('callback-insecure', 'http://limespot.test/studio/activate/api/status'),
    );
    expect(insecure.status).toBe(401);

    const lookalikeHost = await exchangeClaims(
      claims('callback-lookalike', 'https://limespot.test.evil.example/studio/activate/api/status'),
    );
    expect(lookalikeHost.status).toBe(401);

    const relative = await exchangeClaims(
      claims('callback-relative', '/studio/activate/api/status'),
    );
    expect(relative.status).toBe(401);

    const credentialed = await exchangeClaims(
      claims(
        'callback-credentialed',
        'https://user:secret@limespot.test/studio/activate/api/status',
      ),
    );
    expect(credentialed.status).toBe(401);

    const queried = await exchangeClaims(
      claims('callback-query', `${AUDIT_STATUS_CALLBACK_URL}?next=1`),
    );
    expect(queried.status).toBe(401);

    const fragmented = await exchangeClaims(
      claims('callback-fragment', `${AUDIT_STATUS_CALLBACK_URL}#f`),
    );
    expect(fragmented.status).toBe(401);

    const overlong = await exchangeClaims(
      claims(
        'callback-overlong',
        `${AUDIT_STATUS_CALLBACK_URL}/${'p'.repeat(
          MAX_STATUS_CALLBACK_URL_LENGTH - AUDIT_STATUS_CALLBACK_URL.length,
        )}`,
      ),
    );
    expect(overlong.status).toBe(401);

    const allowlisted = await exchangeClaims(
      claims('callback-allowlisted', AUDIT_STATUS_CALLBACK_URL),
    );
    expect(allowlisted.status).toBe(201);
  });

  it('binds public activations to one origin and reserves multi-store entitlement for verified staff', async () => {
    const env = durableEnv();
    const publicToken = await activationToken(env, 'public-origin');
    const publicMismatch = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activationToken: publicToken,
          storeUrl: 'https://another-shop.test',
        }),
      }),
      env,
    );
    expect(publicMismatch.status).toBe(403);

    const invalidStaff = await activationToken(
      env,
      'fake-staff',
      { type: 'limespot-staff-multi-store' },
      'merchant@example.com',
    );
    const invalidStaffResponse = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activationToken: invalidStaff,
          storeUrl: 'https://another-shop.test',
        }),
      }),
      env,
    );
    expect(invalidStaffResponse.status).toBe(401);

    const staff = await activationToken(
      env,
      'staff-any-store',
      { type: 'limespot-staff-multi-store' },
      'sales@limespot.com',
    );
    const staffResponse = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activationToken: staff,
          storeUrl: 'https://another-shop.test/path',
        }),
      }),
      env,
    );
    expect(staffResponse.status).toBe(201);

    const insecureStaff = await activationToken(
      env,
      'staff-insecure-origin',
      { type: 'limespot-staff-multi-store' },
      'sales@limespot.com',
    );
    const insecureResponse = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activationToken: insecureStaff,
          storeUrl: 'http://another-shop.test/path',
        }),
      }),
      env,
    );
    expect(insecureResponse.status).toBe(400);

    const loopbackStaff = await activationToken(
      env,
      'staff-loopback-origin',
      { type: 'limespot-staff-multi-store' },
      'sales@limespot.com',
    );
    const loopbackResponse = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activationToken: loopbackStaff,
          storeUrl: 'http://127.0.0.1:5173/path',
        }),
      }),
      env,
    );
    expect(loopbackResponse.status).toBe(201);

    const unmeteredPublic = await activationToken(
      env,
      'public-without-limit',
      { type: 'store-origin', storeOrigin: STORE_ORIGIN },
      'merchant@example.com',
      'audit-public-without-limit',
      null,
    );
    const unmeteredPublicResponse = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activationToken: unmeteredPublic, storeUrl: STORE_ORIGIN }),
      }),
      env,
    );
    expect(unmeteredPublicResponse.status).toBe(401);

    const cappedStaff = await activationToken(
      env,
      'staff-with-public-limit',
      { type: 'limespot-staff-multi-store' },
      'sales@limespot.com',
      'audit-staff-with-public-limit',
      2,
    );
    const cappedStaffResponse = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activationToken: cappedStaff, storeUrl: STORE_ORIGIN }),
      }),
      env,
    );
    expect(cappedStaffResponse.status).toBe(401);
  });

  it('preserves one public audit authority across reissued activation tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const env = durableEnv({ AUDIT_SESSION_TTL_SECONDS: '1' });
    const auditIdentifier = 'audit-stable-public';
    const firstToken = await activationToken(
      env,
      'stable-first',
      { type: 'store-origin', storeOrigin: STORE_ORIGIN },
      'merchant@example.com',
      auditIdentifier,
    );
    expect((await exchange(env, firstToken)).sessionIdentifier).toBeTypeOf('string');

    vi.advanceTimersByTime(2_000);
    const secondToken = await activationToken(
      env,
      'stable-second',
      { type: 'store-origin', storeOrigin: STORE_ORIGIN },
      'merchant@example.com',
      auditIdentifier,
    );
    expect((await exchange(env, secondToken)).sessionIdentifier).toBeTypeOf('string');

    const replay = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activationToken: firstToken, storeUrl: STORE_ORIGIN }),
      }),
      env,
    );
    expect(replay.status).toBe(409);
    vi.useRealTimers();
  });

  it('does not intercept unrelated bearer auth and rejects wrong origins, routes, and prompts', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ Message: 'context missing' }), { status: 401 }),
    );

    const unrelated = await worker.fetch(
      new Request('https://app-ai.test/files', {
        headers: {
          Authorization: 'Bearer unrelated-service-token',
          'X-Personalizer-Context-ID': 'regular-context',
        },
      }),
      env,
    );
    expect(unrelated.status).toBe(401);
    expect(fetchedUrls(fetchMock)).toEqual([
      'https://brain.test/v2/administrator-authentication/validate-context-id',
    ]);
    fetchMock.mockClear();

    const wrongOrigin = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          ...auditHeaders(session.accessToken, 'onboarding-batch-all'),
          'X-LimeSpot-Audit-Store-Origin': 'https://evil.test',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: [] }] }),
      }),
      env,
    );
    expect(wrongOrigin.status).toBe(403);

    const list = await worker.fetch(
      new Request('https://app-ai.test/files', {
        headers: auditHeaders(session.accessToken, 'onboarding-batch-all'),
      }),
      env,
    );
    expect(list.status).toBe(403);

    // The audit scope is POST /files + POST /messages and nothing else, so the
    // master-only routing diagnostics are refused at the scope check — the
    // handler, and the master comparison inside it, are never reached.
    const diagnostics = await worker.fetch(
      new Request('https://app-ai.test/prompts', {
        headers: auditHeaders(session.accessToken, 'onboarding-batch-all'),
      }),
      env,
    );
    expect(diagnostics.status).toBe(403);
    expect(await diagnostics.json()).toMatchObject({ ExceptionType: 'AuditScopeException' });

    const wrongPrompt = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: auditHeaders(session.accessToken, 'visual-verify'),
        body: JSON.stringify({ messages: [{ role: 'user', content: [] }] }),
      }),
      env,
    );
    expect(wrongPrompt.status).toBe(403);

    const headerOnlyUpload = new FormData();
    headerOnlyUpload.set('file', new File(['pixels'], 'header-only.webp'));
    const headerOnly = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: auditHeaders(session.accessToken, 'onboarding-batch-all', false),
        body: headerOnlyUpload,
      }),
      env,
    );
    expect(headerOnly.status).toBe(403);

    const invalidDestination = await worker.fetch(
      uploadRequest(session.accessToken, 'invalid.webp', undefined, [
        'onboarding-batch-all',
        'visual-verify',
      ]),
      env,
    );
    expect(invalidDestination.status).toBe(403);

    const duplicateDestination = await worker.fetch(
      uploadRequest(session.accessToken, 'duplicate-prompt.webp', undefined, [
        'onboarding-batch-all',
        'onboarding-batch-all',
      ]),
      env,
    );
    expect(duplicateDestination.status).toBe(403);

    const duplicateFiles = new FormData();
    duplicateFiles.append('file', new File(['one'], 'one.webp'));
    duplicateFiles.append('file', new File(['two'], 'two.webp'));
    duplicateFiles.append('prompt', 'onboarding-batch-all');
    const duplicateFileResponse = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: auditHeaders(session.accessToken),
        body: duplicateFiles,
      }),
      env,
    );
    expect(duplicateFileResponse.status).toBe(400);
    expect(fetchedUrls(fetchMock)).toEqual([]);
  });

  it('serializes parallel uploads so every returned file remains owned by the session', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const fetchMock = stubFetch();
    let uploadSequence = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/files')) {
        uploadSequence += 1;
        await Promise.resolve();
        return new Response(JSON.stringify(anthropicFileRecord(`file-${uploadSequence}`)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const uploads = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        worker.fetch(uploadRequest(session.accessToken, `tile-${index}.webp`), env),
      ),
    );
    expect(uploads.map((response) => response.status)).toEqual(
      Array.from({ length: 8 }, () => 200),
    );
    const identifiers = await Promise.all(
      uploads.map(async (response) => ((await response.json()) as { id: string }).id),
    );

    const allowed = await worker.fetch(messageRequest(session.accessToken, identifiers), env);
    expect(allowed.status).toBe(200);
    expect(fetchedUrls(fetchMock)).not.toContain(
      'https://brain.test/v2/administrator-authentication/validate-context-id',
    );
  });

  it('accepts exactly the five onboarding upload destinations while inference remains proposal-only', async () => {
    const destinations = [
      'onboarding-batch-all',
      'onboarding-batch',
      'onboarding-review-all',
      'onboarding-review-gate-all',
      'onboarding-currency-recovery',
    ];
    const env = durableEnv();
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const upload = await worker.fetch(
      uploadRequest(session.accessToken, 'all-prompts.webp', 'all-prompts.webp', destinations),
      env,
    );
    expect(upload.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { references } = (await upload.json()) as { references: Record<string, unknown> };
    expect(new Set(Object.keys(references))).toEqual(new Set(destinations));

    const sixth = await worker.fetch(
      uploadRequest(session.accessToken, 'sixth.webp', 'sixth.webp', [
        ...destinations,
        'onboarding-chat',
      ]),
      env,
    );
    expect(sixth.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const reviewInference = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: auditHeaders(session.accessToken, 'onboarding-review-all'),
        body: JSON.stringify({ messages: [{ role: 'user', content: [] }] }),
      }),
      env,
    );
    expect(reviewInference.status).toBe(403);
  });

  it('rejects foreign or inline files and forces registry-owned inference authority', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 204 });
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord('file-owned')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const owned = await worker.fetch(uploadRequest(session.accessToken, 'home.webp'), env);
    expect(owned.status).toBe(200);
    const ownedReference = ((await owned.json()) as { id: string }).id;

    const foreign = await worker.fetch(messageRequest(session.accessToken, ['file-foreign']), env);
    expect(foreign.status).toBe(403);

    const inline = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: auditHeaders(session.accessToken, 'onboarding-batch-all'),
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'base64', data: 'pixels' } }],
            },
          ],
        }),
      }),
      env,
    );
    expect(inline.status).toBe(403);

    const allowed = await worker.fetch(messageRequest(session.accessToken, [ownedReference]), env);
    expect(allowed.status).toBe(200);
    const messageCall = fetchedUrls(fetchMock).findIndex((url) => url.endsWith('/v1/messages'));
    const forwarded = sentBody(fetchCall(fetchMock, messageCall).init);
    expect(forwarded.model).toBe(ENV.MODEL_BALANCED);
    expect(forwarded.tools).toBeUndefined();
    expect(forwarded.output_config).toEqual({ effort: 'medium' });
  });

  it('seals audit uploads into a session namespace no merchant or other session can open', async () => {
    // The router keys an audit session's file tenant scope off the session
    // identifier, so an audit upload lives in a namespace of its own: it carries
    // no context-ID, and a merchant tenant is not the tenant that made it.
    const env = durableEnv();
    const session = await exchange(env);
    const otherSession = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 204 });
      if (url.includes('/v2/administrator-authentication/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 42, SubscriberTitle: 'Store' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord('file-audit-owned')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const uploaded = await worker.fetch(uploadRequest(session.accessToken, 'home.webp'), env);
    expect(uploaded.status).toBe(200);
    const auditReference = ((await uploaded.json()) as { id: string }).id;

    const merchant = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Personalizer-Context-ID': 'ctx-merchant',
          'X-Personalizer-System-Prompt': 'onboarding-batch-all',
          'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'file', file_id: auditReference } }],
            },
          ],
        }),
      }),
      env,
    );
    expect(merchant.status).toBe(403);
    expect((await merchant.json()) as unknown).toMatchObject({
      Message: 'File reference does not belong to this tenant',
      ExceptionType: 'UnauthorizedAccessException',
    });

    // A second audit session is a second namespace, so the reference is not
    // reachable from it either.
    const foreignSession = await worker.fetch(
      messageRequest(otherSession.accessToken, [auditReference]),
      env,
    );
    expect(foreignSession.status).toBe(403);

    // The owning session still runs, so the refusals are the tenant boundary
    // rather than a reference that never worked.
    expect(
      (await worker.fetch(messageRequest(session.accessToken, [auditReference]), env)).status,
    ).toBe(200);
  });

  it('holds a run to its upload ceiling and releases reservations after upstream failure', async () => {
    const env = durableEnv({ AUDIT_RUN_HEADROOM: '1' });
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'temporary failure' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    expect((await worker.fetch(uploadRequest(session.accessToken, 'first.webp'), env)).status).toBe(
      503,
    );
    await uploadTiles(env, session.accessToken, PLANNED_AUDIT_RUN.uploads);
    const overCeiling = await worker.fetch(uploadRequest(session.accessToken, 'over.webp'), env);
    expect(overCeiling.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(PLANNED_AUDIT_RUN.uploads + 1);
  });

  it('releases an upload reservation when the upstream fetch throws so the request can be retried', async () => {
    const env = durableEnv({ AUDIT_RUN_HEADROOM: '1' });
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await uploadTiles(env, session.accessToken, PLANNED_AUDIT_RUN.uploads - 1);
    fetchMock.mockRejectedValueOnce(new Error('network socket closed'));

    const failed = await worker.fetch(uploadRequest(session.accessToken, 'throw.webp'), env);
    expect(failed.status).toBe(500);
    const retried = await worker.fetch(uploadRequest(session.accessToken, 'retry.webp'), env);
    expect(retried.status).toBe(200);
    const overCeiling = await worker.fetch(uploadRequest(session.accessToken, 'over.webp'), env);
    expect(overCeiling.status).toBe(429);
  });

  it('releases an inference reservation when the tenant sealing key is rejected before dispatch', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    // The same authority namespace, served by a worker whose sealing key is absent.
    const { TOKEN_ENCRYPTION_SECRET: _absent, ...missingSecretEnv } = env;
    const callbacks: Array<Record<string, unknown>> = [];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const failed = await worker.fetch(messageRequest(session.accessToken, []), missingSecretEnv);
    expect(failed.status).toBe(500);
    expect((await failed.json()) as unknown).toMatchObject({ ExceptionType: 'Exception' });
    expect(fetchedUrls(fetchMock).filter((url) => url.endsWith('/v1/messages'))).toEqual([]);
    // The reservation the authorization took is released, so the attempt is
    // reported failed and the next inference after the key is configured is
    // served instead of answering 409 until the session expires.
    expect(callbacks.map(({ status, attemptNumber }) => [status, attemptNumber])).toEqual([
      ['started', 1],
      ['failed', 1],
    ]);
    const retried = await worker.fetch(messageRequest(session.accessToken, []), env);
    expect(retried.status).toBe(200);
    expect(callbacks.map(({ status, attemptNumber }) => [status, attemptNumber])).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('releases an upload reservation when the tenant sealing key is rejected before dispatch', async () => {
    const env = durableEnv({ AUDIT_RUN_HEADROOM: '1' });
    const session = await exchange(env);
    const { TOKEN_ENCRYPTION_SECRET: _absent, ...missingSecretEnv } = env;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await uploadTiles(env, session.accessToken, PLANNED_AUDIT_RUN.uploads - 1);

    const failed = await worker.fetch(
      uploadRequest(session.accessToken, 'no-key.webp'),
      missingSecretEnv,
    );
    expect(failed.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(PLANNED_AUDIT_RUN.uploads - 1);
    const retried = await worker.fetch(uploadRequest(session.accessToken, 'retry.webp'), env);
    expect(retried.status).toBe(200);
    const overCeiling = await worker.fetch(uploadRequest(session.accessToken, 'over.webp'), env);
    expect(overCeiling.status).toBe(429);
  });

  it('allows exactly two completed public runs and refuses the third before any upload', async () => {
    const env = durableEnv();
    const session = await exchange(
      env,
      await activationToken(
        env,
        'two-attempt-token',
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        'audit-two-attempts',
      ),
    );
    const callbacks: Array<Record<string, unknown>> = [];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const firstRun = await uploadTiles(env, session.accessToken, 1);
    expect((await worker.fetch(messageRequest(session.accessToken, firstRun), env)).status).toBe(
      200,
    );
    const repair = await worker.fetch(messageRequest(session.accessToken, firstRun), env);
    expect(repair.status).toBe(200);
    const secondRun = await uploadTiles(env, session.accessToken, 1);
    expect((await worker.fetch(messageRequest(session.accessToken, secondRun), env)).status).toBe(
      200,
    );
    const providerCallsBeforeThirdRun = fetchMock.mock.calls.length;
    const refused = await worker.fetch(uploadRequest(session.accessToken, 'third-run.webp'), env);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { Message: string }).Message).toBe(
      'This public grader has no attempts remaining.',
    );
    expect(fetchMock.mock.calls.length).toBe(providerCallsBeforeThirdRun);

    expect(callbacks.map(({ status, attemptNumber }) => [status, attemptNumber])).toEqual([
      ['started', 1],
      ['completed', 1],
      ['started', 2],
      ['completed', 2],
    ]);
    expect(new Set(callbacks.map(({ eventIdentifier }) => eventIdentifier)).size).toBe(4);
  });

  it('releases a failed inference attempt and reuses the same public attempt number', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const callbacks: Array<Record<string, unknown>> = [];
    const fetchMock = stubFetch();
    let inference = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        callbacks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord('file-retry')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      inference += 1;
      if (inference === 1) {
        return new Response(JSON.stringify({ error: { message: 'temporary' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const retryUpload = await worker.fetch(uploadRequest(session.accessToken, 'retry.webp'), env);
    expect(retryUpload.status).toBe(200);
    const retryReference = ((await retryUpload.json()) as { id: string }).id;
    expect(
      (await worker.fetch(messageRequest(session.accessToken, [retryReference]), env)).status,
    ).toBe(503);
    expect(
      (await worker.fetch(messageRequest(session.accessToken, [retryReference]), env)).status,
    ).toBe(200);
    expect(callbacks.map(({ status, attemptNumber }) => [status, attemptNumber])).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('retains callback events through an outage and retries the immutable outbox in order', async () => {
    const auditIdentifier = 'audit-callback-outbox';
    const env = durableEnv();
    const session = await exchange(
      env,
      await activationToken(
        env,
        'outbox-token',
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      ),
    );
    const callbackBodies: string[] = [];
    let callbackAvailable = false;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        callbackBodies.push(String(init?.body));
        return new Response(null, { status: callbackAvailable ? 204 : 503 });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    expect((await worker.fetch(messageRequest(session.accessToken, []), env)).status).toBe(200);
    expect(callbackBodies).toHaveLength(2);
    expect(callbackBodies[1]).toBe(callbackBodies[0]);

    callbackAvailable = true;
    await authorityFor(env, auditIdentifier).alarm();

    expect(callbackBodies).toHaveLength(4);
    expect(callbackBodies[2]).toBe(callbackBodies[0]);
    expect(callbackBodies.slice(2).map((body) => JSON.parse(body))).toMatchObject([
      { status: 'started', attemptNumber: 1 },
      { status: 'completed', attemptNumber: 1 },
    ]);
  });

  it('mirrors every event in the session to the URL its activation signed, past that token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const env = durableEnv({
      AUDIT_STATUS_ORIGINS: `${ENV.AUDIT_STATUS_ORIGINS},https://mirror.limespot.test`,
    });
    const signedCallbackUrl = 'https://mirror.limespot.test/studio/activate/api/status';
    const session = await exchange(
      env,
      await activationToken(
        env,
        'signed-callback',
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        'audit-signed-callback',
        undefined,
        signedCallbackUrl,
      ),
    );
    const callbackTargets: string[] = [];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/studio/activate/api/status')) {
        callbackTargets.push(url);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    expect((await worker.fetch(messageRequest(session.accessToken, []), env)).status).toBe(200);
    vi.advanceTimersByTime(PAST_ACTIVATION_CEILING_MILLISECONDS);
    const retry = await uploadTiles(env, session.accessToken, 1);
    expect((await worker.fetch(messageRequest(session.accessToken, retry), env)).status).toBe(200);

    expect(callbackTargets).toEqual(Array.from({ length: 4 }, () => signedCallbackUrl));
    expect(callbackTargets).not.toContain(AUDIT_STATUS_CALLBACK_URL);
    vi.useRealTimers();
  });
});

describe('grader runs in one audit session', () => {
  const FIVE_PAGE_RUN_UPLOADS = 5 * 2 * 2;

  interface GraderUpstream {
    readonly callbacks: Array<[unknown, unknown]>;
    readonly callbackEvents: Array<Record<string, unknown>>;
    readonly inferenceCalls: () => number;
    readonly uploadCalls: () => number;
    readonly releaseHeldInference: () => void;
    readonly releaseHeldUploads: () => void;
  }

  function graderUpstream(
    answer: (inference: number) => 'hold' | number,
    holdUpload: (upload: number) => boolean = () => false,
  ): GraderUpstream {
    const callbacks: Array<[unknown, unknown]> = [];
    const callbackEvents: Array<Record<string, unknown>> = [];
    const held: Array<() => void> = [];
    const heldUploads: Array<() => void> = [];
    let inference = 0;
    let upload = 0;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
        callbacks.push([event.status, event.attemptNumber]);
        callbackEvents.push(event);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        upload += 1;
        const stored = (): Response =>
          new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        if (holdUpload(upload)) {
          return new Promise<Response>((resolve) => heldUploads.push(() => resolve(stored())));
        }
        return stored();
      }
      inference += 1;
      const outcome = answer(inference);
      const success = (): Response =>
        new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      if (outcome === 'hold') {
        return new Promise<Response>((resolve) => held.push(() => resolve(success())));
      }
      if (outcome === 200) return success();
      return new Response(JSON.stringify({ error: { message: 'upstream outage' } }), {
        status: outcome,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return {
      callbacks,
      callbackEvents,
      inferenceCalls: () => inference,
      uploadCalls: () => upload,
      releaseHeldInference: () => held.splice(0).forEach((release) => release()),
      releaseHeldUploads: () => heldUploads.splice(0).forEach((release) => release()),
    };
  }

  it('lets a five-page run and every retry Studio offers through, then ends the session', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    graderUpstream((inference) => (inference < 4 ? 503 : 200));

    for (let run = 1; run <= 4; run += 1) {
      const tiles = await uploadTiles(env, session.accessToken, FIVE_PAGE_RUN_UPLOADS);
      const proposal = await worker.fetch(messageRequest(session.accessToken, tiles), env);
      expect(proposal.status, `run ${run}`).toBe(run < 4 ? 503 : 200);
    }

    const fifthRun = await worker.fetch(uploadRequest(session.accessToken, 'fifth.webp'), env);
    expect(fifthRun.status).toBe(429);
    expect(((await fifthRun.json()) as { Message: string }).Message).toBe(
      'This grader session has no retries remaining.',
    );
  });

  async function sessionExpiringDuringProposal(auditIdentifier: string): Promise<{
    env: Env;
    upstream: GraderUpstream;
    proposal: Promise<Response>;
    sessionIdentifier: string;
    expiresAt: number;
    admittedAt: number;
  }> {
    vi.useFakeTimers({ toFake: ['Date'] });
    const exchangedAt = new Date('2026-09-24T12:00:00Z').getTime();
    vi.setSystemTime(exchangedAt);
    const env = durableEnv();
    const session = await exchange(
      env,
      await activationToken(
        env,
        `${auditIdentifier}-token`,
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      ),
    );
    const upstream = graderUpstream(() => 'hold');
    const expiresAt = exchangedAt + Number(ENV.AUDIT_SESSION_TTL_SECONDS) * 1000;
    const admittedAt = expiresAt - 60_000;
    vi.setSystemTime(admittedAt);
    const tiles = await uploadTiles(env, session.accessToken, 1);
    const proposal = worker.fetch(messageRequest(session.accessToken, tiles), env);
    await vi.waitFor(() => expect(upstream.inferenceCalls()).toBe(1));
    return {
      env,
      upstream,
      proposal,
      sessionIdentifier: session.sessionIdentifier,
      expiresAt,
      admittedAt,
    };
  }

  const LEASE_MILLISECONDS =
    UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS + RESERVATION_FINALIZE_GRACE_MILLISECONDS;

  it('delivers a proposal whose inference started before its session expired', async () => {
    const auditIdentifier = 'audit-expiry-in-flight';
    const { env, upstream, proposal, expiresAt } =
      await sessionExpiringDuringProposal(auditIdentifier);

    vi.setSystemTime(expiresAt + 1000);
    await authorityFor(env, auditIdentifier).alarm();
    upstream.releaseHeldInference();

    const response = await proposal;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: [{ type: 'text', text: '{}' }] });
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('finalizes a proposal that answers after its inference deadline, inside the finalization grace', async () => {
    const auditIdentifier = 'audit-expiry-finalization-grace';
    const { env, upstream, proposal, admittedAt } =
      await sessionExpiringDuringProposal(auditIdentifier);

    vi.setSystemTime(admittedAt + UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS + 1000);
    await deliverStatusEvents(env);
    upstream.releaseHeldInference();

    expect((await proposal).status).toBe(200);
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('reports a reservation failed once its lease lapsed, and still delivers its late result', async () => {
    const auditIdentifier = 'audit-expiry-past-lease';
    const { env, upstream, proposal, admittedAt } =
      await sessionExpiringDuringProposal(auditIdentifier);

    vi.setSystemTime(admittedAt + LEASE_MILLISECONDS + 1000);
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
    ]);
    expect((await storedRunSession(env, auditIdentifier)).pending).toEqual({});

    upstream.releaseHeldInference();
    expect((await proposal).status).toBe(200);
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
    ]);
  });

  it('releases a reservation at its own lease while a reissued session is active', async () => {
    const auditIdentifier = 'audit-expiry-reissued';
    const { env, upstream, proposal, sessionIdentifier, expiresAt, admittedAt } =
      await sessionExpiringDuringProposal(auditIdentifier);

    vi.setSystemTime(expiresAt + 1000);
    const reissued = await exchange(
      env,
      await activationToken(
        env,
        `${auditIdentifier}-reissued-token`,
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      ),
    );
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([['started', 1]]);

    vi.setSystemTime(admittedAt + LEASE_MILLISECONDS + 1000);
    await deliverStatusEvents(env);

    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
    ]);
    expect(upstream.callbackEvents.at(-1)?.sessionIdentifier).toBe(sessionIdentifier);
    const record = await storedRunSession(env, auditIdentifier);
    expect(record.sessionIdentifier).toBe(reissued.sessionIdentifier);
    expect(record.pending).toEqual({});
    upstream.releaseHeldInference();
    await proposal;
  });

  it('counts an audit inference deadline from its admission, through the real route', async () => {
    vi.useFakeTimers();
    const PRE_MODEL_DELAY_MILLISECONDS = 300_000;
    const env = durableEnv();
    const session = await exchange(env);
    let modelCalledAt: number | null = null;
    let markModelCalled = (): void => {};
    const modelCalled = new Promise<void>((resolve) => {
      markModelCalled = resolve;
    });
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 204 });
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      modelCalledAt = Date.now();
      markModelCalled();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });
    const tiles = await uploadTiles(env, session.accessToken, 1);

    let releaseReservation = (): void => {};
    let markReservationHeld = (): void => {};
    const reservationHeld = new Promise<void>((resolve) => {
      markReservationHeld = resolve;
    });
    AUTHORITY_GATES.set(env, async (path) => {
      if (path !== '/reserve') return;
      AUTHORITY_GATES.delete(env);
      markReservationHeld();
      await new Promise<void>((resolve) => {
        releaseReservation = resolve;
      });
    });
    const admittedAt = Date.now();
    const pending = worker.fetch(messageRequest(session.accessToken, tiles), env);
    await reservationHeld;
    await vi.advanceTimersByTimeAsync(PRE_MODEL_DELAY_MILLISECONDS);
    releaseReservation();
    await modelCalled;
    expect(modelCalledAt).toBe(admittedAt + PRE_MODEL_DELAY_MILLISECONDS);

    await vi.advanceTimersByTimeAsync(
      UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS - PRE_MODEL_DELAY_MILLISECONDS,
    );
    const response = await pending;

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      Message: 'The AI model did not answer within the 600-second inference deadline.',
      ExceptionType: 'InferenceTimeoutException',
      MessageDetail: 'inference_timeout',
    });
  });

  it("never charges an expired session's late upload to the session that replaced it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const auditIdentifier = 'audit-late-upload';
    const exchangedAt = new Date('2026-09-24T12:00:00Z').getTime();
    vi.setSystemTime(exchangedAt);
    const env = durableEnv({ AUDIT_RUN_HEADROOM: '1', AUDIT_MAX_RUNS: '1' });
    const token = (suffix: string): Promise<string> =>
      activationToken(
        env,
        `${auditIdentifier}-${suffix}`,
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      );
    const expired = await exchange(env, await token('first'));
    const upstream = graderUpstream(
      () => 200,
      (upload) => upload === 1,
    );
    const expiresAt = exchangedAt + Number(ENV.AUDIT_SESSION_TTL_SECONDS) * 1000;
    vi.setSystemTime(expiresAt - 60_000);
    const lateUpload = worker.fetch(uploadRequest(expired.accessToken, 'late.webp'), env);
    await vi.waitFor(() => expect(upstream.uploadCalls()).toBe(1));

    vi.setSystemTime(expiresAt + 1000);
    const replacement = await exchange(env, await token('second'));
    upstream.releaseHeldUploads();
    expect((await lateUpload).status).toBe(200);

    await uploadTiles(env, replacement.accessToken, PLANNED_AUDIT_RUN.uploads);
    const overAllowance = await worker.fetch(
      uploadRequest(replacement.accessToken, 'over.webp'),
      env,
    );
    expect(overAllowance.status).toBe(429);
    expect(await storedRunSession(env, auditIdentifier)).toMatchObject({
      sessionIdentifier: replacement.sessionIdentifier,
      uploadCount: PLANNED_AUDIT_RUN.uploads,
    });
  });

  it('releases a proposal its caller abandoned when the conductor sends it again', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const upstream = graderUpstream((inference) => (inference === 1 ? 'hold' : 200));
    const tiles = await uploadTiles(env, session.accessToken, 2);

    const abandoned = worker.fetch(messageRequest(session.accessToken, tiles), env);
    await vi.waitFor(() => expect(upstream.inferenceCalls()).toBe(1));
    const resent = await worker.fetch(messageRequest(session.accessToken, tiles), env);
    expect(resent.status).toBe(200);

    upstream.releaseHeldInference();
    expect((await abandoned).status).toBe(200);
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('gives a retry after an abandoned run a fresh run of its own', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const upstream = graderUpstream((inference) => (inference === 1 ? 'hold' : 200));
    const firstRun = await uploadTiles(env, session.accessToken, FIVE_PAGE_RUN_UPLOADS);
    void worker.fetch(messageRequest(session.accessToken, firstRun), env);
    await vi.waitFor(() => expect(upstream.inferenceCalls()).toBe(1));

    const retry = await uploadTiles(env, session.accessToken, FIVE_PAGE_RUN_UPLOADS);
    const stale = await worker.fetch(messageRequest(session.accessToken, firstRun), env);
    expect(stale.status).toBe(403);
    const proposal = await worker.fetch(messageRequest(session.accessToken, retry), env);
    expect(proposal.status).toBe(200);
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  interface StoredRunSession {
    readonly auditIdentifier: string;
    readonly attemptLimit: 2 | null;
    readonly storeOrigin: string;
    readonly statusCallbackUrl: string;
    readonly consumedActivationIdentifiers: readonly string[];
    readonly sessionIdentifier: string;
    readonly expiresAt: number;
    readonly uploadCount: number;
    readonly totalUploadBytes: number;
    readonly messageCount: number;
    readonly run: number;
    readonly fileIdentifiers: readonly string[];
    readonly pending: Readonly<
      Record<string, { readonly kind: string; readonly run?: number; readonly uploadBytes: number }>
    >;
    readonly completedReservations: readonly string[];
    readonly statusOutbox: readonly unknown[];
  }

  async function storedRunSession(env: Env, auditIdentifier: string): Promise<StoredRunSession> {
    const record = await storageFor(env, auditIdentifier).get<StoredRunSession>('session');
    if (!record) throw new Error(`Missing stored session for ${auditIdentifier}`);
    return record;
  }

  async function storeWithoutRuns(
    env: Env,
    auditIdentifier: string,
    counts: {
      readonly completedAttempts: number;
      readonly messageCount: number;
      readonly pendingAttemptNumber?: number;
      readonly earlierRun?: StoredRunSession;
    },
  ): Promise<void> {
    const record = await storedRunSession(env, auditIdentifier);
    const pendingMessage = Object.entries(record.pending).find(
      ([, reservation]) => reservation.kind === 'message',
    );
    if ((counts.pendingAttemptNumber === undefined) !== (pendingMessage === undefined)) {
      throw new Error('The stored pending inference does not match the requested record.');
    }
    await storageFor(env, auditIdentifier).put('session', {
      auditIdentifier: record.auditIdentifier,
      attemptLimit: record.attemptLimit,
      storeOrigin: record.storeOrigin,
      statusCallbackUrl: record.statusCallbackUrl,
      completedAttempts: counts.completedAttempts,
      consumedActivationIdentifiers: record.consumedActivationIdentifiers,
      sessionIdentifier: record.sessionIdentifier,
      expiresAt: record.expiresAt,
      uploadCount: record.uploadCount,
      totalUploadBytes: record.totalUploadBytes,
      messageCount: counts.messageCount,
      fileIdentifiers: [...(counts.earlierRun?.fileIdentifiers ?? []), ...record.fileIdentifiers],
      pending: Object.fromEntries(
        Object.entries(record.pending).map(([identifier, reservation]) => [
          identifier,
          reservation.kind === 'message'
            ? { kind: 'message', uploadBytes: 0, attemptNumber: counts.pendingAttemptNumber }
            : { kind: 'upload', uploadBytes: reservation.uploadBytes },
        ]),
      ),
      completedReservations: record.completedReservations,
      statusOutbox: record.statusOutbox,
    });
  }

  async function sessionWithCompletedProposal(
    auditIdentifier: string,
    answer: (inference: number) => 'hold' | number,
    holdUpload?: (upload: number) => boolean,
  ): Promise<{
    env: Env;
    accessToken: string;
    tiles: string[];
    upstream: GraderUpstream;
  }> {
    const env = durableEnv();
    const session = await exchange(
      env,
      await activationToken(
        env,
        `${auditIdentifier}-token`,
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      ),
    );
    const upstream = graderUpstream(answer, holdUpload);
    const tiles = await uploadTiles(env, session.accessToken, 2);
    expect((await worker.fetch(messageRequest(session.accessToken, tiles), env)).status).toBe(200);
    expect(upstream.callbacks.splice(0)).toEqual([
      ['started', 1],
      ['completed', 1],
    ]);
    return { env, accessToken: session.accessToken, tiles, upstream };
  }

  async function refusedForExhaustedAttempts(response: Promise<Response>): Promise<void> {
    const refused = await response;
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { Message: string }).Message).toBe(
      'This public grader has no attempts remaining.',
    );
  }

  it('counts the first proposal after a session stored without runs as its next attempt, then repairs freely', async () => {
    const auditIdentifier = 'audit-stored-without-runs';
    const { env, accessToken, tiles, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
    );
    await storeWithoutRuns(env, auditIdentifier, { completedAttempts: 1, messageCount: 1 });

    expect((await worker.fetch(messageRequest(accessToken, tiles), env)).status).toBe(200);
    expect((await worker.fetch(messageRequest(accessToken, tiles), env)).status).toBe(200);
    expect(upstream.callbacks).toEqual([
      ['started', 2],
      ['completed', 2],
    ]);
    await refusedForExhaustedAttempts(
      worker.fetch(uploadRequest(accessToken, 'third-run.webp'), env),
    );
  });

  it('opens a fresh run for the first upload after a session stored without runs completed its proposal', async () => {
    const auditIdentifier = 'audit-stored-without-runs-retry';
    const { env, accessToken, tiles } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
    );
    await storeWithoutRuns(env, auditIdentifier, { completedAttempts: 1, messageCount: 1 });

    await uploadTiles(env, accessToken, 1);
    expect((await worker.fetch(messageRequest(accessToken, tiles), env)).status).toBe(403);
  });

  it('counts a retry uploaded before its session was stored without runs and proposed after', async () => {
    const auditIdentifier = 'audit-stored-without-runs-uploaded-retry';
    const { env, accessToken, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
    );
    const earlierRun = await storedRunSession(env, auditIdentifier);
    const retry = await uploadTiles(env, accessToken, 2);
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      earlierRun,
    });

    expect((await worker.fetch(messageRequest(accessToken, retry), env)).status).toBe(200);
    expect(upstream.callbacks).toEqual([
      ['started', 2],
      ['completed', 2],
    ]);
    await refusedForExhaustedAttempts(
      worker.fetch(uploadRequest(accessToken, 'third-run.webp'), env),
    );
  });

  it('completes the attempt a session stored without runs admitted for its pending retry', async () => {
    const auditIdentifier = 'audit-stored-without-runs-pending-retry';
    const { env, accessToken, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      (inference) => (inference === 2 ? 'hold' : 200),
    );
    const earlierRun = await storedRunSession(env, auditIdentifier);
    const retry = await uploadTiles(env, accessToken, 2);
    const proposal = worker.fetch(messageRequest(accessToken, retry), env);
    await vi.waitFor(() => expect(upstream.inferenceCalls()).toBe(2));
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      pendingAttemptNumber: 2,
      earlierRun,
    });

    upstream.releaseHeldInference();
    expect((await proposal).status).toBe(200);
    expect(upstream.callbacks).toEqual([
      ['started', 2],
      ['completed', 2],
    ]);
    await refusedForExhaustedAttempts(
      worker.fetch(uploadRequest(accessToken, 'third-run.webp'), env),
    );
  });

  it('gives a retry upload admitted before its session was stored without runs to the run its sibling opens', async () => {
    const auditIdentifier = 'audit-stored-without-runs-pending-upload';
    const { env, accessToken, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
      (upload) => upload === 3,
    );
    const earlierRun = await storedRunSession(env, auditIdentifier);
    const late = worker.fetch(uploadRequest(accessToken, 'late.webp'), env);
    await vi.waitFor(() => expect(upstream.uploadCalls()).toBe(3));
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      earlierRun,
    });

    const sibling = await worker.fetch(uploadRequest(accessToken, 'sibling.webp'), env);
    expect(sibling.status).toBe(200);
    upstream.releaseHeldUploads();
    const landed = await late;
    expect(landed.status).toBe(200);
    const retry = await Promise.all(
      [landed, sibling].map(async (response) => ((await response.json()) as { id: string }).id),
    );

    expect((await worker.fetch(messageRequest(accessToken, retry), env)).status).toBe(200);
    expect(upstream.callbacks).toEqual([
      ['started', 2],
      ['completed', 2],
    ]);
  });

  it('writes the whole-session totals a rolled-back worker without runs enforces its limits from', async () => {
    const auditIdentifier = 'audit-rollback-totals';
    const { env, accessToken, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
      (upload) => upload === 4,
    );
    await uploadTiles(env, accessToken, 1);
    const held = worker.fetch(uploadRequest(accessToken, 'held-retry.webp'), env);
    await vi.waitFor(() => expect(upstream.uploadCalls()).toBe(4));

    const record = await storedRunSession(env, auditIdentifier);
    expect(record).toMatchObject({
      run: 2,
      uploadCount: 3,
      totalUploadBytes: 3 * 'tile-0.webp'.length,
      messageCount: 1,
    });
    expect(Object.values(record.pending)).toEqual([
      {
        kind: 'upload',
        run: 2,
        uploadBytes: 'held-retry.webp'.length,
        sessionIdentifier: expect.any(String),
        admittedAt: expect.any(Number),
      },
    ]);

    upstream.releaseHeldUploads();
    expect((await held).status).toBe(200);
    expect(await storedRunSession(env, auditIdentifier)).toMatchObject({
      uploadCount: 4,
      totalUploadBytes: 3 * 'tile-0.webp'.length + 'held-retry.webp'.length,
      pending: {},
    });
  });

  it('refuses any proposal or run after a session stored without runs used both public attempts', async () => {
    const auditIdentifier = 'audit-stored-without-runs-exhausted';
    const { env, accessToken, tiles, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
    );
    await storeWithoutRuns(env, auditIdentifier, { completedAttempts: 2, messageCount: 2 });

    await refusedForExhaustedAttempts(worker.fetch(messageRequest(accessToken, tiles), env));
    await refusedForExhaustedAttempts(
      worker.fetch(uploadRequest(accessToken, 'third-run.webp'), env),
    );
    expect(upstream.inferenceCalls()).toBe(1);
    expect(upstream.callbacks).toEqual([]);
  });

  it('holds one run to its planned proposal inferences times the headroom', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    graderUpstream(() => 503);
    const tiles = await uploadTiles(env, session.accessToken, 1);
    const ceiling = PLANNED_AUDIT_RUN.inferences * Number(env.AUDIT_RUN_HEADROOM);

    for (let inference = 1; inference <= ceiling; inference += 1) {
      const response = await worker.fetch(messageRequest(session.accessToken, tiles), env);
      expect(response.status, `inference ${inference}`).toBe(503);
    }
    const refused = await worker.fetch(messageRequest(session.accessToken, tiles), env);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { Message: string }).Message).toBe(
      'The grader run limit has been reached.',
    );
  });
});
