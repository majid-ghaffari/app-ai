/**
 * Coverage for the Smart Progress Bar joining the per-page `onboarding-batch`
 * PROPOSE prompt (v7). The bar is an ON-PAGE item like the boxes — the AI decides
 * WHERE it goes — but there is at most ONE per store and it belongs to the Cart
 * page ALONE. A Cart page's plan may carry an OPTIONAL top-level `progressBar`
 * `{ position, anchorNumber, reasoning }` — the SAME PlacementMethod + `1..N`
 * anchor language as a box, with NO appearance keys (the bar's look comes from its
 * campaign template). Every non-Cart page (and Cart with no bar warranted) omits
 * the key. This mirrors the lib's follow-up `ProgressBarPlacement` type + the
 * optional `PageBatchProposal.progressBar` field (`brain/batch-output.ts`).
 *
 * Asserts:
 *   • the prompt text names the Smart Progress Bar, its Cart-ONLY scope, the
 *     placement-by-numbered-section language, the NO-appearance rule, and the
 *     OPTIONAL `progressBar` output key;
 *   • the output contract accepts a Cart plan WITH a valid `progressBar`, a Cart
 *     plan WITHOUT one, and every non-Cart plan (no `progressBar`);
 *   • an invalid `progressBar` (bad `position`, out-of-range / non-integer
 *     `anchorNumber`, disallowed appearance key) is CATCHABLE — the shape the
 *     lib's sanitizer drops (falling back to the deterministic Cart-top default).
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { ENV } from './helpers';

/** The ONLY `position` values — before/after/replace the numbered section. */
const POSITION_VALUES = ['before', 'after', 'replace'];

describe('onboarding-batch prompt — Smart Progress Bar (Cart page only)', () => {
  it('names the Smart Progress Bar, its Cart-only scope, and the placement contract', () => {
    const entry = getSystemPrompt('onboarding-batch', ENV);
    // The bar is named + tied to the Cart page ONLY.
    expect(entry.prompt).toMatch(/Smart Progress Bar/i);
    expect(entry.prompt).toMatch(/Cart page ONLY|Cart page only|Cart ONLY|Cart ALONE/i);
    // It's placed by the SAME numbered-section language as the boxes (position + anchorNumber).
    expect(entry.prompt).toMatch(/threshold|free[- ]shipping/i);
    // The optional output key + its sub-shape (position + anchorNumber + reasoning).
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

  it('the Smart Progress Bar section does NOT put it on a non-Cart page', () => {
    const entry = getSystemPrompt('onboarding-batch', ENV);
    // The prompt must state the bar never lands on the non-Cart pages.
    expect(entry.prompt).toMatch(/never emit a progress bar|not `Cart`|non-Cart/i);
  });
});

describe('onboarding-batch progressBar output contract', () => {
  /**
   * Assert an OPTIONAL `progressBar` on a page plan satisfies the frozen shape:
   * exactly `{ position, anchorNumber, reasoning }` — a `PlacementMethod`
   * position, an INTEGER `anchorNumber` (1..N when the section count is known),
   * a non-empty reasoning, and NO appearance keys. The shape the lib's sanitizer
   * validates before applying (else it drops the bar and falls back to the
   * deterministic Cart-top default).
   */
  function assertProgressBarShape(value: unknown, markerCount?: number): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const bar = value as Record<string, unknown>;
    // Exactly the three keys — no appearance keys, no extras, no missing.
    expect(Object.keys(bar).sort()).toEqual(['anchorNumber', 'position', 'reasoning']);
    // position is exactly 'before' | 'after' | 'replace'.
    expect(POSITION_VALUES).toContain(bar.position);
    // anchorNumber is a positive INTEGER, within 1..N when the section count is known.
    expect(typeof bar.anchorNumber).toBe('number');
    expect(Number.isInteger(bar.anchorNumber)).toBe(true);
    expect(bar.anchorNumber as number).toBeGreaterThanOrEqual(1);
    if (markerCount !== undefined) {
      expect(bar.anchorNumber as number).toBeLessThanOrEqual(markerCount);
    }
    // reasoning is a non-empty string.
    expect(typeof bar.reasoning).toBe('string');
    expect((bar.reasoning as string).length).toBeGreaterThan(0);
  }

  /** The number of numbered sections the lib painted on the Cart page's screenshots. */
  const CART_MARKER_COUNT = 4;

  it('parses a Cart plan carrying a valid progressBar placed BEFORE the first section', () => {
    const plan = JSON.parse(
      JSON.stringify({
        page: 'Cart',
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
          reasoning:
            'A free-shipping threshold bar at the very top of the cart, before the line items.',
        },
      }),
    ) as Record<string, unknown>;
    expect(plan.page).toBe('Cart');
    assertProgressBarShape(plan.progressBar, CART_MARKER_COUNT);
  });

  it("parses a Cart plan with NO progressBar (the merchant already has a bar / one wouldn't help)", () => {
    const plan = JSON.parse(
      JSON.stringify({
        page: 'Cart',
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
      }),
    ) as Record<string, unknown>;
    // No progressBar key at all — a valid Cart plan.
    expect('progressBar' in plan).toBe(false);
  });

  it('treats a null progressBar as "no bar" (both omission and null are accepted)', () => {
    const plan = JSON.parse(
      JSON.stringify({ page: 'Cart', boxes: [], progressBar: null }),
    ) as Record<string, unknown>;
    expect(plan.progressBar).toBeNull();
  });

  it('a NON-Cart page carries NO progressBar', () => {
    for (const page of ['Home', 'Product', 'Collection']) {
      const plan = JSON.parse(JSON.stringify({ page, boxes: [] })) as Record<string, unknown>;
      expect('progressBar' in plan).toBe(false);
    }
  });

  it('CATCHES a progressBar whose anchorNumber is OUTSIDE the painted 1..N range', () => {
    const bar = { position: 'before', anchorNumber: 9, reasoning: 'picked a section not painted' };
    // N = 4; anchorNumber 9 is out of range → the lib sanitizer drops the bar.
    expect(() => assertProgressBarShape(bar, CART_MARKER_COUNT)).toThrow();
  });

  it('CATCHES a progressBar with an invalid position (not before/after/replace)', () => {
    const bar = { position: 'inside', anchorNumber: 1, reasoning: 'x' };
    expect(() => assertProgressBarShape(bar, CART_MARKER_COUNT)).toThrow();
  });

  it('CATCHES a progressBar with a non-integer / zero anchorNumber', () => {
    expect(() =>
      assertProgressBarShape(
        { position: 'before', anchorNumber: 0, reasoning: 'x' },
        CART_MARKER_COUNT,
      ),
    ).toThrow();
    expect(() =>
      assertProgressBarShape(
        { position: 'before', anchorNumber: 1.5, reasoning: 'x' },
        CART_MARKER_COUNT,
      ),
    ).toThrow();
  });

  it('CATCHES a progressBar carrying a disallowed appearance key (the bar takes no styling)', () => {
    const bar = {
      position: 'before',
      anchorNumber: 1,
      reasoning: 'x',
      appearancePatch: { Style: 'grid' },
    };
    // The extra key means it is NOT exactly { position, anchorNumber, reasoning }.
    expect(() => assertProgressBarShape(bar, CART_MARKER_COUNT)).toThrow();
  });
});
