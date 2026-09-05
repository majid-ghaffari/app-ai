/** Gemini adapter fixtures. Every provider call is mocked/no-credit. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/config';
import type {
  FilePolicy,
  InferenceEvent,
  InferenceRequest,
  ModelProfile,
  ProviderContinuationState,
} from '../src/lib/inference-types';
import { InferenceFailure } from '../src/inference/adapter';
import { GeminiGenerateContentAdapter } from '../src/inference/adapters/gemini';
import { decodeMessagesContinuation } from '../src/handlers/messages';
import { toDonePayload } from '../src/handlers/chat';
import {
  createInferenceDiagnosticsService,
  createInferenceFileService,
  createInferenceService,
  isRequiredContinuationMissing,
  requiresOrdinaryTurnContinuation,
} from '../src/inference/factory';
import { ENV, fetchCall, headerOf, sentBody, stubFetch } from './helpers';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GEMINI_ENV: Env = {
  ...ENV,
  GEMINI_API_BASE: GEMINI_BASE,
  GEMINI_API_KEY: 'test-gemini-key',
};

const PROFILE: ModelProfile = {
  name: 'gemini-flash-test',
  provider: 'gemini',
  apiFamily: 'gemini-generate-content',
  model: 'gemini-3.5-flash',
  capabilities: {
    vision: true,
    providerFiles: true,
    streaming: true,
    structuredOutput: true,
    serverTools: true,
    clientTools: true,
    reasoning: true,
    inlineCacheBreakpoints: false,
  },
};

const POLICY: FilePolicy = {
  name: 'gemini-direct-files',
  provider: 'gemini',
  compatibleApiFamilies: ['gemini-generate-content'],
  inputMode: 'provider-file',
  lifecycle: 'provider-managed',
  purpose: null,
};

const SCHEMA = {
  type: 'object' as const,
  properties: { city: { type: 'string' } },
  required: ['city'],
};

const ROUTE = {
  tenantScope: 'tenant-test',
  promptGroup: 'gemini-test-group',
  modelProfile: PROFILE.name,
};

interface GeminiPartView {
  text?: string;
  thoughtSignature?: string;
  functionCall?: { id: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id: string; name: string; response: { output: string } };
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
}

interface GeminiContentView {
  role: string;
  parts: GeminiPartView[];
}

function contentsOf(init: RequestInit): GeminiContentView[] {
  return sentBody(init).contents as unknown as GeminiContentView[];
}

/** The exact bytes sent, for prefix-stability assertions. */
function bodyOf(init: RequestInit): string {
  if (typeof init.body !== 'string') throw new Error('fetch call body is not a JSON string');
  return init.body;
}

function sharedPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function request(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    prompt: 'Stable system instructions',
    promptGroup: ROUTE.promptGroup,
    modelProfile: PROFILE,
    filePolicy: POLICY,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache: 'none' }] }],
    maxOutputTokens: 4096,
    effort: 'high',
    tools: [
      {
        name: 'weather',
        description: 'Get weather',
        inputSchema: SCHEMA,
        execution: 'server',
      },
    ],
    toolChoice: { mode: 'auto' },
    stopSequences: ['END'],
    ...overrides,
  };
}

function usage(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    promptTokenCount: 12,
    candidatesTokenCount: 5,
    totalTokenCount: 20,
    cachedContentTokenCount: 4,
    thoughtsTokenCount: 3,
    ...overrides,
  };
}

function completion(
  parts: readonly Readonly<Record<string, unknown>>[] = [{ text: 'Hello back' }],
  finishReason: string | null = 'STOP',
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts },
        ...(finishReason === null ? {} : { finishReason }),
      },
    ],
    usageMetadata: usage(),
    modelVersion: 'gemini-3.5-flash-002',
    responseId: 'resp_test',
    ...overrides,
  };
}

function chunk(
  parts: readonly Readonly<Record<string, unknown>>[],
  finishReason: string | null = null,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts },
        ...(finishReason === null ? {} : { finishReason }),
      },
    ],
    responseId: 'resp_stream',
    ...overrides,
  };
}

function sse(events: readonly Readonly<Record<string, unknown>>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function fileRecord(
  name = 'files/abc-123',
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    name,
    displayName: 'screenshot.png',
    mimeType: 'image/png',
    sizeBytes: '184040',
    createTime: '2026-09-04T00:00:00Z',
    updateTime: '2026-09-04T00:00:00Z',
    expirationTime: '2026-09-06T00:00:00Z',
    state: 'ACTIVE',
    uri: `${GEMINI_BASE}/${name}`,
    ...overrides,
  };
}

function uploadStart(
  uploadUrl = `${GEMINI_BASE.replace('/v1beta', '/upload/v1beta')}/files?upload_id=u1`,
): Response {
  return new Response(JSON.stringify({}), { headers: { 'X-Goog-Upload-URL': uploadUrl } });
}

