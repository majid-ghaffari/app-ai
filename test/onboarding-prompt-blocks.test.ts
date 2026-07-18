/**
 * BYTE-EQUIVALENCE GATE for the modular onboarding prompt blocks.
 *
 * The four live onboarding prompts — `onboarding-batch`, `onboarding-batch-all`,
 * `onboarding-review`, `onboarding-review-all` — are each COMPOSED
 * (src/prompt-registry.ts, via `composePrompt`) from a small set of per-prompt
 * fragment files plus SHARED partials under `src/prompts/onboarding-shared/` that
 * hold the instruction duplicated across the pair / all four. This test is the
 * load-bearing proof that the composed system text each entry resolves to matches
 * the committed contract, captured verbatim as the
 * `test/__snapshots__/<name>.baseline.md` files. An unintended wording drift in a
 * block or fragment fails the gate.
 *
 * ── `onboarding-batch-all` is HOLISTIC ─────────────────────────────────────────
 * The whole-store propose is the ONE holistic pass (CONDUCTOR-FRAMEWORK.md → "One
 * holistic propose pass"): the SAME call ALSO returns the two OFF-PAGE natures
 * (audience segments + discount / bundle campaigns), store-wide, alongside the
 * on-page boxes + Cart progressBar. So `onboarding-batch-all` composes THREE extra
 * blocks (`_block-audience-segments`, `_block-discount-specs`,
 * `_block-store-wide-output`) APPENDED after the box/PB output+rules, before the
 * JSON tail — so it is NOT byte-equivalent to the batch-all baseline. Its gate
 * therefore proves a DIFFERENT invariant: the box+PB placement portion (the
 * baseline body) stays byte-identical as a PREFIX, and the off-page additions are
 * present. The other three prompts are byte-identical to their baselines (the
 * off-page blocks compose into NONE of them — segments/discounts are store-wide,
 * so per-page `onboarding-batch` + the review prompts never carry them).
 *
 * The baseline `.md` files carry their trailing newline. `composePrompt` trims
 * trailing whitespace exactly as it already does for the shipped `image-selection`
 * entry (`composePrompt(imageSelectionPrompt)`), so the ONLY difference from the
 * raw `.md` is that final newline — behavior-inert in a system prompt. We compare
 * against `baseline.trim()` (the effective prompt text). A mismatch anywhere means
 * the block split changed the effective prompt — the gate FAILS rather than let a
 * wording drift slip in.
 *
 * If a legitimate prompt EDIT is intended, update the affected block/fragment file
 * AND the matching baseline `.md` (the committed prompts changed on purpose).
 *
 * The baselines + blocks import through the SAME raw-`.md` loader as the prompts
 * (vitest.config.ts raw-markdown plugin / wrangler Text rule), so no `node:fs` and
 * no extra tsconfig types are needed. No network.
 */

import { describe, it, expect } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { ENV } from './helpers';

// Committed baselines — the exact bytes each composed onboarding prompt must reproduce.
import batchBaseline from './__snapshots__/onboarding-batch.baseline.md';
import batchAllBaseline from './__snapshots__/onboarding-batch-all.baseline.md';
import reviewBaseline from './__snapshots__/onboarding-review.baseline.md';
import reviewAllBaseline from './__snapshots__/onboarding-review-all.baseline.md';

// The capability blocks — imported to assert their content + which live prompt they
// (do not) compose into. The OFF-PAGE trio composes into `onboarding-batch-all`
// (the holistic whole-store propose); the rest are AUTHORED-NOT-YET-COMPOSED.
import blockAudienceSegments from '../src/prompts/onboarding-shared/_block-audience-segments.md';
import blockDiscountSpecs from '../src/prompts/onboarding-shared/_block-discount-specs.md';
import blockStoreWideOutput from '../src/prompts/onboarding-shared/_block-store-wide-output.md';
import blockBoxPlacement from '../src/prompts/onboarding-shared/_block-box-placement.md';
import sharedAnchorNumbering from '../src/prompts/onboarding-shared/_shared-anchor-numbering.md';
import sharedScope from '../src/prompts/onboarding-shared/_shared-scope.md';
import sharedExistingConfig from '../src/prompts/onboarding-shared/_shared-existing-config.md';

