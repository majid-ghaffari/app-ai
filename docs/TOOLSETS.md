# Toolsets — app-ai's AI-tool layer

**Parent:** [../CLAUDE.md](../CLAUDE.md) · Code: [`src/toolsets/`](../src/toolsets/)

The worker's AI tools are organized into named, encapsulated **TOOLSETS**
composed per request by a **registry**. This document is the standing
contract: what a toolset is, how endpoints consume one, how to add one, and
the credential-resolution security standards every toolset must meet.

## What a toolset is

A toolset is one module directory, `src/toolsets/<name>/`, encapsulating every
AI tool that shares one backend:

- **Tool definitions** — the Anthropic custom-tool schemas (`name`,
  `description`, `input_schema`) sent in the `tools` array. Deterministic:
  stable order, no per-request data, so the prompt prefix caches.
- **Dispatch/executors** — how each `tool_use` is executed against the
  backend.
- **Normalizers** — the backend-response → model-visible-shape mapping (e.g.
  the personalizer toolset's `entity-context.ts` composing the frozen
  `AiToolEntityContext` shape).
- **Degrade conventions** — every execution returns
  `{ ok, name, result, summary }` and NEVER throws: `result` is the JSON the
  model sees as `tool_result` content (`{ error: ... }` with `ok: false` on
  failure, fed back as `is_error` so the model can apologize/proceed);
  `summary` is the short human string for the SSE `tool_result` event. A
  backend failure degrades the tool call; it never aborts the agent turn.

Each toolset exports exactly one thing — its **descriptor** (typed as
`ToolsetDescriptor` in [`src/toolsets/types.ts`](../src/toolsets/types.ts),
alongside the composition and execution-result types):

| Member               | Contract                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | The registry key and the literal endpoints put in their allowlists (e.g. `'personalizer'`).                                                                      |
| `definitions`        | The Anthropic tool schemas, stable order. Model-visible contract — tool names and input schemas are frozen (lib repo `admin/ai/CONTRACTS.md` §2).                |
| `resolveCredentials` | `(authContext) → credentials` (may be async) — the per-request credential seam (below).                                                                          |
| `execute`            | `(name, input, { credentials, env, ...extras }) → Promise<{ ok, name, result, summary }>` — dispatch one owned tool. `extras` carries per-call context (`refs`). |

## The registry (`src/toolsets/registry.ts`)

`composeToolsets(allowlist, { contextId, env })` composes the active toolsets
for ONE request and returns the endpoint's whole tool surface:

```
{ names, definitions, execute(name, input, extras) }
```

- `definitions` — the concatenated model-visible `tools` array, in allowlist
  order (each toolset's own stable order preserved).
- `execute` — routes a `tool_use` by tool name to the owning toolset. A tool
  name outside the composition degrades to the frozen
  `{ ok: false, result: { error: 'Unknown tool: <name>' } }` shape with no
  backend call. A tool name is owned by exactly one active toolset —
  composition throws on a cross-toolset name collision, and on an
  unregistered allowlist name (both programmer errors, caught at compose
  time).

**Handlers consume tools ONLY through the registry.** Each endpoint declares
an explicit toolset allowlist (e.g. `CHAT_TOOLSETS = ['personalizer']` in
`handlers/chat.ts`) and treats the composition as opaque: the agent loop sends
`composition.definitions` and calls `composition.execute(...)`. Adding a
toolset therefore never touches handler logic — it is a new module, a registry
entry, and an allowlist name.

## The credential seam + security standards

Each toolset resolves its own backend credentials through its
`resolveCredentials(authContext)`, where `authContext` is
`{ contextId, env }` — the request's forwarded, router-validated
`X-Personalizer-Context-ID` plus the worker env. The registry resolves
credentials lazily (on the toolset's first tool execution) and memoizes them
for that composition only; a failed resolution degrades that tool call to the
`{ ok: false }` shape.

These standards are the standing contract for every toolset, present and
future:

1. **Per-request resolution.** Credentials are resolved from the request's
   auth context, live for one composition, and are never cached across
   requests.
2. **Subscriber-scoped.** Whatever a toolset resolves is scoped to the
   requesting merchant/subscriber — never a shared or global credential.
3. **Never model-visible.** Credentials never enter the model's context: not
   in tool definitions, not in system/user blocks, not in `tool_result`
   content.
4. **Never logged.** No `console.*` line (the worker's observability channel)
   carries a credential.
5. **Explicit endpoint allowlists.** An endpoint exposes only the toolsets it
   names; there is no implicit "all registered toolsets" composition.

## Registered toolsets

### `personalizer` (`src/toolsets/personalizer/`)

Every tool whose backend is Brain (the Personalizer API). Credentials =
`{ contextId }`, the forwarded context-ID used solely as the Brain auth
header (Brain re-validates it on every proxied call — see the auth notes in
the root CLAUDE.md).

| Tool                  | Backend call                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `get_store_analytics` | `GET v2/ai-tools/store-analytics`                                                                                               |
| `list_segments`       | `GET v2/ai-tools/segments`                                                                                                      |
| `list_campaigns`      | `GET v2/ai-tools/campaigns`                                                                                                     |
| `get_store_config`    | `GET v2/ai-tools/store-config`                                                                                                  |
| `get_entity_context`  | Record types → Brain per-record admin endpoints via `entity-context.ts`; analytics types → the request's `refs`, no Brain call. |

Brain is the source of truth for all of these shapes — mirror the sibling
`brain` repo's C# exactly (root CLAUDE.md → Hard rules). The toolset's
`entity-context.ts` normalizer is also consumed by `lib/references.ts` for the
eager Referenced-Entities block (same resolution, same frozen output shape).

## Adding a toolset

1. Create `src/toolsets/<name>/index.ts` exporting the descriptor
   (`name`, `definitions`, `resolveCredentials`, `execute`). Put
   backend-specific normalizers in sibling files inside the same directory.
2. Register it in the `TOOLSETS` map in `src/toolsets/registry.ts`.
3. Add its name to the allowlist of each endpoint that should expose it
   (e.g. `CHAT_TOOLSETS` in `handlers/chat.ts`). No other handler change.
4. Tests: composition + dispatch + degrade cases in `test/toolsets.test.ts`
   (the tool-contract snapshot there must be regenerated deliberately —
   schema changes are contract changes), plus the toolset's own executor
   tests.
5. Docs: update `src/toolsets/CLAUDE.md`, this file's Registered-toolsets
   section, and propagate to the root CLAUDE.md + README per the
   documentation rule.

## Roadmap seam — platform toolsets (future, not designed here)

Planned toolsets — `shopify-core`, `bigcommerce-core`, `google`, `klaviyo` —
make DIRECT platform API calls with per-subscriber platform access tokens
persisted in Brain's `SubscriberIntegrationConfig`. They plug into the same
seams this document defines: one module directory each, registered in the
registry, exposed by endpoint allowlists, tokens resolved per request through
`resolveCredentials` under the five security standards above.

The secure token-sharing mechanism between Brain and the worker (how a
`SubscriberIntegrationConfig` token safely reaches `resolveCredentials`) is an
open design discussion — deliberately NOT designed or implemented here. The
seam is the contract; the mechanism behind it is future work.
