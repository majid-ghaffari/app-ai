/**
 * Brain-defaults provider (Task E) — fetch → project → cache → inject.
 *
 *   • fetch: authenticated Brain endpoint (forwards the context-ID) by default;
 *     a configured CDN URL is fetched as-is WITHOUT the context-ID.
 *   • cache: one successful global result is reused for the isolate; concurrent
 *     cold callers share one fetch; a cold failure stays retryable.
 *   • project: ONLY the AI-relevant per-box fields, byte-stable across stores +
 *     insensitive to input key order; no other RecommendationsSettings field leaks.
 *   • inject: the propose /messages path adds the defaults as a SECOND cacheable
 *     system block after the stable prompt; review/probe prompts do not.
 *
 * fetch + env mocked; no network.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import {
  getDefaultsBlock,
  projectDefaults,
  canonicalStringify,
  resetDefaultsCacheForTests,
} from '../src/lib/brain-defaults';
import { handleMessages } from '../src/handlers/messages';
import { ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import { ENV, CORS, stubFetch, fetchCall, fetchedUrls, headerOf, sentBody } from './helpers';

beforeEach(() => resetDefaultsCacheForTests());
afterEach(() => vi.restoreAllMocks());

/**
 * A representative raw Brain default RecommendationsSettings (trimmed), shaped
 * like the REAL `RecommendationsSettings.Default`
 * (`brain/LimeSpot.Personalizer/Config/Models/RecommendationsSettings.cs`):
 *
 *   • GLOBAL desktop appearance = `DefaultBoxAppearanceOptions`
 *     (ImageMaxWidth 200 / ImageMaxHeight 250 / ImageMarginRight 40, QA title,
 *     ItemsLimit 20) — line 1109.
 *   • GLOBAL mobile appearance = `DefaultBoxAppearanceOptionsMobile`
 *     (ImageMaxWidth 150 / ImageMaxHeight 200 / ImageMarginRight 10) — line 1130.
 *     These OVERLAP the desktop image dims with DIFFERENT values, so a correct
 *     projection MUST carry both (150 mobile not suppressed by 200 desktop).
 *   • A PAGE-level appearance override (`OrderStatus`, W175/H200/MR20) — the real
 *     `PageType.OrderStatus` block at line 722 — so a page value beats the global.
 *   • A same-typed box (`BoughtTogether` = FBT) on TWO pages with DIFFERENT
 *     per-page styles (bundle vs carousel) — proves per-page scoping (no leak).
 *   • A per-box MOBILE override (Home.Popular) — proves per-box mobile wins.
 */
function rawDefaults(overrides: { upsellStyle?: string } = {}): Record<string, unknown> {
  return {
    BoxOptions: {
      SaleTagEnabled: true,
      SaleTagText: 'SALE',
      // GLOBAL desktop appearance defaults — inherited by any box lacking its own.
      AppearanceOptions: {
        Style: 'rows',
        QuickActionsAddToCartTitle: 'ADD TO CART',
        ItemsLimit: 20,
        ImageMaxWidth: 200,
        ImageMaxHeight: 250,
        ImageMarginRight: 40,
      },
      // GLOBAL mobile appearance — DISTINCT image dims that OVERLAP the desktop
      // ones with SMALLER values. A correct projection keeps these in `mobile`.
      AppearanceOptionsMobile: {
        ImageMaxWidth: 150,
        ImageMaxHeight: 200,
        ImageMarginRight: 10,
      },
      HostPages: {
        Home: {
          Boxes: {
            Popular: {
              Title: 'Most Popular Items',
              Order: 1,
              Enabled: true,
              ItemsLimit: 8,
              FallbackMethod: 'MostPopular',
              AppearanceOptions: {
                Style: 'carousel',
                QuickActionsAddToCartTitle: 'Add to Cart',
                ItemsLimit: 6,
                ImageMaxWidth: 260,
                ImageMaxHeight: 320,
                ImageMarginRight: 8,
                NavigationArrowType: 'circleChevron',
              },
              // Per-box MOBILE override — a mobile-specific width that must win
              // over the global mobile 150 AND stand apart from the desktop 260.
              AppearanceOptionsMobile: {
                ImageMaxWidth: 130,
              },
            },
            // No per-box appearance → inherits the global desktop (top-level) AND
            // the global mobile image dims (mobile sub-object).
            RecentViews: { Title: 'Recently Viewed', Order: 9, Enabled: true },
          },
        },
        Product: {
          Boxes: {
            // Product FBT is a BUNDLE — its own per-page style.
            BoughtTogether: {
              FallbackMethod: 'ShowCrossSellItems',
              AppearanceOptions: { Style: 'bundle' },
            },
          },
        },
        Cart: {
          Boxes: {
            // Cart FBT is a CAROUSEL — a DIFFERENT style than Product's FBT.
            BoughtTogether: {
              FallbackMethod: 'ShowCrossSellItems',
              AppearanceOptions: { Style: 'carousel' },
            },
            Upsell: {
              FallbackMethod: 'RelatedItems',
              AppearanceOptions: {
                Style: overrides.upsellStyle ?? 'slider',
                ImageMaxWidth: 120,
                ImageMaxHeight: 120,
              },
            },
          },
        },
        // PAGE-LEVEL appearance override (mirrors Brain's OrderStatus block). A box
        // here with no own appearance inherits the PAGE image dims (175), NOT the
        // global (200) — proves the page tier is honored.
        OrderStatus: {
          AppearanceOptions: {
            ImageMaxWidth: 175,
            ImageMaxHeight: 200,
            ImageMarginRight: 20,
          },
          Boxes: {
            Related: { FallbackMethod: 'RelatedItems' },
          },
        },
      },
    },
  };
}

