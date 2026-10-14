import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleChat } from '../src/handlers/chat';
import { handleMessages } from '../src/handlers/messages';
import { chatUsageReport } from '../src/lib/brain-usage';
import { getSystemPrompt, listPromptNames } from '../src/prompt-registry';
import type { BackgroundTaskScheduler } from '../src/lib/logger';
import { createLoggingRuntime } from '../src/lib/logger';
import {
  anthropicMessage,
  AVAILABLE_AI_TOOLS,
  BRAIN_USAGE_REPORT_URL,
  brainUsageReports,
  CORS,
  ENV,
  stubFetch,
  type FetchMock,
} from './helpers';

const REQUEST_GUID = /^[0-9a-f-]{36}$/u;

function reportCalls(): RequestInit[] {
  return brainUsageReports.mock.calls.map(([input, init]) => {
    expect(String(input)).toBe(BRAIN_USAGE_REPORT_URL);
    return init ?? {};
  });
}

function reportBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function scheduledLogging(): {
  logging: ReturnType<typeof createLoggingRuntime>;
  settled: () => Promise<unknown>;
} {
  const tasks: Promise<unknown>[] = [];
  const schedule: BackgroundTaskScheduler = (task) => {
    tasks.push(task);
  };
  return {
    logging: createLoggingRuntime(ENV, schedule),
    settled: () => Promise.all(tasks),
  };
}

function providerJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function providerAndBrain(fetchMock: FetchMock, brainStatus = 200): void {
  brainUsageReports.mockImplementation(
    async () =>
      new Response(JSON.stringify({ Reached: false, UsedPercent: 1 }), { status: brainStatus }),
  );
  fetchMock.mockImplementation(async () => providerJson(ANSWER_TURN));
}

const TOOL_TURN = anthropicMessage(
  [{ type: 'tool_use', id: 'tu_1', name: 'get_store_analytics', input: {} }],
  {
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 900,
      output_tokens: 60,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 500,
    },
  },
);

const ANSWER_TURN = anthropicMessage([{ type: 'text', text: 'Hello' }], {
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 7,
  },
});

function toolLoop(fetchMock: FetchMock, answer: () => Response): void {
  const turns = [() => providerJson(TOOL_TURN), answer];
  fetchMock.mockImplementation(async (input) => {
    if (String(input).includes('/v2/ai-tools/')) {
      return providerJson({
        FromDate: '2026-01-01',
        ToDate: '2026-01-31',
        OrderCount: 12,
        TotalRevenue: 552,
        AverageOrderValue: 46,
        ConversionRate: 0.04,
        Currency: 'USD',
      });
    }
    const turn = turns.shift();
    if (!turn) throw new Error('the model was called more than twice');
    return turn();
  });
}

function passthroughAnswering(fetchMock: FetchMock, usage: unknown): void {
  const { usage: _complete, ...message } = anthropicMessage([{ type: 'text', text: 'Hello' }]);
  fetchMock.mockImplementation(async () =>
    providerJson(usage === undefined ? message : { ...message, usage }),
  );
}

function chatRequest(prompt: string): Request {
  return new Request('https://app-ai.test/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx-merchant',
      'X-Personalizer-System-Prompt': prompt,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
  });
}

function messagesRequest(prompt: string | null): Request {
  return new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx-merchant',
      ...(prompt ? { 'X-Personalizer-System-Prompt': prompt } : {}),
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: '{"store":{}}' }] }),
  });
}

