import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import { anthropicFileRecord, anthropicMessage, anthropicStreamResponse, ENV } from './helpers';
import { STORE_ORIGIN, USABLE_PROPOSAL, activationToken, auditHeaders } from './audit-harness';
import {
  postJson,
  postJsonUntilFirstByte,
  postWithheldBody,
  startIdleCutProxy,
  startStubOrigin,
  startWorker,
  type HttpAnswer,
  type IdleCutProxy,
  type RunningWorker,
  type StubOrigin,
  type StubReply,
  type StubRequest,
} from './network-harness.mjs';

const IDLE_CUT_MILLISECONDS = 2_000;
const MODEL_DELAY_MILLISECONDS = 3_000;
const KEEP_ALIVE_INTERVAL_MILLISECONDS = 500;
const STARTUP_TIMEOUT_MILLISECONDS = 120_000;
const CALL_TIMEOUT_MILLISECONDS = 30_000;
const SETTLEMENT_WAIT_MILLISECONDS = 10_000;

const PROPOSAL = anthropicMessage([{ type: 'text', text: '{"pages":{"Home":{"boxes":[]}}}' }]);
const OVERLOADED = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
const STATUS_CALLBACK_PATH = '/studio/activate/api/status';

let modelAnswer: (request: StubRequest) => StubReply = () => {
  throw new Error('No model answer is configured for this test.');
};
let statusEvent: (event: Record<string, unknown>) => void = () => undefined;
let upstream: StubOrigin;
let worker: RunningWorker;
let network: IdleCutProxy;

function workerVars(origin: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(ENV)) {
    if (typeof value === 'string') vars[name] = value;
  }
  return {
    ...vars,
    PERSONALIZER_API_URL: origin,
    ANTHROPIC_API_BASE: origin,
    AUDIT_STATUS_ORIGINS: origin,
    LOG_TARGETS_INFO: 'console',
    LOG_TARGETS_ERROR: 'console',
    MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS: String(KEEP_ALIVE_INTERVAL_MILLISECONDS),
  };
}

function proposal(port: number, responseMode?: string): Promise<HttpAnswer> {
  return postJson({
    port,
    path: '/messages',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx-7',
      'X-Personalizer-System-Prompt': 'onboarding-batch-all',
      'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
    },
    body: {
      ...(responseMode === undefined ? {} : { responseMode }),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Propose for this store.' }] }],
    },
  });
}

beforeAll(async () => {
  const streamedProposal = await anthropicStreamResponse(PROPOSAL).text();
  modelAnswer = () => ({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: streamedProposal,
    delayMilliseconds: MODEL_DELAY_MILLISECONDS,
  });
  upstream = await startStubOrigin({
    '/v2/administrator-authentication/validate-context-id': {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ SubscriberID: 7 }),
    },
    '/v1/messages': (request) => modelAnswer(request),
    '/v1/files': () => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(anthropicFileRecord(`file_${crypto.randomUUID()}`)),
    }),
    [STATUS_CALLBACK_PATH]: (request) => {
      statusEvent(JSON.parse(request.body) as Record<string, unknown>);
      return { status: 204, headers: {}, body: '' };
    },
  });
  worker = await startWorker(workerVars(upstream.origin));
  network = await startIdleCutProxy({
    targetPort: worker.port,
    idleMilliseconds: IDLE_CUT_MILLISECONDS,
  });
}, STARTUP_TIMEOUT_MILLISECONDS);

afterAll(async () => {
  await network?.close();
  await worker?.close();
  await upstream?.close();
});