function jsonResponse(data: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(data), { status: init.status ?? 200 });
}

// ── Projection ──────────────────────────────────────────────────────────────

describe('projectDefaults — page -> box, effective inheritance, byte-stable', () => {
  it('preserves the page -> box hierarchy and applies the effective appearance inheritance', () => {
    const projected = projectDefaults(rawDefaults());
    expect(Object.keys(projected.pages).sort()).toEqual(['Cart', 'Home', 'OrderStatus', 'Product']);

    // A box with its OWN appearance wins over the global; ItemsLimit from the
    // per-box AppearanceOptions wins over the box-level ItemsLimit. DESKTOP dims
    // sit at the top level; the per-box MOBILE width (130) lands in `mobile` and
    // the gaps (H/MR) fill from the global mobile — never from the desktop dims.
    expect(projected.pages.Home?.Popular).toEqual({
      fallbackMethod: 'MostPopular',
      style: 'carousel',
      itemsLimit: 6,
      imageMaxWidth: 260,
      imageMaxHeight: 320,
      imageMarginRight: 8,
      quickActionsAddToCartTitle: 'Add to Cart',
      mobile: { imageMaxWidth: 130, imageMaxHeight: 200, imageMarginRight: 10 },
    });

    // RecentViews has NO per-box appearance → DESKTOP inherits the global desktop
    // defaults (rows / QA title / ItemsLimit 20 / W200·H250·MR40) while MOBILE
    // inherits the global mobile image dims (W150·H200·MR10). Both the OVERLAPPING
    // widths survive — desktop 200 AND mobile 150 — which the old flattened
    // "desktop wins" projection could not express.
    expect(projected.pages.Home?.RecentViews).toEqual({
      style: 'rows',
      itemsLimit: 20,
      imageMaxWidth: 200,
      imageMaxHeight: 250,
      imageMarginRight: 40,
      quickActionsAddToCartTitle: 'ADD TO CART',
      mobile: { imageMaxWidth: 150, imageMaxHeight: 200, imageMarginRight: 10 },
    });
  });

  it('the OVERLAPPING desktop/mobile image widths BOTH survive (mobile 150 not suppressed by desktop 200)', () => {
    const projected = projectDefaults(rawDefaults());
    const recentViews = projected.pages.Home?.RecentViews;
    // The exact bug FINDING 3 describes: a global desktop 200 must NOT swallow the
    // global mobile 150. Desktop keeps 200; mobile keeps 150, distinctly.
    expect(recentViews?.imageMaxWidth).toBe(200);
    expect(recentViews?.mobile?.imageMaxWidth).toBe(150);
    // And a per-box mobile override wins over the global mobile without touching
    // the desktop width.
    const popular = projected.pages.Home?.Popular;
    expect(popular?.imageMaxWidth).toBe(260);
    expect(popular?.mobile?.imageMaxWidth).toBe(130);
  });

  it('honors the PAGE-level appearance tier — a page override beats the global (OrderStatus 175, not 200)', () => {
    const projected = projectDefaults(rawDefaults());
    // OrderStatus.Related has no per-box appearance; the PAGE-level override sets
    // the image dims, so the projected desktop dims are the PAGE values (175/200/20),
    // NOT the global (200/250/40). Style / QA / ItemsLimit still fall to the global.
    expect(projected.pages.OrderStatus?.Related).toEqual({
      fallbackMethod: 'RelatedItems',
      style: 'rows',
      itemsLimit: 20,
      imageMaxWidth: 175,
      imageMaxHeight: 200,
      imageMarginRight: 20,
      quickActionsAddToCartTitle: 'ADD TO CART',
      mobile: { imageMaxWidth: 150, imageMaxHeight: 200, imageMarginRight: 10 },
    });
  });

  it('scopes a same-typed box per page — Product FBT = bundle, Cart FBT = carousel (no cross-leak)', () => {
    const projected = projectDefaults(rawDefaults());
    // The SAME box type on two pages keeps its OWN per-page style.
    expect(projected.pages.Product?.BoughtTogether?.style).toBe('bundle');
    expect(projected.pages.Cart?.BoughtTogether?.style).toBe('carousel');
    // Each still inherits the global desktop gap-fillers (imageMarginRight 40) and
    // the global mobile dims.
    expect(projected.pages.Product?.BoughtTogether?.imageMarginRight).toBe(40);
    expect(projected.pages.Product?.BoughtTogether?.mobile).toEqual({
      imageMaxWidth: 150,
      imageMaxHeight: 200,
      imageMarginRight: 10,
    });
    expect(projected.pages.Cart?.BoughtTogether?.fallbackMethod).toBe('ShowCrossSellItems');
    // The Cart Upsell keeps its own desktop image dims but inherits the global
    // desktop right-margin (40) and the global mobile dims.
    expect(projected.pages.Cart?.Upsell).toEqual({
      fallbackMethod: 'RelatedItems',
      style: 'slider',
      itemsLimit: 20,
      imageMaxWidth: 120,
      imageMaxHeight: 120,
      imageMarginRight: 40,
      quickActionsAddToCartTitle: 'ADD TO CART',
      mobile: { imageMaxWidth: 150, imageMaxHeight: 200, imageMarginRight: 10 },
    });
  });

  it('the serialized projection carries NO non-AI-relevant setting', () => {
    const json = canonicalStringify(projectDefaults(rawDefaults()));
    // Specific leak markers — box Title VALUE, the box-settings keys, and the
    // envelope keys. (Note: `quickActionsAddToCartTitle` legitimately ends in
    // "Title", so we check the box Title's VALUE, not the substring "Title".)
    for (const leak of [
      'Most Popular Items',
      'SaleTag',
      '"Order"',
      '"Enabled"',
      'NavigationArrowType',
      'Recently Viewed',
      'HostPages',
      'BoxOptions',
    ]) {
      expect(json).not.toContain(leak);
    }
    // The page -> box envelope IS present.
    expect(json).toContain('"pages"');
    expect(json).toContain('"Product"');
  });

  it('is BYTE-STABLE regardless of input page + box key order (cross-store prompt-cache hit)', () => {
    const a = canonicalStringify(projectDefaults(rawDefaults()));
    const raw = rawDefaults().BoxOptions as {
      AppearanceOptions: unknown;
      AppearanceOptionsMobile: unknown;
      HostPages: {
        Cart: { Boxes: Record<string, unknown> };
        Home: unknown;
        Product: unknown;
        OrderStatus: unknown;
      };
    };
    // Reorder pages AND the boxes within a page — the projection must be identical.
    const cartBoxes = raw.HostPages.Cart.Boxes;
    const reordered = {
      BoxOptions: {
        AppearanceOptions: raw.AppearanceOptions,
        AppearanceOptionsMobile: raw.AppearanceOptionsMobile,
        HostPages: {
          OrderStatus: raw.HostPages.OrderStatus,
          Cart: { Boxes: { Upsell: cartBoxes.Upsell, BoughtTogether: cartBoxes.BoughtTogether } },
          Product: raw.HostPages.Product,
          Home: raw.HostPages.Home,
        },
      },
    };
    const b = canonicalStringify(projectDefaults(reordered));
    expect(b).toBe(a);
  });

  it('is Pascal/camel tolerant (navigates either serialization casing) incl. mobile dims', () => {
    const camel = {
      boxOptions: {
        appearanceOptions: { style: 'grid', imageMarginRight: 4, imageMaxWidth: 200 },
        appearanceOptionsMobile: { imageMaxWidth: 150 },
        hostPages: {
          Home: {
            boxes: {
              Popular: { fallbackMethod: 'MostPopular', appearanceOptions: { style: 'carousel' } },
            },
          },
        },
      },
    };
    const projected = projectDefaults(camel);
    // Per-box style wins; the global desktop imageMarginRight/Width are inherited
    // and the global mobile width lands distinctly in `mobile` (150, not the 200).
    expect(projected.pages.Home?.Popular).toEqual({
      fallbackMethod: 'MostPopular',
      style: 'carousel',
      imageMaxWidth: 200,
      imageMarginRight: 4,
      mobile: { imageMaxWidth: 150 },
    });
  });

  it('omits a box with no AI-relevant field and a page with no projected box', () => {
    const noGlobals = {
      BoxOptions: {
        HostPages: {
          // Its only box has no per-box field and there is no global to inherit → omitted → page dropped.
          Home: { Boxes: { RecentViews: { Title: 'x', Order: 1, Enabled: true } } },
          Product: { Boxes: { Related: { FallbackMethod: 'RelatedItems' } } },
        },
      },
    };
    const projected = projectDefaults(noGlobals);
    expect(Object.keys(projected.pages)).toEqual(['Product']);
    expect(projected.pages.Product?.Related).toEqual({ fallbackMethod: 'RelatedItems' });
  });

  it('tolerates an empty / shapeless payload → no pages', () => {
    expect(projectDefaults({}).pages).toEqual({});
    expect(projectDefaults({ content: [] }).pages).toEqual({});
    expect(projectDefaults(null).pages).toEqual({});
  });
});

