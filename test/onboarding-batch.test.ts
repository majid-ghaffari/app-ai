/**
 * Coverage for the `onboarding-batch` prompt — the PROPOSE half of onboarding
 * "batch mode": given ONE store page (name + full-page screenshot + cleaned HTML
 * + the enumerated VALID placement anchors the lib derives from its interaction-
 * layer injection-point filter), it returns ONE JSON plan for the WHOLE page. A
 * structured-output reasoner (usesTools: false, no clientTools), header-selected
 * on POST /messages exactly like `visual-verify` / the probes — NOT the /chat
 * tool loop. Asserts:
 *   • the registry resolves `onboarding-batch` with the `balanced` tier
 *     (Sonnet), no tools, no attachments;
 *   • the prompt text names its input (page + screenshot + HTML + anchors) and
 *     the box/page vocab + the JSON plan output contract;
 *   • POST /messages routes the `X-Personalizer-System-Prompt: onboarding-batch`
 *     header to the prompt (injects its system block, no /files upload) and
 *     defaults the model to the `balanced` tier when the body omits it;
 *   • the output contract is asserted via a parse/validate check on a
 *     representative plan — including that a plan referencing an anchor id NOT in
 *     the provided list is catchable.
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

/** The box + page vocabularies (shared via `_shared-box-vocab.md`). */
const BOX_VOCAB = [
  'MostPopular',
  'Trending',
  'NewArrivals',
  'YouMayLike',
  'RecentViews',
  'BoughtTogether',
  'CrossSell',
  'Upsell',
  'RelatedItems',
  'FeaturedCollection',
];
const PAGE_VOCAB = ['Home', 'Product', 'Collection', 'Cart', 'SlidingCart', 'Search', 'Blog'];
/** The ONLY appearancePatch keys the plan may use. */
const APPEARANCE_KEYS = [
  'Style',
  'ItemsPerPage',
  'ItemsLimit',
  'ImageBorderRadius',
  'NavigationArrowType',
];
const STYLE_VALUES = ['carousel', 'grid', 'bundle', 'rows'];
/** The ONLY `position` values — before/after/replace the numbered section. */
const POSITION_VALUES = ['before', 'after', 'replace'];
/** The ONLY `appearancePatchMobile` keys — mobile-only overrides (no items-per-row). */
const MOBILE_KEYS = ['ImageHeightMobile', 'MarginRightMobile'];

