import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config';
import type {
  FilePolicy,
  InferenceEvent,
  InferenceRequest,
  ModelProfile,
} from '../src/lib/inference-types';
import { KimiChatCompletionsAdapter } from '../src/inference/adapters/moonshot';
import { DefaultInferenceService } from '../src/inference/service';
import { preflightInlineEvidence } from '../src/inference/kimi/evidence';
import {
  collectKimiHtmlFragments,
  createKimiHtmlFragmentSelection,
  executeKimiHtmlTool,
  KIMI_HTML_TOOLS,
  prepareKimiHtmlToolRequest,
} from '../src/inference/kimi/html-tools';
import { toDonePayload } from '../src/handlers/chat';
import { kimiHtmlRetrieval } from '../src/prompts';
import {
  createInferenceFileService,
  createInferenceService,
  requiresOrdinaryTurnContinuation,
} from '../src/inference/factory';
import { ENV, fetchCall, headerOf, sentBody, stubFetch } from './helpers';

const KIMI_BASE = 'https://api.kimi.com/coding';

const KIMI_ENV: Env = { ...ENV, KIMI_API_BASE: KIMI_BASE, KIMI_API_KEY: 'test-kimi-key' };

const PROFILE: ModelProfile = {
  name: 'kimi-code-k3',
  provider: 'kimi',
  apiFamily: 'moonshot-chat-completions',
  model: 'k3',
  capabilities: {
    vision: true,
    reusableFiles: true,
    providerFiles: false,
    streaming: true,
    structuredOutput: true,
    serverTools: true,
    clientTools: true,
    reasoning: true,
    inlineCacheBreakpoints: false,
    textConversation: true,
  },
};

const POLICY: FilePolicy = {
  name: 'kimi-stored-evidence',
  provider: 'kimi',
  compatibleApiFamilies: ['moonshot-chat-completions'],
  inputMode: 'worker-file',
  lifecycle: 'worker-managed',
  purpose: null,
};

function evidenceBucket(): R2Bucket {
  const stored = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  return {
    put: async (
      key: string,
      bytes: Uint8Array,
      options: { customMetadata: Record<string, string> },
    ) => {
      stored.set(key, { bytes, metadata: options.customMetadata });
      return { key };
    },
    head: async (key: string) => {
      const item = stored.get(key);
      return item ? { key, customMetadata: item.metadata } : null;
    },
    get: async (key: string) => {
      const item = stored.get(key);
      return item
        ? {
            key,
            customMetadata: item.metadata,
            arrayBuffer: async () =>
              item.bytes.buffer.slice(
                item.bytes.byteOffset,
                item.bytes.byteOffset + item.bytes.byteLength,
              ),
          }
        : null;
    },
    delete: async (key: string) => {
      stored.delete(key);
    },
  } as unknown as R2Bucket;
}

const SCHEMA = {
  type: 'object' as const,
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

const ROUTE = {
  tenantScope: 'tenant-test',
  promptGroup: 'kimi-code-test-group',
  modelProfile: PROFILE.name,
};

function request(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    prompt: 'Stable system instructions',
    promptGroup: ROUTE.promptGroup,
    modelProfile: PROFILE,
    filePolicy: POLICY,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache: 'none' }] }],
    maxOutputTokens: 4096,
    tools: [],
    ...overrides,
  };
}

async function uploadReference(
  adapter: KimiChatCompletionsAdapter,
  bytes: Uint8Array,
  filename: string,
  mediaType: string,
) {
  const metadata = await adapter.uploadFile({ bytes, filename, mediaType, policy: POLICY });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    provider: 'kimi' as const,
    accountScope: await adapter.getFileScope(POLICY),
    tenantScope: 'tenant-test',
    filePolicy: POLICY.name,
    compatibleGroups: [ROUTE.promptGroup] as const,
    upstreamFileId: metadata.id,
    contentHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    expiresAt: metadata.expiresAt,
  };
}

function completion(
  model = PROFILE.model,
  message: Readonly<Record<string, unknown>> = {
    role: 'assistant',
    content: 'Hello back',
    reasoning_content: 'Answer briefly.',
  },
  finishReason = 'stop',
): Record<string, unknown> {
  return {
    id: 'cmpl_kimi',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  };
}

function chunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null = null,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'cmpl_kimi_stream',
    object: 'chat.completion.chunk',
    created: 1_700_000_001,
    model: PROFILE.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
    ...overrides,
  };
}

