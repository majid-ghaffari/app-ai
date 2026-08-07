/**
 * EXACT registry max_tokens (D6) — the registry is authoritative for a registered
 * prompt's output budget. Proves the outgoing Anthropic request's `max_tokens` is
 * EXACTLY the resolved registry entry's `maxTokens`, with NO floor, NO cap, and NO
 * client override:
 *   • /messages (header-selected propose + review prompts): the wire value equals
 *     `getSystemPrompt(name).maxTokens` whether the caller omitted `max_tokens`,
 *     sent a SMALLER one (old floor path), or sent a LARGER one (would-be cap);
 *   • the concrete literals — propose `onboarding-batch-all` = 8192, both review
 *     routes (`onboarding-review` = 2048, `onboarding-review-all` = 8192) — so a
 *     change to a registry literal changes the wire one-for-one and no hidden
 *     4096 default / floor / cap survives;
 *   • /chat (placement) uses the registry `maxTokens` exactly, overriding a
 *     client-sent budget.
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { handleMessages } from '../src/handlers/messages';
import { handleChat } from '../src/handlers/chat';
import { ENV, CORS, stubFetch, fetchCall, fetchedUrls, sentBody } from './helpers';

afterEach(() => vi.restoreAllMocks());

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

/** Fire /messages for a header-selected prompt; return the Anthropic request body. */
async function messagesBody(
  systemPrompt: string,
  body: Record<string, unknown>,
): Promise<ReturnType<typeof sentBody>> {
  const fetchMock = stubFetch();
  fetchMock.mockResolvedValue(jsonOk({ content: [] }));
  const req = new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx',
      'X-Personalizer-System-Prompt': systemPrompt,
      // The onboarding routes enforce the ruleset handshake; supply the matching
      // header so the request reaches Anthropic (the version is not what's tested).
      'X-Personalizer-Ruleset-Version': getSystemPrompt(systemPrompt, ENV).rulesetVersion ?? '',
    },
    body: JSON.stringify(body),
  });
  await handleMessages(req, ENV, CORS);
  const idx = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
  if (idx < 0) throw new Error('no /v1/messages call was made');
  return sentBody(fetchCall(fetchMock, idx).init);
}

// The propose + review routes the D6 exactness contract must cover, with their
// concrete registry literals. Reading these off `getSystemPrompt` too would hide a
// typo, so the literals are pinned HERE and the registry is asserted to match.
const EXACT_ROUTES: Array<{ name: string; maxTokens: number; kind: 'propose' | 'review' }> = [
  { name: 'onboarding-batch', maxTokens: 4096, kind: 'propose' },
  { name: 'onboarding-batch-all', maxTokens: 8192, kind: 'propose' },
  { name: 'onboarding-review', maxTokens: 2048, kind: 'review' },
  { name: 'onboarding-review-all', maxTokens: 8192, kind: 'review' },
];

describe('registry max_tokens is EXACT on /messages (no floor, no cap, no client read)', () => {
  it('the registry literals are what the routes declare (pins the source values)', () => {
    for (const { name, maxTokens } of EXACT_ROUTES) {
      expect(getSystemPrompt(name, ENV).maxTokens).toBe(maxTokens);
    }
    // The whole-store propose + review both budget 8192; the single-page review is
    // the tightest (2048). None is the old 4096 default in disguise.
    expect(getSystemPrompt('onboarding-batch-all', ENV).maxTokens).toBe(8192);
    expect(getSystemPrompt('onboarding-review-all', ENV).maxTokens).toBe(8192);
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

  it('no hidden 4096 default survives for a non-4096 route (onboarding-review sends 2048, not 4096)', async () => {
    const sent = await messagesBody('onboarding-review', {
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'go' }],
    });
    expect(sent.max_tokens).toBe(2048);
  });
});

describe('registry max_tokens is EXACT on /chat (placement overrides the client budget)', () => {
  const ONE_TURN_SSE =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';

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
