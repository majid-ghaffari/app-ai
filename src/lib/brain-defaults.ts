/**
 * Brain-defaults provider — fetch → project → cache the canonical PLATFORM
 * default recommendation settings so the onboarding/cart-drawer PROPOSE prompts
 * can be told the platform's global defaults WITHOUT the lib serializing them into a
 * transport field. Studio never sends the defaults; app-ai fetches them here.
 *
 * WHAT it fetches: the canonical global Brain default `RecommendationsSettings`
 * via the same authenticated Brain endpoint the toolsets use
 * (`GET ${PERSONALIZER_API_URL}/v1/personalizerConfig?defaultRecommendationsSettings=true`,
 * forwarding the merchant `X-Personalizer-Context-ID`). The source URL is behind
 * a config seam (`recommendationsDefaultsUrl`) so it can later point at the
 * platform's CDN-hosted defaults without touching the orchestration below.
 *
 * WHAT it projects: ONLY the AI-relevant per-box defaults (fallback method,
 * style, image dimensions, image right-margin, add-to-cart title, items limit) —
 * never the whole settings object — preserving the PAGE -> BOX hierarchy and the
 * SAME effective appearance inheritance Studio computes. DESKTOP and MOBILE are
 * projected DISTINCTLY (mobile carries its own image dims in a `mobile` sub-
 * object) and there are THREE inheritance tiers, resolved independently per
 * device: the GLOBAL `BoxOptions.AppearanceOptions` / `AppearanceOptionsMobile`
 * UNDER the PAGE-level `BoxHostPageSettings.AppearanceOptions` /
 * `AppearanceOptionsMobile` UNDER the per-box `BoxSettings.AppearanceOptions` /
 * `AppearanceOptionsMobile` — per-box wins, then page, then global. This mirrors
 * the lib's `admin/core/box-defaults.ts` (two independent `mergeEffectiveApp-
 * earance` chains). Because desktop and mobile are separate fields, a mobile
 * ImageMaxWidth=150 is NEVER suppressed by a desktop ImageMaxWidth=200 (the flat
 * "desktop wins" projection could not express both). The result is a COMPACT,
 * byte-STABLE canonical JSON (sorted page + box keys, fixed field order, absent
 * fields omitted), so the same global defaults produce identical bytes for every
 * store and Anthropic's prompt cache HITS across tenants — and a page-scoped box
 * (Product FBT = bundle) never leaks a same-typed box from another page (Cart FBT
 * = carousel).
 *
 * CACHING: one in-isolate promise/result is shared globally because the source is
 * global. Concurrent cold requests share the same fetch. A successful projected
 * block remains the isolate's last-known-good value; a cold failure returns no
 * block and leaves the cache empty so a later request can retry. The cache stores
 * no tenant data; the context-ID authenticates the Brain fetch and is never stored.
 */

import { personalizerApiUrl, recommendationsDefaultsUrl, type Env } from '../config';
import { createLogger } from './logger';

const log = createLogger('BrainDefaults');

/** Brain endpoint path (no scheme — the base comes from `personalizerApiUrl`). */
const BRAIN_DEFAULTS_PATH = 'v1/personalizerConfig?defaultRecommendationsSettings=true';

/**
 * The MOBILE image dimensions — the ONLY appearance fields that vary per device
 * on the platform (Brain's `AppearanceOptionsMobile` carries only image dims).
 * Projected as a distinct sub-object so a mobile value is expressed alongside,
 * never merged into, the desktop value. Absent fields omitted; fixed order.
 */
export interface ProjectedMobileDefaults {
  imageMaxWidth?: number;
  imageMaxHeight?: number;
  imageMarginRight?: number;
}

/**
 * The AI-relevant per-box default fields — the ONLY fields projected out of a
 * box's effective settings. The top-level appearance fields are the DESKTOP
 * effective values; `mobile` carries the (distinct) mobile image dims. Absent
 * fields are omitted (keeps the JSON compact + stable). Field order here is the
 * FIXED emission order (`mobile` last).
 */
export interface ProjectedBoxDefaults {
  fallbackMethod?: string;
  style?: string;
  itemsLimit?: number;
  imageMaxWidth?: number;
  imageMaxHeight?: number;
  imageMarginRight?: number;
  quickActionsAddToCartTitle?: string;
  mobile?: ProjectedMobileDefaults;
}