describe('onboarding-batch registry entry', () => {
  it('resolves with the `balanced` tier (Sonnet), no tools', () => {
    const entry = getSystemPrompt('onboarding-batch', ENV);
    // Runs on the `balanced` tier — the same reasoner class as the strategist.
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    // Structured output — one-shot JSON, no server tools, no CLIENT tools.
    expect(entry.usesTools).toBe(false);
    expect(entry.clientTools).toBeUndefined();
    // No bundled attachments — the lib uploads the desktop + mobile screenshots per run.
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
  });

  it('is NOT a `probe-<id>` name — an onboarding step, not a Website-Analysis probe', () => {
    expect(isProbeName('onboarding-batch')).toBe(false);
  });

  it('the prompt text names its desktop+mobile input, vocab, and JSON plan output contract', () => {
    const entry = getSystemPrompt('onboarding-batch', ENV);
    // JSON-only structured output.
    expect(entry.prompt).toMatch(/JSON/i);
    // Input: TWO screenshots at two widths — desktop + mobile — each a translucent
    // marked screenshot (design shows THROUGH the numbered overlay).
    expect(entry.prompt).toMatch(/desktop/i);
    expect(entry.prompt).toMatch(/mobile/i);
    expect(entry.prompt).toMatch(/both widths|both phone and desktop|phone AND desktop/i);
    expect(entry.prompt).toMatch(/translucent|semi-transparent|opacity|through them/i);
    // Mobile is first-class, not deferred.
    expect(entry.prompt).toMatch(/majority/i);
    // The numbering is SHARED across the two widths — one anchorNumber, not per-width.
    expect(entry.prompt).toMatch(/shared/i);
    // Numbers key SECTIONS/siblings (one number per element), placed before/after/replace.
    expect(entry.prompt).toMatch(/section/i);
    expect(entry.prompt).toMatch(/before/i);
    expect(entry.prompt).toMatch(/after/i);
    // `replace` — swap a merchant element (e.g. an empty placeholder) for the box.
    expect(entry.prompt).toMatch(/replace/i);
    expect(entry.prompt).toMatch(/placeholder|swap/i);
    // The model emits the number + before/after/replace, never a selector.
    expect(entry.prompt).toMatch(/selector/i);
    // Dual purpose: design/aesthetic (WHICH + styling) AND placement (WHERE).
    expect(entry.prompt).toMatch(/design|aesthetic/i);
    expect(entry.prompt).toMatch(/placement/i);
    // The markers are numbered 1..N — a bare range bound, no text legend.
    expect(entry.prompt).toMatch(/numbered/i);
    expect(entry.prompt).toMatch(/marker/i);
    expect(entry.prompt).toMatch(/\b1\.\.N\b|1 through N|1–N|1-N/);
    // NO AI-facing descriptors: the model never gets label/description text, and
    // there is no cleaned-HTML input anymore.
    expect(entry.prompt).not.toMatch(/cleaned[- ]HTML|cleaned HTML/i);
    expect(entry.prompt).not.toMatch(/"label"/);
    expect(entry.prompt).not.toMatch(/"description"/);
    // The output contract keys — anchorNumber + position.
    expect(entry.prompt).toMatch(/"boxType"/);
    expect(entry.prompt).toMatch(/"position"/);
    expect(entry.prompt).toMatch(/"anchorNumber"/);
    expect(entry.prompt).not.toMatch(/anchorIndex/);
    expect(entry.prompt).toMatch(/"appearancePatch"/);
    // The PREFERRED appearance-clone seam — name the store's own product grid /
    // carousel to CLONE (styleReferenceSelector), with appearancePatch as fallback.
    expect(entry.prompt).toMatch(/styleReferenceSelector/);
    expect(entry.prompt).toMatch(/clone/i);
    expect(entry.prompt).toMatch(/fallback/i);
    // The mobile-overrides key + its two allowed knobs (no items-per-row).
    expect(entry.prompt).toMatch(/"appearancePatchMobile"/);
    for (const key of MOBILE_KEYS) expect(entry.prompt).toContain(key);
    expect(entry.prompt).toMatch(/items[- ]per[- ]row|per row/i);
    expect(entry.prompt).toMatch(/"reasoning"/);
    // The number constraint — pick ONLY from the visible numbered sections.
    expect(entry.prompt).toMatch(/invent/i);
    // Box + page vocab present (from the shared `_shared-box-vocab.md` block).
    for (const box of BOX_VOCAB) expect(entry.prompt).toContain(box);
    for (const page of PAGE_VOCAB) expect(entry.prompt).toContain(page);
    // The allowed desktop appearance keys.
    for (const key of APPEARANCE_KEYS) expect(entry.prompt).toContain(key);
  });

  it('hardens output reliability with an explicit JSON-only final instruction', () => {
    const entry = getSystemPrompt('onboarding-batch', ENV);
    // The final hardening line: ONLY the JSON object, no prose/markdown fences.
    expect(entry.prompt).toMatch(/ONLY the JSON object/i);
    expect(entry.prompt).toMatch(/no (prose|explanation)/i);
    expect(entry.prompt).toMatch(/code fences?/i);
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getSystemPrompt('onboarding-batch-nope', ENV)).toThrow(/not found/i);
  });
});

