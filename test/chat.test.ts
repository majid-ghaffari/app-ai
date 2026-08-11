/**
 * Studio AI — app-ai chat agent-loop + SSE tests.
 *
 * These tests exercise the worker's /chat surface end to end against a
 * mocked Anthropic API + a mocked Brain AI-tool proxy, with NO real network.
 * Covers: prompt selection, single-shot streaming, the tool-use agent loop,
 * MAX_ITERATIONS, the SSE protocol, and the non-streaming JSON shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleChat, buildSystem } from '../src/handlers/chat';
import { composeToolsets } from '../src/toolsets/registry';
import { getSystemPrompt } from '../src/prompt-registry';
import type { EntityReference } from '../src/lib/references';
import type { Env } from '../src/config';
import { createLoggingRuntime } from '../src/lib/logger';
import {
  ENV,
  CORS,
  stubFetch,
  fetchCall,
  fetchedUrls,
  headerOf,
  sentBody,
  readWorkerSse,
  eventOf,
  type FetchMock,
} from './helpers';

// The /chat tool surface, composed through the registry exactly as the handler
// does for a subscriber with no third-party integration parties — just the
// always-active personalizer toolset.
const TOOL_DEFINITIONS = composeToolsets([], {
  contextId: 'ctx',
  env: ENV,
}).definitions;

/** Execute one tool through a fresh per-request composition (the registry path). */
const executeTool = (
  name: string,
  input: unknown,
  contextId: string,
  env: Env,
  refs: EntityReference[] = [],
) => composeToolsets([], { contextId, env }).execute(name, input, { refs });

interface SseBlockSpec {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Build an Anthropic-style SSE body from a list of content blocks. */
function anthropicSse(
  blocks: SseBlockSpec[],
  stopReason: string,
  startUsage: Record<string, number> = { input_tokens: 10 },
): string {
  // Real Anthropic SSE carries `type` inside the data JSON too (not just the
  // event: line). The worker switches on the data's `type`, so include it.
  const lines: string[] = [];
  const push = (type: string, data: Record<string, unknown>) =>
    lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  // Anthropic reports input + cache tokens on message_start; output on message_delta.
  push('message_start', { message: { usage: startUsage } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      push('content_block_start', { index, content_block: { type: 'text' } });
      push('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
      push('content_block_stop', { index });
    } else {
      push('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name },
      });
      push('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      });
      push('content_block_stop', { index });
    }
  });
  push('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
  push('message_stop', {});
  return lines.join('');
}

/** A Response whose body streams the given string as one chunk. */
function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function chatRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://app-ai.test/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx-123',
      Accept: 'text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('prompts module', () => {
  it('exposes the Studio system prompts', () => {
    for (const name of ['chat', 'onboarding', 'placement', 'image-selection']) {
      expect(getSystemPrompt(name, ENV).prompt.length).toBeGreaterThan(0);
    }
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getSystemPrompt('nope', ENV)).toThrow('System prompt not found: nope');
  });

  it('placement prompt instructs JSON-only output', () => {
    expect(getSystemPrompt('placement', ENV).prompt).toMatch(/ONLY a single JSON object/i);
  });

  it('chat prompt reasons over currentExperience grounding', () => {
    const prompt = getSystemPrompt('chat', ENV).prompt;
    expect(prompt).toMatch(/currentExperience/);
    // It must tell the model the snapshot carries the current appearance to reason over.
    expect(prompt).toMatch(/itemsPerPage/);
  });

  it('chat prompt documents the setAppearance directive + its whitelist', () => {
    const prompt = getSystemPrompt('chat', ENV).prompt;
    expect(prompt).toMatch(/setAppearance/);
    // The arg shape + the "2-up" mapping the merchant asks for.
    expect(prompt).toMatch(/"page"/);
    expect(prompt).toMatch(/"patch"/);
    expect(prompt).toMatch(/2-up/i);
    // The whitelisted keys agree with the lib-side contract.
    for (const key of ['Style', 'ItemsPerPage', 'ItemsLimit', 'ImageBorderRadius']) {
      expect(prompt).toContain(key);
    }
  });

