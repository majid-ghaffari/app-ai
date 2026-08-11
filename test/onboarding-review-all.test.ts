/**
 * Coverage for the `onboarding-review-all` prompt — the WHOLE-STORE REVIEW twin of
 * `onboarding-batch-all`. Given SEVERAL applied pages,
 * each at BOTH widths (desktop + mobile after-render screenshots) + a per-page manifest
 * (which images + applied plan belong to which page), it returns ONE JSON object mapping
 * each page name to that page's verdict `{ pass, feedback, corrections, failureClass }` —
 * the SAME per-page shape `onboarding-review` emits, all pages at once. It mirrors
 * `onboarding-review` (a multi-modal judge whose truth is the pixels) but collapses N
 * per-page review round-trips into one. Structured output (usesTools: false, no
 * clientTools), header-selected on POST /messages, Sonnet (`balanced` tier). Asserts:
 *   • the registry resolves `onboarding-review-all` with the `balanced` tier (Sonnet), no tools,
 *     no attachments, and a big enough maxTokens for the whole-store payload;
 *   • the prompt text names its whole-store input (manifest + per-page desktop+mobile
 *     screenshots + applied plans), the per-page verdict contract, the placement /
 *     styling classification, the three allowed correction verbs, and the `pages` output;
 *   • POST /messages routes the header to the prompt (injects the system block, no /files
 *     upload) and defaults the model to the `balanced` tier;
 *   • the WHOLE-STORE output contract is asserted via a parse/validate check across a
 *     multi-page verdict object mixing pass + placement + styling pages — the EXACT shape
 *     the lib's `sanitizeMultiPageReviewResult` parses ({ pages: { <page>: verdict } }).
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

/** The three allowed correction actions — the existing write verbs, no new ones. */
const CORRECTION_ACTIONS = ['styleBox', 'removeBox', 'addBox'];
/** The valid failureClass values (null is also allowed). */
const FAILURE_CLASSES = ['placement', 'styling'];