describe('a /messages answer crossing a network that cuts a request idle for two seconds', () => {
  it(
    'loses a model call that takes longer than the idle limit when the request did not opt in',
    async () => {
      const cutsBefore = network.cuts();

      await expect(proposal(network.port)).rejects.toThrow(/closed before the answer ended/);

      expect(network.cuts()).toBe(cutsBefore + 1);
    },
    CALL_TIMEOUT_MILLISECONDS,
  );

  it(
    'delivers the whole proposal to a request that opted in to keep-alive',
    async () => {
      const cutsBefore = network.cuts();

      const answer = await proposal(network.port, 'keep-alive');

      expect(network.cuts()).toBe(cutsBefore);
      expect(answer.status).toBe(200);
      expect(answer.contentType).toBe('application/json');
      expect(answer.headersAfterMilliseconds).toBeLessThan(IDLE_CUT_MILLISECONDS);
      expect(answer.arrivals.length).toBeGreaterThan(1);
      const gaps = answer.arrivals.map(
        (arrival, index) =>
          arrival.afterMilliseconds - (answer.arrivals[index - 1]?.afterMilliseconds ?? 0),
      );
      expect(Math.max(...gaps)).toBeLessThan(IDLE_CUT_MILLISECONDS);
      expect(answer.body).toMatch(/^\s+\{/);
      expect(JSON.parse(answer.body)).toEqual({
        responseMode: 'keep-alive',
        status: 200,
        result: PROPOSAL,
      });
    },
    CALL_TIMEOUT_MILLISECONDS,
  );

  it(
    "carries a model failure to an opted-in request as app-ai's own status and error envelope",
    async () => {
      modelAnswer = () => ({
        status: 529,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(OVERLOADED),
        delayMilliseconds: MODEL_DELAY_MILLISECONDS,
      });

      const [kept, plain] = await Promise.all([
        proposal(network.port, 'keep-alive'),
        proposal(worker.port),
      ]);

      expect(kept.status).toBe(200);
      expect(plain.status).toBe(529);
      const envelope = JSON.parse(kept.body) as Record<string, unknown>;
      expect(envelope).toEqual({
        responseMode: 'keep-alive',
        status: 529,
        error: JSON.parse(plain.body) as unknown,
      });
      expect(envelope.error).toMatchObject({ ExceptionType: 'AnthropicApiException' });
    },
    CALL_TIMEOUT_MILLISECONDS,
  );
});

describe('a /messages request that did not opt in', () => {
  it(
    'is answered exactly as before: its status, then one JSON body with no envelope',
    async () => {
      const streamedProposal = await anthropicStreamResponse(PROPOSAL).text();
      modelAnswer = () => ({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: streamedProposal,
        delayMilliseconds: MODEL_DELAY_MILLISECONDS,
      });

      const answer = await proposal(worker.port);

      expect(answer.status).toBe(200);
      expect(answer.headersAfterMilliseconds).toBeGreaterThanOrEqual(MODEL_DELAY_MILLISECONDS);
      expect(answer.body.startsWith('{')).toBe(true);
      expect(JSON.parse(answer.body)).toEqual(PROPOSAL);
    },
    CALL_TIMEOUT_MILLISECONDS,
  );
});

describe('a /messages request that has not authenticated', () => {
  const FIRST_CHUNK = '{"responseMode":"keep-alive","messages":[';
  const DECLARED_BYTES = 1_000_000;

  async function refusedWhileWithheld(
    headers: Record<string, string>,
    refusal: string,
  ): Promise<{ readonly status: number; readonly body: string }> {
    const logged = worker.logs().length;
    const request = postWithheldBody({
      port: worker.port,
      path: '/messages',
      headers,
      firstChunk: FIRST_CHUNK,
      declaredBytes: DECLARED_BYTES,
    });

    await vi.waitFor(
      () => {
        const refused = worker
          .logs()
          .slice(logged)
          .some(
            (message) => message.includes('Request handler error') && message.includes(refusal),
          );
        expect(refused, 'the worker refused the request').toBe(true);
      },
      { timeout: SETTLEMENT_WAIT_MILLISECONDS, interval: 50 },
    );
    expect(request.bytesSent()).toBe(FIRST_CHUNK.length);

    request.finish();
    return request.answered;
  }

  it(
    'is refused for its missing credential while all but its first bytes are still unsent',
    async () => {
      const answer = await refusedWhileWithheld(
        { 'Content-Type': 'application/json' },
        'MissingContextIDException',
      );

      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.body)).toMatchObject({ ExceptionType: 'MissingContextIDException' });
    },
    CALL_TIMEOUT_MILLISECONDS,
  );

  it(
    'is refused for a Grader bearer that does not verify while all but its first bytes are still unsent',
    async () => {
      const answer = await refusedWhileWithheld(
        {
          ...auditHeaders('ls_audit_aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl', 'grader-chat'),
          'X-LimeSpot-Audit-Plan-Version': '2',
        },
        'The grader token signature is invalid.',
      );

      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.body)).toMatchObject({
        ExceptionType: 'AuditAuthorizationException',
      });
    },
    CALL_TIMEOUT_MILLISECONDS,
  );
});

