/**
 * Token-saving / cost-reduction coverage:
 *   1. Extended 1h TTL on the stable prefix (system + attachments + kept user blocks).
 *   2. Agent-loop conversation breakpoints (lib/agent-cache.ts) — last-block,
 *      ~15-block intermediate rule, 4-breakpoint cap, stale-strip.
 *   3. Files API checksum dedup (lib/file-dedup.ts) — sha256Hex, KV hit/miss, no-op.
 *   4. count_tokens pre-flight helper (lib/anthropic.ts).
 *   5. Model/effort routing (prompt-registry.ts + handlers).
 *
 * fetch + KV mocked; Web Crypto comes from the vitest (Node) runtime.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { applyConversationBreakpoints } from '../src/lib/agent-cache';
import { sha256Hex, dedupUpload, KV_RECORD_TTL_SECONDS } from '../src/lib/file-dedup';
import * as anthropic from '../src/lib/anthropic';
import type { ContentBlock, MessageParam } from '../src/lib/anthropic';
import { buildSystem, handleChat } from '../src/handlers/chat';
import { getSystemPrompt } from '../src/prompt-registry';
import {
  ENV,
  CORS,
  stubFetch,
  fetchCall,
  fetchedUrls,
  headerOf,
  sentBody,
  kvMock,
} from './helpers';

afterEach(() => vi.restoreAllMocks());

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

// ── LEVER 1: extended 1h TTL on the stable prefix ───────────────────────────

describe('LEVER 1 — extended 1h TTL on the stable prefix', () => {
  it('chat buildSystem: base prompt block is 1h-cached, volatile context block is uncached', () => {
    const entry = getSystemPrompt('chat', ENV);
    const blocks = buildSystem(entry, { hostPage: 'Home', candidates: [{ index: 0 }] });
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // The volatile context block (page/candidates) must NOT be cached.
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[blocks.length - 1]?.cache_control).toBeUndefined();
  });

  it('chat buildSystem: with no context there is only the cached base block', () => {
    const blocks = buildSystem(getSystemPrompt('chat', ENV), undefined);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

// ── LEVER 2: agent-loop conversation breakpoints ────────────────────────────

describe('LEVER 2 — applyConversationBreakpoints', () => {
  /** Build a conversation of N total content blocks spread across messages. */
  function buildConversation(blockCounts: number[]): MessageParam[] {
    return blockCounts.map((count, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: Array.from(
        { length: count },
        (_unused, j): ContentBlock => ({ type: 'text', text: `m${i}b${j}` }),
      ),
    }));
  }

  function flatBlocks(messages: MessageParam[]): ContentBlock[] {
    const flat: ContentBlock[] = [];
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        for (const block of message.content) flat.push(block);
      }
    }
    return flat;
  }

  it('places a breakpoint on the last block of the last message', () => {
    const messages = buildConversation([2, 3]);
    applyConversationBreakpoints(messages);
    const last = flatBlocks(messages).at(-1);
    expect(last?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('the ~15-block intermediate rule keeps breakpoints ≤20 apart on a long conversation', () => {
    // 50 total blocks across messages.
    const messages = buildConversation([10, 10, 10, 10, 10]);
    applyConversationBreakpoints(messages);
    const flat = flatBlocks(messages);
    const marked: number[] = [];
    flat.forEach((block, index) => {
      if (block.cache_control) marked.push(index);
    });
    // Last block is always marked.
    expect(marked).toContain(flat.length - 1);
    // No two consecutive breakpoints (and the tail) more than 20 apart.
    const sorted = [...marked].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)).toBeLessThanOrEqual(20);
    }
  });

  it('never exceeds the message-breakpoint cap (default 3 → system holds the 4th)', () => {
    const messages = buildConversation([20, 20, 20, 20, 20]); // 100 blocks
    applyConversationBreakpoints(messages);
    const marked = flatBlocks(messages).filter((block) => block.cache_control);
    expect(marked.length).toBeLessThanOrEqual(3);
  });

  it('strips stale breakpoints before re-applying (no accumulation across iterations)', () => {
    const messages = buildConversation([10, 10, 10, 10]); // 40 blocks
    applyConversationBreakpoints(messages);
    const firstCount = flatBlocks(messages).filter((block) => block.cache_control).length;
    // Re-run (simulating the next loop iteration) — count must not grow.
    applyConversationBreakpoints(messages);
    const secondCount = flatBlocks(messages).filter((block) => block.cache_control).length;
    expect(secondCount).toBe(firstCount);
    expect(secondCount).toBeLessThanOrEqual(3);
  });

  it('tolerates string-content messages and empty input', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'plain string' }];
    expect(() => applyConversationBreakpoints(messages)).not.toThrow();
    expect(messages[0]?.content).toBe('plain string');
    expect(() => applyConversationBreakpoints([])).not.toThrow();
  });
});

