import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FilePolicy,
  InferenceRequest,
  ModelProfile,
  ProviderContinuationState,
} from '../src/lib/inference-types';
import { InferenceFailure } from '../src/inference/adapter';
import { MoonshotChatCompletionsAdapter } from '../src/inference/adapters/moonshot';
import { decodeMessagesContinuation, registeredMessagesResponse } from '../src/handlers/messages';
import { toDonePayload } from '../src/handlers/chat';
import {
  createInferenceDiagnosticsService,
  createInferenceFileService,
  createInferenceService,
  isRequiredContinuationMissing,
  requiresOrdinaryTurnContinuation,
} from '../src/inference/factory';
import {
  fileTenantScope,
  mintOpaqueFileReference,
  openOwnedFileReference,
} from '../src/inference/file-references';
import { ENV, fetchCall, sentBody, stubFetch } from './helpers';

const PROFILE: ModelProfile = {
  name: 'kimi-metered-k3',
  provider: 'moonshot',
  apiFamily: 'moonshot-chat-completions',
  model: 'kimi-k3',
  capabilities: {
    vision: true,
    reusableFiles: true,
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
  name: 'moonshot-image-files',
  provider: 'moonshot',
  compatibleApiFamilies: ['moonshot-chat-completions'],
  inputMode: 'provider-file',
  lifecycle: 'provider-managed',
  purpose: 'image',
};

const SCHEMA = {
  type: 'object' as const,
  properties: { city: { type: 'string' } },
  required: ['city'],
  additionalProperties: false,
};

function request(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    prompt: 'Stable system instructions',
    promptGroup: 'kimi-test-group',
    modelProfile: PROFILE,
    filePolicy: POLICY,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello', cache: 'none' }],
      },
    ],
    maxOutputTokens: 4096,
    effort: 'high',
    structuredOutput: {
      name: 'answer',
      description: 'Strict answer',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
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
    toolChoice: { mode: 'auto' },
    stopSequences: ['END'],
    ...overrides,
  };
}

function unstructuredRequest(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  const { structuredOutput: _structuredOutput, ...base } = request(overrides);
  return base;
}

function requestWithoutEffort(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  const { effort: _effort, ...base } = request(overrides);
  return base;
}

function completion(
  message: Readonly<Record<string, unknown>> = {
    role: 'assistant',
    content: 'Hello back',
    reasoning_content: 'I should answer briefly.',
  },
  finishReason = 'stop',
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'cmpl_test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: PROFILE.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
      cached_tokens: 4,
    },
    ...overrides,
  };
}