const BASELINE: Record<string, string> = {
  'onboarding-batch': batchBaseline,
  'onboarding-batch-all': batchAllBaseline,
  'onboarding-review': reviewBaseline,
  'onboarding-review-all': reviewAllBaseline,
};

const ONBOARDING_PROMPTS = [
  'onboarding-batch',
  'onboarding-batch-all',
  'onboarding-review',
  'onboarding-review-all',
] as const;

// The three prompts whose composed text stays byte-identical to their baseline —
// the OFF-PAGE holistic additions compose into `onboarding-batch-all` ALONE.
const BYTE_IDENTICAL_PROMPTS = [
  'onboarding-batch',
  'onboarding-review',
  'onboarding-review-all',
] as const;

// The trailing JSON-only hardening line (`_shared-json-tail.md`) that closes every
// composed onboarding prompt. The batch-all baseline body is everything BEFORE it;
// the holistic build inserts the off-page blocks between the baseline body and this
// tail, so the tail is the seam that splits "baseline body" from "off-page additions".
const JSON_TAIL =
  'Respond with ONLY the JSON object, no prose, no explanation, no markdown code fences. Return only valid JSON.';

describe('onboarding prompt blocks — byte-equivalence gate', () => {
  it('a baseline exists for exactly the four live onboarding prompts', () => {
    expect(Object.keys(BASELINE).sort()).toEqual([...ONBOARDING_PROMPTS].sort());
    for (const name of ONBOARDING_PROMPTS) {
      // A committed baseline must be a real, non-trivial prompt — never empty
      // (an empty baseline would make the equality assertion vacuous).
      expect(typeof BASELINE[name]).toBe('string');
      expect((BASELINE[name] as string).length).toBeGreaterThan(1000);
    }
  });

  for (const name of BYTE_IDENTICAL_PROMPTS) {
    it(`${name}: composed prompt is BYTE-IDENTICAL to the committed baseline`, () => {
      const composed = getSystemPrompt(name, ENV).prompt;
      const committed = (BASELINE[name] as string).trim();
      // Byte-for-byte — no substring match, no normalization beyond the trailing
      // newline that composePrompt trims (the shipped image-selection convention).
      expect(composed).toBe(committed);
    });
  }

  describe('onboarding-batch-all: HOLISTIC — box/PB baseline unchanged + off-page ADDED', () => {
    const composed = () => getSystemPrompt('onboarding-batch-all', ENV).prompt;

    it('the box+PB placement portion (the baseline body) is byte-identical, as a PREFIX', () => {
      const baseline = (BASELINE['onboarding-batch-all'] as string).trim();
      // The baseline body = the baseline WITHOUT its trailing JSON-only line. That
      // whole box/PB placement instruction must survive verbatim as the composed
      // prompt's prefix — the holistic build only APPENDS off-page content, it never
      // edits the box/PB portion.
      const tailIndex = baseline.lastIndexOf(JSON_TAIL);
      expect(tailIndex).toBeGreaterThan(0);
      const baselineBody = baseline.slice(0, tailIndex).trimEnd();
      expect(baselineBody.length).toBeGreaterThan(1000);
      expect(composed().startsWith(baselineBody)).toBe(true);
    });

    it('the JSON-only tail still CLOSES the prompt (off-page blocks sit before it)', () => {
      expect(composed().endsWith(JSON_TAIL)).toBe(true);
    });

    it('the OFF-PAGE segments + discounts + store-wide-output blocks are all present AND new', () => {
      const text = composed();
      // Each off-page block composes in verbatim …
      expect(text).toContain(blockAudienceSegments.trim());
      expect(text).toContain(blockDiscountSpecs.trim());
      expect(text).toContain(blockStoreWideOutput.trim());
      // … and they are genuinely NEW vs the box/PB baseline (not already there).
      const baseline = BASELINE['onboarding-batch-all'] as string;
      expect(baseline).not.toContain('Audience segments are an OFF-PAGE item');
      expect(baseline).not.toContain('Bundle / discount campaigns are an OFF-PAGE item');
      expect(baseline).not.toContain('Store-wide OFF-PAGE output');
      // The holistic output names the two store-wide keys the lib #92 parser consumes.
      expect(text).toContain('`segments`');
      expect(text).toContain('`discounts`');
    });
  });

  it('the composed prompts do NOT carry per-shop VARIABLE data (cache-prefix stays stable)', () => {
    // The blocks are the STABLE, shop-independent prefix. A file id / screenshot
    // marker leaking into the composed system text would bust the cache and change
    // the wire per shop — assert none is present. (The manifest example lines in a
    // fragment describe the SHAPE only, never a real shop's tiles.) The off-page
    // blocks are equally stable — no per-shop data in segments/discounts either.
    for (const name of ONBOARDING_PROMPTS) {
      const composed = getSystemPrompt(name, ENV).prompt;
      expect(composed).not.toMatch(/file_id|shot_[a-z]|\bfileIds?\b/i);
    }
  });
});

