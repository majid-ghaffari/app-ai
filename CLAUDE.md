# app-ai — Anthropic Proxy (Cloudflare Worker)

**CLAUDE.md Rule:** Any code change MUST update the CLAUDE.md of the affected folder (`src/handlers/CLAUDE.md`, `src/lib/CLAUDE.md`, `src/toolsets/CLAUDE.md`), then propagate the change up to this root file. If you add/rename a handler, lib module, toolset, prompt, or route, update the relevant section here AND the matching folder doc. Keep the documentation tree always valid.

A Cloudflare Worker that is a secure proxy in front of Anthropic. It holds the Anthropic API key, validates the merchant's `X-Personalizer-Context-ID` against the Personalizer backend, and proxies to Anthropic. Parts of it serve **production** (the live smart-image feature depends on `/files` + `/messages`).

## Project docs

Standalone-project documentation lives at the repo root and under `docs/`:

| Document                                             | Purpose                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [README.md](README.md)                               | Quick start, endpoints, deployment, token-saving levers (with live-measured numbers)             |
| [CONTRIBUTING.md](CONTRIBUTING.md)                   | Commit convention, push-to-main deploy rule, validate-before-push loop                           |
| [docs/CODE-PATTERNS.md](docs/CODE-PATTERNS.md)       | Coding standards — strict TypeScript, clean code, error handling, No Hardcoded Config Values     |
| [docs/TESTING.md](docs/TESTING.md)                   | The five test layers (unit / integration / contract / fitness / live token-savings gate)         |
| [docs/DECISIONS.md](docs/DECISIONS.md)               | Numbered decision log with rationale                                                             |
| [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)         | Honest current limitations                                                                       |
| [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md) | Prompt authoring/iteration workflow (artifact rules, length enforcement, maintenance-doc upkeep) |
| [docs/TOOLSETS.md](docs/TOOLSETS.md)                 | Toolset standards: what a toolset is, the registry, the credential seam + security standards     |
| [docs/prompts/](docs/prompts/)                       | Per-prompt design/maintenance docs (`<name>.md`, e.g. `image-selection.md`)                      |

Adding or renaming a `docs/*` file updates this table (propagation rule below).

## Documentation conventions

Two rules govern every `CLAUDE.md`, `README.md`, and code comment/JSDoc in this repo:

1. **CLAUDE.md propagation.** Any code change MUST update the affected folder's `CLAUDE.md` (`src/handlers/CLAUDE.md`, `src/lib/CLAUDE.md`, `src/toolsets/CLAUDE.md`), then propagate the change up to this root file. Adding/renaming a handler, lib module, toolset, prompt, or route updates the relevant section here AND the matching folder doc. Keep the documentation tree always valid.
2. **Current state only — no historical or chronological framing.** Docs and comments describe what the code IS, never what it was or how it got here. Do not write "previously", "now / no longer", "used to", "refactored from", "moved from X", "renamed", "preserved verbatim from the original", "behavior preserved", before→after comparisons, or any reference to a prior structure. A reader should learn only the current behavior. (Forward-looking operational status — KV provisioning steps, "needs live validation" notes — is current-state information and is allowed, phrased as present-tense state rather than a change log.)

## Definition of Done (ENFORCED)

Work in this repo is DONE only when **all** of the following hold — anything
less is not done, and must not be reported as done:

1. **Scope = all of it.** 100% of the agreed scope ships. No deferrals, no
   "later phase", no "good enough", no silently narrowed scope. If a piece
   genuinely cannot land (e.g. it requires a Brain-side change), that is
   surfaced explicitly as a blocker with a written handoff — never quietly
   dropped.
2. **Full test coverage on all of it.** Every new behavior is covered at every
   applicable layer: unit/integration → contract (frozen shapes/snapshots) →
   architecture fitness scans — and, before a release, the live token-savings
   gate (docs/TESTING.md).
3. **All tests passing.** The FULL suite — not just the new tests. A red test
   anywhere means not done.
4. **No preexisting bugs accepted.** A bug surfaced along the way gets fixed —
   "it was already broken" is not an exemption. If the fix is genuinely
   out-of-repo (Brain, lib), it gets a root-cause writeup, and the failing
   test stays honest (never weakened, never skipped to green — see
   docs/CODE-PATTERNS.md → No Silent Skips).
