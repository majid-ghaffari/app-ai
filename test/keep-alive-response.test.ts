import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import { KEEP_ALIVE_RESPONSE_MODE, RESPONSE_MODE_FIELD } from '../src/lib/keep-alive-response';
import {
  anthropicMessage,
  countedRequest,
  ENV,
  parsesOf,
  fetchCall,
  fetchedUrls,
  sentBody,
  stubFetch,
  type FetchMock,
} from './helpers';

const PROVIDER_LONG_REQUEST_MILLISECONDS = 10 * 60 * 1000;
const STORE_ORIGIN = 'https://store.example';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function messagesRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: STORE_ORIGIN,
      'X-Personalizer-Context-ID': 'ctx-7',
      'X-Personalizer-System-Prompt': 'onboarding-batch-all',
      'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function keepAliveBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [RESPONSE_MODE_FIELD]: KEEP_ALIVE_RESPONSE_MODE,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Propose for this store.' }] }],
    ...extra,
  };
}

function routedUpstream(model: (init: RequestInit | undefined) => Promise<Response>): {
  readonly modelCalled: Promise<void>;
  readonly fetchMock: FetchMock;
} {
  let markCalled = (): void => {};
  const modelCalled = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  const fetchMock = stubFetch();
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/validate-context-id')) {
      return new Response(JSON.stringify({ SubscriberID: 7 }), { status: 200 });
    }
    if (url.endsWith('/v1/messages')) {
      markCalled();
      return model(init);
    }
    return new Response(null, { status: 404 });
  });
  return { modelCalled, fetchMock };
}

async function envelopeOf(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toMatch(/^\s+\{/);
  return JSON.parse(text) as Record<string, unknown>;
}

function modelBodies(fetchMock: FetchMock): Record<string, unknown>[] {
  return fetchedUrls(fetchMock).flatMap((url, index) =>
    url.endsWith('/v1/messages')
      ? [sentBody(fetchCall(fetchMock, index).init) as unknown as Record<string, unknown>]
      : [],
  );
}

describe('a keep-alive /messages answer', () => {
  it('commits status 200 with CORS and an uncompressed, uncached JSON stream before the model answers', async () => {
    let answer = (_response: Response): void => {};
    const upstream = routedUpstream(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );

    const response = await worker.fetch(messagesRequest(keepAliveBody()), ENV);
    await upstream.modelCalled;

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(STORE_ORIGIN);
    const message = anthropicMessage([{ type: 'text', text: '{"pages":{}}' }]);
    answer(new Response(JSON.stringify(message), { status: 200 }));
    expect(await envelopeOf(response)).toEqual({
      responseMode: 'keep-alive',
      status: 200,
      result: message,
    });
  });

  it('writes whitespace while the model works and ends with the inference deadline as its 504 envelope', async () => {
    vi.useFakeTimers();
    const upstream = routedUpstream(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const response = await worker.fetch(messagesRequest(keepAliveBody()), ENV);
    await upstream.modelCalled;
    const body = response.text();
    await vi.advanceTimersByTimeAsync(PROVIDER_LONG_REQUEST_MILLISECONDS);
    const text = await body;

    const leading = /^\s*/.exec(text)?.[0] ?? '';
    expect(leading.length).toBeGreaterThanOrEqual(
      PROVIDER_LONG_REQUEST_MILLISECONDS / Number(ENV.MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS),
    );
    expect(JSON.parse(text)).toEqual({
      responseMode: 'keep-alive',
      status: 504,
      error: {
        Message: 'The AI model did not answer within the 600-second inference deadline.',
        ExceptionType: 'InferenceTimeoutException',
        MessageDetail: 'inference_timeout',
      },
    });
  });

  it('carries a reply cut off at its output limit as the 502 it would have answered', async () => {
    routedUpstream(async () =>
      Response.json(
        anthropicMessage([{ type: 'text', text: '{"pages":' }], { stop_reason: 'max_tokens' }),
      ),
    );

    const envelope = await envelopeOf(await worker.fetch(messagesRequest(keepAliveBody()), ENV));

    expect(envelope).toMatchObject({
      responseMode: 'keep-alive',
      status: 502,
      error: { ExceptionType: 'InferenceTruncatedException' },
    });
  });

  it('answers a request without a credential plainly, before reading its body', async () => {
    const upstream = routedUpstream(async () =>
      Response.json(anthropicMessage([{ type: 'text', text: '{}' }])),
    );
    const opening = new TextEncoder().encode(JSON.stringify(keepAliveBody()).slice(0, 32));
    const request = new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: STORE_ORIGIN },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(opening);
        },
      }),
      duplex: 'half',
    } as RequestInit);

    const response = await worker.fetch(request, ENV);

    expect(request.bodyUsed).toBe(false);
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBeNull();
    expect(await response.json()).toMatchObject({ ExceptionType: 'MissingContextIDException' });
    expect(fetchedUrls(upstream.fetchMock)).toEqual([]);
  });

  it('never forwards the opt-in to the provider on the unregistered passthrough', async () => {
    const message = anthropicMessage([{ type: 'text', text: 'hello' }]);
    const upstream = routedUpstream(async () => Response.json(message));

    const envelope = await envelopeOf(
      await worker.fetch(
        messagesRequest(keepAliveBody(), { 'X-Personalizer-System-Prompt': 'not-registered' }),
        ENV,
      ),
    );

    expect(envelope).toEqual({ responseMode: 'keep-alive', status: 200, result: message });
    const [forwarded] = modelBodies(upstream.fetchMock);
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toHaveProperty(RESPONSE_MODE_FIELD);
  });
});