async function collect(events: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const collected: InferenceEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => vi.restoreAllMocks());

describe('Gemini request translation', () => {
  it('serializes the documented generateContent contract and its auth header', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(
      request({
        structuredOutput: {
          name: 'answer',
          description: 'JSON answer',
          schema: SCHEMA,
          strict: false,
        },
      }),
    );

    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe(`${GEMINI_BASE}/models/gemini-3.5-flash:generateContent`);
    expect(headerOf(call.init, 'x-goog-api-key')).toBe('test-gemini-key');
    expect(headerOf(call.init, 'Authorization')).toBeUndefined();
    expect(sentBody(call.init)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      systemInstruction: { parts: [{ text: 'Stable system instructions' }] },
      tools: [
        {
          functionDeclarations: [
            { name: 'weather', description: 'Get weather', parameters: SCHEMA },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        // The canonical 4096-token ANSWER budget plus the `high` thinking
        // allowance that shares Gemini's single `maxOutputTokens` with it.
        maxOutputTokens: 20480,
        stopSequences: ['END'],
        thinkingConfig: { thinkingLevel: 'high' },
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
      },
    });
  });

  it('serializes the stable prefix ahead of the volatile conversation tail', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(completion())));
    const evidence = {
      type: 'image',
      source: {
        type: 'provider-file',
        reference: {
          provider: 'gemini',
          accountScope: 'gemini:scope',
          tenantScope: 'tenant-test',
          filePolicy: POLICY.name,
          compatibleGroups: [ROUTE.promptGroup],
          upstreamFileId: 'files/abc-123',
          contentHash: 'hash',
          mediaType: 'image/png',
          sizeBytes: 4,
          expiresAt: null,
        },
      },
      cache: 'extended',
    } as const;
    const turn = (text: string): InferenceRequest =>
      request({
        messages: [{ role: 'user', content: [evidence, { type: 'text', text, cache: 'none' }] }],
      });
    const adapter = new GeminiGenerateContentAdapter(GEMINI_ENV);
    await adapter.complete(turn('Which page is this?'));
    await adapter.complete(turn('Which page is this?'));
    await adapter.complete(turn('And what colour is the header?'));

    const first = bodyOf(fetchCall(fetchMock, 0).init);
    const repeat = bodyOf(fetchCall(fetchMock, 1).init);
    const divergent = bodyOf(fetchCall(fetchMock, 2).init);
    // Nothing in the request varies per call by itself.
    expect(repeat).toBe(first);
    const shared = first.slice(0, sharedPrefixLength(first, divergent));
    // Every component that repeats across calls of one prompt — including the
    // reusable evidence block — is already inside the byte-identical prefix, and
    // only the per-call text differs after it.
    for (const stable of [
      '"systemInstruction"',
      '"tools"',
      '"toolConfig"',
      '"generationConfig"',
      '"contents"',
      'files/abc-123',
    ]) {
      expect(shared).toContain(stable);
    }
    expect(first.slice(shared.length)).toContain('Which page is this?');
    expect(divergent.slice(shared.length)).toContain('And what colour is the header?');
  });

  it('joins canonical system messages into the separate systemInstruction', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(
      request({
        messages: [
          {
            role: 'system',
            content: [{ type: 'text', text: 'Extra guidance', cache: 'extended' }],
          },
          { role: 'user', content: [{ type: 'text', text: 'Hello', cache: 'none' }] },
        ],
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init).systemInstruction).toEqual({
      parts: [{ text: 'Stable system instructions\n\nExtra guidance' }],
    });
  });

  it.each([
    ['low', 'low', 8192],
    ['medium', 'medium', 12288],
    ['high', 'high', 20480],
    ['xhigh', 'high', 20480],
  ] as const)(
    'maps canonical effort %s to thinkingLevel %s and budgets the answer plus its allowance',
    async (effort, level, maxOutputTokens) => {
      const fetchMock = stubFetch();
      fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
      await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(
        request({ effort, maxOutputTokens: 4096 }),
      );
      expect(sentBody(fetchCall(fetchMock, 0).init).generationConfig).toMatchObject({
        thinkingConfig: { thinkingLevel: level },
        maxOutputTokens,
      });
    },
  );

  it('keeps the canonical answer budget whole for an effort-free request', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    const { effort: _effort, ...effortFree } = request({ maxOutputTokens: 512 });
    await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(effortFree);
    // No declared effort still pins a level and still reserves for it, so the
    // 512-token answer budget is never spent on thinking.
    expect(sentBody(fetchCall(fetchMock, 0).init).generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: 'high' },
      maxOutputTokens: 16896,
    });
  });

  it.each([
    [{ mode: 'auto' } as const, { mode: 'AUTO' }],
    [{ mode: 'none' } as const, { mode: 'NONE' }],
    [{ mode: 'required' } as const, { mode: 'ANY' }],
    [
      { mode: 'specific', name: 'weather' } as const,
      { mode: 'ANY', allowedFunctionNames: ['weather'] },
    ],
  ])('maps canonical tool choice %j', async (toolChoice, expected) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request({ toolChoice }));
    expect(sentBody(fetchCall(fetchMock, 0).init).toolConfig).toEqual({
      functionCallingConfig: expected,
    });
  });

  it('rejects every canonical control Gemini does not document, before provider I/O', async () => {
    const fetchMock = stubFetch();
    const adapter = new GeminiGenerateContentAdapter(GEMINI_ENV);
    await expect(
      adapter.complete(
        request({
          structuredOutput: { name: 'answer', schema: SCHEMA, strict: true },
        }),
      ),
    ).rejects.toThrow(/guarantees syntax only and cannot be strict/);
    await expect(
      adapter.complete(
        request({
          tools: [
            {
              name: 'weather',
              description: 'Get weather',
              inputSchema: SCHEMA,
              strict: true,
              execution: 'server',
            },
          ],
        }),
      ),
    ).rejects.toThrow(/OpenAPI subset and cannot be strict/);
    await expect(adapter.complete(request({ sampling: { temperature: 0.4 } }))).rejects.toThrow(
      /sampling values are provider-fixed/,
    );
    await expect(adapter.complete(request({ metadata: { tag: 'x' } }))).rejects.toThrow(
      /does not support canonical metadata/,
    );
    await expect(adapter.complete(request({ serviceTier: 'flex' }))).rejects.toThrow(
      /does not support canonical service tiers/,
    );
    await expect(
      adapter.complete(request({ toolChoice: { mode: 'auto', disableParallel: true } })),
    ).rejects.toThrow(/parallel-tool-call control/);
    await expect(
      adapter.complete(
        request({
          tools: [
            {
              name: 'hosted',
              description: 'Hosted',
              execution: 'provider',
              providerState: { backend: 'gemini', value: {} },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/provider-hosted tools are not supported/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['gemini-2.5-flash', /does not support model/],
    ['claude-opus-4-8', /does not support model/],
    ['gemini-3.1-flash-image', /does not serve generateContent/],
    ['gemini-3.5-transcribe', /does not serve generateContent/],
  ])('refuses model %s', async (model, expected) => {
    const fetchMock = stubFetch();
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(
        request({ modelProfile: { ...PROFILE, model } }),
      ),
    ).rejects.toThrow(expected);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Gemini multimodal input', () => {
  it('sends inline bytes as camelCase inlineData and uploads as a full fileData uri', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(
      request({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'AAA' },
                cache: 'extended',
              },
              {
                type: 'image',
                source: {
                  type: 'provider-file',
                  reference: {
                    provider: 'gemini',
                    accountScope: 'gemini:scope',
                    tenantScope: 'tenant-test',
                    filePolicy: POLICY.name,
                    compatibleGroups: [ROUTE.promptGroup],
                    upstreamFileId: 'files/abc-123',
                    contentHash: 'hash',
                    mediaType: 'image/png',
                    sizeBytes: 4,
                    expiresAt: null,
                  },
                },
                cache: 'none',
              },
              {
                type: 'document',
                source: { type: 'text', mediaType: 'text/plain', text: '<html/>' },
                title: 'Page',
                cache: 'none',
              },
            ],
          },
        ],
      }),
    );
    expect(contentsOf(fetchCall(fetchMock, 0).init)).toEqual([
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'AAA' } },
          { fileData: { mimeType: 'image/png', fileUri: `${GEMINI_BASE}/files/abc-123` } },
          { text: 'Page\n<html/>' },
        ],
      },
    ]);
  });

  it('rejects media Gemini does not document and foreign file references', async () => {
    const fetchMock = stubFetch();
    const adapter = new GeminiGenerateContentAdapter(GEMINI_ENV);
    const image = (source: Record<string, unknown>): InferenceRequest =>
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: source as never, cache: 'none' }],
          },
        ],
      });
    await expect(
      adapter.complete(image({ type: 'base64', mediaType: 'image/gif', data: 'AAA' })),
    ).rejects.toThrow(/does not support media type image\/gif/);
    await expect(
      adapter.complete(image({ type: 'url', url: 'https://cdn.example/a.png' })),
    ).rejects.toThrow(/does not support external image URLs/);
    await expect(
      adapter.complete(
        image({
          type: 'provider-file',
          reference: {
            provider: 'openai',
            accountScope: 'openai:scope',
            tenantScope: 'tenant-test',
            filePolicy: POLICY.name,
            compatibleGroups: [ROUTE.promptGroup],
            upstreamFileId: 'file-x',
            contentHash: 'hash',
            mediaType: 'image/png',
            sizeBytes: 4,
            expiresAt: null,
          },
        }),
      ),
    ).rejects.toThrow(/cannot consume openai file references/);
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', mediaType: 'application/zip', data: 'AAA' },
                  citations: { enabled: true },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/does not support citation controls/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Gemini response translation', () => {
  it('concatenates visible text, drops thought parts, and normalizes usage', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          completion([
            { text: 'Reasoning summary', thought: true },
            { text: 'Hello ' },
            { text: 'back' },
          ]),
        ),
      ),
    );
    const result = await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request());
    expect(result.content).toEqual([{ type: 'text', text: 'Hello back', cache: 'none' }]);
    expect(result.stopReason).toBe('completed');
    expect(result.providerStopReason).toBe('STOP');
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cachedInputTokens: 4,
      cacheWriteInputTokens: null,
      reasoningTokens: 3,
      providerDetails: usage(),
    });
  });

  it('treats a functionCall part as a tool-call stop whatever finishReason says', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          completion([
            { text: 'Checking.' },
            {
              functionCall: { id: 'fc_1', name: 'weather', args: { city: 'Paris' } },
              thoughtSignature: 'sig-1',
            },
          ]),
        ),
      ),
    );
    const result = await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request());
    expect(result.stopReason).toBe('tool-call');
    expect(result.providerStopReason).toBe('STOP');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: 'fc_1',
      name: 'weather',
      input: { city: 'Paris' },
    });
    expect(result.toolCalls[0]?.providerState?.backend).toBe('gemini');
    expect(result.providerState?.requiredOnNextTurn).toBe(true);
  });

  it('rejects a function call that arrived without its thought signature', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(completion([{ functionCall: { id: 'fc_1', name: 'weather', args: {} } }])),
      ),
    );
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request()),
    ).rejects.toMatchObject({
      inferenceError: {
        backend: 'gemini',
        code: 'invalid_response',
        message: 'Gemini function call omitted its thought signature',
      },
    });
  });

  it.each([
    ['MAX_TOKENS', 'max-output-tokens'],
    ['SAFETY', 'content-filter'],
    ['PROHIBITED_CONTENT', 'content-filter'],
    ['MALFORMED_FUNCTION_CALL', 'error'],
    ['MISSING_THOUGHT_SIGNATURE', 'error'],
    ['SOMETHING_NEW', 'unknown'],
  ])('maps finishReason %s to %s and keeps the raw string', async (finish, expected) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(completion([{ text: 'partial' }], finish))),
    );
    const result = await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request());
    expect(result.stopReason).toBe(expected);
    expect(result.providerStopReason).toBe(finish);
  });

  it('fails a turn whose whole shared budget was spent on thinking', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify(
          completion(
            [
              { text: 'Weighing the options', thought: true },
              { text: 'Still weighing', thought: true },
            ],
            'MAX_TOKENS',
          ),
        ),
      ),
    );
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request()),
    ).rejects.toMatchObject({
      inferenceError: {
        backend: 'gemini',
        code: 'empty_response',
        failureClass: 'invalid-response',
        message: 'Gemini returned no visible assistant content',
        detail: 'finishReason MAX_TOKENS',
      },
    });
  });

  it('fails any terminal turn that carried neither visible text nor a tool call', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion([{ text: '' }], 'SAFETY'))));
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request()),
    ).rejects.toMatchObject({
      inferenceError: { code: 'empty_response', detail: 'finishReason SAFETY' },
    });
  });

  it('surfaces a prompt-level block with no candidate as a content filter', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          promptFeedback: { blockReason: 'SAFETY' },
          usageMetadata: usage(),
          responseId: 'resp_blocked',
        }),
      ),
    );
    const result = await new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request());
    expect(result.stopReason).toBe('content-filter');
    expect(result.providerStopReason).toBe('SAFETY');
    expect(result.content).toEqual([]);
  });

  it.each([
    ['missing usage', { candidates: completion().candidates, responseId: 'r' }],
    ['no candidate', { usageMetadata: usage(), responseId: 'r' }],
    [
      'unsupported part',
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [{ videoMetadata: {} }] } }],
        usageMetadata: usage(),
      },
    ],
    [
      'invalid function call',
      {
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ functionCall: { name: 'weather' } }] },
          },
        ],
        usageMetadata: usage(),
      },
    ],
  ])('rejects an invalid completion envelope: %s', async (_name, body) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request()),
    ).rejects.toMatchObject({ inferenceError: { failureClass: 'invalid-response' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Gemini streaming', () => {
  it('streams the canonical lifecycle and completes on a clean close', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sse([
        chunk([{ text: 'Hel' }]),
        chunk([{ text: 'lo' }, { text: 'ignored', thought: true }]),
        chunk([{ text: '!' }], 'STOP', { usageMetadata: usage() }),
      ]),
    );
    const events = await collect(new GeminiGenerateContentAdapter(GEMINI_ENV).stream(request()));
    expect(fetchCall(fetchMock, 0).url).toBe(
      `${GEMINI_BASE}/models/gemini-3.5-flash:streamGenerateContent?alt=sse`,
    );
    expect(events.map((event) => event.type)).toEqual([
      'message-start',
      'text-delta',
      'text-delta',
      'text-delta',
      'usage',
      'complete',
    ]);
    const terminal = events.at(-1);
    if (terminal?.type !== 'complete') throw new Error('missing terminal event');
    expect(terminal.result.content).toEqual([{ type: 'text', text: 'Hello!', cache: 'none' }]);
    expect(terminal.result.stopReason).toBe('completed');
  });

  it('accumulates a streamed function call with its part-level signature', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sse([
        chunk([{ text: 'Checking.' }]),
        chunk(
          [
            {
              functionCall: { id: 'fc_stream', name: 'weather', args: { city: 'Paris' } },
              thoughtSignature: 'sig-stream',
            },
          ],
          'STOP',
        ),
        { usageMetadata: usage(), responseId: 'resp_stream', candidates: [] },
      ]),
    );
    const events = await collect(new GeminiGenerateContentAdapter(GEMINI_ENV).stream(request()));
    const call = events.find((event) => event.type === 'tool-call');
    if (call?.type !== 'tool-call') throw new Error('missing tool call');
    expect(call.call).toMatchObject({ id: 'fc_stream', name: 'weather' });
    const terminal = events.at(-1);
    if (terminal?.type !== 'complete') throw new Error('missing terminal event');
    expect(terminal.result.stopReason).toBe('tool-call');
  });

  it.each([
    [
      'no finish reason before close',
      [chunk([{ text: 'partial' }], null, { usageMetadata: usage() })],
    ],
    ['no usage metadata', [chunk([{ text: 'done' }], 'STOP')]],
    [
      'content after the finish reason',
      [chunk([{ text: 'a' }], 'STOP', { usageMetadata: usage() }), chunk([{ text: 'b' }])],
    ],
    [
      'a chunk from another response',
      [
        chunk([{ text: 'a' }]),
        { ...chunk([{ text: 'b' }], 'STOP', { usageMetadata: usage() }), responseId: 'other' },
      ],
    ],
  ])('rejects an invalid stream: %s', async (_name, events) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(sse(events));
    await expect(
      collect(new GeminiGenerateContentAdapter(GEMINI_ENV).stream(request())),
    ).rejects.toMatchObject({ inferenceError: { failureClass: 'invalid-response' } });
  });

  it('fails a stream whose whole shared budget was spent on thinking', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sse([
        chunk([{ text: 'Weighing the options', thought: true }]),
        chunk([{ text: 'Still weighing', thought: true }], 'MAX_TOKENS', {
          usageMetadata: usage({ candidatesTokenCount: 0, thoughtsTokenCount: 241 }),
        }),
      ]),
    );
    await expect(
      collect(new GeminiGenerateContentAdapter(GEMINI_ENV).stream(request())),
    ).rejects.toMatchObject({
      inferenceError: {
        backend: 'gemini',
        code: 'empty_response',
        failureClass: 'invalid-response',
        detail: 'finishReason MAX_TOKENS',
      },
    });
  });

  it('rejects a truncated final event', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(
        `data: ${JSON.stringify(chunk([{ text: 'a' }], 'STOP', { usageMetadata: usage() }))}\n\ndata: {"cand`,
      ),
    );
    await expect(
      collect(new GeminiGenerateContentAdapter(GEMINI_ENV).stream(request())),
    ).rejects.toThrow(/ended with a truncated event/);
  });

  it('raises an in-band mid-stream error frame as a normalized failure', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sse([chunk([{ text: 'a' }]), { error: { code: 500, message: 'boom', status: 'INTERNAL' } }]),
    );
    await expect(
      collect(new GeminiGenerateContentAdapter(GEMINI_ENV).stream(request())),
    ).rejects.toMatchObject({
      inferenceError: { backend: 'gemini', code: 'INTERNAL', retryable: true },
    });
  });
});