/**
 * The compact projection: AI-relevant defaults keyed by PAGE then by BOX type
 * (both sorted), preserving the page -> box hierarchy so a box's default is
 * scoped to its page (no cross-page leak).
 */
export interface ProjectedDefaults {
  pages: Record<string, Record<string, ProjectedBoxDefaults>>;
}

/** One successful GLOBAL projected block, shared by every request in the isolate. */
let cachedBlock: string | null = null;

/** The shared cold-load promise, preventing duplicate concurrent source fetches. */
let pendingLoad: Promise<string | null> | null = null;

/** Reset the in-isolate cache. TEST-ONLY (isolates never persist in prod). */
export function resetDefaultsCacheForTests(): void {
  cachedBlock = null;
  pendingLoad = null;
}

/**
 * The AI-RELEVANT projected defaults as an injectable prompt block, or `null`
 * when the cold load fails. Successful results are shared for the isolate;
 * failures are not cached, so a later request can retry.
 *
 * `contextId` authenticates the Brain fetch and is NEVER logged or stored.
 */
export async function getDefaultsBlock(contextId: string, env: Env): Promise<string | null> {
  if (cachedBlock) return cachedBlock;
  if (pendingLoad) return pendingLoad;

  pendingLoad = loadDefaultsBlock(contextId, env);
  try {
    const block = await pendingLoad;
    if (block) cachedBlock = block;
    return block;
  } finally {
    pendingLoad = null;
  }
}

/** Fetch, project, and frame the global defaults once for this isolate. */
async function loadDefaultsBlock(contextId: string, env: Env): Promise<string | null> {
  try {
    const cdnUrl = recommendationsDefaultsUrl(env);
    const url = cdnUrl ?? `${personalizerApiUrl(env)}/${BRAIN_DEFAULTS_PATH}`;
    const init: RequestInit = cdnUrl
      ? { method: 'GET' }
      : { method: 'GET', headers: { 'X-Personalizer-Context-ID': contextId } };
    const response = await fetch(url, init);
    if (!response.ok) {
      log.warn(`defaults fetch ${response.status}; skipping injection`);
      return null;
    }

    const projected = projectDefaults((await response.json()) as unknown);
    const block = buildDefaultsBlock(canonicalStringify(projected));
    log.info(`defaults projected (${Object.keys(projected.pages).length} pages)`);
    return block;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn(`defaults fetch failed (${reason}); skipping injection`);
    return null;
  }
}

/**
 * Deterministically project ONLY the AI-relevant per-box defaults out of a raw
 * `RecommendationsSettings` object, preserving the PAGE -> BOX hierarchy.
 * Navigation is case-insensitive (robust to Pascal/camel serialization). For
 * each page + box, DESKTOP and MOBILE appearance are resolved INDEPENDENTLY over
 * THREE tiers — the GLOBAL `BoxOptions` appearance UNDER the PAGE-level
 * `BoxHostPageSettings` appearance UNDER the per-box `BoxSettings` appearance,
 * per-box winning, then page, then global — the SAME inheritance the lib's
 * `admin/core/box-defaults.ts` computes. A box with no AI-relevant field is
 * omitted; a page with no projected box is omitted. Page keys and box keys are
 * each sorted, so `canonicalStringify` yields byte-stable output. A same-typed
 * box on two pages (Product FBT vs Cart FBT) keeps its OWN per-page settings — no
 * cross-leak.
 */