describe('POST /messages — onboarding-batch routing', () => {
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

  it('injects the onboarding-batch system block + defaults the model to the `balanced` tier', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [], input_tokens: 0 }));

    await handleMessages(
      // Body WITHOUT `model` — the batch transport omits it so the registry is
      // authoritative (onboarding-batch → the `balanced` tier).
      messagesRequest(
        {
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                // TWO widths of the page — desktop + mobile — each a translucent
                // marked screenshot with the SHARED numbered overlay.
                { type: 'image', source: { type: 'file', file_id: 'shot_home_desktop' } },
                { type: 'image', source: { type: 'file', file_id: 'shot_home_mobile' } },
                // Only a bare marker range — no label/description legend.
                { type: 'text', text: 'page: Home\nvalid marker range: 1..5' },
              ],
            },
          ],
        },
        'onboarding-batch',
      ),
      ENV,
      CORS,
    );

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // No attachments → no /files upload (the lib uploads the evidence itself).
    expect(urls.some((url) => url.includes('/files'))).toBe(false);
    const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const sent = sentBody(fetchCall(fetchMock, idx).init);
    expect(sent.system?.[0]?.type).toBe('text');
    expect(sent.system?.[0]?.text).toMatch(/onboarding/i);
    expect(sent.model).toBe(ENV.MODEL_BALANCED);
    // The caller's evidence content blocks flow through untouched.
    expect(Array.isArray(sent.messages?.[0]?.content)).toBe(true);
  });

  it('returns the Anthropic envelope with the assistant plan JSON unchanged', async () => {
    const plan = JSON.stringify({
      page: 'Home',
      boxes: [
        {
          boxType: 'FeaturedCollection',
          position: 'after',
          anchorNumber: 1,
          appearancePatch: { Style: 'carousel', ItemsPerPage: 4, ImageBorderRadius: 0 },
          appearancePatchMobile: { ImageHeightMobile: 160 },
          reasoning: 'A featured-collection carousel after the hero section.',
        },
      ],
    });
    stubFetch().mockResolvedValue(jsonOk({ content: [{ type: 'text', text: plan }] }));

    const res = await handleMessages(
      messagesRequest(
        { max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'onboarding-batch',
      ),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe(plan);
  });
});