  it('chat prompt documents the toggleBox directive (add/remove a box)', () => {
    const prompt = getSystemPrompt('chat', ENV).prompt;
    expect(prompt).toMatch(/toggleBox/);
    // The arg shape (page/box/on) + add/remove intent.
    expect(prompt).toMatch(/"box"/);
    expect(prompt).toMatch(/"on"/);
    expect(prompt).toMatch(/add or remove/i);
    // A couple of box-type keys the lib maps (agrees with ONBOARDING_BOX_TO_BRAIN).
    for (const key of ['BoughtTogether', 'RecentViews']) {
      expect(prompt).toContain(key);
    }
  });
});

describe('tool definitions', () => {
  it('declares the four data-query tools plus get_entity_context', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toEqual([
      'get_store_analytics',
      'list_segments',
      'list_campaigns',
      'get_store_config',
      'get_entity_context',
    ]);
  });

  it('get_entity_context carries the frozen input_schema', () => {
    const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === 'get_entity_context');
    if (!tool) throw new Error('get_entity_context definition missing');
    expect(tool.input_schema.required).toEqual(['type', 'id']);
    const properties = tool.input_schema.properties as {
      type: { enum: string[] };
      id: { type: string };
    };
    expect(properties.type.enum).toEqual([
      'campaign',
      'segment',
      'progress-bar',
      'bundle',
      'analytics-metric',
      'analytics-tab',
    ]);
    expect(properties.id.type).toBe('string');
  });
});

describe('executeTool', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the matching Brain AI-tool endpoint with the context-ID', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ AverageOrderValue: 46.0, Currency: 'USD', OrderCount: 12 }), {
        status: 200,
      }),
    );

    const out = await executeTool('get_store_analytics', { fromDate: '2026-01-01' }, 'ctx-9', ENV);
    expect(out.ok).toBe(true);
    expect((out.result as { AverageOrderValue: number }).AverageOrderValue).toBe(46.0);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://brain.test/v2/ai-tools/store-analytics?fromDate=2026-01-01');
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBe('ctx-9');
  });

  it('returns ok:false (not throw) when Brain fails', async () => {
    stubFetch().mockResolvedValue(new Response('boom', { status: 500 }));
    const out = await executeTool('list_segments', {}, 'ctx', ENV);
    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toMatch(/failed/i);
  });

  it('rejects an unknown tool', async () => {
    const out = await executeTool('nope', {}, 'ctx', ENV);
    expect(out.ok).toBe(false);
  });
});