describe('chat usage reports to Brain', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a Studio chat response after the reply, with the merchant context and the model', async () => {
    providerAndBrain(fetchMock);
    const { logging, settled } = scheduledLogging();

    const response = await handleChat(chatRequest('chat'), ENV, CORS, [], [], logging);
    expect(response.status).toBe(200);
    await settled();

    const [report, ...rest] = reportCalls();
    expect(rest).toEqual([]);
    expect(report?.method).toBe('POST');
    expect(new Headers(report?.headers).get('X-Personalizer-Context-ID')).toBe('ctx-merchant');
    expect(reportBody(report ?? {})).toEqual({
      RequestGuid: expect.stringMatching(REQUEST_GUID),
      PromptName: 'chat',
      Model: ENV.MODEL_FRONTIER,
      InputTokens: 1200,
      OutputTokens: 300,
      CacheReadTokens: 40,
      CacheWriteTokens: 7,
      WebSearchRequests: 0,
    });
  });

  it('reports every turn of a tool loop, each with its own tokens', async () => {
    toolLoop(fetchMock, () => providerJson(ANSWER_TURN));
    const { logging, settled } = scheduledLogging();

    const response = await handleChat(
      chatRequest('chat'),
      ENV,
      CORS,
      [],
      AVAILABLE_AI_TOOLS,
      logging,
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { iterations: number }).iterations).toBe(2);
    await settled();

    const reports = reportCalls().map(reportBody);
    expect(reports).toEqual([
      {
        RequestGuid: expect.stringMatching(REQUEST_GUID),
        PromptName: 'chat',
        Model: ENV.MODEL_FRONTIER,
        InputTokens: 900,
        OutputTokens: 60,
        CacheReadTokens: 0,
        CacheWriteTokens: 500,
        WebSearchRequests: 0,
      },
      {
        RequestGuid: expect.stringMatching(REQUEST_GUID),
        PromptName: 'chat',
        Model: ENV.MODEL_FRONTIER,
        InputTokens: 1200,
        OutputTokens: 300,
        CacheReadTokens: 40,
        CacheWriteTokens: 7,
        WebSearchRequests: 0,
      },
    ]);
    expect(reports[0]?.RequestGuid).not.toBe(reports[1]?.RequestGuid);
  });

  it('still reports the turn a tool loop completed when a later turn fails', async () => {
    toolLoop(fetchMock, () =>
      providerJson(
        { type: 'error', error: { type: 'invalid_request_error', message: 'Bad request' } },
        400,
      ),
    );
    const { logging, settled } = scheduledLogging();

    const response = await handleChat(
      chatRequest('chat'),
      ENV,
      CORS,
      [],
      AVAILABLE_AI_TOOLS,
      logging,
    );
    expect(response.status).toBe(400);
    await settled();

    expect(reportCalls().map(reportBody)).toEqual([
      expect.objectContaining({
        PromptName: 'chat',
        InputTokens: 900,
        OutputTokens: 60,
        CacheReadTokens: 0,
        CacheWriteTokens: 500,
      }),
    ]);
  });

  it('reports a conductor step on /messages', async () => {
    providerAndBrain(fetchMock);
    const { logging, settled } = scheduledLogging();

    await handleMessages(messagesRequest('optimize-bundles'), ENV, CORS, logging);
    await settled();

    const reports = reportCalls().map(reportBody);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ PromptName: 'optimize-bundles', Model: ENV.MODEL_BALANCED });
  });

  it('reports a Gemini response as Brain prices Gemini: the whole prompt as input, thinking as output, and no cache tokens', async () => {
    fetchMock.mockImplementation(async () =>
      providerJson({
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: '{"headline":"Offers"}' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 50,
          totalTokenCount: 1150,
          cachedContentTokenCount: 400,
          thoughtsTokenCount: 100,
        },
        modelVersion: 'gemini-3.5-flash-002',
        responseId: 'resp_usage',
      }),
    );
    const { logging, settled } = scheduledLogging();

    const response = await handleMessages(
      messagesRequest('optimize-bundles'),
      { ...ENV, MODEL_BALANCED: 'gemini-3.5-flash' },
      CORS,
      logging,
    );
    expect(response.status).toBe(200);
    await settled();

    const [report, ...rest] = reportCalls();
    expect(rest).toEqual([]);
    expect(reportBody(report ?? {})).toEqual({
      RequestGuid: expect.stringMatching(REQUEST_GUID),
      PromptName: 'optimize-bundles',
      Model: 'gemini-3.5-flash',
      InputTokens: 1000,
      OutputTokens: 150,
      CacheReadTokens: 0,
      CacheWriteTokens: 0,
      WebSearchRequests: 0,
    });
  });

  it('reports the unregistered passthrough under its own prompt name', async () => {
    providerAndBrain(fetchMock);
    const { logging, settled } = scheduledLogging();

    await handleMessages(messagesRequest(null), ENV, CORS, logging);
    await settled();

    expect(reportCalls().map(reportBody)).toEqual([
      expect.objectContaining({ PromptName: 'unregistered-messages', Model: ENV.MODEL_FAST }),
    ]);
  });

  it('fails an unregistered passthrough whose usage breaks the token-count contract, and reports nothing', async () => {
    const cases: [string, unknown][] = [
      ['no usage', undefined],
      ['a missing output count', { input_tokens: 1200 }],
      ['a count written as text', { input_tokens: '1200', output_tokens: 300 }],
      ['a negative count', { input_tokens: -1, output_tokens: 300 }],
      ['a fractional count', { input_tokens: 1200, output_tokens: 2.5 }],
    ];
    for (const [label, usage] of cases) {
      passthroughAnswering(fetchMock, usage);
      brainUsageReports.mockClear();
      const { logging, settled } = scheduledLogging();

      const response = await handleMessages(messagesRequest(null), ENV, CORS, logging);
      await settled();

      expect(response.status, label).toBe(500);
      expect(((await response.json()) as { ExceptionType: string }).ExceptionType, label).toBe(
        'AnthropicApiException',
      );
      expect(reportCalls(), label).toEqual([]);
    }
  });

  it('never reports the billing assistant', async () => {
    providerAndBrain(fetchMock);
    const { logging, settled } = scheduledLogging();

    await handleChat(chatRequest('billing-assistant'), ENV, CORS, [], [], logging);
    await settled();

    expect(reportCalls()).toEqual([]);
  });

  it('leaves only the billing assistant out of the store AI cap', () => {
    expect(
      listPromptNames().filter((name) => getSystemPrompt(name, ENV).excludedFromStoreAiCap),
    ).toEqual(['billing-assistant']);
  });

  it('never reports an audit session', async () => {
    providerAndBrain(fetchMock);
    const { logging, settled } = scheduledLogging();

    await handleMessages(messagesRequest('optimize-bundles'), ENV, CORS, logging, { audit: true });
    await settled();

    expect(reportCalls()).toEqual([]);
  });

  it('keeps the answer when Brain refuses the report, and sends it once', async () => {
    providerAndBrain(fetchMock, 400);
    const { logging, settled } = scheduledLogging();

    const response = await handleChat(chatRequest('chat'), ENV, CORS, [], [], logging);
    await settled();

    expect(response.status).toBe(200);
    expect(reportCalls()).toHaveLength(1);
  });

  it('counts cache reads apart from input for a provider that includes them in its input total and its thinking in its output', () => {
    const report = chatUsageReport({
      promptName: 'chat',
      model: 'gpt-5.6-luna',
      provider: 'openai',
      usage: {
        inputTokens: 1000,
        outputTokens: 50,
        cachedInputTokens: 400,
        cacheWriteInputTokens: null,
        reasoningTokens: 20,
      },
    });
    expect(report).toMatchObject({
      InputTokens: 600,
      OutputTokens: 50,
      CacheReadTokens: 400,
      CacheWriteTokens: 0,
    });
  });

  it('sends nothing for a response that reported no tokens', () => {
    expect(
      chatUsageReport({
        promptName: 'visual-verify',
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        usage: {
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          cacheWriteInputTokens: null,
          reasoningTokens: null,
        },
      }),
    ).toBeNull();
  });
});