function sse(events: readonly (Readonly<Record<string, unknown>> | '[DONE]')[]): Response {
  return new Response(
    events
      .map((event) => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function collect(events: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const collected: InferenceEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => vi.restoreAllMocks());

describe('Kimi Code subscription transport', () => {
  it('bounds internal HTML reads and searches with source-accurate offsets', () => {
    const documents = new Map([['html_1', `İB${'x'.repeat(100_100)}`]]);
    const call = (name: string, input: Record<string, unknown>) =>
      executeKimiHtmlTool(
        { type: 'tool-call', id: 'call_html', name, input, cache: 'none' },
        documents,
      );
    const textOf = (result: ReturnType<typeof executeKimiHtmlTool>): string => {
      const content = result.content[0];
      if (!content || content.type !== 'text') throw new Error('HTML tool omitted text');
      return content.text;
    };
    expect(call('kimi_read_html', { document: 'missing', offset: 0, limit: 1 }).isError).toBe(true);
    expect(call('kimi_read_html', { document: 'html_1', offset: -1, limit: 1 }).isError).toBe(true);
    const read = JSON.parse(
      textOf(call('kimi_read_html', { document: 'html_1', offset: 0, limit: 200_000 })),
    ) as { end: number };
    expect(read.end).toBe(100_000);
    const search = JSON.parse(
      textOf(call('kimi_search_html', { document: 'html_1', query: 'b' })),
    ) as { hits: { offset: number }[] };
    expect(search.hits[0]?.offset).toBe(1);
    expect(call('kimi_search_html', { document: 'html_1', query: 'x'.repeat(201) }).isError).toBe(
      true,
    );
    expect(call('unknown', { document: 'html_1' }).isError).toBe(true);
  });

  it('reads selected HTML documents sequentially', async () => {
    const bucket = evidenceBucket();
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: bucket };
    const adapter = new KimiChatCompletionsAdapter(env);
    const accountScope = await adapter.getFileScope(POLICY);
    const references = await Promise.all(
      [1, 2, 3].map(async (value) => {
        const bytes = new TextEncoder().encode(String(value).repeat(200_000));
        const metadata = await adapter.uploadFile({
          bytes,
          filename: `${value}.html`,
          mediaType: 'text/plain',
          policy: POLICY,
        });
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          provider: 'kimi' as const,
          accountScope,
          tenantScope: 'tenant-test',
          filePolicy: POLICY.name,
          compatibleGroups: [ROUTE.promptGroup] as const,
          upstreamFileId: metadata.id,
          contentHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
          mediaType: metadata.mediaType,
          sizeBytes: metadata.sizeBytes,
          expiresAt: metadata.expiresAt,
        };
      }),
    );
    const originalGet = bucket.get.bind(bucket);
    let activeReads = 0;
    let peakReads = 0;
    vi.spyOn(bucket, 'get').mockImplementation(async (...args: Parameters<R2Bucket['get']>) => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        return await originalGet(...args);
      } finally {
        activeReads -= 1;
      }
    });
    const prepared = await prepareKimiHtmlToolRequest(
      env,
      request({
        messages: [
          {
            role: 'user',
            content: references.map((reference) => ({
              type: 'document' as const,
              source: { type: 'provider-file' as const, reference },
              cache: 'none' as const,
            })),
          },
        ],
      }),
    );
    expect(prepared?.documents.size).toBe(2);
    expect(peakReads).toBe(1);
  });

  it('evicts a failed decrypted-document cache entry before the next read', async () => {
    const bucket = evidenceBucket();
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: bucket };
    const adapter = new KimiChatCompletionsAdapter(env);
    const reference = await uploadReference(
      adapter,
      new TextEncoder().encode(`<main>target</main>${'x'.repeat(300_000)}`),
      'document.txt',
      'text/plain',
    );
    const storedGet = bucket.get.bind(bucket);
    const get = vi
      .spyOn(bucket, 'get')
      .mockRejectedValueOnce(new Error('temporary R2 failure'))
      .mockImplementation(storedGet);
    const cache = new Map<string, Promise<string>>();
    const htmlRequest = request({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'provider-file', reference },
              cache: 'none',
            },
          ],
        },
      ],
    });
    await expect(prepareKimiHtmlToolRequest(env, htmlRequest, cache)).rejects.toThrow(
      'temporary R2 failure',
    );
    await expect(prepareKimiHtmlToolRequest(env, htmlRequest, cache)).resolves.toMatchObject({
      documents: expect.any(Map),
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('bounds selected HTML fragments across all documents by encoded bytes', () => {
    const selection = createKimiHtmlFragmentSelection(['html_1', 'html_2']);
    const fragments = selection.fragments;
    const result = (document: string, html: string, offset = 0) => ({
      type: 'tool-result' as const,
      toolCallId: `call_${document}`,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ document, offset, html }),
          cache: 'none' as const,
        },
      ],
      isError: false,
      cache: 'none' as const,
    });
    let budgetExhausted = false;
    let exhaustedResult: Record<string, unknown> | undefined;
    for (let index = 0; index < 8; index += 1) {
      const collected = collectKimiHtmlFragments(
        result('html_1', String(index).repeat(100_000), index * 100_000),
        selection,
      );
      const output = collected.content[0];
      if (output?.type === 'text') {
        const value = JSON.parse(output.text) as Record<string, unknown> & {
          selectionBudgetExhausted?: boolean;
        };
        budgetExhausted ||= value.selectionBudgetExhausted === true;
        if (value.selectionBudgetExhausted === true) exhaustedResult = value;
      }
    }
    collectKimiHtmlFragments(result('html_2', '<section>target</section>'), selection);
    const beforeDuplicate = fragments.get('html_2')?.length;
    collectKimiHtmlFragments(result('html_2', '<section>target</section>'), selection);
    expect(fragments.get('html_1')?.length).toBeGreaterThan(0);
    expect(fragments.get('html_2')).toHaveLength(1);
    expect(fragments.get('html_2')?.length).toBe(beforeDuplicate);
    expect(budgetExhausted).toBe(true);
    expect(exhaustedResult).not.toHaveProperty('html');
    expect(exhaustedResult).not.toHaveProperty('hits');
    expect(kimiHtmlRetrieval).toContain('selectionBudgetExhausted: true');
    expect(
      KIMI_HTML_TOOLS.every((tool) => tool.description.includes('selectionBudgetExhausted: true')),
    ).toBe(true);
    const encodedBytes = [...fragments.values()]
      .flat()
      .reduce(
        (total, fragment) => total + new TextEncoder().encode(JSON.stringify(fragment)).byteLength,
        0,
      );
    expect(encodedBytes).toBeLessThanOrEqual(750_000);
  });

  it('fits a first HTML fragment without splitting a Unicode surrogate pair', () => {
    const names = Array.from({ length: 5_000 }, (_, index) => `html_${index}`);
    const selection = createKimiHtmlFragmentSelection(names);
    collectKimiHtmlFragments(
      {
        type: 'tool-result',
        toolCallId: 'call_unicode',
        content: [
          {
            type: 'text',
            text: JSON.stringify({ document: names[0], offset: 0, html: '😀'.repeat(100) }),
            cache: 'none',
          },
        ],
        isError: false,
        cache: 'none',
      },
      selection,
    );
    const retained = selection.fragments.get(names[0] ?? '')?.[0] ?? '';
    expect(retained).toBe(`[offset 0]\n${'😀'.repeat(34)}`);
    for (let index = 0; index < retained.length; index += 1) {
      const unit = retained.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = retained.charCodeAt(index + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        index += 1;
      } else {
        expect(unit < 0xdc00 || unit > 0xdfff).toBe(true);
      }
    }

    const documents = new Map([['html_1', 'a😀b']]);
    const readFromHigh = executeKimiHtmlTool(
      {
        type: 'tool-call',
        id: 'call_read_high',
        name: 'kimi_read_html',
        input: { document: 'html_1', offset: 0, limit: 2 },
        cache: 'none',
      },
      documents,
    );
    const readFromLow = executeKimiHtmlTool(
      {
        type: 'tool-call',
        id: 'call_read_low',
        name: 'kimi_read_html',
        input: { document: 'html_1', offset: 2, limit: 2 },
        cache: 'none',
      },
      documents,
    );
    const searched = executeKimiHtmlTool(
      {
        type: 'tool-call',
        id: 'call_search_unicode',
        name: 'kimi_search_html',
        input: { document: 'html_1', query: 'needle' },
        cache: 'none',
      },
      new Map([['html_1', `😀${'x'.repeat(599)}needle`]]),
    );
    const output = (result: ReturnType<typeof executeKimiHtmlTool>) => {
      const content = result.content[0];
      if (!content || content.type !== 'text') throw new Error('Expected text tool result');
      return JSON.parse(content.text) as {
        html?: string;
        hits?: { html: string }[];
        offset?: number;
      };
    };
    expect(output(readFromHigh)).toMatchObject({ html: 'a', offset: 0 });
    expect(output(readFromLow)).toMatchObject({ html: 'b', offset: 3 });
    expect(output(searched).hits?.[0]?.html).toBe(`${'x'.repeat(599)}needle`);
  });

  it('builds a well-formed HTML retrieval seed at task and user-context boundaries', async () => {
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: evidenceBucket() };
    const adapter = new KimiChatCompletionsAdapter(env);
    const reference = await uploadReference(
      adapter,
      new TextEncoder().encode(`<main>target</main>${'x'.repeat(300_000)}`),
      'document.txt',
      'text/plain',
    );
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify(
          completion('k3', {
            role: 'assistant',
            content: 'READY',
            reasoning_content: 'No inspection.',
          }),
        ),
      ),
    );
    await expect(
      adapter.complete(
        request({
          prompt: `${'p'.repeat(11_999)}😀tail`,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `😀${'u'.repeat(99_999)}`, cache: 'none' },
                {
                  type: 'document',
                  source: { type: 'provider-file', reference },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      inferenceError: { failureClass: 'invalid-response' },
    });
    const body = sentBody(fetchCall(fetchMock, 0).init);
    const seed = body.messages?.at(-1)?.content;
    if (typeof seed !== 'string') throw new Error('Expected string retrieval seed');
    expect(seed).toBe(new TextDecoder().decode(new TextEncoder().encode(seed)));
    expect(seed).toContain(`Task instructions: ${'p'.repeat(11_999)}\n`);
    expect(seed).toContain(`User context: ${'u'.repeat(99_999)}\n`);
  });

  it('normalizes cached and reasoning tokens from the subscription usage envelope', async () => {
    const fetchMock = stubFetch();
    const liveShaped = completion('kimi-for-coding');
    liveShaped.usage = {
      prompt_tokens: 104,
      completion_tokens: 32,
      total_tokens: 136,
      prompt_tokens_details: { cached_tokens: 88, cache_write_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 16 },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(liveShaped)));
    const result = await createInferenceService(KIMI_ENV).complete(
      request({ modelProfile: { ...PROFILE, name: 'kimi-code-coding', model: 'kimi-for-coding' } }),
    );
    expect(result.usage).toMatchObject({
      inputTokens: 104,
      outputTokens: 32,
      cachedInputTokens: 88,
      cacheWriteInputTokens: 12,
      reasoningTokens: 16,
    });
  });

  it('rejects contradictory cache counts in a subscription completion', async () => {
    const fetchMock = stubFetch();
    const conflicting = completion('kimi-for-coding');
    conflicting.usage = {
      prompt_tokens: 104,
      completion_tokens: 32,
      total_tokens: 136,
      cached_tokens: 80,
      prompt_tokens_details: { cached_tokens: 88 },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(conflicting)));
    await expect(
      createInferenceService(KIMI_ENV).complete(
        request({
          modelProfile: { ...PROFILE, name: 'kimi-code-coding', model: 'kimi-for-coding' },
        }),
      ),
    ).rejects.toThrow(/cached token counts disagreed/);
  });

  it('rejects top-level cache reads plus nested cache writes above prompt usage', async () => {
    const fetchMock = stubFetch();
    const conflicting = completion('kimi-for-coding');
    conflicting.usage = {
      prompt_tokens: 100,
      completion_tokens: 32,
      total_tokens: 132,
      cached_tokens: 90,
      prompt_tokens_details: { cache_write_tokens: 20 },
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(conflicting)));
    await expect(
      createInferenceService(KIMI_ENV).complete(
        request({
          modelProfile: { ...PROFILE, name: 'kimi-code-coding', model: 'kimi-for-coding' },
        }),
      ),
    ).rejects.toThrow(/cache token usage exceeded prompt tokens/);
  });

  it('rejects top-level cache reads above prompt usage without nested details', async () => {
    const fetchMock = stubFetch();
    const conflicting = completion('kimi-for-coding');
    conflicting.usage = {
      prompt_tokens: 100,
      completion_tokens: 32,
      total_tokens: 132,
      cached_tokens: 110,
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(conflicting)));
    await expect(
      createInferenceService(KIMI_ENV).complete(
        request({
          modelProfile: { ...PROFILE, name: 'kimi-code-coding', model: 'kimi-for-coding' },
        }),
      ),
    ).rejects.toThrow(/cache token usage exceeded prompt tokens/);
  });

  it('calls the subscription origin with its own bearer credential', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await new KimiChatCompletionsAdapter(KIMI_ENV).complete(request());
    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe(`${KIMI_BASE}/v1/chat/completions`);
    expect(headerOf(call.init, 'Authorization')).toBe('Bearer test-kimi-key');
    expect(sentBody(call.init)).toEqual({
      model: 'k3',
      messages: [
        { role: 'system', content: 'Stable system instructions' },
        { role: 'user', content: 'Hello' },
      ],
      max_completion_tokens: 4096,
    });
  });

  it('keeps the metered account on its own origin, credential, and file scope', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion('kimi-k3'))));
    const meteredProfile: ModelProfile = {
      ...PROFILE,
      name: 'kimi-metered-k3',
      provider: 'moonshot',
      model: 'kimi-k3',
    };
    const meteredPolicy: FilePolicy = {
      ...POLICY,
      name: 'moonshot-image-files',
      provider: 'moonshot',
      inputMode: 'provider-file',
      lifecycle: 'provider-managed',
      purpose: 'image',
    };
    await createInferenceService(KIMI_ENV).complete(
      request({ modelProfile: meteredProfile, filePolicy: meteredPolicy }),
    );
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(headerOf(fetchCall(fetchMock, 0).init, 'Authorization')).toBe(
      'Bearer test-moonshot-key',
    );
    const files = createInferenceFileService(KIMI_ENV);
    const subscriptionScope = await files.scope(PROFILE, POLICY);
    const meteredScope = await files.scope(meteredProfile, meteredPolicy);
    expect(subscriptionScope).toMatch(/^kimi:[a-f0-9]{24}$/);
    expect(meteredScope).toMatch(/^moonshot:[a-f0-9]{24}$/);
    expect(subscriptionScope).not.toBe(meteredScope);
  });
});

