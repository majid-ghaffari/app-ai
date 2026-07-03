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

| Member               | Contract                                                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`               | The registry key (e.g. `'personalizer'`).                                                                                                                                                                         |
| `integrationParties` | The `IntegrationParty[]` that gates this toolset (metadata, NOT model-visible). Empty = always-active (no gate, e.g. personalizer); otherwise composed iff the subscriber has one of these parties available.     |
| `definitions`        | The Anthropic tool schemas, stable order. Model-visible contract — tool names and input schemas are frozen (lib repo `admin/ai/CONTRACTS.md` §2).                                                                 |
| `resolveCredentials` | `(authContext) → credentials` (may be async) — the per-request credential seam (below).                                                                                                                           |
| `execute`            | `(name, input, { credentials, env, matchedParty?, ...extras }) → Promise<{ ok, name, result, summary }>` — dispatch one owned tool. `matchedParty` is the gated toolset's matched party; `extras` carries `refs`. |

## The registry (`src/toolsets/registry.ts`)

`composeToolsets(subscriberParties, { contextId, env })` composes the active
toolsets for ONE request and returns the endpoint's whole tool surface:

```
{ names, definitions, execute(name, input, extras) }
```

Composition is DATA-DRIVEN off the subscriber's available `IntegrationParty`
set (`subscriberParties`, from validate-context-id — no mapping/switch): a
toolset is offered iff

```
descriptor.integrationParties.length === 0                          (always-active)
  || descriptor.integrationParties.some(p => subscriberParties.includes(p))
```

Each active party-gated toolset carries its MATCHED party — the single
intersection of its `integrationParties` with `subscriberParties` (exactly one
by the ≤1-commerce-party invariant; each non-commerce party owns its own
toolset). The registry threads it to `execute` as `matchedParty`; the platform
toolsets use it as the integration-bridge URL party segment.

- `definitions` — the concatenated model-visible `tools` array, in registered
  order (each toolset's own stable order preserved).
- `execute` — routes a `tool_use` by tool name to the owning toolset. A tool
  name outside the composition (a gated-off toolset's tool, or a name no
  toolset owns) degrades to the frozen
  `{ ok: false, result: { error: 'Unknown tool: <name>' } }` shape with no
  backend call. A tool name is owned by exactly one active toolset —
  composition throws on a cross-toolset name collision (a programmer error,
  caught at compose time). A party the subscriber has but no toolset declares
  is simply ignored.

**Handlers consume tools ONLY through the registry.** Each endpoint passes the
subscriber's available parties (threaded from the router's validate-context-id
call — `handlers/chat.ts` takes `availableParties`) and treats the composition
as opaque: the agent loop sends `composition.definitions` and calls
`composition.execute(...)`. Adding a toolset therefore never touches handler
logic — it is a new module + a registry entry declaring its
`integrationParties`; every party-driven endpoint picks it up automatically.

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
5. **Party-driven composition.** An endpoint exposes a toolset only when the
   subscriber has one of its `integrationParties` available (always-active
   toolsets — empty parties — join every request); there is no implicit "all
   registered toolsets" composition, and no static endpoint allowlist.

## Registered toolsets

### `personalizer` (`src/toolsets/personalizer/`)

Every tool whose backend is the Personalizer API. Credentials =
`{ contextId }`, the forwarded context-ID used solely as the Personalizer auth
header (Personalizer re-validates it on every proxied call — see the auth notes in
the root CLAUDE.md).

| Tool                  | Backend call                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_store_analytics` | `GET v2/ai-tools/store-analytics`                                                                                                             |
| `list_segments`       | `GET v2/ai-tools/segments`                                                                                                                    |
| `list_campaigns`      | `GET v2/ai-tools/campaigns`                                                                                                                   |
| `get_store_config`    | `GET v2/ai-tools/store-config`                                                                                                                |
| `get_entity_context`  | Record types → Personalizer per-record admin endpoints via `entity-context.ts`; analytics types → the request's `refs`, no Personalizer call. |

Brain is the source of truth for all of these shapes — mirror the sibling
`brain` repo's C# exactly (root CLAUDE.md → Hard rules). The toolset's
`entity-context.ts` normalizer is also consumed by `lib/references.ts` for the
eager Referenced-Entities block (same resolution, same frozen output shape).

### Platform toolsets — `shopify`, `bigcommerce`, `klaviyo`, `google-ads`

One toolset per platform, each a transparent passthrough to the merchant's
platform API through Personalizer's integration bridge (`v2/integration-bridge/*` on
the main API). Each is party-gated (composed only when the subscriber has its
`IntegrationParty` available): `shopify` → `ShopifyPersonalizer`,
`bigcommerce` → `BigCommercePersonalizer`, `klaviyo` → `Klaviyo`,
`google-ads` → `Google`. The proxy URL `{party}` segment is that matched
party name — Personalizer's dispatch key. Personalizer is the credential
custodian — app-ai never holds a platform token. Each toolset's
`resolveCredentials` resolves a **call channel** only, through the shared seam
`resolveBridgeChannel` in `src/toolsets/integration-bridge.ts`:

