/**
 * Entity-context resolution for record refs (`campaign` / `segment` /
 * `progress-bar` / `bundle`) — the personalizer toolset's normalizer: the data
 * behind the Referenced-Entities block (lib/references.ts) and the
 * `get_entity_context` tool's record dispatch (./index.ts).
 *
 * `fetchEntityContext(type, id, contextId, env)` composes the model-visible
 * `AiToolEntityContext` shape worker-side from Personalizer's per-record admin
 * endpoints (one fetcher per ref type, ENTITY_FETCHERS below), forwarding the
 * merchant's X-Personalizer-Context-ID on every call. The output shape is a
 * frozen cross-repo contract (lib `packages/storefront/src/admin/ai/CONTRACTS.md`
 * §2):
 *
 *   { Type, Id, Found, Title, Status, Kind, Summary, Fields, Related }
 *
 * Null/undefined members are omitted (matching Brain's NullValueHandling.Ignore
 * serialization), and a valid id that resolves to nothing — unknown, deleted,
 * or cross-subscriber — degrades to `{ Type, Id, Found: false }`, never a throw.
 *
 * Brain routes per ref type (Brain's C# is the source of truth — root
 * CLAUDE.md → Hard rules):
 *   campaign      GET v2/discount-campaigns/discount-campaign/{guid}   (probe 1)
 *                 GET v2/html-campaigns/html-campaign/{guid}           (probe 2)
 *                 GET v1/imageCampaigns?guid={guid}                    (probe 3)
 *   segment       GET v1/subscriberSegment?guid={guid}
 *   progress-bar  GET v2/progress-bar-campaigns/{guid}
 *   bundle        GET v2/discount-campaigns/discount-campaign/{guid}
 *   (all types)   GET v2/accounts/subscriber — the merchant's Subscriber record:
 *                 its Guid drives the tenant re-check on every loaded entity
 *                 (the discount-campaign cache is keyed by guid only, and the
 *                 v1 segment load is not tenant-scoped), and its CurrencyCode
 *                 fills the progress-bar Currency field.
 *   related       GET v1/subscriberSegment?guid={guid} per targeted segment
 *                 (discount/bundle one-hop Related, tenant-checked + non-deleted)
 *
 * Failure semantics: a malformed guid, an unknown type, a failed subscriber
 * lookup, a Personalizer 401/403, or a network failure THROWS (callers degrade — the
 * eager block renders `(could not load)`, the tool returns `{ ok: false }`).
 * Any other per-record fetch outcome (404, 204/empty, 5xx, unparsable body)
 * counts as a miss → `Found: false`, mirroring Brain's swallowed facade reads.
 *
 * These fetches ride the request's already-validated context-ID — Personalizer
 * re-validates it on every proxied call, so no extra validation roundtrip is
 * made here.
 */

import { personalizerApiUrl, type Env } from '../../config';

// ── Brain read views (the members this worker consumes; Brain's C# entities
//    carry more — these are read-only projections, never written back) ────────

/** Brain: `Controllers/V2/AccountsController.cs` → `subscriber`. */
export interface BrainSubscriber {
  Guid: string;
  CurrencyCode?: string;
  [member: string]: unknown;
}

/** Common tenant members every loaded record is re-checked against. */
interface BrainTenantRecord {
  Guid?: string;
  SubscriberGuid?: string;
  [member: string]: unknown;
}

/** Brain: `Controllers/V2/DiscountCampaignsController.cs` (read view). */
interface BrainDiscountCampaign extends BrainTenantRecord {
  Title?: string;
  Status?: string;
  DiscountTarget?: string;
  DiscountType?: string;
  DiscountPercentage?: number;
  DiscountAmount?: number;
  StartDate?: string;
  EndDate?: string;
  Conditions?: { BundleCondition?: { MinimumAmount?: number } };
  UserSegmentGuids?: string[];
}

/** Brain: `Controllers/V2/HtmlCampaignsController.cs` / `Controllers/V1/ImageCampaignsController.cs` (read view). */
interface BrainContentCampaign extends BrainTenantRecord {
  Title?: string;
  Status?: string;
  CreateDate?: string;
}

/** Brain: `Controllers/V1/SubscriberSegmentController.cs` (read view). */
interface BrainSegment extends BrainTenantRecord {
  Title?: string;
  Status?: string;
  Deleted?: boolean;
  TemplateGuid?: string;
  Description?: string;
  CreationDate?: string;
}