describe('executeTool — get_entity_context dispatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const CAMPAIGN_GUID = '11111111-2222-3333-4444-555555555555';
  const SUB_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('record type → per-record Brain routes with the context-ID header, normalized result', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v2/accounts/subscriber')) {
        return Promise.resolve(
          new Response(JSON.stringify({ Guid: SUB_GUID, CurrencyCode: 'USD' }), { status: 200 }),
        );
      }
      if (u.includes('/v2/discount-campaigns/discount-campaign/')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Guid: CAMPAIGN_GUID,
              SubscriberGuid: SUB_GUID,
              Title: 'Summer Sale',
              Status: 'Active',
              DiscountTarget: 'Bundle',
              DiscountType: 'Percentage',
              DiscountPercentage: 15,
              StartDate: '2026-05-01T00:00:00',
              UserSegmentGuids: [],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('Not Found', { status: 404 }));
    });

    const out = await executeTool(
      'get_entity_context',
      { type: 'campaign', id: CAMPAIGN_GUID },
      'ctx-9',
      ENV,
    );
    expect(out.ok).toBe(true);
    const result = out.result as { Found: boolean; Title: string; Kind: string };
    expect(result.Found).toBe(true);
    expect(result.Title).toBe('Summer Sale');
    expect(result.Kind).toBe('discount');
    expect(out.summary).toBe('campaign: Summer Sale');
    const urls = fetchedUrls(fetchMock);
    expect(urls).toEqual([
      'https://brain.test/v2/accounts/subscriber',
      `https://brain.test/v2/discount-campaigns/discount-campaign/${CAMPAIGN_GUID}`,
    ]);
    for (let call = 0; call < fetchMock.mock.calls.length; call++) {
      expect(headerOf(fetchCall(fetchMock, call).init, 'X-Personalizer-Context-ID')).toBe('ctx-9');
    }
    // The forwarded context-ID is the auth — no validation roundtrip in here.
    expect(urls.some((u) => u.includes('validate-context-id'))).toBe(false);
  });

  it('record type + Brain 500 → ok:false (not thrown), same error shape as the other tools', async () => {
    stubFetch().mockResolvedValue(new Response('boom', { status: 500 }));
    const out = await executeTool(
      'get_entity_context',
      { type: 'segment', id: CAMPAIGN_GUID },
      'ctx',
      ENV,
    );
    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toMatch(/failed/i);
  });

  it('analytics type resolves from the request refs by category path — NO Brain call', async () => {
    const fetchMock = stubFetch();

    const refs: EntityReference[] = [
      {
        type: 'analytics-metric',
        label: 'AOV',
        metadata: { tab: 'overview', period: '30', metricKey: 'aov-opportunity', value: 42 },
      },
    ];
    const out = await executeTool(
      'get_entity_context',
      { type: 'analytics-metric', id: 'analytics/overview/aov-opportunity' },
      'ctx',
      ENV,
      refs,
    );
    expect(out.ok).toBe(true);
    expect(out.result).toEqual(refs[0]?.metadata);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('analytics type falls back to the first ref of the matching type', async () => {
    stubFetch();
    const refs: EntityReference[] = [
      { type: 'analytics-tab', metadata: { tab: 'overview', period: '30' } },
    ];
    const out = await executeTool(
      'get_entity_context',
      { type: 'analytics-tab', id: 'analytics/some-other-path' },
      'ctx',
      ENV,
      refs,
    );
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ tab: 'overview', period: '30' });
  });

  it('analytics type with no matching ref → ok:false, NO Brain call', async () => {
    const fetchMock = stubFetch();
    const out = await executeTool(
      'get_entity_context',
      { type: 'analytics-tab', id: 'analytics/overview' },
      'ctx',
      ENV,
      [],
    );
    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe(
      'analytics reference not attached to this request',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('handleChat — streaming', () => {
  afterEach(() => vi.restoreAllMocks());

  it('streams a plain text turn then done', async () => {
    stubFetch().mockResolvedValue(
      sseResponse(anthropicSse([{ type: 'text', text: 'Hello there' }], 'end_turn')),
    );

    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);
    const texts = events.filter((e) => e.type === 'text').map((e) => e.data.delta);
    expect(texts.join('')).toBe('Hello there');
    const done = eventOf(events, 'done');
    expect(done.data.text).toBe('Hello there');
    expect(done.data.stopReason).toBe('end_turn');
    expect(done.data.iterations).toBe(1);
  });

  it('emits correlated model-turn input/output events when TRACE routes to console', async () => {
    const logSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    stubFetch().mockResolvedValue(
      sseResponse(anthropicSse([{ type: 'text', text: 'CAD is active' }], 'end_turn')),
    );

    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'check CAD' }] }),
      ENV,
      CORS,
      [],
      createLoggingRuntime({ ...ENV, LOG_TARGETS_TRACE: 'console' }),
    );
    await readWorkerSse(res);

    const traceEvents = logSpy.mock.calls
      .filter((call) => call[0] === '[InferenceTrace]')
      .map((call) => call[2] as Record<string, unknown>);
    expect(traceEvents.map((event) => event.event)).toEqual([
      'request.forwarded',
      'response.received',
      'request.completed',
    ]);
    expect(JSON.stringify(traceEvents[0])).toContain('check CAD');
    expect(JSON.stringify(traceEvents[1])).toContain('CAD is active');
    expect(new Set(traceEvents.map((event) => event.traceId)).size).toBe(1);
  });

  it('logs cache-hit token stats for the model turn (input/cache_creation/cache_read/output)', async () => {
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    stubFetch().mockResolvedValue(
      sseResponse(
        anthropicSse([{ type: 'text', text: 'cached reply' }], 'end_turn', {
          input_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 340,
        }),
      ),
    );

    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      ENV,
      CORS,
      [],
      createLoggingRuntime({ ...ENV, LOG_TARGETS_INFO: 'console' }),
    );
    await readWorkerSse(res);

    // Mirrors the /messages `logUsageStats` line — [Chat] scope + all four counts.
    const usageLine = logSpy.mock.calls.find(
      (call) => typeof call[1] === 'string' && call[1].startsWith('Tokens —'),
    );
    if (!usageLine) throw new Error('no [Chat] Tokens usage line was logged');
    expect(usageLine[0]).toBe('[Chat]');
    expect(usageLine[1]).toBe('Tokens — input: 12, cache_creation: 0, cache_read: 340, output: 5');
  });

  it('runs the tool-use loop: tool_call → Brain → tool_result → final text', async () => {
    const anthropicTurn1 = anthropicSse(
      [{ type: 'tool_use', id: 'tu_1', name: 'get_store_analytics', input: {} }],
      'tool_use',
    );
    const anthropicTurn2 = anthropicSse([{ type: 'text', text: 'Your AOV is $46.' }], 'end_turn');
    const fetchMock = stubFetch();
    fetchMock
      // turn 1: Anthropic asks for the tool
      .mockResolvedValueOnce(sseResponse(anthropicTurn1))
      // Brain AI-tool proxy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ AverageOrderValue: 46 }), { status: 200 }),
      )
      // turn 2: Anthropic final text
      .mockResolvedValueOnce(sseResponse(anthropicTurn2));

    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'what is my AOV?' }] }),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);

    expect(eventOf(events, 'tool_call').data.name).toBe('get_store_analytics');
    expect(eventOf(events, 'tool_result').data.ok).toBe(true);
    const done = eventOf(events, 'done');
    expect(done.data.text).toContain('$46');
    expect(done.data.iterations).toBe(2);

    // The Brain call was made server→server with the context-ID.
    const brainCallIndex = fetchedUrls(fetchMock).findIndex((u) => u.includes('/v2/ai-tools/'));
    expect(brainCallIndex).toBeGreaterThanOrEqual(0);
    const { init } = fetchCall(fetchMock, brainCallIndex);
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBe('ctx-123');
  });

  it('caps the loop at MAX_ITERATIONS when the model keeps calling tools', async () => {
    // Every Anthropic turn asks for a tool; Brain always answers.
    stubFetch().mockImplementation((url) => {
      if (String(url).includes('/v2/ai-tools/')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(
        sseResponse(
          anthropicSse(
            [{ type: 'tool_use', id: 'tu', name: 'list_segments', input: {} }],
            'tool_use',
          ),
        ),
      );
    });

    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'loop' }] }),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);
    const done = eventOf(events, 'done');
    expect(done.data.stopReason).toBe('max_iterations');
    expect(done.data.iterations).toBe(8);
  });

  it('placement prompt runs without tools and yields JSON text', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      sseResponse(
        anthropicSse(
          [
            {
              type: 'text',
              text: '{"reply":"Place Most Popular after the hero.","proposals":[{"box":"Most Popular","page":"Home","candidateIndex":0,"position":"after"}]}',
            },
          ],
          'end_turn',
        ),
      ),
    );

    const res = await handleChat(
      chatRequest(
        {
          messages: [{ role: 'user', content: 'place a box' }],
          context: { hostPage: 'Home', candidates: [{ index: 0, label: 'Hero' }] },
        },
        { 'X-Personalizer-System-Prompt': 'placement' },
      ),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);
    const done = eventOf(events, 'done');
    const parsed = JSON.parse(String(done.data.text)) as {
      proposals: Array<{ box: string }>;
    };
    expect(parsed.proposals[0]?.box).toBe('Most Popular');

    // No tools were sent on the placement request.
    expect(sentBody(fetchCall(fetchMock, 0).init).tools).toBeUndefined();
  });

  // CLIENT-tool mode (#111): a `clientTools` prompt (`onboarding-chat`, carrying the
  // `look_at_page` client tool) runs the loop in CLIENT-tool mode — on a tool_use the
  // loop returns the calls in `done.toolCalls` and STOPS (the browser runs them, not
  // the worker), rather than executing a tool + looping like the server-tool path.
  it('onboarding-chat clientTools mode: a look_at_page tool_use returns done.toolCalls + stops, no server tool call', async () => {
    const fetchMock = stubFetch();
    // ONE Anthropic turn that asks for the client tool. There must be NO second
    // Anthropic turn and NO Brain tool call — the loop stops here and hands off.
    fetchMock.mockResolvedValue(
      sseResponse(
        anthropicSse(
          [{ type: 'tool_use', id: 'tu_look', name: 'look_at_page', input: { page: 'Home' } }],
          'tool_use',
        ),
      ),
    );

    const res = await handleChat(
      chatRequest(
        { messages: [{ role: 'user', content: 'does the Home page look right?' }] },
        { 'X-Personalizer-System-Prompt': 'onboarding-chat' },
      ),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);

    // The done payload carries the client tool-call(s), stop_reason 'tool_use', and
    // stops after ONE iteration — the worker never executed the tool.
    const done = eventOf(events, 'done');
    expect(done.data.stopReason).toBe('tool_use');
    expect(done.data.iterations).toBe(1);
    const toolCalls = done.data.toolCalls;
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0]?.name).toBe('look_at_page');
    expect((toolCalls?.[0]?.input as { page?: string }).page).toBe('Home');

    // The client tool is surfaced as a `tool_call` event, and NO `tool_result` event
    // is emitted (the worker did not execute it — the browser will).
    expect(eventOf(events, 'tool_call').data.name).toBe('look_at_page');
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);

    // Exactly ONE fetch (the single Anthropic turn) — no Brain `/v2/ai-tools/` call.
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(fetchedUrls(fetchMock).some((u) => u.includes('/v2/ai-tools/'))).toBe(false);

    // The tools SENT to Anthropic were the CLIENT tool (look_at_page), NOT the server
    // toolset — client tools are sent in place of the server toolset.
    const sentTools = sentBody(fetchCall(fetchMock, 0).init).tools;
    expect(sentTools?.map((t) => t.name)).toEqual(['look_at_page']);
  });

  it('emits a Brain-shaped error event when Anthropic fails', async () => {
    stubFetch().mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);
    const err = eventOf(events, 'error');
    // SSE error events carry the same { Message, ExceptionType, MessageDetail? }
    // payload as HTTP error bodies — one parser client-side.
    expect(err.data.Message).toMatch(/Anthropic request failed \(500\)/);
    expect(err.data.ExceptionType).toBe('AnthropicApiException');
    expect(err.data.MessageDetail).toBe('nope');
    expect(err.data.message).toBeUndefined();
  });

  it('rejects an empty message list with a Brain-shaped ArgumentException error event', async () => {
    const res = await handleChat(chatRequest({ messages: [] }), ENV, CORS);
    const events = await readWorkerSse(res);
    const err = eventOf(events, 'error');
    expect(err.data.Message).toMatch(/non-empty/i);
    expect(err.data.ExceptionType).toBe('ArgumentException');
    expect(err.data.MessageDetail).toBeUndefined();
  });
});

