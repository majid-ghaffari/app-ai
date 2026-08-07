/**
 * Coverage for the per-store SETUP PROPOSALS prompt — TOOL-CAPABLE: it is
 * grounded on REAL PAGE EVIDENCE (cleaned HTML + screenshots, uploaded via /files
 * and passed as `fileIds`) AND can pull the merchant's REAL store data on demand
 * by CALLING the always-active personalizer toolset (get_store_analytics /
 * list_segments / list_campaigns / get_store_config) during reasoning. It runs on
 * the `/chat` tool-use loop, not the single-shot `/messages` path. Asserts:
 *   • the registry resolves `proposals` with `usesTools: true` and the
 *     `balanced` tier (Sonnet), NOT the default `frontier` tier;
 *   • the prompt text reasons over page evidence AND instructs the model to call
 *     the personalizer tools (the AOV-derived progress-bar threshold in particular);
 *   • `POST /chat` with `X-Personalizer-System-Prompt: proposals` sends the
 *     personalizer tool surface AND drives the tool loop (tool_call → Brain
 *     v2/ai-tools → tool_result → final JSON text) with the page-evidence file
 *     blocks prepended to the first user turn.
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { handleChat } from '../src/handlers/chat';
import {
  ENV,
  CORS,
  stubFetch,
  fetchCall,
  fetchedUrls,
  sentBody,
  readWorkerSse,
  eventOf,
} from './helpers';

interface SseBlockSpec {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Build an Anthropic-style SSE body from a list of content blocks. */
function anthropicSse(blocks: SseBlockSpec[], stopReason: string): string {
  const lines: string[] = [];
  const push = (type: string, data: Record<string, unknown>) =>
    lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  push('message_start', { message: { usage: { input_tokens: 10 } } });
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

afterEach(() => vi.restoreAllMocks());

describe('proposals registry entry', () => {
  it('resolves `proposals` with its OWN authoritative model + TOOLS enabled', () => {
    const entry = getSystemPrompt('proposals', ENV);
    // The proposals model is the `balanced` tier (Sonnet), deliberately DISTINCT
    // from the default `frontier` agent-loop tier.
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    // Tool-capable: it pulls real store data via the personalizer toolset
    // through the /chat tool-use loop, on top of the page evidence.
    expect(entry.usesTools).toBe(true);
    // No bundled sample — the caller uploads the page HTML + screenshots per run.
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
  });

  it('reasons over page evidence AND instructs the model to pull real store data via tools', () => {
    const entry = getSystemPrompt('proposals', ENV);
    // Page-evidence grounding is retained.
    expect(entry.prompt).toMatch(/page evidence/i);
    expect(entry.prompt).toMatch(/screenshot/i);
    expect(entry.prompt).toMatch(/cleaned[- ]HTML|cleaned HTML/i);
    // AND it calls the personalizer tools during reasoning.
    expect(entry.prompt).toMatch(/get_store_analytics/);
    expect(entry.prompt).toMatch(/list_segments/);
    expect(entry.prompt).toMatch(/list_campaigns/);
    expect(entry.prompt).toMatch(/get_store_config/);
    // The AOV-derived progress-bar threshold is the headline use of the data.
    expect(entry.prompt).toMatch(/AOV/);
    // The output envelope is unchanged (the four consumer slices).
    expect(entry.prompt).toMatch(/"setup"/);
    expect(entry.prompt).toMatch(/"segments"/);
    expect(entry.prompt).toMatch(/"progressBar"/);
    expect(entry.prompt).toMatch(/"bundles"/);
  });
});

describe('POST /chat — proposals is tool-capable', () => {
  it('sends the personalizer tool surface + the page-evidence file blocks', async () => {
    const fetchMock = stubFetch();
    fetchMock
      // Files-metadata lookups for the two page-evidence fileIds (document + image).
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mime_type: 'text/plain' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ mime_type: 'image/png' }), { status: 200 }),
      )
      // A single Anthropic turn that emits the final JSON (no tool call this time).
      .mockResolvedValueOnce(
        sseResponse(
          anthropicSse(
            [
              {
                type: 'text',
                text: '{"reply":"ok","setup":[],"segments":[],"progressBar":{"offerType":"FreeShipping","threshold":50,"rationale":"default"},"bundles":[]}',
              },
            ],
            'end_turn',
          ),
        ),
      );

    const res = await handleChat(
      chatRequest(
        {
          messages: [{ role: 'user', content: 'PAGE: Home' }],
          fileIds: ['html_home', 'shot_home'],
        },
        { 'X-Personalizer-System-Prompt': 'proposals' },
      ),
      ENV,
      CORS,
    );
    await readWorkerSse(res);

    // Find the Anthropic /v1/messages call (not the /files metadata lookups).
    const messagesIndex = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
    expect(messagesIndex).toBeGreaterThanOrEqual(0);
    const sent = sentBody(fetchCall(fetchMock, messagesIndex).init);
    // Tools are sent (proposals is usesTools: true) — the personalizer surface.
    const toolNames = (sent.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain('get_store_analytics');
    expect(toolNames).toContain('list_segments');
    expect(toolNames).toContain('list_campaigns');
    expect(toolNames).toContain('get_store_config');
    // Registry-authoritative model applied (the `balanced` tier = Sonnet).
    expect(sent.model).toBe(ENV.MODEL_BALANCED);
    // The page-evidence file blocks were prepended to the first user turn.
    const firstContent = sent.messages?.[0]?.content;
    expect(Array.isArray(firstContent)).toBe(true);
    const blocks = firstContent as Array<{ type?: string }>;
    expect(blocks.some((b) => b.type === 'document')).toBe(true);
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });

  it('drives the tool loop: pulls real AOV, then emits the JSON proposal', async () => {
    const toolTurn = anthropicSse(
      [{ type: 'tool_use', id: 'tu_1', name: 'get_store_analytics', input: {} }],
      'tool_use',
    );
    const finalTurn = anthropicSse(
      [
        {
          type: 'text',
          text: '{"reply":"Threshold set from your $46 AOV.","setup":[],"segments":[],"progressBar":{"offerType":"FreeShipping","threshold":55,"rationale":"order-derived from real AOV"},"bundles":[]}',
        },
      ],
      'end_turn',
    );
    const fetchMock = stubFetch();
    fetchMock
      // turn 1: Anthropic asks for get_store_analytics
      .mockResolvedValueOnce(sseResponse(toolTurn))
      // Brain v2/ai-tools/store-analytics answers with the real AOV
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ AverageOrderValue: 46, Currency: 'USD', OrderCount: 120 }), {
          status: 200,
        }),
      )
      // turn 2: Anthropic emits the final JSON proposal
      .mockResolvedValueOnce(sseResponse(finalTurn));

    const res = await handleChat(
      chatRequest(
        { messages: [{ role: 'user', content: 'propose a setup' }] },
        { 'X-Personalizer-System-Prompt': 'proposals' },
      ),
      ENV,
      CORS,
    );
    const events = await readWorkerSse(res);

    // The model pulled real store analytics mid-reasoning.
    expect(eventOf(events, 'tool_call').data.name).toBe('get_store_analytics');
    expect(eventOf(events, 'tool_result').data.ok).toBe(true);
    // The Brain AI-tool proxy was called (v2/ai-tools/store-analytics).
    const brainIndex = fetchedUrls(fetchMock).findIndex((u) => u.includes('/v2/ai-tools/'));
    expect(brainIndex).toBeGreaterThanOrEqual(0);
    // The final assistant text is the structured JSON proposal.
    const done = eventOf(events, 'done');
    const parsed = JSON.parse(String(done.data.text)) as {
      progressBar: { threshold: number };
    };
    expect(parsed.progressBar.threshold).toBe(55);
    expect(done.data.iterations).toBe(2);
  });
});