describe('onboarding-batch output contract', () => {
  /**
   * Assert an object satisfies the frozen page-plan shape. Each box places a
   * recommendation `position` ('before'|'after'|'replace') a numbered SECTION named
   * by `anchorNumber`, with an optional mobile-only `appearancePatchMobile`. When
   * `markerCount` (N) is provided, every `anchorNumber` MUST be an integer in `1..N`
   * (the model may only pick a painted section number, never invent one) — the
   * constraint the lib's sanitizer enforces on ingest.
   */
  function assertPlanShape(value: unknown, markerCount?: number): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const obj = value as Record<string, unknown>;
    // Exactly the two top-level keys — no extras, no missing.
    expect(Object.keys(obj).sort()).toEqual(['boxes', 'page']);
    // `page` is from the page vocabulary.
    expect(PAGE_VOCAB).toContain(obj.page);
    // `boxes` is an array of well-formed box plans.
    expect(Array.isArray(obj.boxes)).toBe(true);
    for (const raw of obj.boxes as unknown[]) {
      expect(typeof raw).toBe('object');
      expect(raw).not.toBeNull();
      const box = raw as Record<string, unknown>;
      // The six required keys are always present; `styleReferenceSelector` is an
      // OPTIONAL seventh (the store's own block to clone). Assert the required set
      // is a subset and every present key is a known one — so a plan WITH the
      // optional selector still validates.
      const keys = Object.keys(box).sort();
      const REQUIRED = [
        'anchorNumber',
        'appearancePatch',
        'appearancePatchMobile',
        'boxType',
        'position',
        'reasoning',
      ];
      const ALLOWED = [...REQUIRED, 'styleReferenceSelector'].sort();
      for (const required of REQUIRED) expect(keys).toContain(required);
      for (const key of keys) expect(ALLOWED).toContain(key);
      // When present, the style-reference selector is a non-empty string.
      if ('styleReferenceSelector' in box) {
        expect(typeof box.styleReferenceSelector).toBe('string');
        expect((box.styleReferenceSelector as string).length).toBeGreaterThan(0);
      }
      // boxType from the box vocabulary.
      expect(BOX_VOCAB).toContain(box.boxType);
      // position is exactly 'before' | 'after' | 'replace'.
      expect(POSITION_VALUES).toContain(box.position);
      // anchorNumber is a positive INTEGER (a painted section number), and —
      // when the section count is known — within the valid 1..N range (the model
      // may not invent a number outside the painted sections).
      expect(typeof box.anchorNumber).toBe('number');
      expect(Number.isInteger(box.anchorNumber)).toBe(true);
      expect(box.anchorNumber as number).toBeGreaterThanOrEqual(1);
      if (markerCount !== undefined) {
        expect(box.anchorNumber as number).toBeLessThanOrEqual(markerCount);
      }
      // reasoning is a non-empty string.
      expect(typeof box.reasoning).toBe('string');
      expect((box.reasoning as string).length).toBeGreaterThan(0);
      // appearancePatch is null OR an object using ONLY the allowed desktop keys.
      if (box.appearancePatch !== null) {
        const patch = box.appearancePatch as Record<string, unknown>;
        expect(typeof patch).toBe('object');
        for (const key of Object.keys(patch)) {
          expect(APPEARANCE_KEYS).toContain(key);
        }
        if ('Style' in patch) {
          expect(STYLE_VALUES).toContain(patch.Style);
        }
      }
      // appearancePatchMobile is null OR an object using ONLY the two mobile keys.
      if (box.appearancePatchMobile !== null) {
        const mobilePatch = box.appearancePatchMobile as Record<string, unknown>;
        expect(typeof mobilePatch).toBe('object');
        for (const key of Object.keys(mobilePatch)) {
          expect(MOBILE_KEYS).toContain(key);
        }
      }
    }
  }

  /** The number of numbered sections the lib painted on this page's screenshots. */
  const HOME_MARKER_COUNT = 5;

  it('parses a valid Home plan placing boxes before/after painted sections + mobile patch', () => {
    const plan = JSON.stringify({
      page: 'Home',
      boxes: [
        {
          boxType: 'FeaturedCollection',
          position: 'after',
          anchorNumber: 1,
          appearancePatch: {
            Style: 'carousel',
            ItemsPerPage: 4,
            ImageBorderRadius: 0,
            NavigationArrowType: 'chevron',
          },
          appearancePatchMobile: { ImageHeightMobile: 160, MarginRightMobile: 8 },
          reasoning:
            'Featured collection after the hero section; square images to match the store.',
        },
        {
          boxType: 'RecentViews',
          position: 'before',
          anchorNumber: 5,
          appearancePatch: null,
          appearancePatchMobile: null,
          reasoning: 'Recently Viewed just before the footer; the default styling already fits.',
        },
      ],
    });
    assertPlanShape(JSON.parse(plan), HOME_MARKER_COUNT);
  });

  it("accepts a box carrying a styleReferenceSelector (clone the store's own block)", () => {
    const plan = JSON.stringify({
      page: 'Home',
      boxes: [
        {
          boxType: 'FeaturedCollection',
          position: 'after',
          anchorNumber: 1,
          styleReferenceSelector: '.product-grid',
          appearancePatch: null,
          appearancePatchMobile: { ImageHeightMobile: 160 },
          reasoning: "Clone the store's own product grid so the cards match exactly.",
        },
      ],
    });
    assertPlanShape(JSON.parse(plan), HOME_MARKER_COUNT);
  });

  it('accepts a box with position "replace" (swap a placeholder section for the box)', () => {
    const plan = JSON.stringify({
      page: 'Home',
      boxes: [
        {
          boxType: 'MostPopular',
          position: 'replace',
          anchorNumber: 3,
          appearancePatch: { Style: 'grid', ItemsPerPage: 4 },
          appearancePatchMobile: null,
          reasoning: 'Section 3 is an empty placeholder, so swap in a Most Popular grid.',
        },
      ],
    });
    assertPlanShape(JSON.parse(plan), HOME_MARKER_COUNT);
  });

  it('accepts a box whose ONLY mobile override is MarginRightMobile', () => {
    const plan = JSON.stringify({
      page: 'Product',
      boxes: [
        {
          boxType: 'BoughtTogether',
          position: 'after',
          anchorNumber: 2,
          appearancePatch: null,
          appearancePatchMobile: { MarginRightMobile: 6 },
          reasoning: 'Tighten the mobile card gap only.',
        },
      ],
    });
    assertPlanShape(JSON.parse(plan), HOME_MARKER_COUNT);
  });

  it('parses an empty-boxes plan (a page that warrants no boxes)', () => {
    const plan = JSON.stringify({ page: 'Blog', boxes: [] });
    assertPlanShape(JSON.parse(plan));
  });

  it('CATCHES a plan whose anchorNumber is OUTSIDE the painted 1..N range', () => {
    // The model returned a section number the lib never painted (7 > N=5) — the
    // ingest sanitizer (markerCount bound) must reject it.
    const badPlan = JSON.stringify({
      page: 'Home',
      boxes: [
        {
          boxType: 'MostPopular',
          position: 'after',
          anchorNumber: 7,
          appearancePatch: null,
          appearancePatchMobile: null,
          reasoning: 'picked a section that is not on the page',
        },
      ],
    });
    expect(() => assertPlanShape(JSON.parse(badPlan), HOME_MARKER_COUNT)).toThrow();
  });

  it('rejects a non-integer / zero anchorNumber', () => {
    const bad = JSON.parse(
      JSON.stringify({
        page: 'Home',
        boxes: [
          {
            boxType: 'MostPopular',
            position: 'after',
            anchorNumber: 0,
            appearancePatch: null,
            appearancePatchMobile: null,
            reasoning: 'x',
          },
        ],
      }),
    );
    expect(() => assertPlanShape(bad, HOME_MARKER_COUNT)).toThrow();
  });

  it('rejects a box with an invalid position (not before/after/replace)', () => {
    const bad = JSON.parse(
      JSON.stringify({
        page: 'Home',
        boxes: [
          {
            boxType: 'MostPopular',
            position: 'inside',
            anchorNumber: 1,
            appearancePatch: null,
            appearancePatchMobile: null,
            reasoning: 'x',
          },
        ],
      }),
    );
    expect(() => assertPlanShape(bad, HOME_MARKER_COUNT)).toThrow();
  });

  it('rejects an appearancePatchMobile carrying a disallowed key (e.g. desktop / items-per-row)', () => {
    const bad = JSON.parse(
      JSON.stringify({
        page: 'Home',
        boxes: [
          {
            boxType: 'MostPopular',
            position: 'after',
            anchorNumber: 1,
            appearancePatch: null,
            appearancePatchMobile: { ItemsPerPageMobile: 3 },
            reasoning: 'x',
          },
        ],
      }),
    );
    expect(() => assertPlanShape(bad, HOME_MARKER_COUNT)).toThrow();
  });

  it('rejects a plan missing a top-level key', () => {
    const bad = JSON.parse(JSON.stringify({ boxes: [] }));
    expect(() => assertPlanShape(bad)).toThrow();
  });

  it('rejects a box missing the position key', () => {
    const bad = JSON.parse(
      JSON.stringify({
        page: 'Home',
        boxes: [{ boxType: 'MostPopular', anchorNumber: 1, appearancePatch: null, reasoning: 'x' }],
      }),
    );
    expect(() => assertPlanShape(bad, HOME_MARKER_COUNT)).toThrow();
  });

  it('rejects a box using an unknown boxType', () => {
    const bad = JSON.parse(
      JSON.stringify({
        page: 'Home',
        boxes: [
          {
            boxType: 'NotARealBox',
            position: 'after',
            anchorNumber: 1,
            appearancePatch: null,
            appearancePatchMobile: null,
            reasoning: 'x',
          },
        ],
      }),
    );
    expect(() => assertPlanShape(bad)).toThrow();
  });

  it('rejects an appearancePatch carrying a disallowed key', () => {
    const bad = JSON.parse(
      JSON.stringify({
        page: 'Home',
        boxes: [
          {
            boxType: 'MostPopular',
            position: 'after',
            anchorNumber: 1,
            appearancePatch: { BackgroundColor: '#fff' },
            appearancePatchMobile: null,
            reasoning: 'x',
          },
        ],
      }),
    );
    expect(() => assertPlanShape(bad)).toThrow();
  });
});