describe('handleChat — non-streaming JSON', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a single JSON object identical to the done payload', async () => {
    stubFetch().mockResolvedValue(
      sseResponse(anthropicSse([{ type: 'text', text: 'Hi' }], 'end_turn')),
    );
    const req = chatRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { Accept: 'application/json' },
    );
    const res = await handleChat(req, ENV, CORS);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const json = (await res.json()) as { text: string; stopReason: string };
    expect(json.text).toBe('Hi');
    expect(json.stopReason).toBe('end_turn');
  });

  it('returns the Brain-shaped error body with the upstream status when Anthropic fails', async () => {
    stubFetch().mockResolvedValue(new Response('overloaded', { status: 529 }));
    const req = chatRequest(
      { messages: [{ role: 'user', content: 'hi' }] },
      { Accept: 'application/json' },
    );
    const res = await handleChat(req, ENV, CORS);
    expect(res.status).toBe(529);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.Message).toMatch(/Anthropic request failed \(529\)/);
    expect(json.ExceptionType).toBe('AnthropicApiException');
    expect(json.MessageDetail).toBe('overloaded');
    expect(json.error).toBeUndefined();
  });

  it('rejects a bad body with a 400 Brain-shaped ArgumentException', async () => {
    const req = chatRequest({ messages: [] }, { Accept: 'application/json' });
    const res = await handleChat(req, ENV, CORS);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.Message).toMatch(/non-empty/i);
    expect(json.ExceptionType).toBe('ArgumentException');
  });
});

