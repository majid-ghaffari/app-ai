/**
 * Dev Claude-Code shim — translation-layer unit tests + the cred-burn GUARD.
 *
 * Two concerns:
 *
 *  1. TRANSLATION LAYER — the pure Anthropic⇄Claude-Code mapping helpers
 *     exported by scripts/dev-claude-shim.mjs (systemToString, rehydrateBlock,
 *     normalizeContent, buildPromptMessages, estimateTokens, bareToolName,
 *     stripCodeFence, usageFrom, extractFilePart). These are the risk surface:
 *     the shim's HTTP behavior is only correct if these map the wire shapes the
 *     way the worker's chat.ts / messages.ts parsers expect.
 *
 *  2. GUARD — `assertDevAiChannel(env)`: FAILS if a dev/test run has
 *     ANTHROPIC_API_BASE pointed at the real api.anthropic.com WITHOUT an
 *     explicit `AI_CHANNEL=prod` opt-in. This makes accidental credit-burn in
 *     local dev impossible: plain `wrangler dev` uses the free shim, and a dev
 *     who wants the real API must say so out loud.
 */

import { describe, it, expect } from 'vitest';

// The shim runs under Node (Buffer available); this test file is typed with the
// worker lib (no @types/node). Reach Node's Buffer through globalThis with a
// minimal structural type so the .mjs runtime shapes can be exercised without
// pulling @types/node into the worker's tsconfig.
interface NodeBufferLike {
  toString(encoding?: string): string;
}
interface NodeBufferCtor {
  from(input: string | ArrayLike<number>): NodeBufferLike;
}
const NodeBuffer = (globalThis as unknown as { Buffer: NodeBufferCtor }).Buffer;
import {
  systemToString,
  rehydrateBlock,
  normalizeContent,
  buildPromptMessages,
  estimateTokens,
  bareToolName,
  clientToolNamesFrom,
  clientToolShape,
  stripCodeFence,
  usageFrom,
  extractFilePart,
  assertDevAiChannel,
  _filesStore,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — .mjs sibling, no .d.ts; the shapes are exercised structurally.
} from '../scripts/dev-claude-shim.mjs';

// The `look_at_page` client tool's wire schema (#111), as the worker sends it in
// `body.tools`. The shim must treat it as a CLIENT tool: register it so Claude Code
// can call it, but surface-and-stop (never execute it — it runs in a browser).
const LOOK_AT_PAGE_TOOL_DEF = {
  name: 'look_at_page',
  description: 'Look at a page of the merchant’s live store: capture a screenshot.',
  input_schema: {
    type: 'object',
    properties: { page: { type: 'string', description: 'Optional page-name hint.' } },
  },
};

describe('shim translation: systemToString', () => {
  it('passes a string through', () => {
    expect(systemToString('you are terse')).toBe('you are terse');
  });
  it('joins TextBlock[] text with blank lines', () => {
    expect(
      systemToString([
        { type: 'text', text: 'base prompt' },
        { type: 'text', text: 'volatile context' },
      ]),
    ).toBe('base prompt\n\nvolatile context');
  });
  it('returns undefined for empty/absent system', () => {
    expect(systemToString(undefined)).toBeUndefined();
    expect(systemToString(null)).toBeUndefined();
  });
});