describe('onboarding-review-all registry entry', () => {
  it('resolves with the `balanced` tier (Sonnet), no tools, no attachments, whole-store maxTokens', () => {
    const entry = getSystemPrompt('onboarding-review-all', ENV);
    // The multi-modal judge runs on the `balanced` tier (Sonnet), like `onboarding-review`.
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    // Structured output — one-shot JSON, no server tools, no CLIENT tools.
    expect(entry.usesTools).toBe(false);
    expect(entry.clientTools).toBeUndefined();
    // No bundled attachments — the lib uploads every page's after-render screenshots per run.
    expect(entry.attachments).toEqual([]);
    // Whole-store payload needs more output room than the single-page review (2048).
    const singlePage = getSystemPrompt('onboarding-review', ENV);
    expect(entry.maxTokens).toBeGreaterThan(singlePage.maxTokens);
    expect(entry.effort).toBe('medium');
  });

  it('is NOT a `probe-<id>` name — an onboarding step, not a Website-Analysis probe', () => {
    expect(isProbeName('onboarding-review-all')).toBe(false);
  });

  it('the prompt names its whole-store input, verdict contract, classification, and write verbs', () => {
    const entry = getSystemPrompt('onboarding-review-all', ENV);
    // JSON-only structured output.
    expect(entry.prompt).toMatch(/JSON/i);
    // Whole-store input: a MANIFEST + per-page desktop + mobile after-render screenshots + plans.
    expect(entry.prompt).toMatch(/manifest/i);
    expect(entry.prompt).toMatch(/screenshot/i);
    expect(entry.prompt).toMatch(/plan/i);
    expect(entry.prompt).toMatch(/desktop/i);
    expect(entry.prompt).toMatch(/mobile/i);
    // Whole-store framing — every / all pages in one call.
    expect(entry.prompt).toMatch(/whole store|whole-store|all pages|every page|each page/i);
    // Mobile is first-class; a page passes only if BOTH widths pass.
    expect(entry.prompt).toMatch(/both widths|BOTH widths/);
    expect(entry.prompt).toMatch(/only if.*both|both.*only|either width/i);
    expect(entry.prompt).toMatch(/majority/i);
    // Pixels are the source of truth.
    expect(entry.prompt).toMatch(/pixels/i);
    // The WHOLE-STORE output contract: a top-level `pages` map + the per-page verdict keys.
    expect(entry.prompt).toMatch(/"pages"|`pages`/);
    expect(entry.prompt).toMatch(/"pass"/);
    expect(entry.prompt).toMatch(/"feedback"/);
    expect(entry.prompt).toMatch(/"corrections"/);
    expect(entry.prompt).toMatch(/"failureClass"/);
    // The crucial classification — both failure classes + non-critical/critical.
    expect(entry.prompt).toMatch(/placement/);
    expect(entry.prompt).toMatch(/styling/);
    expect(entry.prompt).toMatch(/non-critical/i);
    expect(entry.prompt).toMatch(/critical/i);
    // The three allowed correction actions — no new mutation types.
    for (const action of CORRECTION_ACTIONS) expect(entry.prompt).toContain(action);
    // addBox re-places by a numbered section: position (before/after/replace) + anchorNumber.
    expect(entry.prompt).toMatch(/anchorNumber/);
    expect(entry.prompt).toMatch(/position/);
    expect(entry.prompt).toMatch(/before/);
    expect(entry.prompt).toMatch(/after/);
    expect(entry.prompt).toMatch(/replace/);
    expect(entry.prompt).not.toMatch(/anchorIndex/);
    // A mobile-only styling break is fixable via appearancePatchMobile (2 mobile knobs).
    expect(entry.prompt).toMatch(/appearancePatchMobile/);
    expect(entry.prompt).toMatch(/ImageHeightMobile/);
    expect(entry.prompt).toMatch(/MarginRightMobile/);
    // A one-width (mobile) break is a CRITICAL styling fail.
    expect(entry.prompt).toMatch(/mobile[- ]only|one width|ONE width/i);
    // Each page is judged on its own — one page's verdict never affects another's.
    expect(entry.prompt).toMatch(/each page on its own|its own evidence|own evidence/i);
  });

  it('hardens output reliability with an explicit JSON-only final instruction', () => {
    const entry = getSystemPrompt('onboarding-review-all', ENV);
    // The final hardening line: ONLY the JSON object, no prose/markdown fences.
    expect(entry.prompt).toMatch(/ONLY the JSON object/i);
    expect(entry.prompt).toMatch(/no (prose|explanation)/i);
    expect(entry.prompt).toMatch(/code fences?/i);
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getSystemPrompt('onboarding-review-all-nope', ENV)).toThrow(/not found/i);
  });
});