/** Brain: `Controllers/V2/ProgressBarCampaignsController.cs` (read view). */
interface BrainProgressBarCampaign extends BrainTenantRecord {
  Title?: string;
  Status?: string;
  Tiers?: Array<BrainProgressBarTier | null>;
  FinalMessage?: string;
  CreateDate?: string;
}

interface BrainProgressBarTier {
  MinimumAmount?: number;
  OfferType?: string;
  DiscountPercentage?: number;
  DiscountAmount?: number;
  OfferMessage?: string;
  [member: string]: unknown;
}

// ── The frozen model-visible output shape ────────────────────────────────────

/** One `Related` entry (a targeted segment, one hop). */
export interface RelatedEntity {
  Type: 'segment';
  Id: string;
  Title?: string;
}

/**
 * The frozen model-visible entity-context shape (lib CONTRACTS.md §2). Members
 * that resolve null/undefined are OMITTED from the serialized object (matching
 * Brain's NullValueHandling.Ignore) — `prune` enforces that.
 */
export interface AiToolEntityContext {
  Type: string;
  Id: string;
  Found: boolean;
  Title?: string;
  Status?: string;
  Kind?: string;
  Summary?: string;
  Fields?: Record<string, unknown>;
  Related?: RelatedEntity[];
}

/** The pre-prune per-type context (null members allowed; pruned before return). */
interface EntityContextDetails {
  Title: string | undefined;
  Status: string | undefined;
  Kind: string | null;
  Summary: string;
  Fields: Record<string, unknown>;
  Related: RelatedEntity[];
}

/**
 * Per-request scratch object: concurrent resolutions passing the same object
 * share ONE `v2/accounts/subscriber` lookup (lib/references.ts block builds).
 */
export interface SharedEntityLookup {
  subscriberPromise?: Promise<BrainSubscriber>;
}

type EntityFetcher = (
  guid: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
) => Promise<EntityContextDetails | null>;

/** Record ref type → per-type fetcher (guid, subscriber, contextId, env). */
const ENTITY_FETCHERS: Record<string, EntityFetcher> = {
  campaign: fetchCampaignContext,
  segment: fetchSegmentContext,
  'progress-bar': fetchProgressBarContext,
  bundle: fetchBundleContext,
};

/** Canonical hyphenated Guid — the only id format Studio refs / the model pass. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve one record entity to the frozen AiToolEntityContext shape
 * (`Found: false` when unresolved). Throws on unknown type, malformed guid,
 * subscriber-lookup failure, Personalizer 401/403, or network failure.
 */
export async function fetchEntityContext(
  type: string,
  id: unknown,
  contextId: string,
  env: Env,
  shared: SharedEntityLookup = {},
): Promise<AiToolEntityContext> {
  const fetcher = ENTITY_FETCHERS[type];
  if (!fetcher) {
    throw new Error(`Unknown entity-context type: ${type}`);
  }

  const guid = String(id ?? '')
    .trim()
    .toLowerCase();
  if (!GUID_RE.test(guid)) {
    throw new Error(`Invalid entity guid: ${String(id)}`);
  }

  shared.subscriberPromise ??= loadSubscriber(contextId, env);
  const subscriber = await shared.subscriberPromise;
  const context = await fetcher(guid, subscriber, contextId, env);

  if (context) {
    return prune({ Type: type, Id: guid, Found: true, ...context }) as AiToolEntityContext;
  }
  return { Type: type, Id: guid, Found: false };
}

/**
 * The merchant's own Subscriber record (`GET v2/accounts/subscriber`). Its Guid
 * is the tenant guard every loaded entity is re-checked against; CurrencyCode
 * feeds the progress-bar context. Any failure here throws — resolving without
 * the guard is never allowed.
 */
async function loadSubscriber(contextId: string, env: Env): Promise<BrainSubscriber> {
  const { status, data } = await brainGet('v2/accounts/subscriber', contextId, env);
  const subscriber = data as BrainSubscriber | null;
  if (!subscriber || !subscriber.Guid) {
    throw new Error(`Brain subscriber lookup failed: ${status}`);
  }
  return subscriber;
}

