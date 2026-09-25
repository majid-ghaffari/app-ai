import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import {
  anthropicMessage,
  anthropicStreamResponse,
  ENV,
  fetchCall,
  fetchedUrls,
  sentBody,
  stubFetch,
} from './helpers';

const PROVIDER_LONG_REQUEST_MILLISECONDS = 10 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function proposalRequest(): Request {
  return new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx-7',
      'X-Personalizer-System-Prompt': 'onboarding-batch-all',
      'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Propose for this store.' }] }],
    }),
  });
}

function routedUpstream(model: (init: RequestInit | undefined) => Promise<Response>): {
  readonly modelCalled: Promise<void>;
  readonly fetchMock: ReturnType<typeof stubFetch>;
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

describe('the one upstream inference deadline', () => {
  it('answers the conductor with a typed timeout when the model call outlives the deadline', async () => {
    vi.useFakeTimers();
    const upstream = routedUpstream(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );

    const pending = worker.fetch(proposalRequest(), ENV);
    await upstream.modelCalled;
    await vi.advanceTimersByTimeAsync(PROVIDER_LONG_REQUEST_MILLISECONDS);
    const response = await pending;

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      Message: 'The AI model did not answer within the 600-second inference deadline.',
      ExceptionType: 'InferenceTimeoutException',
      MessageDetail: 'inference_timeout',
    });
  });

  it('keeps a model call that answers inside the deadline', async () => {
    vi.useFakeTimers();
    let answer = (_response: Response): void => {};
    const upstream = routedUpstream(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );

    const pending = worker.fetch(proposalRequest(), ENV);
    await upstream.modelCalled;
    await vi.advanceTimersByTimeAsync(PROVIDER_LONG_REQUEST_MILLISECONDS - 1);
    answer(anthropicStreamResponse(anthropicMessage([{ type: 'text', text: '{"pages":{}}' }])));
    const response = await pending;

    expect(response.status).toBe(200);
  });

  it('streams the model call upstream and answers the conductor with one JSON message', async () => {
    const message = anthropicMessage(
      [
        { type: 'thinking', thinking: '', signature: 'signature-1' },
        { type: 'text', text: '{"pages":{"Home":{"boxes":[]}}}' },
      ],
      {
        usage: {
          input_tokens: 812,
          output_tokens: 4096,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 640,
        },
      },
    );
    const upstream = routedUpstream(async () => anthropicStreamResponse(message));

    const response = await worker.fetch(proposalRequest(), ENV);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual(message);
    const index = fetchedUrls(upstream.fetchMock).findIndex((url) => url.endsWith('/v1/messages'));
    expect(sentBody(fetchCall(upstream.fetchMock, index).init)).toMatchObject({ stream: true });
  });
});

describe('a registered proposal assembled from the upstream stream', () => {
  it('answers a bodyless upstream 200 as a failed inference, never as a success', async () => {
    routedUpstream(async () => new Response(null, { status: 200 }));

    const response = await worker.fetch(proposalRequest(), ENV);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      Message: 'Anthropic returned a stream response with no body',
      ExceptionType: 'AnthropicApiException',
    });
  });

  it('keeps the refusal details the stream carries on its message_delta', async () => {
    const refusal = anthropicMessage([], {
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        explanation: 'The request was declined.',
      },
    });
    routedUpstream(async () => anthropicStreamResponse(refusal));

    const response = await worker.fetch(proposalRequest(), ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(refusal);
  });

  it('merges every message_delta the stream sends into the final message', async () => {
    const start = anthropicMessage([], { usage: { input_tokens: 5, output_tokens: 0 } });
    const events = [
      { type: 'message_start', message: { ...start, stop_reason: null, stop_sequence: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '{"pages":{"Home":{"boxes":[]}}}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 9 },
      },
      { type: 'message_delta', delta: { container: null }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ];
    routedUpstream(
      async () =>
        new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );

    const response = await worker.fetch(proposalRequest(), ENV);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [{ type: 'text', text: '{"pages":{"Home":{"boxes":[]}}}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      container: null,
      usage: { input_tokens: 5, output_tokens: 12 },
    });
  });
});