```ts
{ contextId, serviceToken: personalizerIntegrationBridgeToken(env), baseUrl: personalizerApiUrl(env) }
```

sent as `X-Personalizer-Context-ID` (the tenant) + `X-Personalizer-Integration-Bridge-Token`
(the caller — the `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` Workers Secret behind the
`src/config.ts` accessor, never a `wrangler.toml` var, never logged) on every
proxy call. Personalizer validates both, resolves the subscriber, and relays the call
to the platform under the merchant's own installed-integration credentials.
The five security standards above apply in full.

| Toolset       | Party (gate)              | Tools                                     | Proxy surface                                                                                                   |
| ------------- | ------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `shopify`     | `ShopifyPersonalizer`     | `shopify_rest_request`, `shopify_graphql` | `{verb} …/ShopifyPersonalizer/rest/{path}` (version-less paths) + `POST …/ShopifyPersonalizer/graphql`          |
| `bigcommerce` | `BigCommercePersonalizer` | `bigcommerce_rest_request`                | `{verb} …/BigCommercePersonalizer/rest/{path}` (version-prefixed `v2/…`/`v3/…` paths)                           |
| `klaviyo`     | `Klaviyo`                 | `klaviyo_rest_request`                    | `{verb} …/Klaviyo/rest/{path}` (`api/…` paths; JSON:API paging via `page[cursor]`)                              |
| `google-ads`  | `Google`                  | `google_ads_gaql_query`                   | `POST …/Google/gaql` — read-only (GAQL SELECT); wire `{ Query, PageSize?, PageToken? }`, `NextPageToken` paging |

The proxy is a pure bridge — reads AND writes, mirrored verbs, no path/method
allowlists, GraphQL documents (queries and mutations) forwarded verbatim. The
behavioral boundary is the tool descriptions (write-caution language: writes
only when the merchant explicitly asked, confirm destructive actions first)
plus the merchant token's own OAuth scopes.

**Error discrimination (frozen cross-repo rule).** The shared executor
(`integration-bridge.ts`) checks the `X-Ls-Integration-Bridge-Error` response header:

- **Absent** — the platform speaking, verbatim: `{ ok: true, result:
{ platformStatus, headers?, body } }` at ANY status. Platform 4xx/5xx payloads
  surface raw to the model so it can self-correct (fix a path, adjust a
  GraphQL field, respect a 429) using the platform's own error language — a
  platform error is data, not a degrade. `result.headers` (lowercased keys)
  carries exactly the frozen whitelist of out-of-band platform headers —
  `link` (Shopify REST cursor paging: `page_info` reaches the model here),
  `retry-after`, `x-shopify-shop-api-call-limit` (Shopify),
  `x-rate-limit-requests-left` + `x-rate-limit-time-reset-ms` (BigCommerce),
  `ratelimit-limit` + `ratelimit-remaining` + `ratelimit-reset` (Klaviyo) —
  and is omitted entirely when none are present; every other platform header
  is dropped.
- **Present** — a LimeSpot layer produced the response; the body is the
  standard `{ Message, ExceptionType, MessageDetail }` envelope. The call
  degrades to `{ ok: false, result: { error: '<Message> (<ExceptionType>)' } }`,
  so the model can distinguish a malformed request (`AiProxyRequestException`
  — rephrase the call) from a configuration failure
  (`SubscriberInvalidOrUninstalledException`, `ServiceTokenValidationException`
  — stop retrying, tell the merchant).

Which subscribers see the platform toolsets is decided purely by their
available parties — a toolset's `integrationParties` gate, not any endpoint
allowlist. A subscriber with `Google` available gets `google-ads`; one without
it does not; personalizer (always-active) is composed for everyone.

## Adding a toolset

1. Create `src/toolsets/<name>/index.ts` exporting the descriptor
   (`name`, `integrationParties`, `definitions`, `resolveCredentials`,
   `execute`). Put backend-specific normalizers in sibling files inside the
   same directory.
2. Register it in the `TOOLSETS` array in `src/toolsets/registry.ts`.
3. Declare its `integrationParties` (empty = always-active; otherwise the
   `IntegrationParty` names that gate it). No handler change — every
   party-driven endpoint composes it automatically.
4. Tests: composition + dispatch + degrade cases in `test/toolsets.test.ts`
   (the tool-contract snapshot there must be regenerated deliberately —
   schema changes are contract changes), plus the toolset's own executor
   tests.
5. Docs: update `src/toolsets/CLAUDE.md`, this file's Registered-toolsets
   section, and propagate to the root CLAUDE.md + README per the
   documentation rule.
