/**
 * Dev Claude-Code shim — the record/replay response cache
 * (`scripts/dev-shim-cache.mjs`, wired into `scripts/dev-claude-shim.mjs`).
 *
 * Two concerns, matching the two halves of the feature:
 *
 *  1. THE REQUEST PATH — driven through the shim's REAL router (`handleHttp`)
 *     with the Claude Code SDK mocked, because record/replay is only true end
 *     to end: a miss must reach the fulfiller and write an entry, and the
 *     repeat must reproduce the same bytes WITHOUT reaching it again. The
 *     mock's call count is the proof that a hit costs no model time. Both
 *     transports are covered — the SSE path replays a frame SEQUENCE, and that
 *     sequence is asserted event by event.
 *
 *  2. THE KEY DERIVATION — the pure `deriveCacheKey` / `normalizeRequestBody`
 *     pair. This is the correctness surface: anything that can change the
 *     answer must change the key (model, context-ID, transport, prompt text,
 *     token budget), while the values the worker mints fresh on every run and
 *     that identify nothing (a `file_id`, a `tool_use` id) must NOT — otherwise
 *     the cache cannot hit on the flows it exists for. The documented
 *     limitation that follows from that (differing image BYTES share a key
 *     unless `SHIM_CACHE_ATTACHMENT_BYTES=1`) is pinned here too, in both
 *     directions, so it can never change silently.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * The mocked Claude Code fulfiller. `calls` counts how many times the shim
 * reached the model: a cache HIT must never increment it.
 */
const fulfiller = vi.hoisted(() => ({ calls: 0, text: 'the recorded answer' }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    fulfiller.calls += 1;
    const text = fulfiller.text;
    return (async function* fulfil() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      yield {
        type: 'result',
        subtype: 'success',
        result: text,
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
    })();
  },
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
}));

import {
  handleHttp,
  cacheContextFor,
  CACHE_HEADER,
  _filesStore,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — .mjs sibling, no .d.ts; the shapes are exercised structurally.
} from '../scripts/dev-claude-shim.mjs';
import {
  CACHE_FORMAT_VERSION,
  cacheEnabled,
  cacheLabel,
  canonicalJson,
  clearCacheDirectory,
  deriveCacheKey,
  normalizeRequestBody,
  readCacheEntry,
  writeCacheEntry,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — .mjs sibling, no .d.ts; the shapes are exercised structurally.
} from '../scripts/dev-shim-cache.mjs';

// Node's Buffer / process, reached through globalThis with minimal structural
// types — this suite is typed with the worker lib, like test/dev-shim.test.ts.
interface NodeBufferLike {
  toString(encoding?: string): string;
}
interface NodeBufferCtor {
  from(input: string): NodeBufferLike;
}
const NodeBuffer = (globalThis as unknown as { Buffer: NodeBufferCtor }).Buffer;
const nodeProcess = (
  globalThis as unknown as { process: { env: Record<string, string | undefined> } }
).process;

/** Cache root for this suite — under the gitignored `.dev-cache/`, wiped per test. */
const CACHE_DIRECTORY = '.dev-cache/vitest-dev-shim-cache';

// ── Fake http.IncomingMessage / http.ServerResponse ──────────────────────────

/** The minimal `http.IncomingMessage` surface `handleHttp` touches. */
function fakeRequest(method: string, url: string, body: string, headers: Record<string, string>) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      yield NodeBuffer.from(body);
    },
  };
}

/** The captured response: status, headers, and the exact bytes written. */
interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  /** Headers set BEFORE the head was written, which `writeHead` then merges. */
  preset: Record<string, string>;
  headersSent: boolean;
  readonly body: string;
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(chunk?: string): void;
}

function fakeResponse(): CapturedResponse {
  const chunks: string[] = [];
  return {
    status: 0,
    headers: {},
    preset: {},
    headersSent: false,
    get body() {
      return chunks.join('');
    },
    setHeader(name, value) {
      this.preset[name] = value;
    },
    // Node merges `setHeader` values into the head it writes, with the
    // `writeHead` argument winning on a collision. The fake does the same, so a
    // header the shim sets before fulfilment is observable on the sent response.
    writeHead(status, headers) {
      this.status = status;
      this.headers = { ...this.preset, ...headers };
      this.headersSent = true;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
    },
  };
}