export function projectDefaults(raw: unknown): ProjectedDefaults {
  const pages: Record<string, Record<string, ProjectedBoxDefaults>> = {};
  const boxOptions = getKey(raw, 'BoxOptions');
  const globalDesktop = getKey(boxOptions, 'AppearanceOptions');
  const globalMobile = getKey(boxOptions, 'AppearanceOptionsMobile');
  const hostPages = getKey(boxOptions, 'HostPages');
  if (hostPages && typeof hostPages === 'object') {
    for (const pageKey of Object.keys(hostPages as Record<string, unknown>).sort()) {
      const page = (hostPages as Record<string, unknown>)[pageKey];
      const pageDesktop = getKey(page, 'AppearanceOptions');
      const pageMobile = getKey(page, 'AppearanceOptionsMobile');
      const pageBoxes = getKey(page, 'Boxes');
      if (!pageBoxes || typeof pageBoxes !== 'object') continue;
      const boxes: Record<string, ProjectedBoxDefaults> = {};
      for (const boxKey of Object.keys(pageBoxes as Record<string, unknown>).sort()) {
        const projected = projectBox((pageBoxes as Record<string, unknown>)[boxKey], {
          globalDesktop,
          pageDesktop,
          globalMobile,
          pageMobile,
        });
        if (projected) boxes[boxKey] = projected;
      }
      if (Object.keys(boxes).length > 0) pages[pageKey] = boxes;
    }
  }
  return { pages };
}

/** The four appearance sources that flank a box, one per (device × tier). */
interface AppearanceTiers {
  globalDesktop: unknown;
  pageDesktop: unknown;
  globalMobile: unknown;
  pageMobile: unknown;
}

/**
 * The effective value of an appearance `field`: the FIRST defined value walking
 * the sources in precedence order (per-box → page → global). Case-insensitive
 * per source.
 */