describe('an authenticated /messages body', () => {
  it.each([
    ['without the opt-in', {}],
    ['with the opt-in', { [RESPONSE_MODE_FIELD]: KEEP_ALIVE_RESPONSE_MODE }],
  ])('is read once, parsed once and never copied when it is large: %s', async (_label, optIn) => {
    const message = anthropicMessage([{ type: 'text', text: 'hello' }]);
    const upstream = routedUpstream(async () => Response.json(message));
    const marker = `body-${crypto.randomUUID()}`;
    const largeText = `${marker} ${'x'.repeat(4_000_000)}`;
    const body = JSON.stringify({
      ...optIn,
      messages: [{ role: 'user', content: [{ type: 'text', text: largeText }] }],
    });
    const parse = vi.spyOn(JSON, 'parse');
    const { request, counts } = countedRequest('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: STORE_ORIGIN,
        'X-Personalizer-Context-ID': 'ctx-7',
        'X-Personalizer-System-Prompt': 'not-registered',
      },
      body,
    });

    const response = await worker.fetch(request, ENV);
    const text = await response.text();
    const parsesBeforeInspection = parsesOf(parse, body);

    expect(counts).toEqual({ clones: 0, reads: 1 });
    expect(parsesBeforeInspection).toBe(1);
    expect(JSON.parse(text)).toEqual(
      RESPONSE_MODE_FIELD in optIn
        ? { responseMode: 'keep-alive', status: 200, result: message }
        : message,
    );
    const [forwarded] = modelBodies(upstream.fetchMock);
    expect(forwarded).not.toHaveProperty(RESPONSE_MODE_FIELD);
    expect(JSON.stringify(forwarded)).toContain(marker);
  });
});

describe('a /messages request that does not opt in', () => {
  it.each([
    ['no responseMode', {}],
    ['another responseMode', { [RESPONSE_MODE_FIELD]: 'stream' }],
  ])('is answered with its own status and plain JSON body: %s', async (_label, extra) => {
    const message = anthropicMessage([{ type: 'text', text: 'hello' }]);
    const upstream = routedUpstream(async () => Response.json(message));
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello.' }] }],
      ...extra,
    };

    const response = await worker.fetch(
      messagesRequest(body, { 'X-Personalizer-System-Prompt': 'not-registered' }),
      ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBeNull();
    expect(await response.text()).toBe(JSON.stringify(message));
    const [forwarded] = modelBodies(upstream.fetchMock);
    expect(forwarded).toEqual(expect.objectContaining(extra));
  });

  it('answers a body that is not JSON exactly as before', async () => {
    routedUpstream(async () => Response.json(anthropicMessage([{ type: 'text', text: '{}' }])));
    const request = new Request(messagesRequest({}), { body: 'not json' });

    const response = await worker.fetch(request, ENV);

    expect(response.status).not.toBe(200);
    expect(await response.json()).toHaveProperty('ExceptionType');
  });
});
