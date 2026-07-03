/**
 * Toolset registry — composes the active toolsets for one request.
 *
 * A TOOLSET is a named module under `src/toolsets/<name>/` that encapsulates
 * every AI tool sharing one backend: its Anthropic tool definitions, its
 * dispatch/executors, its result normalizers, and its degrade conventions.
 * The descriptor contract (name / integrationParties / definitions /
 * resolveCredentials / execute) lives in ./types.ts; the standards in
 * docs/TOOLSETS.md.
 *
 * Handlers consume tools ONLY through
 * `composeToolsets(subscriberParties, authContext)`. Composition is DATA-DRIVEN
 * off the subscriber's available `IntegrationParty` set (from
 * validate-context-id — no mapping/switch): a toolset is offered iff
 *
 *   descriptor.integrationParties.length === 0                    (always-active)
 *   OR descriptor.integrationParties.some(p => subscriberParties.includes(p))
 *
 * The returned composition is the endpoint's whole tool surface —
 *
 *   { names, definitions, execute(name, input, extras) }
 *
 * `definitions` is the model-visible `tools` array (registered order, each
 * toolset's own stable order — deterministic, so the prompt prefix caches).
 * `execute` routes a tool_use by tool name to the owning toolset and returns
 * the degrade-safe `{ ok, name, result, summary }` shape — it never throws,
 * so the agent loop can always feed the outcome back to the model. A tool
 * name outside the composition degrades the same way (`Unknown tool: <name>`).
 *
 * Each active party-gated toolset carries its MATCHED party — the single
 * intersection of its `integrationParties` with the subscriber's set (exactly
 * one by the ≤1-commerce-party invariant; each non-commerce party owns its own
 * toolset). The registry threads it to `execute` as `matchedParty`; the
 * platform toolsets build the integration-bridge URL segment from it.
 *
 * Credentials (the per-toolset seam): each toolset resolves its own backend
 * credentials from the request's auth context (`{ contextId, env }`) via its
 * `resolveCredentials`. The registry resolves them lazily on first use and
 * memoizes them for THIS composition only — per-request scope, never cached
 * across requests, never passed to the model, never logged. A failed
 * resolution degrades that tool call; it never aborts the turn.
 *
 * Adding a toolset = one module + one entry in TOOLSETS below (with its
 * `integrationParties`). Handler logic does not change (docs/TOOLSETS.md).
 */

import { personalizerToolset } from './personalizer/index';
import { shopifyToolset } from './shopify/index';
import { bigcommerceToolset } from './bigcommerce/index';
import { klaviyoToolset } from './klaviyo/index';
import { googleAdsToolset } from './google-ads/index';
import type { IntegrationParty } from './integration-party';
import type {
  ToolAuthContext,
  ToolCallExtras,
  ToolsetComposition,
  ToolsetDescriptor,
} from './types';

/** Every registered toolset, in composition order (each toolset's own stable order preserved). */
const TOOLSETS: readonly ToolsetDescriptor[] = [
  personalizerToolset,
  shopifyToolset,
  bigcommerceToolset,
  klaviyoToolset,
  googleAdsToolset,
];

/** One active toolset in a composition + the subscriber party its executor targets. */
interface ActiveToolset {
  descriptor: ToolsetDescriptor;
  /** The single matched party, or null for an always-active (ungated) toolset. */
  matchedParty: IntegrationParty | null;
}

/**
 * Compose the active toolsets for one request from the subscriber's available
 * `IntegrationParty` set. A cross-toolset tool-name collision throws
 * (programmer error, caught at compose time). Party names the subscriber has
 * but no toolset declares are simply ignored.
 */
export function composeToolsets(
  subscriberParties: readonly IntegrationParty[],
  authContext: ToolAuthContext,
): ToolsetComposition {
  const parties = Array.isArray(subscriberParties) ? subscriberParties : [];

  const active: ActiveToolset[] = [];
  for (const descriptor of TOOLSETS) {
    if (descriptor.integrationParties.length === 0) {
      // Always-active toolset (no party gate) — e.g. personalizer.
      active.push({ descriptor, matchedParty: null });
      continue;
    }
    const matched = descriptor.integrationParties.filter((party) => parties.includes(party));
    if (matched.length === 0) continue; // gate closed — toolset not offered this request.
    // Load-bearing invariant: a subscriber has at most ONE commerce party, and
    // each non-commerce party owns its own toolset, so the intersection is
    // exactly one. Assert defensively; never build tiebreak logic.
    const only = matched[0];
    if (matched.length !== 1 || only === undefined) {
      throw new Error(
        `Toolset ${descriptor.name} matched ${matched.length} parties (${matched.join(', ')}); expected exactly one.`,
      );
    }
    active.push({ descriptor, matchedParty: only });
  }

  // Tool-name ownership: a tool name belongs to exactly ONE active toolset.
  const owners = new Map<string, ActiveToolset>();
  for (const entry of active) {
    for (const definition of entry.descriptor.definitions) {
      if (owners.has(definition.name)) {
        throw new Error(`Duplicate tool name across toolsets: ${definition.name}`);
      }
      owners.set(definition.name, entry);
    }
  }

  // Per-toolset credentials — lazy, memoized for this composition only.
  const credentialPromises = new Map<string, Promise<unknown>>();
  const credentialsFor = (descriptor: ToolsetDescriptor): Promise<unknown> => {
    let pending = credentialPromises.get(descriptor.name);
    if (!pending) {
      pending = Promise.resolve().then(() => descriptor.resolveCredentials(authContext));
      credentialPromises.set(descriptor.name, pending);
    }
    return pending;
  };

  return {
    names: active.map((entry) => entry.descriptor.name),

    definitions: active.flatMap((entry) => [...entry.descriptor.definitions]),

    /**
     * Execute one tool_use. `extras` carries per-call context the owning
     * toolset may consume (e.g. the request's surviving `refs` for the
     * personalizer `get_entity_context` analytics dispatch).
     */
    async execute(name: string, input: unknown, extras: ToolCallExtras = {}) {
      const entry = owners.get(name);
      if (!entry) {
        return {
          ok: false as const,
          name,
          result: { error: `Unknown tool: ${name}` },
          summary: `Unknown tool: ${name}`,
        };
      }

      let credentials: unknown;
      try {
        credentials = await credentialsFor(entry.descriptor);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          name,
          result: { error: `Toolset ${entry.descriptor.name} credentials unavailable: ${reason}` },
          summary: `${name} error`,
        };
      }

      return entry.descriptor.execute(name, input, {
        credentials,
        env: authContext.env,
        ...(entry.matchedParty ? { matchedParty: entry.matchedParty } : {}),
        ...extras,
      });
    },
  };
}
