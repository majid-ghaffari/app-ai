/** Anthropic adapter and canonical runtime parity fixtures. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInferenceFileService, createInferenceService } from '../src/inference/factory';
import { InferenceFailure, type InferenceProviderAdapter } from '../src/inference/adapter';
import { DefaultInferenceService } from '../src/inference/service';
import { parseCompatibilityMessages } from '../src/inference/messages-compatibility';
import type {
  AgentRequest,
  CanonicalClientToolDefinition,
  CanonicalServerToolDefinition,
  InferenceEvent,
  InferenceRequest,
  InferenceResult,
} from '../src/lib/inference-types';
import { getFilePolicy, getModelProfile } from '../src/prompt-registry';
import {
  anthropicMessage,
  anthropicMessageStart,
  ENV,
  fetchCall,
  sentBody,
  stubFetch,
} from './helpers';

function canonicalRequest(): InferenceRequest {
  return {
    prompt: 'Stable system prompt',
    promptGroup: 'studio-data-agent',
    modelProfile: getModelProfile('chat', ENV),
    filePolicy: getFilePolicy('anthropic-provider-files'),
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'Volatile context', cache: 'none' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello', cache: 'short' }],
      },
    ],
    maxOutputTokens: 1234,
    serviceTier: 'standard_only',
    effort: 'medium',
    structuredOutput: {
      name: 'answer',
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
      strict: true,
    },
    tools: [
      {
        name: 'lookup',
        description: 'Look something up',
        execution: 'server',
        strict: true,
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    ],
  };
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const normalized: Record<string, unknown>[] = [];
  const openBlocks = new Set<number>();
  for (const event of events) {
    const normalizedEvent =
      event.type === 'message_start'
        ? anthropicMessageStart(
            (event.message as { usage?: Readonly<Record<string, unknown>> } | undefined)?.usage,
          )
        : event;
    if (event.type === 'content_block_start' && typeof event.index === 'number') {
      for (const index of openBlocks) {
        normalized.push({ type: 'content_block_stop', index });
      }
      openBlocks.clear();
      openBlocks.add(event.index);
    }
    if (event.type === 'message_delta') {
      for (const index of openBlocks) {
        normalized.push({ type: 'content_block_stop', index });
      }
      openBlocks.clear();
    }
    normalized.push(normalizedEvent);
  }
  if (events.some((event) => event.type === 'message_delta')) {
    normalized.push({ type: 'message_stop' });
  }
  const body = normalized.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => vi.restoreAllMocks());

describe('Anthropic complete adapter', () => {
  it('serializes canonical system/messages/cache/tools/effort and normalizes the result', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: ENV.MODEL_FRONTIER,
          content: [{ type: 'text', text: 'Hi there' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 7,
            service_tier: 'standard',
            server_tool_use: { web_search_requests: 2 },
            output_tokens_details: { thinking_tokens: 1 },
          },
        }),
      ),
    );

    const result = await createInferenceService(ENV).complete(canonicalRequest());
    const sent = sentBody(fetchCall(fetchMock, 0).init);
    expect(sent).toMatchObject({
      model: ENV.MODEL_FRONTIER,
      max_tokens: 1234,
      service_tier: 'standard_only',
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
      system: [
        {
          type: 'text',
          text: 'Stable system prompt',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
        { type: 'text', text: 'Volatile context' },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'lookup',
          strict: true,
          input_schema: expect.objectContaining({ additionalProperties: false }),
        },
      ],
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'Hi there', cache: 'none' }],
      stopReason: 'completed',
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        cacheWriteInputTokens: 5,
        cachedInputTokens: 7,
        reasoningTokens: 1,
        providerDetails: {
          service_tier: 'standard',
          server_tool_use: { web_search_requests: 2 },
          output_tokens_details: { thinking_tokens: 1 },
        },
      },
    });
  });

  it('normalizes non-ok provider responses', async () => {
    stubFetch().mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'busy' } }), {
        status: 529,
      }),
    );
    await expect(createInferenceService(ENV).complete(canonicalRequest())).rejects.toMatchObject({
      inferenceError: {
        backend: 'anthropic',
        status: 529,
        code: 'overloaded_error',
        message: 'busy',
        retryable: true,
        failureClass: 'http',
      },
    });
  });

  it('preserves canonical media inside messages and tool results', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'msg_media',
          type: 'message',
          role: 'assistant',
          model: ENV.MODEL_FRONTIER,
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    );
    await createInferenceService(ENV).complete({
      ...canonicalRequest(),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
              cache: 'none',
            },
            {
              type: 'document',
              source: {
                type: 'content',
                content: [
                  {
                    type: 'text',
                    text: 'evidence',
                    citations: [{ type: 'content_block_location', cited_text: 'evidence' }],
                    cache: 'short',
                  },
                  {
                    type: 'image',
                    source: { type: 'url', url: 'https://example.test/document-image.png' },
                    cache: 'none',
                  },
                ],
              },
              title: 'Evidence',
              context: 'Merchant page',
              citations: { enabled: true },
              cache: 'none',
            },
            {
              type: 'tool-result',
              toolCallId: 'tool_1',
              isError: false,
              cache: 'short',
              content: [
                { type: 'text', text: 'browser capture', cache: 'none' },
                {
                  type: 'image',
                  source: { type: 'url', url: 'https://example.test/capture.png' },
                  cache: 'none',
                },
              ],
            },
          ],
        },
      ],
    });
    const sent = sentBody(fetchCall(fetchMock, 0).init);
    const messages = sent.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      {
        type: 'document',
        source: {
          type: 'content',
          content: [
            {
              type: 'text',
              text: 'evidence',
              citations: [{ type: 'content_block_location', cited_text: 'evidence' }],
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.test/document-image.png' },
            },
          ],
        },
        title: 'Evidence',
        context: 'Merchant page',
        citations: { enabled: true },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        is_error: false,
        cache_control: { type: 'ephemeral' },
        content: [
          { type: 'text', text: 'browser capture' },
          { type: 'image', source: { type: 'url', url: 'https://example.test/capture.png' } },
        ],
      },
    ]);
  });

  it('normalizes cancellation before a response is received', async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(
      createInferenceService(ENV).complete({
        ...canonicalRequest(),
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({
      inferenceError: {
        backend: 'anthropic',
        status: null,
        code: 'cancelled',
        message: expect.stringContaining('cancelled'),
        retryable: false,
        failureClass: 'cancelled',
      },
    } satisfies Partial<InferenceFailure>);
  });

  it('distinguishes an AbortSignal timeout from caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(
      createInferenceService(ENV).complete({
        ...canonicalRequest(),
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({
      inferenceError: {
        backend: 'anthropic',
        status: null,
        code: 'timeout',
        retryable: true,
        failureClass: 'timeout',
      },
    });
  });

  it('normalizes malformed provider responses', async () => {
    stubFetch().mockResolvedValue(new Response('not-json'));
    await expect(createInferenceService(ENV).complete(canonicalRequest())).rejects.toMatchObject({
      inferenceError: {
        backend: 'anthropic',
        status: 200,
        code: 'invalid_response',
        failureClass: 'invalid-response',
      },
    });
  });

  it('accepts nullable modern output-token details in complete and streamed usage', async () => {
    stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            anthropicMessage([], {
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                output_tokens_details: null,
              },
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(
        sse([
          {
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 1,
                output_tokens: 0,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                output_tokens_details: null,
              },
            },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              output_tokens: 1,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              output_tokens_details: null,
            },
          },
        ]),
      );
    expect((await createInferenceService(ENV).complete(canonicalRequest())).usage).toMatchObject({
      reasoningTokens: null,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      providerDetails: {
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens_details: null,
      },
    });
    const events: InferenceEvent[] = [];
    for await (const event of createInferenceService(ENV).stream(canonicalRequest())) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: { usage: { reasoningTokens: null } },
    });
  });

  it('rejects null, malformed content, and incomplete/invalid usage envelopes', async () => {
    stubFetch()
      .mockResolvedValueOnce(new Response('null'))
      .mockResolvedValueOnce(new Response(JSON.stringify(anthropicMessage([{ type: 'text' }]))))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            anthropicMessage([], { usage: { input_tokens: 'many', output_tokens: 1 } }),
          ),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(anthropicMessage([], { usage: {} }))))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(anthropicMessage([], { usage: { input_tokens: -1, output_tokens: 1 } })),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(anthropicMessage([], { usage: { input_tokens: 1.5, output_tokens: 1 } })),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            anthropicMessage([{ type: 'text', text: 'bad citations', citations: [null] }]),
          ),
        ),
      );
    for (let index = 0; index < 7; index += 1) {
      await expect(createInferenceService(ENV).complete(canonicalRequest())).rejects.toMatchObject({
        inferenceError: { code: 'invalid_response', failureClass: 'invalid-response' },
      });
    }
  });

  it('rejects continuation state owned by another backend before provider I/O', async () => {
    const fetchMock = stubFetch();
    await expect(
      createInferenceService(ENV).complete({
        ...canonicalRequest(),
        continuation: { backend: 'claude-code', value: { session: 'local' } },
      }),
    ).rejects.toThrow(/cannot continue claude-code/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attaches request continuation to the latest assistant without object-identity coupling', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(JSON.stringify(anthropicMessage())),
    );
    const older = {
      backend: 'anthropic' as const,
      value: { contentBlocks: [{ type: 'text', text: 'older raw' }] },
    };
    const latestEquivalentCopy = {
      backend: 'anthropic' as const,
      value: {
        contentBlocks: [
          { type: 'thinking', thinking: 'new', signature: 'signed' },
          {
            type: 'tool_use',
            id: 'tool_business',
            name: 'lookup',
            input: { cache_control: 'merchant-value' },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    };
    await createInferenceService(ENV).complete({
      ...canonicalRequest(),
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'older canonical', cache: 'none' }],
          providerState: older,
        },
        { role: 'user', content: [{ type: 'text', text: 'next', cache: 'none' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'latest canonical', cache: 'none' }],
          providerState: { ...latestEquivalentCopy, value: { ...latestEquivalentCopy.value } },
        },
        { role: 'user', content: [{ type: 'text', text: 'tool result', cache: 'none' }] },
      ],
      continuation: latestEquivalentCopy,
    });
    const sent = sentBody(fetchCall(fetchMock, 0).init);
    expect(sent.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'older raw' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'new', signature: 'signed' },
          {
            type: 'tool_use',
            id: 'tool_business',
            name: 'lookup',
            input: { cache_control: 'merchant-value' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'tool result' }] },
    ]);
  });

  it('retains provider-hosted response blocks opaquely without executing them', async () => {
    stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify(
          anthropicMessage([
            {
              type: 'server_tool_use',
              id: 'srv_1',
              name: 'web_search',
              input: { query: 'LimeSpot' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srv_1',
              content: [{ type: 'web_search_result', title: 'Result' }],
            },
            { type: 'text', text: 'Answer' },
          ]),
        ),
      ),
    );
    const result = await createInferenceService(ENV).complete(canonicalRequest());
    expect(result.content).toEqual([{ type: 'text', text: 'Answer', cache: 'none' }]);
    expect(result.providerState?.value).toMatchObject({
      contentBlocks: [
        { type: 'server_tool_use', id: 'srv_1' },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1' },
        { type: 'text', text: 'Answer' },
      ],
    });
  });

  it('does not synthesize opaque state for non-Anthropic compatibility history', () => {
    const raw = [{ role: 'assistant', content: [{ type: 'text', text: 'ordinary history' }] }];
    expect(parseCompatibilityMessages(raw, 'openai')[0]?.providerState).toBeUndefined();
    expect(parseCompatibilityMessages(raw, 'gemini')[0]?.providerState).toBeUndefined();
    expect(parseCompatibilityMessages(raw, 'anthropic')[0]?.providerState).toMatchObject({
      backend: 'anthropic',
    });
  });
});

describe('Anthropic file adapter', () => {
  it('routes upload/get/delete through one adapter and propagates abort signals', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'file_1',
            type: 'file',
            mime_type: 'text/plain',
            size_bytes: 3,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'file_1',
            type: 'file',
            mime_type: 'text/plain',
            size_bytes: 3,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const profile = getModelProfile('placement', ENV);
    const policy = getFilePolicy('anthropic-provider-files');
    const files = createInferenceFileService(ENV);
    const signal = new AbortController().signal;

    await expect(
      files.upload(profile, policy, new TextEncoder().encode('abc'), 'a.txt', 'text/plain', signal),
    ).resolves.toMatchObject({ id: 'file_1', mediaType: 'text/plain', sizeBytes: 3 });
    await expect(files.getMetadata(profile, 'file_1', signal)).resolves.toMatchObject({
      id: 'file_1',
      mediaType: 'text/plain',
      sizeBytes: 3,
    });
    await expect(files.delete(profile, 'file_1', signal)).resolves.toBeUndefined();

    expect(fetchCall(fetchMock, 0)).toMatchObject({
      url: 'https://api.anthropic.com/v1/files',
      init: { method: 'POST', signal },
    });
    expect(fetchCall(fetchMock, 1).init.signal).toBe(signal);
    expect(fetchCall(fetchMock, 2)).toMatchObject({
      url: 'https://api.anthropic.com/v1/files/file_1',
      init: { method: 'DELETE', signal },
    });
  });

  it('normalizes malformed successful upload and metadata envelopes', async () => {
    stubFetch()
      .mockResolvedValueOnce(new Response('null'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '', type: 'file', mime_type: 42, size_bytes: 'large' })),
      )
      .mockResolvedValueOnce(new Response('null'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'file_other',
            type: 'file',
            mime_type: 'text/plain',
            size_bytes: 3,
          }),
        ),
      );
    const files = createInferenceFileService(ENV);
    const profile = getModelProfile('placement', ENV);
    const policy = getFilePolicy('anthropic-provider-files');
    for (let index = 0; index < 2; index += 1) {
      await expect(
        files.upload(profile, policy, new TextEncoder().encode('abc'), 'a.txt', 'text/plain'),
      ).rejects.toMatchObject({
        inferenceError: { code: 'invalid_response', failureClass: 'invalid-response' },
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await expect(files.getMetadata(profile, 'file_cached')).rejects.toMatchObject({
        inferenceError: { code: 'invalid_response', failureClass: 'invalid-response' },
      });
    }
  });
});

describe('Anthropic streaming and shared agent loop', () => {
  it('normalizes streamed text, tool calls, usage, and completion', async () => {
    stubFetch().mockResolvedValue(
      sse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 8,
              service_tier: 'standard',
              server_tool_use: { web_search_requests: 1 },
            },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'citations_delta',
            citation: { type: 'page_location', cited_text: 'Hi', start_page_number: 1 },
          },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"id":"42"}' },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 2 } },
        },
      ]),
    );
    const events: InferenceEvent[] = [];
    for await (const event of createInferenceService(ENV).stream(canonicalRequest())) {
      events.push(event);
    }
    expect(events).toContainEqual({ type: 'text-delta', delta: 'Hi' });
    expect(events).toContainEqual({
      type: 'tool-call',
      call: {
        type: 'tool-call',
        id: 'tool_1',
        name: 'lookup',
        input: { id: '42' },
        cache: 'none',
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: {
        stopReason: 'tool-call',
        usage: {
          inputTokens: 8,
          outputTokens: 4,
          reasoningTokens: 2,
          providerDetails: {
            service_tier: 'standard',
            server_tool_use: { web_search_requests: 1 },
          },
        },
        providerState: {
          value: {
            contentBlocks: [
              expect.objectContaining({
                citations: [expect.objectContaining({ cited_text: 'Hi' })],
              }),
              expect.anything(),
            ],
          },
        },
      },
    });
  });

  it('normalizes transient and permanent in-stream provider errors', async () => {
    stubFetch()
      .mockResolvedValueOnce(
        sse([{ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }]),
      )
      .mockResolvedValueOnce(
        sse([{ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }]),
      );
    for (const [message, retryable] of [
      ['Anthropic stream error: busy', true],
      ['Anthropic stream error: bad', false],
    ] as const) {
      await expect(async () => {
        for await (const event of createInferenceService(ENV).stream(canonicalRequest()))
          void event;
      }).rejects.toMatchObject({
        inferenceError: { message, retryable, failureClass: 'http' },
      });
    }
  });

  it('rejects malformed, truncated, and non-terminal provider streams', async () => {
    stubFetch()
      .mockResolvedValueOnce(new Response('data: {not-json}\n\n'))
      .mockResolvedValueOnce(new Response('data: {"type":"message_delta"}'))
      .mockResolvedValueOnce(
        sse([{ type: 'content_block_start', index: 0, content_block: { type: 'text' } }]),
      );

    for (let index = 0; index < 3; index += 1) {
      await expect(async () => {
        for await (const event of createInferenceService(ENV).stream(canonicalRequest())) {
          // Drain the stream so terminal validation runs.
          void event;
        }
      }).rejects.toMatchObject({
        inferenceError: { code: 'invalid_response', failureClass: 'invalid-response' },
      });
    }
  });

  it('rejects null events, malformed message_start usage, and missing delta payloads', async () => {
    const validStart = anthropicMessageStart();
    const nonEmptyStart = anthropicMessageStart() as {
      type: string;
      message: Record<string, unknown>;
    };
    nonEmptyStart.message = {
      ...nonEmptyStart.message,
      content: [{ type: 'text', text: 'must be empty' }],
    };
    stubFetch()
      .mockResolvedValueOnce(new Response('data: null\n\n'))
      .mockResolvedValueOnce(
        new Response(`data: ${JSON.stringify(anthropicMessageStart({ input_tokens: -1 }))}\n\n`),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            validStart,
            { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            validStart,
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup' },
            },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta' } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      )
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(nonEmptyStart)}\n\n`))
      .mockResolvedValueOnce(
        new Response(
          [
            validStart,
            { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'citations_delta', citation: 'not-an-object' },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      );
    for (let index = 0; index < 6; index += 1) {
      await expect(async () => {
        for await (const event of createInferenceService(ENV).stream(canonicalRequest()))
          void event;
      }).rejects.toMatchObject({
        inferenceError: { code: 'invalid_response', failureClass: 'invalid-response' },
      });
    }
  });

  it('rejects out-of-order indexes and streams missing message_stop', async () => {
    stubFetch()
      .mockResolvedValueOnce(
        new Response(
          [
            anthropicMessageStart(),
            { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
            { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'x' } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          [anthropicMessageStart(), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        ),
      );
    for (let index = 0; index < 2; index += 1) {
      await expect(async () => {
        for await (const event of createInferenceService(ENV).stream(canonicalRequest()))
          void event;
      }).rejects.toMatchObject({
        inferenceError: { code: 'invalid_response', failureClass: 'invalid-response' },
      });
    }
  });

  it('never fabricates empty arguments for malformed streamed tool JSON', async () => {
    stubFetch().mockResolvedValue(
      sse([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"id":' },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      ]),
    );
    await expect(async () => {
      for await (const event of createInferenceService(ENV).stream(canonicalRequest())) {
        // Drain the stream so tool argument parsing runs.
        void event;
      }
    }).rejects.toMatchObject({
      inferenceError: { code: 'invalid_response', failureClass: 'invalid-response' },
    });
  });

  it('runs server tools through the canonical multi-turn loop', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 8 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'private provider state' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'signed-state' },
          },
          {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup' },
          },
          {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '{"id":"42"}' },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 2 },
          },
        ]),
      )
      .mockResolvedValueOnce(
        sse([
          { type: 'message_start', message: { usage: { input_tokens: 12 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Found it' },
          },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 3 },
          },
        ]),
      );

    const observed: InferenceEvent[] = [];
    const request: AgentRequest = {
      ...canonicalRequest(),
      mode: 'server',
      maxIterations: 8,
      tools: canonicalRequest().tools.filter(
        (tool): tool is CanonicalServerToolDefinition => tool.execution === 'server',
      ),
      async executeTool(call) {
        return {
          type: 'tool-result',
          toolCallId: call.id,
          content: [{ type: 'text', text: '{"name":"Example"}', cache: 'none' }],
          isError: false,
          cache: 'none',
        };
      },
      onEvent(event) {
        observed.push(event);
      },
    };
    const result = await createInferenceService(ENV).runAgent(request);
    expect(result.iterations).toBe(2);
    expect(result.content).toContainEqual({ type: 'text', text: 'Found it', cache: 'none' });
    expect(observed.some((event) => event.type === 'tool-result')).toBe(true);
    const second = sentBody(fetchCall(fetchMock, 1).init);
    expect(second.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'private provider state',
              signature: 'signed-state',
            },
            expect.objectContaining({
              type: 'tool_use',
              id: 'tool_1',
              name: 'lookup',
              input: { id: '42' },
            }),
          ],
        }),
        expect.objectContaining({
          role: 'user',
          content: [
            expect.objectContaining({
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: '{"name":"Example"}',
            }),
          ],
        }),
      ]),
    );
  });

  it('passes initial continuation to the first adapter turn', async () => {
    const continuation = { backend: 'anthropic' as const, value: { opaque: 'turn-0' } };
    let observed: InferenceRequest | undefined;
    const adapter = fakeAdapter(async function* (request) {
      observed = request;
      yield { type: 'complete', result: completedResult() };
    });
    const service = new DefaultInferenceService(() => adapter);
    await service.runAgent({
      ...canonicalRequest(),
      continuation,
      mode: 'none',
      tools: [],
      maxIterations: 1,
    });
    expect(observed?.continuation).toEqual(continuation);
  });

  it('preserves normalized adapter error events through the shared runtime', async () => {
    const error = {
      backend: 'anthropic' as const,
      status: 429,
      code: 'rate_limit',
      message: 'slow down',
      detail: 'request-id-safe-detail',
      retryable: true,
      failureClass: 'http' as const,
    };
    const adapter = fakeAdapter(async function* () {
      yield { type: 'error', error };
    });
    const service = new DefaultInferenceService(() => adapter);
    await expect(
      service.runAgent({
        ...canonicalRequest(),
        mode: 'none',
        tools: [],
        maxIterations: 1,
      }),
    ).rejects.toMatchObject({ inferenceError: error });
  });

  it('returns client tool calls without executing them server-side', async () => {
    const tool = {
      ...canonicalRequest().tools[0],
      execution: 'client' as const,
    } as CanonicalClientToolDefinition;
    const toolCall = {
      type: 'tool-call' as const,
      id: 'browser_1',
      name: tool.name,
      input: { id: '42' },
      cache: 'none' as const,
    };
    const adapter = fakeAdapter(async function* () {
      yield {
        type: 'complete',
        result: {
          ...completedResult(),
          content: [toolCall],
          toolCalls: [toolCall],
          stopReason: 'tool-call',
        },
      };
    });
    const service = new DefaultInferenceService(() => adapter);
    const result = await service.runAgent({
      ...canonicalRequest(),
      mode: 'client',
      tools: [tool],
      maxIterations: 4,
    });
    expect(result.iterations).toBe(1);
    expect(result.toolCalls).toEqual([toolCall]);
  });

  it('concatenates text blocks within a turn and separates model turns once', async () => {
    let turn = 0;
    const adapter = fakeAdapter(async function* () {
      turn += 1;
      const toolCall = {
        type: 'tool-call' as const,
        id: 'tool_1',
        name: 'lookup',
        input: { id: '42' },
        cache: 'none' as const,
      };
      yield {
        type: 'complete',
        result:
          turn === 1
            ? {
                ...completedResult(),
                content: [
                  { type: 'text', text: 'one', cache: 'none' },
                  { type: 'text', text: 'two', cache: 'none' },
                  toolCall,
                ],
                toolCalls: [toolCall],
                stopReason: 'tool-call',
              }
            : {
                ...completedResult(),
                content: [{ type: 'text', text: 'three', cache: 'none' }],
              },
      };
    });
    const service = new DefaultInferenceService(() => adapter);
    const result = await service.runAgent({
      ...canonicalRequest(),
      mode: 'server',
      maxIterations: 2,
      tools: canonicalRequest().tools as readonly CanonicalServerToolDefinition[],
      async executeTool(call) {
        return {
          type: 'tool-result',
          toolCallId: call.id,
          content: [{ type: 'text', text: 'ok', cache: 'none' }],
          isError: false,
          cache: 'none',
        };
      },
    });
    expect(result.text).toBe('onetwo\nthree');
  });
});

function completedResult(): InferenceResult {
  return {
    content: [{ type: 'text', text: 'done', cache: 'none' }],
    toolCalls: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      reasoningTokens: null,
    },
    stopReason: 'completed',
  };
}

function fakeAdapter(
  stream: (request: InferenceRequest) => AsyncIterable<InferenceEvent>,
): InferenceProviderAdapter {
  return {
    provider: 'anthropic',
    apiFamily: 'anthropic-messages',
    complete: async () => completedResult(),
    stream,
  };
}

describe('Anthropic Files API upload failures', () => {
  it('appends the beta-access hint to a 500 and to nothing else', async () => {
    const files = createInferenceFileService(ENV);
    const profile = getModelProfile('placement', ENV);
    const policy = getFilePolicy('anthropic-provider-files');
    const upload = () => files.upload(profile, policy, new Uint8Array([1]), 'a.txt', 'text/plain');

    stubFetch().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 500 }),
    );
    await expect(upload()).rejects.toMatchObject({
      inferenceError: {
        backend: 'anthropic',
        status: 500,
        message: expect.stringMatching(/^server error[\s\S]*Files API[\s\S]*beta/),
      },
    });

    stubFetch().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 }),
    );
    await expect(upload()).rejects.toMatchObject({
      inferenceError: { backend: 'anthropic', status: 404, message: 'not found' },
    });
  });
});
