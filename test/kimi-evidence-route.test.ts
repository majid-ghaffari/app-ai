import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/config';
import { getSystemPrompt, ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import { ENV, stubFetch, DISTANT_FILE_EXPIRY } from './helpers';

afterEach(() => vi.restoreAllMocks());

function evidenceBucket() {
  const stored = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  const bucket = {
    put: vi.fn(
      async (
        key: string,
        bytes: Uint8Array,
        options: { customMetadata: Record<string, string> },
      ) => {
        stored.set(key, { bytes, metadata: options.customMetadata });
        return { key };
      },
    ),
    head: vi.fn(async (key: string) => {
      const item = stored.get(key);
      return item ? { key, size: item.bytes.byteLength, customMetadata: item.metadata } : null;
    }),
    get: vi.fn(async (key: string) => {
      const item = stored.get(key);
      return item
        ? {
            key,
            size: item.bytes.byteLength,
            customMetadata: item.metadata,
            arrayBuffer: async () =>
              item.bytes.buffer.slice(
                item.bytes.byteOffset,
                item.bytes.byteOffset + item.bytes.byteLength,
              ),
          }
        : null;
    }),
    delete: vi.fn(async (key: string) => {
      stored.delete(key);
    }),
  } as unknown as R2Bucket;
  return { stored, bucket };
}

describe('Kimi prompt-aware evidence route', () => {
  it('fails a Kimi upload without R2 while the same real route still uploads to Anthropic', async () => {
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.endsWith('/v1/files')) {
        return new Response(
          JSON.stringify({
            id: 'file_anthropic',
            type: 'file',
            filename: 'page.png',
            mime_type: 'image/png',
            size_bytes: 3,
            expires_at: DISTANT_FILE_EXPIRY,
            created_at: '2026-01-01T00:00:00Z',
            downloadable: false,
          }),
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const uploadRequest = (prompts: readonly string[] = ['visual-verify']) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'page.png');
      prompts.forEach((prompt) => form.append('prompt', prompt));
      return new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-binding-route' },
        body: form,
      });
    };
    const kimi = await worker.fetch(uploadRequest(), {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
    });
    expect(kimi.status).toBe(500);
    expect(await kimi.json()).toMatchObject({
      ExceptionType: 'Exception',
      Message: expect.stringMatching(/INLINE_EVIDENCE_R2/),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mixed = await worker.fetch(uploadRequest(['image-selection', 'visual-verify']), {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
    });
    expect(mixed.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const anthropic = await worker.fetch(uploadRequest(), ENV);
    expect(anthropic.status, await anthropic.clone().text()).toBe(200);
    expect(await anthropic.json()).toMatchObject({ type: 'file' });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      'https://brain.test/v2/administrator-authentication/validate-context-id',
      'https://brain.test/v2/administrator-authentication/validate-context-id',
      'https://brain.test/v2/administrator-authentication/validate-context-id',
      'https://api.anthropic.com/v1/files',
    ]);
  });

  it('seals and replays a server-tool transcript through the real chat route', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'studio-data-agent=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    let completionIndex = 0;
    const chunk = (
      delta: Readonly<Record<string, unknown>>,
      finishReason: string | null = null,
      usage: Readonly<Record<string, unknown>> | null = null,
    ) => ({
      id: 'cmpl_chat_kimi',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'kimi-for-coding',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      usage,
    });
    const stream = (events: readonly Readonly<Record<string, unknown>>[]) =>
      new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.includes('/v2/ai-tools/')) {
        return new Response(
          JSON.stringify({
            FromDate: '2026-01-01',
            ToDate: '2026-01-31',
            OrderCount: 12,
            TotalRevenue: 552,
            AverageOrderValue: 46,
            ConversionRate: 0.04,
            Currency: 'USD',
          }),
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        completionIndex += 1;
        if (completionIndex === 1) {
          return stream([
            chunk({
              role: 'assistant',
              content: 'Checking.',
              reasoning_content: 'Use analytics.',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_kimi_analytics',
                  type: 'function',
                  function: { name: 'get_store_analytics', arguments: '{}' },
                },
              ],
            }),
            chunk({}, 'tool_calls', {
              prompt_tokens: 5,
              completion_tokens: 2,
              total_tokens: 7,
            }),
          ]);
        }
        if (completionIndex === 2) {
          return stream([
            chunk({
              role: 'assistant',
              content: 'Your AOV is $46.',
              reasoning_content: 'The tool answered.',
            }),
            chunk({}, 'stop', {
              prompt_tokens: 9,
              completion_tokens: 3,
              total_tokens: 12,
            }),
          ]);
        }
        return stream([
          chunk({
            role: 'assistant',
            content: 'Confirmed.',
            reasoning_content: 'Continue from the sealed transcript.',
          }),
          chunk({}, 'stop', {
            prompt_tokens: 13,
            completion_tokens: 2,
            total_tokens: 15,
          }),
        ]);
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const chatRequest = (body: unknown) =>
      new Request('https://app-ai.test/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Personalizer-Context-ID': 'ctx-kimi-tool-state',
          'X-Personalizer-System-Prompt': 'chat',
        },
        body: JSON.stringify(body),
      });
    const first = await worker.fetch(
      chatRequest({ messages: [{ role: 'user', content: 'what is my AOV?' }] }),
      env,
    );
    expect(first.status, await first.clone().text()).toBe(200);
    const firstDone = (await first.json()) as { continuation?: string; text?: string };
    expect(firstDone.text).toContain('$46');
    expect(firstDone.continuation).toMatch(/^continuation_v2_/);
    const second = await worker.fetch(
      chatRequest({
        continuation: firstDone.continuation,
        messages: [
          { role: 'user', content: 'what is my AOV?' },
          { role: 'assistant', content: firstDone.text },
          { role: 'user', content: 'confirm' },
        ],
      }),
      env,
    );
    expect(second.status, await second.clone().text()).toBe(200);
    const providerCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/v1/chat/completions'),
    );
    expect(providerCalls).toHaveLength(3);
    const replay = JSON.parse(String(providerCalls[2]?.[1]?.body)) as {
      messages: readonly Readonly<Record<string, unknown>>[];
    };
    expect(replay.messages).toEqual([
      { role: 'system', content: getSystemPrompt('chat', env).prompt },
      { role: 'user', content: 'what is my AOV?' },
      {
        role: 'assistant',
        content: 'Checking.',
        reasoning_content: 'Use analytics.',
        tool_calls: [
          {
            id: 'call_kimi_analytics',
            type: 'function',
            function: { name: 'get_store_analytics', arguments: '{}' },
          },
        ],
      },
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_kimi_analytics' }),
      {
        role: 'assistant',
        content: 'Your AOV is $46.',
        reasoning_content: 'The tool answered.',
      },
      { role: 'user', content: 'confirm' },
    ]);
    const withoutContinuation = await worker.fetch(
      chatRequest({
        messages: [
          { role: 'user', content: 'what is my AOV?' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_kimi_analytics',
                name: 'get_store_analytics',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_kimi_analytics',
                content: 'captured',
              },
            ],
          },
        ],
      }),
      env,
    );
    expect(withoutContinuation.status).toBe(400);
    expect(await withoutContinuation.json()).toMatchObject({
      ExceptionType: 'ArgumentException',
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/chat/completions')),
    ).toHaveLength(3);
  });

  it.each([
    {
      name: 'oversized evidence',
      blob: new Blob(['12345'], { type: 'text/plain' }),
      maxBytes: '4',
      status: 413,
    },
    {
      name: 'unsupported media',
      blob: new Blob(['pdf'], { type: 'application/pdf' }),
      maxBytes: '8000000',
      status: 400,
    },
    {
      name: 'invalid UTF-8 text',
      blob: new Blob([new Uint8Array([0xc3, 0x28])], { type: 'text/plain' }),
      maxBytes: '8000000',
      status: 400,
    },
  ])('rejects $name before R2 or Kimi I/O', async ({ blob, maxBytes, status }) => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'image-selection=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
      KIMI_EVIDENCE_MAX_BYTES: maxBytes,
    };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const form = new FormData();
    form.append('file', blob, 'evidence');
    form.append('prompt', 'image-selection');
    const response = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-invalid-evidence' },
        body: form,
      }),
      env,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(bucket.put as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns client input for an unsupported inline image type before Kimi I/O', async () => {
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-invalid-image',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' },
                },
              ],
            },
          ],
        }),
      }),
      { ...ENV, MODEL_OVERRIDES: 'render-verification=kimi-for-coding' },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported controls before reading stored evidence or calling Kimi', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'page.png');
    form.append('prompt', 'visual-verify');
    const uploaded = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-control-preflight' },
        body: form,
      }),
      env,
    );
    expect(uploaded.status).toBe(200);
    const file = (await uploaded.json()) as { id: string };
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-control-preflight',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          temperature: 0.4,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'file', file_id: file.id } }],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(bucket.get as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/'))).toHaveLength(0);
  });

  it('recovers a missing hosted image on the real chat agent stream before emitting output', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'studio-visual-agent=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    let fileIndex = 0;
    let streamIndex = 0;
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.endsWith('/v1/files')) {
        fileIndex += 1;
        return new Response(
          JSON.stringify({
            id: `kimi_chat_${fileIndex}`,
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'evidence',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        streamIndex += 1;
        if (streamIndex === 1) {
          return new Response(
            JSON.stringify({
              error: {
                type: 'resource_not_found_error',
                message: 'The requested resource was not found',
              },
            }),
            { status: 404 },
          );
        }
        const frames = [
          {
            id: 'chat_stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'kimi-for-coding',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', reasoning_content: 'Checked.' },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            id: 'chat_stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'kimi-for-coding',
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          },
        ];
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'page.jpg');
    form.append('prompt', 'onboarding-chat');
    const uploaded = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-chat-retry' },
        body: form,
      }),
      env,
    );
    expect(uploaded.status).toBe(200);
    const reference = (await uploaded.json()) as { id: string };
    const response = await worker.fetch(
      new Request('https://app-ai.test/chat', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-chat-retry',
          'X-Personalizer-System-Prompt': 'onboarding-chat',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Describe this page.' }],
          fileIds: [reference.id],
        }),
      }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { text?: string };
    expect(body.text).toBe('OK');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      2,
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/chat/completions')),
    ).toHaveLength(2);
  });

  it('re-uploads a hosted image once when Kimi expires its upstream id', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    let fileIndex = 0;
    let completionIndex = 0;
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.endsWith('/v1/files')) {
        fileIndex += 1;
        return new Response(
          JSON.stringify({
            id: `kimi_expiring_${fileIndex}`,
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'evidence',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        completionIndex += 1;
        if (completionIndex === 1) {
          return new Response(
            JSON.stringify({
              error: {
                type: 'resource_not_found_error',
                message: 'The requested resource was not found',
              },
            }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'cmpl_recovered',
            object: 'chat.completion',
            created: 1,
            model: 'kimi-for-coding',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '{"pass":true}',
                  reasoning_content: 'Checked.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          }),
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'page.jpg');
    form.append('prompt', 'visual-verify');
    const uploaded = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-retry' },
        body: form,
      }),
      env,
    );
    expect(uploaded.status).toBe(200);
    const reference = (await uploaded.json()) as { id: string };
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-retry',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'file', file_id: reference.id } }],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      2,
    );
    const completions = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/chat/completions'),
    );
    expect(completions).toHaveLength(2);
    const retried = JSON.parse(String(completions[1]?.[1]?.body));
    expect(retried.messages.at(-1).content).toContainEqual({
      type: 'image_url',
      image_url: { url: 'ms://kimi_expiring_2' },
    });
  });

  it('binds a stored reference to its tenant before reading bytes or calling Kimi', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const form = new FormData();
    form.append('file', new Blob(['<main>Private</main>'], { type: 'text/plain' }), 'document.txt');
    form.append('prompt', 'visual-verify');
    const uploaded = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-owner' },
        body: form,
      }),
      env,
    );
    expect(uploaded.status).toBe(200);
    const reference = (await uploaded.json()) as { id: string };
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-other',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'file', file_id: reference.id } }],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(
      fetchMock.mock.calls.every(([url]) => String(url).endsWith('/validate-context-id')),
    ).toBe(true);
  });

  it('fails closed on a changed encrypted object before provider I/O', async () => {
    const { bucket, stored } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const form = new FormData();
    form.append(
      'file',
      new Blob(['<main>Original</main>'], { type: 'text/plain' }),
      'document.txt',
    );
    form.append('prompt', 'visual-verify');
    const uploaded = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-owner' },
        body: form,
      }),
      env,
    );
    expect(uploaded.status).toBe(200);
    const reference = (await uploaded.json()) as { id: string };
    const object = [...stored.values()][0];
    if (!object) throw new Error('Stored object missing');
    const last = object.bytes.length - 1;
    object.bytes[last] = (object.bytes[last] ?? 0) ^ 1;
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-owner',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'file', file_id: reference.id } }],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status).toBe(500);
    expect(
      fetchMock.mock.calls.every(([url]) => String(url).endsWith('/validate-context-id')),
    ).toBe(true);
  });

  it('refuses an expired stored object before calling Kimi', async () => {
    const { bucket, stored } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const form = new FormData();
    form.append('file', new Blob(['<main>Expired</main>'], { type: 'text/plain' }), 'document.txt');
    form.append('prompt', 'visual-verify');
    const uploaded = await worker.fetch(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-expired' },
        body: form,
      }),
      env,
    );
    expect(uploaded.status).toBe(200);
    const reference = (await uploaded.json()) as { id: string };
    const object = [...stored.values()][0];
    if (!object) throw new Error('Stored object missing');
    object.metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-expired',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'document', source: { type: 'file', file_id: reference.id } }],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(
      fetchMock.mock.calls.every(([url]) => String(url).endsWith('/validate-context-id')),
    ).toBe(true);
  });

  it('keeps five-page onboarding propose, review, and QC messages bounded with thirty shared tiles', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'onboarding-visual=kimi-for-coding,onboarding-qc-gate=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    let uploadIndex = 0;
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.includes('/personalizerConfig?')) return new Response(JSON.stringify({}));
      if (url.endsWith('/v1/files')) {
        uploadIndex += 1;
        return new Response(
          JSON.stringify({
            id: `kimi_tile_${uploadIndex}`,
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'evidence',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'cmpl_onboarding',
            object: 'chat.completion',
            created: 1,
            model: 'kimi-for-coding',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '{"pages":{}}',
                  reasoning_content: 'Reviewed.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const references: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array([index, 2, 3])], { type: 'image/jpeg' }),
        `tile-${index}.jpg`,
      );
      form.append('prompt', 'onboarding-batch-all');
      form.append('prompt', 'onboarding-review-all');
      form.append('prompt', 'onboarding-review-gate-all');
      const uploaded = await worker.fetch(
        new Request('https://app-ai.test/files', {
          method: 'POST',
          headers: { 'X-Personalizer-Context-ID': 'ctx-kimi-onboarding' },
          body: form,
        }),
        env,
      );
      expect(uploaded.status, await uploaded.clone().text()).toBe(200);
      const body = (await uploaded.json()) as { references: Record<string, { id: string }> };
      const batchReference = body.references['onboarding-batch-all'];
      const reviewReference = body.references['onboarding-review-all'];
      const gateReference = body.references['onboarding-review-gate-all'];
      if (!batchReference || !reviewReference || !gateReference)
        throw new Error('Missing prompt-aware reference');
      expect(batchReference.id).toBe(reviewReference.id);
      expect(gateReference.id).toBe(reviewReference.id);
      references.push(batchReference.id);
    }
    for (const prompt of [
      'onboarding-batch-all',
      'onboarding-review-all',
      'onboarding-review-gate-all',
    ]) {
      const request = new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-kimi-onboarding',
          'X-Personalizer-System-Prompt': prompt,
          'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                ...references.map((id) => ({
                  type: 'image',
                  source: { type: 'file', file_id: id },
                })),
                {
                  type: 'text',
                  text: 'Five pages, desktop and mobile, thirty ordered tile images.',
                },
              ],
            },
          ],
        }),
      });
      const response = await worker.fetch(request, env);
      expect(response.status, await response.clone().text()).toBe(200);
    }
    const modelCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/chat/completions'),
    );
    expect(modelCalls).toHaveLength(3);
    for (const [, init] of modelCalls) {
      const raw = String(init?.body);
      expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(2 * 1024 * 1024);
      const payload = JSON.parse(raw);
      expect(
        payload.messages
          .at(-1)
          .content.filter((part: { type: string }) => part.type === 'image_url'),
      ).toHaveLength(30);
    }
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      30,
    );
  });

  it('runs smart image detection with its uploaded image, HTML, and registry sample', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'image-selection=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.endsWith('/v1/files')) {
        return new Response(
          JSON.stringify({
            id: 'kimi_smart_image',
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'page.jpg',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'cmpl_smart_image',
            object: 'chat.completion',
            created: 1,
            model: 'kimi-for-coding',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{}', reasoning_content: 'Reviewed.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
          }),
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const upload = async (blob: Blob, filename: string) => {
      const form = new FormData();
      form.append('file', blob, filename);
      form.append('prompt', 'image-selection');
      const response = await worker.fetch(
        new Request('https://app-ai.test/files', {
          method: 'POST',
          headers: { 'X-Personalizer-Context-ID': 'ctx-kimi-smart' },
          body: form,
        }),
        env,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { id: string }).id;
    };
    const imageId = await upload(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'page.jpg',
    );
    const htmlId = await upload(
      new Blob(['<main><img alt="hero"></main>'], { type: 'text/plain' }),
      'document.txt',
    );
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-kimi-smart',
          'X-Personalizer-System-Prompt': 'image-selection',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'file', file_id: imageId } },
                { type: 'document', source: { type: 'file', file_id: htmlId } },
              ],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/chat/completions'));
    if (!call) throw new Error('Kimi completion was not called');
    const payload = JSON.parse(String(call[1]?.body));
    const parts = payload.messages.flatMap((message: { content: unknown }) =>
      Array.isArray(message.content) ? message.content : [],
    );
    expect(parts).toContainEqual({
      type: 'image_url',
      image_url: { url: 'ms://kimi_smart_image' },
    });
    expect(parts).toContainEqual({ type: 'text', text: '<main><img alt="hero"></main>' });
    const sample = getSystemPrompt('image-selection', env).attachments[0]?.content;
    expect(sample).toBeTruthy();
    expect(parts).toContainEqual({ type: 'text', text: sample });
  });

  it('rejects an oversized multipart message before Kimi I/O', async () => {
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const env = { ...ENV, MODEL_OVERRIDES: 'render-verification=kimi-for-coding' };
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-kimi-evidence',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Review the image and HTML.' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(2_100_000) },
                },
              ],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      ExceptionType: 'ArgumentException',
      Message: expect.stringContaining('2 MiB'),
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://brain.test/v2/administrator-authentication/validate-context-id',
    ]);
  });

  it('isolates overlapping image uploads and reuses the completed sidecar afterward', async () => {
    const { stored, bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'render-verification=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    } as Env & { INLINE_EVIDENCE_R2: R2Bucket };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.endsWith('/v1/chat/completions')) {
        return new Response(
          JSON.stringify({
            id: 'cmpl_kimi_evidence',
            object: 'chat.completion',
            created: 1,
            model: 'kimi-for-coding',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '{"pass":true}',
                  reasoning_content: 'Checked evidence.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
        );
      }
      if (url.endsWith('/v1/files')) {
        return new Response(
          JSON.stringify({
            id: 'kimi_image_1',
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'page.jpg',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const upload = async (bytes: Blob, filename: string): Promise<string> => {
      const form = new FormData();
      form.append('file', bytes, filename);
      form.append('prompt', 'visual-verify');
      const response = await worker.fetch(
        new Request('https://app-ai.test/files', {
          method: 'POST',
          headers: { 'X-Personalizer-Context-ID': 'ctx-kimi-evidence' },
          body: form,
        }),
        env,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { references: { 'visual-verify': { id: string } } };
      return body.references['visual-verify'].id;
    };
    const imageId = await upload(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'page.jpg',
    );
    const htmlId = await upload(
      new Blob(['<main><h1>Example</h1></main>'], { type: 'text/plain' }),
      'document.txt',
    );
    const inferenceRequest = () =>
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-kimi-evidence',
          'X-Personalizer-System-Prompt': 'visual-verify',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'file', file_id: imageId } },
                { type: 'document', source: { type: 'file', file_id: htmlId } },
              ],
            },
          ],
        }),
      });
    const [response, repeated] = await Promise.all([
      worker.fetch(inferenceRequest(), env),
      worker.fetch(inferenceRequest(), env),
    ]);
    expect(response.status).toBe(200);
    expect(repeated.status).toBe(200);
    const modelCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/chat/completions'),
    );
    expect(modelCalls).toHaveLength(2);
    const payload = JSON.parse(String(modelCalls[0]?.[1]?.body));
    const content = payload.messages.at(-1).content;
    expect(content).toContainEqual({ type: 'image_url', image_url: { url: 'ms://kimi_image_1' } });
    expect(content).toContainEqual({ type: 'text', text: '<main><h1>Example</h1></main>' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      2,
    );
    expect(
      [...stored.values()].every(
        (item) => !new TextDecoder().decode(item.bytes).includes('<main>'),
      ),
    ).toBe(true);

    const cached = await worker.fetch(inferenceRequest(), env);
    expect(cached.status).toBe(200);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      2,
    );

    const removed = await worker.fetch(
      new Request(`https://app-ai.test/files/${imageId}`, {
        method: 'DELETE',
        headers: { 'X-Personalizer-Context-ID': 'ctx-kimi-evidence' },
      }),
      env,
    );
    expect(removed.status).toBe(200);
    const afterDeletion = await worker.fetch(inferenceRequest(), env);
    expect(afterDeletion.status).toBe(400);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/chat/completions')),
    ).toHaveLength(3);
  });
  it('searches oversized smart image HTML through an internal tool without sending the whole document', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'image-selection=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    let completionIndex = 0;
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.endsWith('/v1/files')) {
        return new Response(
          JSON.stringify({
            id: 'kimi_large_html_image',
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'page.jpg',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        completionIndex += 1;
        return new Response(
          JSON.stringify({
            id: `cmpl_large_html_${completionIndex}`,
            object: 'chat.completion',
            created: 1,
            model: 'kimi-for-coding',
            choices: [
              {
                index: 0,
                message:
                  completionIndex <= 2
                    ? {
                        role: 'assistant',
                        content: '',
                        reasoning_content: 'Inspect the target.',
                        tool_calls: [
                          {
                            id: completionIndex === 1 ? 'call_search_html' : 'call_read_html',
                            type: 'function',
                            function: {
                              name: completionIndex === 1 ? 'kimi_search_html' : 'kimi_read_html',
                              arguments:
                                completionIndex === 1
                                  ? '{"document":"html_1","query":"hero"}'
                                  : '{"document":"html_1","offset":0,"limit":120}',
                            },
                          },
                        ],
                      }
                    : {
                        role: 'assistant',
                        content: '{"containerSelector":"#hero"}',
                        reasoning_content: 'Found the target.',
                      },
                finish_reason: completionIndex <= 2 ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
          }),
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const upload = async (blob: Blob, filename: string): Promise<string> => {
      const form = new FormData();
      form.append('file', blob, filename);
      form.append('prompt', 'image-selection');
      const response = await worker.fetch(
        new Request('https://app-ai.test/files', {
          method: 'POST',
          headers: { 'X-Personalizer-Context-ID': 'ctx-large-html' },
          body: form,
        }),
        env,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { id: string }).id;
    };
    const html = `<section id="hero"><img src="/hero.jpg"></section><div>${'x'.repeat(2_200_000)}</div>`;
    const htmlId = await upload(new Blob([html], { type: 'text/plain' }), 'document.txt');
    const imageId = await upload(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'page.jpg',
    );
    const response = await worker.fetch(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-large-html',
          'X-Personalizer-System-Prompt': 'image-selection',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'file', file_id: htmlId } },
                { type: 'text', text: '{"wrapperSelector":"#hero","pageType":"Home"}' },
                { type: 'image', source: { type: 'file', file_id: imageId } },
              ],
            },
          ],
        }),
      }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()) as { content: unknown }).toMatchObject({
      content: [{ text: '{"containerSelector":"#hero"}' }],
    });
    const completions = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/chat/completions'),
    );
    expect(completions).toHaveLength(4);
    expect(
      completions.every(
        ([, init]) => new TextEncoder().encode(String(init?.body)).length < 2 * 1024 * 1024,
      ),
    ).toBe(true);
    const continuation = JSON.parse(String(completions[1]?.[1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const tool = JSON.parse(
      continuation.messages.find((message) => message.role === 'tool')?.content ?? '{}',
    ) as { hits?: { html: string }[] };
    expect(tool.hits?.[0]?.html).toContain('<section id="hero"');
    const selectionFinal = JSON.parse(String(completions[2]?.[1]?.body)) as {
      messages: unknown[];
    };
    expect(JSON.stringify(selectionFinal.messages)).toContain('call_search_html');
    expect(JSON.stringify(selectionFinal.messages)).toContain('call_read_html');
  });

  it('retrieves oversized onboarding chat HTML before the public client-tool stream', async () => {
    const { bucket } = evidenceBucket();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: 'studio-visual-agent=kimi-for-coding',
      INLINE_EVIDENCE_R2: bucket,
    };
    let completionIndex = 0;
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/validate-context-id')) {
        return new Response(JSON.stringify({ SubscriberID: 7, SubscriberTitle: 'Example' }));
      }
      if (url.endsWith('/v1/files')) {
        return new Response(
          JSON.stringify({
            id: 'kimi_chat_large_image',
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'page.jpg',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      if (url.endsWith('/v1/chat/completions')) {
        completionIndex += 1;
        const phase = ((completionIndex - 1) % 3) + 1;
        if (phase < 3) {
          return new Response(
            JSON.stringify({
              id: `cmpl_chat_html_${completionIndex}`,
              object: 'chat.completion',
              created: 1,
              model: 'kimi-for-coding',
              choices: [
                {
                  index: 0,
                  message:
                    phase === 1
                      ? {
                          role: 'assistant',
                          content: '',
                          reasoning_content: 'Find the hero.',
                          tool_calls: [
                            {
                              id: 'call_find_hero',
                              type: 'function',
                              function: {
                                name: 'kimi_search_html',
                                arguments: '{"document":"html_1","query":"hero"}',
                              },
                            },
                            {
                              id: 'call_find_footer',
                              type: 'function',
                              function: {
                                name: 'kimi_search_html',
                                arguments: '{"document":"html_2","query":"footer"}',
                              },
                            },
                          ],
                        }
                      : {
                          role: 'assistant',
                          content: 'READY',
                          reasoning_content: 'Found relevant HTML.',
                        },
                  finish_reason: phase === 1 ? 'tool_calls' : 'stop',
                },
              ],
              usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 },
            }),
          );
        }
        const frames = [
          {
            id: 'chat_large_html_stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'kimi-for-coding',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', reasoning_content: 'Checked.' },
                finish_reason: null,
              },
            ],
            usage: null,
          },
          {
            id: 'chat_large_html_stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'kimi-for-coding',
            choices: [{ index: 0, delta: { content: 'Page inspected' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
          },
        ];
        return new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    });
    const upload = async (blob: Blob, filename: string): Promise<string> => {
      const form = new FormData();
      form.append('file', blob, filename);
      form.append('prompt', 'onboarding-chat');
      const response = await worker.fetch(
        new Request('https://app-ai.test/files', {
          method: 'POST',
          headers: { 'X-Personalizer-Context-ID': 'ctx-large-chat' },
          body: form,
        }),
        env,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { id: string }).id;
    };
    const htmlId = await upload(
      new Blob([`<section id="hero"><img src="/hero.jpg"></section>${'x'.repeat(1_100_000)}`], {
        type: 'text/plain',
      }),
      'document.txt',
    );
    const secondHtmlId = await upload(
      new Blob([`<footer id="footer">Support</footer>${'y'.repeat(1_100_000)}`], {
        type: 'text/plain',
      }),
      'footer.txt',
    );
    const imageId = await upload(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'page.jpg',
    );
    const response = await worker.fetch(
      new Request('https://app-ai.test/chat', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-large-chat',
          'X-Personalizer-System-Prompt': 'onboarding-chat',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Review this page.' }],
          fileIds: [htmlId, secondHtmlId, imageId],
        }),
      }),
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const first = (await response.json()) as { text: string; continuation?: string };
    expect(first.text).toBe('Page inspected');
    expect(first.continuation).toBeUndefined();
    const continued = await worker.fetch(
      new Request('https://app-ai.test/chat', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx-large-chat',
          'X-Personalizer-System-Prompt': 'onboarding-chat',
        },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: 'Review this page.' },
            { role: 'assistant', content: first.text },
            { role: 'user', content: 'Check the footer too.' },
          ],
          fileIds: [htmlId, secondHtmlId, imageId],
        }),
      }),
      env,
    );
    expect(continued.status, await continued.clone().text()).toBe(200);
    expect((await continued.json()) as { text: string }).toMatchObject({ text: 'Page inspected' });
    const completions = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/chat/completions'),
    );
    expect(completions).toHaveLength(6);
    expect(
      completions.every(
        ([, init]) => new TextEncoder().encode(String(init?.body)).length < 2 * 1024 * 1024,
      ),
    ).toBe(true);
    const finalPayload = JSON.parse(String(completions[2]?.[1]?.body)) as {
      messages: { content: unknown }[];
      tools: { function: { name: string } }[];
    };
    expect(JSON.stringify(finalPayload.messages)).toContain('Exact selected fragments');
    expect(JSON.stringify(finalPayload.messages)).toContain('hero');
    expect(JSON.stringify(finalPayload.messages)).toContain('footer');
    expect(finalPayload.tools.some((tool) => tool.function.name === 'look_at_page')).toBe(true);
    expect(finalPayload.tools.some((tool) => tool.function.name === 'kimi_search_html')).toBe(
      false,
    );
  });
});
