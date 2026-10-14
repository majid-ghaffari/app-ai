/**
 * EXACT registry max_tokens (D6) — the registry is authoritative for a registered
 * prompt's output budget. Proves the outgoing Anthropic request's `max_tokens` is
 * EXACTLY the resolved registry entry's `maxTokens`, with NO floor, NO cap, and NO
 * client override:
 *   • /messages (header-selected propose + review prompts): the wire value equals
 *     `getSystemPrompt(name).maxTokens` whether the caller omitted `max_tokens`,
 *     sent a SMALLER one (old floor path), or sent a LARGER one (would-be cap);
 *   • the concrete literals — every conductor prompt carries its model's documented
 *     maximum output: 128000 for the balanced-tier claude-sonnet-5 routes and 64000
 *     for the fast-tier claude-haiku-4-5 QC gate — so a change to a registry value
 *     changes the wire one-for-one and no smaller guessed budget survives;
 *   • /chat (placement) uses the registry `maxTokens` exactly, overriding a
 *     client-sent budget.
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import type { Env } from '../src/config';
import { handleMessages } from '../src/handlers/messages';
import { handleChat } from '../src/handlers/chat';
import {
  anthropicMessage,
  anthropicMessageStart,
  ENV,
  CORS,
  stubFetch,
  fetchCall,
  fetchedUrls,
  sentBody,
} from './helpers';

afterEach(() => vi.restoreAllMocks());

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

/** Fire /messages for a header-selected prompt; return the Anthropic request body. */
async function messagesBody(
  systemPrompt: string,
  body: Record<string, unknown>,
  env: Env = ENV,
): Promise<ReturnType<typeof sentBody>> {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation(async () => jsonOk(anthropicMessage()));
  const req = new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx',
      'X-Personalizer-System-Prompt': systemPrompt,
      // The onboarding routes enforce the ruleset handshake; supply the matching
      // header so the request reaches Anthropic (the version is not what's tested).
      'X-Personalizer-Ruleset-Version': getSystemPrompt(systemPrompt, env).rulesetVersion ?? '',
    },
    body: JSON.stringify(body),
  });
  await handleMessages(req, env, CORS);
  const idx = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
  if (idx < 0) throw new Error('no /v1/messages call was made');
  return sentBody(fetchCall(fetchMock, idx).init);
}

// The propose + review routes the D6 exactness contract must cover, with their
// concrete registry literals. Reading these off `getSystemPrompt` too would hide a
// typo, so the literals are pinned HERE and the registry is asserted to match.
const EXACT_ROUTES: Array<{ name: string; maxTokens: number; kind: 'propose' | 'review' }> = [
  { name: 'onboarding-batch', maxTokens: 128000, kind: 'propose' },
  { name: 'onboarding-batch-all', maxTokens: 128000, kind: 'propose' },
  { name: 'onboarding-review', maxTokens: 128000, kind: 'review' },
  { name: 'onboarding-review-all', maxTokens: 128000, kind: 'review' },
  { name: 'onboarding-review-gate-all', maxTokens: 64000, kind: 'review' },
  { name: 'onboarding-css-review', maxTokens: 128000, kind: 'review' },
  { name: 'onboarding-currency-recovery', maxTokens: 128000, kind: 'review' },
  { name: 'cartdrawer-batch-all', maxTokens: 128000, kind: 'propose' },
  { name: 'cartdrawer-review-all', maxTokens: 128000, kind: 'review' },
  { name: 'optimize-demand', maxTokens: 128000, kind: 'propose' },
  { name: 'optimize-boxes', maxTokens: 128000, kind: 'propose' },
  { name: 'optimize-ads-audiences', maxTokens: 128000, kind: 'propose' },
  { name: 'optimize-progress-bar', maxTokens: 128000, kind: 'propose' },
  { name: 'optimize-bundles', maxTokens: 128000, kind: 'propose' },
];

