import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { AuditSessionAuthority } from '../src/lib/audit-session-authority';
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

  async setAlarm(_scheduledTime: number): Promise<void> {}

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
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          authority.fetch(input instanceof Request ? input : new Request(input, init)),
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
  const env: Env = { ...ENV, ...overrides, AUDIT_SESSIONS: namespace };
  AUTHORITIES_BY_ENV.set(env, authorities);
  return env;
}

function authorityFor(env: Env, auditIdentifier: string): AuditSessionAuthority {
  const authority = AUTHORITIES_BY_ENV.get(env)?.get(auditIdentifier);
  if (!authority) throw new Error(`Missing test authority for ${auditIdentifier}`);
  return authority;
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
    const env = durableEnv({ AUDIT_MAX_UPLOADS: '8' });
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

  it('accepts all four repeated multipart upload destinations while inference remains proposal-only', async () => {
    const env = durableEnv({ AUDIT_MAX_UPLOADS: '1' });
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const upload = await worker.fetch(uploadRequest(session.accessToken, 'all-prompts.webp'), env);
    expect(upload.status).toBe(200);
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

  it('atomically enforces upload quotas and releases reservations after upstream failure', async () => {
    const env = durableEnv({ AUDIT_MAX_UPLOADS: '1', AUDIT_MAX_TOTAL_UPLOAD_BYTES: '20' });
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'temporary failure' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(anthropicFileRecord('file-retry')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    expect((await worker.fetch(uploadRequest(session.accessToken, 'first.webp'), env)).status).toBe(
      503,
    );
    expect((await worker.fetch(uploadRequest(session.accessToken, 'retry.webp'), env)).status).toBe(
      200,
    );
    const overQuota = await worker.fetch(uploadRequest(session.accessToken, 'third.webp'), env);
    expect(overQuota.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('releases upload quota when the upstream fetch throws so the request can be retried', async () => {
    const env = durableEnv({ AUDIT_MAX_UPLOADS: '1' });
    const session = await exchange(env);
    const fetchMock = stubFetch();
    fetchMock.mockRejectedValueOnce(new Error('network socket closed')).mockResolvedValueOnce(
      new Response(JSON.stringify(anthropicFileRecord('file-after-throw')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const failed = await worker.fetch(uploadRequest(session.accessToken, 'throw.webp'), env);
    expect(failed.status).toBe(500);
    const retried = await worker.fetch(uploadRequest(session.accessToken, 'retry.webp'), env);
    expect(retried.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    const env = durableEnv({ AUDIT_MAX_UPLOADS: '1' });
    const session = await exchange(env);
    const { TOKEN_ENCRYPTION_SECRET: _absent, ...missingSecretEnv } = env;
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(anthropicFileRecord('file-after-key')), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const failed = await worker.fetch(
      uploadRequest(session.accessToken, 'no-key.webp'),
      missingSecretEnv,
    );
    expect(failed.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    const retried = await worker.fetch(uploadRequest(session.accessToken, 'retry.webp'), env);
    expect(retried.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows exactly two successful public proposal attempts and reports ordered completion status', async () => {
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
        return new Response(JSON.stringify(anthropicFileRecord('file-attempts')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const uploaded = await worker.fetch(uploadRequest(session.accessToken, 'attempts.webp'), env);
    expect(uploaded.status).toBe(200);
    const reference = ((await uploaded.json()) as { id: string }).id;
    expect((await worker.fetch(messageRequest(session.accessToken, [reference]), env)).status).toBe(
      200,
    );
    expect((await worker.fetch(messageRequest(session.accessToken, [reference]), env)).status).toBe(
      200,
    );
    expect((await worker.fetch(messageRequest(session.accessToken, [reference]), env)).status).toBe(
      429,
    );

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
      return new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: '{}' }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    expect((await worker.fetch(messageRequest(session.accessToken, []), env)).status).toBe(200);
    vi.advanceTimersByTime(PAST_ACTIVATION_CEILING_MILLISECONDS);
    expect((await worker.fetch(messageRequest(session.accessToken, []), env)).status).toBe(200);

    expect(callbackTargets).toEqual(Array.from({ length: 4 }, () => signedCallbackUrl));
    expect(callbackTargets).not.toContain(AUDIT_STATUS_CALLBACK_URL);
    vi.useRealTimers();
  });
});