// ── Fetch + global in-isolate cache ──────────────────────────────────────────

describe('getDefaultsBlock — fetch, cache, degradation', () => {
  it('fetches the authenticated Brain endpoint, forwards context-ID, and builds a stable block', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(rawDefaults()));

    const result = await getDefaultsBlock('ctx-123', ENV);
    expect(result).not.toBeNull();
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe(
      'https://brain.test/v1/personalizerConfig?defaultRecommendationsSettings=true',
    );
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBe('ctx-123');
    // The block carries the projected JSON, not the raw settings.
    expect(result).toContain(canonicalStringify(projectDefaults(rawDefaults())));
    expect(result).not.toContain('HostPages');
  });

  it('reuses one successful global block for the isolate without another fetch', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(rawDefaults()));

    const first = await getDefaultsBlock('ctx', ENV);
    const second = await getDefaultsBlock('another-context', ENV);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one cold fetch across concurrent callers', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(rawDefaults()));

    const [first, second] = await Promise.all([
      getDefaultsBlock('ctx-a', ENV),
      getDefaultsBlock('ctx-b', ENV),
    ]);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a cold failure retryable', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse(rawDefaults()));

    const first = await getDefaultsBlock('ctx', ENV);
    const second = await getDefaultsBlock('ctx', ENV);
    expect(first).toBeNull();
    expect(second).toContain('Platform default box settings');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns NULL (skip injection) when a cold fetch gets a non-ok response', async () => {
    stubFetch().mockResolvedValue(jsonResponse({ error: 'boom' }, { status: 500 }));
    expect(await getDefaultsBlock('ctx', ENV)).toBeNull();
  });

  it('a CDN-configured URL is fetched as-is WITHOUT the context-ID', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonResponse(rawDefaults()));
    const cdnEnv = { ...ENV, RECOMMENDATIONS_DEFAULTS_URL: 'https://cdn.test/defaults.json' };

    await getDefaultsBlock('ctx-secret', cdnEnv);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://cdn.test/defaults.json');
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBeUndefined();
  });
});