// ── LEVER 3: Files API checksum dedup ───────────────────────────────────────

describe('LEVER 3 — file-dedup', () => {
  it('sha256Hex matches the known vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes equal bytes identically regardless of string vs Uint8Array', async () => {
    const fromStr = await sha256Hex('hello');
    const fromBytes = await sha256Hex(new TextEncoder().encode('hello'));
    expect(fromStr).toBe(fromBytes);
  });

  it('KV hit verifies the file still exists, then returns it without re-uploading', async () => {
    // On a hit, dedup makes ONE call: a GET metadata check confirming the file
    // is still alive (200). It must NOT upload (no POST /files) and must NOT
    // rewrite KV.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: 'file_cached', type: 'file' }, 200));
    const { kv, env } = kvMock(JSON.stringify({ fileId: 'file_cached', createdAt: 1 }));
    const out = await dedupUpload(
      { content: 'abc', mimeType: 'text/plain', filename: 'a.txt' },
      env,
    );
    expect(out).toEqual({ fileId: 'file_cached', deduped: true });
    // Exactly one fetch: the GET metadata existence check (not an upload POST).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/files/file_cached');
    expect(init.method).toBeUndefined(); // GET (no method = GET)
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
    // Looked up under the content hash.
    expect(kv.get).toHaveBeenCalledWith(await sha256Hex('abc'));
  });

  it('KV hit on a STALE id (file 404s) drops the record, re-uploads, and refreshes', async () => {
    // First fetch = metadata check → 404 (file gone). Second fetch = upload POST.
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(jsonOk({ error: { message: 'File not found' } }, 404))
      .mockResolvedValueOnce(jsonOk({ id: 'file_fresh' }, 200));
    const { kv, env } = kvMock(JSON.stringify({ fileId: 'file_stale', createdAt: 1 }));
    const out = await dedupUpload(
      { content: 'abc', mimeType: 'text/plain', filename: 'a.txt' },
      env,
    );
    // Never returns the dead id — a fresh upload replaces it.
    expect(out).toEqual({ fileId: 'file_fresh', deduped: false });
    expect(kv.delete).toHaveBeenCalledWith(await sha256Hex('abc'));
    // Metadata check (GET) then upload (POST /files).
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files/file_stale');
    const upload = fetchCall(fetchMock, 1);
    expect(upload.url).toBe('https://api.anthropic.com/v1/files');
    expect(upload.init.method).toBe('POST');
    // Re-stored under the same hash with a TTL.
    const putCall = kv.put.mock.calls.at(0);
    if (!putCall) throw new Error('KV put was not called');
    const [hashKey, stored, putOpts] = putCall;
    expect(hashKey).toBe(await sha256Hex('abc'));
    expect((JSON.parse(stored) as { fileId: string }).fileId).toBe('file_fresh');
    expect(putOpts?.expirationTtl).toBe(KV_RECORD_TTL_SECONDS);
  });

  it('KV hit on an UNUSABLE id (400 malformed, e.g. a dev-shim id) also drops it and re-uploads', async () => {
    // THE CROSS-CHANNEL POISONING REGRESSION. Switching ANTHROPIC_API_BASE from the dev shim to the
    // real API leaves the hash→file_id records in FILES_KV untouched: identical page tiles hash to
    // the same key, so the worker vended shim ids (`file_dev_…`) at api.anthropic.com. Those answer
    // 400 "Invalid file source id", NOT 404 — and the old guard (`status !== 404`) read that as
    // "exists", so every /messages carrying the block failed. Any non-OK metadata response must drop
    // the record: re-uploading costs bandwidth, vending an unusable id costs the whole request.
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        jsonOk({ error: { message: 'Invalid file source id `file_dev_abc`' } }, 400),
      )
      .mockResolvedValueOnce(jsonOk({ id: 'file_fresh' }, 200));
    const { kv, env } = kvMock(JSON.stringify({ fileId: 'file_dev_abc', createdAt: 1 }));
    const out = await dedupUpload(
      { content: 'abc', mimeType: 'text/plain', filename: 'a.txt' },
      env,
    );
    expect(out).toEqual({ fileId: 'file_fresh', deduped: false });
    expect(kv.delete).toHaveBeenCalledWith(await sha256Hex('abc'));
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files/file_dev_abc');
    expect(fetchCall(fetchMock, 1).init.method).toBe('POST');
  });

  it('KV hit whose metadata check THROWS re-uploads rather than vending an unverified id', async () => {
    // Fail-closed on a network blip too: the contract is "never return a dead file_id", and an id we
    // could not verify may be dead. A needless re-upload is the cheap failure mode.
    const fetchMock = stubFetch();
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonOk({ id: 'file_fresh' }, 200));
    const { kv, env } = kvMock(JSON.stringify({ fileId: 'file_unverifiable', createdAt: 1 }));
    const out = await dedupUpload(
      { content: 'abc', mimeType: 'text/plain', filename: 'a.txt' },
      env,
    );
    expect(out).toEqual({ fileId: 'file_fresh', deduped: false });
    expect(kv.delete).toHaveBeenCalledWith(await sha256Hex('abc'));
  });

  it('KV miss uploads, stores hash→fileId, returns deduped:false', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: 'file_new' }));
    const { kv, env } = kvMock();

    const out = await dedupUpload(
      { content: 'xyz', mimeType: 'text/plain', filename: 'b.txt' },
      env,
    );
    expect(out).toEqual({ fileId: 'file_new', deduped: false });
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files');
    const putCall = kv.put.mock.calls.at(0);
    if (!putCall) throw new Error('KV put was not called');
    const [hashKey, stored, putOpts] = putCall;
    expect(hashKey).toBe(await sha256Hex('xyz'));
    expect((JSON.parse(stored) as { fileId: string }).fileId).toBe('file_new');
    // The KV record carries the conservative TTL (stale-id bound).
    expect(putOpts?.expirationTtl).toBe(KV_RECORD_TTL_SECONDS);
  });

  it('no KV binding → plain upload, never touches KV, deduped:false', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: 'file_plain' }));
    const out = await dedupUpload(
      { content: 'data', mimeType: 'image/png', filename: 'c.png' },
      ENV, // no FILES_KV
    );
    expect(out).toEqual({ fileId: 'file_plain', deduped: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws (caller catches) when the upload fails', async () => {
    stubFetch().mockResolvedValue(jsonOk({ error: { message: 'boom' } }, 500));
    await expect(
      dedupUpload({ content: 'd', mimeType: 'text/plain', filename: 'd.txt' }, ENV),
    ).rejects.toThrow(/boom/);
  });
});

