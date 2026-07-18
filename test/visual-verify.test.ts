/**
 * Coverage for the `visual-verify` prompt — the UNIFIED quality-gate reasoner
 * used by BOTH the internal test harness (free Claude-Code channel) and the
 * product's own customer-side self-verify-and-fix loop:
 *   • the registry resolves `visual-verify` (text + metadata + model = Sonnet);
 *   • the prompt text names its multi-modal input + `{ pass, reason, fix }`
 *     output contract;
 *   • `POST /messages` routes the `X-Personalizer-System-Prompt: visual-verify`
 *     header to the prompt (injects its system block, no attachments) and
 *     defaults the model to the `balanced` tier when the body omits it;
 *   • the output contract is asserted via a schema/parse check on a
 *     representative assistant verdict (pass, fail-with-fix, fail-no-fix).
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { getSystemPrompt, isProbeName } from '../src/prompt-registry';
import { handleMessages } from '../src/handlers/messages';
import { ENV, CORS, stubFetch, fetchCall, sentBody } from './helpers';

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

afterEach(() => vi.restoreAllMocks());

describe('visual-verify registry', () => {
  it('resolves `visual-verify` with its text + metadata + the `balanced` tier (Sonnet)', () => {
    const entry = getSystemPrompt('visual-verify', ENV);
    // The multi-modal judge runs on the `balanced` tier (Sonnet), NOT the default
    // `frontier` tier.
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    // One-shot JSON — no tools, no bundled attachments (the caller uploads the
    // rendered snapshot's screenshot + HTML per request).
    expect(entry.usesTools).toBe(false);
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
  });

  it('is NOT a `probe-<id>` name — a cross-side capability, not a Website-Analysis probe', () => {
    expect(isProbeName('visual-verify')).toBe(false);
  });

  it('the prompt text names its multi-modal input + verdict output contract', () => {
    const entry = getSystemPrompt('visual-verify', ENV);
    expect(entry.prompt).toMatch(/visual verification/i);
    expect(entry.prompt).toMatch(/JSON/i);
    // Multi-modal input — all four modalities named.
    expect(entry.prompt).toMatch(/screenshot/i);
    expect(entry.prompt).toMatch(/html|DOM/i);
    expect(entry.prompt).toMatch(/console/i);
    expect(entry.prompt).toMatch(/inspection/i);
    expect(entry.prompt).toMatch(/elementFromPoint|hit-test|hitTestAtCenter/i);
    expect(entry.prompt).toMatch(/rect|getBoundingClientRect/i);
    // The plain-language claim.
    expect(entry.prompt).toMatch(/intent/i);
    // Output contract keys.
    expect(entry.prompt).toMatch(/"pass"/);
    expect(entry.prompt).toMatch(/"reason"/);
    expect(entry.prompt).toMatch(/"fix"/);
    // Pixels-win-ties — the whole point (catch false-greens).
    expect(entry.prompt).toMatch(/pixels/i);
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getSystemPrompt('visual-verify-nope', ENV)).toThrow(/not found/i);
  });
});

describe('POST /messages — visual-verify routing', () => {
  function messagesRequest(body: unknown, systemPrompt: string): Request {
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': systemPrompt,
      },
      body: JSON.stringify(body),
    });
  }

  it('injects the visual-verify system block + defaults the model to the `balanced` tier', async () => {
    const fetchMock = stubFetch();
    // Fresh Response per call so the count_tokens pre-flight and the real
    // /messages POST each read their own body (a shared Response can only be
    // read once).
    fetchMock.mockImplementation(async () => jsonOk({ content: [], input_tokens: 0 }));

    await handleMessages(
      // Body WITHOUT `model` — the verify transport omits it so the registry is
      // authoritative (visual-verify → the `balanced` tier).
      messagesRequest(
        {
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'file', file_id: 'shot_1' } },
                { type: 'document', source: { type: 'file', file_id: 'html_1' } },
                { type: 'text', text: 'intent: the box is highlighted' },
              ],
            },
          ],
        },
        'visual-verify',
      ),
      ENV,
      CORS,
    );

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // No attachments → no /files upload (the caller uploads evidence itself).
    expect(urls.some((url) => url.includes('/files'))).toBe(false);
    const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const sent = sentBody(fetchCall(fetchMock, idx).init);
    expect(sent.system?.[0]?.type).toBe('text');
    expect(sent.system?.[0]?.text).toMatch(/visual verification/i);
    expect(sent.model).toBe(ENV.MODEL_BALANCED);
    // The caller's evidence content blocks flow through untouched.
    expect(Array.isArray(sent.messages?.[0]?.content)).toBe(true);
  });

  it('returns the Anthropic envelope with the assistant verdict JSON unchanged', async () => {
    const verdict = JSON.stringify({
      pass: false,
      reason:
        'The box is not highlighted — the screenshot shows a uniformly dimmed page and hitTestAtCenter is false, so a scrim covers it.',
      fix: { action: 'retrySpotlight', args: { target: "[data-box-type='BoughtTogether']" } },
    });
    stubFetch().mockResolvedValue(jsonOk({ content: [{ type: 'text', text: verdict }] }));

    const res = await handleMessages(
      messagesRequest(
        { max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'visual-verify',
      ),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe(verdict);
  });
});

describe('visual-verify output contract', () => {
  /** Assert an object satisfies the frozen `{ pass, reason, fix }` shape. */
  function assertVerdictShape(value: unknown): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const obj = value as Record<string, unknown>;
    // Exactly the three contract keys — no extras, no missing.
    expect(Object.keys(obj).sort()).toEqual(['fix', 'pass', 'reason']);
    expect(typeof obj.pass).toBe('boolean');
    expect(typeof obj.reason).toBe('string');
    expect((obj.reason as string).length).toBeGreaterThan(0);
    // `fix` is either null OR an `{ action: string, args: object }` directive.
    if (obj.fix !== null) {
      const fix = obj.fix as Record<string, unknown>;
      expect(typeof fix.action).toBe('string');
      expect((fix.action as string).length).toBeGreaterThan(0);
      expect(typeof fix.args).toBe('object');
      expect(fix.args).not.toBeNull();
    }
  }

  it('parses a passing verdict (fix: null)', () => {
    const verdict = JSON.stringify({
      pass: true,
      reason:
        'The cart drawer is visibly open as a slide-in panel; its rect is on-screen and non-zero, hitTestAtCenter is true, and no relevant console errors are present.',
      fix: null,
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('parses a failing verdict carrying a concrete fix directive', () => {
    const verdict = JSON.stringify({
      pass: false,
      reason: 'The box did not paint — its rect is 0×0 even though the element exists in the DOM.',
      fix: { action: 'reRender', args: {} },
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('rejects a verdict missing a contract key', () => {
    const bad = JSON.parse(JSON.stringify({ pass: true, reason: 'ok' }));
    expect(() => assertVerdictShape(bad)).toThrow();
  });

  it('rejects a non-boolean pass', () => {
    const bad = JSON.parse(JSON.stringify({ pass: 'yes', reason: 'ok', fix: null }));
    expect(() => assertVerdictShape(bad)).toThrow();
  });

  it('rejects an empty reason', () => {
    const bad = JSON.parse(JSON.stringify({ pass: true, reason: '', fix: null }));
    expect(() => assertVerdictShape(bad)).toThrow();
  });

  it('rejects a fix missing its action', () => {
    const bad = JSON.parse(JSON.stringify({ pass: false, reason: 'nope', fix: { args: {} } }));
    expect(() => assertVerdictShape(bad)).toThrow();
  });
});
