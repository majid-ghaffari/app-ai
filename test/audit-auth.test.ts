import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { RESERVATION_FINALIZE_GRACE_MILLISECONDS } from '../src/lib/audit-session-authority';
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
import {
  AUTHORITY_GATES,
  DURABLE_OBJECT_ENTRY_LIMIT_BYTES,
  STORE_ORIGIN,
  USABLE_PROPOSAL,
  activationToken,
  auditHeaders,
  authorityFor,
  deliverStatusEvents,
  durableEnv,
  exchange,
  EXTENSION_BUILD_HEADERS,
  messageRequest,
  signWebsiteActivation,
  storageFor,
  uploadRequest,
  uploadTiles,
} from './audit-harness';

const MAX_STATUS_CALLBACK_URL_LENGTH = 2048;
const PAST_ACTIVATION_CEILING_MILLISECONDS = 1_000_000;

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
          headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
          headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
        body: JSON.stringify({ activationToken: cappedStaff, storeUrl: STORE_ORIGIN }),
      }),
      env,
    );
    expect(cappedStaffResponse.status).toBe(401);
  });

  it('authorizes a public activation on both the bare and the www form of its store, and nowhere else', async () => {
    const bareOrigin = 'https://example-store.test';
    const wwwOrigin = 'https://www.example-store.test';
    const env = durableEnv();
    const exchangeOn = async (entitled: string, storeUrl: string): Promise<Response> =>
      worker.fetch(
        new Request('https://app-ai.test/audit/session/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
          body: JSON.stringify({
            activationToken: await activationToken(env, crypto.randomUUID(), {
              type: 'store-origin',
              storeOrigin: entitled,
            }),
            storeUrl,
          }),
        }),
        env,
      );

    const landedOnWww = await exchangeOn(bareOrigin, `${wwwOrigin}/collections/all`);
    expect(landedOnWww.status).toBe(201);
    expect((await exchangeOn(wwwOrigin, `${bareOrigin}/`)).status).toBe(201);
    expect((await exchangeOn(bareOrigin, 'https://WWW.Example-Store.test/')).status).toBe(201);
    for (const elsewhere of [
      'https://shop.example-store.test',
      'https://evilexample-store.test',
      'https://www.www.example-store.test',
      'https://example-store.test:8443',
      'https://example-store.test.evil.test',
    ]) {
      const refused = await exchangeOn(bareOrigin, `${elsewhere}/`);
      expect(refused.status, elsewhere).toBe(403);
      expect(await refused.json()).toMatchObject({ ExceptionType: 'AuditScopeException' });
    }

    const session = (await landedOnWww.json()) as { accessToken: string };
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(anthropicFileRecord('file-same-store')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const uploadFrom = (storeOrigin: string): Request => {
      const request = uploadRequest(session.accessToken, `tile-${storeOrigin.length}.webp`);
      request.headers.set('X-LimeSpot-Audit-Store-Origin', storeOrigin);
      return request;
    };
    expect((await worker.fetch(uploadFrom(wwwOrigin), env)).status).toBe(200);
    expect((await worker.fetch(uploadFrom(bareOrigin), env)).status).toBe(200);
    for (const elsewhere of ['https://shop.example-store.test', 'https://evilexample-store.test']) {
      const refused = await worker.fetch(uploadFrom(elsewhere), env);
      expect(refused.status, elsewhere).toBe(403);
    }
  });

  it('keeps one public audit authority across both forms of its store, and the authority refuses another store', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const env = durableEnv({ AUDIT_SESSION_TTL_SECONDS: '1' });
    const auditIdentifier = 'audit-stable-same-store';
    const exchangeOn = async (
      tokenIdentifier: string,
      entitledOrigin: string,
      storeUrl: string,
    ): Promise<Response> =>
      worker.fetch(
        new Request('https://app-ai.test/audit/session/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
          body: JSON.stringify({
            activationToken: await activationToken(
              env,
              tokenIdentifier,
              { type: 'store-origin', storeOrigin: entitledOrigin },
              'merchant@example.com',
              auditIdentifier,
            ),
            storeUrl,
          }),
        }),
        env,
      );

    const first = await exchangeOn(
      'same-store-first',
      'https://example-store.test',
      'https://www.example-store.test/',
    );
    expect(first.status).toBe(201);
    vi.advanceTimersByTime(2_000);
    const otherForm = await exchangeOn(
      'same-store-second',
      'https://www.example-store.test',
      'https://example-store.test/',
    );
    expect(otherForm.status).toBe(201);
    vi.advanceTimersByTime(2_000);
    const otherStore = await exchangeOn(
      'same-store-third',
      'https://shop.example-store.test',
      'https://shop.example-store.test/',
    );
    expect(otherStore.status).toBe(403);
    expect(await otherStore.json()).toMatchObject({
      ExceptionType: 'AuditScopeException',
      Message: 'The grader identity does not match its existing authority.',
    });
    vi.useRealTimers();
  });

  it('reports a public session under the store origin its activation signed, whichever form the tab opened', async () => {
    const env = durableEnv();
    const bareOrigin = 'https://example-store.test';
    const wwwOrigin = 'https://www.example-store.test';
    const exchanged = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
        body: JSON.stringify({
          activationToken: await activationToken(env, 'signed-origin-status', {
            type: 'store-origin',
            storeOrigin: bareOrigin,
          }),
          storeUrl: `${wwwOrigin}/collections/all`,
        }),
      }),
      env,
    );
    expect(exchanged.status).toBe(201);
    const session = (await exchanged.json()) as { accessToken: string };
    const reportedOrigins: unknown[] = [];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        reportedOrigins.push(
          (JSON.parse(String(init?.body)) as { storeOrigin: unknown }).storeOrigin,
        );
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const fromWww = (request: Request): Request => {
      request.headers.set('X-LimeSpot-Audit-Store-Origin', wwwOrigin);
      return request;
    };

    const upload = await worker.fetch(
      fromWww(uploadRequest(session.accessToken, 'tile.webp')),
      env,
    );
    expect(upload.status).toBe(200);
    const fileIdentifier = ((await upload.json()) as { id: string }).id;
    const proposal = await worker.fetch(
      fromWww(messageRequest(session.accessToken, [fileIdentifier])),
      env,
    );
    expect(proposal.status).toBe(200);

    await deliverStatusEvents(env);
    expect(reportedOrigins.length).toBeGreaterThan(0);
    expect(new Set(reportedOrigins)).toEqual(new Set([bareOrigin]));
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
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
        body: JSON.stringify({ activationToken: firstToken, storeUrl: STORE_ORIGIN }),
      }),
      env,
    );
    expect(replay.status).toBe(409);
    vi.useRealTimers();
  });

  it('lets a new activation supersede the active session, refusing the old token and carrying the audit', async () => {
    const env = durableEnv();
    stubFetch().mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 503 });
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const auditIdentifier = 'audit-superseded-public';
    const activation = (tokenIdentifier: string): Promise<string> =>
      activationToken(
        env,
        tokenIdentifier,
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      );
    const firstToken = await activation('superseded-first');
    const first = await exchange(env, firstToken);
    const firstTiles = await uploadTiles(env, first.accessToken, 1);
    expect((await worker.fetch(messageRequest(first.accessToken, firstTiles), env)).status).toBe(
      200,
    );
    const before = await storageFor(env, auditIdentifier).get<Record<string, unknown>>('session');

    const second = await exchange(env, await activation('superseded-second'));
    expect(second.sessionIdentifier).not.toBe(first.sessionIdentifier);

    for (const [label, request] of [
      ['upload', uploadRequest(first.accessToken, 'late.webp')],
      ['proposal', messageRequest(first.accessToken, firstTiles)],
    ] as const) {
      const refused = await worker.fetch(request, env);
      expect(refused.status, label).toBe(401);
      expect(await refused.json(), label).toEqual({
        Message: 'The grader session has expired.',
        ExceptionType: 'AuditAuthorizationException',
        MessageDetail: 'audit_session_expired',
      });
    }

    const carried = await storageFor(env, auditIdentifier).get<Record<string, unknown>>('session');
    expect(carried).toMatchObject({
      sessionIdentifier: second.sessionIdentifier,
      completedAttempts: 1,
      run: 1,
      runUploads: 0,
      runInferences: 0,
      runCompleted: false,
      fileIdentifiers: [],
      pending: {},
      statusOutbox: before?.statusOutbox,
      abandonedReservations: before?.abandonedReservations,
    });
    expect(carried?.consumedActivationIdentifiers).toHaveLength(2);

    const foreign = await worker.fetch(messageRequest(second.accessToken, firstTiles), env);
    expect(foreign.status).toBe(403);
    const secondTiles = await uploadTiles(env, second.accessToken, 1);
    expect((await worker.fetch(messageRequest(second.accessToken, secondTiles), env)).status).toBe(
      200,
    );

    const exhausted = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
        body: JSON.stringify({
          activationToken: await activation('superseded-third'),
          storeUrl: `${STORE_ORIGIN}/`,
        }),
      }),
      env,
    );
    expect(exhausted.status).toBe(429);
    const replay = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
        body: JSON.stringify({ activationToken: firstToken, storeUrl: `${STORE_ORIGIN}/` }),
      }),
      env,
    );
    expect(replay.status).toBe(409);
  }, 30_000);

  it('carries a reservation the superseded session still has in flight and finalizes it there', async () => {
    const env = durableEnv();
    const gate = (() => {
      let release = (): void => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    })();
    let arrived = (): void => {};
    const inferenceArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    stubFetch().mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 204 });
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      arrived();
      await gate.promise;
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const auditIdentifier = 'audit-superseded-in-flight';
    const activation = (tokenIdentifier: string): Promise<string> =>
      activationToken(
        env,
        tokenIdentifier,
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      );
    const first = await exchange(env, await activation('in-flight-first'));
    const tiles = await uploadTiles(env, first.accessToken, 1);
    const proposal = worker.fetch(messageRequest(first.accessToken, tiles), env);
    await inferenceArrived;

    await exchange(env, await activation('in-flight-second'));
    const pending = (await storageFor(env, auditIdentifier).get<Record<string, unknown>>('session'))
      ?.pending as Record<string, { sessionIdentifier?: string }>;
    expect(Object.values(pending)).toEqual([
      expect.objectContaining({ kind: 'message', sessionIdentifier: first.sessionIdentifier }),
    ]);

    gate.release();
    expect((await proposal).status).toBe(200);
    expect(await storageFor(env, auditIdentifier).get('session')).toMatchObject({
      completedAttempts: 1,
      pending: {},
    });
  }, 30_000);

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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
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

  it('holds a session to its upload allowance and releases reservations after upstream failure', async () => {
    const env = durableEnv({ AUDIT_RUN_HEADROOM: '1', AUDIT_MAX_RUNS: '1' });
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
    const env = durableEnv({ AUDIT_RUN_HEADROOM: '1', AUDIT_MAX_RUNS: '1' });
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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const failed = await worker.fetch(messageRequest(session.accessToken, []), missingSecretEnv);
    expect(failed.status).toBe(500);
    expect((await failed.json()) as unknown).toMatchObject({ ExceptionType: 'Exception' });
    expect(fetchedUrls(fetchMock).filter((url) => url.endsWith('/v1/messages'))).toEqual([]);
    // The reservation the authorization took is released, so the attempt is
    // reported failed and the next inference after the key is configured is
    // served instead of answering 409 until the session expires.
    await deliverStatusEvents(env);
    expect(callbacks.map(({ status, attemptNumber }) => [status, attemptNumber])).toEqual([
      ['started', 1],
      ['failed', 1],
    ]);
    const retried = await worker.fetch(messageRequest(session.accessToken, []), env);
    expect(retried.status).toBe(200);
    await deliverStatusEvents(env);
    expect(callbacks.map(({ status, attemptNumber }) => [status, attemptNumber])).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('releases an upload reservation when the tenant sealing key is rejected before dispatch', async () => {
    const env = durableEnv({ AUDIT_RUN_HEADROOM: '1', AUDIT_MAX_RUNS: '1' });
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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
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

    await deliverStatusEvents(env);
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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
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
    await deliverStatusEvents(env);
    expect(callbacks.map(({ status, attemptNumber }) => [status, attemptNumber])).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('reports a reply that is not a usable proposal as failed, so it does not count as a run', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const callbacks: Array<[unknown, unknown]> = [];
    const replies = [
      'I could not see the store clearly, so here is my best advice in prose.',
      '{"pages":',
      USABLE_PROPOSAL,
    ];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
        callbacks.push([event.status, event.attemptNumber]);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: replies.shift() ?? '' }])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const tiles = await uploadTiles(env, session.accessToken, 1);
    for (let reply = 0; reply < 3; reply += 1) {
      expect((await worker.fetch(messageRequest(session.accessToken, tiles), env)).status).toBe(
        200,
      );
    }

    await deliverStatusEvents(env);
    expect(callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('never spends a public run on a proposal the conductor would reject', async () => {
    const auditIdentifier = 'audit-consumer-shapes';
    const env = durableEnv();
    const session = await exchange(
      env,
      await activationToken(
        env,
        'consumer-shapes-token',
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      ),
    );
    const manifest = [
      'PAGE Home: DESKTOP TILES images 1-1, MOBILE TILES images 1-1, CANDIDATE ANCHORS 1..6',
      'PAGE Cart: DESKTOP TILES images 1-1, MOBILE TILES images 1-1, CANDIDATE ANCHORS 1..3',
      'Propose the placement plan for EACH page listed above.',
    ].join('\n');
    const box = { boxType: 'MostPopular', position: 'after', anchorNumber: 2 };
    const replies = [
      { pages: { Home: { boxes: [{}] }, Cart: { boxes: [] } } },
      { pages: { Home: { boxes: [box] } } },
      { pages: { Home: { boxes: [box] }, Cart: { boxes: [{ ...box, anchorNumber: 7 }] } } },
      { pages: { Home: { boxes: [box] }, Cart: { boxes: [] } } },
    ].map((proposal) => JSON.stringify(proposal));
    const callbacks: Array<[unknown, unknown]> = [];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
        callbacks.push([event.status, event.attemptNumber]);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: replies.shift() ?? '' }])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const tiles = await uploadTiles(env, session.accessToken, 1);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await worker.fetch(
        messageRequest(session.accessToken, tiles, manifest),
        env,
      );
      expect(response.status).toBe(200);
    }

    await deliverStatusEvents(env);
    expect(callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
    const stored = await storageFor(env, auditIdentifier).get<{ completedAttempts: number }>(
      'session',
    );
    expect(stored?.completedAttempts).toBe(1);
  });

  it('never spends a public run on a reply to a request without a readable manifest', async () => {
    const auditIdentifier = 'audit-manifest-required';
    const env = durableEnv();
    const session = await exchange(
      env,
      await activationToken(
        env,
        'manifest-required-token',
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      ),
    );
    const box = { boxType: 'MostPopular', position: 'after', anchorNumber: 2 };
    const replies = [
      { pages: { Home: { boxes: [box] } } },
      { pages: { Home: { boxes: [{ ...box, anchorNumber: 501 }] } } },
      { pages: { Home: { boxes: [box] } } },
    ].map((proposal) => JSON.stringify(proposal));
    const callbacks: Array<[unknown, unknown]> = [];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
        callbacks.push([event.status, event.attemptNumber]);
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: replies.shift() ?? '' }])),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const tiles = await uploadTiles(env, session.accessToken, 1);
    const wideManifest =
      'PAGE Home: DESKTOP TILES images 1-1, MOBILE TILES images 1-1, CANDIDATE ANCHORS 1..600';

    for (const manifest of ['Analyze this store.', wideManifest, wideManifest]) {
      const response = await worker.fetch(
        messageRequest(session.accessToken, tiles, manifest),
        env,
      );
      expect(response.status).toBe(200);
    }

    await deliverStatusEvents(env);
    expect(callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('retries a status event the website could not take from the alarm, in order, with the same body', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    expect((await worker.fetch(messageRequest(session.accessToken, []), env)).status).toBe(200);
    expect(callbackBodies).toEqual([]);
    await deliverStatusEvents(env);
    expect(callbackBodies).toHaveLength(1);
    await deliverStatusEvents(env);
    expect(callbackBodies, 'the retry waits for its backoff').toHaveLength(1);

    callbackAvailable = true;
    vi.setSystemTime(Date.now() + 60_000);
    await deliverStatusEvents(env);

    expect(callbackBodies).toHaveLength(3);
    expect(callbackBodies[1]).toBe(callbackBodies[0]);
    expect(callbackBodies.slice(1).map((body) => JSON.parse(body))).toMatchObject([
      { status: 'started', attemptNumber: 1 },
      { status: 'completed', attemptNumber: 1 },
    ]);
  });

  it('never makes an upload or inference wait on the website status callback', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    let markCallbackAttempted = (): void => {};
    const callbackAttempted = new Promise<void>((resolve) => {
      markCallbackAttempted = resolve;
    });
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        markCallbackAttempted();
        return new Promise<Response>(() => {});
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const waitedOnCallback = callbackAttempted.then(() => 'waited on the status callback');
    const tiles = await Promise.race([uploadTiles(env, session.accessToken, 1), waitedOnCallback]);
    expect(Array.isArray(tiles)).toBe(true);
    const proposal = await Promise.race([
      worker
        .fetch(messageRequest(session.accessToken, tiles as string[]), env)
        .then((response) => response.status),
      waitedOnCallback,
    ]);
    expect(proposal).toBe(200);
  });

  it('drops a status event the website refuses for good so the events behind it are delivered', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const delivered: Array<[unknown, number]> = [];
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        const event = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const status = event.status === 'started' ? 409 : 204;
        delivered.push([event.status, status]);
        return new Response(null, { status });
      }
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    expect((await worker.fetch(messageRequest(session.accessToken, []), env)).status).toBe(200);
    await deliverStatusEvents(env);

    expect(delivered).toEqual([
      ['started', 409],
      ['completed', 204],
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
      return new Response(
        JSON.stringify(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }])),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    expect((await worker.fetch(messageRequest(session.accessToken, []), env)).status).toBe(200);
    vi.advanceTimersByTime(PAST_ACTIVATION_CEILING_MILLISECONDS);
    const retry = await uploadTiles(env, session.accessToken, 1);
    expect((await worker.fetch(messageRequest(session.accessToken, retry), env)).status).toBe(200);

    await deliverStatusEvents(env);
    expect(callbackTargets).toEqual(Array.from({ length: 4 }, () => signedCallbackUrl));
    expect(callbackTargets).not.toContain(AUDIT_STATUS_CALLBACK_URL);
    vi.useRealTimers();
  });
});

