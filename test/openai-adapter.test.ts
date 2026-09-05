/** OpenAI Responses adapter fixtures. All provider calls are mocked/no-credit. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CanonicalClientToolDefinition,
  CanonicalServerToolDefinition,
  FilePolicy,
  InferenceRequest,
  InferenceResult,
  ModelProfile,
  ProviderContinuationState,
} from '../src/lib/inference-types';
import { InferenceFailure } from '../src/inference/adapter';
import { OpenAIResponsesAdapter } from '../src/inference/adapters/openai';
import {
  createInferenceDiagnosticsService,
  createInferenceFileService,
  createInferenceService,
} from '../src/inference/factory';
import { dedupUpload } from '../src/lib/file-dedup';
import { messagesCompatibilityResponse } from '../src/inference/messages-compatibility';
import { registeredMessagesResponse } from '../src/handlers/messages';
import { ENV, fetchCall, kvMock, sentBody, stubFetch } from './helpers';

const PROFILE: ModelProfile = {
  name: 'openai-responses-test',
  provider: 'openai',
  apiFamily: 'openai-responses',
  model: 'gpt-test',
  capabilities: {
    vision: true,
    reusableFiles: true,
    providerFiles: true,
    streaming: true,
    structuredOutput: true,
    serverTools: true,
    clientTools: true,
    reasoning: true,
    inlineCacheBreakpoints: true,
  },
};

const POLICY: FilePolicy = {
  name: 'openai-user-data-files',
  provider: 'openai',
  compatibleApiFamilies: ['openai-responses'],
  inputMode: 'provider-file',
  lifecycle: 'provider-managed',
  purpose: 'user_data',
};

const LOOKUP_SCHEMA = {
  type: 'object' as const,
  properties: { id: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

function request(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    prompt: 'Stable instructions',
    promptGroup: 'test-group',
    modelProfile: PROFILE,
    filePolicy: POLICY,
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'Volatile system context', cache: 'short' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello', cache: 'none' }],
      },
    ],
    maxOutputTokens: 2048,
    effort: 'medium',
    structuredOutput: {
      name: 'answer',
      description: 'A strict answer',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
      strict: true,
    },
    sampling: { temperature: 0.2, topP: 0.9 },
    serviceTier: 'default',
    metadata: { trace: 'phase3-fixture' },
    tools: [
      {
        name: 'lookup',
        description: 'Look up a record',
        execution: 'server',
        strict: true,
        inputSchema: LOOKUP_SCHEMA,
      },
    ],
    toolChoice: { mode: 'specific', name: 'lookup', disableParallel: true },
    ...overrides,
  };
}

function response(
  output: readonly Record<string, unknown>[] = [],
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1_700_000_000,
    model: PROFILE.model,
    status: 'completed',
    output,
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 15,
    },
    ...overrides,
  };
}

function message(
  text: string,
  annotations: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations }],
  };
}

function functionCall(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'function_call',
    call_id: 'call_1',
    name: 'lookup',
    arguments: '{"id":"42"}',
    ...overrides,
  };
}

function sse(events: readonly Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function created(id = 'resp_1'): Record<string, unknown> {
  return {
    type: 'response.created',
    sequence_number: 0,
    response: {
      id,
      object: 'response',
      created_at: 1_700_000_000,
      model: PROFILE.model,
      status: 'in_progress',
      output: [],
      error: null,
      incomplete_details: null,
      usage: null,
    },
  };
}

function progressResponse(status: 'queued' | 'in_progress'): Record<string, unknown> {
  return { ...(created().response as Record<string, unknown>), status };
}

function completedMessageStream(
  text: string,
  responseId: string,
  messageId = 'msg_1',
): Record<string, unknown>[] {
  const finalMessage = { ...message(text), id: messageId };
  return [
    created(responseId),
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 3,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      sequence_number: 4,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: 'response.content_part.done',
      sequence_number: 5,
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    },
    { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: finalMessage },
    {
      type: 'response.completed',
      sequence_number: 7,
      response: response([finalMessage], { id: responseId }),
    },
  ];
}

function completedFunctionStream(responseId: string): Record<string, unknown>[] {
  const finalCall = { id: 'fc_1', ...functionCall({ status: 'completed' }) };
  return [
    created(responseId),
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...finalCall, arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.delta',
      sequence_number: 2,
      item_id: 'fc_1',
      output_index: 0,
      delta: '{"id":"42"}',
    },
    {
      type: 'response.function_call_arguments.done',
      sequence_number: 3,
      item_id: 'fc_1',
      output_index: 0,
      arguments: '{"id":"42"}',
      name: 'lookup',
    },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: finalCall },
    {
      type: 'response.completed',
      sequence_number: 5,
      response: response([finalCall], { id: responseId }),
    },
  ];
}

function completedReasoningStream(responseId: string): Record<string, unknown>[] {
  const finalItem = {
    id: 'rs_1',
    type: 'reasoning',
    status: 'completed',
    summary: [{ type: 'summary_text', text: 'summary' }],
    content: [{ type: 'reasoning_text', text: 'reasoning' }],
  };
  return [
    created(responseId),
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...finalItem, status: 'in_progress', summary: [], content: [] },
    },
    {
      type: 'response.reasoning_summary_part.added',
      sequence_number: 2,
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      sequence_number: 3,
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      delta: 'summary',
    },
    {
      type: 'response.reasoning_summary_text.done',
      sequence_number: 4,
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      text: 'summary',
    },
    {
      type: 'response.reasoning_summary_part.done',
      sequence_number: 5,
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: 'summary' },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 6,
      item_id: 'rs_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'reasoning_text', text: '' },
    },
    {
      type: 'response.reasoning_text.delta',
      sequence_number: 7,
      item_id: 'rs_1',
      output_index: 0,
      content_index: 0,
      delta: 'reasoning',
    },
    {
      type: 'response.reasoning_text.done',
      sequence_number: 8,
      item_id: 'rs_1',
      output_index: 0,
      content_index: 0,
      text: 'reasoning',
    },
    {
      type: 'response.content_part.done',
      sequence_number: 9,
      item_id: 'rs_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'reasoning_text', text: 'reasoning' },
    },
    { type: 'response.output_item.done', sequence_number: 10, output_index: 0, item: finalItem },
    {
      type: 'response.completed',
      sequence_number: 11,
      response: response([finalItem], { id: responseId }),
    },
  ];
}

function completedRefusalStream(responseId: string): Record<string, unknown>[] {
  const finalItem = {
    id: 'msg_refusal',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'refusal', refusal: 'Cannot comply' }],
  };
  return [
    created(responseId),
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...finalItem, status: 'in_progress', content: [] },
    },
    {
      type: 'response.content_part.added',
      sequence_number: 2,
      item_id: 'msg_refusal',
      output_index: 0,
      content_index: 0,
      part: { type: 'refusal', refusal: '' },
    },
    {
      type: 'response.refusal.delta',
      sequence_number: 3,
      item_id: 'msg_refusal',
      output_index: 0,
      content_index: 0,
      delta: 'Cannot comply',
    },
    {
      type: 'response.refusal.done',
      sequence_number: 4,
      item_id: 'msg_refusal',
      output_index: 0,
      content_index: 0,
      refusal: 'Cannot comply',
    },
    {
      type: 'response.content_part.done',
      sequence_number: 5,
      item_id: 'msg_refusal',
      output_index: 0,
      content_index: 0,
      part: { type: 'refusal', refusal: 'Cannot comply' },
    },
    { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: finalItem },
    {
      type: 'response.completed',
      sequence_number: 7,
      response: response([finalItem], { id: responseId }),
    },
  ];
}

afterEach(() => vi.restoreAllMocks());

describe('OpenAI Responses complete translation', () => {
  it('maps canonical controls, multimodal inputs, strict tools, and normalized output', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(
        JSON.stringify(
          response([
            { id: 'rs_1', type: 'reasoning', summary: [], content: [] },
            message('{"answer":"ok"}', [
              { type: 'file_citation', file_id: 'file_source', filename: 'brief.pdf', index: 0 },
            ]),
          ]),
        ),
      ),
    );
    const adapter = new OpenAIResponsesAdapter(ENV);
    const result = await adapter.complete(
      request({
        messages: [
          ...request().messages,
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', mediaType: 'image/png', data: 'aW1n' },
                cache: 'none',
              },
              {
                type: 'image',
                source: { type: 'url', url: 'https://images.test/page.jpg' },
                cache: 'none',
              },
              {
                type: 'document',
                title: 'Brief',
                source: { type: 'url', url: 'https://files.test/brief.pdf' },
                cache: 'none',
              },
              {
                type: 'document',
                source: { type: 'text', mediaType: 'text/plain', text: 'plain evidence' },
                cache: 'none',
              },
              {
                type: 'document',
                title: 'Bytes',
                source: { type: 'base64', mediaType: 'application/pdf', data: 'cGRm' },
                cache: 'none',
              },
              {
                type: 'document',
                title: 'Mixed evidence',
                source: {
                  type: 'content',
                  content: [
                    { type: 'text', text: 'nested evidence', cache: 'none' },
                    {
                      type: 'image',
                      source: { type: 'base64', mediaType: 'image/jpeg', data: 'bmVzdGVk' },
                      cache: 'none',
                    },
                  ],
                },
                cache: 'none',
              },
              {
                type: 'image',
                source: {
                  type: 'provider-file',
                  reference: {
                    provider: 'openai',
                    accountScope: 'test',
                    tenantScope: 'tenant',
                    filePolicy: POLICY.name,
                    compatibleGroups: ['test-group'],
                    upstreamFileId: 'file_img',
                    contentHash: 'hash',
                    mediaType: 'image/png',
                    sizeBytes: 3,
                    expiresAt: null,
                  },
                },
                cache: 'none',
              },
              {
                type: 'document',
                title: 'Provider document',
                source: {
                  type: 'provider-file',
                  reference: {
                    provider: 'openai',
                    accountScope: 'test',
                    tenantScope: 'tenant',
                    filePolicy: POLICY.name,
                    compatibleGroups: ['test-group'],
                    upstreamFileId: 'file_doc',
                    contentHash: 'document-hash',
                    mediaType: 'application/pdf',
                    sizeBytes: 7,
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
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-openai-key',
    );
    const body = sentBody(call.init);
    expect(body).toMatchObject({
      model: PROFILE.model,
      max_output_tokens: 2048,
      store: true,
      reasoning: { effort: 'medium' },
      temperature: 0.2,
      top_p: 0.9,
      service_tier: 'default',
      metadata: { trace: 'phase3-fixture' },
      parallel_tool_calls: false,
      prompt_cache_key: 'app-ai:test-group:openai-responses-test',
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      tool_choice: { type: 'function', name: 'lookup' },
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          description: 'A strict answer',
          strict: true,
        },
      },
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a record',
        strict: true,
        parameters: LOOKUP_SCHEMA,
      },
    ]);
    expect(JSON.stringify(body.input)).toContain('data:image/png;base64,aW1n');
    expect(JSON.stringify(body.input)).toContain('https://images.test/page.jpg');
    expect(JSON.stringify(body.input)).toContain('https://files.test/brief.pdf');
    expect(JSON.stringify(body.input)).toContain('plain evidence');
    expect(JSON.stringify(body.input)).toContain('data:application/pdf;base64,cGRm');
    expect(JSON.stringify(body.input)).toContain('nested evidence');
    expect(JSON.stringify(body.input)).toContain('data:image/jpeg;base64,bmVzdGVk');
    expect(JSON.stringify(body.input)).toContain('file_img');
    expect(JSON.stringify(body.input)).toContain('file_doc');
    expect(body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: [
            expect.objectContaining({
              type: 'input_text',
              text: 'Stable instructions',
              prompt_cache_breakpoint: { mode: 'explicit' },
            }),
          ],
        }),
      ]),
    );
    expect(result).toMatchObject({
      content: [
        {
          type: 'text',
          text: '{"answer":"ok"}',
          citations: [
            { type: 'file_citation', file_id: 'file_source', filename: 'brief.pdf', index: 0 },
          ],
          cache: 'none',
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 3,
        reasoningTokens: 2,
      },
      stopReason: 'completed',
      providerState: { backend: 'openai', value: { previousResponseId: 'resp_1' } },
    });
  });

  it('routes an internal OpenAI profile through the factory without changing the registry', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(JSON.stringify(response([message('factory')]))),
    );
    const configured = request();
    const {
      structuredOutput: _structured,
      sampling: _sampling,
      toolChoice: _choice,
      ...plain
    } = configured;
    const result = await createInferenceService(ENV).complete({ ...plain, tools: [] });
    expect(result.content).toEqual([{ type: 'text', text: 'factory', cache: 'none' }]);
    expect(fetchCall(fetchMock, 0).url).toContain('/v1/responses');
  });

  it('routes diagnostics through the candidate adapter without fabricating token counts', async () => {
    const fetchMock = stubFetch();
    await expect(createInferenceDiagnosticsService(ENV).countTokens(request())).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes an OpenAI result through the registered /messages compatibility envelope', async () => {
    stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify(response([functionCall()]))))
      .mockResolvedValueOnce(new Response(JSON.stringify(response([message('done')]))));
    const adapter = new OpenAIResponsesAdapter(ENV);
    const toolResult = await adapter.complete(request());
    expect(messagesCompatibilityResponse(toolResult, PROFILE.model)).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: PROFILE.model,
      content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: '42' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 3 },
    });
    const textResult = await adapter.complete(request());
    expect(messagesCompatibilityResponse(textResult, PROFILE.model)).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: PROFILE.model,
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
    });
  });

  it('covers every canonical /messages stop, citation, and cache mapping through handler wiring', async () => {
    const baseResult: InferenceResult = {
      content: [
        {
          type: 'text',
          text: 'cited',
          citations: [{ type: 'file_citation', file_id: 'opaque-at-public-boundary' }],
          cache: 'none',
        },
      ],
      toolCalls: [],
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 6,
        cacheWriteInputTokens: 4,
        reasoningTokens: 1,
      },
      stopReason: 'max-output-tokens',
      providerStopReason: 'max_tokens',
    };
    const maxResponse = await registeredMessagesResponse(baseResult, request(), {
      'X-Test': 'wired',
    });
    expect(maxResponse.headers.get('X-Test')).toBe('wired');
    expect(await maxResponse.json()).toMatchObject({
      model: PROFILE.model,
      content: [
        {
          type: 'text',
          text: 'cited',
          citations: [{ type: 'file_citation', file_id: 'opaque-at-public-boundary' }],
        },
      ],
      stop_reason: 'max_tokens',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 6,
        cache_creation_input_tokens: 4,
      },
    });
    const cases = [
      { stopReason: 'content-filter' as const, providerStopReason: 'refusal', expected: 'refusal' },
      {
        stopReason: 'unknown' as const,
        providerStopReason: 'provider_custom',
        expected: 'provider_custom',
      },
      { stopReason: 'unknown' as const, providerStopReason: null, expected: null },
    ];
    for (const item of cases) {
      const envelope = messagesCompatibilityResponse(
        { ...baseResult, stopReason: item.stopReason, providerStopReason: item.providerStopReason },
        PROFILE.model,
      ) as { stop_reason: string | null };
      expect(envelope.stop_reason).toBe(item.expected);
    }
  });

  it('rejects provider-hosted tools until their output Items are modeled', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    await expect(
      adapter.complete(
        request({
          tools: [
            {
              name: 'web_search',
              description: 'Search the web',
              execution: 'provider',
              providerState: { backend: 'openai', value: { type: 'web_search_preview' } },
            },
          ],
        }),
      ),
    ).rejects.toThrow('provider-hosted tools are not supported');
  });

  it('uses previous_response_id and sends only post-response tool results, including images', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      new Response(JSON.stringify(response([message('continued')], { id: 'resp_2' }))),
    );
    const continuation: ProviderContinuationState = {
      backend: 'openai',
      value: { previousResponseId: 'resp_1' },
    };
    await new OpenAIResponsesAdapter(ENV).complete(
      request({
        continuation,
        messages: [
          ...request().messages,
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                id: 'call_1',
                name: 'lookup',
                input: { id: '42' },
                cache: 'none',
              },
            ],
            providerState: continuation,
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call_1',
                isError: false,
                cache: 'none',
                content: [
                  { type: 'text', text: 'visible page', cache: 'none' },
                  {
                    type: 'image',
                    source: { type: 'base64', mediaType: 'image/png', data: 'cGFnZQ==' },
                    cache: 'none',
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const body = sentBody(fetchCall(fetchMock, 0).init);
    expect(body.previous_response_id).toBe('resp_1');
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
    expect(JSON.stringify(body.input)).not.toContain('Stable instructions');
    expect(body.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'visible page' },
          { type: 'input_image', image_url: 'data:image/png;base64,cGFnZQ==', detail: 'auto' },
        ],
      },
    ]);
  });

  it('normalizes function calls and incomplete responses without fabricating arguments', async () => {
    stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify(response([functionCall()]))))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            response([], {
              id: 'resp_2',
              status: 'incomplete',
              incomplete_details: { reason: 'max_tokens' },
              usage: null,
            }),
          ),
        ),
      );
    const adapter = new OpenAIResponsesAdapter(ENV);
    const tool = await adapter.complete(request());
    expect(tool.toolCalls).toEqual([
      expect.objectContaining({ id: 'call_1', name: 'lookup', input: { id: '42' } }),
    ]);
    expect(tool.stopReason).toBe('tool-call');
    const incomplete = await adapter.complete(request());
    expect(incomplete.stopReason).toBe('max-output-tokens');
    expect(incomplete.usage.inputTokens).toBeNull();

    stubFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          response([], {
            id: 'resp_3',
            status: 'incomplete',
            incomplete_details: {},
            usage: null,
          }),
        ),
      ),
    );
    await expect(adapter.complete(request())).resolves.toMatchObject({
      stopReason: 'unknown',
      providerStopReason: 'incomplete',
    });
  });

  it('normalizes a complete refusal without losing its public text', async () => {
    stubFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          response([
            {
              id: 'msg_refusal',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'refusal', refusal: 'Cannot comply' }],
            },
          ]),
        ),
      ),
    );
    await expect(new OpenAIResponsesAdapter(ENV).complete(request())).resolves.toMatchObject({
      content: [{ type: 'text', text: 'Cannot comply' }],
      stopReason: 'content-filter',
      providerStopReason: 'refusal',
    });
  });

  it('never exposes a function call from an incomplete parent response', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    for (const call of [functionCall(), functionCall({ status: 'completed' })]) {
      stubFetch().mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            response([call], {
              status: 'incomplete',
              incomplete_details: {},
              usage: null,
            }),
          ),
        ),
      );
      await expect(adapter.complete(request())).rejects.toMatchObject({
        inferenceError: { backend: 'openai', failureClass: 'invalid-response' },
      });
    }
  });

  it('never executes a function call from an incomplete streamed parent response', async () => {
    stubFetch().mockResolvedValueOnce(
      sse([
        created(),
        {
          type: 'response.incomplete',
          sequence_number: 1,
          response: response([functionCall()], {
            status: 'incomplete',
            incomplete_details: {},
            usage: null,
          }),
        },
      ]),
    );
    const executeTool = vi.fn();
    const base = request();
    await expect(
      createInferenceService(ENV).runAgent({
        ...base,
        mode: 'server',
        maxIterations: 2,
        tools: base.tools as readonly CanonicalServerToolDefinition[],
        executeTool,
      }),
    ).rejects.toMatchObject({
      inferenceError: { backend: 'openai', failureClass: 'invalid-response' },
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('fails before provider I/O when canonical cache intent exceeds OpenAI write limits', async () => {
    const fetchMock = stubFetch();
    await expect(
      new OpenAIResponsesAdapter(ENV).complete(
        request({
          messages: [
            {
              role: 'user',
              content: Array.from({ length: 5 }, (_, index) => ({
                type: 'text' as const,
                text: `stable-${index}`,
                cache: 'short' as const,
              })),
            },
          ],
        }),
      ),
    ).rejects.toThrow('at most 4 writable prompt-cache breakpoints');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails before provider I/O for undeclared caching and unsupported canonical controls', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    const fetchMock = stubFetch();
    await expect(
      adapter.complete(
        request({
          modelProfile: {
            ...PROFILE,
            capabilities: { ...PROFILE.capabilities, inlineCacheBreakpoints: false },
          },
        }),
      ),
    ).rejects.toThrow('cannot cache prompts');
    await expect(adapter.complete(request({ sampling: { topK: 20 } }))).rejects.toThrow(
      'does not support canonical topK',
    );
    await expect(adapter.complete(request({ stopSequences: ['STOP'] }))).rejects.toThrow(
      'does not support canonical stop sequences',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects incompatible adapter and file-policy routes before provider I/O', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    const fetchMock = stubFetch();
    await expect(
      adapter.complete(
        request({
          modelProfile: { ...PROFILE, provider: 'anthropic', apiFamily: 'anthropic-messages' },
        }),
      ),
    ).rejects.toThrow('incompatible model profile');
    await expect(
      adapter.complete(request({ filePolicy: { ...POLICY, purpose: 'assistants' } })),
    ).rejects.toThrow('cannot use file policy');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OpenAI Responses streaming and failure normalization', () => {
  it('translates lifecycle text, usage, and terminal result events', async () => {
    stubFetch().mockResolvedValue(
      sse([
        created(),
        {
          type: 'response.in_progress',
          sequence_number: 1,
          response: progressResponse('in_progress'),
        },
        {
          type: 'response.output_item.added',
          sequence_number: 2,
          output_index: 0,
          item: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        },
        {
          type: 'response.content_part.added',
          sequence_number: 3,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 4,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'hel',
        },
        {
          type: 'response.output_text.annotation.added',
          sequence_number: 5,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          annotation_index: 0,
          annotation: { type: 'file_citation', file_id: 'file_source', index: 0 },
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 6,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'lo',
        },
        {
          type: 'response.output_text.done',
          sequence_number: 7,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          text: 'hello',
        },
        {
          type: 'response.content_part.done',
          sequence_number: 8,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          part: {
            type: 'output_text',
            text: 'hello',
            annotations: [{ type: 'file_citation', file_id: 'file_source', index: 0 }],
          },
        },
        {
          type: 'response.output_item.done',
          sequence_number: 9,
          output_index: 0,
          item: message('hello', [{ type: 'file_citation', file_id: 'file_source', index: 0 }]),
        },
        {
          type: 'response.completed',
          sequence_number: 10,
          response: response([
            message('hello', [{ type: 'file_citation', file_id: 'file_source', index: 0 }]),
          ]),
        },
      ]),
    );
    const events = [];
    for await (const event of new OpenAIResponsesAdapter(ENV).stream(request())) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      'message-start',
      'text-delta',
      'text-delta',
      'usage',
      'complete',
    ]);
    expect(events[1]).toEqual({ type: 'text-delta', delta: 'hel' });
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: {
        content: [
          {
            type: 'text',
            citations: [{ type: 'file_citation', file_id: 'file_source', index: 0 }],
          },
        ],
      },
    });
  });

  it('emits terminal tool calls from a streamed response', async () => {
    stubFetch().mockResolvedValue(
      sse([
        created(),
        {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup',
            arguments: '',
            status: 'in_progress',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          sequence_number: 2,
          item_id: 'fc_1',
          output_index: 0,
          delta: '{"id":"42"}',
        },
        {
          type: 'response.function_call_arguments.done',
          sequence_number: 3,
          item_id: 'fc_1',
          output_index: 0,
          arguments: '{"id":"42"}',
          name: 'lookup',
        },
        {
          type: 'response.output_item.done',
          sequence_number: 4,
          output_index: 0,
          item: {
            id: 'fc_1',
            ...functionCall({ status: 'completed' }),
          },
        },
        {
          type: 'response.completed',
          sequence_number: 5,
          response: response([{ id: 'fc_1', ...functionCall({ status: 'completed' }) }]),
        },
      ]),
    );
    const events = [];
    for await (const event of new OpenAIResponsesAdapter(ENV).stream(request())) events.push(event);
    expect(events).toContainEqual({
      type: 'tool-call',
      call: expect.objectContaining({ id: 'call_1', input: { id: '42' } }),
    });
  });

  it('reconciles streamed reasoning summary/content with item and terminal arrays', async () => {
    stubFetch().mockResolvedValue(sse(completedReasoningStream('resp_reasoning')));
    const events = [];
    for await (const event of new OpenAIResponsesAdapter(ENV).stream(request())) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['message-start', 'usage', 'complete']);
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: { stopReason: 'completed', providerState: { backend: 'openai' } },
    });
  });

  it('streams a refusal through the complete item/content lifecycle', async () => {
    stubFetch().mockResolvedValue(sse(completedRefusalStream('resp_refusal')));
    const events = [];
    for await (const event of new OpenAIResponsesAdapter(ENV).stream(request())) events.push(event);
    expect(events).toContainEqual({ type: 'text-delta', delta: 'Cannot comply' });
    expect(events.at(-1)).toMatchObject({
      type: 'complete',
      result: {
        content: [{ type: 'text', text: 'Cannot comply' }],
        stopReason: 'content-filter',
        providerStopReason: 'refusal',
      },
    });
  });

  it('continues the shared server-tool loop with previous_response_id and call_id', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(sse(completedFunctionStream('resp_tool')))
      .mockResolvedValueOnce(sse(completedMessageStream('done', 'resp_done')));
    const base = request();
    const result = await createInferenceService(ENV).runAgent({
      ...base,
      mode: 'server',
      maxIterations: 3,
      tools: base.tools as readonly CanonicalServerToolDefinition[],
      async executeTool(call) {
        return {
          type: 'tool-result',
          toolCallId: call.id,
          content: [{ type: 'text', text: 'record 42', cache: 'none' }],
          isError: false,
          cache: 'none',
        };
      },
    });
    expect(result).toMatchObject({ text: 'done', iterations: 2, stopReason: 'completed' });
    const second = sentBody(fetchCall(fetchMock, 1).init);
    expect(second.previous_response_id).toBe('resp_tool');
    expect(second.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          {
            type: 'input_text',
            text: 'record 42',
            prompt_cache_breakpoint: { mode: 'explicit' },
          },
        ],
      },
    ]);
  });

  it('returns browser-owned tool calls with opaque OpenAI continuation state', async () => {
    stubFetch().mockResolvedValue(sse(completedFunctionStream('resp_client')));
    const clientTool: CanonicalClientToolDefinition = {
      name: 'lookup',
      description: 'Look up in the browser',
      execution: 'client',
      strict: true,
      inputSchema: LOOKUP_SCHEMA,
    };
    const base = request({ tools: [clientTool] });
    const result = await createInferenceService(ENV).runAgent({
      ...base,
      mode: 'client',
      maxIterations: 3,
      tools: [clientTool],
    });
    expect(result).toMatchObject({
      iterations: 1,
      stopReason: 'tool-call',
      toolCalls: [expect.objectContaining({ id: 'call_1' })],
      providerState: { backend: 'openai', value: { previousResponseId: 'resp_client' } },
    });
  });

  it('fails closed on malformed complete/SSE envelopes and tool JSON', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    for (const invalid of [
      null,
      response([message('x')], { usage: {} }),
      response([{ ...functionCall(), arguments: '{' }]),
      response([{ ...message('x'), status: undefined }]),
      response([functionCall({ status: 'incomplete', arguments: '{}' })]),
    ]) {
      stubFetch().mockResolvedValueOnce(new Response(JSON.stringify(invalid)));
      await expect(adapter.complete(request())).rejects.toMatchObject({
        inferenceError: { backend: 'openai', failureClass: 'invalid-response' },
      });
    }
    stubFetch().mockResolvedValueOnce(
      sse([{ type: 'response.output_text.delta', sequence_number: 0, delta: 'early' }]),
    );
    await expect(async () => {
      for await (const event of adapter.stream(request())) void event;
    }).rejects.toBeInstanceOf(InferenceFailure);

    stubFetch().mockResolvedValueOnce(
      sse([
        created(),
        {
          type: 'response.completed',
          sequence_number: 1,
          response: response([], {
            status: 'incomplete',
            incomplete_details: { reason: 'max_tokens' },
            usage: null,
          }),
        },
      ]),
    );
    await expect(async () => {
      for await (const event of adapter.stream(request())) void event;
    }).rejects.toBeInstanceOf(InferenceFailure);

    stubFetch().mockResolvedValueOnce(
      sse([created(), { type: 'response.output_item.added', sequence_number: 1, output_index: 0 }]),
    );
    await expect(async () => {
      for await (const event of adapter.stream(request())) void event;
    }).rejects.toBeInstanceOf(InferenceFailure);

    for (const malformed of [
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { type: 'message' },
      },
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
      },
      {
        type: 'response.content_part.added',
        sequence_number: 1,
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text' },
      },
      {
        type: 'response.in_progress',
        sequence_number: 1,
        response: {
          id: 'resp_1',
          object: 'response',
          status: 'in_progress',
          output: [],
          error: null,
          incomplete_details: null,
          usage: null,
        },
      },
    ]) {
      stubFetch().mockResolvedValueOnce(sse([created(), malformed]));
      await expect(async () => {
        for await (const event of adapter.stream(request())) void event;
      }).rejects.toMatchObject({
        inferenceError: { backend: 'openai', failureClass: 'invalid-response' },
      });
    }
  });

  it('rejects SSE events outside their item/content/response lifecycle', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    const textDoneMismatch = completedMessageStream('safe', 'resp_1');
    textDoneMismatch[4] = { ...textDoneMismatch[4], text: 'different' };
    const contentDoneMismatch = completedMessageStream('safe', 'resp_1');
    contentDoneMismatch[5] = {
      ...contentDoneMismatch[5],
      part: { type: 'output_text', text: 'different', annotations: [] },
    };
    const itemDoneMismatch = completedMessageStream('safe', 'resp_1');
    itemDoneMismatch[6] = {
      ...itemDoneMismatch[6],
      item: { ...message('different'), id: 'msg_1' },
    };
    const terminalMismatch = completedMessageStream('safe', 'resp_1');
    terminalMismatch[7] = {
      ...terminalMismatch[7],
      response: response([{ ...message('different'), id: 'msg_1' }]),
    };
    const functionMismatch = completedFunctionStream('resp_1');
    functionMismatch[3] = { ...functionMismatch[3], name: 'changed' };
    const messageIndexGap = completedMessageStream('safe', 'resp_1');
    for (const index of [2, 3, 4, 5]) {
      messageIndexGap[index] = { ...messageIndexGap[index], content_index: 7 };
    }
    const reasoningContentGap = completedReasoningStream('resp_1');
    for (const index of [6, 7, 8, 9]) {
      reasoningContentGap[index] = { ...reasoningContentGap[index], content_index: 7 };
    }
    const reasoningSummaryGap = completedReasoningStream('resp_1');
    for (const index of [2, 3, 4, 5]) {
      reasoningSummaryGap[index] = { ...reasoningSummaryGap[index], summary_index: 7 };
    }
    const reasoningContentOmitted = completedReasoningStream('resp_1');
    const itemDone = reasoningContentOmitted[10]?.item as Record<string, unknown>;
    const terminalResponse = reasoningContentOmitted[11]?.response as Record<string, unknown>;
    const terminalItem = (terminalResponse.output as readonly Record<string, unknown>[])[0];
    const { content: _itemContent, ...itemWithoutContent } = itemDone;
    const { content: _terminalContent, ...terminalWithoutContent } = terminalItem ?? {};
    reasoningContentOmitted[10] = { ...reasoningContentOmitted[10], item: itemWithoutContent };
    reasoningContentOmitted[11] = {
      ...reasoningContentOmitted[11],
      response: { ...terminalResponse, output: [terminalWithoutContent] },
    };
    const refusalDoneMismatch = completedRefusalStream('resp_1');
    refusalDoneMismatch[4] = { ...refusalDoneMismatch[4], refusal: 'changed' };
    const refusalContentMismatch = completedRefusalStream('resp_1');
    refusalContentMismatch[5] = {
      ...refusalContentMismatch[5],
      part: { type: 'refusal', refusal: 'changed' },
    };
    const refusalTerminalMismatch = completedRefusalStream('resp_1');
    refusalTerminalMismatch[7] = {
      ...refusalTerminalMismatch[7],
      response: response(
        [
          {
            id: 'msg_refusal',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'refusal', refusal: 'changed' }],
          },
        ],
        { id: 'resp_1' },
      ),
    };
    const invalidStreams = [
      [
        created(),
        {
          type: 'response.output_text.delta',
          sequence_number: 1,
          item_id: 'msg_missing',
          output_index: 0,
          content_index: 0,
          delta: 'not-owned',
        },
      ],
      [
        created(),
        {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        },
        {
          type: 'response.content_part.added',
          sequence_number: 2,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        {
          type: 'response.output_text.done',
          sequence_number: 3,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          text: 'done',
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 4,
          item_id: 'msg_1',
          output_index: 0,
          content_index: 0,
          delta: 'late',
        },
      ],
      [
        created(),
        {
          type: 'response.queued',
          sequence_number: 1,
          response: progressResponse('queued'),
        },
      ],
      textDoneMismatch,
      contentDoneMismatch,
      itemDoneMismatch,
      terminalMismatch,
      functionMismatch,
      messageIndexGap,
      reasoningContentGap,
      reasoningSummaryGap,
      reasoningContentOmitted,
      refusalDoneMismatch,
      refusalContentMismatch,
      refusalTerminalMismatch,
    ];
    for (const events of invalidStreams) {
      stubFetch().mockResolvedValueOnce(sse(events));
      await expect(async () => {
        for await (const event of adapter.stream(request())) void event;
      }).rejects.toMatchObject({
        inferenceError: { backend: 'openai', failureClass: 'invalid-response' },
      });
    }
  });

  it('normalizes HTTP, stream, timeout, and abort failures', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    const fetchMock = stubFetch().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'credit_balance_exhausted',
            type: 'insufficient_quota',
            message: 'No credit',
          },
        }),
        { status: 429 },
      ),
    );
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { status: 429, code: 'credit_balance_exhausted', retryable: false },
    });

    fetchMock.mockResolvedValueOnce(
      sse([
        created(),
        {
          type: 'error',
          sequence_number: 1,
          code: 'server_error',
          message: 'overloaded',
        },
      ]),
    );
    await expect(async () => {
      for await (const event of adapter.stream(request())) void event;
    }).rejects.toMatchObject({ inferenceError: { backend: 'openai', code: 'server_error' } });

    const timeout = Object.assign(new Error('slow'), { name: 'TimeoutError' });
    fetchMock.mockRejectedValueOnce(timeout);
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { failureClass: 'timeout', retryable: true },
    });
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(
      adapter.complete(request({ abortSignal: controller.signal })),
    ).rejects.toMatchObject({ inferenceError: { failureClass: 'cancelled', retryable: false } });
    expect(fetchCall(fetchMock, 3).init.signal).toBe(controller.signal);
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { failureClass: 'network', code: 'network_error', retryable: true },
    });
    fetchMock.mockResolvedValueOnce(new Response('{not-json', { status: 502 }));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: {
        backend: 'openai',
        status: 502,
        code: 'invalid_response',
        failureClass: 'invalid-response',
        retryable: true,
      },
    });
  });

  it('normalizes complete and streamed failed/cancelled terminal responses', async () => {
    const adapter = new OpenAIResponsesAdapter(ENV);
    const failed = {
      id: 'resp_1',
      object: 'response',
      status: 'failed',
      error: { code: 'server_error', message: 'provider failed' },
    };
    const cancelled = { id: 'resp_1', object: 'response', status: 'cancelled' };

    stubFetch().mockResolvedValueOnce(new Response(JSON.stringify(failed)));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { backend: 'openai', code: 'server_error', retryable: true },
    });
    stubFetch().mockResolvedValueOnce(new Response(JSON.stringify(cancelled)));
    await expect(adapter.complete(request())).rejects.toMatchObject({
      inferenceError: { backend: 'openai', failureClass: 'cancelled', retryable: false },
    });

    stubFetch().mockResolvedValueOnce(
      sse([created(), { type: 'response.failed', sequence_number: 1, response: failed }]),
    );
    await expect(async () => {
      for await (const event of adapter.stream(request())) void event;
    }).rejects.toMatchObject({ inferenceError: { backend: 'openai', code: 'server_error' } });
    stubFetch().mockResolvedValueOnce(
      sse([created(), { type: 'response.cancelled', sequence_number: 1, response: cancelled }]),
    );
    await expect(async () => {
      for await (const event of adapter.stream(request())) void event;
    }).rejects.toMatchObject({
      inferenceError: { backend: 'openai', failureClass: 'cancelled' },
    });
  });
});

describe('OpenAI Files adapter', () => {
  const file = {
    id: 'file_1',
    object: 'file',
    bytes: 3,
    created_at: 1_700_000_000,
    expires_at: 1_900_000_000,
    filename: 'page.png',
    purpose: 'user_data',
  };

  it('uploads with user_data and supports metadata/delete through the factory', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify(file)))
      .mockResolvedValueOnce(new Response(JSON.stringify(file)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'file_1', object: 'file', deleted: true })),
      );
    const files = createInferenceFileService(ENV);
    const scope = await files.scope(PROFILE, POLICY);
    expect(scope).toMatch(/^openai:[a-f0-9]{24}$/);
    await expect(
      createInferenceFileService({ ...ENV, OPENAI_API_KEY: 'another-openai-key' }).scope(
        PROFILE,
        POLICY,
      ),
    ).resolves.not.toBe(scope);
    const upload = await files.upload(
      PROFILE,
      POLICY,
      new Uint8Array([1, 2, 3]),
      'page.png',
      'image/png',
    );
    expect(upload).toEqual({
      id: 'file_1',
      mediaType: 'image/png',
      sizeBytes: 3,
      expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
    });
    const form = fetchCall(fetchMock, 0).init.body as FormData;
    expect(form.get('purpose')).toBe('user_data');
    expect((form.get('file') as unknown as { name: string }).name).toBe('page.png');
    expect(await files.getMetadata(PROFILE, 'file_1')).toMatchObject({ id: 'file_1' });
    await files.delete(PROFILE, 'file_1');
    expect(fetchCall(fetchMock, 1).url).toContain('/v1/files/file_1');
  });

  it('forwards one caller AbortSignal through every OpenAI Files operation', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify(file)))
      .mockResolvedValueOnce(new Response(JSON.stringify(file)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'file_1', object: 'file', deleted: true })),
      );
    const signal = new AbortController().signal;
    const files = createInferenceFileService(ENV);
    await files.upload(PROFILE, POLICY, new Uint8Array([1]), 'page.png', 'image/png', signal);
    await files.getMetadata(PROFILE, 'file_1', signal);
    await files.delete(PROFILE, 'file_1', signal);
    for (let index = 0; index < 3; index += 1) {
      expect(fetchCall(fetchMock, index).init.signal).toBe(signal);
    }
  });

  it('returns null on 404 and rejects mismatched/malformed file success envelopes', async () => {
    const files = createInferenceFileService(ENV);
    stubFetch().mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect(await files.getMetadata(PROFILE, 'file_missing')).toBeNull();
    stubFetch().mockResolvedValueOnce(new Response(JSON.stringify({ ...file, id: 'file_other' })));
    await expect(files.getMetadata(PROFILE, 'file_1')).rejects.toMatchObject({
      inferenceError: { failureClass: 'invalid-response' },
    });
    stubFetch().mockResolvedValueOnce(new Response('null'));
    await expect(
      files.upload(PROFILE, POLICY, new Uint8Array([1]), 'x.txt', 'text/plain'),
    ).rejects.toMatchObject({ inferenceError: { failureClass: 'invalid-response' } });
    stubFetch().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'file_other', object: 'file', deleted: true })),
    );
    await expect(files.delete(PROFILE, 'file_1')).rejects.toMatchObject({
      inferenceError: { failureClass: 'invalid-response' },
    });
  });

  it('preserves upload MIME through a KV dedup hit when OpenAI metadata omits it', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response(JSON.stringify(file)))
      .mockResolvedValueOnce(new Response(JSON.stringify(file)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...file, id: 'file_2', filename: 'page.jpg' })),
      );
    const { env } = kvMock();
    const route = {
      profile: PROFILE,
      policy: POLICY,
      accountScope: 'openai:test',
      tenantScope: 'tenant:test',
      compatibleGroups: ['test-group'] as [string, ...string[]],
    };
    const upload = {
      content: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      filename: 'page.png',
    };
    expect((await dedupUpload(upload, route, env)).reference.mediaType).toBe('image/png');
    expect((await dedupUpload(upload, route, env)).reference.mediaType).toBe('image/png');
    expect(fetchCall(fetchMock, 1).init.method).toBeUndefined();
    const differentMime = await dedupUpload(
      { ...upload, mimeType: 'image/jpeg', filename: 'page.jpg' },
      route,
      env,
    );
    expect(differentMime).toMatchObject({
      deduped: false,
      reference: { upstreamFileId: 'file_2', mediaType: 'image/jpeg' },
    });
    expect(fetchCall(fetchMock, 2).init.method).toBe('POST');
  });
});