describe('shim translation: rehydrateBlock (file → inline)', () => {
  it('rehydrates a file-referenced image to a base64 image block', () => {
    _filesStore.set('file_img', {
      id: 'file_img',
      mime_type: 'image/png',
      filename: 's.png',
      data: NodeBuffer.from([1, 2, 3]),
      created_at: 'now',
    });
    const out = rehydrateBlock({ type: 'image', source: { type: 'file', file_id: 'file_img' } });
    expect(out.type).toBe('image');
    expect(out.source.type).toBe('base64');
    expect(out.source.media_type).toBe('image/png');
    expect(out.source.data).toBe(NodeBuffer.from([1, 2, 3]).toString('base64'));
    _filesStore.delete('file_img');
  });

  it('rehydrates a file-referenced plaintext document to an inline text document', () => {
    _filesStore.set('file_doc', {
      id: 'file_doc',
      mime_type: 'text/html',
      filename: 'page.html',
      data: NodeBuffer.from('<h1>hi</h1>'),
      created_at: 'now',
    });
    const out = rehydrateBlock({ type: 'document', source: { type: 'file', file_id: 'file_doc' } });
    expect(out.type).toBe('document');
    expect(out.source.type).toBe('text');
    expect(out.source.data).toBe('<h1>hi</h1>');
    _filesStore.delete('file_doc');
  });

  it('degrades an unknown file_id to a text note (never throws)', () => {
    const out = rehydrateBlock({ type: 'image', source: { type: 'file', file_id: 'nope' } });
    expect(out.type).toBe('text');
    expect(out.text).toContain('missing file nope');
  });

  it('flattens a tool_result block to text', () => {
    const out = rehydrateBlock({ type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":1}' });
    expect(out.type).toBe('text');
    expect(out.text).toContain('tool_result tu_1');
    expect(out.text).toContain('{"ok":1}');
  });
});

describe('shim translation: normalizeContent', () => {
  it('wraps a string into a single text block', () => {
    expect(normalizeContent('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });
  it('maps a block array through rehydrateBlock', () => {
    expect(normalizeContent([{ type: 'text', text: 'a' }])).toEqual([{ type: 'text', text: 'a' }]);
  });
});

describe('shim translation: buildPromptMessages', () => {
  it('yields one SDKUserMessage with a user role', async () => {
    const gen = buildPromptMessages([{ role: 'user', content: 'hi' }]);
    const first = await gen.next();
    expect(first.value.type).toBe('user');
    expect(first.value.message.role).toBe('user');
    expect(first.value.parent_tool_use_id).toBeNull();
  });

  it('folds assistant history into a text preamble before the user blocks', async () => {
    const gen = buildPromptMessages([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'my earlier answer' },
      { role: 'user', content: 'follow up' },
    ]);
    const { value } = await gen.next();
    const blocks = value.message.content;
    const preamble = blocks.find(
      (b: { type: string; text?: string }) =>
        b.type === 'text' && b.text?.includes('Conversation so far'),
    );
    expect(preamble).toBeTruthy();
    expect(preamble.text).toContain('my earlier answer');
  });
});

describe('shim translation: estimateTokens (char/4)', () => {
  it('estimates from system + message text', () => {
    // 8 chars system + 8 chars message = 16 chars / 4 = 4
    const n = estimateTokens({
      system: 'sys text',
      messages: [{ role: 'user', content: 'usr text' }],
    });
    expect(n).toBe(4);
  });
  it('never returns 0', () => {
    expect(estimateTokens({ messages: [] })).toBe(1);
  });
});

describe('shim translation: bareToolName', () => {
  it('strips the mcp__personalizer__ prefix', () => {
    expect(bareToolName('mcp__personalizer__get_store_config')).toBe('get_store_config');
  });
  it('leaves an un-prefixed name unchanged', () => {
    expect(bareToolName('get_store_config')).toBe('get_store_config');
  });
});

describe('shim client-tool bridge: look_at_page (#111)', () => {
  it('treats look_at_page as a CLIENT tool (surfaced-and-stopped, not a personalizer tool)', () => {
    // `clientToolNamesFrom` returns the bare names of the tools in `body.tools` that
    // are NOT the four personalizer server tools — i.e. the ones the shim surfaces to
    // the worker (returned in done.toolCalls) and STOPS on, rather than executing. A
    // `look_at_page` request must be picked up here so it bridges to the browser.
    const names = clientToolNamesFrom({ tools: [LOOK_AT_PAGE_TOOL_DEF] });
    expect(names).toEqual(['look_at_page']);
  });

  it('does NOT bridge the personalizer server tools (those the shim executes internally)', () => {
    // A personalizer server tool alongside look_at_page: only the CLIENT tool bridges;
    // the personalizer one is executed by the shim (its handler makes the real call).
    const names = clientToolNamesFrom({
      tools: [LOOK_AT_PAGE_TOOL_DEF, { name: 'get_store_analytics', input_schema: {} }],
    });
    expect(names).toEqual(['look_at_page']);
  });

  it('builds a permissive Zod shape from look_at_page.input_schema (optional `page`)', () => {
    // The shim registers the client tool by name with an optional-any shape per declared
    // property so the model can call it; the browser (not the shim) validates the input.
    const shape = clientToolShape(LOOK_AT_PAGE_TOOL_DEF.input_schema);
    expect(Object.keys(shape)).toEqual(['page']);
    // Each declared property becomes an optional Zod schema (parses when absent).
    expect(shape.page.isOptional()).toBe(true);
  });

  it('the bridged tool_use is surfaced with the BARE name (mcp prefix stripped)', () => {
    // When Claude Code emits the client tool it carries the SDK `mcp__client__` prefix;
    // the shim strips it so the worker sees the bare `look_at_page` in done.toolCalls.
    expect(bareToolName('mcp__client__look_at_page')).toBe('look_at_page');
  });
});

describe('shim translation: stripCodeFence', () => {
  it('unwraps a ```json fenced block to raw JSON', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('unwraps a bare ``` fence', () => {
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('leaves prose that merely contains a fence untouched', () => {
    const s = 'Here is code:\n```js\nx=1\n```\nDone.';
    expect(stripCodeFence(s)).toBe(s);
  });
  it('leaves unfenced JSON untouched', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe('shim translation: usageFrom', () => {
  it('maps SDK usage to the Anthropic usage shape', () => {
    const u = usageFrom({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 7,
      },
    });
    expect(u).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 7,
    });
  });
  it('defaults missing usage fields to 0', () => {
    expect(usageFrom({})).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe('shim translation: extractFilePart (multipart)', () => {
  it('pulls the file part out of a multipart/form-data body', () => {
    const boundary = 'BOUND';
    const body = NodeBuffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="page.html"\r\n` +
        `Content-Type: text/html\r\n\r\n` +
        `<h1>hi</h1>\r\n` +
        `--${boundary}--\r\n`,
    );
    const part = extractFilePart(body, boundary);
    expect(part).toBeTruthy();
    expect(part.filename).toBe('page.html');
    expect(part.mimeType).toBe('text/html');
    expect(part.data.toString('utf8')).toBe('<h1>hi</h1>');
  });
});

describe('shim GUARD: assertDevAiChannel (no accidental credit-burn)', () => {
  it('allows the free local shim base (127.0.0.1)', () => {
    expect(() =>
      assertDevAiChannel({ ANTHROPIC_API_BASE: 'http://127.0.0.1:8788', AI_CHANNEL: '' }),
    ).not.toThrow();
  });

  it('allows any localhost / non-anthropic base', () => {
    expect(() =>
      assertDevAiChannel({ ANTHROPIC_API_BASE: 'http://localhost:8788', AI_CHANNEL: undefined }),
    ).not.toThrow();
  });

  it('THROWS when a dev run points at api.anthropic.com without AI_CHANNEL=prod', () => {
    expect(() =>
      assertDevAiChannel({ ANTHROPIC_API_BASE: 'https://api.anthropic.com', AI_CHANNEL: '' }),
    ).toThrow(/AI_CHANNEL=prod/);
  });

  it('allows the real API when AI_CHANNEL=prod is set explicitly', () => {
    expect(() =>
      assertDevAiChannel({ ANTHROPIC_API_BASE: 'https://api.anthropic.com', AI_CHANNEL: 'prod' }),
    ).not.toThrow();
  });

  it('is case/spacing tolerant on the host match', () => {
    expect(() =>
      assertDevAiChannel({ ANTHROPIC_API_BASE: 'https://API.Anthropic.com/v1', AI_CHANNEL: '' }),
    ).toThrow();
  });
});

describe('shim GUARD: committed dev default uses the free channel', () => {
  const devVarsExample = import.meta.glob('../.dev.vars.example', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>;

  /** Parse `KEY=value` lines from a .dev.vars-style file into a plain object. */
  function parseDotEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
  }

  it('.dev.vars.example defaults ANTHROPIC_API_BASE to the local shim (free channel)', () => {
    const source = Object.values(devVarsExample)[0];
    if (!source) throw new Error('.dev.vars.example not found in the raw glob');
    const vars = parseDotEnv(source);
    expect(vars.ANTHROPIC_API_BASE, 'the committed dev default must be the free shim').toBe(
      'http://127.0.0.1:8788',
    );
    // The default must survive its own guard (no accidental prod pointer).
    expect(() => assertDevAiChannel(vars)).not.toThrow();
  });
});