/**
 * Coverage for the OFF-PAGE HOLISTIC blocks — COMPOSED into `onboarding-batch-all`
 * (the whole-store propose), and ONLY there. This suite proves (a) each carries its
 * intended instruction, (b) it composes into `onboarding-batch-all`, and (c) it does
 * NOT leak into the per-page `onboarding-batch` or the two review prompts (segments +
 * discounts are store-wide, not a per-page / review concern).
 */
describe('off-page holistic blocks — composed into onboarding-batch-all ONLY', () => {
  const OFF_PAGE: Record<string, { text: string; patterns: RegExp[]; marker: string }> = {
    '_block-audience-segments': {
      text: blockAudienceSegments,
      patterns: [/audience segments?/i, /OFF-PAGE/, /no website visual footprint/i, /rationale/],
      marker: 'Audience segments are an OFF-PAGE item',
    },
    '_block-discount-specs': {
      text: blockDiscountSpecs,
      patterns: [/discount/i, /bundle/i, /OFF-PAGE/, /audience/, /discountRate/],
      marker: 'Bundle / discount campaigns are an OFF-PAGE item',
    },
    '_block-store-wide-output': {
      text: blockStoreWideOutput,
      patterns: [/store-wide/i, /`segments`/, /`discounts`/, /STORE-WIDE, not per-page/],
      marker: 'Store-wide OFF-PAGE output',
    },
  };

  for (const [stem, { text, patterns }] of Object.entries(OFF_PAGE)) {
    it(`${stem}.md carries its intended instruction`, () => {
      expect(text.length).toBeGreaterThan(100);
      for (const pattern of patterns) expect(text).toMatch(pattern);
    });
  }

  it('composes into onboarding-batch-all', () => {
    const batchAll = getSystemPrompt('onboarding-batch-all', ENV).prompt;
    for (const [, { marker }] of Object.entries(OFF_PAGE)) {
      expect(batchAll).toContain(marker);
    }
  });

  it('does NOT leak into onboarding-batch (per-page) or the two review prompts', () => {
    const nonHolistic = ['onboarding-batch', 'onboarding-review', 'onboarding-review-all'] as const;
    for (const [, { text, marker }] of Object.entries(OFF_PAGE)) {
      expect(text).toContain(marker); // sanity: the marker really is in the block
      for (const name of nonHolistic) {
        expect(getSystemPrompt(name, ENV).prompt).not.toContain(marker);
      }
    }
  });
});

