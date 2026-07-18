/**
 * Coverage for the Smart Progress Bar joining the WHOLE-STORE `onboarding-batch-all`
 * PROPOSE prompt (v7). The whole-store propose returns `{ pages: { <page>: { boxes,
 * progressBar? } } }`; a Cart page's plan may carry an OPTIONAL `progressBar`
 * `{ position, anchorNumber, reasoning }` — the Smart Progress Bar AI-placed
 * relative to a numbered Cart section like a box (same PlacementMethod + `1..N`
 * anchor rules), with NO appearance keys (its look comes from its campaign
 * template). It is Cart-ONLY: every other page's plan omits the key. This mirrors
 * the lib's follow-up `ProgressBarPlacement` type + the optional
 * `PageBatchProposal.progressBar` field (`brain/batch-output.ts`).
 *
 * Asserts:
 *   • the registry resolves `onboarding-batch-all` (Sonnet / `balanced` tier, no
 *     tools) and the prompt names the Smart Progress Bar, its Cart-ONLY scope, the
 *     no-appearance rule, and the OPTIONAL `progressBar` key in the `pages` output;
 *   • POST /messages routes the header to the prompt + defaults the model;
 *   • the WHOLE-STORE output contract accepts a plan whose Cart page carries a
 *     valid `progressBar` while the other pages omit it — the EXACT shape the lib's
 *     `sanitizeMultiPageBatchProposal` parses;
 *   • a Cart plan with NO progressBar, and non-Cart pages never carrying one, both
 *     parse; an invalid Cart progressBar is CATCHABLE (the lib drops it, falling
 *     back to the deterministic Cart-top default).
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

const PAGE_VOCAB = ['Home', 'Product', 'Collection', 'Cart', 'SlidingCart', 'Search', 'Blog'];
/** The ONLY `position` values — before/after/replace the numbered section. */
const POSITION_VALUES = ['before', 'after', 'replace'];

describe('onboarding-batch-all registry entry (progress-bar-aware)', () => {
  it('resolves with the `balanced` tier (Sonnet), no tools, no attachments', () => {
    const entry = getSystemPrompt('onboarding-batch-all', ENV);
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    expect(entry.usesTools).toBe(false);
    expect(entry.clientTools).toBeUndefined();
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
  });

  it('is NOT a `probe-<id>` name — an onboarding step, not a Website-Analysis probe', () => {
    expect(isProbeName('onboarding-batch-all')).toBe(false);
  });

  it('the prompt names the Smart Progress Bar, its Cart-only scope, and the placement contract', () => {
    const entry = getSystemPrompt('onboarding-batch-all', ENV);
    // Whole-store framing + the `pages` output key.
    expect(entry.prompt).toMatch(/"pages"|`pages`/);
    // The bar is named + tied to the Cart page ONLY.
    expect(entry.prompt).toMatch(/Smart Progress Bar/i);
    expect(entry.prompt).toMatch(/Cart page ONLY|Cart page only|Cart ONLY|Cart ALONE/i);
    expect(entry.prompt).toMatch(/threshold|free[- ]shipping/i);
    // The optional output key + its sub-shape.
    expect(entry.prompt).toMatch(/"progressBar"/);
    expect(entry.prompt).toMatch(/"position"/);
    expect(entry.prompt).toMatch(/"anchorNumber"/);
    expect(entry.prompt).toMatch(/"reasoning"/);
    // NO appearance keys on the bar — its look comes from the campaign template.
    expect(entry.prompt).toMatch(/campaign template/i);
    expect(entry.prompt).toMatch(/NO `appearancePatch`|no appearance keys|NO appearance/i);
    // Non-Cart pages omit the key.
    expect(entry.prompt).toMatch(/omit/i);
  });

  it('hardens output reliability with an explicit JSON-only final instruction', () => {
    const entry = getSystemPrompt('onboarding-batch-all', ENV);
    expect(entry.prompt).toMatch(/ONLY the JSON object/i);
    expect(entry.prompt).toMatch(/no (prose|explanation)/i);
    expect(entry.prompt).toMatch(/code fences?/i);
  });
});