/** POST one body to the shim's real router and capture what it wrote. */
async function postMessages(body: unknown): Promise<CapturedResponse> {
  const response = fakeResponse();
  await handleHttp(
    fakeRequest('POST', '/v1/messages', JSON.stringify(body), {
      'content-type': 'application/json',
    }),
    response,
  );
  return response;
}

/** GET the shim's status endpoint through the real router. */
async function getHealth(): Promise<{ response: CapturedResponse; payload: HealthPayload }> {
  const response = fakeResponse();
  await handleHttp(fakeRequest('GET', '/health', '', {}), response);
  return { response, payload: JSON.parse(response.body) as HealthPayload };
}

/** What `GET /health` reports about the cache. */
interface HealthPayload {
  status: string;
  fulfiller: string;
  cache: {
    enabled: boolean;
    directory: string | null;
    attachmentIdentity: string | null;
    hits: number;
    misses: number;
    recorded: number;
    recordFailures: number;
  };
}

/** The `event:` names of an SSE payload, in order. */
function sseEventSequence(payload: string): string[] {
  return payload
    .split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length));
}

/** A tool-free non-stream request body; `text` is the only thing that varies. */
function messagesBody(text: string): Record<string, unknown> {
  return {
    model: 'claude-opus-4-8',
    max_tokens: 256,
    system: [{ type: 'text', text: 'you are terse' }],
    messages: [{ role: 'user', content: text }],
  };
}

beforeEach(() => {
  clearCacheDirectory(CACHE_DIRECTORY);
  fulfiller.calls = 0;
  fulfiller.text = 'the recorded answer';
  nodeProcess.env.SHIM_CACHE_DIR = CACHE_DIRECTORY;
  delete nodeProcess.env.SHIM_CACHE;
  delete nodeProcess.env.SHIM_CACHE_ATTACHMENT_BYTES;
});

afterAll(() => {
  clearCacheDirectory(CACHE_DIRECTORY);
  delete nodeProcess.env.SHIM_CACHE_DIR;
  delete nodeProcess.env.SHIM_CACHE;
  delete nodeProcess.env.SHIM_CACHE_ATTACHMENT_BYTES;
});

describe('shim cache: the switch (on by default, an opt-OUT)', () => {
  it('is on unless SHIM_CACHE opts out, in the shim\u2019s own falsy spellings', () => {
    expect(cacheEnabled({}), 'caching is what an unconfigured shim does').toBe(true);
    expect(cacheEnabled({ SHIM_CACHE: '' })).toBe(true);
    expect(cacheEnabled({ SHIM_CACHE: '1' })).toBe(true);
    expect(cacheEnabled({ SHIM_CACHE: 'true' })).toBe(true);
    expect(cacheEnabled({ SHIM_CACHE: 'YES' })).toBe(true);
    expect(cacheEnabled({ SHIM_CACHE: 'on' })).toBe(true);
    expect(cacheEnabled({ SHIM_CACHE: '0' })).toBe(false);
    expect(cacheEnabled({ SHIM_CACHE: 'false' })).toBe(false);
    expect(cacheEnabled({ SHIM_CACHE: 'NO' })).toBe(false);
    expect(cacheEnabled({ SHIM_CACHE: 'off' })).toBe(false);
  });

  it('records nothing and replays nothing once SHIM_CACHE opts out', async () => {
    nodeProcess.env.SHIM_CACHE = '0';
    const body = messagesBody('what is my conversion rate?');
    await postMessages(body);
    await postMessages(body);

    expect(fulfiller.calls, 'both identical calls reached the model').toBe(2);
    const key = deriveCacheKey({
      body,
      model: 'claude-opus-4-8',
      contextId: '',
      transport: 'messages',
    });
    expect(readCacheEntry(CACHE_DIRECTORY, key, 'messages')).toBeNull();
  });
});

