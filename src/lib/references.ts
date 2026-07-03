/**
 * Chat referencing — `context.refs` intake + the Referenced-Entities system block.
 *
 * A ref (`EntityReference`, camelCase wire shape) anchors a /chat conversation
 * to an entity or topic. Six types: the four RECORD types (`campaign`,
 * `segment`, `progress-bar`, `bundle` — each carries a DB Guid `id`) resolve
 * via `fetchEntityContext` (the personalizer toolset's entity-context
 * resolver, toolsets/personalizer/entity-context.ts — Personalizer's per-record
 * admin endpoints, normalized worker-side to the frozen AiToolEntityContext
 * shape);
 * the two ANALYTICS types (`analytics-metric`, `analytics-tab` — composite, no
 * Guid) resolve from the ref's own `metadata` with NO Personalizer call.
 *
 * When ≥1 valid ref survives intake, `buildReferencedEntitiesBlock` eagerly
 * prefetches every ref concurrently (`Promise.allSettled`) and renders the
 * frozen "## Referenced Entities" block — appended by the chat handler as a
 * separate, final, UNCACHED system block. A failed resolve degrades that ref's
 * line to `(could not load)`; the block never throws and never blocks the reply.
 *
 * Frozen cross-repo contract: lib repo
 * `packages/storefront/src/admin/ai/CONTRACTS.md` (§1 `context.refs`, §2
 * `get_entity_context` + the entity-context output shape, §8 block format).
 */

import {
  fetchEntityContext,
  type SharedEntityLookup,
} from '../toolsets/personalizer/entity-context';
import type { Env } from '../config';

/** Max refs accepted per /chat call — extras are silently dropped (first 5 kept). */
export const MAX_CHAT_REFS = 5;

/** Record ref types — Personalizer-resolved; entries without an `id` string are dropped. */
export const RECORD_REF_TYPES = ['campaign', 'segment', 'progress-bar', 'bundle'] as const;

/** Analytics ref types — resolved from the ref's own `metadata`, no Personalizer call. */
export const ANALYTICS_REF_TYPES = ['analytics-metric', 'analytics-tab'] as const;

export type RecordRefType = (typeof RECORD_REF_TYPES)[number];
export type AnalyticsRefType = (typeof ANALYTICS_REF_TYPES)[number];
export type EntityRefType = RecordRefType | AnalyticsRefType;

/**
 * One entity reference riding `context.refs` (frozen camelCase wire shape,
 * lib CONTRACTS.md §1). Record types carry the entity Guid as `id`; analytics
 * types carry their payload in `metadata`.
 */
export interface EntityReference {
  type: EntityRefType;
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

const VALID_REF_TYPES: ReadonlySet<string> = new Set([...RECORD_REF_TYPES, ...ANALYTICS_REF_TYPES]);

/** Frozen heading of the Referenced-Entities system block. */
const REFERENCED_ENTITIES_HEADING = '## Referenced Entities';

/** Frozen preamble line of the Referenced-Entities system block. */
const REFERENCED_ENTITIES_PREAMBLE =
  'The user opened this conversation with the entities below ALREADY in context. They ARE the topic — do not ask "which one?". Ground every answer in this data.';

function isRecordType(type: string): type is RecordRefType {
  return (RECORD_REF_TYPES as readonly string[]).includes(type);
}

/** Boundary type guard: one raw `context.refs` entry is a valid EntityReference. */
function isEntityReference(value: unknown): value is EntityReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { type?: unknown; id?: unknown };
  if (typeof candidate.type !== 'string' || !VALID_REF_TYPES.has(candidate.type)) return false;
  if (isRecordType(candidate.type)) {
    return typeof candidate.id === 'string' && candidate.id.length > 0;
  }
  return true;
}

/**
 * Intake sanitizer for `body.context.refs`. Accepts only an array; drops
 * non-object entries, entries without a valid `type` literal, and record-type
 * entries without a non-empty `id` string; caps at MAX_CHAT_REFS (first five).
 */
export function sanitizeRefs(raw: unknown): EntityReference[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(isEntityReference).slice(0, MAX_CHAT_REFS);
}

/**
 * The deterministic category path a ref anchors (the subject's persistence key
 * in Personalizer, and the `id` the model passes to `get_entity_context` for
 * analytics refs): record types → `record/{type}`; `analytics-tab` →
 * `analytics/{tab}`; `analytics-metric` → `analytics/{tab}/{metricKey}`.
 */
export function refCategoryPath(ref: EntityReference): string {
  if (isRecordType(ref.type)) return `record/${ref.type}`;
  const meta = ref.metadata && typeof ref.metadata === 'object' ? ref.metadata : {};
  if (ref.type === 'analytics-tab') return `analytics/${meta.tab}`;
  return `analytics/${meta.tab}/${meta.metricKey}`;
}

/**
 * Resolve one ref to its single-line JSON payload string. Record types resolve
 * via `fetchEntityContext` (Personalizer's per-record admin endpoints, forwarding the
 * merchant's context-ID); analytics types stringify the ref's own `metadata` —
 * NO Personalizer call. Throws on any fetch failure (the caller degrades the line via
 * `Promise.allSettled`). Concurrent record resolutions passing the same
 * `shared` scratch object share one subscriber lookup.
 */
export async function resolveRef(
  ref: EntityReference,
  contextId: string,
  env: Env,
  shared: SharedEntityLookup = {},
): Promise<string> {
  if (!isRecordType(ref.type)) {
    return JSON.stringify(ref.metadata ?? {});
  }
  return JSON.stringify(await fetchEntityContext(ref.type, ref.id, contextId, env, shared));
}

/**
 * Build the frozen Referenced-Entities system-block text for the surviving
 * refs. All refs resolve concurrently via `Promise.allSettled`; a rejected
 * resolve degrades that ref's payload to `(could not load)` — this function
 * never throws. Line grammar (frozen):
 * `- [<type>] "<label>" (<anchor>): <payload>` where `<anchor>` is
 * `id <ref.id>` for record types and the category path for analytics types.
 * Returns null when there are no refs.
 */
export async function buildReferencedEntitiesBlock(
  refs: readonly EntityReference[] | undefined,
  contextId: string,
  env: Env,
): Promise<string | null> {
  if (!Array.isArray(refs) || refs.length === 0) return null;

  const shared: SharedEntityLookup = {};
  const settled = await Promise.allSettled(
    refs.map((ref) => resolveRef(ref, contextId, env, shared)),
  );

  const lines = refs.map((ref, i) => {
    const outcome = settled[i];
    const payload = outcome?.status === 'fulfilled' ? outcome.value : '(could not load)';
    const label = ref.label ?? ref.id ?? refCategoryPath(ref);
    const anchor = isRecordType(ref.type) ? `id ${ref.id}` : refCategoryPath(ref);
    return `- [${ref.type}] "${label}" (${anchor}): ${payload}`;
  });

  return `${REFERENCED_ENTITIES_HEADING}\n${REFERENCED_ENTITIES_PREAMBLE}\n\n${lines.join('\n')}`;
}