// ── LEVER 4: count_tokens pre-flight helper ─────────────────────────────────

describe('LEVER 4 — countTokens', () => {
  it('POSTs to /v1/messages/count_tokens with the messages beta header + count-only body', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ input_tokens: 1234 }));

    const res = await anthropic.countTokens(
      {
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        stream: true,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: 's' }],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 't' }],
      },
      ENV,
    );
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(headerOf(init, 'anthropic-beta')).toBe('prompt-caching-2024-07-31,files-api-2025-04-14');
    const body = sentBody(init);
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.system).toBeDefined();
    expect(body.messages).toBeDefined();
    expect(body.tools).toBeDefined();
    // Inference-only fields are stripped.
    expect(body.max_tokens).toBeUndefined();
    expect(body.stream).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(((await res.json()) as { input_tokens: number }).input_tokens).toBe(1234);
  });
});

// ── LEVER 5: model / effort routing ─────────────────────────────────────────

describe('LEVER 5 — model + effort routing', () => {
  it('registry tiers resolve to models: placement→fast, a balanced prompt→balanced, no-tier→frontier default', () => {
    // The tier PAIRING is registry data; the model VALUES are deploy-time config
    // (MODEL_FAST / MODEL_BALANCED / MODEL_FRONTIER via `resolveModel`). Production
    // values are pinned by the wrangler.toml [vars] contract test in
    // test/config.test.ts.
    // `fast` tier — the latency-sensitive placement prompt.
    expect(getSystemPrompt('placement', ENV).model).toBe(ENV.MODEL_FAST);
    // `balanced` tier — a multi-modal / JSON reasoner.
    expect(getSystemPrompt('proposals', ENV).model).toBe(ENV.MODEL_BALANCED);
    // DEFAULT (`frontier`) tier — the entries that OMIT `tier`.
    expect(getSystemPrompt('chat', ENV).model).toBe(ENV.MODEL_FRONTIER);
    expect(getSystemPrompt('onboarding', ENV).model).toBe(ENV.MODEL_FRONTIER);
    expect(getSystemPrompt('image-selection', ENV).model).toBe(ENV.MODEL_FRONTIER);
  });

  it('the DEFAULT tier is `frontier` — a no-tier prompt resolves to the frontier binding', () => {
    // A no-tier entry (`chat`) MUST resolve to the frontier model id, proving the
    // registry's DEFAULT_TIER is `frontier` (the flagship agent-loop tier). If the
    // default flipped, this catches it.
    expect(getSystemPrompt('chat', ENV).model).toBe('claude-opus-4-8');
    expect(getSystemPrompt('placement', ENV).model).toBe('claude-haiku-4-5');
    expect(getSystemPrompt('proposals', ENV).model).toBe('claude-sonnet-5');
  });

  it('uses low effort per page and medium effort for whole-store onboarding JSON', () => {
    // Placement runs on Haiku 4.5, which 400s on output_config.effort, so the
    // entry must not set it. chat/onboarding/image-selection never set it.
    expect(getSystemPrompt('placement', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('chat', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('onboarding', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('image-selection', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('onboarding-batch', ENV).effort).toBe('low');
    expect(getSystemPrompt('onboarding-batch-all', ENV).effort).toBe('medium');
    expect(getSystemPrompt('onboarding-review', ENV).effort).toBe('low');
    expect(getSystemPrompt('onboarding-review-all', ENV).effort).toBe('medium');
  });

  it('supportsEffort: true for the effort-capable models, false for placement/Haiku & Sonnet 4.5', () => {
    // The guard that prevents the placement 500. Effort-capable set.
    expect(anthropic.supportsEffort('claude-fable-5')).toBe(true);
    expect(anthropic.supportsEffort('claude-opus-4-8')).toBe(true);
    expect(anthropic.supportsEffort('claude-opus-4-7')).toBe(true);
    expect(anthropic.supportsEffort('claude-opus-4-6')).toBe(true);
    expect(anthropic.supportsEffort('claude-opus-4-5')).toBe(true);
    expect(anthropic.supportsEffort('claude-sonnet-4-6')).toBe(true);
    expect(anthropic.supportsEffort('claude-sonnet-5')).toBe(true);
    // Models that 400 on output_config.effort.
    expect(anthropic.supportsEffort('claude-haiku-4-5')).toBe(false);
    expect(anthropic.supportsEffort('claude-sonnet-4-5')).toBe(false);
    expect(anthropic.supportsEffort(getSystemPrompt('placement', ENV).model)).toBe(false);
  });

  it('chat.ts NEVER sends output_config.effort to an effort-UNsupported model (placement 500 guard)', async () => {
    // Minimal SSE body the worker can parse → ends the loop after one turn.
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
    const sseResponse = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        }),
        { status: 200 },
      );

    const req = (promptName: string, extra: Record<string, unknown> = {}) =>
      new Request('https://app-ai.test/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Personalizer-Context-ID': 'ctx',
          'X-Personalizer-System-Prompt': promptName,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }], ...extra }),
      });

    const bodyOf = async (request: Request) => {
      const fetchMock = stubFetch();
      fetchMock.mockResolvedValue(sseResponse());
      await (await handleChat(request, ENV, CORS)).text();
      return sentBody(fetchCall(fetchMock, 0).init);
    };

    // placement → Haiku 4.5 (effort-UNsupported): NO output_config, even though
    // the path is structured. This is the exact 500 the guard prevents.
    const placementBody = await bodyOf(req('placement'));
    expect(placementBody.model).toBe('claude-haiku-4-5');
    expect(placementBody.output_config).toBeUndefined();

    // Forcing effort via the client body on the placement model must STILL be
    // dropped — the guard is on model capability, not on where effort came from.
    const placementForced = await bodyOf(req('placement', { effort: 'low' }));
    expect(placementForced.model).toBe('claude-haiku-4-5');
    expect(placementForced.output_config).toBeUndefined();

    // chat → Opus 4.8 with no effort set: no output_config.
    const chatBody = await bodyOf(req('chat'));
    expect(chatBody.model).toBe('claude-opus-4-8');
    expect(chatBody.output_config).toBeUndefined();

    // chat → Opus 4.8 (effort-SUPPORTED) with effort set via body: output_config
    // IS attached. Proves the guard keeps the lever working where it's valid.
    const chatEffort = await bodyOf(req('chat', { effort: 'low' }));
    expect(chatEffort.model).toBe('claude-opus-4-8');
    expect(chatEffort.output_config).toEqual({ effort: 'low' });
  });
});

