/**
 * GET /prompts — the master-gated routing diagnostics.
 *
 * Driven through the real router so the context-ID validation, the master
 * check, the unknown-route answer, and both accepted credential positions
 * (header and query parameter) are all exercised on the actual HTTP path.
 * Personalizer, Seq, and every provider are mocked; no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { handleHealth } from '../src/handlers/health';
import { PROMPTS_CONTEXT_ID_PARAMETER } from '../src/handlers/prompts';
import { listPromptNames } from '../src/prompt-registry';
import type { Env } from '../src/config';
import { CORS, ENV, fetchCall, headerOf, stubFetch, type FetchMock } from './helpers';

interface PromptRouteView {
  name: string;
  group: string;
  tier: string;
  model: string | null;
  provider: string | null;
  apiFamily: string | null;
  filePolicy: string | null;
  modelProfile: string | null;
  requirements: string[];
  inlineCacheBreakpoints: boolean | null;
  valid: boolean;
  error?: string;
}

interface PromptsBody {
  prompts: PromptRouteView[];
  missingSecrets: string[];
}

const MASTER_CONTEXT_ID = 'ctx-master';
const MERCHANT_CONTEXT_ID = 'ctx-merchant';

/** Personalizer answers the validate call; every other host is a test failure. */
function stubPersonalizer(subscriberId: number | undefined): FetchMock {
  return stubFetch().mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v2/administrator-authentication/validate-context-id')) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            subscriberId === undefined
              ? { SubscriberTitle: 'Unknown' }
              : { SubscriberID: subscriberId, SubscriberTitle: 'Store' },
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function promptsRequest(contextId: string | null = MASTER_CONTEXT_ID): Request {
  return new Request('https://app-ai.test/prompts', {
    headers: contextId === null ? {} : { 'X-Personalizer-Context-ID': contextId },
  });
}

/** The same route with the context-ID in the URL, optionally alongside a header. */
function promptsUrlRequest(urlContextId: string, headerContextId?: string): Request {
  const url = new URL('https://app-ai.test/prompts');
  url.searchParams.set(PROMPTS_CONTEXT_ID_PARAMETER, urlContextId);
  return new Request(url, {
    headers: headerContextId === undefined ? {} : { 'X-Personalizer-Context-ID': headerContextId },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GET /prompts — master gate', () => {
  it('serves the master subscriber every registered prompt with its resolved route', async () => {
    stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID));
    const response = await worker.fetch(promptsRequest(), ENV);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PromptsBody;

    expect(body.prompts.map((prompt) => prompt.name)).toEqual([...listPromptNames()]);
    for (const prompt of body.prompts) {
      expect(prompt.valid, `${prompt.name}: ${prompt.error ?? ''}`).toBe(true);
      const free = prompt.name === 'visual-verify-free';
      expect(prompt.provider).toBe(free ? 'cloudflare' : 'anthropic');
      expect(prompt.apiFamily).toBe(free ? 'cloudflare-workers-ai' : 'anthropic-messages');
      expect(prompt.filePolicy).toBe(free ? 'cloudflare-inline' : 'anthropic-provider-files');
      expect(['fast', 'balanced', 'frontier']).toContain(prompt.tier);
      expect(prompt.requirements.length).toBeGreaterThan(0);
      expect(prompt.inlineCacheBreakpoints).toBe(!free);
      expect(prompt.error).toBeUndefined();
    }
    const placement = body.prompts.find((prompt) => prompt.name === 'placement');
    expect(placement).toMatchObject({
      group: 'placement-vision',
      tier: 'fast',
      model: ENV.MODEL_FAST,
      modelProfile: 'claude-haiku',
    });
  });

  it('answers a validated non-master merchant exactly as it answers a route that does not exist', async () => {
    stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID) + 1);
    const promptsResponse = await worker.fetch(promptsRequest(MERCHANT_CONTEXT_ID), ENV);
    const unknownRouteResponse = await worker.fetch(
      new Request('https://app-ai.test/no-such-route', {
        headers: { 'X-Personalizer-Context-ID': MERCHANT_CONTEXT_ID },
      }),
      ENV,
    );
    expect(promptsResponse.status).toBe(404);
    expect(promptsResponse.status).toBe(unknownRouteResponse.status);
    const body = await promptsResponse.text();
    expect(body).toBe(await unknownRouteResponse.text());
    expect(JSON.parse(body)).toEqual({
      Message: 'Resource not found.',
      ExceptionType: 'RecordNotFoundException',
    });
  });

  it('answers a validation payload carrying no SubscriberID as unknown too', async () => {
    stubPersonalizer(undefined);
    const response = await worker.fetch(promptsRequest(MERCHANT_CONTEXT_ID), ENV);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ExceptionType: 'RecordNotFoundException' });
  });

  it('requires a context-ID like every other authenticated route', async () => {
    const fetchMock = stubFetch();
    const response = await worker.fetch(promptsRequest(null), ENV);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ExceptionType: 'MissingContextIDException' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a prompt whose configured model cannot serve it, with the reason', async () => {
    stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID));
    // onboarding-visual declares `reasoning`; Haiku carries no reasoning control.
    const env: Env = { ...ENV, MODEL_BALANCED: 'claude-haiku-4-5' };
    const response = await worker.fetch(promptsRequest(), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PromptsBody;
    const broken = body.prompts.find((prompt) => prompt.name === 'onboarding-batch');
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toMatch(/requires reasoning/);
    expect(broken?.provider).toBeNull();
    expect(broken?.inlineCacheBreakpoints).toBeNull();
    // A prompt on an unaffected tier still reports as routable.
    expect(body.prompts.find((prompt) => prompt.name === 'chat')?.valid).toBe(true);
  });

  it("reports a prompt whose configured model's output limit is not recorded", async () => {
    stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID));
    const env: Env = {
      ...ENV,
      MODEL_OVERRIDES: `${ENV.MODEL_OVERRIDES},onboarding-visual=gpt-4.1,onboarding-qc-gate=gpt-4.1`,
    };
    const response = await worker.fetch(promptsRequest(), env);
    const body = (await response.json()) as PromptsBody;
    const broken = body.prompts.find((prompt) => prompt.name === 'onboarding-batch-all');
    expect(broken?.valid).toBe(false);
    expect(broken?.error).toMatch(/No maximum output is recorded for model "gpt-4\.1"/);
    expect(body.prompts.find((prompt) => prompt.name === 'probe-currency')?.valid).toBe(true);
  });

  it('reports which prompts run on a provider that ignores their cache markers', async () => {
    stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID));
    // Gemini caches a stable prefix implicitly and honours no per-block marker.
    const env: Env = { ...ENV, MODEL_FAST: 'gemini-3.5-flash' };
    const response = await worker.fetch(promptsRequest(), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PromptsBody;
    const placement = body.prompts.find((prompt) => prompt.name === 'placement');
    expect(placement).toMatchObject({
      valid: true,
      provider: 'gemini',
      model: 'gemini-3.5-flash',
      inlineCacheBreakpoints: false,
    });
    expect(body.prompts.find((prompt) => prompt.name === 'chat')).toMatchObject({
      provider: 'anthropic',
      inlineCacheBreakpoints: true,
    });
  });

  it('names the blank required secrets and nothing about the ones that are set', async () => {
    stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID));
    const complete = (await (await worker.fetch(promptsRequest(), ENV)).json()) as PromptsBody;
    expect(complete.missingSecrets).toEqual([]);

    // Every route here is Anthropic, so a blank OpenAI key is not missing — the
    // provider's key is required only while some resolved route uses it.
    const { OPENAI_API_KEY: _openai, TOKEN_ENCRYPTION_SECRET: _sealing, ...partial } = ENV;
    const response = await worker.fetch(promptsRequest(), partial);
    const body = (await response.json()) as PromptsBody;
    expect([...body.missingSecrets].sort()).toEqual(['TOKEN_ENCRYPTION_SECRET']);

    // Route one whole file route onto OpenAI and its key becomes required.
    const routed = await worker.fetch(promptsRequest(), {
      ...partial,
      MODEL_OVERRIDES: 'onboarding-visual=gpt-5.2,onboarding-qc-gate=gpt-5.2',
    });
    const routedBody = (await routed.json()) as PromptsBody;
    expect([...routedBody.missingSecrets].sort()).toEqual([
      'OPENAI_API_KEY',
      'TOKEN_ENCRYPTION_SECRET',
    ]);

    // Names only: no value, no prefix, no length, and nothing about a set secret.
    const serialized = JSON.stringify(body);
    for (const secret of [
      ENV.CLAUDE_API_KEY,
      ENV.OPENAI_API_KEY,
      ENV.PERSONALIZER_INTEGRATION_BRIDGE_TOKEN,
      ENV.AUDIT_SESSION_SIGNING_SECRET,
    ]) {
      if (!secret) throw new Error('the Env fixture must carry every secret');
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(secret.slice(0, 4));
    }
    expect(serialized).not.toContain('CLAUDE_API_KEY');
    expect(serialized).not.toMatch(/length|prefix|redacted|\*{3}/i);
  });

  it('accepts the master context-ID from the URL, so the diagnostics open in a browser', async () => {
    const fetchMock = stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID));
    const response = await worker.fetch(promptsUrlRequest(MASTER_CONTEXT_ID), ENV);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PromptsBody;
    expect(body.prompts.map((prompt) => prompt.name)).toEqual([...listPromptNames()]);
    // The URL credential is validated exactly like a header one — same call, same shape.
    const { init } = fetchCall(fetchMock, 0);
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBe(MASTER_CONTEXT_ID);
  });

  it('prefers the header when a request carries a context-ID in both positions', async () => {
    // Only MASTER_CONTEXT_ID resolves to the master subscriber.
    stubFetch().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('/v2/administrator-authentication/validate-context-id')) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      const sent = headerOf(init ?? {}, 'X-Personalizer-Context-ID');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            SubscriberID:
              sent === MASTER_CONTEXT_ID
                ? Number(ENV.MASTER_SUBSCRIBER_ID)
                : Number(ENV.MASTER_SUBSCRIBER_ID) + 1,
            SubscriberTitle: 'Store',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    });
    const headerWins = await worker.fetch(
      promptsUrlRequest(MASTER_CONTEXT_ID, MERCHANT_CONTEXT_ID),
      ENV,
    );
    expect(headerWins.status).toBe(404);
    const urlOnly = await worker.fetch(promptsUrlRequest(MASTER_CONTEXT_ID), ENV);
    expect(urlOnly.status).toBe(200);
  });

  it('answers a non-master URL context-ID exactly as it answers one carrying no credential', async () => {
    // Only this route reads the query parameter, so a URL credential that is not
    // the master must not produce an answer any other path would not: it gets
    // the credential-less answer, not the unknown-route one a header gets.
    stubPersonalizer(Number(ENV.MASTER_SUBSCRIBER_ID) + 1);
    const fromUrl = await worker.fetch(promptsUrlRequest(MERCHANT_CONTEXT_ID), ENV);
    const withoutCredential = await worker.fetch(promptsRequest(null), ENV);
    expect(fromUrl.status).toBe(401);
    expect(fromUrl.status).toBe(withoutCredential.status);
    const body = await fromUrl.text();
    expect(body).toBe(await withoutCredential.text());
    expect(JSON.parse(body) as unknown).toEqual({
      Message: 'Missing Context ID.',
      ExceptionType: 'MissingContextIDException',
    });
    // A header credential keeps the unknown-route answer, which every other
    // path also gives a validated non-master.
    const fromHeader = await worker.fetch(promptsRequest(MERCHANT_CONTEXT_ID), ENV);
    expect(fromHeader.status).toBe(404);
  });

  it('answers a rejected URL context-ID exactly as it answers one carrying no credential', async () => {
    // Relaying Personalizer's rejection here would confirm both that this route
    // reads the parameter and that an unauthenticated guess reached Personalizer.
    const fetchMock = stubFetch().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/v2/administrator-authentication/validate-context-id')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ Message: 'Invalid Context ID.', ExceptionType: 'BrainException' }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const fromUrl = await worker.fetch(promptsUrlRequest('ctx-garbage'), ENV);
    const withoutCredential = await worker.fetch(promptsRequest(null), ENV);
    expect(fromUrl.status).toBe(401);
    expect(await fromUrl.text()).toBe(await withoutCredential.text());
    // The header form still relays exactly what Personalizer said.
    const fromHeader = await worker.fetch(promptsRequest('ctx-garbage'), ENV);
    expect(fromHeader.status).toBe(403);
    expect(await fromHeader.json()).toMatchObject({ ExceptionType: 'BrainException' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('leaves the URL credential unreadable to every other route', async () => {
    const fetchMock = stubFetch();
    for (const request of [
      new Request(`https://app-ai.test/messages?${PROMPTS_CONTEXT_ID_PARAMETER}=ctx-master`, {
        method: 'POST',
        body: '{}',
      }),
      new Request(`https://app-ai.test/chat?${PROMPTS_CONTEXT_ID_PARAMETER}=ctx-master`, {
        method: 'POST',
        body: '{}',
      }),
      new Request(`https://app-ai.test/files?${PROMPTS_CONTEXT_ID_PARAMETER}=ctx-master`, {
        method: 'POST',
      }),
      // Not even the same route under another method.
      new Request(`https://app-ai.test/prompts?${PROMPTS_CONTEXT_ID_PARAMETER}=ctx-master`, {
        method: 'POST',
      }),
    ]) {
      const response = await worker.fetch(request, ENV);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ExceptionType: 'MissingContextIDException' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a URL-borne credential out of every log sink', async () => {
    const consoleSpies = (['debug', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const seqBodies: string[] = [];
    stubFetch().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v2/administrator-authentication/validate-context-id')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              SubscriberID: Number(ENV.MASTER_SUBSCRIBER_ID),
              SubscriberTitle: 'Store',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      if (url === ENV.LOG_SEQ_INGEST_URL) {
        seqBodies.push(String(init?.body));
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const loud = 'console,seq';
    const env: Env = {
      ...ENV,
      LOG_TARGETS_TRACE: loud,
      LOG_TARGETS_DEBUG: loud,
      LOG_TARGETS_INFO: loud,
      LOG_TARGETS_WARN: loud,
      LOG_TARGETS_ERROR: loud,
      LOG_TARGETS_FATAL: loud,
    };
    const scheduled: Promise<unknown>[] = [];
    const response = await worker.fetch(promptsUrlRequest(MASTER_CONTEXT_ID), env, {
      waitUntil: (task: Promise<unknown>) => scheduled.push(task),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    await Promise.all(scheduled);

    const records = [
      ...consoleSpies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))),
      ...seqBodies,
    ];
    // The path must really log — an assertion over an empty set proves nothing.
    expect(records.length).toBeGreaterThan(0);
    const unredacted = new RegExp(`${PROMPTS_CONTEXT_ID_PARAMETER}=(?!\\[REDACTED\\])`);
    for (const record of records) {
      expect(record, 'a log record carried the master credential').not.toContain(MASTER_CONTEXT_ID);
      expect(record, 'a log record carried an unredacted query credential').not.toMatch(unredacted);
    }
  });

  it('leaves /health unauthenticated and unchanged', async () => {
    const fetchMock = stubFetch();
    const response = await worker.fetch(new Request('https://app-ai.test/health'), ENV);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['buildRev', 'message', 'status', 'timestamp']);
    const direct = (await handleHealth(CORS, ENV).json()) as Record<string, unknown>;
    // Everything but the moment it was asked.
    const { timestamp: _routed, ...routedFields } = body;
    const { timestamp: _direct, ...directFields } = direct;
    expect(routedFields).toEqual(directFields);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