describe('POST /messages — onboarding-review-all routing', () => {
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

  it('injects the onboarding-review-all system block + defaults the model to the `balanced` tier', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [], input_tokens: 0 }));

    await handleMessages(
      // Body WITHOUT `model` — the transport omits it so the registry is authoritative
      // (onboarding-review-all → the `balanced` tier).
      messagesRequest(
        {
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                // Every page's after-render tiles (desktop + mobile), concatenated.
                { type: 'image', source: { type: 'file', file_id: 'home_desktop' } },
                { type: 'image', source: { type: 'file', file_id: 'home_mobile' } },
                { type: 'image', source: { type: 'file', file_id: 'product_desktop' } },
                { type: 'image', source: { type: 'file', file_id: 'product_mobile' } },
                {
                  type: 'text',
                  text:
                    'PAGE Home: DESKTOP TILES images 1-1, MOBILE TILES images 2-2, APPLIED PLAN {…}\n' +
                    'PAGE Product: DESKTOP TILES images 3-3, MOBILE TILES images 4-4, APPLIED PLAN {…}\n' +
                    'Review the rendered page for EACH page listed above.',
                },
              ],
            },
          ],
        },
        'onboarding-review-all',
      ),
      ENV,
      CORS,
    );

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // No attachments → no /files upload (the lib uploads the screenshots itself).
    expect(urls.some((url) => url.includes('/files'))).toBe(false);
    expect(urls.some((url) => url.includes('/count_tokens'))).toBe(false);
    const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const sent = sentBody(fetchCall(fetchMock, idx).init);
    expect(sent.system?.[0]?.type).toBe('text');
    expect(sent.system?.[0]?.text).toMatch(/onboarding/i);
    expect(sent.model).toBe(ENV.MODEL_BALANCED);
    expect(sent.output_config).toEqual({ effort: 'medium' });
    expect(Array.isArray(sent.messages?.[0]?.content)).toBe(true);
  });

  it('returns the Anthropic envelope with the assistant whole-store verdict JSON unchanged', async () => {
    const verdict = JSON.stringify({
      pages: {
        Home: {
          pass: true,
          feedback: 'Home looks good at both widths.',
          corrections: [],
          failureClass: null,
        },
        Product: {
          pass: false,
          feedback: 'BoughtTogether clashes with the store cards.',
          corrections: [
            {
              action: 'styleBox',
              args: {
                page: 'Product',
                boxType: 'BoughtTogether',
                appearancePatch: { ImageBorderRadius: 0, NavigationArrowType: 'none' },
              },
            },
          ],
          failureClass: 'styling',
        },
      },
    });
    stubFetch().mockResolvedValue(jsonOk({ content: [{ type: 'text', text: verdict }] }));

    const res = await handleMessages(
      messagesRequest(
        { max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'onboarding-review-all',
      ),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe(verdict);
  });
});