/** campaign = discount / html / image kind, probed in that order. */
async function fetchCampaignContext(
  guid: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<EntityContextDetails | null> {
  const discount = await loadDiscountCampaign(guid, subscriber, contextId, env);
  if (discount) {
    return buildDiscountContext(discount, 'Discount', subscriber, contextId, env);
  }

  const html = await loadRecord<BrainContentCampaign>(
    `v2/html-campaigns/html-campaign/${guid}`,
    subscriber,
    contextId,
    env,
  );
  if (html) {
    return {
      Title: html.Title,
      Status: html.Status,
      Kind: 'html',
      Summary: `HTML content campaign "${html.Title}" (${html.Status}).`,
      Fields: { CreateDate: html.CreateDate },
      Related: [],
    };
  }

  const image = await loadRecord<BrainContentCampaign>(
    `v1/imageCampaigns?guid=${guid}`,
    subscriber,
    contextId,
    env,
  );
  if (image) {
    return {
      Title: image.Title,
      Status: image.Status,
      Kind: 'image',
      Summary: `Image content campaign "${image.Title}" (${image.Status}).`,
      Fields: { CreateDate: image.CreateDate },
      Related: [],
    };
  }

  return null;
}

async function fetchSegmentContext(
  guid: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<EntityContextDetails | null> {
  const segment = await loadRecord<BrainSegment>(
    `v1/subscriberSegment?guid=${guid}`,
    subscriber,
    contextId,
    env,
  );
  if (!segment || segment.Deleted) {
    return null;
  }

  return {
    Title: segment.Title,
    Status: segment.Status,
    Kind: null,
    Summary: `Audience segment "${segment.Title}" (${segment.Status ?? 'unknown status'}).`,
    Fields: {
      TemplateGuid: segment.TemplateGuid,
      Description: segment.Description,
      CreationDate: segment.CreationDate,
    },
    Related: [],
  };
}

async function fetchProgressBarContext(
  guid: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<EntityContextDetails | null> {
  const campaign = await loadRecord<BrainProgressBarCampaign>(
    `v2/progress-bar-campaigns/${guid}`,
    subscriber,
    contextId,
    env,
  );
  if (!campaign) {
    return null;
  }

  const tiers = (Array.isArray(campaign.Tiers) ? campaign.Tiers : [])
    .filter((tier): tier is BrainProgressBarTier => !!tier && typeof tier === 'object')
    .map((tier) => ({
      MinimumAmount: tier.MinimumAmount,
      OfferType: tier.OfferType,
      DiscountPercentage: tier.DiscountPercentage,
      DiscountAmount: tier.DiscountAmount,
      OfferMessage: tier.OfferMessage,
    }));

  return {
    Title: campaign.Title,
    Status: campaign.Status,
    Kind: 'progressbar',
    Summary: `Smart progress bar "${campaign.Title}" (${campaign.Status}) with ${tiers.length} tier(s).`,
    Fields: {
      Tiers: tiers,
      FinalMessage: campaign.FinalMessage,
      Currency: subscriber.CurrencyCode,
      CreateDate: campaign.CreateDate,
    },
    Related: [],
  };
}

/** Bundles ARE discount campaigns — same record, bundle-flavored Summary. */
async function fetchBundleContext(
  guid: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<EntityContextDetails | null> {
  const bundle = await loadDiscountCampaign(guid, subscriber, contextId, env);
  if (!bundle) {
    return null;
  }
  return buildDiscountContext(bundle, 'Bundle discount', subscriber, contextId, env);
}

/** Discount-campaign load + tenant re-check (its Personalizer cache is guid-keyed). */
function loadDiscountCampaign(
  guid: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<BrainDiscountCampaign | null> {
  return loadRecord<BrainDiscountCampaign>(
    `v2/discount-campaigns/discount-campaign/${guid}`,
    subscriber,
    contextId,
    env,
  );
}

/** The shared discount/bundle context (label = "Discount" | "Bundle discount"). */
async function buildDiscountContext(
  campaign: BrainDiscountCampaign,
  label: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<EntityContextDetails> {
  return {
    Title: campaign.Title,
    Status: campaign.Status,
    Kind: 'discount',
    Summary:
      `${label} campaign "${campaign.Title}" (${campaign.Status}), ` +
      `${describeDiscount(campaign)}, ` +
      `running ${describeSchedule(campaign.StartDate, campaign.EndDate)}.`,
    Fields: {
      DiscountTarget: campaign.DiscountTarget,
      DiscountType: campaign.DiscountType,
      DiscountPercentage: campaign.DiscountPercentage,
      DiscountAmount: campaign.DiscountAmount,
      StartDate: campaign.StartDate,
      EndDate: campaign.EndDate,
      MinimumAmount: campaign.Conditions?.BundleCondition?.MinimumAmount,
    },
    Related: await getSegmentRelated(campaign.UserSegmentGuids, subscriber, contextId, env),
  };
}

/**
 * One-hop Related: the campaign's targeted segments, titled via per-guid
 * segment loads (tenant-checked, non-deleted). A failing segment load drops
 * that entry — Related never fails the whole resolution.
 */
async function getSegmentRelated(
  segmentGuids: string[] | undefined,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<RelatedEntity[]> {
  if (!Array.isArray(segmentGuids) || segmentGuids.length === 0) {
    return [];
  }

  const settled = await Promise.allSettled(
    segmentGuids.map((guid) =>
      loadRecord<BrainSegment>(`v1/subscriberSegment?guid=${guid}`, subscriber, contextId, env),
    ),
  );

  const related: RelatedEntity[] = [];
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const segment = result.value;
    if (segment.Guid && !segment.Deleted) {
      const entry: RelatedEntity = { Type: 'segment', Id: segment.Guid };
      if (segment.Title !== undefined) entry.Title = segment.Title;
      related.push(entry);
    }
  }
  return related;
}

/**
 * Load one record and re-check it belongs to the merchant. A miss (no body,
 * 404/5xx, cross-subscriber hit) is null; 401/403 and network failures throw.
 */
async function loadRecord<T extends BrainTenantRecord>(
  path: string,
  subscriber: BrainSubscriber,
  contextId: string,
  env: Env,
): Promise<T | null> {
  const { data } = await brainGet(path, contextId, env);
  const record = data as T | null;
  if (!record || !sameGuid(record.SubscriberGuid, subscriber.Guid)) {
    return null;
  }
  return record;
}

/**
 * GET one Personalizer admin path, forwarding the merchant's context-ID. Returns
 * `{ status, data }` — `data` is null for 204/empty/unparsable/non-ok bodies.
 * Throws on 401/403 (the context-ID itself was rejected) and network failure.
 */
async function brainGet(
  path: string,
  contextId: string,
  env: Env,
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(`${personalizerApiUrl(env)}/${path}`, {
    method: 'GET',
    headers: {
      'X-Personalizer-Context-ID': contextId,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Brain ${path} failed: ${response.status}`);
  }

  const text = await response.text().catch(() => '');
  if (!response.ok || !text || text === 'null') {
    return { status: response.status, data: null };
  }

  try {
    const data: unknown = JSON.parse(text);
    return { status: response.status, data: data && typeof data === 'object' ? data : null };
  } catch {
    return { status: response.status, data: null };
  }
}

/** Case-insensitive Guid equality (Brain serializes Guids lowercase). */
function sameGuid(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** C# `0.##` number format: max two decimals, trailing zeros trimmed. */
function formatAmount(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** `{percentage}% off` / `{amount} off` / the DiscountType literal. */
function describeDiscount(campaign: BrainDiscountCampaign): string {
  if (campaign.DiscountPercentage != null) {
    return `${formatAmount(campaign.DiscountPercentage)}% off`;
  }
  if (campaign.DiscountAmount != null) {
    return `${formatAmount(campaign.DiscountAmount)} off`;
  }
  return String(campaign.DiscountType);
}

/** `{start} to {end}` / `from {start}` — dates as yyyy-MM-dd. */
function describeSchedule(startDate: string | undefined, endDate: string | undefined): string {
  const start = isoDay(startDate);
  return endDate ? `${start} to ${isoDay(endDate)}` : `from ${start}`;
}

/** The yyyy-MM-dd prefix of a Brain-serialized DateTime string. */
function isoDay(value: string | undefined): string {
  return String(value).slice(0, 10);
}

/**
 * Drop null/undefined members recursively (objects and arrays) — the output
 * omits absent members exactly like Brain's NullValueHandling.Ignore.
 */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(prune);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry != null) {
        out[key] = prune(entry);
      }
    }
    return out;
  }
  return value;
}