function pickEffective(field: string, ...sources: unknown[]): unknown {
  for (const source of sources) {
    const value = getKey(source, field);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Project one box's AI-relevant defaults. DESKTOP appearance resolves per-box
 * over page over global; MOBILE image dims resolve per-box over page over global
 * INDEPENDENTLY, into the distinct `mobile` sub-object (so a mobile dim is never
 * suppressed by a desktop one). Returns `null` when the box has no AI-relevant
 * field at all.
 */
function projectBox(box: unknown, tiers: AppearanceTiers): ProjectedBoxDefaults | null {
  const perBoxDesktop = getKey(box, 'AppearanceOptions');
  const perBoxMobile = getKey(box, 'AppearanceOptionsMobile');
  // Precedence within each device: per-box → page → global.
  const desktop = [perBoxDesktop, tiers.pageDesktop, tiers.globalDesktop];
  const mobile = [perBoxMobile, tiers.pageMobile, tiers.globalMobile];

  const fallbackMethod = asString(getKey(box, 'FallbackMethod'));
  const style = asString(pickEffective('Style', ...desktop));
  const itemsLimit = asNumber(pickEffective('ItemsLimit', ...desktop) ?? getKey(box, 'ItemsLimit'));
  const imageMaxWidth = asNumber(pickEffective('ImageMaxWidth', ...desktop));
  const imageMaxHeight = asNumber(pickEffective('ImageMaxHeight', ...desktop));
  const imageMarginRight = asNumber(pickEffective('ImageMarginRight', ...desktop));
  const quickActionsAddToCartTitle = asString(
    pickEffective('QuickActionsAddToCartTitle', ...desktop),
  );

  // Mobile carries only image dims (Brain's mobile appearance has nothing else).
  const mobileImageMaxWidth = asNumber(pickEffective('ImageMaxWidth', ...mobile));
  const mobileImageMaxHeight = asNumber(pickEffective('ImageMaxHeight', ...mobile));
  const mobileImageMarginRight = asNumber(pickEffective('ImageMarginRight', ...mobile));
  const mobileDefaults: ProjectedMobileDefaults = {};
  if (mobileImageMaxWidth !== undefined) mobileDefaults.imageMaxWidth = mobileImageMaxWidth;
  if (mobileImageMaxHeight !== undefined) mobileDefaults.imageMaxHeight = mobileImageMaxHeight;
  if (mobileImageMarginRight !== undefined) {
    mobileDefaults.imageMarginRight = mobileImageMarginRight;
  }

  // Assemble in a FIXED key order so identical inputs serialize identically.
  const projected: ProjectedBoxDefaults = {};
  if (fallbackMethod !== undefined) projected.fallbackMethod = fallbackMethod;
  if (style !== undefined) projected.style = style;
  if (itemsLimit !== undefined) projected.itemsLimit = itemsLimit;
  if (imageMaxWidth !== undefined) projected.imageMaxWidth = imageMaxWidth;
  if (imageMaxHeight !== undefined) projected.imageMaxHeight = imageMaxHeight;
  if (imageMarginRight !== undefined) projected.imageMarginRight = imageMarginRight;
  if (quickActionsAddToCartTitle !== undefined) {
    projected.quickActionsAddToCartTitle = quickActionsAddToCartTitle;
  }
  if (Object.keys(mobileDefaults).length > 0) projected.mobile = mobileDefaults;
  return Object.keys(projected).length > 0 ? projected : null;
}

/**
 * Serialize the projection with STABLE property ordering: pages sorted, boxes
 * within each page sorted, and each box's fields in the FIXED emission order.
 * Rebuilt here (not relying on `projectDefaults`'s insertion order) so the bytes
 * are canonical regardless of how the projection was assembled.
 */
export function canonicalStringify(projected: ProjectedDefaults): string {
  const pages: Record<string, Record<string, ProjectedBoxDefaults>> = {};
  for (const pageKey of Object.keys(projected.pages).sort()) {
    const boxes = projected.pages[pageKey] ?? {};
    const sortedBoxes: Record<string, ProjectedBoxDefaults> = {};
    for (const boxKey of Object.keys(boxes).sort()) {
      sortedBoxes[boxKey] = orderBoxFields(boxes[boxKey] as ProjectedBoxDefaults);
    }
    pages[pageKey] = sortedBoxes;
  }
  return JSON.stringify({ pages });
}

/** Rebuild one box's fields in the FIXED emission order, omitting absent ones. */
function orderBoxFields(box: ProjectedBoxDefaults): ProjectedBoxDefaults {
  const ordered: ProjectedBoxDefaults = {};
  if (box.fallbackMethod !== undefined) ordered.fallbackMethod = box.fallbackMethod;
  if (box.style !== undefined) ordered.style = box.style;
  if (box.itemsLimit !== undefined) ordered.itemsLimit = box.itemsLimit;
  if (box.imageMaxWidth !== undefined) ordered.imageMaxWidth = box.imageMaxWidth;
  if (box.imageMaxHeight !== undefined) ordered.imageMaxHeight = box.imageMaxHeight;
  if (box.imageMarginRight !== undefined) ordered.imageMarginRight = box.imageMarginRight;
  if (box.quickActionsAddToCartTitle !== undefined) {
    ordered.quickActionsAddToCartTitle = box.quickActionsAddToCartTitle;
  }
  if (box.mobile !== undefined) ordered.mobile = orderMobileFields(box.mobile);
  return ordered;
}

/** Rebuild the mobile sub-object's fields in the FIXED emission order. */
function orderMobileFields(mobile: ProjectedMobileDefaults): ProjectedMobileDefaults {
  const ordered: ProjectedMobileDefaults = {};
  if (mobile.imageMaxWidth !== undefined) ordered.imageMaxWidth = mobile.imageMaxWidth;
  if (mobile.imageMaxHeight !== undefined) ordered.imageMaxHeight = mobile.imageMaxHeight;
  if (mobile.imageMarginRight !== undefined) ordered.imageMarginRight = mobile.imageMarginRight;
  return ordered;
}

/** Build the byte-stable injectable defaults block around canonical JSON. */
function buildDefaultsBlock(projectedJson: string): string {
  return [
    '# Platform default box settings',
    "The platform's global DEFAULTS for the boxes you may propose, grouped by PAGE then box type. Each box's top-level fields are the DESKTOP effective settings (fallback method, style, items limit, image dimensions, image right-margin, add-to-cart button title); the `mobile` sub-object holds the box's distinct MOBILE image dimensions (a mobile image width may differ from desktop and stands on its own — it is not overridden by the desktop value). All values are the effective result of the platform's global → page → per-box appearance inheritance. Treat them as SOFT defaults you may keep or override per box. Do not restate them in your output.",
    projectedJson,
  ].join('\n\n');
}

/** Case-insensitive single-level key read (Pascal/camel tolerant). */
function getKey(object: unknown, key: string): unknown {
  if (!object || typeof object !== 'object') return undefined;
  const record = object as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  const lower = key.toLowerCase();
  for (const candidate of Object.keys(record)) {
    if (candidate.toLowerCase() === lower) return record[candidate];
  }
  return undefined;
}

/** Coerce a scalar to a non-empty string, or `undefined`. */
function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Coerce a finite number (or numeric string), or `undefined`. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
