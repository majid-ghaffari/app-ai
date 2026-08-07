/**
 * Coverage for the Smart Progress Bar in the per-page `onboarding-batch` PROPOSE
 * prompt. The bar belongs to the Cart page ALONE, and there is at most ONE per
 * store. Its PLACEMENT is DETERMINISTIC — the lib always renders it at the TOP of
 * the Cart page (D1 ratified deterministic top-of-Cart) — so the model decides
 * ONLY WHETHER the store should have one, never where. A Cart page's plan may
 * carry an OPTIONAL top-level `progressBar` `{ reasoning }` (a single sentence and
 * nothing else): NO `position` / `anchorNumber` (the model can't affect
 * placement) and NO appearance keys (the bar's look comes from its campaign
 * template). Every non-Cart page (and Cart with no bar warranted) omits the key.
 *
 * Asserts:
 *   • the prompt names the Smart Progress Bar, its Cart-ONLY scope, the
 *     deterministic-top placement, the NO-`position`/`anchorNumber` rule, the
 *     NO-appearance rule, and the OPTIONAL `progressBar` output key;
 *   • the output contract accepts a Cart plan WITH a valid reasoning-only
 *     `progressBar`, a Cart plan WITHOUT one, and every non-Cart plan;
 *   • an invalid `progressBar` (a stray `position` / `anchorNumber` placement
 *     token, a disallowed appearance key, an empty / missing `reasoning`) is
 *     CATCHABLE — the shape the lib's sanitizer drops (it then places the bar at
 *     the deterministic Cart-top default anyway).
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { ENV } from './helpers';

describe('onboarding-batch prompt — Smart Progress Bar (Cart page only)', () => {
  it('names the Smart Progress Bar, its Cart-only scope, and the DETERMINISTIC-top contract', () => {
    const entry = getSystemPrompt('onboarding-batch', ENV);
    // The bar is named + tied to the Cart page ONLY.
    expect(entry.prompt).toMatch(/Smart Progress Bar/i);
    expect(entry.prompt).toMatch(/Cart page ONLY|Cart page only|Cart ONLY|Cart ALONE/i);
    expect(entry.prompt).toMatch(/threshold|free[- ]shipping/i);
    // The optional output key carries ONLY `reasoning` — the model decides WHETHER,
    // not WHERE. Placement is deterministic (always the top of the Cart page).
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

  it('the Smart Progress Bar section does NOT put it on a non-Cart page', () => {
    const entry = getSystemPrompt('onboarding-batch', ENV);
    // The prompt must state the bar never lands on the non-Cart pages.
    expect(entry.prompt).toMatch(/never emit a progress bar|not `Cart`|non-Cart/i);
  });
});

describe('onboarding-batch progressBar output contract', () => {
  /**
   * Assert an OPTIONAL `progressBar` on a Cart page plan satisfies the frozen
   * shape: exactly `{ reasoning }` — a non-empty string and NOTHING else. The
   * model decides only WHETHER a bar fits; its placement is deterministic (always
   * the top of the Cart page), so it carries NO `position` / `anchorNumber` and NO
   * appearance keys. The shape the lib's sanitizer validates before applying (else
   * it drops the bar and places it at the deterministic Cart-top default anyway).
   */
  function assertProgressBarShape(value: unknown): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const bar = value as Record<string, unknown>;
    // Exactly ONE key — `reasoning`. No placement tokens, no appearance keys, no extras.
    expect(Object.keys(bar).sort()).toEqual(['reasoning']);
    expect(typeof bar.reasoning).toBe('string');
    expect((bar.reasoning as string).length).toBeGreaterThan(0);
  }

  it('parses a Cart plan carrying a valid reasoning-only progressBar', () => {
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
          reasoning:
            'A free-shipping threshold bar at the top of the cart nudges shoppers to the reward.',
        },
      }),
    ) as Record<string, unknown>;
    expect(plan.page).toBe('Cart');
    assertProgressBarShape(plan.progressBar);
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

  it('CATCHES a progressBar carrying placement tokens (position/anchorNumber the model can NOT affect)', () => {
    const bar = {
      position: 'before',
      anchorNumber: 1,
      reasoning: 'chose a slot it cannot control',
    };
    // Placement is deterministic top-of-Cart — a position/anchorNumber is a forbidden
    // extra key; the lib sanitizer drops the bar rather than honoring the pick.
    expect(() => assertProgressBarShape(bar)).toThrow();
  });

  it('CATCHES a progressBar carrying a disallowed appearance key (the bar takes no styling)', () => {
    const bar = { reasoning: 'x', appearancePatch: { Style: 'grid' } };
    // Any key beyond `reasoning` is a violation.
    expect(() => assertProgressBarShape(bar)).toThrow();
  });

  it('CATCHES a progressBar with an empty or missing reasoning', () => {
    expect(() => assertProgressBarShape({})).toThrow();
    expect(() => assertProgressBarShape({ reasoning: '' })).toThrow();
  });
});