describe('handleChat — context.refs (Referenced Entities)', () => {
  afterEach(() => vi.restoreAllMocks());

  const SUB_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const CAMPAIGN_GUID = '11111111-2222-3333-4444-555555555555';
  const SEGMENT_GUID = '99999999-8888-7777-6666-555555555555';
  const DEAD_GUID = '00000000-0000-0000-0000-00000000dead';

  const SUBSCRIBER = { Guid: SUB_GUID, CurrencyCode: 'USD' };
  const DISCOUNT = {
    Guid: CAMPAIGN_GUID,
    SubscriberGuid: SUB_GUID,
    Title: 'Summer Sale',
    Status: 'Active',
    DiscountTarget: 'Bundle',
    DiscountType: 'Percentage',
    DiscountPercentage: 12.5,
    StartDate: '2026-05-01T00:00:00',
    UserSegmentGuids: [],
  };
  const SEGMENT = {
    Guid: SEGMENT_GUID,
    SubscriberGuid: SUB_GUID,
    Title: 'VIP Customers',
    Status: 'Active',
    Deleted: false,
    CreationDate: '2026-01-15T10:00:00',
  };

  const oneTextTurn = () => sseResponse(anthropicSse([{ type: 'text', text: 'ok' }], 'end_turn'));

  /** fetch mock: Brain record endpoints → fixtures; everything else → one text turn. */
  function mockFetch(): FetchMock {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/v2/accounts/subscriber')) {
        return Promise.resolve(new Response(JSON.stringify(SUBSCRIBER), { status: 200 }));
      }
      if (u.includes('/v2/discount-campaigns/discount-campaign/')) {
        return Promise.resolve(new Response(JSON.stringify(DISCOUNT), { status: 200 }));
      }
      if (u.includes('/v1/subscriberSegment?guid=')) {
        const guid = u.split('guid=')[1]?.split('&')[0];
        return Promise.resolve(
          new Response(JSON.stringify({ ...SEGMENT, Guid: guid }), { status: 200 }),
        );
      }
      return Promise.resolve(oneTextTurn());
    });
    return fetchMock;
  }

  const brainCalls = (fetchMock: FetchMock, match: string) =>
    fetchedUrls(fetchMock).filter((u) => u.includes(match));
  const anthropicBody = (fetchMock: FetchMock) => {
    const index = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
    if (index < 0) throw new Error('no /v1/messages call was made');
    return sentBody(fetchCall(fetchMock, index).init);
  };

  it('prefetches each record ref from Brain and appends the block as the LAST uncached system block', async () => {
    const fetchMock = mockFetch();

    const res = await handleChat(
      chatRequest({
        messages: [{ role: 'user', content: 'hi' }],
        context: {
          hostPage: 'Home',
          refs: [
            { type: 'campaign', id: CAMPAIGN_GUID, label: 'Summer Sale' },
            {
              type: 'analytics-tab',
              label: 'Overview',
              metadata: { tab: 'overview', period: '30' },
            },
          ],
        },
      }),
      ENV,
      CORS,
    );
    await res.text();

    // Eager prefetch: the record ref resolves via the subscriber + discount
    // endpoints (analytics never hits Brain), forwarding the merchant's context-ID.
    const prefetches = brainCalls(fetchMock, '/v2/discount-campaigns/discount-campaign/');
    expect(prefetches).toEqual([
      `https://brain.test/v2/discount-campaigns/discount-campaign/${CAMPAIGN_GUID}`,
    ]);
    const prefetchIndex = fetchedUrls(fetchMock).findIndex((u) =>
      u.includes('/v2/discount-campaigns/discount-campaign/'),
    );
    expect(headerOf(fetchCall(fetchMock, prefetchIndex).init, 'X-Personalizer-Context-ID')).toBe(
      'ctx-123',
    );
    expect(brainCalls(fetchMock, '/v2/accounts/subscriber')).toHaveLength(1);

    // System array shape: [ registry (1h-cached), context (uncached), refs block (uncached, LAST) ].
    const sent = anthropicBody(fetchMock);
    expect(sent.system).toHaveLength(3);
    expect(sent.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(sent.system?.[1]?.cache_control).toBeUndefined();
    const refsBlock = sent.system?.[2];
    if (!refsBlock?.text) throw new Error('refs block missing');
    expect(refsBlock.cache_control).toBeUndefined();
    expect(refsBlock.text.startsWith('## Referenced Entities\n')).toBe(true);
    expect(refsBlock.text).toContain(
      `- [campaign] "Summer Sale" (id ${CAMPAIGN_GUID}): ` +
        `{"Type":"campaign","Id":"${CAMPAIGN_GUID}","Found":true,"Title":"Summer Sale"`,
    );
    expect(refsBlock.text).toContain(
      '- [analytics-tab] "Overview" (analytics/overview): {"tab":"overview","period":"30"}',
    );
    // Cache safety: exactly ONE cached system block (the registry prompt).
    expect(sent.system?.filter((b) => b.cache_control).length).toBe(1);
  });

  it('no refs → NO block and a system array byte-identical to buildSystem without refs', async () => {
    const fetchMock = mockFetch();
    const context = { hostPage: 'Home' };
    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }], context }),
      ENV,
      CORS,
    );
    await res.text();

    expect(brainCalls(fetchMock, 'brain.test')).toHaveLength(0);
    const sent = anthropicBody(fetchMock);
    expect(JSON.stringify(sent.system)).toBe(
      JSON.stringify(buildSystem(getSystemPrompt('chat', ENV), context)),
    );
  });

  it('caps intake at 5 refs — only the first five are prefetched', async () => {
    const fetchMock = mockFetch();
    const guids = Array.from(
      { length: 7 },
      (_unused, i) => `00000000-0000-0000-0000-00000000000${i}`,
    );
    const refs = guids.map((id) => ({ type: 'segment', id }));
    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'hi' }], context: { refs } }),
      ENV,
      CORS,
    );
    await res.text();

    const prefetches = brainCalls(fetchMock, '/v1/subscriberSegment?guid=');
    expect(prefetches).toEqual(
      guids.slice(0, 5).map((id) => `https://brain.test/v1/subscriberSegment?guid=${id}`),
    );
    // One shared subscriber lookup for the whole block build.
    expect(brainCalls(fetchMock, '/v2/accounts/subscriber')).toHaveLength(1);
  });

  it('a failed prefetch degrades that ref to "(could not load)" — the reply still streams', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.includes(`guid=${DEAD_GUID}`)) {
        return Promise.reject(new Error('network down'));
      }
      if (u.includes('/v2/accounts/subscriber')) {
        return Promise.resolve(new Response(JSON.stringify(SUBSCRIBER), { status: 200 }));
      }
      if (u.includes('/v1/subscriberSegment?guid=')) {
        return Promise.resolve(new Response(JSON.stringify(SEGMENT), { status: 200 }));
      }
      return Promise.resolve(oneTextTurn());
    });

    const res = await handleChat(
      chatRequest({
        messages: [{ role: 'user', content: 'hi' }],
        context: {
          refs: [
            { type: 'segment', id: DEAD_GUID, label: 'Dead' },
            { type: 'segment', id: SEGMENT_GUID, label: 'Live' },
          ],
        },
      }),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);
    expect(eventOf(events, 'done')).toBeTruthy();
    expect(events.find((e) => e.type === 'error')).toBeUndefined();

    const refsBlock = anthropicBody(fetchMock).system?.at(-1)?.text ?? '';
    expect(refsBlock).toContain(`- [segment] "Dead" (id ${DEAD_GUID}): (could not load)`);
    expect(refsBlock).toContain(
      `- [segment] "Live" (id ${SEGMENT_GUID}): {"Type":"segment","Id":"${SEGMENT_GUID}","Found":true`,
    );
  });

  it('threads refs into the agent loop: analytics get_entity_context resolves with NO Brain call', async () => {
    const toolTurn = anthropicSse(
      [
        {
          type: 'tool_use',
          id: 'tu_ref',
          name: 'get_entity_context',
          input: { type: 'analytics-metric', id: 'analytics/overview/aov-opportunity' },
        },
      ],
      'tool_use',
    );
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(sseResponse(toolTurn)).mockResolvedValueOnce(oneTextTurn());

    const res = await handleChat(
      chatRequest({
        messages: [{ role: 'user', content: 'tell me more' }],
        context: {
          refs: [
            {
              type: 'analytics-metric',
              label: 'AOV',
              metadata: { tab: 'overview', period: '30', metricKey: 'aov-opportunity' },
            },
          ],
        },
      }),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);

    const toolResult = eventOf(events, 'tool_result');
    expect(toolResult.data.name).toBe('get_entity_context');
    expect(toolResult.data.ok).toBe(true);
    // The ONLY fetches are the two Anthropic turns — no Brain call at all.
    expect(fetchedUrls(fetchMock).every((u) => u.endsWith('/v1/messages'))).toBe(true);
  });

  it('agent-loop get_entity_context Brain 500 → tool_result is_error fed back, not thrown', async () => {
    const toolTurn = anthropicSse(
      [
        {
          type: 'tool_use',
          id: 'tu_ec',
          name: 'get_entity_context',
          input: { type: 'campaign', id: CAMPAIGN_GUID },
        },
      ],
      'tool_use',
    );
    let anthropicCall = 0;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      if (String(url).includes('brain.test')) {
        return Promise.resolve(new Response('boom', { status: 500 }));
      }
      anthropicCall += 1;
      return Promise.resolve(anthropicCall === 1 ? sseResponse(toolTurn) : oneTextTurn());
    });

    const res = await handleChat(
      chatRequest({ messages: [{ role: 'user', content: 'detail?' }] }),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(eventOf(events, 'tool_result').data.ok).toBe(false);
    // The follow-up Anthropic call carries the tool_result with is_error: true.
    const messageCallIndexes = fetchedUrls(fetchMock)
      .map((u, i) => (u.endsWith('/v1/messages') ? i : -1))
      .filter((i) => i >= 0);
    const lastMessagesCall = messageCallIndexes.at(-1);
    if (lastMessagesCall === undefined) throw new Error('no /v1/messages call');
    const secondBody = sentBody(fetchCall(fetchMock, lastMessagesCall).init);
    const lastMessage = secondBody.messages?.at(-1);
    const resultBlock = Array.isArray(lastMessage?.content) ? lastMessage.content[0] : undefined;
    expect(resultBlock?.type).toBe('tool_result');
    expect(resultBlock?.is_error).toBe(true);
  });
});