describe('shim cache: non-stream record → replay', () => {
  it('a miss records the fulfilment; the repeat replays it byte-identically, model untouched', async () => {
    const body = messagesBody('what is my conversion rate?');

    const recorded = await postMessages(body);
    expect(fulfiller.calls, 'the miss reaches the model').toBe(1);
    expect(recorded.status).toBe(200);

    // The entry is on disk, under the key the shim derives for this request.
    const key = deriveCacheKey({
      body,
      model: 'claude-opus-4-8',
      contextId: '',
      transport: 'messages',
    });
    const entry = readCacheEntry(CACHE_DIRECTORY, key, 'messages');
    expect(entry, 'the miss wrote an entry').toBeTruthy();
    expect(entry.transport).toBe('messages');
    expect(entry.model).toBe('claude-opus-4-8');
    expect(entry.label).toBe('what is my conversion rate?');

    // Change what the model WOULD say, to prove the repeat never asked it.
    fulfiller.text = 'a different answer the replay must not contain';
    const replayed = await postMessages(body);

    expect(fulfiller.calls, 'the hit costs no model time').toBe(1);
    expect(replayed.body, 'byte-identical replay').toBe(recorded.body);
    expect(replayed.status).toBe(recorded.status);
    expect(replayed.body).toContain('the recorded answer');

    // The PAYLOAD headers are identical — but the cache marker is not, and must
    // not be: the answer is byte-for-byte the recorded one, so the marker is the
    // caller's only way to tell it apart from a fresh fulfilment.
    const withoutMarker = (headers: Record<string, string>) => {
      const rest = { ...headers };
      delete rest[CACHE_HEADER];
      return rest;
    };
    expect(withoutMarker(replayed.headers)).toEqual(withoutMarker(recorded.headers));
    expect(recorded.headers[CACHE_HEADER]).toBe('miss');
    expect(replayed.headers[CACHE_HEADER], 'a replay says so on the response').toBe('hit');
  });

  it('a changed prompt misses and records its own entry — never reuses the neighbour', async () => {
    const first = messagesBody('what is my conversion rate?');
    const second = messagesBody('what is my average order value?');

    const firstRecorded = await postMessages(first);
    expect(fulfiller.calls).toBe(1);

    fulfiller.text = 'the OTHER answer';
    const secondRecorded = await postMessages(second);
    expect(fulfiller.calls, 'the changed prompt reached the model rather than reusing').toBe(2);
    expect(secondRecorded.body).toContain('the OTHER answer');
    expect(secondRecorded.body).not.toBe(firstRecorded.body);

    // Each prompt replays ITS OWN recording, not the most recent one.
    fulfiller.text = 'never served';
    expect((await postMessages(first)).body).toBe(firstRecorded.body);
    expect((await postMessages(second)).body).toBe(secondRecorded.body);
    expect(fulfiller.calls).toBe(2);
  });
});

describe('shim cache: a run says out loud whether it cost model time', () => {
  it('logs MISS + RECORD on the first call and HIT on the repeat, in the shim log idiom', async () => {
    const body = messagesBody('was this answer free?');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      await postMessages(body);
      await postMessages(body);
    } finally {
      spy.mockRestore();
    }

    const cacheLines = lines.filter((line) => line.includes('cache '));
    expect(cacheLines).toHaveLength(3);
    expect(cacheLines[0]).toMatch(
      /^\[dev-claude-shim\] cache MISS messages [0-9a-f]{12} — fulfilling via Claude Code \(costs model time\)$/,
    );
    expect(cacheLines[1]).toMatch(/^\[dev-claude-shim\] cache RECORD messages [0-9a-f]{12} → /);
    expect(cacheLines[2]).toMatch(
      /^\[dev-claude-shim\] cache HIT messages [0-9a-f]{12} — replaying recorded response \(no model time\)$/,
    );
    // The MISS and the HIT name the same entry, so a log reader can correlate them.
    expect(cacheLines[0]?.split(' ')[4]).toBe(cacheLines[2]?.split(' ')[4]);
  });

  it('says nothing per request once the cache is opted out of', async () => {
    nodeProcess.env.SHIM_CACHE = '0';
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      await postMessages(messagesBody('no cache here'));
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((line) => line.includes('cache '))).toEqual([]);
  });
});