5. **All gates green, with zero errors:** `npx vitest run`, `npm run lint`,
   `npm run format-check`, `npm run typecheck`, `npx wrangler deploy
--dry-run` — and the documentation tree updated with the change (this
   file's propagation rule).

Verification is independent: gate results are re-run and confirmed, not taken
from a summary. Reporting "done" with any of the above unmet is the failure
mode this section exists to prevent.

## Key Principles

See [docs/CODE-PATTERNS.md](docs/CODE-PATTERNS.md) for the detailed standards. Summary:

- **DRY** — shared logic lives in `lib/`; one implementation per concern.
- **Single Responsibility** — one module = one concern; the router routes, handlers handle, `lib/anthropic.ts` is the only Anthropic caller, `src/config.ts` is the only binding reader.
- **No Dead Code** — unused exports, commented-out blocks, and "just in case" shims are deleted, not kept.
- **No Hardcoded Config Values** — URLs + deploy-time tunables in config, read through `src/config.ts`; missing config throws; no inline fallbacks (Tech / Constraints above).
- **One Error Shape** — every error is the Brain wire envelope via `lib/responses.ts` (Hard rules below).
- **Brain Is the Single Source of Truth** — anything crossing the Personalizer API boundary mirrors Brain's C# exactly; verify in the sibling `brain` repo, never the legacy `app` TS (Hard rules below).
- **Credentials stay server-side** — the context-ID and API key are never model-visible and never logged (docs/TOOLSETS.md; fitness-tested).
- **No Silent Skips** — tests never skip on a missing precondition; they throw with an actionable error.
- **Current-state docs** — the documentation tree describes what IS (Documentation conventions above) and updates in the same commit as the code.

## Tech / Constraints

- **Strict TypeScript (ES modules).** `tsconfig.json` declares the full strict family plus the beyond-strict correctness flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, …). No `any`, no `@ts-ignore`/`@ts-expect-error` — `unknown` + narrowing instead (docs/CODE-PATTERNS.md → Strict TypeScript). `npm run typecheck` (`tsc --noEmit`) is a required gate; there is no separate build step — wrangler/esbuild transpiles the TS natively at deploy time, vitest/vite at test time.
- Cloudflare Workers runtime (V8 isolates, Web-standard `fetch`/`Request`/`Response`/`FormData`) — **no Node.js, no runtime filesystem.**
- No production npm dependencies (nothing is bundled into the deployed worker). Dev-only: `wrangler`, `vitest`, `typescript`, `typescript-eslint`, `eslint`, `prettier`, and — for the free local Claude-Code testing channel (`scripts/dev-claude-shim.mjs`) — `@anthropic-ai/claude-agent-sdk` + `zod`. The shim is standalone Node tooling run by `npm run dev:shim`; it is never imported by `src/` and never ships to production.
- **No Hardcoded Config Values (ENFORCED).** Every URL and deploy-time tunable (Personalizer/Anthropic origins, credentialed CORS origins, model choices) lives in configuration — wrangler.toml `[vars]` (production) / `.dev.vars` + committed `.dev.vars.example` (local) — and is read ONLY through the typed accessors in `src/config.ts` (the single typed `Env` interface). **Missing config = a thrown error naming the variable and where to set it. No fallback defaults anywhere** — `env.X || …` / `env.X ?? …` is banned. True contract constants (wire field names, tool names, routes, prompt text, Anthropic's 4-breakpoint limit, the contract-frozen `MAX_ITERATIONS` / `MAX_CHAT_REFS`) stay in code. Full rule: docs/CODE-PATTERNS.md → "No Hardcoded Config Values"; enforced by the fitness scans in `test/architecture.test.ts` and the production-value pins in `test/config.test.ts`.
- **The Anthropic API key never leaves the worker.** Only `src/lib/anthropic.ts` reads it, via `claudeApiKey(env)` from `src/config.ts`.
- **The Personalizer integration-bridge token (`PERSONALIZER_INTEGRATION_BRIDGE_TOKEN`, Workers Secret) never leaves the worker.** Only the platform toolsets' call-channel seam (`src/toolsets/integration-bridge.ts`) reads it, via `personalizerIntegrationBridgeToken(env)` from `src/config.ts`; it is sent solely as the `X-Personalizer-Integration-Bridge-Token` header toward Personalizer's integration bridge — never a `wrangler.toml` var, never logged, never model-visible.
- Deploy is automatic from `main` via Cloudflare's GitHub integration — **pushing `main` deploys to production.** Commit locally; do not push casually.

## Architecture

Entry/router → handlers → shared lib + toolsets. The router is thin; all logic lives in `handlers/`, `lib/`, and `toolsets/`.

```
src/
├── index.ts              # Entry + router only: CORS, OPTIONS, context-ID auth, dispatch
├── config.ts             # Typed `Env` + fail-fast config accessors — the ONE place bindings are read
├── types/markdown.d.ts   # Ambient module type: `.md` imports resolve to their raw text
├── handlers/             # Route handlers (see handlers/CLAUDE.md)
│   ├── health.ts         # GET  /health (no auth)
│   ├── files.ts          # POST/GET /files, DELETE /files/{id}
│   ├── messages.ts       # POST /messages — single-shot proxy (LIVE smart-image)
│   └── chat.ts           # POST /chat — Studio AI agent loop + SSE
├── lib/                  # Shared modules (see lib/CLAUDE.md)
│   ├── anthropic.ts      # THE Anthropic client: files + messages + streaming + countTokens (headers/beta in one place)
│   ├── auth.ts           # validateContextId() against Personalizer
│   ├── cors.ts           # getCorsHeaders()
│   ├── responses.ts      # jsonResponse() / errorResponse() / errorPayload() / WorkerError — the ONE Brain-shaped error format
│   ├── cache-control.ts  # manageCacheControl() — the 4-block prompt-cache limit; EXTENDED_CACHE_CONTROL (1h TTL) const
│   ├── agent-cache.ts    # applyConversationBreakpoints() — cache breakpoints on /chat conversation turns (≤3, ~15-block intervals)
│   ├── file-dedup.ts     # dedupUpload() / sha256Hex() — Files API contentHash→file_id dedup (KV-backed LIVE, stale-id verify, 30d TTL, graceful no-op)
│   ├── references.ts     # /chat context.refs intake + the Referenced-Entities system block (record refs → the personalizer toolset's entity-context.ts; analytics refs → own metadata)
│   └── logger.ts         # createLogger(scope) — scoped console.* (read via `wrangler tail`)
├── toolsets/             # The AI-tool layer: named toolsets + registry (see toolsets/CLAUDE.md + docs/TOOLSETS.md)
│   ├── registry.ts       # composeToolsets(subscriberParties, { contextId, env }) — party-driven per-request composition, matched-party threading, tool-name routing, per-toolset credential seam
│   ├── integration-party.ts # IntegrationParty — verbatim mirror of Personalizer's C# enum (wire NAMES); the single identity gating composition + keying the bridge URL segment
│   ├── types.ts          # The toolset seam types: ToolsetDescriptor (name / integrationParties / definitions / …) / ToolsetComposition / ToolExecution
│   ├── integration-bridge.ts # Shared platform-toolset plumbing: call-channel seam (context-ID + PERSONALIZER_INTEGRATION_BRIDGE_TOKEN → Personalizer's v2/integration-bridge/{party}) + REST/GraphQL/GAQL executors (GAQL: PageSize?/PageToken?) + the X-Ls-Integration-Bridge-Error discrimination
│   ├── personalizer/     # Every tool whose backend is the Personalizer API
│   │   ├── index.ts      # Toolset descriptor: frozen tool definitions + /v2/ai-tools/* dispatch + get_entity_context dispatch + degrade shape
│   │   └── entity-context.ts # fetchEntityContext() — record-ref resolution: per-refType fetchers over Personalizer's per-record admin endpoints → the frozen AiToolEntityContext shape
│   ├── shopify/          # Shopify platform toolset: shopify_rest_request (version-less Admin REST) + shopify_graphql (verbatim documents, mutations included)
│   ├── bigcommerce/      # BigCommerce platform toolset: bigcommerce_rest_request (version-prefixed v2/…/v3/… paths)
│   ├── klaviyo/          # Klaviyo platform toolset: klaviyo_rest_request (api/… paths, JSON:API paging via query params)
│   └── google-ads/       # Google Ads platform toolset: google_ads_gaql_query (GAQL SELECT via the google/gaql proxy surface — read-only by nature)
├── prompts.ts            # System-prompt REGISTRY: name → { prompt, model, maxTokens, usesTools, description, attachments }
├── prompts/*.md          # SIMPLE prompt TEXT (one .md per prompt; pure text, bundled at build time)
└── prompts/<name>/       # MULTI-FILE prompt (folder): prompt.md (system) + sample.md (attachment); maintenance doc in docs/prompts/<name>.md
```

### Routes

| Method | Path          | Handler            | Auth |
| ------ | ------------- | ------------------ | ---- |
| GET    | `/health`     | `handleHealth`     | No   |
| POST   | `/files`      | `handleFileUpload` | Yes  |
| GET    | `/files`      | `handleListFiles`  | Yes  |
| DELETE | `/files/{id}` | `handleDeleteFile` | Yes  |
| POST   | `/messages`   | `handleMessages`   | Yes  |
| POST   | `/chat`       | `handleChat`       | Yes  |

Auth = the router calls `validateContextId(X-Personalizer-Context-ID, env)` for every non-`/health` route before dispatch; a missing header is a 401 `MissingContextIDException`, a Personalizer rejection relays Personalizer's status + body unchanged, and an unreachable Personalizer is a 500 `BrainUnreachableException` (all in the Brain wire error shape — see Hard rules). Every authed route consumes the Anthropic API (paid tokens / Files storage), which is what the upfront gate protects. The server→server Personalizer fetches made INSIDE a gated request (`toolsets/personalizer/`, `lib/references.ts`) carry no second validation call — they forward the merchant's context-ID and Personalizer re-validates it on each proxied call; a Personalizer rejection there degrades to the tool/ref error shape, never an unhandled throw.

### The Anthropic client (`lib/anthropic.ts`)

The single place that talks to `api.anthropic.com`. It owns the base URLs, `anthropic-version`, the `x-api-key` injection, and the beta flags:

- Files API calls send `anthropic-beta: files-api-2025-04-14`.
- Messages API calls send `anthropic-beta: prompt-caching-2024-07-31,files-api-2025-04-14`.

Exports: `uploadFile`, `listFiles`, `deleteFile`, `createMessage` (non-streaming), `streamMessage` (forces `stream: true`, returns the raw `Response` for the caller to read SSE), `countTokens` (POST `/messages/count_tokens` — free pre-flight estimate; forwards only count-accepted fields: model/system/messages/tools). No handler re-implements fetch/header logic.

### Token-saving levers (prompt caching, dedup, count_tokens, effort)

Cost-reduction is additive and never changes external request/response shapes.

**What caches, measured live (Opus 4.8 / Haiku 4.5):**

- **`/chat` + onboarding (Opus 4.8) cache.** The cached prefix is `tools` (TOOL_DEFINITIONS, ~6.4KB JSON) + the `buildSystem` base prompt block, ~1351 input tokens. A repeat call reads the full ~1351 from cache (`cache_read_input_tokens: 1351`, `input_tokens: 89`). The effective Opus-4.8 cacheable prefix is therefore ≤1351 tokens — the TOOL_DEFINITIONS block is what clears the floor (a tool-less prompt this small would not cache). The agent-loop conversation breakpoints (below) extend this to the growing turns.
- **Placement file blocks (Haiku 4.5) cache — the big win.** The placement flow uploads a screenshot + cleaned HTML via `POST /files`, referenced as `fileIds` in `POST /chat`. Those file blocks (thousands of tokens — they dwarf the ~370-token placement system prompt) carry a 1h breakpoint on the LAST block, so a repeat placement call on the same page reads them at 0.1× (`cache_read_input_tokens` > 0 on call 2). Same-page reuse maps to the same `file_id` via the `/files` content-hash dedup, so the bytes hit the same cache entry.
- **Placement _system_ prompt (~370 tokens) does NOT cache and is left uncached — by design.** It is well under Haiku 4.5's minimum cacheable prefix; a `cache_control` marker on it would be a silent no-op, and padding it to clear the floor would cost more than it saves. The placement win is the file blocks, not the system prompt. (`buildSystem` still attaches the 1h marker to the base block because chat/onboarding share that path and DO clear the floor via tools; on placement the marker is harmless — the API ignores an unmet prefix — but it is genuinely inert there.)

**The levers:**

- **Extended 1h prompt cache (`EXTENDED_CACHE_CONTROL` in `cache-control.ts`).** The STABLE prefix uses `{ type: 'ephemeral', ttl: '1h' }` (GA — no beta header): `messages.ts` system block + reused file-attachment blocks; `chat.ts` `buildSystem` base prompt block (the volatile context block AND the Referenced-Entities block stay uncached — the system array is `[ registry (1h) , context? , referenced-entities? ]`, per-call blocks last so the cached prefix stays byte-stable); the placement file-prefix block (last `fileIds` block); and the user blocks `manageCacheControl` KEEPS. Conversation turns use the 5-min default (short-lived).
- **Agent-loop breakpoints (`agent-cache.ts`).** `runAgentLoop` calls `applyConversationBreakpoints(conversation, { maxBreakpoints, reservedHeadBlocks })` each iteration: strips stale breakpoints (except the reserved file-prefix head blocks), then re-applies last-block + intermediates every ~15 blocks so the 20-block lookback never misses. Budget ≤4 total: 1 system + (1 file-prefix when `fileIds` present, so `maxBreakpoints` drops to 2) + conversation; otherwise system + 3 conversation.
- **Files API checksum dedup (`file-dedup.ts`) — LIVE.** `dedupUpload({content,mimeType,filename}, env)` SHA-256s the bytes; on `env.FILES_KV` hit it VERIFIES the cached `file_id` still exists (Files API metadata, `getFileMetadata`) before reuse — a 404 drops the stale record and re-uploads, so a dead id is never vended. Misses upload and store `hash → { fileId, createdAt }` with a 30-day TTL (`KV_RECORD_TTL_SECONDS`). Both `handlers/files.ts::handleFileUpload` (the real screenshot/HTML path) and `messages.ts` attachment upload route through it. `FILES_KV` is bound in production, so dedup is active; it GRACEFULLY NO-OPS (plain upload) if the binding is ever absent.
- **Image vs document block typing (`chat.ts::buildFileBlock`).** Each `fileId` is resolved to `image` (mime `image/*`) or `document` by its Files API metadata. Images MUST be `image` blocks — Anthropic 400s an image inside a `document` block ("Only PDF and plaintext documents are supported"), which is exactly the placement screenshot. Lookup failure falls back to `document`.
- **count_tokens pre-flight.** `messages.ts` best-effort logs an estimate (warns past a soft threshold) for large payloads — wrapped in try/catch, NEVER gates/rejects the live request.
- **Opt-in output effort (model-gated).** A registry entry MAY carry `effort: 'low'|'medium'|'high'|'xhigh'`. Handlers add `output_config: { effort }` only when the effort is set AND the resolved model supports it (`supportsEffort` in `lib/anthropic.ts`): Fable 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6. On any other model the worker omits it — `output_config.effort` returns a 400 on e.g. Haiku 4.5 / Sonnet 4.5. `chat.ts` gates on the per-call model; `messages.ts` gates on `claudePayload.model || entry.model` and only applies when the client hasn't already set `output_config`. No registry entry currently sets `effort` — `placement` runs on Haiku 4.5 (effort-unsupported), so it deliberately carries none.

### The `/chat` agent loop (`handlers/chat.ts` + `src/toolsets/`)

`POST /chat` runs the Anthropic tool-use agent loop:

```
model → (tool_use?) → execute tool (owning toolset) → tool_result → model → …   (capped at MAX_ITERATIONS = 8)
```

streaming text out as it arrives. Response shape is chosen by `Accept`:

- `Accept: text/event-stream` → SSE protocol (events: `text`, `tool_call`, `tool_result`, `done`, `error`).
- otherwise → a single JSON object identical to the `done` payload.

`X-Personalizer-System-Prompt` selects the prompt (`chat` default, `onboarding`, `placement`, `proposals`, `analytics-insights`). Per-prompt model / max_tokens / whether tools are sent all come from the prompt registry (see below) — not hardcoded in the loop. The frozen cross-repo contract is in the lib repo at `packages/storefront/src/admin/ai/CONTRACTS.md` (§1 SSE protocol, §2 tools, §8 referencing).

**Toolsets (`src/toolsets/` — standards in [docs/TOOLSETS.md](docs/TOOLSETS.md)).** The AI tools are organized into named TOOLSETS, one module directory per backend, each encapsulating its Anthropic tool definitions, dispatch/executors, normalizers, and degrade conventions. `composeToolsets(subscriberParties, { contextId, env })` (`toolsets/registry.ts`) composes the endpoint's tool surface per request, DATA-DRIVEN off the subscriber's available `IntegrationParty` set — a toolset is offered iff its `integrationParties` is empty (always-active) OR intersects the subscriber's parties. `handleChat` takes `availableParties` (threaded from the router's validate-context-id call, which returns `AvailableIntegrationParties`), sends the composition's `definitions` as the `tools` array, and routes every `tool_use` through the composition's `execute` (adding a toolset never edits handler logic). The `personalizer` toolset is every tool backed by the Personalizer API: the `/v2/ai-tools/*` data queries + `get_entity_context`, called server→server with the merchant's context-ID as the toolset's per-request credentials (resolved through the registry's credential seam — per-request, subscriber-scoped, never model-visible, never logged). The four platform toolsets — `shopify` (`shopify_rest_request` + `shopify_graphql`), `bigcommerce` (`bigcommerce_rest_request`), `klaviyo` (`klaviyo_rest_request`), `google-ads` (`google_ads_gaql_query`) — are transparent passthroughs to the merchant's platform APIs through Personalizer's integration bridge (`v2/integration-bridge/*`): app-ai never holds a platform token; each is party-gated (`shopify` → `ShopifyPersonalizer`, `bigcommerce` → `BigCommercePersonalizer`, `klaviyo` → `Klaviyo`, `google-ads` → `Google`) and resolves only the CALL CHANNEL (context-ID + the `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` Workers Secret + Personalizer base URL via the `src/config.ts` accessors — `toolsets/integration-bridge.ts`); the proxy URL `{party}` segment is the matched `IntegrationParty` name (`v2/integration-bridge/{party}/…`), and the `X-Ls-Integration-Bridge-Error` response header discriminates the platform speaking (surfaced verbatim as data, any status) from LimeSpot-layer failures (degraded with the envelope's `ExceptionType`). Which subscribers see a platform toolset is decided purely by their available parties — no endpoint allowlist.

