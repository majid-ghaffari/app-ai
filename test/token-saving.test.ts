/**
 * Token-saving / cost-reduction coverage:
 *   1. Extended 1h TTL on the stable prefix (system + attachments + kept user blocks).
 *   2. Agent-loop conversation breakpoints (inference/cache.ts) — last-block, ~15-block
 *      intermediate rule, breakpoint cap, stale-strip, one extended file-prefix intent kept.
 *   3. Files API checksum dedup (lib/file-dedup.ts) — sha256Hex, KV hit/miss, no-op.
 *   4. Anthropic adapter count_tokens pre-flight helper.
 *   5. Model/effort routing (prompt-registry.ts + handlers).
 *
 * fetch + KV mocked; Web Crypto comes from the vitest (Node) runtime.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { applyCanonicalConversationBreakpoints } from '../src/inference/cache';
import {
  sha256Hex,
  dedupUpload,
  fileMetadataTtlSeconds,
  KV_RECORD_TTL_SECONDS,
} from '../src/lib/file-dedup';
import * as anthropic from '../src/inference/adapters/anthropic-wire';
import type { InferenceContent, InferenceMessage } from '../src/lib/inference-types';
import { buildSystem, handleChat } from '../src/handlers/chat';
import { getFilePolicy, getModelProfile, getSystemPrompt } from '../src/prompt-registry';
import {
  anthropicMessageStart,
  ENV,
  CORS,
  stubFetch,
  fetchCall,
  fetchedUrls,
  headerOf,
  sentBody,
  kvMock,
  opaqueFileEnv,
  DISTANT_FILE_EXPIRY,
} from './helpers';

const FILE_ROUTE = {
  profile: getModelProfile('placement', ENV),
  policy: getFilePolicy('anthropic-provider-files'),
  accountScope: 'anthropic:test-account',
  tenantScope: 'tenant:test-tenant',
  compatibleGroups: ['image-selection'] as [string, ...string[]],
};

async function dedupStorageKey(content: string): Promise<string> {
  return `${FILE_ROUTE.tenantScope}:${FILE_ROUTE.accountScope}:${FILE_ROUTE.policy.name}:${FILE_ROUTE.compatibleGroups.join(',')}:${encodeURIComponent('text/plain')}:${await sha256Hex(content)}`;
}

afterEach(() => vi.restoreAllMocks());

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

// ── LEVER 1: extended 1h TTL on the stable prefix ───────────────────────────

describe('LEVER 1 — extended 1h TTL on the stable prefix', () => {
  it('chat buildSystem: volatile canonical context remains uncached', () => {
    const messages = buildSystem({ hostPage: 'Home', candidates: [{ index: 0 }] });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content[0]).toMatchObject({ type: 'text', cache: 'none' });
  });

  it('chat buildSystem: with no volatile context there is no extra system message', () => {
    expect(buildSystem(undefined)).toEqual([]);
  });
});

// ── LEVER 2: agent-loop conversation breakpoints ────────────────────────────

describe('LEVER 2 — applyCanonicalConversationBreakpoints', () => {
  /** Build a conversation of N total content blocks spread across messages. */
  function buildConversation(blockCounts: number[]): InferenceMessage[] {
    return blockCounts.map((count, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: Array.from(
        { length: count },
        (_unused, j): InferenceContent => ({ type: 'text', text: `m${i}b${j}`, cache: 'none' }),
      ),
    }));
  }

  function flatBlocks(messages: InferenceMessage[]): InferenceContent[] {
    return messages.flatMap((message) => [...message.content]);
  }

  /** Flat indices carrying a short conversation breakpoint, in conversation order. */
  function shortBreakpoints(messages: InferenceMessage[]): number[] {
    const marked: number[] = [];
    flatBlocks(messages).forEach((block, index) => {
      if (block.cache === 'short') marked.push(index);
    });
    return marked;
  }

  it('places a short breakpoint on the last block of the last message', () => {
    const messages = buildConversation([2, 3]);
    applyCanonicalConversationBreakpoints(messages, 3);
    expect(flatBlocks(messages).at(-1)?.cache).toBe('short');
  });

  it('the ~15-block intermediate rule keeps breakpoints ≤20 apart on a long conversation', () => {
    const messages = buildConversation([10, 10, 10, 10, 10]); // 50 blocks
    applyCanonicalConversationBreakpoints(messages, 3);
    const marked = shortBreakpoints(messages);
    expect(marked).toContain(flatBlocks(messages).length - 1);
    for (let i = 1; i < marked.length; i++) {
      expect((marked[i] ?? 0) - (marked[i - 1] ?? 0)).toBeLessThanOrEqual(20);
    }
  });

  it('never exceeds the conversation-breakpoint cap (3 → the system block holds the 4th)', () => {
    const messages = buildConversation([20, 20, 20, 20, 20]); // 100 blocks
    applyCanonicalConversationBreakpoints(messages, 3);
    expect(shortBreakpoints(messages).length).toBeLessThanOrEqual(3);
  });

  it('strips stale short breakpoints before re-applying (no accumulation across iterations)', () => {
    const messages = buildConversation([10, 10, 10, 10]); // 40 blocks
    applyCanonicalConversationBreakpoints(messages, 3);
    const firstCount = shortBreakpoints(messages).length;
    applyCanonicalConversationBreakpoints(messages, 3);
    const secondCount = shortBreakpoints(messages).length;
    expect(secondCount).toBe(firstCount);
    expect(secondCount).toBeLessThanOrEqual(3);
  });

  it('keeps only the last extended file-prefix intent and never re-marks it', () => {
    const image = (data: string): InferenceContent => ({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/png', data },
      cache: 'extended',
    });
    const messages: InferenceMessage[] = [
      {
        role: 'user',
        content: [
          image('screenshot'),
          image('html'),
          { type: 'text', text: 'place', cache: 'none' },
        ],
      },
      ...buildConversation([4, 4]),
    ];
    applyCanonicalConversationBreakpoints(messages, 2);
    const flat = flatBlocks(messages);
    expect(flat[0]?.cache).toBe('none');
    expect(flat[1]?.cache).toBe('extended');
    expect(shortBreakpoints(messages).length).toBeLessThanOrEqual(2);
    expect(flat.at(-1)?.cache).toBe('short');
    expect(() => applyCanonicalConversationBreakpoints([], 3)).not.toThrow();
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
    fetchMock.mockResolvedValue(
      jsonOk(
        {
          id: 'file_cached',
          type: 'file',
          mime_type: 'text/plain',
          size_bytes: 3,
          expires_at: DISTANT_FILE_EXPIRY,
        },
        200,
      ),
    );
    const { kv, env } = kvMock(JSON.stringify({ fileId: 'file_cached', createdAt: 1 }));
    const out = await dedupUpload(
      { content: 'abc', mimeType: 'text/plain', filename: 'a.txt' },
      FILE_ROUTE,
      env,
    );
    expect(out).toMatchObject({
      reference: { upstreamFileId: 'file_cached', mediaType: 'text/plain', sizeBytes: 3 },
      deduped: true,
    });
    // Exactly one fetch: the GET metadata existence check (not an upload POST).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/files/file_cached');
    expect(init.method).toBeUndefined(); // GET (no method = GET)
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
    // Looked up under the content hash.
    expect(kv.get).toHaveBeenCalledWith(await dedupStorageKey('abc'));
  });

  it('KV hit on a STALE id (file 404s) drops the record, re-uploads, and refreshes', async () => {
    // First fetch = metadata check → 404 (file gone). Second fetch = upload POST.
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(jsonOk({ error: { message: 'File not found' } }, 404))
      .mockResolvedValueOnce(
        jsonOk(
          {
            id: 'file_fresh',
            type: 'file',
            mime_type: 'text/plain',
            size_bytes: 3,
            expires_at: DISTANT_FILE_EXPIRY,
          },
          200,
        ),
      );
    const { kv, env } = kvMock(JSON.stringify({ fileId: 'file_stale', createdAt: 1 }));
    const out = await dedupUpload(
      { content: 'abc', mimeType: 'text/plain', filename: 'a.txt' },
      FILE_ROUTE,
      env,
    );
    // Never returns the dead id — a fresh upload replaces it.
    expect(out).toMatchObject({
      reference: { upstreamFileId: 'file_fresh' },
      deduped: false,
    });
    expect(kv.delete).toHaveBeenCalledWith(await dedupStorageKey('abc'));
    // Metadata check (GET) then upload (POST /files).
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files/file_stale');
    const upload = fetchCall(fetchMock, 1);
    expect(upload.url).toBe('https://api.anthropic.com/v1/files');
    expect(upload.init.method).toBe('POST');
    // Re-stored under the same hash with a TTL.
    const putCall = kv.put.mock.calls.at(0);
    if (!putCall) throw new Error('KV put was not called');
    const [hashKey, stored, putOpts] = putCall;
    expect(hashKey).toBe(await dedupStorageKey('abc'));
    expect(JSON.parse(stored)).toMatchObject({ fileId: 'file_fresh', mediaType: 'text/plain' });
    expect(putOpts?.expirationTtl).toBe(KV_RECORD_TTL_SECONDS);
  });

  it('treats a malformed metadata success as stale instead of vending the cached id', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(new Response('null'))
      .mockResolvedValueOnce(
        jsonOk({
          id: 'file_recovered',
          type: 'file',
          mime_type: 'text/plain',
          size_bytes: 3,
          expires_at: DISTANT_FILE_EXPIRY,
        }),
      );
    const { kv, env } = kvMock(JSON.stringify({ fileId: 'file_malformed', createdAt: 1 }));
    await expect(
      dedupUpload({ content: 'abc', mimeType: 'text/plain', filename: 'a.txt' }, FILE_ROUTE, env),
    ).resolves.toMatchObject({
      reference: { upstreamFileId: 'file_recovered' },
      deduped: false,
    });
    expect(kv.delete).toHaveBeenCalledWith(await dedupStorageKey('abc'));
    expect(fetchCall(fetchMock, 1).url).toBe('https://api.anthropic.com/v1/files');
  });

  it('KV miss uploads, stores hash→fileId, returns deduped:false', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonOk({
        id: 'file_new',
        type: 'file',
        mime_type: 'text/plain',
        size_bytes: 3,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { kv, env } = kvMock();

    const out = await dedupUpload(
      { content: 'xyz', mimeType: 'text/plain', filename: 'b.txt' },
      FILE_ROUTE,
      env,
    );
    expect(out).toMatchObject({ reference: { upstreamFileId: 'file_new' }, deduped: false });
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files');
    const putCall = kv.put.mock.calls.at(0);
    if (!putCall) throw new Error('KV put was not called');
    const [hashKey, stored, putOpts] = putCall;
    expect(hashKey).toBe(await dedupStorageKey('xyz'));
    expect(JSON.parse(stored)).toMatchObject({ fileId: 'file_new', mediaType: 'text/plain' });
    // The KV record carries the conservative TTL (stale-id bound).
    expect(putOpts?.expirationTtl).toBe(KV_RECORD_TTL_SECONDS);
  });

  it('treats a stored bare provider id as a miss rather than a validated record', async () => {
    // Only the JSON record shape is a hit: a raw `file_…` string is never read
    // out of storage as if it carried validated route metadata.
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonOk({
        id: 'file_fresh',
        type: 'file',
        mime_type: 'text/plain',
        size_bytes: 3,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { kv, env } = kvMock('file_bare_record');

    const out = await dedupUpload(
      { content: 'xyz', mimeType: 'text/plain', filename: 'b.txt' },
      FILE_ROUTE,
      env,
    );
    expect(out).toMatchObject({ reference: { upstreamFileId: 'file_fresh' }, deduped: false });
    // No metadata verification of the bare id — straight to the upload.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files');
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('treats KV read and write outages as best-effort cache misses', async () => {
    const readFetch = stubFetch().mockResolvedValueOnce(
      jsonOk({
        id: 'file_after_read_outage',
        type: 'file',
        mime_type: 'text/plain',
        size_bytes: 3,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const readOutage = kvMock();
    readOutage.kv.get.mockRejectedValueOnce(new Error('KV unavailable'));

    await expect(
      dedupUpload(
        { content: 'read-outage', mimeType: 'text/plain', filename: 'read.txt' },
        FILE_ROUTE,
        readOutage.env,
      ),
    ).resolves.toMatchObject({
      reference: { upstreamFileId: 'file_after_read_outage' },
      deduped: false,
    });
    expect(fetchCall(readFetch, 0).url).toBe('https://api.anthropic.com/v1/files');

    const writeFetch = stubFetch().mockResolvedValueOnce(
      jsonOk({
        id: 'file_after_write_outage',
        type: 'file',
        mime_type: 'text/plain',
        size_bytes: 3,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const writeOutage = kvMock();
    writeOutage.kv.put.mockRejectedValueOnce(new Error('KV unavailable'));

    await expect(
      dedupUpload(
        { content: 'write-outage', mimeType: 'text/plain', filename: 'write.txt' },
        FILE_ROUTE,
        writeOutage.env,
      ),
    ).resolves.toMatchObject({
      reference: { upstreamFileId: 'file_after_write_outage' },
      deduped: false,
    });
    expect(fetchCall(writeFetch, 0).url).toBe('https://api.anthropic.com/v1/files');
  });

  it('isolates identical bytes by tenant, provider account, file policy, and group', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        jsonOk({
          id: 'file_policy_a',
          type: 'file',
          mime_type: 'text/plain',
          size_bytes: 3,
          expires_at: DISTANT_FILE_EXPIRY,
        }),
      )
      .mockResolvedValueOnce(
        jsonOk({
          id: 'file_policy_b',
          type: 'file',
          mime_type: 'text/plain',
          size_bytes: 3,
          expires_at: DISTANT_FILE_EXPIRY,
        }),
      )
      .mockResolvedValueOnce(
        jsonOk({
          id: 'file_tenant_b',
          type: 'file',
          mime_type: 'text/plain',
          size_bytes: 3,
          expires_at: DISTANT_FILE_EXPIRY,
        }),
      );
    const { kv, env } = kvMock();
    const alternateRoute = {
      ...FILE_ROUTE,
      compatibleGroups: ['onboarding-visual'] as [string, ...string[]],
    };

    await dedupUpload(
      { content: 'same-bytes', mimeType: 'text/plain', filename: 'a.txt' },
      FILE_ROUTE,
      env,
    );
    await dedupUpload(
      { content: 'same-bytes', mimeType: 'text/plain', filename: 'b.txt' },
      alternateRoute,
      env,
    );
    await dedupUpload(
      { content: 'same-bytes', mimeType: 'text/plain', filename: 'tenant.txt' },
      { ...FILE_ROUTE, tenantScope: 'tenant:other' },
      env,
    );

    const firstKey = kv.put.mock.calls[0]?.[0];
    const secondKey = kv.put.mock.calls[1]?.[0];
    const thirdKey = kv.put.mock.calls[2]?.[0];
    expect(firstKey).toContain(
      `:${FILE_ROUTE.policy.name}:${FILE_ROUTE.compatibleGroups.join(',')}:`,
    );
    expect(secondKey).toContain(
      `:${alternateRoute.policy.name}:${alternateRoute.compatibleGroups.join(',')}:`,
    );
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).not.toBe(thirdKey);
  });

  it('never retains metadata past provider expiry', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(fileMetadataTtlSeconds(new Date(now + 3600_000).toISOString())).toBe(3600);
    expect(fileMetadataTtlSeconds(null)).toBe(KV_RECORD_TTL_SECONDS);
    expect(() => fileMetadataTtlSeconds(new Date(now + 60_000).toISOString())).toThrow(/too near/);
  });

  it('preserves cancellation and surfaces stale-check and upload timeouts', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    stubFetch().mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    const cached = kvMock(JSON.stringify({ fileId: 'file_cached', createdAt: 1 }));
    await expect(
      dedupUpload(
        { content: 'cached', mimeType: 'text/plain', filename: 'cached.txt' },
        FILE_ROUTE,
        cached.env,
        cancelled.signal,
      ),
    ).rejects.toMatchObject({
      inferenceError: { failureClass: 'cancelled', retryable: false },
    });

    const timedOut = new AbortController();
    timedOut.abort();
    stubFetch().mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const timedCached = kvMock(JSON.stringify({ fileId: 'file_cached', createdAt: 1 }));
    await expect(
      dedupUpload(
        { content: 'cached', mimeType: 'text/plain', filename: 'cached.txt' },
        FILE_ROUTE,
        timedCached.env,
        timedOut.signal,
      ),
    ).rejects.toMatchObject({
      inferenceError: { failureClass: 'timeout', retryable: true },
    });

    stubFetch().mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const missing = kvMock();
    await expect(
      dedupUpload(
        { content: 'missing', mimeType: 'text/plain', filename: 'missing.txt' },
        FILE_ROUTE,
        missing.env,
        timedOut.signal,
      ),
    ).rejects.toMatchObject({
      inferenceError: { failureClass: 'timeout', retryable: true },
    });
  });

  it('no KV binding → plain upload, never touches KV, deduped:false', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonOk({
        id: 'file_plain',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 4,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const out = await dedupUpload(
      { content: 'data', mimeType: 'image/png', filename: 'c.png' },
      FILE_ROUTE,
      ENV, // no FILES_KV
    );
    expect(out).toMatchObject({ reference: { upstreamFileId: 'file_plain' }, deduped: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws (caller catches) when the upload fails', async () => {
    stubFetch().mockResolvedValue(jsonOk({ error: { message: 'boom' } }, 500));
    await expect(
      dedupUpload({ content: 'd', mimeType: 'text/plain', filename: 'd.txt' }, FILE_ROUTE, ENV),
    ).rejects.toMatchObject({
      inferenceError: {
        backend: 'anthropic',
        status: 500,
        message: 'boom',
      },
    });
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
  it('prompt groups resolve through profiles to the configured model bindings', () => {
    // Group→profile pairing is registry data; model values are deploy-time
    // configuration. Production values are pinned by test/config.test.ts.
    expect(getSystemPrompt('placement', ENV).model).toBe(ENV.MODEL_FAST);
    expect(getSystemPrompt('image-selection', ENV).model).toBe(ENV.MODEL_FAST);
    expect(getSystemPrompt('proposals', ENV).model).toBe(ENV.MODEL_BALANCED);
    expect(getSystemPrompt('chat', ENV).model).toBe(ENV.MODEL_FRONTIER);
    expect(getSystemPrompt('onboarding', ENV).model).toBe(ENV.MODEL_FRONTIER);
  });

  it('pins representative fast, balanced, and frontier group routes', () => {
    expect(getSystemPrompt('chat', ENV).model).toBe('claude-opus-4-8');
    expect(getSystemPrompt('placement', ENV).model).toBe('claude-haiku-4-5');
    expect(getSystemPrompt('proposals', ENV).model).toBe('claude-sonnet-5');
  });

  it('uses low effort per page and adaptive low-to-medium effort for holistic QC', () => {
    // Placement runs on Haiku 4.5, which 400s on output_config.effort, so the
    // entry must not set it. chat/onboarding/image-selection never set it.
    expect(getSystemPrompt('placement', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('chat', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('onboarding', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('image-selection', ENV).effort).toBeUndefined();
    expect(getSystemPrompt('onboarding-batch', ENV).effort).toBe('low');
    expect(getSystemPrompt('onboarding-batch-all', ENV).effort).toBe('medium');
    expect(getSystemPrompt('onboarding-review', ENV).effort).toBe('low');
    const holisticReview = getSystemPrompt('onboarding-review-all', ENV);
    expect(holisticReview.effort).toBeUndefined();
    expect(holisticReview.adaptiveEffort).toEqual({ default: 'low', escalated: 'medium' });
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
    // Matching is by family prefix, so an UNRELEASED version inside a supporting
    // family keeps the lever instead of silently losing it to an exact-id list.
    expect(anthropic.supportsEffort('claude-opus-4-9')).toBe(true);
    expect(anthropic.supportsEffort('claude-opus-5')).toBe(true);
    expect(anthropic.supportsEffort('claude-sonnet-5-1')).toBe(true);
    expect(anthropic.supportsEffort('claude-fable-6')).toBe(true);
    // Models that 400 on output_config.effort.
    expect(anthropic.supportsEffort('claude-haiku-4-5')).toBe(false);
    expect(anthropic.supportsEffort('claude-haiku-5')).toBe(false);
    expect(anthropic.supportsEffort('claude-sonnet-4-5')).toBe(false);
    expect(anthropic.supportsEffort('gpt-5')).toBe(false);
    expect(anthropic.supportsEffort(getSystemPrompt('placement', ENV).model)).toBe(false);
  });

  it('chat.ts NEVER sends output_config.effort to an effort-UNsupported model (placement 500 guard)', async () => {
    // Minimal SSE body the worker can parse → ends the loop after one turn.
    const sse =
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

    // Caller effort is not an authority and remains absent.
    const placementForced = await bodyOf(req('placement', { effort: 'low' }));
    expect(placementForced.model).toBe('claude-haiku-4-5');
    expect(placementForced.output_config).toBeUndefined();

    // chat → Opus 4.8 with no effort set: no output_config.
    const chatBody = await bodyOf(req('chat'));
    expect(chatBody.model).toBe('claude-opus-4-8');
    expect(chatBody.output_config).toBeUndefined();

    // A caller cannot add effort to a prompt whose registry entry omits it.
    const chatEffort = await bodyOf(req('chat', { effort: 'low' }));
    expect(chatEffort.model).toBe('claude-opus-4-8');
    expect(chatEffort.output_config).toBeUndefined();
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
      lines.push(
        `event: message_start\ndata: ${JSON.stringify(anthropicMessageStart({ input_tokens: 10 }))}\n\n`,
      );
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
        push('content_block_stop', { index });
      });
      push('message_delta', { delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
      push('message_stop', {});
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
          jsonOk({
            id: match[1],
            type: 'file',
            mime_type: mimeByFileId[match[1]] || 'text/plain',
            size_bytes: 1,
            expires_at: DISTANT_FILE_EXPIRY,
          }),
        );
      }
      // The Messages stream.
      return Promise.resolve(sseResponse());
    });
    const record = body as { fileIds?: unknown };
    const upstreamIds = Array.isArray(record.fileIds) ? record.fileIds.map((id) => String(id)) : [];
    const references = await opaqueFileEnv(
      upstreamIds.map((upstreamFileId) => ({
        upstreamFileId,
        mediaType: mimeByFileId[upstreamFileId] ?? null,
      })),
      ['placement-vision'],
    );
    const routedBody = {
      ...(body as Record<string, unknown>),
      ...(upstreamIds.length > 0 ? { fileIds: references.ids } : {}),
    };
    const req = new Request('https://app-ai.test/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': 'placement',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(routedBody),
    });
    await (await handleChat(req, references.env, CORS)).text();
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