describe('shim cache: a caller can tell a replay from a fresh answer without the log', () => {
  // The shim runs as its own background process, so whoever commanded a run is
  // reading a different terminal. Since the cache is ON by default, being able
  // to ask — over the wire, per response and per run — is what pays for that
  // default. These two channels are that answer.

  it('marks EVERY served response with its outcome, on both transports', async () => {
    const body = messagesBody('did this cost model time?');
    expect((await postMessages(body)).headers[CACHE_HEADER]).toBe('miss');
    expect((await postMessages(body)).headers[CACHE_HEADER]).toBe('hit');

    const streamed = { ...messagesBody('stream me'), stream: true };
    expect((await postMessages(streamed)).headers[CACHE_HEADER]).toBe('miss');
    expect((await postMessages(streamed)).headers[CACHE_HEADER]).toBe('hit');
  });

  it('marks a response `off` when the cache is opted out of, never leaving it unmarked', async () => {
    nodeProcess.env.SHIM_CACHE = '0';
    expect((await postMessages(messagesBody('fresh please'))).headers[CACHE_HEADER]).toBe('off');
  });

  it('reports the cache state and running counts on GET /health', async () => {
    const before = (await getHealth()).payload.cache;
    expect(before.enabled).toBe(true);
    expect(before.directory).toBe(CACHE_DIRECTORY);
    expect(before.attachmentIdentity).toBe('placeholder');

    const body = messagesBody('count me');
    await postMessages(body);
    await postMessages(body);
    await postMessages(body);

    // Deltas, not absolutes: the counts are per PROCESS and never reset, which
    // is exactly what lets a harness read /health either side of a run and say
    // how many of that run's model calls were answered from disk.
    const after = (await getHealth()).payload.cache;
    expect(after.misses - before.misses, 'one call reached the model').toBe(1);
    expect(after.recorded - before.recorded, 'and was recorded').toBe(1);
    expect(after.hits - before.hits, 'the other two were replayed').toBe(2);
    expect(after.recordFailures - before.recordFailures).toBe(0);
    expect(fulfiller.calls).toBe(1);
  });

  it('reports the cache as disabled once it is opted out of', async () => {
    nodeProcess.env.SHIM_CACHE = '0';
    const { payload } = await getHealth();
    expect(payload.status).toBe('ok');
    expect(payload.cache.enabled).toBe(false);
    expect(payload.cache.directory, 'no directory to point a reader at').toBeNull();
    expect(payload.cache.attachmentIdentity).toBeNull();
  });
});

describe('shim cache: streaming (SSE) record → replay', () => {
  const streamBody = { ...messagesBody('stream me an answer'), stream: true };

  it('replays the recorded frame SEQUENCE, not one concatenated blob', async () => {
    const recorded = await postMessages(streamBody);
    expect(fulfiller.calls).toBe(1);
    const liveSequence = sseEventSequence(recorded.body);
    expect(liveSequence).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    fulfiller.text = 'a different answer the replay must not contain';
    const replayed = await postMessages(streamBody);

    expect(fulfiller.calls, 'the hit costs no model time').toBe(1);
    expect(replayed.body, 'byte-identical stream replay').toBe(recorded.body);
    expect(sseEventSequence(replayed.body)).toEqual(liveSequence);
    expect(replayed.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(replayed.status).toBe(200);
  });

  it('never serves a stream recording to a non-stream request (or the reverse)', async () => {
    await postMessages(streamBody);
    expect(fulfiller.calls).toBe(1);

    // The same conversation, non-stream: a different transport, so a miss.
    await postMessages(messagesBody('stream me an answer'));
    expect(fulfiller.calls, 'the non-stream request was fulfilled fresh').toBe(2);
  });
});

describe('shim cache: key derivation — what MUST change the key', () => {
  const body = messagesBody('what is my conversion rate?');
  const base = { body, model: 'claude-opus-4-8', contextId: 'ctx-1', transport: 'messages' };

  it('the model — a different fulfiller model is a different answer', () => {
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, model: 'claude-haiku-4-5' }));
  });

  it('the context-ID — the tool bridge calls a different store with it', () => {
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, contextId: 'ctx-2' }));
  });

  it('the transport — a stream recording and a JSON body are different artifacts', () => {
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, transport: 'stream' }));
  });

  it('the prompt text', () => {
    expect(deriveCacheKey(base)).not.toBe(
      deriveCacheKey({ ...base, body: messagesBody('something else entirely') }),
    );
  });

  it('the system prompt', () => {
    const restated = { ...body, system: [{ type: 'text', text: 'you are verbose' }] };
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, body: restated }));
  });

  it('the token budget and any other body member', () => {
    expect(deriveCacheKey(base)).not.toBe(
      deriveCacheKey({ ...base, body: { ...body, max_tokens: 512 } }),
    );
    expect(deriveCacheKey(base)).not.toBe(
      deriveCacheKey({ ...base, body: { ...body, output_config: { effort: 'low' } } }),
    );
  });

  it('a tool definition the model can see', () => {
    const withTool = { ...body, tools: [{ name: 'look_at_page', input_schema: {} }] };
    expect(deriveCacheKey(base)).not.toBe(deriveCacheKey({ ...base, body: withTool }));
  });

  it('the CONTENT of a tool result (normalization erases identity, never content)', () => {
    const turn = (result: string) => ({
      ...body,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_a', name: 'look', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: result }],
        },
      ],
    });
    expect(
      deriveCacheKey({ ...base, body: turn('Screenshot of the home page attached.') }),
    ).not.toBe(
      deriveCacheKey({ ...base, body: turn('Could not capture the home page right now.') }),
    );
  });
});

