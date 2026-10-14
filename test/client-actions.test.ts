import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import {
  anthropicMessage,
  anthropicMessageStart,
  ENV,
  eventOf,
  fetchCall,
  fetchedUrls,
  readWorkerSse,
  sentBody,
  stubFetch,
  type FetchMock,
} from './helpers';

const STUDIO_CHAT_PROMPTS = ['chat', 'onboarding-chat'] as const;

const SUPPORT_TEACHING = [/requestSupport/u, /Talk with Support/u, /Support's chat is opening/u];
const MOVE_BOX_TEACHING = [/moveBox/u, /^MOVE A BOX/mu];

const GATED_REPLY = [
  'Moving Featured: Denim above Featured: Hoodies.',
  '',
  '```json',
  JSON.stringify({
    directives: [
      {
        action: 'moveBox',
        args: {
          page: 'Home',
          box: 'FeaturedCollection1',
          position: 'before',
          anchorBox: 'Popular',
        },
      },
    ],
    choices: [
      {
        label: 'Talk with Support',
        action: 'requestSupport',
        args: { summary: 'The owner wants a refund.' },
      },
    ],
  }),
  '```',
].join('\n');

const STREAM_DELTAS = ['Moving Featured: Denim ', 'above Featured: Hoodies.'];

function chatRequest(
  prompt: string,
  body: Record<string, unknown>,
  accept = 'text/event-stream',
): Request {
  return new Request('https://app-ai.test/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx-123',
      'X-Personalizer-System-Prompt': prompt,
      Accept: accept,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], ...body }),
  });
}

function routedUpstream(model: () => Response): FetchMock {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/validate-context-id')) {
      return new Response(JSON.stringify({ SubscriberID: 7 }), { status: 200 });
    }
    if (url.endsWith('/v1/messages')) return model();
    return new Response(null, { status: 404 });
  });
  return fetchMock;
}

function answering(text: string): FetchMock {
  return routedUpstream(
    () =>
      new Response(JSON.stringify(anthropicMessage([{ type: 'text', text }])), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function modelCalls(fetchMock: FetchMock): number[] {
  return fetchedUrls(fetchMock).flatMap((url, index) =>
    url.endsWith('/v1/messages') ? [index] : [],
  );
}

async function sentSystemText(prompt: string, body: Record<string, unknown>): Promise<string> {
  const fetchMock = answering('Done.');
  const events = await readWorkerSse(await worker.fetch(chatRequest(prompt, body), ENV));
  expect(eventOf(events, 'done').data.text).toBe('Done.');
  const [call] = modelCalls(fetchMock);
  if (call === undefined) throw new Error('The worker never called the model.');
  const system = sentBody(fetchCall(fetchMock, call).init).system ?? [];
  return system.map((block) => block.text ?? '').join('\n');
}

function heldProviderStream(): { readonly response: Response; readonly release: () => void } {
  const encoder = new TextEncoder();
  const frame = (type: string, data: Record<string, unknown>) =>
    encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
    },
  });
  if (!controller) throw new Error('The provider stream did not start.');
  const open = controller;
  open.enqueue(
    encoder.encode(
      `event: message_start\ndata: ${JSON.stringify(anthropicMessageStart({ input_tokens: 10 }))}\n\n`,
    ),
  );
  open.enqueue(
    frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  );
  open.enqueue(
    frame('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: STREAM_DELTAS[0] },
    }),
  );
  const release = () => {
    open.enqueue(
      frame('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: STREAM_DELTAS[1] },
      }),
    );
    open.enqueue(frame('content_block_stop', { index: 0 }));
    open.enqueue(
      frame('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
    );
    open.enqueue(frame('message_stop', {}));
    open.close();
  };
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    release,
  };
}

interface StreamedEvent {
  readonly type: string;
  readonly data: { readonly delta?: string; readonly text?: string };
}