describe('grader runs in one audit session', () => {
  const FIVE_PAGE_RUN_UPLOADS = 5 * 2 * 2;
  const GRADER_PAGES = ['Home', 'Collection', 'Product', 'Cart', 'Search'] as const;
  const WHOLE_STORE_SENDS = 4;
  const CALLS_PER_SEND = 3;
  const RUN_MESSAGES = (WHOLE_STORE_SENDS + GRADER_PAGES.length) * CALLS_PER_SEND;

  function wholeStoreManifest(pages: number = GRADER_PAGES.length): string {
    const names = ['Home', 'Collection', 'Product', 'Cart', 'Search', 'SlidingCart', 'Blog'];
    return names
      .slice(0, pages)
      .map((page, index) => {
        const desktop = index * 48 + 1;
        const mobile = desktop + 24;
        return `PAGE ${page}: DESKTOP TILES images ${desktop}-${desktop + 23}, MOBILE TILES images ${mobile}-${mobile + 23}, CANDIDATE ANCHORS 1..6`;
      })
      .join('\n');
  }

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
    proposal = USABLE_PROPOSAL,
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
        new Response(JSON.stringify(anthropicMessage([{ type: 'text', text: proposal }])), {
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

  it('keeps a later attempt within its upload allowance after earlier attempts failed before inference', async () => {
    const SEVEN_PAGE_ATTEMPT_UPLOADS = 7 * 2 * 2;
    const env = durableEnv();
    const session = await exchange(env);
    const upstream = graderUpstream(() => 200);

    await uploadTiles(env, session.accessToken, SEVEN_PAGE_ATTEMPT_UPLOADS);
    await uploadTiles(env, session.accessToken, SEVEN_PAGE_ATTEMPT_UPLOADS);
    const thirdAttempt = await uploadTiles(env, session.accessToken, SEVEN_PAGE_ATTEMPT_UPLOADS);
    const proposal = await worker.fetch(messageRequest(session.accessToken, thirdAttempt), env);

    expect(proposal.status).toBe(200);
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['completed', 1],
    ]);
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
    expect(await response.json()).toMatchObject({
      content: [{ type: 'text', text: USABLE_PROPOSAL }],
    });
    await deliverStatusEvents(env);
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

  const COUNTERPART_STORE_ORIGIN = STORE_ORIGIN.replace('https://', 'https://www.');

  async function reissueOnCounterpartForm(env: Env, auditIdentifier: string): Promise<string> {
    const reissued = await exchange(
      env,
      await activationToken(
        env,
        `${auditIdentifier}-reissued-token`,
        { type: 'store-origin', storeOrigin: COUNTERPART_STORE_ORIGIN },
        'merchant@example.com',
        auditIdentifier,
      ),
    );
    return reissued.sessionIdentifier;
  }

  it('releases a reservation at its own lease under its admitting origin while a counterpart-form session is active', async () => {
    const auditIdentifier = 'audit-expiry-reissued';
    const { env, upstream, proposal, sessionIdentifier, expiresAt, admittedAt } =
      await sessionExpiringDuringProposal(auditIdentifier);

    vi.setSystemTime(expiresAt + 1000);
    const reissuedSessionIdentifier = await reissueOnCounterpartForm(env, auditIdentifier);
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([['started', 1]]);

    vi.setSystemTime(admittedAt + LEASE_MILLISECONDS + 1000);
    await deliverStatusEvents(env);

    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
    ]);
    expect(upstream.callbackEvents.at(-1)).toMatchObject({
      sessionIdentifier,
      storeOrigin: STORE_ORIGIN,
    });
    const record = await storedRunSession(env, auditIdentifier);
    expect(record.sessionIdentifier).toBe(reissuedSessionIdentifier);
    expect(record.pending).toEqual({});
    upstream.releaseHeldInference();
    await proposal;
  });

  it('finalizes a carried proposal under its admitting origin after a counterpart-form session replaced its own', async () => {
    const auditIdentifier = 'audit-expiry-reissued-finalized';
    const { env, upstream, proposal, sessionIdentifier, expiresAt } =
      await sessionExpiringDuringProposal(auditIdentifier);

    vi.setSystemTime(expiresAt + 1000);
    await reissueOnCounterpartForm(env, auditIdentifier);
    upstream.releaseHeldInference();
    expect((await proposal).status).toBe(200);
    await deliverStatusEvents(env);

    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['completed', 1],
    ]);
    expect(
      upstream.callbackEvents.map((event) => [event.sessionIdentifier, event.storeOrigin]),
    ).toEqual([
      [sessionIdentifier, STORE_ORIGIN],
      [sessionIdentifier, STORE_ORIGIN],
    ]);
  });

  it('reports a reservation an earlier worker admitted under the origin of the session it was carried out of', async () => {
    const auditIdentifier = 'audit-expiry-reissued-unstamped';
    const { env, upstream, proposal, sessionIdentifier, expiresAt, admittedAt } =
      await sessionExpiringDuringProposal(auditIdentifier);
    const storage = storageFor(env, auditIdentifier);
    const stored = (await storage.get<Record<string, unknown>>('session')) as {
      pending: Record<string, Record<string, unknown>>;
    };
    await storage.put('session', {
      ...stored,
      pending: Object.fromEntries(
        Object.entries(stored.pending).map(
          ([identifier, { storeOrigin: _origin, ...reservation }]) => [identifier, reservation],
        ),
      ),
    });

    vi.setSystemTime(expiresAt + 1000);
    await reissueOnCounterpartForm(env, auditIdentifier);
    vi.setSystemTime(admittedAt + LEASE_MILLISECONDS + 1000);
    await deliverStatusEvents(env);

    expect(upstream.callbackEvents.at(-1)).toMatchObject({
      status: 'failed',
      sessionIdentifier,
      storeOrigin: STORE_ORIGIN,
    });
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
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([
      ['started', 1],
      ['failed', 1],
      ['started', 1],
      ['completed', 1],
    ]);
  });

  it('keeps the latest two sessions of abandoned reservations when it abandons another', async () => {
    const auditIdentifier = 'audit-abandoned-retention';
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
    const upstream = graderUpstream((inference) => (inference === 1 ? 'hold' : 200));
    const tiles = await uploadTiles(env, session.accessToken, 2);
    const retained = 2 * 4 * (672 + 66);
    const storage = storageFor(env, auditIdentifier);
    const record = await storedRunSession(env, auditIdentifier);
    await storage.put('session', {
      ...record,
      abandonedReservations: Array.from({ length: retained }, (_, index) => `seeded-${index}`),
    });

    const abandoned = worker.fetch(messageRequest(session.accessToken, tiles), env);
    await vi.waitFor(() => expect(upstream.inferenceCalls()).toBe(1));
    expect((await worker.fetch(messageRequest(session.accessToken, tiles), env)).status).toBe(200);

    const kept = (await storage.get<{ abandonedReservations: string[] }>('session'))
      ?.abandonedReservations;
    expect(kept).toHaveLength(retained);
    expect(kept?.[0]).toBe('seeded-1');
    expect(kept?.at(-1)).not.toMatch(/^seeded-/u);
    upstream.releaseHeldInference();
    expect((await abandoned).status).toBe(200);
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
    await deliverStatusEvents(env);
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
    readonly runUploads: number;
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
      readonly fileReferences: readonly string[];
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
      fileIdentifiers: counts.fileReferences,
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
    await deliverStatusEvents(env);
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
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      fileReferences: tiles,
    });

    expect((await worker.fetch(messageRequest(accessToken, tiles), env)).status).toBe(200);
    expect((await worker.fetch(messageRequest(accessToken, tiles), env)).status).toBe(200);
    await deliverStatusEvents(env);
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
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      fileReferences: tiles,
    });

    await uploadTiles(env, accessToken, 1);
    expect((await worker.fetch(messageRequest(accessToken, tiles), env)).status).toBe(403);
  });

  it('counts a retry uploaded before its session was stored without runs and proposed after', async () => {
    const auditIdentifier = 'audit-stored-without-runs-uploaded-retry';
    const { env, accessToken, tiles, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
    );
    const retry = await uploadTiles(env, accessToken, 2);
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      fileReferences: [...tiles, ...retry],
    });

    expect((await worker.fetch(messageRequest(accessToken, retry), env)).status).toBe(200);
    await deliverStatusEvents(env);
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
    const { env, accessToken, tiles, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      (inference) => (inference === 2 ? 'hold' : 200),
    );
    const retry = await uploadTiles(env, accessToken, 2);
    const proposal = worker.fetch(messageRequest(accessToken, retry), env);
    await vi.waitFor(() => expect(upstream.inferenceCalls()).toBe(2));
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      pendingAttemptNumber: 2,
      fileReferences: [...tiles, ...retry],
    });

    upstream.releaseHeldInference();
    expect((await proposal).status).toBe(200);
    await deliverStatusEvents(env);
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
    const { env, accessToken, tiles, upstream } = await sessionWithCompletedProposal(
      auditIdentifier,
      () => 200,
      (upload) => upload === 3,
    );
    const late = worker.fetch(uploadRequest(accessToken, 'late.webp'), env);
    await vi.waitFor(() => expect(upstream.uploadCalls()).toBe(3));
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 1,
      messageCount: 1,
      fileReferences: tiles,
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
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([
      ['started', 2],
      ['completed', 2],
    ]);
  });

  it('records each owned file by the digest of its reference and admits ownership stored as file references', async () => {
    const auditIdentifier = 'audit-run-recorded-by-references';
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
    const upstream = graderUpstream(() => 200);
    const tiles = await uploadTiles(env, session.accessToken, 2);
    const record = await storedRunSession(env, auditIdentifier);
    expect(record.fileIdentifiers).toHaveLength(2);
    for (const digest of record.fileIdentifiers) {
      expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(tiles).not.toContain(digest);
    }

    await storageFor(env, auditIdentifier).put('session', { ...record, fileIdentifiers: tiles });

    expect((await worker.fetch(messageRequest(session.accessToken, tiles), env)).status).toBe(200);
    expect(upstream.inferenceCalls()).toBe(1);
  });

  it('writes the totals and run upload count that rolled-back workers enforce their limits from', async () => {
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
      runUploads: 1,
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
        storeOrigin: STORE_ORIGIN,
        admittedAt: expect.any(Number),
      },
    ]);

    upstream.releaseHeldUploads();
    expect((await held).status).toBe(200);
    expect(await storedRunSession(env, auditIdentifier)).toMatchObject({
      runUploads: 2,
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
    await storeWithoutRuns(env, auditIdentifier, {
      completedAttempts: 2,
      messageCount: 2,
      fileReferences: tiles,
    });

    await refusedForExhaustedAttempts(worker.fetch(messageRequest(accessToken, tiles), env));
    await refusedForExhaustedAttempts(
      worker.fetch(uploadRequest(accessToken, 'third-run.webp'), env),
    );
    expect(upstream.inferenceCalls()).toBe(1);
    await deliverStatusEvents(env);
    expect(upstream.callbacks).toEqual([]);
  });

  it('holds one run to 66 proposal inferences, its worst-case plan times the headroom', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    graderUpstream(() => 503);
    const tiles = await uploadTiles(env, session.accessToken, 1);

    for (let inference = 1; inference <= 66; inference += 1) {
      const response = await worker.fetch(messageRequest(session.accessToken, tiles), env);
      expect(response.status, `inference ${inference}`).toBe(503);
    }
    const refused = await worker.fetch(messageRequest(session.accessToken, tiles), env);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      Message: 'The grader run limit has been reached.',
      ExceptionType: 'AuditQuotaException',
    });
  });

  it('lets two worst-case Studio-capture runs, each with every resend and per-page retry, through one session', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    const upstream = graderUpstream(
      (inference) =>
        ((inference - 1) % RUN_MESSAGES) + 1 < WHOLE_STORE_SENDS * CALLS_PER_SEND ? 503 : 200,
      () => false,
      JSON.stringify({
        pages: Object.fromEntries(GRADER_PAGES.map((page) => [page, { boxes: [] }])),
      }),
    );

    for (let run = 1; run <= 2; run += 1) {
      const tiles = await uploadTiles(env, session.accessToken, GRADER_PAGES.length * 2 * 24);
      for (let send = 1; send <= WHOLE_STORE_SENDS * CALLS_PER_SEND; send += 1) {
        const response = await worker.fetch(
          messageRequest(session.accessToken, tiles, wholeStoreManifest()),
          env,
        );
        expect(response.status, `run ${run} whole-store call ${send}`).toBe(
          send < WHOLE_STORE_SENDS * CALLS_PER_SEND ? 503 : 200,
        );
      }
      for (const [index, page] of GRADER_PAGES.entries()) {
        const pageTiles = tiles.slice(index * 48, (index + 1) * 48);
        for (let call = 1; call <= CALLS_PER_SEND; call += 1) {
          const response = await worker.fetch(
            messageRequest(
              session.accessToken,
              pageTiles,
              `PAGE: ${page}\nCANDIDATE ANCHORS: 1..6`,
              'onboarding-batch',
            ),
            env,
          );
          expect(response.status, `run ${run} ${page} call ${call}`).toBe(200);
        }
      }
    }

    expect(upstream.uploadCalls()).toBe(2 * 240);
    expect(upstream.inferenceCalls()).toBe(2 * RUN_MESSAGES);
    const third = await worker.fetch(uploadRequest(session.accessToken, 'third.webp'), env);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({
      Message: 'This public grader has no attempts remaining.',
      ExceptionType: 'AuditQuotaException',
    });
  }, 30_000);

  it('holds a session to 2688 uploads, four worst-case runs times the headroom, one run owning them all inside the Durable Object entry limit', async () => {
    const auditIdentifier = 'audit-session-upload-allowance';
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
    const upstream = graderUpstream(() => 200);

    const tiles = await uploadTiles(env, session.accessToken, 2688);
    const refused = await worker.fetch(uploadRequest(session.accessToken, 'over.webp'), env);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({
      Message: 'The grader run limit has been reached.',
      ExceptionType: 'AuditQuotaException',
    });
    expect(upstream.uploadCalls()).toBe(2688);
    const proposal = await worker.fetch(
      messageRequest(session.accessToken, [...tiles.slice(0, 1), ...tiles.slice(-1)]),
      env,
    );
    expect(proposal.status).toBe(200);
    expect(storageFor(env, auditIdentifier).largestEntryBytes).toBeLessThan(
      DURABLE_OBJECT_ENTRY_LIMIT_BYTES / 4,
    );
  }, 30_000);

  it('admits a whole-store proposal naming every tile of a worst-case seven-page run', async () => {
    const env = durableEnv();
    const session = await exchange(env);
    graderUpstream(() => 200);
    const tiles = await uploadTiles(env, session.accessToken, 7 * 2 * 24);

    const proposal = await worker.fetch(
      messageRequest(session.accessToken, tiles, wholeStoreManifest(7)),
      env,
    );

    expect(proposal.status).toBe(200);
  });
});