describe('Kimi Code model namespace', () => {
  it.each([
    ['k3', { reasoning_effort: 'low' }],
    ['k3-256k', { reasoning_effort: 'low' }],
  ])('sends reasoning_effort for the K3 id %s', async (model, expected) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion(model))));
    await new KimiChatCompletionsAdapter(KIMI_ENV).complete(
      request({ modelProfile: { ...PROFILE, model }, effort: 'low' }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject(expected);
    expect(sentBody(fetchCall(fetchMock, 0).init)).not.toHaveProperty('thinking');
  });

  it('sends K2.8 reasoning effort through the provider-neutral request path', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion('kimi-for-coding'))));
    await createInferenceService(KIMI_ENV).complete(
      request({
        modelProfile: { ...PROFILE, name: 'kimi-code-coding', model: 'kimi-for-coding' },
        effort: 'high',
      }),
    );
    const body = sentBody(fetchCall(fetchMock, 0).init);
    expect(body).toMatchObject({ model: 'kimi-for-coding', reasoning_effort: 'high' });
    expect(body).not.toHaveProperty('thinking');
  });

  it.each(['kimi-for-coding-highspeed'])(
    'sends preserved thinking for the always-thinking id %s',
    async (model) => {
      const fetchMock = stubFetch();
      fetchMock.mockResolvedValue(new Response(JSON.stringify(completion(model))));
      await new KimiChatCompletionsAdapter(KIMI_ENV).complete(
        request({
          modelProfile: { ...PROFILE, name: 'kimi-code-highspeed', model },
        }),
      );
      expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject({
        thinking: { type: 'enabled', keep: 'all' },
      });
      expect(sentBody(fetchCall(fetchMock, 0).init)).not.toHaveProperty('reasoning_effort');
    },
  );

  it.each(['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code', 'k3[1m]', 'Kimi K3'])(
    'refuses the non-subscription model id %s',
    async (model) => {
      const fetchMock = stubFetch();
      await expect(
        new KimiChatCompletionsAdapter(KIMI_ENV).complete(
          request({ modelProfile: { ...PROFILE, name: 'unsupported-kimi-profile', model } }),
        ),
      ).rejects.toThrow(/Kimi Code candidate does not support profile/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['k3', 'k3-256k', 'kimi-for-coding'])(
    'rejects sampling overrides on the subscription id %s',
    async (model) => {
      const fetchMock = stubFetch();
      await expect(
        new KimiChatCompletionsAdapter(KIMI_ENV).complete(
          request({
            modelProfile: { ...PROFILE, name: 'kimi-code-coding', model },
            sampling: { temperature: 0.4 },
          }),
        ),
      ).rejects.toThrow(/Kimi Code model sampling values are provider-fixed/);
      await expect(
        new KimiChatCompletionsAdapter(KIMI_ENV).complete(
          request({
            modelProfile: { ...PROFILE, name: 'kimi-code-coding', model },
            sampling: { topK: 10 },
          }),
        ),
      ).rejects.toThrow(/Kimi Code model sampling values are provider-fixed/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('applies the K3-only tool-choice gate to the subscription coding namespace', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion('kimi-for-coding'))));
    const coding = { ...PROFILE, name: 'kimi-code-coding', model: 'kimi-for-coding' };
    await expect(
      new KimiChatCompletionsAdapter(KIMI_ENV).complete(
        request({ modelProfile: coding, toolChoice: { mode: 'required' } }),
      ),
    ).rejects.toThrow(/Required tool choice is supported only by the Kimi K3 candidate/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Kimi Code file policy fails closed', () => {
  it('accepts a realistic multi-page image set within the aggregate upload envelope', () => {
    const references = [1, 2, 3, 4, 5].map((value) => ({
      provider: 'kimi' as const,
      accountScope: 'kimi:scope',
      tenantScope: 'tenant-test',
      filePolicy: POLICY.name,
      compatibleGroups: [ROUTE.promptGroup] as const,
      upstreamFileId: `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`,
      contentHash: String(value).repeat(64),
      mediaType: 'image/png',
      sizeBytes: 8_000_000,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(() =>
      preflightInlineEvidence(
        {
          ...KIMI_ENV,
          KIMI_EVIDENCE_MAX_TOTAL_BYTES: '64000000',
          KIMI_EVIDENCE_MAX_TEXT_BYTES: '16000000',
        },
        request({
          messages: [
            {
              role: 'user',
              content: references.map((reference) => ({
                type: 'image' as const,
                source: { type: 'provider-file' as const, reference },
                cache: 'none' as const,
              })),
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects aggregate evidence bytes before reading R2 or calling Kimi', async () => {
    const get = vi.fn();
    const env: Env = {
      ...KIMI_ENV,
      INLINE_EVIDENCE_R2: { get } as unknown as R2Bucket,
      KIMI_EVIDENCE_MAX_TOTAL_BYTES: '10',
    };
    const fetchMock = stubFetch();
    const reference = (id: string) => ({
      provider: 'kimi' as const,
      accountScope: 'kimi:scope',
      tenantScope: 'tenant-test',
      filePolicy: POLICY.name,
      compatibleGroups: [ROUTE.promptGroup] as const,
      upstreamFileId: id,
      contentHash: 'a'.repeat(64),
      mediaType: 'image/png',
      sizeBytes: 6,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(
      new KimiChatCompletionsAdapter(env).complete(
        request({
          messages: [
            {
              role: 'user',
              content: ['one', 'two'].map((id) => ({
                type: 'image' as const,
                source: { type: 'provider-file' as const, reference: reference(id) },
                cache: 'none' as const,
              })),
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 413, exceptionType: 'ArgumentException' });
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects aggregate stored text before reading R2 or calling Kimi', async () => {
    const get = vi.fn();
    const env: Env = {
      ...KIMI_ENV,
      INLINE_EVIDENCE_R2: { get } as unknown as R2Bucket,
      KIMI_EVIDENCE_MAX_TOTAL_BYTES: '100',
      KIMI_EVIDENCE_MAX_TEXT_BYTES: '10',
    };
    const fetchMock = stubFetch();
    const reference = (id: string) => ({
      provider: 'kimi' as const,
      accountScope: 'kimi:scope',
      tenantScope: 'tenant-test',
      filePolicy: POLICY.name,
      compatibleGroups: [ROUTE.promptGroup] as const,
      upstreamFileId: id,
      contentHash: 'a'.repeat(64),
      mediaType: 'text/plain',
      sizeBytes: 6,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(
      new KimiChatCompletionsAdapter(env).complete(
        request({
          messages: [
            {
              role: 'user',
              content: ['one', 'two'].map((id) => ({
                type: 'document' as const,
                source: { type: 'provider-file' as const, reference: reference(id) },
                cache: 'none' as const,
              })),
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 413, exceptionType: 'ArgumentException' });
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported document sources before reading stored evidence', async () => {
    const get = vi.fn();
    const env: Env = {
      ...KIMI_ENV,
      INLINE_EVIDENCE_R2: { get } as unknown as R2Bucket,
    };
    const fetchMock = stubFetch();
    const reference = {
      provider: 'kimi' as const,
      accountScope: 'kimi:scope',
      tenantScope: 'tenant-test',
      filePolicy: POLICY.name,
      compatibleGroups: [ROUTE.promptGroup] as const,
      upstreamFileId: crypto.randomUUID(),
      contentHash: 'a'.repeat(64),
      mediaType: 'image/png',
      sizeBytes: 3,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const invalidSources = [
      { type: 'url' as const, url: 'https://example.com/document.html' },
      { type: 'base64' as const, mediaType: 'image/svg+xml', data: 'AA==' },
    ];
    for (const source of invalidSources) {
      await expect(
        new KimiChatCompletionsAdapter(env).complete(
          request({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: { type: 'provider-file', reference },
                    cache: 'none',
                  },
                  { type: 'document', source, cache: 'none' },
                ],
              },
            ],
          }),
        ),
      ).rejects.toMatchObject({ status: 400, exceptionType: 'ArgumentException' });
    }
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts only a worker-managed, purpose-free policy', async () => {
    const fetchMock = stubFetch();
    const files = createInferenceFileService(KIMI_ENV);
    await expect(files.scope(PROFILE, POLICY)).resolves.toMatch(/^kimi:/);
    for (const overrides of [
      { inputMode: 'provider-file' as const, lifecycle: 'provider-managed' as const },
      { purpose: 'image' },
      { provider: 'moonshot' as const },
      { compatibleApiFamilies: ['openai-responses'] as const },
    ]) {
      await expect(files.scope(PROFILE, { ...POLICY, ...overrides })).rejects.toThrow(
        /Kimi Code cannot use file policy/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses every provider-file operation instead of degrading silently', async () => {
    const fetchMock = stubFetch();
    const { INLINE_EVIDENCE_R2: _bucket, ...missingBucket } = KIMI_ENV;
    const files = createInferenceFileService(missingBucket);
    const inlinePolicy: FilePolicy = {
      ...POLICY,
      name: 'kimi-inline-images',
      inputMode: 'inline',
      lifecycle: 'request-scoped',
    };
    await expect(
      files.upload(PROFILE, inlinePolicy, new Uint8Array([1]), 'a.png', 'image/png'),
    ).rejects.toThrow(/Kimi Code requires its worker-managed evidence policy/);
    await expect(files.getMetadata(PROFILE, 'file-1')).rejects.toThrow(/INLINE_EVIDENCE_R2/);
    await expect(files.delete(PROFILE, 'file-1')).rejects.toThrow(/INLINE_EVIDENCE_R2/);
    await expect(
      new KimiChatCompletionsAdapter(missingBucket).complete(
        request({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'provider-file',
                    reference: {
                      provider: 'kimi',
                      accountScope: 'kimi:scope',
                      tenantScope: 'tenant-test',
                      filePolicy: POLICY.name,
                      compatibleGroups: [ROUTE.promptGroup],
                      upstreamFileId: 'file-1',
                      contentHash: 'hash',
                      mediaType: 'image/png',
                      sizeBytes: 4,
                      expiresAt: null,
                    },
                  },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/INLINE_EVIDENCE_R2/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('inherits the metered strict json_schema and tool contract on the subscription', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await new KimiChatCompletionsAdapter(KIMI_ENV).complete(
      request({
        structuredOutput: {
          name: 'answer',
          description: 'Strict answer',
          schema: SCHEMA,
          strict: true,
        },
        tools: [
          {
            name: 'weather',
            description: 'Get weather',
            inputSchema: SCHEMA,
            strict: true,
            execution: 'server',
          },
        ],
        toolChoice: { mode: 'specific', name: 'weather' },
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: SCHEMA, strict: true },
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'weather',
            description: 'Get weather',
            parameters: SCHEMA,
            strict: true,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'weather' } },
    });
  });

  it('carries images inline as base64 instead', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await createInferenceService(KIMI_ENV).complete(
      request({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'AAA' },
                cache: 'none',
              },
            ],
          },
        ],
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init).messages?.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
    });
  });
});

describe('Kimi Code reasoning replay and failures', () => {
  it('accepts ordinary public assistant history without an opaque continuation', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify(
          completion('k3', {
            role: 'assistant',
            content: 'Second',
            reasoning_content: 'Answer again.',
          }),
        ),
      ),
    );
    expect(requiresOrdinaryTurnContinuation(PROFILE, KIMI_ENV)).toBe(false);
    await createInferenceService(KIMI_ENV).complete(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'First', cache: 'none' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Answer', cache: 'none' }] },
          { role: 'user', content: [{ type: 'text', text: 'Second', cache: 'none' }] },
        ],
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Second' },
    ]);
  });

  it('selects large HTML once across a multi-iteration server tool loop', async () => {
    const bucket = evidenceBucket();
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: bucket };
    const adapter = new KimiChatCompletionsAdapter(env);
    const bytes = new TextEncoder().encode(
      `<section id="hero">Target</section>${'x'.repeat(300_000)}`,
    );
    const metadata = await adapter.uploadFile({
      bytes,
      filename: 'document.txt',
      mediaType: 'text/plain',
      policy: POLICY,
    });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const contentHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const accountScope = await adapter.getFileScope(POLICY);
    const get = vi.spyOn(bucket, 'get');
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion(
              'k3',
              {
                role: 'assistant',
                content: '',
                reasoning_content: 'Search.',
                tool_calls: [
                  {
                    id: 'call_html',
                    type: 'function',
                    function: {
                      name: 'kimi_search_html',
                      arguments: '{"document":"html_1","query":"hero"}',
                    },
                  },
                ],
              },
              'tool_calls',
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion('k3', {
              role: 'assistant',
              content: 'READY',
              reasoning_content: 'Selected.',
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(
        sse([
          chunk({
            role: 'assistant',
            content: '',
            reasoning_content: 'Use tool.',
            tool_calls: [
              {
                index: 0,
                id: 'call_weather',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Paris"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls', {
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          '[DONE]',
        ]),
      )
      .mockResolvedValueOnce(
        sse([
          chunk({ role: 'assistant', content: 'Done', reasoning_content: 'Complete.' }),
          chunk({}, 'stop', {
            usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 },
          }),
          '[DONE]',
        ]),
      );
    const service = new DefaultInferenceService(() => adapter);
    const result = await service.runAgent({
      ...request({
        filePolicy: POLICY,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'provider-file',
                  reference: {
                    provider: 'kimi',
                    accountScope,
                    tenantScope: 'tenant-test',
                    filePolicy: POLICY.name,
                    compatibleGroups: [ROUTE.promptGroup],
                    upstreamFileId: metadata.id,
                    contentHash,
                    mediaType: metadata.mediaType,
                    sizeBytes: metadata.sizeBytes,
                    expiresAt: metadata.expiresAt,
                  },
                },
                cache: 'none',
              },
            ],
          },
        ],
      }),
      mode: 'server',
      maxIterations: 3,
      tools: [
        {
          name: 'weather',
          description: 'Get weather',
          inputSchema: SCHEMA,
          execution: 'server',
        },
      ],
      executeTool: async (call) => ({
        type: 'tool-result',
        toolCallId: call.id,
        content: [{ type: 'text', text: 'Sunny', cache: 'none' }],
        isError: false,
        cache: 'none',
      }),
    });
    expect(result.text).toBe('Done');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(
      bodies.filter((body) =>
        body.tools?.some((tool: { function?: { name?: string } }) =>
          tool.function?.name?.startsWith('kimi_'),
        ),
      ),
    ).toHaveLength(2);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not reuse decrypted HTML across inference-service request contexts', async () => {
    const bucket = evidenceBucket();
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: bucket };
    const uploader = new KimiChatCompletionsAdapter(env);
    const reference = await uploadReference(
      uploader,
      new TextEncoder().encode(`<main>target</main>${'x'.repeat(300_000)}`),
      'document.txt',
      'text/plain',
    );
    const htmlRequest = request({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'provider-file', reference },
              cache: 'none',
            },
          ],
        },
      ],
    });
    const get = vi.spyOn(bucket, 'get');
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion(
              'k3',
              {
                role: 'assistant',
                content: '',
                reasoning_content: 'Read the document.',
                tool_calls: [
                  {
                    id: 'call_request_scope',
                    type: 'function',
                    function: {
                      name: 'kimi_read_html',
                      arguments: '{"document":"html_1","offset":0,"limit":20}',
                    },
                  },
                ],
              },
              'tool_calls',
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion('k3', {
              role: 'assistant',
              content: 'READY',
              reasoning_content: 'The document was inspected.',
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())));
    await expect(
      createInferenceService(env, 'tenant-test').complete(htmlRequest),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'Hello back' }],
    });
    await uploader.deleteFile(reference.upstreamFileId);
    await expect(createInferenceService(env, 'tenant-test').complete(htmlRequest)).rejects.toThrow(
      /unavailable or expired/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails when Kimi finishes HTML selection without inspecting stored documents', async () => {
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: evidenceBucket() };
    const adapter = new KimiChatCompletionsAdapter(env);
    const reference = await uploadReference(
      adapter,
      new TextEncoder().encode(`<main>target</main>${'x'.repeat(300_000)}`),
      'document.txt',
      'text/plain',
    );
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify(
          completion('k3', {
            role: 'assistant',
            content: 'READY',
            reasoning_content: 'No inspection.',
          }),
        ),
      ),
    );
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'provider-file', reference },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      inferenceError: {
        failureClass: 'invalid-response',
        message: expect.stringMatching(/did not inspect every stored HTML document/),
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails when Kimi inspects only one of multiple stored HTML documents', async () => {
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: evidenceBucket() };
    const adapter = new KimiChatCompletionsAdapter(env);
    const references = await Promise.all(
      [1, 2].map((index) =>
        uploadReference(
          adapter,
          new TextEncoder().encode(`<main>target ${index}</main>${'x'.repeat(300_000)}`),
          `document-${index}.txt`,
          'text/plain',
        ),
      ),
    );
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion(
              'k3',
              {
                role: 'assistant',
                content: '',
                reasoning_content: 'Inspect the first document.',
                tool_calls: [
                  {
                    id: 'call_partial_inspection',
                    type: 'function',
                    function: {
                      name: 'kimi_read_html',
                      arguments: '{"document":"html_1","offset":0,"limit":20}',
                    },
                  },
                ],
              },
              'tool_calls',
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion('k3', {
              role: 'assistant',
              content: 'READY',
              reasoning_content: 'Inspected enough.',
            }),
          ),
        ),
      );
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: references.map((reference) => ({
                type: 'document' as const,
                source: { type: 'provider-file' as const, reference },
                cache: 'none' as const,
              })),
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      inferenceError: {
        failureClass: 'invalid-response',
        message: expect.stringMatching(/did not inspect every stored HTML document/),
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails when Kimi ends HTML selection without a completed stop after inspection', async () => {
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: evidenceBucket() };
    const adapter = new KimiChatCompletionsAdapter(env);
    const reference = await uploadReference(
      adapter,
      new TextEncoder().encode(`<main>target</main>${'x'.repeat(300_000)}`),
      'document.txt',
      'text/plain',
    );
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion(
              'k3',
              {
                role: 'assistant',
                content: '',
                reasoning_content: 'Inspect the document.',
                tool_calls: [
                  {
                    id: 'call_nonterminal_inspection',
                    type: 'function',
                    function: {
                      name: 'kimi_read_html',
                      arguments: '{"document":"html_1","offset":0,"limit":20}',
                    },
                  },
                ],
              },
              'tool_calls',
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion(
              'k3',
              {
                role: 'assistant',
                content: '',
                reasoning_content: 'Output budget ended.',
              },
              'length',
            ),
          ),
        ),
      );
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'provider-file', reference },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      inferenceError: {
        failureClass: 'invalid-response',
        message: expect.stringMatching(/did not inspect every stored HTML document/),
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails after the bounded HTML retrieval tool-turn limit', async () => {
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: evidenceBucket() };
    const adapter = new KimiChatCompletionsAdapter(env);
    const reference = await uploadReference(
      adapter,
      new TextEncoder().encode(`<main>target</main>${'x'.repeat(300_000)}`),
      'document.txt',
      'text/plain',
    );
    let index = 0;
    const fetchMock = stubFetch().mockImplementation(async () => {
      index += 1;
      return new Response(
        JSON.stringify(
          completion(
            'k3',
            {
              role: 'assistant',
              content: '',
              reasoning_content: 'Read again.',
              tool_calls: [
                {
                  id: `call_limit_${index}`,
                  type: 'function',
                  function: {
                    name: 'kimi_read_html',
                    arguments: '{"document":"html_1","offset":0,"limit":10}',
                  },
                },
              ],
            },
            'tool_calls',
          ),
        ),
      );
    });
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'provider-file', reference },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      inferenceError: {
        failureClass: 'invalid-response',
        message: expect.stringMatching(/exceeded its tool-turn limit/),
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it('keeps overlapping hosted-image uploads inside their own request contexts', async () => {
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: evidenceBucket() };
    const adapter = new KimiChatCompletionsAdapter(env);
    const bytes = new Uint8Array([1, 2, 3]);
    const metadata = await adapter.uploadFile({
      bytes,
      filename: 'image.png',
      mediaType: 'image/png',
      policy: POLICY,
    });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const contentHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const reference = {
      provider: 'kimi' as const,
      accountScope: await adapter.getFileScope(POLICY),
      tenantScope: 'tenant-test',
      filePolicy: POLICY.name,
      compatibleGroups: [ROUTE.promptGroup] as const,
      upstreamFileId: metadata.id,
      contentHash,
      mediaType: metadata.mediaType,
      sizeBytes: metadata.sizeBytes,
      expiresAt: metadata.expiresAt,
    };
    let fileCall = 0;
    const uploadSignals: AbortSignal[] = [];
    const fetchMock = stubFetch().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/files')) {
          fileCall += 1;
          if (!(init?.signal instanceof AbortSignal)) throw new Error('missing upload signal');
          uploadSignals.push(init.signal);
          if (fileCall === 1) {
            return await new Promise<Response>((_resolve, reject) => {
              const abort = () => reject(new DOMException('Aborted', 'AbortError'));
              if (init?.signal?.aborted) abort();
              else init?.signal?.addEventListener('abort', abort, { once: true });
            });
          }
          return new Response(
            JSON.stringify({
              id: 'hosted_shared',
              object: 'file',
              bytes: 3,
              created_at: 1,
              filename: 'image.png',
              purpose: 'image',
              status: 'ok',
            }),
          );
        }
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return new Response(JSON.stringify(completion()));
      },
    );
    const inference = (abortSignal?: AbortSignal) =>
      request({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'provider-file', reference },
                cache: 'none',
              },
            ],
          },
        ],
        ...(abortSignal ? { abortSignal } : {}),
      });
    const controller = new AbortController();
    const secondController = new AbortController();
    const first = adapter.complete(inference(controller.signal));
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files')),
      ).toHaveLength(1),
    );
    const second = adapter.complete(inference(secondController.signal));
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files')),
      ).toHaveLength(2),
    );
    controller.abort();
    await expect(first).rejects.toMatchObject({
      inferenceError: { code: 'cancelled', failureClass: 'cancelled' },
    });
    await expect(second).resolves.toMatchObject({ stopReason: 'completed' });
    await expect(adapter.complete(inference())).resolves.toMatchObject({ stopReason: 'completed' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      2,
    );
    expect(uploadSignals[0]).not.toBe(uploadSignals[1]);
  });

  it('does not let an aborted request block a later hosted-image request', async () => {
    const bucket = evidenceBucket();
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: bucket };
    const adapter = new KimiChatCompletionsAdapter(env);
    const bytes = new Uint8Array([1, 2, 3]);
    const metadata = await adapter.uploadFile({
      bytes,
      filename: 'image.png',
      mediaType: 'image/png',
      policy: POLICY,
    });
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const reference = {
      provider: 'kimi' as const,
      accountScope: await adapter.getFileScope(POLICY),
      tenantScope: 'tenant-test',
      filePolicy: POLICY.name,
      compatibleGroups: [ROUTE.promptGroup] as const,
      upstreamFileId: metadata.id,
      contentHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      mediaType: metadata.mediaType,
      sizeBytes: metadata.sizeBytes,
      expiresAt: metadata.expiresAt,
    };
    const originalHead = bucket.head.bind(bucket);
    let releaseHead: (() => void) | undefined;
    const headGate = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    const head = vi.spyOn(bucket, 'head').mockImplementation(async (...args) => {
      await headGate;
      return originalHead(...args);
    });
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/files')) {
        return new Response(
          JSON.stringify({
            id: 'hosted_late_join',
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'image.png',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      return new Response(JSON.stringify(completion()));
    });
    const inference = (abortSignal?: AbortSignal) =>
      request({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'provider-file', reference },
                cache: 'none',
              },
            ],
          },
        ],
        ...(abortSignal ? { abortSignal } : {}),
      });
    const controller = new AbortController();
    const first = adapter.complete(inference(controller.signal));
    await vi.waitFor(() => expect(head).toHaveBeenCalledTimes(1));
    controller.abort();
    const second = adapter.complete(inference());
    await vi.waitFor(() => expect(head).toHaveBeenCalledTimes(2));
    releaseHead?.();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toMatchObject({ stopReason: 'completed' });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      1,
    );
  });

  it('does not start queued hosted-image work after its request is aborted', async () => {
    const bucket = evidenceBucket();
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: bucket };
    const adapter = new KimiChatCompletionsAdapter(env);
    const accountScope = await adapter.getFileScope(POLICY);
    const references = await Promise.all(
      [1, 2, 3].map(async (value) => {
        const bytes = new Uint8Array([value]);
        const metadata = await adapter.uploadFile({
          bytes,
          filename: `${value}.png`,
          mediaType: 'image/png',
          policy: POLICY,
        });
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          provider: 'kimi' as const,
          accountScope,
          tenantScope: 'tenant-test',
          filePolicy: POLICY.name,
          compatibleGroups: [ROUTE.promptGroup] as const,
          upstreamFileId: metadata.id,
          contentHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
          mediaType: metadata.mediaType,
          sizeBytes: metadata.sizeBytes,
          expiresAt: metadata.expiresAt,
        };
      }),
    );
    const head = vi.spyOn(bucket, 'head');
    const fetchMock = stubFetch().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith('/v1/files')) {
          throw new Error(`Unexpected outbound request: ${String(input)}`);
        }
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      },
    );
    const controller = new AbortController();
    const pending = adapter.complete(
      request({
        abortSignal: controller.signal,
        messages: [
          {
            role: 'user',
            content: references.map((reference) => ({
              type: 'image' as const,
              source: { type: 'provider-file' as const, reference },
              cache: 'none' as const,
            })),
          },
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files')),
      ).toHaveLength(2),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      inferenceError: { code: 'cancelled', failureClass: 'cancelled' },
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      2,
    );
    expect(head).toHaveBeenCalledTimes(2);
  });

  it('reads stored text evidence sequentially', async () => {
    const bucket = evidenceBucket();
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: bucket };
    const adapter = new KimiChatCompletionsAdapter(env);
    const accountScope = await adapter.getFileScope(POLICY);
    const references = await Promise.all(
      ['first', 'second'].map(async (text) => {
        const bytes = new TextEncoder().encode(text);
        const metadata = await adapter.uploadFile({
          bytes,
          filename: `${text}.txt`,
          mediaType: 'text/plain',
          policy: POLICY,
        });
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return {
          provider: 'kimi' as const,
          accountScope,
          tenantScope: 'tenant-test',
          filePolicy: POLICY.name,
          compatibleGroups: [ROUTE.promptGroup] as const,
          upstreamFileId: metadata.id,
          contentHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
          mediaType: metadata.mediaType,
          sizeBytes: metadata.sizeBytes,
          expiresAt: metadata.expiresAt,
        };
      }),
    );
    const originalGet = bucket.get.bind(bucket);
    let activeReads = 0;
    let peakReads = 0;
    vi.spyOn(bucket, 'get').mockImplementation(async (...args: Parameters<R2Bucket['get']>) => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        return await originalGet(...args);
      } finally {
        activeReads -= 1;
      }
    });
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(JSON.stringify(completion()), { status: 200 }),
    );
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: references.map((reference) => ({
                type: 'document' as const,
                source: { type: 'provider-file' as const, reference },
                cache: 'none' as const,
              })),
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ stopReason: 'completed' });
    expect(peakReads).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts HTML selection usage once when an expired hosted image triggers retry', async () => {
    const env: Env = { ...KIMI_ENV, INLINE_EVIDENCE_R2: evidenceBucket() };
    const adapter = new KimiChatCompletionsAdapter(env);
    const accountScope = await adapter.getFileScope(POLICY);
    const upload = async (bytes: Uint8Array, mediaType: string, filename: string) => {
      const metadata = await adapter.uploadFile({ bytes, filename, mediaType, policy: POLICY });
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return {
        provider: 'kimi' as const,
        accountScope,
        tenantScope: 'tenant-test',
        filePolicy: POLICY.name,
        compatibleGroups: [ROUTE.promptGroup] as const,
        upstreamFileId: metadata.id,
        contentHash: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        mediaType: metadata.mediaType,
        sizeBytes: metadata.sizeBytes,
        expiresAt: metadata.expiresAt,
      };
    };
    const html = await upload(
      new TextEncoder().encode(`<section id="hero">Target</section>${'x'.repeat(300_000)}`),
      'text/plain',
      'document.txt',
    );
    const image = await upload(new Uint8Array([1, 2, 3]), 'image/png', 'image.png');
    let fileIndex = 0;
    let completionIndex = 0;
    const withCacheWrite = (value: Record<string, unknown>, cacheWriteTokens: number) => {
      const current = value.usage as Record<string, unknown>;
      value.usage = {
        ...current,
        prompt_tokens_details: { cache_write_tokens: cacheWriteTokens },
      };
      return value;
    };
    const fetchMock = stubFetch().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/files')) {
        fileIndex += 1;
        return new Response(
          JSON.stringify({
            id: `hosted_${fileIndex}`,
            object: 'file',
            bytes: 3,
            created_at: 1,
            filename: 'image.png',
            purpose: 'image',
            status: 'ok',
          }),
        );
      }
      completionIndex += 1;
      if (completionIndex === 1) {
        return new Response(
          JSON.stringify(
            withCacheWrite(
              completion(
                'k3',
                {
                  role: 'assistant',
                  content: '',
                  reasoning_content: 'Search.',
                  tool_calls: [
                    {
                      id: 'call_html_retry',
                      type: 'function',
                      function: {
                        name: 'kimi_search_html',
                        arguments: '{"document":"html_1","query":"hero"}',
                      },
                    },
                  ],
                },
                'tool_calls',
              ),
              1,
            ),
          ),
        );
      }
      if (completionIndex === 2) {
        return new Response(
          JSON.stringify(
            withCacheWrite(
              completion('k3', {
                role: 'assistant',
                content: 'READY',
                reasoning_content: 'Selected.',
              }),
              2,
            ),
          ),
        );
      }
      if (completionIndex === 3) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'resource_not_found_error',
              code: 'resource_not_found_error',
              message: 'Image expired',
            },
          }),
          { status: 404 },
        );
      }
      return new Response(JSON.stringify(withCacheWrite(completion(), 4)));
    });
    const result = await adapter.complete(
      request({
        filePolicy: POLICY,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'provider-file', reference: html },
                cache: 'none',
              },
              {
                type: 'image',
                source: { type: 'provider-file', reference: image },
                cache: 'none',
              },
            ],
          },
        ],
      }),
    );
    expect(result.usage).toMatchObject({
      inputTokens: 36,
      outputTokens: 15,
      cacheWriteInputTokens: 7,
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/files'))).toHaveLength(
      2,
    );
    expect(completionIndex).toBe(4);
  });

  it('accepts the subscription stream repeating identical terminal usage in an empty-choices chunk', async () => {
    const fetchMock = stubFetch();
    const usage = {
      prompt_tokens: 89,
      completion_tokens: 33,
      total_tokens: 122,
      prompt_tokens_details: { cache_write_tokens: 21 },
      completion_tokens_details: { reasoning_tokens: 17 },
    };
    fetchMock.mockResolvedValue(
      sse([
        chunk({ role: 'assistant', reasoning_content: 'Check briefly.' }, null, {
          model: 'kimi-for-coding',
        }),
        chunk({ content: 'OK' }, null, { model: 'kimi-for-coding' }),
        chunk({}, 'stop', {
          model: 'kimi-for-coding',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop', usage }],
        }),
        chunk({}, null, {
          model: 'kimi-for-coding',
          choices: [],
          usage: {
            total_tokens: 122,
            completion_tokens: 33,
            prompt_tokens: 89,
            prompt_tokens_details: { cache_write_tokens: 21 },
            completion_tokens_details: { reasoning_tokens: 17 },
          },
        }),
        '[DONE]',
      ]),
    );
    const events = await collect(
      createInferenceService(KIMI_ENV).stream(
        request({
          modelProfile: { ...PROFILE, name: 'kimi-code-coding', model: 'kimi-for-coding' },
        }),
      ),
    );
    const terminal = events.at(-1);
    if (terminal?.type !== 'complete') throw new Error('missing terminal event');
    expect(terminal.result.stopReason).toBe('completed');
    expect(terminal.result.usage.inputTokens).toBe(89);
    expect(terminal.result.usage.outputTokens).toBe(33);
    expect(terminal.result.usage.cacheWriteInputTokens).toBe(21);
  });

  it('streams the Chat Completions lifecycle without requiring ordinary continuation', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        sse([
          chunk({ role: 'assistant', content: 'Hello', reasoning_content: 'Be brief.' }),
          chunk({}, 'stop', {
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
          '[DONE]',
        ]),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())));
    const events = await collect(new KimiChatCompletionsAdapter(KIMI_ENV).stream(request()));
    const terminal = events.at(-1);
    if (terminal?.type !== 'complete') throw new Error('missing terminal event');
    expect(terminal.result.providerState?.backend).toBe('kimi');
    expect(terminal.result.providerState?.requiredOnNextTurn).toBeUndefined();

    const done = await toDonePayload(
      { ...terminal.result, iterations: 1, text: 'Hello' },
      ROUTE,
      KIMI_ENV,
    );
    expect(done.continuation).toBeUndefined();
    await createInferenceService(KIMI_ENV).complete(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hello', cache: 'none' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello', cache: 'none' }] },
          { role: 'user', content: [{ type: 'text', text: 'More', cache: 'none' }] },
        ],
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 1).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'More' },
    ]);
  });

  it('refuses a continuation minted for the metered account', async () => {
    const fetchMock = stubFetch();
    await expect(
      new KimiChatCompletionsAdapter(KIMI_ENV).complete(
        request({
          messages: [
            { role: 'assistant', content: [{ type: 'text', text: 'Prior', cache: 'none' }] },
          ],
          continuation: { backend: 'moonshot', value: {} },
        }),
      ),
    ).rejects.toThrow(/Kimi Code cannot consume moonshot continuation state/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes quota exhaustion as a fatal 403 and overload as a retryable 429', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "You've reached your weekly (7-day) usage limit.", type: 'quota' },
        }),
        { status: 403 },
      ),
    );
    await expect(
      new KimiChatCompletionsAdapter(KIMI_ENV).complete(request()),
    ).rejects.toMatchObject({
      inferenceError: {
        backend: 'kimi',
        status: 403,
        retryable: false,
        message: 'Kimi Code request failed (403)',
      },
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: 'engine overloaded', type: 'engine_overloaded_error' },
        }),
        { status: 429 },
      ),
    );
    await expect(
      new KimiChatCompletionsAdapter(KIMI_ENV).complete(request()),
    ).rejects.toMatchObject({
      inferenceError: { backend: 'kimi', status: 429, retryable: true },
    });
  });

  it('is selected only through the provider-neutral factory', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await expect(createInferenceService(KIMI_ENV).complete(request())).resolves.toMatchObject({
      stopReason: 'completed',
    });
    expect(requiresOrdinaryTurnContinuation(PROFILE, KIMI_ENV)).toBe(false);
    await expect(
      new KimiChatCompletionsAdapter(KIMI_ENV).complete(
        request({ modelProfile: { ...PROFILE, provider: 'moonshot' } }),
      ),
    ).rejects.toThrow(/Kimi Code adapter cannot serve moonshot/);
  });
});