function sseEvents(response: Response): () => Promise<StreamedEvent | null> {
  if (!response.body) throw new Error('The worker answered without a body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return async () => {
    for (;;) {
      const end = buffered.indexOf('\n\n');
      if (end >= 0) {
        const raw = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const type = /^event: (.+)$/mu.exec(raw)?.[1];
        const data = /^data: (.+)$/mu.exec(raw)?.[1];
        if (type && data) return { type, data: JSON.parse(data) as StreamedEvent['data'] };
        continue;
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

describe('Studio chat actions a client must say it carries out', () => {
  afterEach(() => vi.restoreAllMocks());

  describe.each(STUDIO_CHAT_PROMPTS)('%s', (prompt) => {
    it('teaches neither Support nor moveBox to a client that lists no actions', async () => {
      for (const body of [{}, { clientActions: [] }, { clientActions: ['openPath'] }]) {
        const system = await sentSystemText(prompt, body);
        for (const teaching of [...SUPPORT_TEACHING, ...MOVE_BOX_TEACHING]) {
          expect(system, `${JSON.stringify(body)} ${teaching}`).not.toMatch(teaching);
        }
        expect(system).toContain('`setAppearance`');
        expect(system).toContain('`toggleBox`');
        expect(system).toContain('`runAgentAgain`');
      }
    });

    it('teaches Support and moveBox each only to a client that lists it', async () => {
      const both = await sentSystemText(prompt, { clientActions: ['requestSupport', 'moveBox'] });
      for (const teaching of [...SUPPORT_TEACHING, ...MOVE_BOX_TEACHING]) {
        expect(both).toMatch(teaching);
      }
      const support = await sentSystemText(prompt, { clientActions: ['requestSupport'] });
      for (const teaching of SUPPORT_TEACHING) expect(support).toMatch(teaching);
      for (const teaching of MOVE_BOX_TEACHING) expect(support).not.toMatch(teaching);
      const moveBox = await sentSystemText(prompt, { clientActions: ['moveBox'] });
      for (const teaching of MOVE_BOX_TEACHING) expect(moveBox).toMatch(teaching);
      for (const teaching of SUPPORT_TEACHING) expect(moveBox).not.toMatch(teaching);
    });

    it('tells a client without the Support action to ask for a person in the chat', async () => {
      const system = await sentSystemText(prompt, {});
      expect(system).toContain(
        "SUPPORT IN STUDIO: the owner reaches LimeSpot's Support team by asking in this chat to talk to a person",
      );
    });

    it('delivers the model reply unchanged whatever the client lists, over SSE and as JSON', async () => {
      for (const body of [
        {},
        { clientActions: [] },
        { clientActions: ['requestSupport'] },
        { clientActions: ['requestSupport', 'moveBox'] },
      ]) {
        answering(GATED_REPLY);
        const events = await readWorkerSse(await worker.fetch(chatRequest(prompt, body), ENV));
        expect(eventOf(events, 'done').data.text, JSON.stringify(body)).toBe(GATED_REPLY);
        answering(GATED_REPLY);
        const response = await worker.fetch(chatRequest(prompt, body, 'application/json'), ENV);
        expect(((await response.json()) as { text?: string }).text).toBe(GATED_REPLY);
      }
    });

    it('refuses clientActions that is not a list of action names', async () => {
      for (const clientActions of ['moveBox', { moveBox: true }, [1], null]) {
        const fetchMock = answering('Done.');
        const response = await worker.fetch(chatRequest(prompt, { clientActions }), ENV);
        const events = await readWorkerSse(response);
        expect(eventOf(events, 'error').data, JSON.stringify(clientActions)).toMatchObject({
          Message: 'clientActions must be an array of action names',
        });
        expect(modelCalls(fetchMock)).toEqual([]);
      }
    });
  });
});

describe('Studio chat streams every reply as the model writes it', () => {
  afterEach(() => vi.restoreAllMocks());

  const clients: readonly (readonly [string, Record<string, unknown>])[] = [
    ['no clientActions', {}],
    ['every gated action listed', { clientActions: ['requestSupport', 'moveBox'] }],
  ];

  it.each(
    STUDIO_CHAT_PROMPTS.flatMap((prompt) =>
      clients.map(([label, body]) => [prompt, label, body] as const),
    ),
  )('%s, %s: a text delta arrives before the model has finished', async (prompt, _label, body) => {
    const provider = heldProviderStream();
    const fetchMock = routedUpstream(() => provider.response);
    const next = sseEvents(await worker.fetch(chatRequest(prompt, body), ENV));

    expect(await next()).toEqual({ type: 'text', data: { delta: STREAM_DELTAS[0] } });

    provider.release();
    const rest: StreamedEvent[] = [];
    for (let event = await next(); event; event = await next()) rest.push(event);
    expect(rest.map((event) => event.type)).toEqual(['text', 'done']);
    expect(rest[0]).toEqual({ type: 'text', data: { delta: STREAM_DELTAS[1] } });
    expect(rest[1]?.data.text).toBe(STREAM_DELTAS.join(''));
    expect(fetchedUrls(fetchMock).some((url) => url.endsWith('/validate-context-id'))).toBe(true);
  });
});
