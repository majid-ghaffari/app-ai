/**
 * Coverage for the Smart Progress Bar in the WHOLE-STORE `onboarding-batch-all`
 * PROPOSE prompt. The whole-store propose returns `{ pages: { <page>: { boxes,
 * progressBar? } } }`; a Cart page's plan may carry an OPTIONAL reasoning-only
 * `progressBar` `{ reasoning }`. Its PLACEMENT is DETERMINISTIC — the lib always
 * renders the bar at the TOP of the Cart page (D1 ratified deterministic
 * top-of-Cart) — so the model decides ONLY WHETHER the store should have one,
 * never where: the bar carries NO `position` / `anchorNumber` and NO appearance
 * keys (its look comes from its campaign template). It is Cart-ONLY: every other
 * page's plan omits the key.
 *
 * Asserts:
 *   • the registry resolves `onboarding-batch-all` (Sonnet / `balanced` tier, no
 *     tools) and the prompt names the Smart Progress Bar, its Cart-ONLY scope, the
 *     deterministic-top placement, the no-`position`/`anchorNumber` rule, the
 *     no-appearance rule, and the OPTIONAL `progressBar` key;
 *   • POST /messages routes the header to the prompt + defaults the model;
 *   • the WHOLE-STORE output contract accepts a plan whose Cart page carries a
 *     valid reasoning-only `progressBar` while the other pages omit it;
 *   • a Cart plan with NO progressBar, and non-Cart pages never carrying one, both
 *     parse; an invalid Cart progressBar (placement tokens, appearance key, on a
 *     non-Cart page) is CATCHABLE.
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

describe('onboarding-batch-all registry entry (progress-bar-aware)', () => {
  it('resolves with the `balanced` tier (Sonnet), no tools, no attachments', () => {
    const entry = getSystemPrompt('onboarding-batch-all', ENV);
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    expect(entry.usesTools).toBe(false);
    expect(entry.clientTools).toBeUndefined();
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
    expect(entry.effort).toBe('medium');
  });

  it('is NOT a `probe-<id>` name — an onboarding step, not a Website-Analysis probe', () => {
    expect(isProbeName('onboarding-batch-all')).toBe(false);
  });

  it('the prompt names the Smart Progress Bar, its Cart-only scope, and the DETERMINISTIC-top contract', () => {
    const entry = getSystemPrompt('onboarding-batch-all', ENV);
    // Whole-store framing + the `pages` output key.
    expect(entry.prompt).toMatch(/"pages"|`pages`/);
    // The bar is named + tied to the Cart page ONLY.
    expect(entry.prompt).toMatch(/Smart Progress Bar/i);
    expect(entry.prompt).toMatch(/Cart page ONLY|Cart page only|Cart ONLY|Cart ALONE/i);
    expect(entry.prompt).toMatch(/threshold|free[- ]shipping/i);
    // The optional output key carries ONLY `reasoning` — placement is deterministic.
    expect(entry.prompt).toMatch(/"progressBar"/);
    expect(entry.prompt).toMatch(/"reasoning"/);
    expect(entry.prompt).toMatch(
      /always renders at the (very )?TOP of the Cart page|deterministic/i,
    );
    // The bar carries NO placement tokens — the model can't affect where it goes.
    expect(entry.prompt).toMatch(/NO `position`, `anchorNumber`/);
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
    expect(sent.output_config).toEqual({ effort: 'medium' });
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
            reasoning: 'Free-shipping threshold bar at the top of the cart.',
          },
        },
      },
    });
    // Fresh Response per call: the propose path also fetches Brain defaults, so a
    // single shared Response would have its body consumed before the Messages read.
    stubFetch().mockImplementation(async () => jsonOk({ content: [{ type: 'text', text: plan }] }));

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

describe('onboarding-batch-all output contract — whole-store progressBar (Cart only, reasoning-only)', () => {
  /**
   * Assert an OPTIONAL `progressBar` satisfies the frozen `{ reasoning }` shape:
   * a non-empty string and NOTHING else (no `position` / `anchorNumber` placement
   * tokens, no appearance keys). Placement is deterministic top-of-Cart.
   */
  function assertProgressBarShape(value: unknown): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const bar = value as Record<string, unknown>;
    expect(Object.keys(bar).sort()).toEqual(['reasoning']);
    expect(typeof bar.reasoning).toBe('string');
    expect((bar.reasoning as string).length).toBeGreaterThan(0);
  }

  /**
   * Assert a WHOLE-STORE object satisfies `{ pages: { <page>: { boxes, progressBar? } } }`:
   * every page value has a `boxes` array; `progressBar`, when present, is a valid
   * reasoning-only bar AND only appears on the Cart page (the Cart-ONLY invariant).
   * Mirrors the shape the lib's `sanitizeMultiPageBatchProposal` parses.
   */
  function assertMultiPageShape(value: unknown): void {
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
        assertProgressBarShape(planObj.progressBar);
      }
    }
  }

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
            reasoning: 'Free-shipping threshold bar at the top of the cart.',
          },
        },
      },
    });
    assertMultiPageShape(JSON.parse(plan));
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
    assertMultiPageShape(JSON.parse(plan));
    const pages = (JSON.parse(plan) as { pages: Record<string, Record<string, unknown>> }).pages;
    expect('progressBar' in (pages.Cart ?? {})).toBe(false);
  });

  it('accepts a Cart page whose progressBar is explicitly null (treated as "no bar")', () => {
    const plan = JSON.stringify({ pages: { Cart: { boxes: [], progressBar: null } } });
    // null progressBar passes the shape (the invariant only checks non-null bars).
    assertMultiPageShape(JSON.parse(plan));
  });

  it('CATCHES a Cart progressBar carrying placement tokens (position/anchorNumber the model can NOT affect)', () => {
    const plan = JSON.stringify({
      pages: {
        Cart: {
          boxes: [],
          progressBar: {
            position: 'before',
            anchorNumber: 1,
            reasoning: 'picked a slot it cannot control',
          },
        },
      },
    });
    expect(() => assertMultiPageShape(JSON.parse(plan))).toThrow();
  });

  it('CATCHES a whole-store plan that places a progressBar on a NON-Cart page (Cart-only invariant)', () => {
    const plan = JSON.stringify({
      pages: {
        Home: {
          boxes: [],
          progressBar: { reasoning: 'bar on the wrong page' },
        },
      },
    });
    expect(() => assertMultiPageShape(JSON.parse(plan))).toThrow();
  });

  it('CATCHES a Cart progressBar carrying a disallowed appearance key (the bar takes no styling)', () => {
    const plan = JSON.stringify({
      pages: {
        Cart: {
          boxes: [],
          progressBar: {
            reasoning: 'x',
            appearancePatch: { Style: 'grid' },
          },
        },
      },
    });
    expect(() => assertMultiPageShape(JSON.parse(plan))).toThrow();
  });
});