**CLIENT-tool mode (dormant — no consumer on this branch).** The loop also carries a client-tool path for a future prompt whose tools execute on the CLIENT, not in the worker. When a registry entry carries `clientTools` (`usesTools: false` alongside it — the two are mutually exclusive), `handleChat` sends THOSE tool definitions to the model in place of the server toolset and runs the loop in client-tool mode: on a `tool_use` stop it emits the `tool_call` SSE events, returns the calls to the client in the `done.toolCalls` array (`stopReason: 'tool_use'`), and STOPS the turn — it never executes them and makes no Brain proxy call. The client would run each tool (e.g. in a browser iframe over the merchant's live store), append the `tool_result` turn, and call `/chat` again to continue the loop; a turn that ends with text carries `done.text` and no `toolCalls`. This is a typed capability with NO consumer yet: no prompt on this branch sets `clientTools`, so the client-tool branch is inert (the field is the hook a future client-tool prompt would opt into).

**Referencing (`context.refs`).** `body.context` may carry `refs` — an array of entity references (`{ type, id?, label?, metadata? }`, six type literals: `campaign` / `segment` / `progress-bar` / `bundle` / `analytics-metric` / `analytics-tab`) anchoring the conversation to specific entities. `lib/references.ts` owns the flow:

- **Intake:** array-only; non-object entries, invalid `type` literals, and record-type entries without an `id` string are dropped; capped at `MAX_CHAT_REFS = 5` (first five kept). Requests without refs behave identically to a refs-free build (byte-identical system array — cache safety).
- **Eager Referenced-Entities block:** every surviving ref resolves concurrently (`Promise.allSettled`) — record types via `fetchEntityContext` (`toolsets/personalizer/entity-context.ts`, context-ID forwarded on every Personalizer call, ONE shared subscriber lookup per block build), analytics types from the ref's own `metadata` with NO Personalizer call. A failed resolve degrades that ref's line to `(could not load)`; the block never throws. The block (frozen format: `## Referenced Entities` heading + preamble + one `- [<type>] "<label>" (<anchor>): <payload>` line per ref) is appended by `buildSystem` as a separate, FINAL, **uncached** system block, so the 1h-cached registry prefix and the ≤4 breakpoint budget are untouched.
- **Lazy `get_entity_context` tool** (the personalizer toolset, `toolsets/personalizer/index.ts`, registered with the other tools whenever `entry.usesTools`): the model derefs an entity by `{ type, id }`. Record types → the same `fetchEntityContext` resolution (`{ok:false,...}` degrade on any thrown failure, like the other tools); analytics types → resolved worker-side from the request's refs (`refCategoryPath(ref) === input.id`, fallback first ref of the matching type; `id` here is the category path `analytics/{tab}` / `analytics/{tab}/{metricKey}`) — NO Personalizer call, `{ok:false, result:{error:'analytics reference not attached to this request'}}` when absent. The composition's `execute(name, input, { refs })` receives the surviving refs threaded from `handleChat` → `runAgentLoop`.
- **Record resolution (`toolsets/personalizer/entity-context.ts`):** `fetchEntityContext(type, id, contextId, env)` composes the frozen model-visible `AiToolEntityContext` shape (`{ Type, Id, Found, Title, Status, Kind, Summary, Fields, Related }`, null members omitted) from Personalizer's per-record admin endpoints — campaign probes `v2/discount-campaigns/discount-campaign/{guid}` → `v2/html-campaigns/html-campaign/{guid}` → `v1/imageCampaigns?guid=` (Kind = `discount` / `html` / `image`); segment → `v1/subscriberSegment?guid=`; progress-bar → `v2/progress-bar-campaigns/{guid}` (+ the subscriber's CurrencyCode as `Currency`); bundle → the discount route with a bundle-flavored Summary. `v2/accounts/subscriber` is loaded per resolution: its Guid tenant-checks every loaded entity (the discount cache is guid-keyed; the v1 segment load is not tenant-scoped). Discount/bundle `Related` = the targeted segments (per-guid loads, tenant-checked, non-deleted). A miss — 404/204/5xx record fetch, cross-subscriber, deleted — yields `{ Type, Id, Found: false }`; a malformed guid, unknown type, failed subscriber lookup, Personalizer 401/403, or network failure throws (→ the degrade paths above).