describe('a Grader session whose caller disconnects during a keep-alive answer', () => {
  const REPLY = 'LimeSpot can add Trending products below your home page hero.';
  const REPORT = {
    platform: 'shopline',
    partial: false,
    pages: [
      {
        page: 'Home',
        state: 'read',
        desktopCovered: true,
        mobileCovered: true,
        findings: [
          {
            label: 'Trending products',
            fix: 'Add Trending products below section 3.',
            reason: 'The home page shows no product discovery after the hero.',
          },
        ],
      },
    ],
    audiences: [{ title: 'Returning visitors', reason: 'Repeat sessions are common here.' }],
    offers: [{ title: 'Spend $75, save 10%', reason: 'Lifts basket size.' }],
  };

  function settled(): {
    readonly outcome: Promise<'sent' | 'dropped'>;
    readonly settle: (outcome: 'sent' | 'dropped') => void;
  } {
    let settle = (_outcome: 'sent' | 'dropped'): void => {};
    const outcome = new Promise<'sent' | 'dropped'>((resolve) => {
      settle = resolve;
    });
    return { outcome, settle };
  }

  async function workerFetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${worker.port}${path}`, init);
  }

  it(
    'still settles the proposal and the chat message, and replays the stored outcome with no second model call',
    async () => {
      const proposalReply = await anthropicStreamResponse(
        anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }]),
      ).text();
      const chatReply = await anthropicStreamResponse(
        anthropicMessage([{ type: 'text', text: REPLY }]),
      ).text();
      const proposalDelivery = settled();
      const chatDelivery = settled();
      let chatCalls = 0;
      modelAnswer = (request) => {
        const isChat = request.body.includes('BOUNDARIES');
        if (isChat) chatCalls += 1;
        return {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: isChat ? chatReply : proposalReply,
          delayMilliseconds: MODEL_DELAY_MILLISECONDS,
          onSettled: isChat ? chatDelivery.settle : proposalDelivery.settle,
        };
      };
      const auditIdentifier = `audit-${crypto.randomUUID()}`;
      let runCompleted = false;
      statusEvent = (event) => {
        if (event.auditIdentifier === auditIdentifier && event.status === 'completed') {
          runCompleted = true;
        }
      };

      const exchanged = await workerFetch('/audit/session/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LimeSpot-Audit-Plan-Version': '2' },
        body: JSON.stringify({
          activationToken: await activationToken(
            ENV,
            crypto.randomUUID(),
            { type: 'store-origin', storeOrigin: STORE_ORIGIN },
            'merchant@example.com',
            auditIdentifier,
            2,
            `${upstream.origin}${STATUS_CALLBACK_PATH}`,
          ),
          storeUrl: `${STORE_ORIGIN}/`,
        }),
      });
      expect(exchanged.status).toBe(201);
      const { accessToken } = (await exchanged.json()) as { accessToken: string };
      const upload = new FormData();
      upload.set('file', new File(['tile'], 'tile.webp', { type: 'image/webp' }));
      upload.append('prompt', 'onboarding-batch-all');
      const uploaded = await workerFetch('/files', {
        method: 'POST',
        headers: auditHeaders(accessToken),
        body: upload,
      });
      expect(uploaded.status).toBe(200);
      const { id: tile } = (await uploaded.json()) as { id: string };

      const proposalStart = await postJsonUntilFirstByte({
        port: worker.port,
        path: '/messages',
        headers: auditHeaders(accessToken, 'onboarding-batch-all'),
        body: {
          responseMode: 'keep-alive',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'file', file_id: tile } },
                {
                  type: 'text',
                  text: 'PAGE Home: DESKTOP TILES images 1-1, MOBILE TILES images 1-1, CANDIDATE ANCHORS 1..6',
                },
              ],
            },
          ],
        },
      });
      expect(proposalStart.status).toBe(200);
      expect(proposalStart.firstBytes).toMatch(/^ +$/);
      expect(await proposalDelivery.outcome).toBe('sent');
      await vi.waitFor(
        () => expect(runCompleted, 'the audit recorded its run completed').toBe(true),
        { timeout: SETTLEMENT_WAIT_MILLISECONDS, interval: 50 },
      );

      const messageId = crypto.randomUUID();
      const chatBody = {
        messageId,
        messages: [{ role: 'user', content: 'What would LimeSpot add first?' }],
        graderReport: REPORT,
      };
      const chatHeaders = {
        ...auditHeaders(accessToken),
        'Content-Type': 'application/json',
        'X-Personalizer-System-Prompt': 'grader-chat',
        'X-LimeSpot-Audit-Plan-Version': '2',
        'CF-Connecting-IP': '203.0.113.7',
      };
      const chatStart = await postJsonUntilFirstByte({
        port: worker.port,
        path: '/messages',
        headers: chatHeaders,
        body: { ...chatBody, responseMode: 'keep-alive' },
      });
      expect(chatStart.status).toBe(200);
      expect(chatStart.firstBytes).toMatch(/^ +$/);
      expect(await chatDelivery.outcome).toBe('sent');
      const answeredLogs = (): number =>
        worker.logs().filter((message) => message.includes('Grader chat answered')).length;

      const replayed = await vi.waitFor(
        async () => {
          const replay = await workerFetch('/messages', {
            method: 'POST',
            headers: chatHeaders,
            body: JSON.stringify(chatBody),
          });
          const body = (await replay.json()) as Record<string, unknown>;
          expect(replay.status, JSON.stringify(body)).toBe(200);
          return body;
        },
        { timeout: SETTLEMENT_WAIT_MILLISECONDS, interval: 50 },
      );

      expect(replayed).toMatchObject({
        content: [{ type: 'text', text: REPLY }],
        graderChat: { remainingInAudit: 24, withheld: false },
      });
      await vi.waitFor(() => expect(answeredLogs()).toBe(1), {
        timeout: SETTLEMENT_WAIT_MILLISECONDS,
        interval: 50,
      });
      expect(chatCalls).toBe(1);
    },
    CALL_TIMEOUT_MILLISECONDS,
  );
});