describe('audit plan versions', () => {
  const PLAN_VERSION_HEADER = 'X-LimeSpot-Audit-Plan-Version';

  interface CountingUpstream {
    readonly uploads: () => number;
    readonly inferences: () => number;
  }

  function countingUpstream(): CountingUpstream {
    let uploads = 0;
    let inferences = 0;
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    stubFetch().mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 204 });
      if (url.endsWith('/v1/files')) {
        uploads += 1;
        return json(anthropicFileRecord(crypto.randomUUID()));
      }
      inferences += 1;
      return json(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }]));
    });
    return { uploads: () => uploads, inferences: () => inferences };
  }

  function exchangeRequest(activation: string, planVersion: string | undefined): Request {
    return declaring(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
        body: JSON.stringify({ activationToken: activation, storeUrl: `${STORE_ORIGIN}/` }),
      }),
      planVersion,
    );
  }

  function declaring(request: Request, planVersion: string | undefined): Request {
    if (planVersion !== undefined) request.headers.set(PLAN_VERSION_HEADER, planVersion);
    return request;
  }

  async function auditActivation(env: Env, auditIdentifier: string): Promise<string> {
    return activationToken(
      env,
      `${auditIdentifier}-token`,
      { type: 'store-origin', storeOrigin: STORE_ORIGIN },
      'merchant@example.com',
      auditIdentifier,
    );
  }

  async function expectUnsupportedPlan(response: Response, label: string): Promise<void> {
    expect(response.status, label).toBe(409);
    expect(await response.json(), label).toEqual({
      Message: 'This grader version is not supported. Update the LimeSpot extension and try again.',
      ExceptionType: 'AuditPlanVersionException',
      MessageDetail: 'audit_plan_version_unsupported',
    });
  }

  for (const [label, planVersion] of [
    ['plan version 1', '1'],
    ['plan version 2', '2'],
    ['no plan version from a build naming its build time', undefined],
  ] as const) {
    it(`admits a grader naming ${label} through exchange, upload and inference`, async () => {
      const env = durableEnv();
      const upstream = countingUpstream();

      const exchanged = await worker.fetch(
        exchangeRequest(
          await auditActivation(env, `audit-plan-${planVersion ?? 'none'}`),
          planVersion,
        ),
        env,
      );
      expect(exchanged.status).toBe(201);
      const { accessToken } = (await exchanged.json()) as { accessToken: string };
      const upload = await worker.fetch(
        declaring(uploadRequest(accessToken, 'tile.webp'), planVersion),
        env,
      );
      expect(upload.status).toBe(200);
      const { id } = (await upload.json()) as { id: string };
      const proposal = await worker.fetch(
        declaring(messageRequest(accessToken, [id]), planVersion),
        env,
      );

      expect(proposal.status).toBe(200);
      expect(upstream.uploads()).toBe(1);
      expect(upstream.inferences()).toBe(1);
    });
  }

  it('holds a grader naming no plan version, plan version 1, or plan version 2 to the same 66-inference run ceiling', async () => {
    const env = durableEnv();
    countingUpstream();
    const session = await exchange(env);
    const tiles = await uploadTiles(env, session.accessToken, 1);

    for (const planVersion of ['1', '2', undefined]) {
      const response = await worker.fetch(
        declaring(messageRequest(session.accessToken, tiles), planVersion),
        env,
      );
      expect(response.status).toBe(200);
    }
    for (let inference = 4; inference <= 66; inference += 1) {
      const response = await worker.fetch(messageRequest(session.accessToken, tiles), env);
      expect(response.status, `inference ${inference}`).toBe(200);
    }
    const refused = await worker.fetch(messageRequest(session.accessToken, tiles), env);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ ExceptionType: 'AuditQuotaException' });
  });

  it('refuses a plan version this worker holds no allowance for with 409, before the exchange consumes its activation or a request reserves quota', async () => {
    const auditIdentifier = 'audit-plan-unsupported';
    const env = durableEnv();
    const upstream = countingUpstream();
    const activation = await auditActivation(env, auditIdentifier);

    await expectUnsupportedPlan(
      await worker.fetch(exchangeRequest(activation, '3'), env),
      'exchange',
    );
    const exchanged = await worker.fetch(exchangeRequest(activation, '1'), env);
    expect(exchanged.status).toBe(201);
    const { accessToken } = (await exchanged.json()) as { accessToken: string };

    for (const planVersion of ['3', '0', '01', '2.0', 'v2', '']) {
      await expectUnsupportedPlan(
        await worker.fetch(declaring(uploadRequest(accessToken, 'tile.webp'), planVersion), env),
        `upload naming "${planVersion}"`,
      );
    }
    const upload = await worker.fetch(declaring(uploadRequest(accessToken, 'tile.webp'), '1'), env);
    expect(upload.status).toBe(200);
    const { id } = (await upload.json()) as { id: string };
    await expectUnsupportedPlan(
      await worker.fetch(declaring(messageRequest(accessToken, [id]), '3'), env),
      'inference',
    );

    expect(upstream.uploads()).toBe(1);
    expect(upstream.inferences()).toBe(0);
    expect(
      await storageFor(env, auditIdentifier).get<Record<string, unknown>>('session'),
    ).toMatchObject({ uploadCount: 1, runUploads: 1, runInferences: 0, pending: {} });
  });

  it('lets a browser preflight carry the plan version header', async () => {
    const preflight = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'OPTIONS',
        headers: {
          Origin: STORE_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': `authorization, ${PLAN_VERSION_HEADER.toLowerCase()}`,
        },
      }),
      durableEnv(),
    );

    expect(preflight.headers.get('Access-Control-Allow-Headers')?.split(', ')).toContain(
      PLAN_VERSION_HEADER,
    );
    expect(preflight.headers.get('Access-Control-Allow-Headers')?.split(', ')).toContain(
      'X-LimeSpot-Extension-Built-At',
    );
  });
});