Entity-context fetches are NOT cached (no KV) — fresh per call. The `chat` prompt (`src/prompts/chat.md`) instructs the model to treat a present Referenced-Entities section as THE topic (never ask "which one?").

### Prompt registry (`prompts.ts` + `src/prompts/`)

`prompts.ts` is a thin registry mapping prompt name → metadata:

```
{ prompt, model, maxTokens, usesTools, description, attachments, effort?, clientTools? }
```

(`effort` is optional — see Token-saving levers above. `clientTools` is optional, dormant, and mutually exclusive with `usesTools` — see CLIENT-tool mode above; no prompt on this branch sets it, so it has no consumer yet.)

It is the **single source of truth** for each prompt's model / token / tool choices — both `handlers/chat.ts` (agent loop) and `handlers/messages.ts` (system-prompt injection) read text + metadata through `getSystemPrompt(name, env)`. The model VALUE is a deploy-time configuration choice (No Hardcoded Config Values): each entry pairs with either the `MODEL_DEFAULT` or the `MODEL_PLACEMENT` config accessor (placement is the one latency-sensitive prompt on the faster model), resolved from wrangler `[vars]` / `.dev.vars` when the entry is read. All prompt text lives ONLY under `src/prompts/` (there is exactly one prompt location — no second folder anywhere in the repo). `prompts.ts` imports each `.md` as a string.