describe('shim cache: key derivation — the volatile identity it must ignore', () => {
  const base = { model: 'claude-opus-4-8', contextId: 'ctx-1', transport: 'messages' };

  /** The onboarding screenshot turn: a file block whose id is minted per upload. */
  function screenshotBody(fileId: string): Record<string, unknown> {
    return {
      model: 'claude-opus-4-8',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: 'review this page' },
          ],
        },
      ],
    };
  }

  it('a freshly minted file_id — the shim mints a new one per upload, every run', () => {
    expect(deriveCacheKey({ ...base, body: screenshotBody('file_dev_aaaaaaaa') })).toBe(
      deriveCacheKey({ ...base, body: screenshotBody('file_dev_bbbbbbbb') }),
    );
  });

  /**
   * The whole-store onboarding turn: twenty page tiles in one user message. The
   * only thing that varies between the two bodies is whether tiles 16 and 19
   * arrived as ONE upload or two.
   */
  function tileGalleryBody(fileIds: readonly string[]): Record<string, unknown> {
    return {
      model: 'claude-opus-4-8',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            ...fileIds.map((fileId) => ({
              type: 'image',
              source: { type: 'file', file_id: fileId },
            })),
            { type: 'text', text: 'propose the placement plan for each page above' },
          ],
        },
      ],
    };
  }

  it('whether two attachments came from ONE deduped upload or two separate ones', () => {
    // MEASURED, not hypothetical: two runs of one onboarding call differed in
    // exactly this. The worker dedupes uploads by content, so two tiles that
    // happened to render byte-identically arrived as one file_id used twice,
    // and as two ids on the next run. Numbering attachments by the IDENTITY of
    // the id shifted every later ordinal, and the warm entry could never match.
    const twenty = Array.from({ length: 20 }, (_, index) => `file_dev_${index + 1}`);
    const sharedUpload = 'file_dev_16';
    const deduped = twenty.map((fileId, index) => (index === 18 ? sharedUpload : fileId));

    expect(twenty[15], 'the id tile 19 reuses is tile 16\u2019s').toBe(sharedUpload);
    expect(deduped[18], 'tile 19 is the same upload as tile 16').toBe(deduped[15]);
    expect(deriveCacheKey({ ...base, body: tileGalleryBody(twenty) })).toBe(
      deriveCacheKey({ ...base, body: tileGalleryBody(deduped) }),
    );
  });

  it('…while a tile ADDED or REMOVED still moves every later position, and misses', () => {
    // Position is what the placeholder carries, so the gallery cannot collapse:
    // a nineteen-tile call is a different prompt from a twenty-tile one.
    const twenty = Array.from({ length: 20 }, (_, index) => `file_dev_${index + 1}`);
    expect(deriveCacheKey({ ...base, body: tileGalleryBody(twenty) })).not.toBe(
      deriveCacheKey({ ...base, body: tileGalleryBody(twenty.slice(0, 19)) }),
    );
  });

  it('freshly minted tool_use ids, while KEEPING which result answers which call', () => {
    const conversation = (firstId: string, secondId: string, answered: string) => ({
      model: 'claude-opus-4-8',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: firstId, name: 'look_at_page', input: { page: 'home' } },
            { type: 'tool_use', id: secondId, name: 'look_at_page', input: { page: 'cart' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: answered, content: 'ok' }] },
      ],
    });

    // Same conversation, ids re-minted: same key.
    expect(deriveCacheKey({ ...base, body: conversation('toolu_1', 'toolu_2', 'toolu_1') })).toBe(
      deriveCacheKey({ ...base, body: conversation('toolu_x', 'toolu_y', 'toolu_x') }),
    );
    // The LINKAGE still counts: answering the second call is a different turn.
    expect(
      deriveCacheKey({ ...base, body: conversation('toolu_1', 'toolu_2', 'toolu_1') }),
    ).not.toBe(deriveCacheKey({ ...base, body: conversation('toolu_1', 'toolu_2', 'toolu_2') }));
  });

  it('normalizeRequestBody replaces only those values, and never mutates its input', () => {
    const original = screenshotBody('file_dev_aaaaaaaa');
    const normalized = normalizeRequestBody(original);
    expect(JSON.stringify(normalized)).toContain('<shim-cache:file:1>');
    expect(JSON.stringify(normalized)).toContain('review this page');
    expect(JSON.stringify(original)).toContain('file_dev_aaaaaaaa');
  });
});