describe('Gemini thought-signature continuation', () => {
  it('replays the signature across a full two-request client-tool round trip', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        sse([
          chunk([{ text: 'Checking.' }]),
          chunk(
            [
              {
                functionCall: { id: 'fc_client', name: 'look_at_page', args: { page: '/' } },
                thoughtSignature: 'sig-client',
              },
            ],
            'STOP',
            { usageMetadata: usage() },
          ),
        ]),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(completion([{ text: 'All done' }]))));

    // Request one: the browser-tool turn stops with the calls the client runs.
    const first = await createInferenceService(GEMINI_ENV).runAgent({
      ...request({ tools: [] }),
      mode: 'client',
      maxIterations: 4,
      tools: [
        {
          name: 'look_at_page',
          description: 'Screenshot the storefront',
          inputSchema: { type: 'object', properties: { page: { type: 'string' } } },
          execution: 'client',
        },
      ],
    });
    expect(first.stopReason).toBe('tool-call');
    const done = await toDonePayload(first, ROUTE, GEMINI_ENV);
    expect(done.toolCalls).toEqual([
      { id: 'fc_client', name: 'look_at_page', input: { page: '/' } },
    ]);
    expect(typeof done.continuation).toBe('string');

    // Request two: a separate HTTP request carrying only the opaque token.
    const continuation = await decodeMessagesContinuation(
      done.continuation,
      ROUTE,
      'gemini',
      GEMINI_ENV,
    );
    if (!continuation) throw new Error('missing client-tool continuation');
    await createInferenceService(GEMINI_ENV).complete(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hello', cache: 'none' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Checking.', cache: 'none' },
              {
                type: 'tool-call',
                id: 'fc_client',
                name: 'look_at_page',
                input: { page: '/' },
                cache: 'none',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'fc_client',
                content: [{ type: 'text', text: 'captured', cache: 'none' }],
                isError: false,
                cache: 'none',
              },
            ],
          },
        ],
        continuation,
      }),
    );

    const replayed = contentsOf(fetchCall(fetchMock, 1).init);
    expect(replayed).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      {
        role: 'model',
        parts: [
          { text: 'Checking.' },
          {
            functionCall: { id: 'fc_client', name: 'look_at_page', args: { page: '/' } },
            thoughtSignature: 'sig-client',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc_client',
              name: 'look_at_page',
              response: { output: 'captured' },
            },
          },
        ],
      },
    ]);
  });

  it('keeps the signature through a server-executed agent iteration', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        sse([
          chunk(
            [
              {
                functionCall: { id: 'fc_agent', name: 'weather', args: { city: 'Paris' } },
                thoughtSignature: 'sig-agent',
              },
            ],
            'STOP',
            { usageMetadata: usage() },
          ),
        ]),
      )
      .mockResolvedValueOnce(sse([chunk([{ text: 'Sunny' }], 'STOP', { usageMetadata: usage() })]));
    const result = await createInferenceService(GEMINI_ENV).runAgent({
      ...request(),
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
    expect(result).toMatchObject({ text: 'Sunny', stopReason: 'completed', iterations: 2 });
    expect(contentsOf(fetchCall(fetchMock, 1).init)).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'fc_agent', name: 'weather', args: { city: 'Paris' } },
            thoughtSignature: 'sig-agent',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: { id: 'fc_agent', name: 'weather', response: { output: 'Sunny' } },
          },
        ],
      },
    ]);
  });

  it('seals capped terminal tool results so the next request replays them', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        sse([
          chunk(
            [
              {
                functionCall: { id: 'fc_capped', name: 'weather', args: { city: 'Paris' } },
                thoughtSignature: 'sig-capped',
              },
            ],
            'STOP',
            { usageMetadata: usage() },
          ),
        ]),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())));
    const result = await createInferenceService(GEMINI_ENV).runAgent({
      ...request(),
      mode: 'server',
      maxIterations: 1,
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
    expect(result.stopReason).toBe('max-iterations');
    const done = await toDonePayload(result, ROUTE, GEMINI_ENV);
    const continuation = await decodeMessagesContinuation(
      done.continuation,
      ROUTE,
      'gemini',
      GEMINI_ENV,
    );
    if (!continuation) throw new Error('missing capped continuation');
    await createInferenceService(GEMINI_ENV).complete(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hello', cache: 'none' }] },
          { role: 'assistant', content: [] },
          { role: 'user', content: [{ type: 'text', text: 'Continue', cache: 'none' }] },
        ],
        continuation,
      }),
    );
    expect(contentsOf(fetchCall(fetchMock, 1).init)).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: { id: 'fc_capped', name: 'weather', args: { city: 'Paris' } },
            thoughtSignature: 'sig-capped',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: { id: 'fc_capped', name: 'weather', response: { output: 'Sunny' } },
          },
        ],
      },
      { role: 'user', parts: [{ text: 'Continue' }] },
    ]);
  });

  it('fails closed on lost, foreign, or mismatched continuation state', async () => {
    const fetchMock = stubFetch();
    const adapter = new GeminiGenerateContentAdapter(GEMINI_ENV);
    const assistant = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Prior', cache: 'none' as const }],
    };
    await expect(adapter.complete(request({ messages: [assistant] }))).rejects.toThrow(
      /assistant history requires authenticated continuation state/,
    );
    const foreign: ProviderContinuationState = { backend: 'openai', value: {} };
    await expect(
      adapter.complete(request({ messages: [assistant], continuation: foreign })),
    ).rejects.toThrow(/cannot consume openai continuation state/);
    const stripped: ProviderContinuationState = {
      backend: 'gemini',
      value: {
        segments: [
          {
            transcript: [
              {
                role: 'model',
                parts: [{ functionCall: { id: 'fc_1', name: 'weather', args: {} } }],
              },
            ],
            publicAssistant: {
              text: '',
              toolCalls: [{ id: 'fc_1', name: 'weather', input: {} }],
            },
          },
        ],
      },
      requiredOnNextTurn: true,
    };
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  id: 'fc_1',
                  name: 'weather',
                  input: {},
                  cache: 'none',
                },
              ],
            },
          ],
          continuation: stripped,
        }),
      ),
    ).rejects.toThrow(/function-call replay is missing its thought signature/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Gemini file lifecycle', () => {
  it('uploads through the documented two-call resumable protocol', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(uploadStart())
      .mockResolvedValueOnce(new Response(JSON.stringify({ file: fileRecord() })));
    const uploaded = await createInferenceFileService(GEMINI_ENV).upload(
      PROFILE,
      POLICY,
      new Uint8Array([1, 2, 3]),
      'screenshot.png',
      'image/png',
    );
    expect(uploaded).toEqual({
      id: 'files/abc-123',
      mediaType: 'image/png',
      sizeBytes: 184040,
      expiresAt: '2026-09-06T00:00:00Z',
    });
    const start = fetchCall(fetchMock, 0);
    expect(start.url).toBe('https://generativelanguage.googleapis.com/upload/v1beta/files');
    expect(headerOf(start.init, 'X-Goog-Upload-Protocol')).toBe('resumable');
    expect(headerOf(start.init, 'X-Goog-Upload-Command')).toBe('start');
    expect(headerOf(start.init, 'X-Goog-Upload-Header-Content-Length')).toBe('3');
    expect(headerOf(start.init, 'X-Goog-Upload-Header-Content-Type')).toBe('image/png');
    expect(JSON.parse(String(start.init.body))).toEqual({
      file: { display_name: 'screenshot.png' },
    });
    const finish = fetchCall(fetchMock, 1);
    expect(finish.url).toBe(
      'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=u1',
    );
    expect(headerOf(finish.init, 'X-Goog-Upload-Command')).toBe('upload, finalize');
    expect(headerOf(finish.init, 'X-Goog-Upload-Offset')).toBe('0');
    expect(headerOf(finish.init, 'x-goog-api-key')).toBeUndefined();
  });

  it('polls a PROCESSING upload until it is active', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(uploadStart())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ file: fileRecord('files/slow', { state: 'PROCESSING' }) })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(fileRecord('files/slow'))));
    const uploaded = await createInferenceFileService(GEMINI_ENV).upload(
      PROFILE,
      POLICY,
      new Uint8Array([1]),
      'slow.png',
      'image/png',
    );
    expect(uploaded.id).toBe('files/slow');
    expect(fetchCall(fetchMock, 2).url).toBe(`${GEMINI_BASE}/files/slow`);
  });

  it('fails closed on a failed upload, a foreign upload endpoint, and a uri mismatch', async () => {
    const fetchMock = stubFetch();
    const files = createInferenceFileService(GEMINI_ENV);
    fetchMock
      .mockResolvedValueOnce(uploadStart())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ file: fileRecord('files/x', { state: 'FAILED' }) })),
      );
    await expect(
      files.upload(PROFILE, POLICY, new Uint8Array([1]), 'a.png', 'image/png'),
    ).rejects.toThrow(/failed to process/);

    fetchMock.mockResolvedValueOnce(uploadStart('https://evil.example/upload'));
    await expect(
      files.upload(PROFILE, POLICY, new Uint8Array([1]), 'a.png', 'image/png'),
    ).rejects.toThrow(/left the configured Gemini origin/);

    fetchMock
      .mockResolvedValueOnce(uploadStart())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ file: fileRecord('files/y', { uri: 'https://other.example/files/y' }) }),
        ),
      );
    await expect(
      files.upload(PROFILE, POLICY, new Uint8Array([1]), 'a.png', 'image/png'),
    ).rejects.toThrow(/uri did not match its resource name/);

    await expect(
      files.upload(PROFILE, POLICY, new Uint8Array([1]), 'a.svg', 'image/svg+xml'),
    ).rejects.toThrow(/does not support media type image\/svg\+xml/);
  });

  it('reads and deletes files with a stable non-secret account scope', async () => {
    const fetchMock = stubFetch();
    const files = createInferenceFileService(GEMINI_ENV);
    const scope = await files.scope(PROFILE, POLICY);
    expect(scope).toMatch(/^gemini:[a-f0-9]{24}$/);
    await expect(
      createInferenceFileService({ ...GEMINI_ENV, GEMINI_API_KEY: 'other' }).scope(PROFILE, POLICY),
    ).resolves.not.toBe(scope);

    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(files.getMetadata(PROFILE, 'files/gone')).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fileRecord())));
    await expect(files.getMetadata(PROFILE, 'files/abc-123')).resolves.toEqual({
      id: 'files/abc-123',
      mediaType: 'image/png',
      sizeBytes: 184040,
      expiresAt: '2026-09-06T00:00:00Z',
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({})));
    await expect(files.delete(PROFILE, 'files/abc-123')).resolves.toBeUndefined();
    expect(fetchCall(fetchMock, 2).init.method).toBe('DELETE');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true })));
    await expect(files.delete(PROFILE, 'files/abc-123')).rejects.toThrow(
      /file deletion response was invalid/,
    );
  });

  it.each([
    ['foreign provider', { provider: 'openai' as const }],
    ['foreign api family', { compatibleApiFamilies: ['openai-responses'] as const }],
    ['a purpose Gemini has no concept of', { purpose: 'image' }],
    ['inline input mode', { inputMode: 'inline' as const }],
    ['request-scoped lifecycle', { lifecycle: 'request-scoped' as const }],
  ])('refuses a file policy with %s', async (_name, overrides) => {
    const fetchMock = stubFetch();
    await expect(
      createInferenceFileService(GEMINI_ENV).scope(PROFILE, { ...POLICY, ...overrides }),
    ).rejects.toThrow(/cannot use file policy/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Gemini diagnostics, failures, and routing', () => {
  it('estimates tokens through the documented countTokens wrapper', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ totalTokens: 42 })));
    await expect(
      createInferenceDiagnosticsService(GEMINI_ENV).countTokens(request()),
    ).resolves.toBe(42);
    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe(`${GEMINI_BASE}/models/gemini-3.5-flash:countTokens`);
    expect(sentBody(call.init).generateContentRequest).toMatchObject({
      model: 'models/gemini-3.5-flash',
      systemInstruction: { parts: [{ text: 'Stable system instructions' }] },
    });
  });

  it.each([
    [400, { error: { code: 'invalid_request', message: 'bad' } }, 'invalid_request', false],
    [
      400,
      { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } },
      'INVALID_ARGUMENT',
      false,
    ],
    [429, { error: { code: 'rate_limit_exceeded', message: 'slow' } }, 'rate_limit_exceeded', true],
    [429, { error: { code: 'quota_exceeded', message: 'gone' } }, 'quota_exceeded', false],
    [503, { error: { code: 503, status: 'UNAVAILABLE' } }, 'UNAVAILABLE', true],
    [501, { error: { code: 'unimplemented' } }, 'unimplemented', false],
  ])('normalizes a %s failure to code %s', async (status, body, expectedCode, retryable) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    const failure = await new GeminiGenerateContentAdapter(GEMINI_ENV)
      .complete(request())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InferenceFailure);
    expect((failure as InferenceFailure).inferenceError).toMatchObject({
      backend: 'gemini',
      status,
      code: expectedCode,
      retryable,
      failureClass: 'http',
    });
  });

  it('normalizes cancellation, transport, and invalid JSON failures', async () => {
    const fetchMock = stubFetch();
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(
        request({ abortSignal: controller.signal }),
      ),
    ).rejects.toMatchObject({
      inferenceError: { failureClass: 'cancelled', code: 'cancelled', retryable: false },
    });

    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request()),
    ).rejects.toMatchObject({
      inferenceError: { failureClass: 'network', code: 'network_error', retryable: true },
    });

    fetchMock.mockResolvedValueOnce(new Response('not json'));
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(request()),
    ).rejects.toMatchObject({ inferenceError: { code: 'invalid_response' } });
  });

  it('selects Gemini only through the provider-neutral factory', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    await expect(createInferenceService(GEMINI_ENV).complete(request())).resolves.toMatchObject({
      stopReason: 'completed',
    });
    expect(requiresOrdinaryTurnContinuation(PROFILE, GEMINI_ENV)).toBe(true);
    expect(
      isRequiredContinuationMissing(PROFILE, GEMINI_ENV, [{ role: 'assistant' }], undefined),
    ).toBe(true);
    await expect(
      new GeminiGenerateContentAdapter(GEMINI_ENV).complete(
        request({ modelProfile: { ...PROFILE, provider: 'openai' } }),
      ),
    ).rejects.toThrow(/Gemini adapter cannot serve openai/);
  });
});