describe('registry max_tokens is EXACT on /messages (no floor, no cap, no client read)', () => {
  it('the registry literals are what the routes declare (pins the source values)', () => {
    for (const { name, maxTokens } of EXACT_ROUTES) {
      expect(getSystemPrompt(name, ENV).maxTokens).toBe(maxTokens);
    }
    expect(getSystemPrompt('onboarding-batch-all', ENV).maxTokens).toBe(128000);
    expect(getSystemPrompt('onboarding-review-all', ENV).maxTokens).toBe(128000);
  });

  for (const { name, maxTokens } of EXACT_ROUTES) {
    it(`${name}: omitted max_tokens → sends exactly ${maxTokens}`, async () => {
      const sent = await messagesBody(name, {
        messages: [{ role: 'user', content: 'go' }],
      });
      expect(sent.max_tokens).toBe(maxTokens);
      expect(sent.max_tokens).toBe(getSystemPrompt(name, ENV).maxTokens);
    });

    it(`${name}: a SMALLER client max_tokens is raised to exactly ${maxTokens} (fill, not floor-once)`, async () => {
      const sent = await messagesBody(name, {
        max_tokens: 16,
        messages: [{ role: 'user', content: 'go' }],
      });
      expect(sent.max_tokens).toBe(maxTokens);
    });

    it(`${name}: a LARGER client max_tokens is OVERRIDDEN down to exactly ${maxTokens} (no cap kept, no floor)`, async () => {
      const sent = await messagesBody(name, {
        max_tokens: 100000,
        messages: [{ role: 'user', content: 'go' }],
      });
      // The OLD floor behavior (Math.max) would have kept 100000; exact-registry
      // overrides it. This is the load-bearing "no floor" proof.
      expect(sent.max_tokens).toBe(maxTokens);
      expect(sent.max_tokens).not.toBe(100000);
    });
  }

  it('no hidden 4096 default survives for a conductor route (onboarding-review sends 128000, not 4096)', async () => {
    const sent = await messagesBody('onboarding-review', {
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(sent.max_tokens).toBe(128000);
  });
});

describe("a conductor prompt's budget is its selected model's maximum output", () => {
  const routedTo = (routes: string): Env => ({
    ...ENV,
    MODEL_OVERRIDES: `${ENV.MODEL_OVERRIDES},${routes}`,
  });

  it('follows a settings-only route change to a model with a lower limit', async () => {
    const env = routedTo('onboarding-visual=claude-sonnet-4-5');
    expect(getSystemPrompt('onboarding-batch-all', env).maxTokens).toBe(64000);
    const sent = await messagesBody(
      'onboarding-batch-all',
      { messages: [{ role: 'user', content: 'go' }] },
      env,
    );
    expect(sent.model).toBe('claude-sonnet-4-5');
    expect(sent.max_tokens).toBe(64000);
  });

  it('resolves every catalogued generation the route can select', () => {
    expect(getSystemPrompt('onboarding-review-all', ENV).maxTokens).toBe(128000);
    expect(
      getSystemPrompt('onboarding-review-all', routedTo('onboarding-review-all=claude-opus-4-5'))
        .maxTokens,
    ).toBe(64000);
    expect(
      getSystemPrompt('onboarding-review-all', routedTo('onboarding-review-all=claude-opus-4-8'))
        .maxTokens,
    ).toBe(128000);
    expect(
      getSystemPrompt(
        'onboarding-review-all',
        routedTo('onboarding-visual=gpt-5.2,onboarding-qc-gate=gpt-5.2'),
      ).maxTokens,
    ).toBe(128000);
    expect(
      getSystemPrompt(
        'onboarding-review-gate-all',
        routedTo('onboarding-visual=gemini-3-pro,onboarding-qc-gate=gemini-3-pro'),
      ).maxTokens,
    ).toBe(65536);
  });

  it('fails before provider I/O on a model whose maximum output is not recorded', () => {
    expect(() =>
      getSystemPrompt(
        'onboarding-batch-all',
        routedTo('onboarding-visual=gpt-4.1,onboarding-qc-gate=gpt-4.1'),
      ),
    ).toThrow(/No maximum output is recorded for model "gpt-4\.1"/);
  });

  it('leaves a fixed budget fixed whatever the route selects', () => {
    expect(
      getSystemPrompt('probe-currency', routedTo('onboarding-visual=claude-sonnet-4-5')).maxTokens,
    ).toBe(512);
  });
});

describe('registry max_tokens is EXACT on /chat (placement overrides the client budget)', () => {
  const ONE_TURN_SSE =
    `event: message_start\ndata: ${JSON.stringify(anthropicMessageStart())}\n\n` +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const sseResponse = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ONE_TURN_SSE));
          controller.close();
        },
      }),
      { status: 200 },
    );

  async function chatBody(extra: Record<string, unknown>): Promise<ReturnType<typeof sentBody>> {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(sseResponse());
    const req = new Request('https://app-ai.test/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': 'placement',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }], ...extra }),
    });
    await (await handleChat(req, ENV, CORS)).text();
    const idx = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
    if (idx < 0) throw new Error('no /v1/messages call was made');
    return sentBody(fetchCall(fetchMock, idx).init);
  }

  it('placement omitted → sends exactly the registry value', async () => {
    const sent = await chatBody({});
    expect(sent.max_tokens).toBe(getSystemPrompt('placement', ENV).maxTokens);
    expect(sent.max_tokens).toBe(2048);
  });

  it('placement with a client max_tokens → registry value wins (no client override)', async () => {
    const sent = await chatBody({ max_tokens: 99999 });
    expect(sent.max_tokens).toBe(2048);
    expect(sent.max_tokens).not.toBe(99999);
  });
});