describe('POST /messages — onboarding-batch-all routing (progress-bar-aware)', () => {
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

  it('injects the onboarding-batch-all system block + defaults the model to the `balanced` tier', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [], input_tokens: 0 }));

    await handleMessages(
      messagesRequest(
        {
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'file', file_id: 'cart_desktop' } },
                { type: 'image', source: { type: 'file', file_id: 'cart_mobile' } },
                {
                  type: 'text',
                  text: 'PAGE Cart: DESKTOP TILES images 1-1, MOBILE TILES images 2-2, CANDIDATE ANCHORS 1..4',
                },
              ],
            },
          ],
        },
        'onboarding-batch-all',
      ),
      ENV,
      CORS,
    );

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('/files'))).toBe(false);
    const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const sent = sentBody(fetchCall(fetchMock, idx).init);
    expect(sent.system?.[0]?.type).toBe('text');
    expect(sent.system?.[0]?.text).toMatch(/onboarding/i);
    expect(sent.model).toBe(ENV.MODEL_BALANCED);
    expect(Array.isArray(sent.messages?.[0]?.content)).toBe(true);
  });

  it('returns the Anthropic envelope with the whole-store plan JSON (incl. a Cart progressBar) unchanged', async () => {
    const plan = JSON.stringify({
      pages: {
        Cart: {
          boxes: [
            {
              boxType: 'YouMayLike',
              position: 'after',
              anchorNumber: 2,
              appearancePatch: null,
              appearancePatchMobile: null,
              reasoning: 'You May Like after the cart contents.',
            },
          ],
          progressBar: {
            position: 'before',
            anchorNumber: 1,
            reasoning: 'Free-shipping threshold bar at the top of the cart.',
          },
        },
      },
    });
    stubFetch().mockResolvedValue(jsonOk({ content: [{ type: 'text', text: plan }] }));

    const res = await handleMessages(
      messagesRequest(
        { max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'onboarding-batch-all',
      ),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe(plan);
  });
});