/**
 * Coverage for the INSERT+REPLACE box-placement block — the canonical placement
 * instruction COMPOSED into BOTH propose prompts (`onboarding-batch` +
 * `onboarding-batch-all`), and ONLY there (the two REVIEW prompts don't re-place
 * boxes, they only correct via the review verbs). This suite proves (a) the block
 * carries its intended INSERT+REPLACE instruction — the two candidate types, the
 * reference-style slot, and the per-number `type` / `outerHTML` MANIFEST contract
 * lib #99 must send — and (b) it composes into both propose prompts and NOT the
 * review prompts. Editing this one block updates both propose prompts at once.
 */
describe('box-placement block — INSERT + REPLACE, composed into both propose prompts', () => {
  it('_block-box-placement.md carries the INSERT+REPLACE instruction + manifest contract', () => {
    expect(blockBoxPlacement.length).toBeGreaterThan(100);
    for (const pattern of [
      /INSERT/,
      /REPLACE/,
      /styleReferenceSelector/,
      /outerHTML/,
      /cache breakpoint/i,
      // The per-number manifest input contract lib #99 must match EXACTLY.
      /`type: "insert"` \| `"replace"`/,
      /ONE continuous sequence/i,
    ]) {
      expect(blockBoxPlacement).toMatch(pattern);
    }
  });

  it('composes into BOTH propose prompts', () => {
    const marker = 'INSERT anchors (violet)';
    expect(blockBoxPlacement).toContain(marker); // sanity
    for (const name of ['onboarding-batch', 'onboarding-batch-all'] as const) {
      expect(getSystemPrompt(name, ENV).prompt).toContain(marker);
    }
  });

  it('does NOT compose into the two REVIEW prompts (they only correct, never place)', () => {
    const marker = 'INSERT anchors (violet)';
    for (const name of ['onboarding-review', 'onboarding-review-all'] as const) {
      expect(getSystemPrompt(name, ENV).prompt).not.toContain(marker);
    }
  });
});

/**
 * Coverage for the capability blocks still AUTHORED but NOT YET composed into any live
 * onboarding prompt (their behavioral wiring lands later with their lib consumers): the
 * canonical anchor-numbering block, and the reusable SCOPE / EXISTING-CONFIG partials.
 * This suite proves (a) each carries its intended instruction, and (b) it is NOT in any
 * live composed prompt (zero behavioral footprint), so composing one later is a one-line
 * `composePrompt` addition.
 */
describe('capability blocks — authored, unit-covered, NOT-yet-composed', () => {
  const AUTHORED: Record<string, { text: string; patterns: RegExp[]; marker: string }> = {
    '_shared-anchor-numbering': {
      text: sharedAnchorNumbering,
      patterns: [/anchorNumber/, /before/, /after/, /replace/, /1\.\.N/],
      marker: '## The numbered-anchor system',
    },
    '_shared-scope': {
      text: sharedScope,
      patterns: [/whole-store/, /single-page/, /single-surface/],
      marker: '## Scope of this request',
    },
    '_shared-existing-config': {
      text: sharedExistingConfig,
      patterns: [/existing config/i, /OPTIMIZE/i, /RETHINK/i, /greenfield/i],
      marker: '## Existing configuration (RETHINK, don',
    },
  };

  for (const [stem, { text, patterns }] of Object.entries(AUTHORED)) {
    it(`${stem}.md carries its intended instruction`, () => {
      expect(text.length).toBeGreaterThan(100);
      for (const pattern of patterns) expect(text).toMatch(pattern);
    });
  }

  it('NONE of the authored blocks leak into a live composed prompt (zero behavioral footprint)', () => {
    for (const [, { text, marker }] of Object.entries(AUTHORED)) {
      // sanity: the marker really is in the authored block
      expect(text).toContain(marker);
      for (const name of ONBOARDING_PROMPTS) {
        expect(getSystemPrompt(name, ENV).prompt).not.toContain(marker);
      }
    }
  });
});