describe('shim cache: the attachment-bytes limitation, pinned in both directions', () => {
  const base = { model: 'claude-opus-4-8', contextId: 'ctx-1', transport: 'messages' };

  function inlineImageBody(data: string): Record<string, unknown> {
    return {
      model: 'claude-opus-4-8',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            { type: 'text', text: 'what is on this page?' },
          ],
        },
      ],
    };
  }

  it('by DEFAULT two calls differing only in image bytes share a key — the documented limitation', () => {
    expect(deriveCacheKey({ ...base, body: inlineImageBody('AAAA') })).toBe(
      deriveCacheKey({ ...base, body: inlineImageBody('BBBB') }),
    );
  });

  it('SHIM_CACHE_ATTACHMENT_BYTES=1 keys on the bytes, so varying the image misses', () => {
    const strict = { ...base, attachmentIdentity: 'digest' };
    expect(deriveCacheKey({ ...strict, body: inlineImageBody('AAAA') })).not.toBe(
      deriveCacheKey({ ...strict, body: inlineImageBody('BBBB') }),
    );
    // Identical bytes still hit under the strict rule.
    expect(deriveCacheKey({ ...strict, body: inlineImageBody('AAAA') })).toBe(
      deriveCacheKey({ ...strict, body: inlineImageBody('AAAA') }),
    );
  });

  it('the two modes never read each other’s entries', () => {
    expect(deriveCacheKey({ ...base, body: inlineImageBody('AAAA') })).not.toBe(
      deriveCacheKey({ ...base, body: inlineImageBody('AAAA'), attachmentIdentity: 'digest' }),
    );
  });

  it('an unresolvable file_id under the strict rule keys on the raw id (fails toward a miss)', () => {
    const strict = { ...base, attachmentIdentity: 'digest', attachmentBytes: () => null };
    const body = (fileId: string) => ({
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: fileId } }] },
      ],
    });
    expect(deriveCacheKey({ ...strict, body: body('file_dev_a') })).not.toBe(
      deriveCacheKey({ ...strict, body: body('file_dev_b') }),
    );
  });
});

