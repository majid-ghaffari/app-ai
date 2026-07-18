/**
 * Coverage for the cart-drawer conductor's two SINGLE-SURFACE prompts (#96):
 * `cartdrawer-batch-all` (PROPOSE) + `cartdrawer-review-all` (REVIEW).
 *
 * The cart-drawer conductor is 100% AI, like onboarding: it opens the merchant's
 * cart DRAWER (a rendered overlay), screenshots the OPEN drawer at desktop + mobile
 * widths, PROPOSES recommendation box(es) to place INSIDE the drawer, applies them,
 * then does a VISUAL REVIEW. It is a SINGLE surface (the drawer), NOT paginated — so
 * both prompts drop the `pages` wrapper the onboarding twins use. These are composed
 * from the SAME shared onboarding blocks (box-placement, mobile-first, JSON
 * hardening/tail, box vocab, correction verbs, review classify) plus drawer-specific
 * fragments (src/prompt-registry.ts). This test proves (a) both registry entries resolve with
 * the right model class + no tools, (b) the propose prompt carries the drawer-specific
 * guidance + the SINGLE-SURFACE `{ boxes: [...] }` output contract, (c) the review
 * prompt carries the SINGLE-SURFACE verdict contract, (d) the shared box-placement +
 * JSON-tail blocks are REUSED, and (e) the composed prompts carry NO per-shop VARIABLE
 * data (the cache prefix stays stable).
 *
 * The blocks import through the SAME raw-`.md` loader as the prompts
 * (vitest.config.ts raw-markdown plugin / wrangler Text rule), so no `node:fs`. No
 * network.
 */

import { describe, it, expect } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { ENV } from './helpers';

const CARTDRAWER_PROMPTS = ['cartdrawer-batch-all', 'cartdrawer-review-all'] as const;

// The trailing JSON-only hardening line (`_shared-json-tail.md`) that closes every
// composed cart-drawer prompt — a distinctive marker that the shared tail is reused.
const JSON_TAIL =
  'Respond with ONLY the JSON object, no prose, no explanation, no markdown code fences. Return only valid JSON.';

// A distinctive marker from the reused `_block-box-placement.md` (INSERT+REPLACE).
const BOX_PLACEMENT_MARKER = 'INSERT anchors (violet)';

describe('cart-drawer prompts — registry resolution + model class', () => {
  it('both entries resolve by name and return non-trivial prompt text', () => {
    for (const name of CARTDRAWER_PROMPTS) {
      const entry = getSystemPrompt(name, ENV);
      expect(typeof entry.prompt).toBe('string');
      expect(entry.prompt.length).toBeGreaterThan(1000);
      expect(entry.usesTools).toBe(false);
      expect(entry.clientTools).toBeUndefined();
    }
  });

  it('cartdrawer-batch-all is the `balanced` tier (Sonnet), like onboarding-batch-all', () => {
    const drawer = getSystemPrompt('cartdrawer-batch-all', ENV);
    const onboarding = getSystemPrompt('onboarding-batch-all', ENV);
    // Both are the `balanced` tier — the same Sonnet reasoner class.
    expect(drawer.model).toBe(onboarding.model);
    expect(drawer.model).toBe(ENV.MODEL_BALANCED);
    expect(drawer.maxTokens).toBe(4096);
  });

  it('cartdrawer-review-all is the `balanced` tier (Sonnet), like onboarding-review-all', () => {
    const drawer = getSystemPrompt('cartdrawer-review-all', ENV);
    const onboarding = getSystemPrompt('onboarding-review-all', ENV);
    // Both are the `balanced` tier — the same Sonnet reasoner class.
    expect(drawer.model).toBe(onboarding.model);
    expect(drawer.model).toBe(ENV.MODEL_BALANCED);
    expect(drawer.maxTokens).toBe(2048);
  });
});

describe('cartdrawer-batch-all (PROPOSE) — drawer guidance + single-surface output', () => {
  const composed = () => getSystemPrompt('cartdrawer-batch-all', ENV).prompt;

  it('carries the drawer-specific placement guidance', () => {
    const text = composed();
    // Distinctive markers from _drawer-guidance.md: below the line items / above the
    // checkout CTA, and fitting the narrow drawer.
    expect(text).toContain('BELOW the line items and ABOVE the checkout CTA');
    expect(text).toMatch(/FITS the drawer's narrow width/);
    expect(text).toMatch(/compact slide-out OVERLAY/i);
    // Drawer-strong box types are called out.
    expect(text).toMatch(/cross-sell/i);
  });

  it('states the SINGLE-SURFACE `{ boxes: [...] }` output contract, with NO `pages` wrapper', () => {
    const text = composed();
    expect(text).toContain('`boxes`');
    expect(text).toContain('{\n  "boxes": [');
    // No per-page map in the OUTPUT SHAPE — a `"pages": {` wrapper is the onboarding
    // shape and must be absent (the prose may say "no `pages` wrapper", which is fine;
    // what must not appear is the JSON key / a per-page map structure).
    expect(text).not.toContain('"pages"');
    expect(text).not.toMatch(/"pages"\s*:\s*\{/);
    // The drawer is compact: the schema explicitly EXCLUDES the progress bar + the
    // store-wide off-page keys (they must not appear as an OUTPUT key — the prompt
    // spells out that they are NOT part of the drawer's output).
    expect(text).toMatch(/NO `progressBar`/);
    expect(text).toMatch(/NO off-page `segments` \/ `discounts`/);
    // The single-surface box fields the lib parser must match.
    for (const field of [
      'boxType',
      'position',
      'anchorNumber',
      'styleReferenceSelector',
      'appearancePatch',
      'appearancePatchMobile',
      'reasoning',
    ]) {
      expect(text).toContain(field);
    }
  });

  it('REUSES the shared box-placement block and the JSON tail', () => {
    const text = composed();
    expect(text).toContain(BOX_PLACEMENT_MARKER);
    expect(text).toContain(JSON_TAIL);
  });
});

describe('cartdrawer-review-all (REVIEW) — single-surface verdict', () => {
  const composed = () => getSystemPrompt('cartdrawer-review-all', ENV).prompt;

  it('states the SINGLE-SURFACE verdict contract, with NO `pages` wrapper', () => {
    const text = composed();
    // The flat verdict fields the lib parser must match.
    for (const field of ['pass', 'feedback', 'corrections', 'failureClass']) {
      expect(text).toContain(field);
    }
    // The example verdict is FLAT, not a per-page map — the `"pages": {` JSON wrapper
    // must be absent (prose saying "no `pages` wrapper" is fine).
    expect(text).not.toContain('"pages"');
    expect(text).not.toMatch(/"pages"\s*:\s*\{/);
    // The three write verbs are present …
    for (const verb of ['styleBox', 'removeBox', 'addBox']) {
      expect(text).toContain(verb);
    }
    // … and corrections drop the per-page `args.page` requirement (single surface).
    expect(text).toContain('NO `page` field');
  });

  it('reuses the JSON tail (shared block)', () => {
    expect(composed()).toContain(JSON_TAIL);
  });
});

describe('cart-drawer prompts — cache-prefix stays stable (no per-shop data)', () => {
  it('the composed prompts do NOT carry per-shop VARIABLE data', () => {
    // The blocks are the STABLE, shop-independent prefix. A file id / screenshot
    // reference leaking into the composed system text would bust the cache and change
    // the wire per shop — assert none is present (same assertion as the onboarding test).
    for (const name of CARTDRAWER_PROMPTS) {
      const composed = getSystemPrompt(name, ENV).prompt;
      expect(composed).not.toMatch(/file_id|fileIds?/i);
    }
  });
});