describe('audit session record bounds', () => {
  const LONGEST_AUDIT_IDENTIFIER = `audit-${'x'.repeat(122)}`;
  const SESSION_SECONDS = Number(ENV.AUDIT_SESSION_TTL_SECONDS);

  interface OutageUpstream {
    readonly inferences: () => number;
    readonly endOutage: () => void;
  }

  function outageUpstream(): OutageUpstream {
    let outage = true;
    let inferences = 0;
    stubFetch().mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) {
        return new Response(null, { status: outage ? 503 : 204 });
      }
      if (url.endsWith('/v1/files')) {
        return new Response(JSON.stringify(anthropicFileRecord(crypto.randomUUID())), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      inferences += 1;
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'unavailable' } }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    });
    return {
      inferences: () => inferences,
      endOutage: () => {
        outage = false;
      },
    };
  }

  async function exchangeFor(env: Env, tokenIdentifier: string): Promise<string> {
    const session = await exchange(
      env,
      await activationToken(
        env,
        tokenIdentifier,
        { type: 'store-origin', storeOrigin: STORE_ORIGIN },
        'merchant@example.com',
        LONGEST_AUDIT_IDENTIFIER,
      ),
    );
    return session.accessToken;
  }

  async function expectBacklog(response: Response): Promise<void> {
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      Message: 'The grader is still delivering earlier status updates. Try again in a few minutes.',
      ExceptionType: 'AuditSessionBacklogException',
    });
  }

  it('refuses new work before a callback outage across reissued sessions at maximum inference churn carries the record to the entry limit, and resumes once delivery drains it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const env = durableEnv();
    const upstream = outageUpstream();
    let refused: { kind: 'upload' | 'message'; accessToken: string; tiles: string[] } | null = null;
    let sessions = 0;

    while (refused === null && sessions < 12) {
      sessions += 1;
      const accessToken = await exchangeFor(env, `outage-session-${sessions}`);
      for (let run = 1; run <= 4 && refused === null; run += 1) {
        const upload = await worker.fetch(
          uploadRequest(accessToken, `session-${sessions}-run-${run}.webp`),
          env,
        );
        if (upload.status === 503) {
          await expectBacklog(upload);
          refused = { kind: 'upload', accessToken, tiles: [] };
          break;
        }
        expect(upload.status, `session ${sessions} run ${run} upload`).toBe(200);
        const tiles = [((await upload.json()) as { id: string }).id];
        for (let inference = 1; inference <= 66; inference += 1) {
          const before = upstream.inferences();
          const response = await worker.fetch(messageRequest(accessToken, tiles), env);
          if (response.status === 503) {
            await expectBacklog(response);
            expect(upstream.inferences()).toBe(before);
            refused = { kind: 'message', accessToken, tiles };
            break;
          }
          expect(response.status, `session ${sessions} run ${run} inference ${inference}`).toBe(
            502,
          );
        }
        await deliverStatusEvents(env);
      }
      if (refused === null) {
        vi.setSystemTime(Date.now() + (SESSION_SECONDS + 1) * 1000);
        await deliverStatusEvents(env);
      }
    }

    expect(refused, 'the record never reached its budget').not.toBeNull();
    expect(sessions).toBeGreaterThan(1);
    const storage = storageFor(env, LONGEST_AUDIT_IDENTIFIER);
    expect(storage.largestEntryBytes).toBeLessThan(DURABLE_OBJECT_ENTRY_LIMIT_BYTES * 0.6);
    const backlog = await storage.get<{ statusOutbox: unknown[] }>('session');
    expect(backlog?.statusOutbox.length).toBeGreaterThan(528);

    upstream.endOutage();
    vi.setSystemTime(Date.now() + 61_000);
    await deliverStatusEvents(env);
    expect((await storage.get<{ statusOutbox: unknown[] }>('session'))?.statusOutbox).toEqual([]);

    if (refused === null) throw new Error('unreachable');
    const resumed =
      refused.kind === 'upload'
        ? await worker.fetch(uploadRequest(refused.accessToken, 'resumed.webp'), env)
        : await worker.fetch(messageRequest(refused.accessToken, refused.tiles), env);
    expect(resumed.status).toBe(refused.kind === 'upload' ? 200 : 502);
  }, 120_000);

  it('keeps the latest 1,024 consumed activations, more than one activation lifetime can exchange', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const env = durableEnv();
    outageUpstream();
    await exchangeFor(env, 'retention-first');
    const storage = storageFor(env, LONGEST_AUDIT_IDENTIFIER);
    const record = await storage.get<Record<string, unknown>>('session');
    await storage.put('session', {
      ...record,
      consumedActivationIdentifiers: Array.from(
        { length: 1024 },
        (_, index) => `seeded-activation-${index}`,
      ),
    });

    vi.setSystemTime(Date.now() + (SESSION_SECONDS + 1) * 1000);
    const freshToken = await activationToken(
      env,
      'retention-fresh',
      { type: 'store-origin', storeOrigin: STORE_ORIGIN },
      'merchant@example.com',
      LONGEST_AUDIT_IDENTIFIER,
    );
    await exchange(env, freshToken);

    const kept = (await storage.get<{ consumedActivationIdentifiers: string[] }>('session'))
      ?.consumedActivationIdentifiers;
    expect(kept).toHaveLength(1024);
    expect(kept?.[0]).toBe('seeded-activation-1');
    expect(kept?.at(-1)).toBe('retention-fresh');
    const replay = await worker.fetch(
      new Request('https://app-ai.test/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...EXTENSION_BUILD_HEADERS },
        body: JSON.stringify({ activationToken: freshToken, storeUrl: `${STORE_ORIGIN}/` }),
      }),
      env,
    );
    expect(replay.status).toBe(409);
  });
});