describe('shim cache: what the shim itself feeds the key derivation', () => {
  /** A file block referencing an id in the shim's own in-memory Files store. */
  function uploadedImageBody(fileId: string): Record<string, unknown> {
    return {
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'file', file_id: fileId } },
            { type: 'text', text: 'review this page' },
          ],
        },
      ],
    };
  }

  it('returns no context at all once the cache is opted out of', () => {
    nodeProcess.env.SHIM_CACHE = '0';
    expect(cacheContextFor(messagesBody('anything'), '', 'messages')).toBeNull();
  });

  it('fills in the shim default model when the request omits one', () => {
    const withoutModel = { max_tokens: 256, messages: [{ role: 'user', content: 'hello' }] };
    const defaulted = cacheContextFor(withoutModel, '', 'messages').key;

    // Same body, same default: same key.
    expect(cacheContextFor(withoutModel, '', 'messages').key).toBe(defaulted);
    // A request that names a model other than the default keys differently, so
    // the default can never be silently served for an explicit choice.
    expect(
      cacheContextFor({ ...withoutModel, model: 'not-the-shim-default-model' }, '', 'messages').key,
    ).not.toBe(defaulted);
    // The context-ID the router resolved is part of the key.
    expect(cacheContextFor(withoutModel, 'ctx-9', 'messages').key).not.toBe(defaulted);
  });

  it('resolves uploaded file bytes out of the shim Files store under the strict rule', () => {
    nodeProcess.env.SHIM_CACHE_ATTACHMENT_BYTES = '1';
    const stored = (id: string, bytes: string) =>
      _filesStore.set(id, {
        id,
        mime_type: 'image/png',
        filename: 's.png',
        data: NodeBuffer.from(bytes),
        created_at: 'now',
      });
    stored('file_dev_first', 'AAAA');
    stored('file_dev_second', 'BBBB');
    stored('file_dev_third', 'AAAA');
    try {
      const first = cacheContextFor(uploadedImageBody('file_dev_first'), '', 'messages').key;
      const second = cacheContextFor(uploadedImageBody('file_dev_second'), '', 'messages').key;
      const third = cacheContextFor(uploadedImageBody('file_dev_third'), '', 'messages').key;
      expect(second, 'different bytes are a different question').not.toBe(first);
      expect(third, 'the same bytes under a re-minted id are the same question').toBe(first);
    } finally {
      _filesStore.delete('file_dev_first');
      _filesStore.delete('file_dev_second');
      _filesStore.delete('file_dev_third');
    }
  });
});

describe('shim cache: canonical JSON', () => {
  it('is insensitive to member ORDER (the same JSON value is the same key)', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
  it('is sensitive to array order (message order changes the answer)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it('round-trips nested structures deterministically', () => {
    expect(canonicalJson({ z: [{ y: 1, x: 2 }], a: null })).toBe('{"a":null,"z":[{"x":2,"y":1}]}');
  });
});

describe('shim cache: an entry that cannot be trusted is a miss, out loud', () => {
  const key = 'a'.repeat(64);

  function reasonFor(entry: Record<string, unknown>, transport: string): string {
    writeCacheEntry(CACHE_DIRECTORY, key, entry);
    let reason = '';
    const read = readCacheEntry(CACHE_DIRECTORY, key, transport, (why: string) => {
      reason = why;
    });
    expect(read, 'an untrusted entry is never served').toBeNull();
    return reason;
  }

  const good = {
    cacheFormat: CACHE_FORMAT_VERSION,
    key,
    transport: 'messages',
    model: 'claude-opus-4-8',
    response: { content: [] },
  };

  it('serves a well-formed entry', () => {
    writeCacheEntry(CACHE_DIRECTORY, key, good);
    expect(readCacheEntry(CACHE_DIRECTORY, key, 'messages')).toBeTruthy();
  });

  it('rejects an entry recorded under another cacheFormat, and says so', () => {
    expect(reasonFor({ ...good, cacheFormat: 99 }, 'messages')).toContain('cacheFormat');
  });

  it('rejects an entry whose declared key is not the one asked for', () => {
    expect(reasonFor({ ...good, key: 'b'.repeat(64) }, 'messages')).toContain('declares key');
  });

  it('rejects a recording made for the other transport', () => {
    expect(reasonFor(good, 'stream')).toContain('stream');
  });

  it('rejects a non-stream entry with no response body', () => {
    expect(reasonFor({ ...good, response: null }, 'messages')).toContain('no response body');
  });

  it('rejects a stream entry with no frames', () => {
    expect(reasonFor({ ...good, transport: 'stream', frames: [] }, 'stream')).toContain(
      'no frames',
    );
  });

  it('an absent entry is simply a miss', () => {
    expect(readCacheEntry(CACHE_DIRECTORY, 'f'.repeat(64), 'messages')).toBeNull();
  });
});

describe('shim cache: the entry label (advisory triage only)', () => {
  it('takes the last user turn, squeezed onto one line', () => {
    expect(
      cacheLabel({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: ' a\n  b ' },
        ],
      }),
    ).toBe('a b');
  });
  it('reads text blocks out of a block array', () => {
    expect(
      cacheLabel({ messages: [{ role: 'user', content: [{ type: 'text', text: 'block text' }] }] }),
    ).toBe('block text');
  });
  it('is empty when there is no text to show', () => {
    expect(cacheLabel({})).toBe('');
  });
});