// ── Injection into the propose /messages path ────────────────────────────────

describe('injection — the propose /messages path adds a second cacheable system block', () => {
  function messagesRequest(systemPrompt: string): Request {
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': systemPrompt,
        'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
    });
  }

  /** Route the Brain defaults fetch vs the Anthropic Messages call, fresh per call. */
  function routedFetch() {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) => {
      const u = String(input);
      if (u.includes('personalizerConfig')) {
        return Promise.resolve(jsonResponse(rawDefaults()));
      }
      return Promise.resolve(jsonResponse({ content: [] }));
    });
    return fetchMock;
  }

  it('onboarding-batch: system = [stable prompt, defaults block], both 1h-cached, screenshots stay in the user message', async () => {
    const fetchMock = routedFetch();
    await handleMessages(messagesRequest('onboarding-batch'), ENV, CORS);
    const idx = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
    const sent = sentBody(fetchCall(fetchMock, idx).init);

    expect(sent.system).toHaveLength(2);
    // [0] the stable system prompt (starts the composed onboarding prompt).
    expect(sent.system?.[0]?.text).toMatch(/onboarding/i);
    expect(sent.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // [1] the injected defaults block — its OWN cache_control breakpoint, AFTER the
    // stable prompt, carrying the projected defaults (not the raw settings).
    expect(sent.system?.[1]?.text).toContain('Platform default box settings');
    expect(sent.system?.[1]?.text).toContain(canonicalStringify(projectDefaults(rawDefaults())));
    expect(sent.system?.[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // The defaults block contains no transport/ruleset version binding.
    expect(sent.system?.[1]?.text).not.toContain(ONBOARDING_RULESET_VERSION);
  });

  it('every injectsBrainDefaults propose prompt gets the block; total system+user cache breakpoints ≤ 4', async () => {
    for (const name of [
      'onboarding-batch',
      'onboarding-batch-all',
      'cartdrawer-batch-all',
      'optimize-demand',
    ]) {
      const fetchMock = routedFetch();
      await handleMessages(messagesRequest(name), ENV, CORS);
      const idx = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
      const sent = sentBody(fetchCall(fetchMock, idx).init);
      const systemBreakpoints = sent.system?.filter((b) => b.cache_control).length ?? 0;
      expect(systemBreakpoints, `${name} injects the defaults block`).toBe(2);
      expect(systemBreakpoints).toBeLessThanOrEqual(4);
      vi.restoreAllMocks();
      resetDefaultsCacheForTests();
    }
  });

  it('a REVIEW prompt does NOT inject defaults (only PROPOSE prompts do)', async () => {
    const fetchMock = routedFetch();
    await handleMessages(messagesRequest('onboarding-review'), ENV, CORS);
    // No Brain defaults fetch happened at all.
    expect(fetchedUrls(fetchMock).some((u) => u.includes('personalizerConfig'))).toBe(false);
    const idx = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
    const sent = sentBody(fetchCall(fetchMock, idx).init);
    expect(sent.system).toHaveLength(1);
  });

  it('a Brain-defaults fetch failure does NOT fail the propose request (best-effort skip)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((input) => {
      const u = String(input);
      if (u.includes('personalizerConfig')) return Promise.reject(new Error('brain down'));
      return Promise.resolve(jsonResponse({ content: [] }));
    });
    const res = await handleMessages(messagesRequest('onboarding-batch'), ENV, CORS);
    expect(res.status).toBe(200);
    const idx = fetchedUrls(fetchMock).findIndex((u) => u.endsWith('/v1/messages'));
    const sent = sentBody(fetchCall(fetchMock, idx).init);
    // Degraded: no defaults block, just the stable prompt.
    expect(sent.system).toHaveLength(1);
  });

  it('a non-injectsBrainDefaults prompt on /messages does not fetch or inject defaults', async () => {
    const fetchMock = routedFetch();
    // image-selection goes through /messages but never injects Brain defaults.
    await handleMessages(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Personalizer-Context-ID': 'ctx',
          'X-Personalizer-System-Prompt': 'image-selection',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
      }),
      ENV,
      CORS,
    );
    expect(fetchedUrls(fetchMock).some((u) => u.includes('personalizerConfig'))).toBe(false);
  });
});
