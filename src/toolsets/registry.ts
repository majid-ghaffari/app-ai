/**
 * Toolset registry — composes the active toolsets for one request.
 *
 * A TOOLSET is a named module under `src/toolsets/<name>/` that encapsulates
 * every AI tool sharing one backend: its Anthropic tool definitions, its
 * dispatch/executors, its result normalizers, and its degrade conventions.
 * The descriptor contract (name / definitions / resolveCredentials / execute)
 * lives in ./types.ts; the standards in docs/TOOLSETS.md.
 *
 * Handlers consume tools ONLY through `composeToolsets(allowlist, authContext)`:
 * each endpoint declares an explicit allowlist of toolset names, and the
 * returned composition is the endpoint's whole tool surface —
 *
 *   { names, definitions, execute(name, input, extras) }
 *
 * `definitions` is the model-visible `tools` array (allowlist order, each
 * toolset's own stable order — deterministic, so the prompt prefix caches).
 * `execute` routes a tool_use by tool name to the owning toolset and returns
 * the degrade-safe `{ ok, name, result, summary }` shape — it never throws,
 * so the agent loop can always feed the outcome back to the model. A tool
 * name outside the composition degrades the same way (`Unknown tool: <name>`).
 *
 * Credentials (the per-toolset seam): each toolset resolves its own backend
 * credentials from the request's auth context (`{ contextId, env }`) via its
 * `resolveCredentials`. The registry resolves them lazily on first use and
 * memoizes them for THIS composition only — per-request scope, never cached
 * across requests, never passed to the model, never logged. A failed
 * resolution degrades that tool call; it never aborts the turn.
 *
 * Adding a toolset = one module + one entry in TOOLSETS below + the endpoint
 * allowlist that wants it. Handler logic does not change (docs/TOOLSETS.md).
 */

import { personalizerToolset } from './personalizer/index';
import type {
  ToolAuthContext,
  ToolCallExtras,
  ToolsetComposition,
  ToolsetDescriptor,
} from './types';

/** Every registered toolset, keyed by name. */
const TOOLSETS = new Map<string, ToolsetDescriptor>(
  [personalizerToolset].map((toolset) => [toolset.name, toolset]),
);

/**
 * Compose the active toolsets for one request. An unregistered allowlist name
 * throws (programmer error, caught at compose time), as does a cross-toolset
 * tool-name collision.
 */
export function composeToolsets(
  allowlist: readonly string[],
  authContext: ToolAuthContext,
): ToolsetComposition {
  const active = (allowlist || []).map((name) => {
    const toolset = TOOLSETS.get(name);
    if (!toolset) {
      throw new Error(`Unknown toolset: ${name}`);
    }
    return toolset;
  });

  // Tool-name ownership: a tool name belongs to exactly ONE active toolset.
  const owners = new Map<string, ToolsetDescriptor>();
  for (const toolset of active) {
    for (const definition of toolset.definitions) {
      if (owners.has(definition.name)) {
        throw new Error(`Duplicate tool name across toolsets: ${definition.name}`);
      }
      owners.set(definition.name, toolset);
    }
  }

  // Per-toolset credentials — lazy, memoized for this composition only.
  const credentialPromises = new Map<string, Promise<unknown>>();
  const credentialsFor = (toolset: ToolsetDescriptor): Promise<unknown> => {
    let pending = credentialPromises.get(toolset.name);
    if (!pending) {
      pending = Promise.resolve().then(() => toolset.resolveCredentials(authContext));
      credentialPromises.set(toolset.name, pending);
    }
    return pending;
  };

  return {
    names: active.map((toolset) => toolset.name),

    definitions: active.flatMap((toolset) => [...toolset.definitions]),

    /**
     * Execute one tool_use. `extras` carries per-call context the owning
     * toolset may consume (e.g. the request's surviving `refs` for the
     * personalizer `get_entity_context` analytics dispatch).
     */
    async execute(name: string, input: unknown, extras: ToolCallExtras = {}) {
      const toolset = owners.get(name);
      if (!toolset) {
        return {
          ok: false as const,
          name,
          result: { error: `Unknown tool: ${name}` },
          summary: `Unknown tool: ${name}`,
        };
      }

      let credentials: unknown;
      try {
        credentials = await credentialsFor(toolset);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          name,
          result: { error: `Toolset ${toolset.name} credentials unavailable: ${reason}` },
          summary: `${name} error`,
        };
      }

      return toolset.execute(name, input, { credentials, env: authContext.env, ...extras });
    },
  };
}