function chunk(
  delta: Readonly<Record<string, unknown>>,
  finishReason: string | null = null,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'cmpl_stream',
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

function fileRecord(id = 'file_test', purpose = 'image'): Readonly<Record<string, unknown>> {
  return {
    id,
    object: 'file',
    bytes: 123,
    created_at: 1_700_000_000,
    filename: 'image.png',
    purpose,
    status: 'ready',
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Moonshot request and complete translation', () => {
  it('normalizes provider content filtering and rejects an empty successful turn', async () => {
    stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion(
              { role: 'assistant', content: 'Blocked', reasoning_content: 'Policy.' },
              'content_filter',
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion({ role: 'assistant', content: null, reasoning_content: 'Only.' }),
          ),
        ),
      );
    await expect(
      new MoonshotChatCompletionsAdapter(ENV).complete(request()),
    ).resolves.toMatchObject({ stopReason: 'content-filter' });
    await expect(new MoonshotChatCompletionsAdapter(ENV).complete(request())).rejects.toMatchObject(
      {
        inferenceError: { failureClass: 'invalid-response' },
      },
    );
  });

  it('serializes the canonical Kimi contract without leaking provider authority to callers', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));
    const adapter = new MoonshotChatCompletionsAdapter(ENV);

    await adapter.complete(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect', cache: 'extended' },
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
                cache: 'short',
              },
              {
                type: 'image',
                source: {
                  type: 'provider-file',
                  reference: {
                    provider: 'moonshot',
                    accountScope: 'moonshot:account',
                    tenantScope: 'tenant',
                    filePolicy: POLICY.name,
                    compatibleGroups: ['kimi-test-group'],
                    upstreamFileId: 'file_image',
                    contentHash: 'hash',
                    mediaType: 'image/png',
                    sizeBytes: 123,
                    expiresAt: null,
                  },
                },
                cache: 'none',
              },
            ],
          },
        ],
      }),
    );

    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(call.init.headers).toMatchObject({
      Authorization: 'Bearer test-moonshot-key',
      'Content-Type': 'application/json',
    });
    expect(sentBody(call.init)).toEqual({
      model: PROFILE.model,
      messages: [
        { role: 'system', content: 'Stable system instructions' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
            { type: 'image_url', image_url: { url: 'ms://file_image' } },
          ],
        },
      ],
      max_completion_tokens: 4096,
      reasoning_effort: 'high',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
          strict: true,
        },
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
      tool_choice: 'auto',
      stop: ['END'],
    });
  });

  it('normalizes text, usage, stop, and retains reasoning only in opaque Moonshot state', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(completion())));

    const result = await new MoonshotChatCompletionsAdapter(ENV).complete(request());

    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'Hello back', cache: 'none' }],
      toolCalls: [],
      stopReason: 'completed',
      providerStopReason: 'stop',
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cachedInputTokens: 4,
        cacheWriteInputTokens: null,
        reasoningTokens: null,
      },
      providerState: {
        backend: 'moonshot',
        value: {
          assistantMessages: [
            {
              role: 'assistant',
              content: 'Hello back',
              reasoning_content: 'I should answer briefly.',
            },
          ],
        },
      },
    });
  });

  it('preserves complete reasoning_content and tool calls through a second tool round', async () => {
    const fetchMock = stubFetch();
    const assistant = {
      role: 'assistant',
      content: 'Checking weather.',
      reasoning_content: 'I need the weather tool.',
      tool_calls: [
        {
          id: 'call_weather',
          type: 'function',
          function: { name: 'weather', arguments: '{ "city": "Paris" }' },
        },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(completion(assistant, 'tool_calls'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())))
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())));
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    const first = await adapter.complete(unstructuredRequest());

    expect(first.toolCalls).toEqual([
      expect.objectContaining({
        id: 'call_weather',
        name: 'weather',
        input: { city: 'Paris' },
      }),
    ]);
    const second = await adapter.complete(
      unstructuredRequest({
        messages: [
          request().messages[0]!,
          {
            role: 'assistant',
            content: first.content,
            providerState: first.providerState!,
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call_weather',
                content: [{ type: 'text', text: 'Sunny', cache: 'none' }],
                isError: false,
                cache: 'none',
              },
            ],
          },
        ],
        continuation: first.providerState!,
      }),
    );

    expect(sentBody(fetchCall(fetchMock, 1).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      assistant,
      { role: 'tool', tool_call_id: 'call_weather', content: 'Sunny' },
    ]);
    expect(second.providerState).toBeDefined();

    await adapter.complete(
      unstructuredRequest({
        messages: [
          request().messages[0]!,
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Checking weather.\nHello back',
                cache: 'none',
              },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'Confirm', cache: 'none' }] },
        ],
        continuation: second.providerState!,
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 2).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      assistant,
      { role: 'tool', tool_call_id: 'call_weather', content: 'Sunny' },
      {
        role: 'assistant',
        content: 'Hello back',
        reasoning_content: 'I should answer briefly.',
      },
      { role: 'user', content: 'Confirm' },
    ]);
  });

  it('keeps ordinary public turns continuation-free', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())))
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())));
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    const first = await adapter.complete(unstructuredRequest());
    const route = {
      tenantScope: 'tenant-test',
      promptGroup: request().promptGroup,
      modelProfile: PROFILE.name,
    };

    const messagesResponse = await registeredMessagesResponse(
      first,
      request(),
      { 'X-Test': 'messages' },
      ENV,
      route.tenantScope,
    );
    const messagesEnvelope = (await messagesResponse.json()) as { continuation?: string };
    expect(messagesEnvelope.continuation).toBeUndefined();

    await adapter.complete(
      unstructuredRequest({
        messages: [
          request().messages[0]!,
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'text', text: 'Next', cache: 'none' }] },
        ],
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 1).init).messages?.[2]).toEqual({
      role: 'assistant',
      content: 'Hello back',
    });

    const done = await toDonePayload(
      {
        content: first.content,
        toolCalls: [],
        usage: first.usage,
        stopReason: first.stopReason,
        ...(first.providerStopReason !== undefined
          ? { providerStopReason: first.providerStopReason }
          : {}),
        ...(first.providerState ? { providerState: first.providerState } : {}),
        iterations: 1,
        text: 'Hello back',
      },
      route,
      ENV,
    );
    expect(done.continuation).toBeUndefined();

    const ordinaryAnthropic = await toDonePayload(
      {
        content: [{ type: 'text', text: 'parity', cache: 'none' }],
        toolCalls: [],
        usage: first.usage,
        stopReason: 'completed',
        providerState: { backend: 'anthropic', value: { contentBlocks: [] } },
        iterations: 1,
        text: 'parity',
      },
      route,
      ENV,
    );
    expect(ordinaryAnthropic).not.toHaveProperty('continuation');
  });

  it('keeps raw Anthropic /messages tool parity independent of continuation sealing', async () => {
    const rawResponse = {
      id: 'msg_raw',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_raw', name: 'weather', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const response = await registeredMessagesResponse(
      {
        content: [
          {
            type: 'tool-call',
            id: 'call_raw',
            name: 'weather',
            input: {},
            cache: 'none',
          },
        ],
        toolCalls: [
          {
            type: 'tool-call',
            id: 'call_raw',
            name: 'weather',
            input: {},
            cache: 'none',
          },
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          reasoningTokens: null,
        },
        stopReason: 'tool-call',
        providerState: {
          backend: 'anthropic',
          value: { rawResponse, contentBlocks: rawResponse.content },
        },
      },
      request(),
      {},
    );
    await expect(response.json()).resolves.toEqual(rawResponse);
  });

  it('requires and validates Moonshot continuation before provider I/O', async () => {
    const fetchMock = stubFetch().mockResolvedValueOnce(new Response(JSON.stringify(completion())));
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    const history = [
      request().messages[0]!,
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'Hello back', cache: 'none' as const }],
      },
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'Next', cache: 'none' as const }],
      },
    ];
    await expect(
      adapter.complete(unstructuredRequest({ messages: history })),
    ).resolves.toMatchObject({ stopReason: 'completed' });
    await expect(
      adapter.complete(
        unstructuredRequest({
          messages: history,
          continuation: { backend: 'moonshot', value: {} },
        }),
      ),
    ).rejects.toThrow(/did not contain assistant history/);
    await expect(
      adapter.complete(
        unstructuredRequest({
          messages: history,
          continuation: {
            backend: 'moonshot',
            value: {
              assistantMessages: [
                {
                  role: 'assistant',
                  content: 'Hello back',
                  reasoning_content: 'Private thought',
                },
              ],
              segments: [
                {
                  transcript: [
                    {
                      role: 'assistant',
                      content: 'Hello back',
                      reasoning_content: 'Private thought',
                    },
                  ],
                  publicAssistant: { text: 'different', toolCalls: [] },
                },
              ],
            },
          },
        }),
      ),
    ).rejects.toThrow(/did not match its public assistant turn/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects public tool-call history without authenticated continuation state', async () => {
    const fetchMock = stubFetch();
    await expect(
      new MoonshotChatCompletionsAdapter(ENV).complete(
        unstructuredRequest({
          messages: [
            request().messages[0]!,
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  id: 'call_public',
                  name: 'weather',
                  input: { city: 'Paris' },
                  cache: 'none',
                },
              ],
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'call_public',
                  content: [{ type: 'text', text: 'Sunny', cache: 'none' }],
                  isError: false,
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      status: 400,
      exceptionType: 'ArgumentException',
      message: expect.stringMatching(/requires authenticated continuation state/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['stop', 'completed'],
    ['length', 'max-output-tokens'],
  ])('maps %s to %s', async (providerReason, canonicalReason) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(completion(undefined, providerReason))),
    );
    await expect(
      new MoonshotChatCompletionsAdapter(ENV).complete(request()),
    ).resolves.toMatchObject({ stopReason: canonicalReason, providerStopReason: providerReason });
  });

  it.each([
    ['low', 'low'],
    ['medium', 'high'],
    ['high', 'high'],
    ['xhigh', 'max'],
  ] as const)('maps canonical %s effort to K3 %s', async (effort, expected) => {
    const fetchMock = stubFetch().mockResolvedValue(new Response(JSON.stringify(completion())));
    await new MoonshotChatCompletionsAdapter(ENV).complete(request({ effort }));
    expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject({
      reasoning_effort: expected,
    });
  });

  it.each(['required', 'none'] as const)('serializes K3 %s tool choice', async (mode) => {
    const fetchMock = stubFetch().mockResolvedValue(new Response(JSON.stringify(completion())));
    await new MoonshotChatCompletionsAdapter(ENV).complete(request({ toolChoice: { mode } }));
    expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject({ tool_choice: mode });
  });

  it('serializes a documented K3 specific-function tool choice', async () => {
    const fetchMock = stubFetch().mockResolvedValue(new Response(JSON.stringify(completion())));
    await new MoonshotChatCompletionsAdapter(ENV).complete(
      request({ toolChoice: { mode: 'specific', name: 'weather' } }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'weather' } },
    });
  });

  it('rejects unsupported canonical controls before provider I/O', async () => {
    const fetchMock = stubFetch();
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    await expect(adapter.complete(request({ metadata: { trace: 'nope' } }))).rejects.toThrow(
      /does not support canonical metadata/,
    );
    await expect(adapter.complete(request({ serviceTier: 'priority' }))).rejects.toThrow(
      /does not support canonical service tiers/,
    );
    await expect(adapter.complete(request({ sampling: { topK: 10 } }))).rejects.toThrow(
      /sampling values are provider-fixed/,
    );
    await expect(adapter.complete(request({ sampling: { temperature: 0.6 } }))).rejects.toThrow(
      /sampling values are provider-fixed/,
    );
    await expect(
      adapter.complete(request({ toolChoice: { mode: 'auto', disableParallel: true } })),
    ).rejects.toThrow(/does not expose a documented parallel-tool-call control/);
    await expect(
      adapter.complete(
        request({
          modelProfile: { ...PROFILE, name: 'unsupported-moonshot-profile', model: 'future-kimi' },
        }),
      ),
    ).rejects.toThrow(/does not support profile unsupported-moonshot-profile/);
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'url', url: 'https://images.test/example.jpg' },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/does not support external image URLs/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes supported document and tool-result content without losing error semantics', async () => {
    const fetchMock = stubFetch().mockResolvedValue(new Response(JSON.stringify(completion())));
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    await adapter.complete(
      unstructuredRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                title: 'Evidence',
                context: 'Current page',
                source: {
                  type: 'content',
                  content: [
                    { type: 'text', text: 'Visible copy', cache: 'none' },
                    {
                      type: 'image',
                      source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
                      cache: 'none',
                    },
                  ],
                },
                cache: 'none',
              },
              {
                type: 'tool-result',
                toolCallId: 'call_failed',
                content: [
                  { type: 'text', text: 'first', cache: 'none' },
                  { type: 'text', text: 'second', cache: 'none' },
                ],
                isError: true,
                cache: 'none',
              },
            ],
          },
        ],
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Evidence\nCurrent page' },
          { type: 'text', text: 'Visible copy' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_failed', content: '[tool error]\nfirst\nsecond' },
    ]);
  });

  it('rejects unsupported documents, citations, tool-result media, and tool kinds before I/O', async () => {
    const fetchMock = stubFetch();
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    const messageWith = (content: InferenceRequest['messages'][number]['content']) =>
      unstructuredRequest({ messages: [{ role: 'user', content }] });

    await expect(
      adapter.complete(
        messageWith([
          {
            type: 'document',
            source: { type: 'text', mediaType: 'text/plain', text: 'Evidence' },
            citations: { enabled: true },
            cache: 'none',
          },
        ]),
      ),
    ).rejects.toThrow(/does not support citation controls/);
    await expect(
      adapter.complete(
        messageWith([
          {
            type: 'document',
            source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0=' },
            cache: 'none',
          },
        ]),
      ),
    ).rejects.toThrow(/supports only text or image content/);
    await expect(
      adapter.complete(
        messageWith([
          {
            type: 'tool-result',
            toolCallId: 'call_media',
            content: [
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
                cache: 'none',
              },
            ],
            isError: false,
            cache: 'none',
          },
        ]),
      ),
    ).rejects.toThrow(/tool results support only text content/);
    await expect(
      adapter.complete(
        unstructuredRequest({
          tools: [
            {
              name: 'hosted',
              description: 'Hosted tool',
              execution: 'provider',
              providerState: { backend: 'moonshot', value: { type: 'hosted' } },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/provider-hosted tools are not supported/);
    await expect(
      adapter.complete(
        unstructuredRequest({
          tools: [
            {
              name: 'weather',
              description: 'Get weather',
              inputSchema: SCHEMA,
              execution: 'server',
              allowedCallers: ['direct'],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/cannot serialize provider-specific options/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses preserved-thinking controls for supported K2 families and rejects level semantics', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completion(undefined, 'stop', { model: 'kimi-k2.6' }))),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completion(undefined, 'stop', { model: 'kimi-k2.7-code' }))),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(completion(undefined, 'stop', { model: 'kimi-k2.7-code-highspeed' })),
        ),
      );
    const adapter = new MoonshotChatCompletionsAdapter(ENV);

    await adapter.complete(
      requestWithoutEffort({
        modelProfile: { ...PROFILE, name: 'kimi-metered-k26', model: 'kimi-k2.6' },
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject({
      model: 'kimi-k2.6',
      thinking: { type: 'enabled', keep: 'all' },
    });
    await adapter.complete(
      requestWithoutEffort({
        modelProfile: { ...PROFILE, name: 'kimi-metered-k27', model: 'kimi-k2.7-code' },
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 1).init)).toMatchObject({
      model: 'kimi-k2.7-code',
      thinking: { type: 'enabled', keep: 'all' },
    });
    await adapter.complete(
      requestWithoutEffort({
        modelProfile: {
          ...PROFILE,
          name: 'kimi-metered-k27-highspeed',
          model: 'kimi-k2.7-code-highspeed',
        },
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 2).init)).toMatchObject({
      model: 'kimi-k2.7-code-highspeed',
      thinking: { type: 'enabled', keep: 'all' },
    });
    await expect(
      adapter.complete(
        request({ modelProfile: { ...PROFILE, name: 'kimi-metered-k26', model: 'kimi-k2.6' } }),
      ),
    ).rejects.toThrow(/semantic effort is supported only by the Kimi K3/);
    await expect(
      adapter.complete(
        requestWithoutEffort({
          modelProfile: { ...PROFILE, name: 'kimi-metered-k27', model: 'kimi-k2.7-code' },
          toolChoice: { mode: 'required' },
        }),
      ),
    ).rejects.toThrow(/Required tool choice is supported only by the Kimi K3/);
    await expect(
      adapter.complete(
        requestWithoutEffort({
          modelProfile: { ...PROFILE, name: 'kimi-metered-k26', model: 'kimi-k2.6' },
          toolChoice: { mode: 'specific', name: 'weather' },
        }),
      ),
    ).rejects.toThrow(/Specific tool choice is supported only by the Kimi K3/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('Moonshot streaming', () => {
  it('parses SSE split across byte boundaries and a multibyte character', async () => {
    const raw = [
      chunk({ role: 'assistant', content: 'A✓', reasoning_content: 'Think.' }),
      chunk({ content: 'B' }, 'stop', {
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
      }),
      '[DONE]' as const,
    ]
      .map((event) => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`)
      .join('');
    const bytes = new TextEncoder().encode(raw);
    const marker = new TextEncoder().encode('✓');
    const markerIndex = bytes.findIndex((value, index) =>
      marker.every((member, offset) => bytes[index + offset] === member),
    );
    const cuts = [7, markerIndex + 1, markerIndex + marker.length, bytes.length - 5];
    let start = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const end of cuts) {
          controller.enqueue(bytes.slice(start, end));
          start = end;
        }
        controller.enqueue(bytes.slice(start));
        controller.close();
      },
    });
    stubFetch().mockResolvedValue(
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const events = [];
    for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: { content: [{ type: 'text', text: 'A✓B' }] },
    });
  });

  it('normalizes a non-success stream response', async () => {
    stubFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Slow down' } }), {
        status: 429,
      }),
    );
    const consumeFailure = async () => {
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        void event;
      }
    };
    await expect(consumeFailure()).rejects.toMatchObject({
      inferenceError: { status: 429, retryable: true },
    });
  });

  it('cancels an abandoned stream reader', async () => {
    const first = `data: ${JSON.stringify(
      chunk({ role: 'assistant', content: '', reasoning_content: 'Think.' }),
    )}\n\n`;
    const response = new Response(first);
    if (!response.body) throw new Error('missing test response body');
    const reader = response.body.getReader();
    const cancel = vi.spyOn(reader, 'cancel');
    Object.defineProperty(response.body, 'getReader', { value: () => reader });
    stubFetch().mockResolvedValueOnce(response);
    const iterator = new MoonshotChatCompletionsAdapter(ENV)
      .stream(request())
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'message-start' } });
    await iterator.return?.();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('accepts nullable known delta fields and rejects an empty terminal stream', async () => {
    stubFetch()
      .mockResolvedValueOnce(
        sse([
          chunk({
            role: 'assistant',
            content: null,
            tool_calls: null,
            reasoning_content: 'Thinking.',
          }),
          chunk({ content: 'OK' }, 'stop', {
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          '[DONE]',
        ]),
      )
      .mockResolvedValueOnce(
        sse([
          chunk({ role: 'assistant', content: null, reasoning_content: 'Hidden only.' }),
          chunk({}, 'stop', {
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          '[DONE]',
        ]),
      );
    const accepted = [];
    for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
      accepted.push(event);
    }
    expect(accepted.at(-1)).toMatchObject({
      type: 'complete',
      result: { stopReason: 'completed', content: [{ type: 'text', text: 'OK' }] },
    });
    const consumeEmpty = async () => {
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        void event;
      }
    };
    await expect(consumeEmpty()).rejects.toMatchObject({
      inferenceError: { failureClass: 'invalid-response' },
    });
  });

  it('accepts an empty length stop when reasoning consumes the output budget', async () => {
    stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion(
              { role: 'assistant', content: null, reasoning_content: 'Budget exhausted.' },
              'length',
            ),
          ),
        ),
      )
      .mockResolvedValueOnce(
        sse([
          chunk({ role: 'assistant', content: null, reasoning_content: 'Budget exhausted.' }),
          chunk({}, 'length', {
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          '[DONE]',
        ]),
      );
    await expect(
      new MoonshotChatCompletionsAdapter(ENV).complete(request()),
    ).resolves.toMatchObject({
      content: [],
      stopReason: 'max-output-tokens',
      providerStopReason: 'length',
    });
    const events = [];
    for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: {
        content: [],
        stopReason: 'max-output-tokens',
        providerStopReason: 'length',
        usage: { inputTokens: 2, outputTokens: 1 },
      },
    });
  });

  it('normalizes a streamed content filter stop', async () => {
    stubFetch().mockResolvedValue(
      sse([
        chunk({ role: 'assistant', content: 'Blocked', reasoning_content: 'Policy.' }),
        chunk({}, 'content_filter', {
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        '[DONE]',
      ]),
    );
    const events = [];
    for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: { stopReason: 'content-filter' },
    });
  });

  it('streams text, preserves reasoning, normalizes usage, and requires [DONE]', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sse([
        chunk({ role: 'assistant', content: '', reasoning_content: 'Think ' }),
        chunk({ reasoning_content: 'carefully.', content: 'Hello ' }),
        chunk({ content: 'world' }, 'stop', {
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            cached_tokens: 3,
          },
        }),
        '[DONE]',
      ]),
    );

    const events = [];
    for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
      events.push(event);
    }

    expect(sentBody(fetchCall(fetchMock, 0).init)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events.map((event) => event.type)).toEqual([
      'message-start',
      'text-delta',
      'text-delta',
      'usage',
      'complete',
    ]);
    expect(events.filter((event) => event.type === 'text-delta')).toEqual([
      { type: 'text-delta', delta: 'Hello ' },
      { type: 'text-delta', delta: 'world' },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: {
        content: [{ type: 'text', text: 'Hello world', cache: 'none' }],
        providerState: {
          backend: 'moonshot',
          value: {
            assistantMessages: [
              {
                reasoning_content: 'Think carefully.',
              },
            ],
          },
        },
      },
    });
  });

  it('assembles multiple fragmented tool calls by exact contiguous index', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sse([
        chunk({
          role: 'assistant',
          content: 'Checking.',
          reasoning_content: 'Use two tools.',
          tool_calls: [
            {
              index: 0,
              id: 'call_0',
              type: 'function',
              function: { name: 'weather', arguments: '{"city"' },
            },
            {
              index: 1,
              id: 'call_1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city"' },
            },
          ],
        }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: null,
              type: null,
              function: { name: null, arguments: ':"Paris"}' },
            },
            { index: 1, function: { arguments: ':"Rome"}' } },
          ],
        }),
        chunk({}, 'tool_calls', {
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
        '[DONE]',
      ]),
    );

    const events = [];
    for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(
      unstructuredRequest(),
    )) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === 'tool-call')).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ id: 'call_0', input: { city: 'Paris' } }),
      }),
      expect.objectContaining({
        call: expect.objectContaining({ id: 'call_1', input: { city: 'Rome' } }),
      }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: { stopReason: 'tool-call', providerStopReason: 'tool_calls' },
    });
  });

  it('accepts documented nested final usage and CRLF SSE framing', async () => {
    const fetchMock = stubFetch();
    const events = [
      chunk({ role: 'assistant', content: '', reasoning_content: '' }),
      chunk({ content: 'ok' }, 'stop', {
        usage: null,
        choices: [
          {
            index: 0,
            delta: { content: 'ok' },
            finish_reason: 'stop',
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          },
        ],
      }),
    ];
    const body = `${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')}data: [DONE]\r\n\r\n`;
    fetchMock.mockResolvedValue(new Response(body));

    const received = [];
    for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
      received.push(event);
    }
    expect(received.at(-1)).toMatchObject({
      type: 'complete',
      result: { usage: { inputTokens: 2, outputTokens: 1 } },
    });
  });

  it.each([null, ''] as const)(
    'preserves explicit %s streamed reasoning state for exact replay',
    async (reasoningContent) => {
      const fetchMock = stubFetch();
      fetchMock.mockResolvedValue(
        sse([
          chunk({ role: 'assistant', content: 'ok', reasoning_content: reasoningContent }),
          chunk({}, 'stop', {
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          '[DONE]',
        ]),
      );
      const received = [];
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        received.push(event);
      }
      expect(received.at(-1)).toMatchObject({
        type: 'complete',
        result: {
          providerState: {
            value: { assistantMessages: [{ reasoning_content: reasoningContent }] },
          },
        },
      });
    },
  );

  it('normalizes a provider SSE error independently of HTTP status', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sse([
        {
          error: {
            type: 'engine_overloaded_error',
            code: 'engine_overloaded_error',
            message: 'Try later',
          },
        },
      ]),
    );
    const consume = async () => {
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        void event;
      }
    };
    await expect(consume()).rejects.toMatchObject({
      inferenceError: {
        backend: 'moonshot',
        status: null,
        code: 'engine_overloaded_error',
        retryable: true,
        failureClass: 'http',
      },
    });
  });

  it('preserves reasoning_content through the shared server-tool agent loop', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        sse([
          chunk({
            role: 'assistant',
            content: 'Checking.',
            reasoning_content: 'I need weather.',
            tool_calls: [
              {
                index: 0,
                id: 'call_agent',
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
          chunk({ role: 'assistant', content: 'Sunny', reasoning_content: 'The tool answered.' }),
          chunk({}, 'stop', {
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
          }),
          '[DONE]',
        ]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            completion({
              role: 'assistant',
              content: 'Confirmed',
              reasoning_content: 'Continue.',
            }),
          ),
        ),
      );

    const result = await createInferenceService(ENV).runAgent({
      ...unstructuredRequest(),
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

    expect(result).toMatchObject({
      text: 'Checking.\nSunny',
      stopReason: 'completed',
      iterations: 2,
    });
    expect(sentBody(fetchCall(fetchMock, 1).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Checking.',
        reasoning_content: 'I need weather.',
        tool_calls: [
          {
            id: 'call_agent',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_agent', content: 'Sunny' },
    ]);

    const route = {
      tenantScope: 'tenant-test',
      promptGroup: request().promptGroup,
      modelProfile: PROFILE.name,
    };
    const done = await toDonePayload(result, route, ENV);
    const continuation = await decodeMessagesContinuation(
      done.continuation,
      route,
      'moonshot',
      ENV,
    );
    if (!continuation) throw new Error('missing server-loop continuation');
    await createInferenceService(ENV).complete(
      unstructuredRequest({
        messages: [
          request().messages[0]!,
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Checking.\nSunny', cache: 'none' }],
          },
          { role: 'user', content: [{ type: 'text', text: 'Confirm', cache: 'none' }] },
        ],
        continuation,
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 2).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Checking.',
        reasoning_content: 'I need weather.',
        tool_calls: [
          {
            id: 'call_agent',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_agent', content: 'Sunny' },
      {
        role: 'assistant',
        content: 'Sunny',
        reasoning_content: 'The tool answered.',
      },
      { role: 'user', content: 'Confirm' },
    ]);
  });

  it('runs two consecutive tool turns and aggregates usage across all three completions', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        sse([
          chunk({
            role: 'assistant',
            content: '',
            reasoning_content: 'First tool.',
            tool_calls: [
              {
                index: 0,
                id: 'call_first',
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
          chunk({
            role: 'assistant',
            content: '',
            reasoning_content: 'Second tool.',
            tool_calls: [
              {
                index: 0,
                id: 'call_second',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Rome"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls', {
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          }),
          '[DONE]',
        ]),
      )
      .mockResolvedValueOnce(
        sse([
          chunk({ role: 'assistant', content: 'Complete', reasoning_content: 'Done.' }),
          chunk({}, 'stop', {
            usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
          }),
          '[DONE]',
        ]),
      );
    const result = await createInferenceService(ENV).runAgent({
      ...unstructuredRequest(),
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
    expect(result).toMatchObject({
      text: 'Complete',
      stopReason: 'completed',
      iterations: 3,
      usage: {
        inputTokens: 23,
        outputTokens: 9,
        providerDetails: {
          prompt_tokens: 23,
          completion_tokens: 9,
          total_tokens: 32,
        },
      },
    });
    const done = await toDonePayload(
      result,
      {
        tenantScope: 'tenant-test',
        promptGroup: request().promptGroup,
        modelProfile: PROFILE.name,
      },
      ENV,
    );
    expect(done.usage).toMatchObject({
      prompt_tokens: 23,
      completion_tokens: 9,
      total_tokens: 32,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBody(fetchCall(fetchMock, 2).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'First tool.',
        tool_calls: [
          {
            id: 'call_first',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_first', content: 'Sunny' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Second tool.',
        tool_calls: [
          {
            id: 'call_second',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Rome"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_second', content: 'Sunny' },
    ]);
  });

  it('runs a later internal tool iteration after continuation-free public history', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())))
      .mockResolvedValueOnce(
        sse([
          chunk({
            role: 'assistant',
            content: 'Checking.',
            reasoning_content: 'Use weather.',
            tool_calls: [
              {
                index: 0,
                id: 'call_later',
                type: 'function',
                function: { name: 'weather', arguments: '{"city":"Paris"}' },
              },
            ],
          }),
          chunk({}, 'tool_calls', {
            usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
          }),
          '[DONE]',
        ]),
      )
      .mockResolvedValueOnce(
        sse([
          chunk({ role: 'assistant', content: 'Sunny', reasoning_content: 'Tool complete.' }),
          chunk({}, 'stop', {
            usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
          }),
          '[DONE]',
        ]),
      );
    const service = createInferenceService(ENV);
    const first = await service.complete(unstructuredRequest());
    await service.runAgent({
      ...unstructuredRequest({
        messages: [
          request().messages[0]!,
          { role: 'assistant', content: first.content },
          { role: 'user', content: [{ type: 'text', text: 'Weather?', cache: 'none' }] },
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

    expect(sentBody(fetchCall(fetchMock, 2).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Hello back',
      },
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: 'Checking.',
        reasoning_content: 'Use weather.',
        tool_calls: [
          {
            id: 'call_later',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_later', content: 'Sunny' },
    ]);
  });

  it('keeps max-iteration terminal tools and their hidden results replayable', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        sse([
          chunk({
            role: 'assistant',
            content: 'Checking.',
            reasoning_content: 'Use weather once.',
            tool_calls: [
              {
                index: 0,
                id: 'call_capped',
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
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())));
    const result = await createInferenceService(ENV).runAgent({
      ...unstructuredRequest(),
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
    expect(result).toMatchObject({
      text: 'Checking.',
      stopReason: 'max-iterations',
      toolCalls: [],
    });

    const route = {
      tenantScope: 'tenant-test',
      promptGroup: request().promptGroup,
      modelProfile: PROFILE.name,
    };
    const done = await toDonePayload(result, route, ENV);
    expect(done).toMatchObject({
      text: 'Checking.',
      stopReason: 'max_iterations',
    });
    expect(done).not.toHaveProperty('toolCalls');
    const continuation = await decodeMessagesContinuation(
      done.continuation,
      route,
      'moonshot',
      ENV,
    );
    if (!continuation) throw new Error('missing capped-loop continuation');
    await createInferenceService(ENV).complete(
      unstructuredRequest({
        messages: [
          request().messages[0]!,
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Checking.', cache: 'none' }],
          },
          { role: 'user', content: [{ type: 'text', text: 'Continue', cache: 'none' }] },
        ],
        continuation,
      }),
    );
    expect(sentBody(fetchCall(fetchMock, 1).init).messages).toEqual([
      { role: 'system', content: 'Stable system instructions' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Checking.',
        reasoning_content: 'Use weather once.',
        tool_calls: [
          {
            id: 'call_capped',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_capped', content: 'Sunny' },
      { role: 'user', content: 'Continue' },
    ]);
  });

  it.each([
    [
      'missing done',
      [
        chunk({ role: 'assistant', content: 'x' }, 'stop', {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ],
      /before data: \[DONE\]/,
    ],
    [
      'missing usage',
      [chunk({ role: 'assistant', content: 'x' }, 'stop'), '[DONE]'],
      /without final usage/,
    ],
    [
      'missing finish',
      [chunk({ role: 'assistant', content: 'x' }), '[DONE]'],
      /before a finish reason/,
    ],
    [
      'missing required reasoning',
      [
        chunk({ role: 'assistant', content: 'x' }),
        chunk({}, 'stop', {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        '[DONE]',
      ],
      /required reasoning content/,
    ],
    [
      'changed id',
      [chunk({ role: 'assistant', content: '' }), chunk({ content: 'x' }, null, { id: 'other' })],
      /chunk envelope was invalid/,
    ],
    [
      'changed created timestamp',
      [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: 'x' }, null, { created: 1_700_000_002 }),
      ],
      /chunk envelope was invalid/,
    ],
    [
      'late choice',
      [chunk({ role: 'assistant', content: '' }, 'stop'), chunk({ content: 'late' })],
      /choice after its finish reason/,
    ],
  ] as const)('rejects malformed stream: %s', async (_name, events, message) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(sse(events));
    const consume = async () => {
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        void event;
      }
    };
    await expect(consume()).rejects.toMatchObject({
      inferenceError: {
        backend: 'moonshot',
        failureClass: 'invalid-response',
        message: expect.stringMatching(message),
      },
    });
  });

  it.each([
    ['invalid json', 'data: {\n\n', /invalid JSON/],
    ['non-object', 'data: null\n\n', /chunk envelope was invalid/],
    [
      'first role missing',
      `data: ${JSON.stringify(chunk({ content: 'x' }))}\n\n`,
      /stream delta was invalid/,
    ],
    [
      'unknown delta field',
      `data: ${JSON.stringify(chunk({ role: 'assistant', future: 'x' }))}\n\n`,
      /unknown field/,
    ],
    [
      'truncated frame',
      `data: ${JSON.stringify(chunk({ role: 'assistant', content: 'x' }))}`,
      /truncated event/,
    ],
  ])('rejects malformed raw SSE: %s', async (_name, body, message) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(body));
    const consume = async () => {
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        void event;
      }
    };
    await expect(consume()).rejects.toMatchObject({
      inferenceError: {
        backend: 'moonshot',
        failureClass: 'invalid-response',
        message: expect.stringMatching(message),
      },
    });
  });

  it('rejects a stream frame after data: [DONE]', async () => {
    stubFetch().mockResolvedValue(
      sse([
        chunk({ role: 'assistant', content: 'ok', reasoning_content: 'done' }, 'stop', {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        '[DONE]',
        chunk({ content: 'late' }),
      ]),
    );
    const consume = async () => {
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        void event;
      }
    };
    await expect(consume()).rejects.toMatchObject({
      inferenceError: {
        backend: 'moonshot',
        failureClass: 'invalid-response',
        message: expect.stringMatching(/data after \[DONE\]/),
      },
    });
  });

  it.each([
    [
      'tool index gap',
      [
        chunk({
          role: 'assistant',
          reasoning_content: '',
          tool_calls: [
            {
              index: 1,
              id: 'call_1',
              type: 'function',
              function: { name: 'weather', arguments: '{}' },
            },
          ],
        }),
        chunk({}, 'tool_calls', {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        '[DONE]' as const,
      ],
      /tool-call indexes were not contiguous/,
    ],
    [
      'changed tool identity',
      [
        chunk({
          role: 'assistant',
          reasoning_content: '',
          tool_calls: [
            {
              index: 0,
              id: 'call_0',
              type: 'function',
              function: { name: 'weather', arguments: '{' },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, id: 'changed', function: { arguments: '}' } }],
        }),
      ],
      /tool-call delta changed identity/,
    ],
    [
      'contradictory usage',
      [
        chunk({ role: 'assistant', content: '' }),
        chunk({}, 'stop', {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            },
          ],
        }),
      ],
      /usage in two locations/,
    ],
    [
      'reasoning after visible content',
      [chunk({ role: 'assistant', content: 'visible' }), chunk({ reasoning_content: 'late' })],
      /reasoning appeared after visible content/,
    ],
    [
      'reasoning after tool output',
      [
        chunk({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_0',
              type: 'function',
              function: { name: 'weather', arguments: '{}' },
            },
          ],
        }),
        chunk({ reasoning_content: 'late' }),
      ],
      /reasoning appeared after visible content/,
    ],
    [
      'premature usage',
      [
        chunk({ role: 'assistant', content: '' }, null, {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ],
      /usage outside its terminal chunk/,
    ],
    [
      'conflicting terminal usage',
      [
        chunk({ role: 'assistant', content: 'ok' }, 'stop', {
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        chunk({}, null, {
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ],
      /conflicting terminal usage/,
    ],
    [
      'duplicate tool-call ids',
      [
        chunk({
          role: 'assistant',
          reasoning_content: '',
          tool_calls: [
            {
              index: 0,
              id: 'duplicate',
              type: 'function',
              function: { name: 'weather', arguments: '{}' },
            },
            {
              index: 1,
              id: 'duplicate',
              type: 'function',
              function: { name: 'weather', arguments: '{}' },
            },
          ],
        }),
        chunk({}, 'tool_calls', {
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        '[DONE]' as const,
      ],
      /duplicate tool-call IDs/,
    ],
  ] as const)('rejects strict stream lifecycle mismatch: %s', async (_name, events, message) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(sse(events));
    const consume = async () => {
      for await (const event of new MoonshotChatCompletionsAdapter(ENV).stream(request())) {
        void event;
      }
    };
    await expect(consume()).rejects.toMatchObject({
      inferenceError: {
        backend: 'moonshot',
        failureClass: 'invalid-response',
        message: expect.stringMatching(message),
      },
    });
  });
});

describe('Moonshot failures and strict success validation', () => {
  it.each([
    null,
    {},
    completion(undefined, 'stop', { choices: [] }),
    completion(undefined, 'stop', { model: 'different-model' }),
    completion({ role: 'assistant', content: 42 }),
    completion({ role: 'assistant', content: 'missing reasoning' }),
    completion(undefined, 'stop', { usage: {} }),
    completion(undefined, 'stop', {
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 4 },
    }),
    completion(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call', type: 'function', function: { name: 'weather', arguments: '{' } },
        ],
      },
      'tool_calls',
    ),
    completion({ role: 'assistant', content: 'x' }, 'tool_calls'),
    completion(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'duplicate', type: 'function', function: { name: 'weather', arguments: '{}' } },
          { id: 'duplicate', type: 'function', function: { name: 'weather', arguments: '{}' } },
        ],
      },
      'tool_calls',
    ),
  ])('rejects malformed complete envelope %#', async (body) => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(new MoonshotChatCompletionsAdapter(ENV).complete(request())).rejects.toMatchObject(
      {
        inferenceError: { backend: 'moonshot', failureClass: 'invalid-response' },
      },
    );
  });

  it('normalizes provider HTTP errors and keeps permanent credit failures non-retryable', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'exceeded_current_quota_error',
            message: 'No balance with ms://clg681objj8g9m7n4je0',
          },
        }),
        { status: 429 },
      ),
    );
    const failure = await new MoonshotChatCompletionsAdapter(ENV)
      .complete(request())
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      inferenceError: {
        backend: 'moonshot',
        status: 429,
        code: 'exceeded_current_quota_error',
        message: 'Moonshot request failed (429)',
        retryable: false,
        failureClass: 'http',
      },
    });
    expect((failure as InferenceFailure).inferenceError.detail).toBeUndefined();
  });

  it('normalizes malformed HTTP JSON, network, timeout, and cancellation', async () => {
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(new Response('{', { status: 502 }));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { status: 502, code: 'invalid_response', failureClass: 'invalid-response' },
    });

    fetchMock.mockRejectedValueOnce(new Error('socket closed'));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { code: 'network_error', retryable: true, failureClass: 'network' },
    });

    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { code: 'timeout', retryable: true, failureClass: 'timeout' },
    });

    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(
      adapter.complete(request({ abortSignal: controller.signal })),
    ).rejects.toMatchObject({
      inferenceError: { code: 'cancelled', retryable: false, failureClass: 'cancelled' },
    });
    expect(fetchCall(fetchMock, 3).init.signal).toBe(controller.signal);

    const bodyController = new AbortController();
    bodyController.abort();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new DOMException('body aborted', 'AbortError')),
    } as unknown as Response);
    await expect(
      adapter.complete(request({ abortSignal: bodyController.signal })),
    ).rejects.toMatchObject({
      inferenceError: { code: 'cancelled', retryable: false, failureClass: 'cancelled' },
    });
  });
});

describe('Moonshot Files and factory integration', () => {
  it('rejects unsupported image MIME before upload or inference provider I/O', async () => {
    const fetchMock = stubFetch();
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    await expect(
      adapter.uploadFile({
        bytes: new Uint8Array([1]),
        filename: 'document.pdf',
        mediaType: 'application/pdf',
        policy: POLICY,
      }),
    ).rejects.toThrow(/does not support media type application\/pdf/);
    await expect(
      adapter.complete(
        request({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    mediaType: 'image/svg+xml',
                    data: 'PHN2Zy8+',
                  },
                  cache: 'none',
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/does not support media type image\/svg\+xml/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads, reads, and deletes strict file envelopes with exact abort propagation', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(fileRecord())))
      .mockResolvedValueOnce(new Response(JSON.stringify(fileRecord())))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'file_test', object: 'file', deleted: true })),
      );
    const controller = new AbortController();
    const adapter = new MoonshotChatCompletionsAdapter(ENV);

    await expect(
      adapter.uploadFile({
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'image.png',
        mediaType: 'image/png',
        policy: POLICY,
        abortSignal: controller.signal,
      }),
    ).resolves.toEqual({
      id: 'file_test',
      mediaType: 'image/png',
      sizeBytes: 123,
      expiresAt: null,
    });
    await expect(adapter.getFileMetadata('file_test', controller.signal)).resolves.toEqual({
      id: 'file_test',
      mediaType: null,
      sizeBytes: 123,
      expiresAt: null,
    });
    await expect(adapter.deleteFile('file_test', controller.signal)).resolves.toBeUndefined();

    expect(fetchCall(fetchMock, 0).url).toBe('https://api.moonshot.ai/v1/files');
    expect(fetchCall(fetchMock, 0).init.body).toBeInstanceOf(FormData);
    expect(fetchCall(fetchMock, 0).init.headers).toEqual({
      Authorization: 'Bearer test-moonshot-key',
    });
    expect(fetchCall(fetchMock, 1).url).toBe('https://api.moonshot.ai/v1/files/file_test');
    expect(fetchCall(fetchMock, 2).init.method).toBe('DELETE');
    for (let index = 0; index < 3; index += 1) {
      expect(fetchCall(fetchMock, index).init.signal).toBe(controller.signal);
    }
  });

  it('returns null for missing metadata and rejects malformed/mismatched file success envelopes', async () => {
    const fetchMock = stubFetch();
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(adapter.getFileMetadata('missing')).resolves.toBeNull();

    for (const body of [
      null,
      { ...fileRecord(), id: '' },
      fileRecord('other'),
      { ...fileRecord(), bytes: -1 },
      { ...fileRecord(), status: 'processing' },
      { ...fileRecord(), status: 'failed', status_details: 'scan failed' },
      fileRecord('file_test', 'file-extract'),
    ]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body)));
      await expect(adapter.getFileMetadata('file_test')).rejects.toMatchObject({
        inferenceError: { backend: 'moonshot', failureClass: 'invalid-response' },
      });
    }
  });

  it('accepts the official SDK ok success spelling for usable upload and metadata records', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...fileRecord(), status: 'ok' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...fileRecord(), status: 'ok' })));
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    await expect(
      adapter.uploadFile({
        bytes: new Uint8Array([1]),
        filename: 'image.png',
        mediaType: 'image/png',
        policy: POLICY,
      }),
    ).resolves.toMatchObject({ id: 'file_test', mediaType: 'image/png' });
    await expect(adapter.getFileMetadata('file_test')).resolves.toMatchObject({ id: 'file_test' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects upload metadata that is not ready to be referenced', async () => {
    const fetchMock = stubFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ ...fileRecord(), status: 'processing' })),
    );
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    await expect(
      adapter.uploadFile({
        bytes: new Uint8Array([1]),
        filename: 'image.png',
        mediaType: 'image/png',
        policy: POLICY,
      }),
    ).rejects.toMatchObject({
      inferenceError: { backend: 'moonshot', failureClass: 'invalid-response' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed delete success envelopes', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'other', object: 'file', deleted: true })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'file_test', object: 'file', deleted: false })),
      );
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    await expect(adapter.deleteFile('file_test')).rejects.toMatchObject({
      inferenceError: { backend: 'moonshot', failureClass: 'invalid-response' },
    });
    await expect(adapter.deleteFile('file_test')).rejects.toMatchObject({
      inferenceError: { backend: 'moonshot', failureClass: 'invalid-response' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('derives key-isolated file scopes and rejects incompatible policies before I/O', async () => {
    const fetchMock = stubFetch();
    const files = createInferenceFileService(ENV);
    const first = await files.scope(PROFILE, POLICY);
    await expect(files.scope(PROFILE, POLICY)).resolves.toBe(first);
    await expect(
      createInferenceFileService({ ...ENV, MOONSHOT_API_KEY: 'different-key' }).scope(
        PROFILE,
        POLICY,
      ),
    ).resolves.not.toBe(first);
    expect(first).toMatch(/^moonshot:[a-f0-9]{24}$/);

    for (const policy of [
      { ...POLICY, provider: 'openai' as const },
      { ...POLICY, compatibleApiFamilies: ['openai-responses'] as const },
      { ...POLICY, purpose: 'file-extract' as const },
    ]) {
      await expect(files.scope(PROFILE, policy)).rejects.toThrow(/cannot use file policy/);
    }
    for (const policy of [
      { ...POLICY, inputMode: 'base64' },
      { ...POLICY, lifecycle: 'request-scoped' },
    ]) {
      await expect(files.scope(PROFILE, policy as unknown as FilePolicy)).rejects.toThrow(
        /cannot use file policy/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('selects Moonshot only through the provider-neutral service/file/diagnostics factory', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(completion())))
      .mockResolvedValueOnce(new Response(JSON.stringify(fileRecord())));

    await expect(createInferenceService(ENV).complete(request())).resolves.toMatchObject({
      stopReason: 'completed',
    });
    await expect(
      createInferenceFileService(ENV).upload(
        PROFILE,
        POLICY,
        new Uint8Array([1]),
        'image.png',
        'image/png',
      ),
    ).resolves.toMatchObject({ id: 'file_test' });
    await expect(createInferenceDiagnosticsService(ENV).countTokens(request())).resolves.toBeNull();
    expect(requiresOrdinaryTurnContinuation(PROFILE, ENV)).toBe(false);
    expect(isRequiredContinuationMissing(PROFILE, ENV, [{ role: 'assistant' }], undefined)).toBe(
      false,
    );
    expect(
      isRequiredContinuationMissing(PROFILE, ENV, [{ role: 'assistant' }], {
        backend: 'moonshot',
      }),
    ).toBe(false);
    expect(
      requiresOrdinaryTurnContinuation(
        { ...PROFILE, provider: 'anthropic', apiFamily: 'anthropic-messages' },
        ENV,
      ),
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers an unopenable or foreign Moonshot file reference as client input', async () => {
    const fetchMock = stubFetch();
    const tenantScope = await fileTenantScope('ctx-moonshot-owner', ENV);
    const otherTenant = await fileTenantScope('ctx-moonshot-intruder', ENV);
    if (!tenantScope || !otherTenant) throw new Error('test tenant scope missing');
    const sealed = await mintOpaqueFileReference(
      {
        provider: 'moonshot',
        accountScope: await createInferenceFileService(ENV).scope(PROFILE, POLICY),
        tenantScope,
        filePolicy: 'moonshot-image-files',
        compatibleGroups: ['image-selection'],
        upstreamFileId: 'cxxxxxxxxxxxxxxxxxxx',
        contentHash: 'a'.repeat(64),
        mediaType: 'image/png',
        sizeBytes: 1,
        expiresAt: null,
      },
      ENV,
    );
    await expect(openOwnedFileReference(sealed.id, ENV, tenantScope)).resolves.toMatchObject({
      provider: 'moonshot',
      upstreamFileId: 'cxxxxxxxxxxxxxxxxxxx',
    });
    await expect(openOwnedFileReference(sealed.id, ENV, otherTenant)).rejects.toMatchObject({
      status: 403,
      exceptionType: 'UnauthorizedAccessException',
    });
    await expect(
      openOwnedFileReference('lsfile_not_a_real_token', ENV, tenantScope),
    ).rejects.toMatchObject({ status: 400, exceptionType: 'ArgumentException' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps foreign continuation and file routes isolated before provider I/O', async () => {
    const fetchMock = stubFetch();
    const adapter = new MoonshotChatCompletionsAdapter(ENV);
    const foreign: ProviderContinuationState = {
      backend: 'openai',
      value: { previousResponseId: 'resp_foreign' },
    };
    await expect(
      adapter.complete(
        request({
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x', cache: 'none' }] }],
          continuation: foreign,
        }),
      ),
    ).rejects.toThrow(/cannot consume openai continuation/);
    await expect(
      adapter.complete(
        request({
          modelProfile: { ...PROFILE, provider: 'openai' },
        }),
      ),
    ).rejects.toThrow(/cannot serve openai/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
