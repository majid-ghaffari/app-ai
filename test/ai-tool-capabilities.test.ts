/**
 * AI-tool capability and failure-sanitization coverage through the real Worker route.
 * Every case drives context validation, /chat, the Anthropic tool loop, and the
 * Personalizer HTTP boundary with mocked transports and no real network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import type { ContextValidation } from '../src/lib/auth';
import {
  anthropicMessageStart,
  ENV,
  fetchCall,
  fetchedUrls,
  readWorkerSse,
  sentBody,
  stubFetch,
  type FetchMock,
} from './helpers';

interface SseBlockSpec {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

const VALID_TOOL_RESULTS: Record<string, unknown> = {
  get_store_analytics: {
    FromDate: '2026-01-01',
    ToDate: '2026-01-31',
    OrderCount: 12,
    TotalRevenue: 552,
    AverageOrderValue: 46,
    ConversionRate: 0.04,
    Currency: 'USD',
  },
  list_segments: [
    {
      Guid: '11111111-2222-3333-4444-555555555555',
      Title: 'Customers',
      Status: 'Active',
    },
  ],
  list_campaigns: [
    {
      Guid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      Title: 'Welcome',
      Kind: 'discount',
      Status: 'Active',
    },
  ],
  get_store_config: {
    SubscriberTitle: 'Test store',
    Platform: 'Shopify',
    Currency: 'USD',
    Pages: [{ HostPage: 'Home', BoxTypes: ['TopPicks'] }],
  },
};

afterEach(() => vi.restoreAllMocks());

describe('AI-tool capability contract', () => {
  it.each([
    ['absent', undefined],
    ['unknown', 2],
  ])('fails closed when the contract version is %s', async (_label, contractVersion) => {
    const validation: ContextValidation = {
      SubscriberID: 7,
      SubscriberTitle: 'Test store',
      AvailableAiTools: ['get_store_analytics'],
      ...(contractVersion === undefined ? {} : { AiToolsContractVersion: contractVersion }),
    };
    const fetchMock = workerFlow(validation, [textTurn('No tools needed.')]);

    const response = await worker.fetch(chatRequest(), ENV);
    await readWorkerSse(response);

    expect(sentToolNames(fetchMock)).toEqual(['get_entity_context']);
  });

  it('offers only known data tools advertised by a version-1 contract', async () => {
    const fetchMock = workerFlow(
      {
        SubscriberID: 7,
        SubscriberTitle: 'Test store',
        AiToolsContractVersion: 1,
        AvailableAiTools: ['get_store_analytics', 'future_tool'],
      },
      [textTurn('Ready.')],
    );

    const response = await worker.fetch(chatRequest(), ENV);
    await readWorkerSse(response);

    expect(sentToolNames(fetchMock)).toEqual(['get_store_analytics', 'get_entity_context']);
  });

  it('degrades an unadvertised data-tool call without calling Brain', async () => {
    const fetchMock = workerFlow(
      {
        SubscriberID: 7,
        SubscriberTitle: 'Test store',
        AiToolsContractVersion: 1,
        AvailableAiTools: ['get_store_analytics'],
      },
      [toolTurn('list_segments'), textTurn('That tool is unavailable.')],
      VALID_TOOL_RESULTS.list_segments,
    );

    const response = await worker.fetch(chatRequest(), ENV);
    await readWorkerSse(response);

    expect(brainAiToolCalls(fetchMock)).toEqual([]);
    expect(modelVisibleToolResult(fetchMock)).toEqual({ error: 'Unknown tool: list_segments' });
  });
});

describe('AI-tool response boundary', () => {
  it('logs Brain error details but returns only a generic model-visible failure', async () => {
    const brainError = JSON.stringify({
      Message: 'AI tool data could not be read.',
      ExceptionType: 'AiToolReadException',
      MessageDetail: 'internal-host credential-fragment',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = workerFlow(
      versionOneValidation('get_store_analytics'),
      [toolTurn('get_store_analytics'), textTurn('The data is unavailable.')],
      new Response(brainError, { status: 500 }),
    );

    const response = await worker.fetch(chatRequest(), { ...ENV, LOG_TARGETS_ERROR: 'console' });
    await readWorkerSse(response);

    expect(modelVisibleToolResult(fetchMock)).toEqual({
      error: 'Brain AI tool get_store_analytics failed: 500',
    });
    expect(JSON.stringify(modelVisibleToolResult(fetchMock))).not.toContain('MessageDetail');
    expect(errorSpy.mock.calls).toContainEqual([
      '[Chat]',
      'Brain AI tool get_store_analytics failed',
      expect.objectContaining({ status: 500, responseBody: brainError }),
    ]);
  });

  it('logs a Brain transport error without exposing its details to the model', async () => {
    const transportError = new Error('internal-host credential-fragment');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = workerFlow(
      versionOneValidation('get_store_analytics'),
      [toolTurn('get_store_analytics'), textTurn('The data is unavailable.')],
      transportError,
    );

    const response = await worker.fetch(chatRequest(), { ...ENV, LOG_TARGETS_ERROR: 'console' });
    await readWorkerSse(response);

    expect(modelVisibleToolResult(fetchMock)).toEqual({
      error: 'Brain AI tool get_store_analytics request failed',
    });
    expect(JSON.stringify(modelVisibleToolResult(fetchMock))).not.toContain('internal-host');
    expect(errorSpy.mock.calls).toContainEqual([
      '[Chat]',
      'Brain AI tool get_store_analytics request failed',
      expect.objectContaining({
        Exception: expect.objectContaining({ message: 'internal-host credential-fragment' }),
      }),
    ]);
  });

  it.each(['get_store_analytics', 'list_segments', 'list_campaigns', 'get_store_config'])(
    'degrades a %s response missing required members',
    async (toolName) => {
      const fetchMock = workerFlow(
        versionOneValidation(toolName),
        [toolTurn(toolName), textTurn('The response was invalid.')],
        {},
      );

      const response = await worker.fetch(chatRequest(), ENV);
      await readWorkerSse(response);

      expect(modelVisibleToolResult(fetchMock)).toEqual({
        error: `Brain AI tool ${toolName} returned an invalid response`,
      });
    },
  );

  it.each(Object.entries(VALID_TOOL_RESULTS))(
    'accepts a %s response carrying all required members',
    async (toolName, brainResult) => {
      const fetchMock = workerFlow(
        versionOneValidation(toolName),
        [toolTurn(toolName), textTurn('The response is valid.')],
        brainResult,
      );

      const response = await worker.fetch(chatRequest(), ENV);
      await readWorkerSse(response);

      expect(brainAiToolCalls(fetchMock)).toHaveLength(1);
      expect(modelVisibleToolResult(fetchMock)).toEqual(brainResult);
    },
  );
});

describe('AI-tool partial lists', () => {
  it.each([
    [
      'list_segments',
      VALID_TOOL_RESULTS.list_segments,
      'Only the first 1 segments are shown; the store has more than 1.',
    ],
    [
      'list_campaigns',
      VALID_TOOL_RESULTS.list_campaigns,
      'Only the first 1 campaigns are shown; the store has more than 1.',
    ],
    [
      'get_store_config',
      VALID_TOOL_RESULTS.get_store_config,
      'Only the first 1 pages are shown in Pages; the store has more than 1.',
    ],
  ])(
    'tells the model a %s result holds only the first page',
    async (toolName, brainResult, notice) => {
      const fetchMock = workerFlow(
        versionOneValidation(toolName),
        [toolTurn(toolName), textTurn('Noted.')],
        jsonResponse(brainResult, { 'X-Ls-Has-More-Results': 'true' }),
      );

      const response = await worker.fetch(chatRequest(), ENV);
      await readWorkerSse(response);

      expect(modelVisibleToolResultBlocks(fetchMock)).toEqual([
        { type: 'text', text: JSON.stringify(brainResult) },
        { type: 'text', text: notice },
      ]);
    },
  );

  it('adds nothing when Brain says the list is complete', async () => {
    const fetchMock = workerFlow(
      versionOneValidation('list_segments'),
      [toolTurn('list_segments'), textTurn('Noted.')],
      jsonResponse(VALID_TOOL_RESULTS.list_segments, { 'X-Ls-Has-More-Results': 'false' }),
    );

    const response = await worker.fetch(chatRequest(), ENV);
    await readWorkerSse(response);

    expect(modelVisibleToolResult(fetchMock)).toEqual(VALID_TOOL_RESULTS.list_segments);
  });
});

function versionOneValidation(toolName: string): ContextValidation {
  return {
    SubscriberID: 7,
    SubscriberTitle: 'Test store',
    AiToolsContractVersion: 1,
    AvailableAiTools: [toolName],
  };
}

function workerFlow(
  validation: ContextValidation,
  anthropicTurns: Response[],
  brainResult: unknown | Response | Error = {},
): FetchMock {
  let anthropicCall = 0;
  return stubFetch().mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith('/v2/administrator-authentication/validate-context-id')) {
      return Promise.resolve(jsonResponse(validation));
    }
    if (url.endsWith('/v1/messages')) {
      const response = anthropicTurns[anthropicCall];
      anthropicCall += 1;
      if (!response) throw new Error(`missing Anthropic turn ${anthropicCall}`);
      return Promise.resolve(response);
    }
    if (url.includes('/v2/ai-tools/')) {
      if (brainResult instanceof Error) return Promise.reject(brainResult);
      return Promise.resolve(
        brainResult instanceof Response ? brainResult : jsonResponse(brainResult),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function chatRequest(): Request {
  return new Request('https://app-ai.test/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx-capabilities',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Help me with my store.' }] }),
  });
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function toolTurn(name: string): Response {
  return sseResponse([{ type: 'tool_use', id: `tool-${name}`, name, input: {} }], 'tool_use');
}

function textTurn(text: string): Response {
  return sseResponse([{ type: 'text', text }], 'end_turn');
}

function sseResponse(blocks: SseBlockSpec[], stopReason: string): Response {
  const lines: string[] = [];
  const push = (type: string, data: Record<string, unknown>) =>
    lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  lines.push(
    `event: message_start\ndata: ${JSON.stringify(anthropicMessageStart({ input_tokens: 10 }))}\n\n`,
  );
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      push('content_block_start', { index, content_block: { type: 'text' } });
      push('content_block_delta', {
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else {
      push('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name },
      });
      push('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      });
    }
    push('content_block_stop', { index });
  });
  push('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
  push('message_stop', {});
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sentToolNames(fetchMock: FetchMock): string[] {
  const messageIndex = fetchedUrls(fetchMock).findIndex((url) => url.endsWith('/v1/messages'));
  if (messageIndex < 0) throw new Error('no Anthropic request was made');
  return sentBody(fetchCall(fetchMock, messageIndex).init).tools?.map((tool) => tool.name) ?? [];
}

function brainAiToolCalls(fetchMock: FetchMock): string[] {
  return fetchedUrls(fetchMock).filter((url) => url.includes('/v2/ai-tools/'));
}

function modelVisibleToolResultBlocks(fetchMock: FetchMock): unknown {
  const messageIndexes = fetchedUrls(fetchMock)
    .map((url, index) => (url.endsWith('/v1/messages') ? index : -1))
    .filter((index) => index >= 0);
  const lastIndex = messageIndexes.at(-1);
  if (lastIndex === undefined) throw new Error('no Anthropic request was made');
  const lastMessage = sentBody(fetchCall(fetchMock, lastIndex).init).messages?.at(-1);
  const resultBlock = Array.isArray(lastMessage?.content) ? lastMessage.content[0] : undefined;
  if (!resultBlock) throw new Error('no model-visible tool result was sent');
  return resultBlock.content;
}

function modelVisibleToolResult(fetchMock: FetchMock): unknown {
  const messageIndexes = fetchedUrls(fetchMock)
    .map((url, index) => (url.endsWith('/v1/messages') ? index : -1))
    .filter((index) => index >= 0);
  const lastIndex = messageIndexes.at(-1);
  if (lastIndex === undefined) throw new Error('no Anthropic request was made');
  const lastMessage = sentBody(fetchCall(fetchMock, lastIndex).init).messages?.at(-1);
  const resultBlock = Array.isArray(lastMessage?.content) ? lastMessage.content[0] : undefined;
  if (typeof resultBlock?.content !== 'string') {
    throw new Error('no model-visible tool result was sent');
  }
  return JSON.parse(resultBlock.content) as unknown;
}