// ── Integration: agent loop breakpoint count stays ≤4 after a multi-tool loop ─

describe('integration — agent-loop cache_control count ≤ 4', () => {
  it('after a tool loop, message-block breakpoints ≤3 (system base block holds the 4th)', async () => {
    interface SseBlockSpec {
      type: 'text' | 'tool_use';
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }
    function anthropicSse(blocks: SseBlockSpec[], stopReason: string): string {
      const lines: string[] = [];
      const push = (type: string, data: Record<string, unknown>) =>
        lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      push('message_start', { message: { usage: { input_tokens: 10 } } });
      blocks.forEach((block, index) => {
        if (block.type === 'text') {
          push('content_block_start', { index, content_block: { type: 'text' } });
          push('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
        } else {
          push('content_block_start', {
            index,
            content_block: { type: 'tool_use', id: block.id, name: block.name },
          });
          push('content_block_delta', {
            index,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          });
        }
      });
      push('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
      return lines.join('');
    }
    const sseResponse = (text: string) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
        { status: 200 },
      );

    let turn = 0;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      if (String(url).includes('/v2/ai-tools/')) {
        return Promise.resolve(jsonOk({ ok: true }));
      }
      turn += 1;
      // First 3 turns ask for a tool, then a final text turn.
      if (turn <= 3) {
        return Promise.resolve(
          sseResponse(
            anthropicSse(
              [{ type: 'tool_use', id: `tu_${turn}`, name: 'list_segments', input: {} }],
              'tool_use',
            ),
          ),
        );
      }
      return Promise.resolve(
        sseResponse(anthropicSse([{ type: 'text', text: 'done' }], 'end_turn')),
      );
    });

    const req = new Request('https://app-ai.test/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'loop' }] }),
    });
    await (await handleChat(req, ENV, CORS)).text();

    // Inspect the LAST Anthropic call (largest conversation) — count message
    // breakpoints; must be ≤3 so total (with the 1 system block) ≤4.
    const anthropicCallIndexes = fetchedUrls(fetchMock)
      .map((u, i) => (u.includes('/v2/ai-tools/') ? -1 : i))
      .filter((i) => i >= 0);
    const lastIndex = anthropicCallIndexes.at(-1);
    if (lastIndex === undefined) throw new Error('no Anthropic call was made');
    const lastBody = sentBody(fetchCall(fetchMock, lastIndex).init);
    let msgBreakpoints = 0;
    lastBody.messages?.forEach((message) => {
      if (Array.isArray(message.content)) {
        message.content.forEach((block) => {
          if (block.cache_control) msgBreakpoints += 1;
        });
      }
    });
    expect(msgBreakpoints).toBeLessThanOrEqual(3);
    expect(msgBreakpoints).toBeGreaterThanOrEqual(1);
    // System base block uses exactly 1.
    expect(lastBody.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

// ── LEVER 6: cache_control on the placement file prefix (fileIds) ────────────

describe('LEVER 6 — fileIds document-block caching (placement file prefix)', () => {
  /** Minimal one-turn SSE the worker parses → ends the loop after one turn. */
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

  /**
   * Fire /chat with the given body, return the parsed Anthropic request body.
   * `mimeByFileId` maps each uploaded fileId to the mime_type its Files-API
   * metadata lookup should report (drives image vs document block selection).
   */
  async function chatBody(body: unknown, mimeByFileId: Record<string, string> = {}) {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      // Files API metadata lookup (GET /v1/files/{id}) for block-type selection.
      const match = u.match(/\/v1\/files\/(file_[^/?]+)$/);
      if (match?.[1]) {
        return Promise.resolve(
          jsonOk({ id: match[1], mime_type: mimeByFileId[match[1]] || 'text/plain' }),
        );
      }
      // The Messages stream.
      return Promise.resolve(sseResponse());
    });
    const req = new Request('https://app-ai.test/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': 'placement',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    await (await handleChat(req, ENV, CORS)).text();
    const index = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
    if (index < 0) throw new Error('no /v1/messages call was made');
    return sentBody(fetchCall(fetchMock, index).init);
  }

  it('prepends fileIds, 1h-caches the LAST file block, and types images vs documents by mime', async () => {
    const sent = await chatBody(
      {
        messages: [{ role: 'user', content: 'where should the box go?' }],
        fileIds: ['file_html', 'file_screenshot'],
      },
      { file_html: 'text/plain', file_screenshot: 'image/jpeg' },
    );
    const content = sent.messages?.[0]?.content;
    if (!Array.isArray(content)) throw new Error('first message content is not a block array');
    // Two file blocks prepended ahead of the user text, in order.
    const fileBlocks = content.filter((b) => b.type === 'document' || b.type === 'image');
    expect(fileBlocks).toHaveLength(2);
    // HTML → document block; screenshot (image/jpeg) → image block (NOT document,
    // which Anthropic rejects for images — the real placement 400 this fixes).
    expect(fileBlocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'file', file_id: 'file_html' },
    });
    expect(fileBlocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'file', file_id: 'file_screenshot' },
    });
    // Only the LAST file block carries the 1h breakpoint (caches the whole
    // prefix); the first does NOT (avoids burning two slots on the prefix).
    expect(fileBlocks[0]?.cache_control).toBeUndefined();
    expect(fileBlocks[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('keeps total breakpoints ≤4 with a file prefix present (1 system + 1 file + ≤2 conv)', async () => {
    const sent = await chatBody({
      messages: [{ role: 'user', content: 'go' }],
      fileIds: ['file_html', 'file_screenshot'],
    });
    let total = sent.system?.filter((b) => b.cache_control).length ?? 0; // system base = 1
    sent.messages?.forEach((message) => {
      if (Array.isArray(message.content)) {
        message.content.forEach((block) => {
          if (block.cache_control) total += 1;
        });
      }
    });
    expect(total).toBeLessThanOrEqual(4);
    // Sanity: the file-prefix breakpoint is present (≥ system + file = 2).
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it('no fileIds → no document blocks, no file breakpoint (placement without uploads)', async () => {
    const sent = await chatBody({ messages: [{ role: 'user', content: 'go' }] });
    const content = sent.messages?.[0]?.content;
    // Plain string content is left as-is (no file blocks injected).
    const hasDocBlock = Array.isArray(content) && content.some((b) => b.type === 'document');
    expect(hasDocBlock).toBe(false);
  });
});