**Unified single-vs-multi-file convention.** A prompt is one of two shapes; both resolve to the same registry entry:

- **Simple** → one file: `src/prompts/<name>.md` (e.g. `chat.md`, `placement.md`). Import it and use it as `prompt`.
- **Multi-file** → a folder: `src/prompts/<name>/` (e.g. `image-selection/`), made of parts:
  - `prompt.md` — the main system prompt (required).
  - additional non-underscore context part(s) — composed into the system prompt via the `composePrompt(...)` helper (main prompt first, extra grounding appended after).
  - a sample/attachment file (e.g. `sample.md`) — NOT part of the system prompt; wired as an `attachments` entry `{ content, mimeType, filename }` so `messages.ts` uploads it (Files-API dedup + extended cache) and prepends it to the first message as a document block. Attachments are image-selection-only today.
  - underscore-prefixed files (`_*.md`) remain a supported EXCLUSION convention (never imported, never bundled, never sent to the API — matching the LimeSpot `_` convention) if a prompt folder ever needs a co-located non-runtime file. Per-prompt design/maintenance docs live at `docs/prompts/<name>.md` (process: [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md)).

`image-selection` is the one multi-file prompt: its system text is `prompt.md`; `sample.md` (training examples) is its attachment; its design/maintenance doc is [docs/prompts/image-selection.md](docs/prompts/image-selection.md).