describe('onboarding-batch-all output contract — whole-store progressBar (Cart only)', () => {
  /** Assert an OPTIONAL `progressBar` satisfies `{ position, anchorNumber, reasoning }`. */
  function assertProgressBarShape(value: unknown, markerCount?: number): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const bar = value as Record<string, unknown>;
    expect(Object.keys(bar).sort()).toEqual(['anchorNumber', 'position', 'reasoning']);
    expect(POSITION_VALUES).toContain(bar.position);
    expect(typeof bar.anchorNumber).toBe('number');
    expect(Number.isInteger(bar.anchorNumber)).toBe(true);
    expect(bar.anchorNumber as number).toBeGreaterThanOrEqual(1);
    if (markerCount !== undefined) {
      expect(bar.anchorNumber as number).toBeLessThanOrEqual(markerCount);
    }
    expect(typeof bar.reasoning).toBe('string');
    expect((bar.reasoning as string).length).toBeGreaterThan(0);
  }

  /**
   * Assert a WHOLE-STORE object satisfies `{ pages: { <page>: { boxes, progressBar? } } }`:
   * every page value has a `boxes` array; `progressBar`, when present, is valid AND
   * only appears on the Cart page (the Cart-ONLY invariant). Mirrors the shape the
   * lib's `sanitizeMultiPageBatchProposal` parses (keyed-object form).
   */
  function assertMultiPageShape(value: unknown, cartMarkerCount?: number): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const obj = value as Record<string, unknown>;
    expect(Object.keys(obj)).toEqual(['pages']);
    const pages = obj.pages as Record<string, unknown>;
    expect(typeof pages).toBe('object');
    expect(pages).not.toBeNull();
    const entries = Object.entries(pages);
    expect(entries.length).toBeGreaterThan(0);
    for (const [pageLabel, plan] of entries) {
      expect(PAGE_VOCAB).toContain(pageLabel);
      expect(typeof plan).toBe('object');
      expect(plan).not.toBeNull();
      const planObj = plan as Record<string, unknown>;
      expect(Array.isArray(planObj.boxes)).toBe(true);
      if ('progressBar' in planObj && planObj.progressBar !== null) {
        // The bar is Cart-ONLY.
        expect(pageLabel).toBe('Cart');
        assertProgressBarShape(planObj.progressBar, cartMarkerCount);
      }
    }
  }

  const CART_MARKER_COUNT = 4;

  it('parses a whole-store plan whose Cart page carries a progressBar (other pages omit it)', () => {
    const plan = JSON.stringify({
      pages: {
        Home: {
          boxes: [
            {
              boxType: 'FeaturedCollection',
              position: 'after',
              anchorNumber: 1,
              appearancePatch: null,
              appearancePatchMobile: null,
              reasoning: 'Featured collection after the hero.',
            },
          ],
        },
        Product: {
          boxes: [
            {
              boxType: 'RelatedItems',
              position: 'after',
              anchorNumber: 2,
              appearancePatch: null,
              appearancePatchMobile: null,
              reasoning: 'Related items after the details.',
            },
          ],
        },
        Cart: {
          boxes: [
            {
              boxType: 'YouMayLike',
              position: 'after',
              anchorNumber: 2,
              appearancePatch: null,
              appearancePatchMobile: null,
              reasoning: 'You May Like after the cart contents.',
            },
          ],
          progressBar: {
            position: 'before',
            anchorNumber: 1,
            reasoning: 'Free-shipping threshold bar at the top of the cart.',
          },
        },
      },
    });
    assertMultiPageShape(JSON.parse(plan), CART_MARKER_COUNT);
    // And the Home/Product plans genuinely omit the key.
    const pages = (JSON.parse(plan) as { pages: Record<string, Record<string, unknown>> }).pages;
    expect('progressBar' in (pages.Home ?? {})).toBe(false);
    expect('progressBar' in (pages.Product ?? {})).toBe(false);
    expect('progressBar' in (pages.Cart ?? {})).toBe(true);
  });

  it('parses a whole-store plan where the Cart page has NO progressBar', () => {
    const plan = JSON.stringify({
      pages: {
        Cart: {
          boxes: [
            {
              boxType: 'MostPopular',
              position: 'after',
              anchorNumber: 2,
              appearancePatch: null,
              appearancePatchMobile: null,
              reasoning: 'Most Popular after the cart contents.',
            },
          ],
        },
      },
    });
    assertMultiPageShape(JSON.parse(plan), CART_MARKER_COUNT);
    const pages = (JSON.parse(plan) as { pages: Record<string, Record<string, unknown>> }).pages;
    expect('progressBar' in (pages.Cart ?? {})).toBe(false);
  });

  it('accepts a Cart page whose progressBar is explicitly null (treated as "no bar")', () => {
    const plan = JSON.stringify({ pages: { Cart: { boxes: [], progressBar: null } } });
    // null progressBar passes the shape (the invariant only checks non-null bars).
    assertMultiPageShape(JSON.parse(plan), CART_MARKER_COUNT);
  });

  it('CATCHES a whole-store plan whose Cart progressBar anchorNumber is out of the 1..N range', () => {
    const plan = JSON.stringify({
      pages: {
        Cart: {
          boxes: [],
          progressBar: { position: 'before', anchorNumber: 9, reasoning: 'not painted' },
        },
      },
    });
    expect(() => assertMultiPageShape(JSON.parse(plan), CART_MARKER_COUNT)).toThrow();
  });

  it('CATCHES a whole-store plan whose Cart progressBar has an invalid position', () => {
    const plan = JSON.stringify({
      pages: {
        Cart: {
          boxes: [],
          progressBar: { position: 'inside', anchorNumber: 1, reasoning: 'x' },
        },
      },
    });
    expect(() => assertMultiPageShape(JSON.parse(plan), CART_MARKER_COUNT)).toThrow();
  });

  it('CATCHES a whole-store plan that places a progressBar on a NON-Cart page (Cart-only invariant)', () => {
    const plan = JSON.stringify({
      pages: {
        Home: {
          boxes: [],
          progressBar: { position: 'before', anchorNumber: 1, reasoning: 'bar on the wrong page' },
        },
      },
    });
    expect(() => assertMultiPageShape(JSON.parse(plan), CART_MARKER_COUNT)).toThrow();
  });

  it('CATCHES a Cart progressBar carrying a disallowed appearance key (the bar takes no styling)', () => {
    const plan = JSON.stringify({
      pages: {
        Cart: {
          boxes: [],
          progressBar: {
            position: 'before',
            anchorNumber: 1,
            reasoning: 'x',
            appearancePatch: { Style: 'grid' },
          },
        },
      },
    });
    expect(() => assertMultiPageShape(JSON.parse(plan), CART_MARKER_COUNT)).toThrow();
  });
});
