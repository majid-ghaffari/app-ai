/**
 * Soft-default reframing (D — remove Upsell/FBT hard-fallback + catalog-primary
 * enforcement). The onboarding + cart-drawer playbook is now advisory: the model's
 * box ORDER is respected, never forced to lead with a catalog-backed box, and the
 * "empty preview" hard-fallback framing is gone (Studio fills every box with sample
 * items while designing). These assertions lock that in so a regression re-adds a
 * forced-primary rule visibly.
 *
 * No network — the composed prompt text is read straight from the registry.
 */

import { describe, it, expect } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { ENV } from './helpers';

const PROPOSE_PROMPTS = ['onboarding-batch', 'onboarding-batch-all'] as const;
const REVIEW_PROMPTS = [
  'onboarding-review',
  'onboarding-review-all',
  'cartdrawer-review-all',
] as const;

describe('soft-default reframing — propose prompts (catalog-note + pb-detail)', () => {
  for (const name of PROPOSE_PROMPTS) {
    const text = () => getSystemPrompt(name, ENV).prompt;

    it(`${name}: the catalog-backed-PRIMARY requirement is GONE`, () => {
      // The old forcing rules — no longer present anywhere in the composed prompt.
      expect(text()).not.toMatch(/lead with a CATALOG-backed box/i);
      expect(text()).not.toMatch(/Keep the page's most prominent strip CATALOG-backed/i);
    });

    it(`${name}: the hard-fallback "degrades to a populated strip" framing is GONE`, () => {
      // The prescriptive "FBT falls back to Cross-sell / Upsell falls back to Related
      // Items AS A CATALOG-BACKED STRIP so it renders populated" guidance is removed
      // from the propose blocks. (The deterministic ENFORCED-rules block still names
      // the fallbacks as advisory context — that is a different, system-owned block.)
      expect(text()).not.toMatch(/degrade[s]? to a POPULATED strip/i);
      expect(text()).not.toMatch(
        /degrades gracefully for real shoppers via its configured fallback/i,
      );
    });

    it(`${name}: carries the SOFT-default framing (Studio fills boxes; order respected)`, () => {
      expect(text()).toMatch(/SOFT defaults/);
      // The catalog-note is hard-wrapped in the single-page prompt, so allow any
      // run of whitespace (incl. a newline) between the words.
      expect(text()).toMatch(/Studio fills every\s+box with SAMPLE items/);
      expect(text()).toMatch(/order is respected/i);
    });
  }
});

describe('soft-default reframing — review prompts (no forced-primary correction)', () => {
  for (const name of REVIEW_PROMPTS) {
    it(`${name}: the "Empty session-dependent PRIMARY (FAIL)" forcing rule is GONE`, () => {
      const text = getSystemPrompt(name, ENV).prompt;
      expect(text).not.toMatch(/Empty session-dependent PRIMARY/i);
      expect(text).not.toMatch(/so a POPULATED, catalog-backed strip is the primary/i);
      // The three surviving classification bullets are still present.
      expect(text).toMatch(/All good/);
      expect(text).toMatch(/Placement off/);
      expect(text).toMatch(/Styling broken/);
    });
  }
});