The registry holds six named prompts:

| Name                 | Endpoint    | Tools | Purpose                                                                                                                                                                                                     |
| -------------------- | ----------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image-selection`    | `/messages` | No    | Analyzes page HTML + screenshot → CSS selectors for image/text/CTA personalization (JSON-only). LIVE smart-image.                                                                                           |
| `chat`               | `/chat`     | Yes   | General conversational Studio assistant; runs the tool-use agent loop to read store data.                                                                                                                   |
| `onboarding`         | `/chat`     | Yes   | New-merchant onboarding assistant; applies best-practice defaults, runs the agent loop.                                                                                                                     |
| `placement`          | `/chat`     | No    | Structured placement proposer; one-shot JSON, no tools, faster model (Haiku 4.5).                                                                                                                           |
| `proposals`          | `/chat`     | Yes   | Per-store onboarding SETUP proposer; grounds in real store data via the agent loop, returns a structured JSON proposal (boxes/segments/progress-bar/bundles). Drives lib `ai/brain/proposals.ts`.           |
| `analytics-insights` | `/chat`     | No    | One-shot analytics INSIGHTS generator; returns a JSON array of up to three `{ kind, text }` insights over the tab's real data (handed over as grounding), no tools. Drives lib `analytics/ai-insights.tsx`. |

**Bundler text rule (no runtime fs):** `import x from './prompts/chat.md'` — and nested multi-file imports like `import x from './prompts/image-selection/prompt.md'` — resolve to the file's string contents at BUILD time, in both targets with the SAME import specifier (no `?raw`):

- **Worker** — `[[rules]] type = "Text"` (`globs = ["**/*.md"]`) in `wrangler.toml` makes esbuild emit each `.md` as a text module. The `**/*.md` glob matches nested folders, so multi-file prompts bundle without any config change.
- **Tests** — an inline Vite plugin in `vitest.config.ts` does the same for any `.md` at any depth (`transform` turns `.md` into `export default "<contents>"`).

To add/edit a prompt: create/edit the `.md` file(s) under `src/prompts/` (a single `.md` for a simple prompt, or a `<name>/` folder for a multi-file prompt), add/update its registry entry in `prompts.ts`. If a prompt needs runtime `${}` interpolation it can't be a static `.md` — keep that dynamic bit in JS.

> There is only ONE prompt location: `src/prompts/`. Simple prompts are a single `.md`; advanced/multi-file prompts are a folder (`prompt.md` + a `sample`/attachment file). Per-prompt maintenance docs live under `docs/prompts/`. No stray second prompts directory exists anywhere in the repo.

### Logging

`console.*` IS the observability mechanism (read via `wrangler tail`) — do not strip it. Use `createLogger(scope)` from `lib/logger.ts` so each line is prefixed (`[Messages] …`) and a tail grep can isolate one subsystem.

## Commands

- `npm run dev` — local dev server (`wrangler dev`, port 8787). Local config comes from `.dev.vars` — copy `.dev.vars.example` and fill in the key.
- `npm test` — vitest (watch). One-shot: `npx vitest run`.
- `npm run typecheck` — `tsc --noEmit` (strict; must be 0)
- `npm run lint` / `npm run lint:fix` — ESLint over the whole repo (worker TS, tests, `scripts/`, tooling configs)
- `npm run format-check` / `npm run format` — Prettier over the whole repo (exclusions + rationale in `.prettierignore`)
- `npx wrangler deploy --dry-run` — build the bundle without deploying (verifies imports + the Text rule)
- `npm run tail` — live production logs

## Tests (`test/`)

- `test/chat.test.ts` — the `/chat` agent loop, SSE protocol, tool-use loop, MAX_ITERATIONS, placement no-tools path, non-streaming JSON, prompt selection, `get_entity_context` dispatch through the registry composition (record → per-record Personalizer routes/header + normalized result, analytics → refs, error degrade), and the `context.refs` handler flow (prefetch-per-ref, uncached final block, no-refs byte-identical system, 5-ref cap + one shared subscriber lookup, failure degrade, refs threaded into the loop).
- `test/toolsets.test.ts` — `src/toolsets/registry.ts`: composition (allowlist order, empty allowlist, unregistered-name throw, per-request independence), endpoint-allowlist gating (out-of-composition tools degrade with zero backend calls), the credential seam (contextId resolved per composition and forwarded as the Personalizer header, never in the model-visible definitions, per-call `refs` extras), and the FROZEN model-visible tool contract (byte-for-byte file snapshot of the composed definitions, `test/__snapshots__/tool-definitions.contract.json`).
- `test/platform-toolsets.test.ts` — the platform toolsets (`toolsets/{shopify,bigcommerce,klaviyo,google-ads}/` + `toolsets/integration-bridge.ts`): the REST/GraphQL/GAQL wire shapes toward Personalizer's `v2/integration-bridge/*` (URLs, mirrored verbs, PascalCase `Query`/`Variables`/`PageSize` bodies, JSON POST/PUT bodies, body-less DELETE), the `X-Ls-Integration-Bridge-Error` discrimination (platform 4xx/5xx surface verbatim as `ok: true` data; whitelisted `Link`/`Retry-After`/rate-limit headers surface as `result.headers`, omitted when absent; LimeSpot envelopes degrade with `<Message> (<ExceptionType>)`; network failures degrade), and the call-channel credential seam (no proxy call without a service token/context; the token never model-visible).
- `test/references.test.ts` — `lib/references.ts`: intake sanitization + cap, `refCategoryPath`, per-type `resolveRef` (record → normalized entity-context payload vs analytics → metadata, throw on subscriber failure, Found:false pass-through), the FROZEN Referenced-Entities block string (contract snapshot), label fallbacks, allSettled degradation, analytics-only → zero Personalizer calls, one-subscriber-lookup-per-block.
- `test/entity-context.test.ts` — `toolsets/personalizer/entity-context.ts`: the frozen AiToolEntityContext shape per record type (member order, Summary grammar incl. `0.##` amounts + schedule, Fields minimums, null-member omission), the campaign discount→html→image probe, tenant re-checks (cross-subscriber/deleted → Found:false), one-hop Related filtering, failure semantics (miss vs throw: 404/204/5xx → Found:false; malformed guid / unknown type / subscriber failure / 401/403 → throw), the shared subscriber lookup, and no validate-context-id roundtrip.
- `test/proxy.test.ts` — the proxy surface: CORS, response/error shape, context validation, the Anthropic client (headers/beta/URLs, config-error rejection), `manageCacheControl`, and the `/files` + `/messages` + `/health` handlers.
- `test/config.test.ts` — `src/config.ts`: the no-fallback contract (every accessor throws on a missing/empty variable, naming it and where to set it) + the PRODUCTION `[vars]` pins read from wrangler.toml itself (`PERSONALIZER_API_URL = https://personalizer.io`, the Anthropic origin, both model choices, the credentialed-origin allowlist, and no secret in the file).
- `test/architecture.test.ts` — fitness scans over `src/` + `scripts/` enforcing the standing invariants: explicit endpoint toolset allowlists; credentials never in logs or the model-visible system builder; one error shape (no bespoke `{ error: { message } }` envelopes); No Hardcoded Config Values (no absolute URL literals in src or scripts, no inline `||`/`??` fallbacks on `env`/`process.env` reads, required worker vars read only through `src/config.ts`).
- `test/helpers.ts` — shared typed fixtures: the complete `Env` fixture, fetch-mock accessors, the worker-SSE parser, the KV mock.
- `test/token-saving.test.ts` — the cost-reduction levers: 1h-TTL placement (system/context/kept user blocks), `applyConversationBreakpoints` (last-block, ~15-block intervals, cap + `reservedHeadBlocks`, stale-strip), `file-dedup` (sha256Hex vector, KV hit + stale-id verify/re-upload + miss + no-op, 30d TTL), `fileIds` document/image block typing + 1h file-prefix breakpoint + ≤4-breakpoint-with-file-prefix invariant, `countTokens` body/header, model+effort routing, and an end-to-end agent-loop breakpoint-count ≤4 assertion.

Tests mock `fetch` and `env` — no real network. Don't weaken assertions to pass.

A further layer, the **live token-savings gate** (`scripts/verify-caching.mjs`, `npm run verify:caching`), runs against the DEPLOYED worker — it needs a master context-ID + a reachable target, so it is OUT of `vitest run`. It asserts `cache_read_input_tokens > 0` on a repeat call for the chat tools+system prefix and the placement file-block prefix, and throws loudly (never silently skips) on a 0-read regression or missing creds. It is a required pre-release step. See [docs/TESTING.md](docs/TESTING.md).

## CI + deploy

- **CI** (`.github/workflows/ci.yml`) runs on every push + PR (Node 20): `npm run lint` → `npm run format-check` → `npm run typecheck` → `npx vitest run` → `npx wrangler deploy --dry-run`. All five must be green. `lint` and `format-check` run over the WHOLE repo (`eslint .` / `prettier --check .`) — worker TS, tests, `scripts/verify-caching.mjs` (Node globals), tooling configs, and every `.md`/`.yml`/`.json`. The only prettier exclusions are byte-frozen contract artifacts, each with its rationale in `.prettierignore`: the prompt text under `src/prompts/` (shipped byte-for-byte) and the tool-schema snapshot in `test/__snapshots__/`.
- **Caching gate workflow** (`.github/workflows/verify-caching.yml`) is a `workflow_dispatch` job guarded on the `APP_AI_CONTEXT_ID` + `APP_AI_TARGET` repo secrets — it runs the live token-savings gate against the deployed worker. The guard step exits cleanly when either secret is absent, so it never fails a fork or unconfigured repo, and it is never wired into the push/PR `build` job (which has no secrets). Otherwise the gate is the manual pre-release step (`npm run verify:caching` with `APP_AI_TARGET` + `APP_AI_CONTEXT_ID`/`APP_AI_CONTEXT_FILE` set explicitly — the script takes no defaults).
- **Deploy** is automatic from `main` via Cloudflare's GitHub integration — **pushing `main` deploys to production.** No manual step. `npx wrangler deploy --dry-run` builds the bundle (verifies imports + the Text rule) without deploying.
- **Tooling baseline:** strict TypeScript (`tsconfig.json`) + ESLint flat config with typescript-eslint (`eslint.config.js`) + Prettier (`prettier.config.cjs`) + `.editorconfig`. No production npm dependencies; dev-only `wrangler`, `vitest`, `typescript`, `typescript-eslint`, `eslint`, `prettier`.

## Automated PR review loop (Gemini) — run until clean

PRs on LimeSpot repos get an automated Gemini reviewer. Every PR is driven to
clear via this loop, repeated **until clean**:

1. Trigger a review by commenting `/gemini review` on the PR (the first review
   may auto-fire on PR open).
2. Poll for the review (~every 2 min; allow up to ~15 min per round).
3. Triage every comment: **SOLVE** (the critique is valid — implement the fix)
   or **REJECT** (grounded counter-evidence only: file:line or runnable proof.
   Verify Gemini's claims before accepting them — it is frequently wrong).
4. Reply to EVERY comment (what was done / why rejected) and resolve EVERY
   addressed thread.
5. Run the repo's full gate set; commit or amend per the branch's rules;
   force-push with lease.
6. Re-trigger `/gemini review` and repeat.

Termination: **clean** = a round raising zero new comments. Two consecutive
rounds of nothing but recycled, already-rejected points = terminal ("clean
modulo recycled rejections"). An explicitly agreed round cap may also end the
loop. Comments that raise genuine product decisions are flagged to the owner,
never guessed. Pushes and PR mutations always require the user's explicit
per-session authorization.

## Hard rules

- **The live surface is a stable external contract.** `/files`, `/messages` (image-selection), context validation, CORS, and cache_control serve production. Their routes, request/response shapes, headers, and status codes must stay identical.
- **Brain is the source of truth** for the `/v2/ai-tools/*` request/response shapes (`toolsets/personalizer/index.ts`), the per-record admin endpoints consumed by `toolsets/personalizer/entity-context.ts` (`Controllers/V2/DiscountCampaignsController.cs`, `Controllers/V2/HtmlCampaignsController.cs`, `Controllers/V1/ImageCampaignsController.cs`, `Controllers/V1/SubscriberSegmentController.cs`, `Controllers/V2/ProgressBarCampaignsController.cs`, `Controllers/V2/AccountsController.cs` → `subscriber`), and the `/v2/administrator-authentication/validate-context-id` shape (`auth.ts`). Mirror Brain's C# exactly — verify routes, query params, and fields against the sibling `brain` repo (`Controllers/V2/AiToolsController.cs` `[Route("v2/ai-tools")]` → `store-analytics` / `segments` / `campaigns` / `store-config`; `AdministratorAuthenticationController.cs` → `validate-context-id`). Brain serializes PascalCase with enums as strings and null members omitted (`NullValueHandling.Ignore`) — `entity-context.ts` mirrors that omission. Brain also owns the AI integration-bridge wire contract consumed by `toolsets/integration-bridge.ts` (`v2/integration-bridge/{platform}/rest/{path}` + `/graphql` + `/gaql` routes, the `{ Query, Variables }` / `{ Query, PageSize }` request models, the `X-Personalizer-Integration-Bridge-Token` caller header, and the `X-Ls-Integration-Bridge-Error` discrimination header). Never invent, narrow, or rename a field in `toolsets/` / `auth.ts`; never assume the shape from the legacy app TS (it can be stale).
- **One error shape — Brain's wire format — status mapped from the failure.** Every error response is structurally identical to a Brain error (`{ "Message": ..., "ExceptionType": ..., "MessageDetail": ... }`, flat PascalCase, `MessageDetail` omitted when absent), built by `errorResponse`/`errorPayload` in `lib/responses.ts`, so clients keep ONE error parser for both backends. SSE `error` events carry the same payload. Status + `ExceptionType` mirror Brain's mappings: missing context-ID → 401 `MissingContextIDException`; a Personalizer rejection of the validate call relays Personalizer's status + body UNCHANGED; client input validation → 400 `ArgumentException`; unknown route → 404 `RecordNotFoundException`; non-ok Anthropic responses keep Anthropic's status with `AnthropicApiException` + the raw upstream body in `MessageDetail` (a 500 `/files` upload also appends the beta-access hint); everything else → 500 `Exception` via the router's `errorResponseFrom` catch. Handlers do not invent per-route error envelopes. See [docs/DECISIONS.md](docs/DECISIONS.md) #7.
- Prompt `.md` text must match the intended prompt byte-for-byte.
- No new production npm dependencies (the worker bundle stays dependency-free); dev tooling only when a gate needs it.
- **No Hardcoded Config Values** (Tech / Constraints above) — URLs and deploy-time tunables live in wrangler `[vars]` / `.dev.vars` behind `src/config.ts`; missing config throws; no inline fallbacks. Fitness-tested.
- Commit locally; **never push without explicit intent** (push = production deploy).