describe('onboarding-review-all output contract (whole-store)', () => {
  /** Assert a per-page verdict object satisfies the frozen review shape. */
  function assertVerdictShape(value: unknown): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const obj = value as Record<string, unknown>;
    // Exactly the four contract keys — no extras, no missing.
    expect(Object.keys(obj).sort()).toEqual(['corrections', 'failureClass', 'feedback', 'pass']);
    // pass is a boolean.
    expect(typeof obj.pass).toBe('boolean');
    // feedback is a non-empty string.
    expect(typeof obj.feedback).toBe('string');
    expect((obj.feedback as string).length).toBeGreaterThan(0);
    // corrections is an array of the allowed write verbs, each with an args object.
    expect(Array.isArray(obj.corrections)).toBe(true);
    for (const raw of obj.corrections as unknown[]) {
      expect(typeof raw).toBe('object');
      expect(raw).not.toBeNull();
      const correction = raw as Record<string, unknown>;
      expect(CORRECTION_ACTIONS).toContain(correction.action);
      expect(typeof correction.args).toBe('object');
      expect(correction.args).not.toBeNull();
      // Every correction's args carry the page it belongs to (so the conductor targets it).
      expect(typeof (correction.args as Record<string, unknown>).page).toBe('string');
    }
    // failureClass is null OR one of the two classes. And the pass ⇄ null invariant.
    if (obj.failureClass !== null) {
      expect(FAILURE_CLASSES).toContain(obj.failureClass);
      expect(obj.pass).toBe(false);
    } else {
      expect(obj.pass).toBe(true);
    }
  }

  /**
   * Assert the WHOLE-STORE object satisfies the `{ pages: { <page>: verdict } }` shape the
   * lib's `sanitizeMultiPageReviewResult` parses (keyed-object form — what this prompt emits).
   */
  function assertMultiPageShape(value: unknown): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const obj = value as Record<string, unknown>;
    // Exactly the one top-level key.
    expect(Object.keys(obj)).toEqual(['pages']);
    const pages = obj.pages;
    expect(typeof pages).toBe('object');
    expect(pages).not.toBeNull();
    // At least one page, and EACH value is a valid per-page verdict.
    const entries = Object.entries(pages as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(0);
    for (const [pageLabel, verdict] of entries) {
      expect(typeof pageLabel).toBe('string');
      expect(pageLabel.length).toBeGreaterThan(0);
      assertVerdictShape(verdict);
    }
  }

  it('parses a whole-store verdict mixing pass + placement + styling pages', () => {
    const verdict = JSON.stringify({
      pages: {
        Home: {
          pass: true,
          feedback:
            'Featured Collection + Recently Viewed rendered in sensible slots, matching cards.',
          corrections: [],
          failureClass: null,
        },
        Product: {
          pass: false,
          feedback:
            'BoughtTogether rendered with big rounded cards + chevron arrows that clash with the flat store cards.',
          corrections: [
            {
              action: 'styleBox',
              args: {
                page: 'Product',
                boxType: 'BoughtTogether',
                appearancePatch: { ImageBorderRadius: 0, NavigationArrowType: 'none' },
              },
            },
          ],
          failureClass: 'styling',
        },
        Collection: {
          pass: false,
          feedback:
            'Recently Viewed rendered near the top instead of the bottom; everything else fine.',
          corrections: [
            { action: 'removeBox', args: { page: 'Collection', boxType: 'RecentViews' } },
            {
              action: 'addBox',
              args: {
                page: 'Collection',
                boxType: 'RecentViews',
                position: 'after',
                anchorNumber: 5,
                appearancePatch: null,
                appearancePatchMobile: null,
              },
            },
          ],
          failureClass: 'placement',
        },
      },
    });
    assertMultiPageShape(JSON.parse(verdict));
  });

  it('parses a whole-store verdict where a page fails on mobile-only styling (fixed via appearancePatchMobile)', () => {
    const verdict = JSON.stringify({
      pages: {
        Home: {
          pass: false,
          feedback: 'The featured-collection cards are fine on desktop but far too tall on mobile.',
          corrections: [
            {
              action: 'styleBox',
              args: {
                page: 'Home',
                boxType: 'FeaturedCollection',
                appearancePatchMobile: { ImageHeightMobile: 140 },
              },
            },
          ],
          failureClass: 'styling',
        },
      },
    });
    assertMultiPageShape(JSON.parse(verdict));
  });

  it('parses a whole-store verdict where every page passes', () => {
    const verdict = JSON.stringify({
      pages: {
        Home: {
          pass: true,
          feedback: 'All good on Home at both widths.',
          corrections: [],
          failureClass: null,
        },
        Cart: {
          pass: true,
          feedback: 'All good on Cart at both widths.',
          corrections: [],
          failureClass: null,
        },
      },
    });
    assertMultiPageShape(JSON.parse(verdict));
  });

  it('rejects a whole-store object missing the top-level `pages` key', () => {
    const bad = JSON.parse(
      JSON.stringify({ Home: { pass: true, feedback: 'ok', corrections: [], failureClass: null } }),
    );
    expect(() => assertMultiPageShape(bad)).toThrow();
  });

  it('rejects a page verdict missing a contract key', () => {
    const bad = JSON.parse(
      JSON.stringify({ pages: { Home: { pass: true, feedback: 'ok', corrections: [] } } }),
    );
    expect(() => assertMultiPageShape(bad)).toThrow();
  });

  it('rejects a passing page verdict with a non-null failureClass (invariant)', () => {
    const bad = JSON.parse(
      JSON.stringify({
        pages: { Home: { pass: true, feedback: 'ok', corrections: [], failureClass: 'placement' } },
      }),
    );
    expect(() => assertMultiPageShape(bad)).toThrow();
  });

  it('rejects a failing page verdict with a null failureClass (invariant)', () => {
    const bad = JSON.parse(
      JSON.stringify({
        pages: { Home: { pass: false, feedback: 'off', corrections: [], failureClass: null } },
      }),
    );
    expect(() => assertMultiPageShape(bad)).toThrow();
  });

  it('rejects a correction using an action outside the three write verbs', () => {
    const bad = JSON.parse(
      JSON.stringify({
        pages: {
          Home: {
            pass: false,
            feedback: 'off',
            corrections: [{ action: 'reRender', args: { page: 'Home' } }],
            failureClass: 'styling',
          },
        },
      }),
    );
    expect(() => assertMultiPageShape(bad)).toThrow();
  });
});
