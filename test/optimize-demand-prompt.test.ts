/**
 * Coverage for the on-demand OPTIMIZE prompt (#98): `optimize-demand` (PROPOSE).
 *
 * On-demand optimize is 100% AI, like onboarding, but scoped to ONE page the merchant
 * is looking at and driven by a request they TYPED. It captures that page at desktop +
 * mobile widths, PROPOSES recommendation box(es) — honoring the merchant's demand FIRST
 * then filling gaps with best practice — applies them, then QCs by REUSING the existing
 * `onboarding-review` prompt (single-page QC is identical; the demand does not gate the
 * verdict for v1 — decision recorded here, no separate `optimize-review` authored).
 *
 * `optimize-demand` is COMPOSED (src/prompt-registry.ts, via `composePrompt`) EXACTLY like the
 * single-page `onboarding-batch` but demand-first: it REUSES the shared onboarding blocks
 * (box-placement INSERT+REPLACE, mobile-first, JSON hardening/tail, guidance, box vocab,
 * appearance header, mobile rule) PLUS one NEW shared block `_block-user-demand.md`, and
 * only the optimize-specific fragments under `optimize-demand/` are authored anew. This
 * test pins (a) the entry resolves with the right model class + no tools, (b) the composed
 * text carries its blocks in the FROZEN cache-first order (demand block right after the
 * intro, before the placement/vocab/styling instruction), (c) it states the SINGLE-PAGE
 * `{ page, boxes }` output contract with NO `pages` wrapper / progressBar / segments /
 * discounts, (d) the shared box-placement + JSON-tail blocks are REUSED, and (e) the
 * composed prompt carries NO per-shop VARIABLE data (the cache prefix stays stable — the
 * merchant's actual DEMAND rides after the breakpoint, not in the system prefix).
 *
 * The blocks import through the SAME raw-`.md` loader as the prompts (vitest.config.ts
 * raw-markdown plugin / wrangler Text rule), so no `node:fs`. No network.
 */

import { describe, it, expect } from 'vitest';

import { getSystemPrompt } from '../src/prompt-registry';
import { ENV } from './helpers';

// The NEW demand block + the reused shared blocks, imported to assert composition + order.
import blockUserDemand from '../src/prompts/onboarding-shared/_block-user-demand.md';
import optimizeDemandIntro from '../src/prompts/optimize-demand/_intro.md';

// The trailing JSON-only hardening line (`_shared-json-tail.md`) that closes the prompt.
const JSON_TAIL =
  'Respond with ONLY the JSON object, no prose, no explanation, no markdown code fences. Return only valid JSON.';

// A distinctive marker from the reused `_block-box-placement.md` (INSERT+REPLACE).
const BOX_PLACEMENT_MARKER = 'INSERT anchors (violet)';

// A distinctive marker from the NEW `_block-user-demand.md`.
const DEMAND_MARKER = "The merchant's explicit request comes FIRST";

describe('optimize-demand — registry resolution + model class', () => {
  it('resolves by name and returns non-trivial prompt text, no tools', () => {
    const entry = getSystemPrompt('optimize-demand', ENV);
    expect(typeof entry.prompt).toBe('string');
    expect(entry.prompt.length).toBeGreaterThan(1000);
    expect(entry.usesTools).toBe(false);
    expect(entry.clientTools).toBeUndefined();
  });

  it('is the `balanced` tier (Sonnet), like onboarding-batch', () => {
    const optimize = getSystemPrompt('optimize-demand', ENV);
    const onboarding = getSystemPrompt('onboarding-batch', ENV);
    // Both are the `balanced` tier — the same Sonnet reasoner class.
    expect(optimize.model).toBe(onboarding.model);
    expect(optimize.model).toBe(ENV.MODEL_BALANCED);
    expect(optimize.maxTokens).toBe(4096);
  });
});

describe('optimize-demand — demand-first, composed in the FROZEN cache-first order', () => {
  const composed = () => getSystemPrompt('optimize-demand', ENV).prompt;

  it('carries the NEW user-demand block, and it composes into NO onboarding prompt', () => {
    const text = composed();
    expect(text).toContain(blockUserDemand.trim());
    expect(text).toContain(DEMAND_MARKER);
    // The demand block is optimize-only — it must NOT leak into the onboarding /
    // cart-drawer prompts (those are not demand-driven).
    for (const name of [
      'onboarding-batch',
      'onboarding-batch-all',
      'onboarding-review',
      'cartdrawer-batch-all',
    ] as const) {
      expect(getSystemPrompt(name, ENV).prompt).not.toContain(DEMAND_MARKER);
    }
  });

  it('places the demand block RIGHT AFTER the intro and BEFORE the placement instruction', () => {
    const text = composed();
    const introEnd = text.indexOf(optimizeDemandIntro.trim()) + optimizeDemandIntro.trim().length;
    const demandAt = text.indexOf(DEMAND_MARKER);
    const placementAt = text.indexOf(BOX_PLACEMENT_MARKER);
    const mobileFirstAt = text.indexOf('Mobile is the majority of ecommerce shoppers');
    // intro → demand → mobile-first → box-placement — the frozen cache-first order.
    expect(introEnd).toBeGreaterThan(0);
    expect(demandAt).toBeGreaterThan(introEnd - 1);
    expect(mobileFirstAt).toBeGreaterThan(demandAt);
    expect(placementAt).toBeGreaterThan(mobileFirstAt);
  });

  it('states the SINGLE-PAGE `{ page, boxes }` output contract with NO pages wrapper / off-page keys', () => {
    const text = composed();
    // Per-page shape (like onboarding-batch), not the whole-store `pages` map.
    expect(text).toContain('`page` and `boxes`');
    expect(text).toContain('"page": "Product"');
    expect(text).not.toMatch(/"pages"\s*:\s*\{/);
    // On-demand optimize places boxes only — NO progress bar, NO store-wide off-page keys.
    expect(text).toMatch(/NO `progressBar` key/);
    expect(text).toMatch(/NO off-page `segments` \/ `discounts` keys/);
    // The per-page box fields the lib parser must match.
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

  it('REUSES the shared box-placement block and the JSON tail, and ENDS with the tail', () => {
    const text = composed();
    expect(text).toContain(BOX_PLACEMENT_MARKER);
    expect(text).toContain(JSON_TAIL);
    expect(text.endsWith(JSON_TAIL)).toBe(true);
  });
});

describe('optimize-demand — cache-prefix stays stable (no per-shop data)', () => {
  it('the composed prompt does NOT carry per-shop VARIABLE data (the demand rides after the breakpoint)', () => {
    // The blocks are the STABLE, shop-independent prefix — the merchant's actual typed
    // demand + the screenshots + manifest ride AFTER the cache breakpoint in the first
    // user message. A file id / screenshot reference leaking into the system text would
    // bust the cache; assert none is present (same assertion as the onboarding test).
    const composed = getSystemPrompt('optimize-demand', ENV).prompt;
    expect(composed).not.toMatch(/file_id|fileIds?/i);
  });
});
