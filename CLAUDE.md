# app-ai — Anthropic Proxy (Cloudflare Worker)

**Parent:** [LimeSpot/CLAUDE.md](../CLAUDE.md)

The seven always-in-context hard rules bind here and are inlined for Codex in [AGENTS.md](AGENTS.md) beside this file. The depth behind them lives once in the workspace repository's `../_standards/*.md` — `engineering`, `testing`, `documentation-and-comments`, `git-and-approval`, `architecture`, `naming`, `security`, `web-ui` — read on demand. This file carries only what is specific to app-ai and never restates a workspace standard. Activate this repository's git hooks once per clone: `../_enforcement/install-git-hooks.sh app-ai`.

**CLAUDE.md Rule:** Any code change MUST update the CLAUDE.md of the affected folder (`src/handlers/CLAUDE.md`, `src/lib/CLAUDE.md`, `src/toolsets/CLAUDE.md`, `src/prompts/CLAUDE.md`), then propagate the change up to this root file. If you add/rename a handler, lib module, toolset, prompt, or route, update the relevant section here AND the matching folder doc. Keep the documentation tree always valid.

A Cloudflare Worker that is a secure proxy in front of Anthropic. It holds the Anthropic API key, validates ordinary merchant requests through Personalizer, and provides a separate origin-scoped extension demo exchange for stores without a LimeSpot Context-ID. Parts of it serve **production** (the live smart-image feature depends on `/files` + `/messages`).

## Project docs

Standalone-project documentation lives at the repo root and under `docs/`:

| Document                                             | Purpose                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [README.md](README.md)                               | Quick start, endpoints, deployment, token-saving levers (with live-measured numbers)              |
| [CONTRIBUTING.md](CONTRIBUTING.md)                   | Commit convention, push-to-main deploy rule, validate-before-push loop                            |
| [docs/CODE-PATTERNS.md](docs/CODE-PATTERNS.md)       | Coding standards — strict TypeScript, clean code, error handling, No Hardcoded Config Values      |
| [docs/TESTING.md](docs/TESTING.md)                   | The required offline test layers plus the optional live token-savings diagnostic                  |
| [docs/DECISIONS.md](docs/DECISIONS.md)               | Numbered decision log with rationale                                                              |
| [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md)         | Honest current limitations                                                                        |
| [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md) | Prompt authoring/iteration workflow (artifact rules, length enforcement, maintenance-doc upkeep)  |
| [docs/TOOLSETS.md](docs/TOOLSETS.md)                 | Toolset standards: what a toolset is, the registry, the credential seam + security standards      |
| [docs/DEMO-AUTH.md](docs/DEMO-AUTH.md)               | Extension demo claims, entitlement, scope, quotas, global controls, and Durable Object deployment |
| [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md) | The folder-by-folder map of `src/` — which module owns what                                       |
| [docs/QC-OBSERVABILITY.md](docs/QC-OBSERVABILITY.md) | The onboarding QC cascade's telemetry contract                                                    |
| [docs/prompts/](docs/prompts/)                       | Per-prompt design/maintenance docs (`<name>.md`, e.g. `image-selection.md`)                       |

Adding or renaming a `docs/*` file updates this table (propagation rule below).

## Documentation conventions

Two rules govern every `CLAUDE.md`, `README.md`, and code comment/JSDoc in this repo:

1. **CLAUDE.md propagation.** Any code change MUST update the affected folder's `CLAUDE.md` (`src/handlers/CLAUDE.md`, `src/lib/CLAUDE.md`, `src/toolsets/CLAUDE.md`, `src/prompts/CLAUDE.md`), then propagate the change up to this root file. Adding/renaming a handler, lib module, toolset, prompt, or route updates the relevant section here AND the matching folder doc. Keep the documentation tree always valid.
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
   `npm run format-check`, `npm run typecheck`, `npm run deploy:dry-run` — and the documentation tree updated with the change (this
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
- **Brain Is the Single Source of Truth** — anything crossing the Personalizer API boundary mirrors Brain's C# exactly; verify in the sibling `brain` repo, never the sibling `app` TS, which can be stale (Hard rules below).
- **Secrets stay server-side** — API keys, bearer tokens, cookies, passwords, and service credentials are never model-visible and are redacted by the logging runtime. The request context-ID is intentionally retained as a private operational correlation field (docs/TOOLSETS.md; fitness-tested).
- **No Silent Skips** — tests never skip on a missing precondition; they throw with an actionable error.
- **Current-state docs** — the documentation tree describes what IS (Documentation conventions above) and updates in the same commit as the code.

The review prompts use four explicit correction verbs. `styleBox` changes appearance, `removeBox`
removes, `addBox` creates a missing box, and `moveBox` relocates an existing box. Relocation is never
encoded as remove+add; lib rejects both halves of that ambiguous pair atomically. The shared prompt
contract and synchronization points are documented in [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md).

## Tech / Constraints

- **Strict TypeScript (ES modules).** `tsconfig.json` declares the full strict family plus the beyond-strict correctness flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, …). No `any`, no `@ts-ignore`/`@ts-expect-error` — `unknown` + narrowing instead (docs/CODE-PATTERNS.md → Strict TypeScript). `npm run typecheck` (`tsc --noEmit`) is a required gate; there is no separate build step — wrangler/esbuild transpiles the TS natively at deploy time, vitest/vite at test time.
- Cloudflare Workers runtime (V8 isolates, Web-standard `fetch`/`Request`/`Response`/`FormData`) — **no Node.js, no runtime filesystem.**
- No production npm dependencies (nothing is bundled into the deployed worker). Dev-only: `wrangler`, `vitest`, `typescript`, `typescript-eslint`, `eslint`, `prettier`, and — for the free local Claude-Code testing channel (`scripts/dev-claude-shim.mjs`) — `@anthropic-ai/claude-agent-sdk` + `zod`. The shim is standalone Node tooling run by `npm run dev:shim`; it is never imported by `src/` and never ships to production.
- **No Hardcoded Config Values (ENFORCED).** Every URL and deploy-time tunable (Personalizer/Anthropic origins, credentialed CORS origins, model choices) lives in configuration — wrangler.toml `[vars]` (production) / `.dev.vars` + committed `.dev.vars.example` (local) — and is read ONLY through the typed accessors in `src/config.ts` (the single typed `Env` interface). **Missing config = a thrown error naming the variable and where to set it. No fallback defaults anywhere** — `env.X || …` / `env.X ?? …` is banned. True contract constants (wire field names, tool names, routes, prompt text, Anthropic's 4-breakpoint limit, the contract-frozen `MAX_ITERATIONS` / `MAX_CHAT_REFS`) stay in code. Full rule: docs/CODE-PATTERNS.md → "No Hardcoded Config Values"; enforced by the fitness scans in `test/architecture.test.ts` and the production-value pins in `test/config.test.ts`.
- **The Anthropic API key never leaves the worker.** Only `src/lib/anthropic.ts` reads it, via `claudeApiKey(env)` from `src/config.ts`.
- **The Personalizer integration-bridge token (`PERSONALIZER_INTEGRATION_BRIDGE_TOKEN`, Workers Secret) never leaves the worker.** Only the platform toolsets' call-channel seam (`src/toolsets/integration-bridge.ts`) reads it, via `personalizerIntegrationBridgeToken(env)` from `src/config.ts`; it is sent solely as the `X-Personalizer-Integration-Bridge-Token` header toward Personalizer's integration bridge — never a `wrangler.toml` var, never logged, never model-visible.
- **Demo signing keys are separated.** The website shares `DEMO_ACTIVATION_SIGNING_SECRET` for activation assertions and the distinct `DEMO_AUDIT_STATUS_SIGNING_SECRET` for app-ai callbacks; `DEMO_SESSION_SIGNING_SECRET` remains app-ai-only. All three are encrypted secrets with at least 32 bytes and never model-visible.
- Deploy is automatic from `main` via Cloudflare's GitHub integration — **pushing `main` deploys to production**, which is why `main` is read-only to every agent and that push is an operator step carrying its own deploy approval (Hard rules below).

## Architecture

Entry/router → handlers → shared lib + toolsets. The router is thin; all logic lives in `handlers/`, `lib/`, and `toolsets/`. Four chokepoints hold that split together: `src/config.ts` is the ONE place a binding is read, `src/lib/anthropic.ts` the ONE place that talks to Anthropic, `src/lib/responses.ts` the ONE error shape, and `src/prompts/` the ONE location prompt text lives in. Which module owns what is the folder-by-folder map in [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md), read on demand; each folder's own rules are in its `CLAUDE.md`.

The `billing-assistant` prompt is a no-tool `/chat` surface for subscription experiences. It
answers only from the request's current pricing grounding, never accepts payment secrets, and cannot
mutate an account or subscription.

### Routes

`src/index.ts` IS the route table — it is the only router and short enough to read directly, so no copy of it lives in a document. The invariant it encodes: `/health` is the only unauthenticated route; `POST /demo/session/exchange` is authenticated by a website activation JWT; every other route requires a merchant context-ID, and only `POST /files` and `POST /messages` additionally accept a scoped demo bearer. A new route is added there and nowhere else.

Normal auth calls `validateContextId(X-Personalizer-Context-ID, env)` before dispatch. The alternate demo path exchanges an exact, email-verified website JWT once and accepts only an app-ai-signed `ls_demo_…` bearer plus the extension's active-tab-origin header. Demo scope is four onboarding upload destinations and an explicit onboarding proposal/QC prompt allowlist; it cannot list/delete files, call `/chat`, use Brain, or choose model/tools/effort. Its audit-keyed Durable Object atomically serializes tile uploads, quotas and owned file IDs, enforces two public successful completions across reissued links, and durably mirrors status to website D1. Exact claims, public-origin vs verified `@limespot.com` entitlement, callback signing, limits, global-cap ownership, and deployment are in [docs/DEMO-AUTH.md](docs/DEMO-AUTH.md).

### The Anthropic client (`lib/anthropic.ts`)

The single place that talks to `api.anthropic.com`. It owns the base URLs, `anthropic-version`, the `x-api-key` injection, and the per-surface `anthropic-beta` flags — the `ANTHROPIC_VERSION` / `FILES_BETA` / `MESSAGES_BETA` constants at the top of that module are the source of truth for their values, and no document restates them. Its exported surface is the whole Anthropic vocabulary the worker has: file upload/list/delete, a non-streaming and a streaming message call, and the free `count_tokens` pre-flight, which forwards only the fields that endpoint accepts. **No handler re-implements fetch or header logic** — a handler that needs a new Anthropic capability adds it here.

### Token-saving levers (prompt caching, dedup, count_tokens, effort)

Cost-reduction is additive and never changes external request/response shapes.

**What caches, measured live (Opus 4.8 / Haiku 4.5):**

- **`/chat` + onboarding (Opus 4.8) cache.** The cached prefix is `tools` (TOOL_DEFINITIONS, ~6.4KB JSON) + the `buildSystem` base prompt block, ~1351 input tokens. A repeat call reads the full ~1351 from cache (`cache_read_input_tokens: 1351`, `input_tokens: 89`). The effective Opus-4.8 cacheable prefix is therefore ≤1351 tokens — the TOOL_DEFINITIONS block is what clears the floor (a tool-less prompt this small would not cache). The agent-loop conversation breakpoints (below) extend this to the growing turns.
- **Placement file blocks (Haiku 4.5) cache — the big win.** The placement flow uploads a screenshot + cleaned HTML via `POST /files`, referenced as `fileIds` in `POST /chat`. Those file blocks (thousands of tokens — they dwarf the ~370-token placement system prompt) carry a 1h breakpoint on the LAST block, so a repeat placement call on the same page reads them at 0.1× (`cache_read_input_tokens` > 0 on call 2). Same-page reuse maps to the same `file_id` via the `/files` content-hash dedup, so the bytes hit the same cache entry.
- **Placement _system_ prompt (~370 tokens) does NOT cache and is left uncached — by design.** It is well under Haiku 4.5's minimum cacheable prefix; a `cache_control` marker on it would be a silent no-op, and padding it to clear the floor would cost more than it saves. The placement win is the file blocks, not the system prompt. (`buildSystem` still attaches the 1h marker to the base block because chat/onboarding share that path and DO clear the floor via tools; on placement the marker is harmless — the API ignores an unmet prefix — but it is genuinely inert there.)

**The levers:**

- **Extended 1h prompt cache (`EXTENDED_CACHE_CONTROL` in `cache-control.ts`).** The STABLE prefix uses `{ type: 'ephemeral', ttl: '1h' }` (GA — no beta header): `messages.ts` system block + reused file-attachment blocks; `chat.ts` `buildSystem` base prompt block (the volatile context block AND the Referenced-Entities block stay uncached — the system array is `[ registry (1h) , context? , referenced-entities? ]`, per-call blocks last so the cached prefix stays byte-stable); the placement file-prefix block (last `fileIds` block); and explicitly marked user blocks `manageCacheControl` keeps. The onboarding review-all caller sends round-0, clean-reference, and current screenshots as variable user evidence without an internal stable-prefix marker or pre-customization originals. Cache management strips any marker before token counting/inference, preserves block/file-ID order, and ranks other user images/documents only for the remaining slots. Conversation turns use the 5-min default (short-lived).
- **Agent-loop breakpoints (`agent-cache.ts`).** `runAgentLoop` calls `applyConversationBreakpoints(conversation, { maxBreakpoints, reservedHeadBlocks })` each iteration: strips stale breakpoints (except the reserved file-prefix head blocks), then re-applies last-block + intermediates every ~15 blocks so the 20-block lookback never misses. Budget ≤4 total: 1 system + (1 file-prefix when `fileIds` present, so `maxBreakpoints` drops to 2) + conversation; otherwise system + 3 conversation.
- **Files API checksum dedup (`file-dedup.ts`) — LIVE.** `dedupUpload({content,mimeType,filename}, env)` SHA-256s the bytes; on `env.FILES_KV` hit it VERIFIES the cached `file_id` still exists (Files API metadata, `getFileMetadata`) before reuse — a 404 drops the stale record and re-uploads, so a dead id is never vended. Misses upload and store `hash → { fileId, createdAt }` with a 30-day TTL (`KV_RECORD_TTL_SECONDS`). Both `handlers/files.ts::handleFileUpload` (the real screenshot/HTML path) and `messages.ts` attachment upload route through it. `FILES_KV` is bound in production, so dedup is active; it GRACEFULLY NO-OPS (plain upload) if the binding is ever absent.
- **Image vs document block typing (`chat.ts::buildFileBlock`).** Each `fileId` is resolved to `image` (mime `image/*`) or `document` by its Files API metadata. Images MUST be `image` blocks — Anthropic 400s an image inside a `document` block ("Only PDF and plaintext documents are supported"), which is exactly the placement screenshot. Lookup failure falls back to `document`.
- **count_tokens pre-flight.** `messages.ts` best-effort logs an estimate (warns past a soft threshold) for large payloads — wrapped in try/catch, NEVER gates/rejects the live request.
- **Opt-in and adaptive output effort (model-gated).** A registry entry MAY carry `effort: 'low'|'medium'|'high'|'xhigh'` or `adaptiveEffort: { default, escalated }`. Handlers add `output_config: { effort }` only when the resolved model supports it — `supportsEffort` in `lib/anthropic.ts`, over the `EFFORT_SUPPORTED_MODELS` set declared beside it, which is the only place that model set is written down. On other models the worker omits it. `onboarding-review-all` uses low by default and medium when the content-free `X-Personalizer-QC-Escalated: 1` recovery header is present; app-ai still owns the model and effort mapping. The holistic proposal remains medium; per-page proposal/review remain low.
- **Cascaded onboarding QC.** `onboarding-review-gate-all` uses the configured fast tier and a compact output budget to classify every dirty page from bounded whole-store evidence. Only failed, uncertain, malformed, or uncovered pages enter `onboarding-review-all` on the balanced tier for detailed correction generation.

### The `/chat` agent loop (`handlers/chat.ts` + `src/toolsets/`)

`POST /chat` runs the Anthropic tool-use agent loop:

```
model → (tool_use?) → execute tool (owning toolset) → tool_result → model → …   (capped at MAX_ITERATIONS = 8)
```

streaming text out as it arrives. Response shape is chosen by `Accept`:

- `Accept: text/event-stream` → SSE protocol (events: `text`, `tool_call`, `tool_result`, `done`, `error`).
- otherwise → a single JSON object identical to the `done` payload.

`X-Personalizer-System-Prompt` selects the prompt (`chat` default, `onboarding`, `placement`, `proposals`, `analytics-insights`). Per-prompt model / max_tokens / whether tools are sent all come from the prompt registry (see below) — not hardcoded in the loop. The frozen cross-repo contract is in the lib repo at `packages/storefront/src/admin/ai/CONTRACTS.md` (§1 SSE protocol, §2 tools, §8 referencing).

**Toolsets (`src/toolsets/` — standards in [docs/TOOLSETS.md](docs/TOOLSETS.md)).** The AI tools are organized into named TOOLSETS, one module directory per backend, each encapsulating its Anthropic tool definitions, dispatch/executors, normalizers, and degrade conventions. `composeToolsets(subscriberParties, { contextId, env })` (`toolsets/registry.ts`) composes the endpoint's tool surface per request, DATA-DRIVEN off the subscriber's available `IntegrationParty` set — a toolset is offered iff its `integrationParties` is empty (always-active) OR intersects the subscriber's parties. `handleChat` takes `availableParties` (threaded from the router's validate-context-id call, which returns `AvailableIntegrationParties`), sends the composition's `definitions` as the `tools` array, and routes every `tool_use` through the composition's `execute` (adding a toolset never edits handler logic). The `personalizer` toolset is every tool backed by the Personalizer API: the `/v2/ai-tools/*` data queries + `get_entity_context`, called server→server with the merchant's context-ID as the toolset's per-request credentials (resolved through the registry's credential seam — per-request, subscriber-scoped, never model-visible, and retained only as private request-log correlation). The four platform toolsets — `shopify` (`shopify_rest_request` + `shopify_graphql`), `bigcommerce` (`bigcommerce_rest_request`), `klaviyo` (`klaviyo_rest_request`), `google-ads` (`google_ads_gaql_query`) — are transparent passthroughs to the merchant's platform APIs through Personalizer's integration bridge (`v2/integration-bridge/*`): app-ai never holds a platform token; each is party-gated by its own descriptor's `integrationParties` declaration (the source of truth for that pairing) and resolves only the CALL CHANNEL (context-ID + the `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` Workers Secret + Personalizer base URL via the `src/config.ts` accessors — `toolsets/integration-bridge.ts`); the proxy URL `{party}` segment is the matched `IntegrationParty` name (`v2/integration-bridge/{party}/…`), and the `X-Ls-Integration-Bridge-Error` response header discriminates the platform speaking (surfaced verbatim as data, any status) from LimeSpot-layer failures (degraded with the envelope's `ExceptionType`). Which subscribers see a platform toolset is decided purely by their available parties — no endpoint allowlist.

**CLIENT-tool mode (LIVE — first consumer `onboarding-chat`).** The loop also carries a client-tool path for a prompt whose tools execute on the CLIENT, not in the worker. When a registry entry carries `clientTools` (`usesTools: false` alongside it — the two are mutually exclusive), `handleChat` sends THOSE tool definitions to the model in place of the server toolset and runs the loop in client-tool mode: on a `tool_use` stop it emits the `tool_call` SSE events, returns the calls to the client in the `done.toolCalls` array (`stopReason: 'tool_use'`), and STOPS the turn — it never executes them and makes no Brain proxy call. The client (the lib) runs each tool (in a browser iframe over the merchant's live store), appends the `tool_result` turn, and calls `/chat` again to continue the loop; a turn that ends with text carries `done.text` and no `toolCalls`. The first live consumer is the **`onboarding-chat`** prompt, which carries **`look_at_page`** (`lib/client-tools.ts` — capture a full-page store screenshot; `page?: string` hint). Its own system prompt (`prompts/onboarding-chat.md`) drops the server-data-tool guidance (`get_store_analytics` / `get_entity_context` aren't sent in client-tool mode) and steers the model to `look_at_page`.

**Referencing (`context.refs`).** `body.context` may carry `refs` — entity references anchoring the conversation to specific entities. `lib/references.ts` owns both the wire shape and the valid type literals: `RECORD_REF_TYPES` (Personalizer-resolved, each needing an `id`) and `ANALYTICS_REF_TYPES` (resolved from the ref's own `metadata`) declared there are the whole vocabulary, and the split between them is what decides whether resolving a ref costs a Personalizer call. The flow:

- **Intake:** array-only; non-object entries, invalid `type` literals, and record-type entries without an `id` string are dropped; capped at `MAX_CHAT_REFS = 5` (first five kept). Requests without refs behave identically to a refs-free build (byte-identical system array — cache safety).
- **Eager Referenced-Entities block:** every surviving ref resolves concurrently (`Promise.allSettled`) — record types via `fetchEntityContext` (`toolsets/personalizer/entity-context.ts`, context-ID forwarded on every Personalizer call, ONE shared subscriber lookup per block build), analytics types from the ref's own `metadata` with NO Personalizer call. A failed resolve degrades that ref's line to `(could not load)`; the block never throws. The block (frozen format: `## Referenced Entities` heading + preamble + one `- [<type>] "<label>" (<anchor>): <payload>` line per ref) is appended by `buildSystem` as a separate, FINAL, **uncached** system block, so the 1h-cached registry prefix and the ≤4 breakpoint budget are untouched.
- **Lazy `get_entity_context` tool** (the personalizer toolset, `toolsets/personalizer/index.ts`, registered with the other tools whenever `entry.usesTools`): the model derefs an entity by `{ type, id }`. Record types → the same `fetchEntityContext` resolution (`{ok:false,...}` degrade on any thrown failure, like the other tools); analytics types → resolved worker-side from the request's refs (`refCategoryPath(ref) === input.id`, fallback first ref of the matching type; `id` here is the category path `analytics/{tab}` / `analytics/{tab}/{metricKey}`) — NO Personalizer call, `{ok:false, result:{error:'analytics reference not attached to this request'}}` when absent. The composition's `execute(name, input, { refs })` receives the surviving refs threaded from `handleChat` → `runAgentLoop`.
- **Record resolution (`toolsets/personalizer/entity-context.ts`):** `fetchEntityContext(type, id, contextId, env)` composes the frozen model-visible `AiToolEntityContext` shape — declared in `toolsets/personalizer/entity-context.ts`, member order and null-member omission pinned by `test/entity-context.test.ts` — from Personalizer's per-record admin endpoints — campaign probes `v2/discount-campaigns/discount-campaign/{guid}` → `v2/html-campaigns/html-campaign/{guid}` → `v1/imageCampaigns?guid=` (Kind = `discount` / `html` / `image`); segment → `v1/subscriberSegment?guid=`; progress-bar → `v2/progress-bar-campaigns/{guid}` (+ the subscriber's CurrencyCode as `Currency`); bundle → the discount route with a bundle-flavored Summary. `v2/accounts/subscriber` is loaded per resolution: its Guid tenant-checks every loaded entity (the discount cache is guid-keyed; the v1 segment load is not tenant-scoped). Discount/bundle `Related` = the targeted segments (per-guid loads, tenant-checked, non-deleted). A miss — 404/204/5xx record fetch, cross-subscriber, deleted — yields `{ Type, Id, Found: false }`; a malformed guid, unknown type, failed subscriber lookup, Personalizer 401/403, or network failure throws (→ the degrade paths above).

Entity-context fetches are NOT cached (no KV) — fresh per call. The `chat` prompt (`src/prompts/chat.md`) instructs the model to treat a present Referenced-Entities section as THE topic (never ask "which one?").

### Prompt registry (`prompt-registry.ts` + `src/prompts/`)

`prompt-registry.ts` is a thin registry mapping prompt name → metadata. Its `SystemPromptEntry` interface, in that file, is the source of truth for what an entry may carry and which fields are optional; two exclusivity rules ride it — `clientTools` is mutually exclusive with `usesTools` (see CLIENT-tool mode above), and `adaptiveEffort` is mutually exclusive with `effort` (see Token-saving levers above).

It is the **single source of truth** for each prompt's model / token / tool choices — both `handlers/chat.ts` (agent loop) and `handlers/messages.ts` (system-prompt injection) read text + metadata through `getSystemPrompt(name, env)`. The model is chosen via a **two-layer indirection** (No Hardcoded Config Values): each registry entry carries a provider-agnostic capability **`ModelTier`** — `fast` (latency-sensitive / cheapest — the one-shot `placement` prompt), `balanced` (the multi-modal / JSON reasoners: `proposals`, `visual-verify`, the onboarding batch/review passes, the behavioral/visual/generative probes `probe-cart-wiring` / `probe-style` / `probe-template`), or `frontier` (the most-capable flagship, the **default** tier — the agent-loop chat prompts + `probe-industry`). An entry that omits `tier` gets the `frontier` default. The tier→model **binding** is the ONLY place a concrete model id appears: `wrangler.toml [vars]` (`MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER`), read via `resolveModel(env, tier)` when the entry is resolved. Bumping a model version OR switching provider (Claude → OpenAI / Gemini) is a config-only change — the registry and every prompt stay untouched. All prompt text lives ONLY under `src/prompts/` (there is exactly one prompt location — no second folder anywhere in the repo). The `src/prompts/` **barrel** (`index.ts`) imports each `.md`, re-exports every prompt's FINAL text as a named export, and (via `getSystemPrompt`) is where `resolveModel` maps the entry's tier → model. Each COMPOSED prompt is self-contained in its own folder's `index.ts`, which assembles its `_`-prefixed block fragments + `onboarding-shared/` blocks with `composePrompt` (`_compose.ts`) and default-exports the finished text the barrel re-exports. The registry just does `import * as prompts from './prompts'` (resolving to the barrel), so each registry entry's `prompt:` is `prompts.<name>`.

**Unified single / multi-file / COMPOSED convention.** A prompt is one of three shapes; all resolve to the same registry entry:

- **Simple** → one file: `src/prompts/<name>.md` (e.g. `chat.md`, `placement.md`). Import it and use it as `prompt`.
- **Multi-file** → a folder: `src/prompts/<name>/` (e.g. `image-selection/`), made of parts:
  - `prompt.md` — the main system prompt (re-exported by the barrel).
  - a sample/attachment file (e.g. `sample.md`) — NOT part of the system prompt; re-exported by the barrel and wired as an `attachments` entry `{ content, mimeType, filename }` so `messages.ts` uploads it (Files-API dedup + extended cache) and prepends it to the first message as a document block. Attachments are image-selection-only today.
- **Composed** → a folder of `_`-prefixed BLOCK files, no `prompt.md`, PLUS its own `index.ts` that assembles the system text with `composePrompt(...)` (the helper lives in `src/prompts/_compose.ts`) from an ORDERED mix of per-prompt fragment files in the prompt's own folder (`_intro.md`, `_receive.md`, …) plus SHARED blocks under `src/prompts/onboarding-shared/` (`_shared-*.md` / `_block-*.md` — box vocabulary, the JSON-only hardening lines, the mobile rule, the correction verbs, …) so every composing prompt shares that instruction (edit a block once → all of them update). The composed prompts are the onboarding propose/review pairs (`onboarding-batch` / `-all`, `onboarding-review` / `-all`), the cart-drawer conductors (`cartdrawer-batch-all`, `cartdrawer-review-all`), and `optimize-demand`; which folders are prompts vs shared blocks, and why the `-all` twins are not duplicates, is in [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md). Here a `_`-prefixed `.md` is a BLOCK PART that IS explicitly imported + composed — it just isn't a standalone `<name>` you select via the header. The composed text is pinned byte-for-byte by the byte-equivalence gate (`test/onboarding-prompt-blocks.test.ts`) and its STABLE ORDER is the cacheable system prefix (the `cache_control` 1h breakpoint in `messages.ts`; per-shop screenshots + manifest ride AFTER it — "variable data last"). Per-prompt design/maintenance docs live at `docs/prompts/<name>.md` (process: [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md)).

`image-selection` is the multi-file prompt with an attachment (system text `prompt.md` + the `sample.md` attachment); the composed prompts are the onboarding + cart-drawer + optimize set. Design docs: [docs/prompts/image-selection.md](docs/prompts/image-selection.md), [docs/prompts/onboarding-batch.md](docs/prompts/onboarding-batch.md), [docs/prompts/onboarding-review.md](docs/prompts/onboarding-review.md).

The whole-store proposal owns the initial currency decision. Deterministic currency validation and the
registered `onboarding-currency-recovery` one-shot form a targeted hard gate before common QC.
If the initial proposal omits a valid verdict, the recovery prompt
reuses at most four already-uploaded price tiles and returns exactly one candidate selection or strictly
validated six-argument format before the first QC render. It is a bounded omission recovery, not a
post-QC currency island. Advanced CSS enters the registered `onboarding-css-review` specialist only
when common QC emits `advanced-css-required`; ordinary review-all responses cannot return visual
actions. The currency recovery maintenance contract is
[docs/prompts/onboarding-currency-recovery.md](docs/prompts/onboarding-currency-recovery.md).

`prompt-registry.ts` is the authoritative list of registered prompts. The reading aid over it — every prompt with its shape, endpoint, tools, and role — is [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md) → "Registered prompts", read on demand; the doc-sync rule that keeps the two in step is [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md). No third, partial copy lives anywhere.

### Website-Analysis probes (`probe-<id>`)

A **probe** is a header-selected `POST /messages` system prompt for Website Analysis: it takes storefront evidence (cleaned-HTML documents + screenshot images, uploaded via `POST /files` and referenced as content blocks on the first user message — the same muscle as `image-selection`) and returns **JSON ONLY** per a fixed schema (no tools, no prose). `/messages` needs no per-probe change — it serves any `X-Personalizer-System-Prompt`-selected prompt. The convention lives in `prompt-registry.ts`: every probe registers under a `probe-<id>` name (`PROBE_PREFIX = 'probe-'`, `isProbeName()`), ships its system text at `src/prompts/probe-<id>/prompt.md`, records its frozen output contract in the `PROBE_SCHEMAS` index, and has a maintenance doc at `docs/prompts/probe-<id>.md`. A new probe drops in identically — a new prompt file + registry entry + `PROBE_SCHEMAS` entry + maintenance doc, no handler edit. Which probes exist and what each returns is `PROBE_SCHEMAS` in `prompt-registry.ts`, cross-checked against the registry by `test/probes.test.ts`; the inventory table in [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md) names them with their roles, and each has its own maintenance doc under `docs/prompts/`. Every probe shares one call shape: `POST {base}/messages` with `X-Personalizer-System-Prompt: probe-<id>`, a standard Anthropic messages payload whose first user content is the uploaded evidence blocks, and an assistant text body that parses as that probe's frozen schema.

**Bundler text rule (no runtime fs):** `import x from './prompts/chat.md'` — and nested multi-file imports like `import x from './prompts/image-selection/prompt.md'` — resolve to the file's string contents at BUILD time, in both targets with the SAME import specifier (no `?raw`):

- **Worker** — `[[rules]] type = "Text"` (`globs = ["**/*.md"]`) in `wrangler.toml` makes esbuild emit each `.md` as a text module. The `**/*.md` glob matches nested folders, so multi-file prompts bundle without any config change.
- **Tests** — an inline Vite plugin in `vitest.config.ts` does the same for any `.md` at any depth (`transform` turns `.md` into `export default "<contents>"`).

To add/edit a prompt: create/edit the `.md` file(s) under `src/prompts/` (a single `.md` for a simple prompt, or a `<name>/` folder for a multi-file prompt), add/update its registry entry in `prompt-registry.ts`. If a prompt needs runtime `${}` interpolation it can't be a static `.md` — keep that dynamic bit in JS.

> There is only ONE prompt location: `src/prompts/`. Simple prompts are a single `.md`; advanced/multi-file prompts are a folder (`prompt.md` + a `sample`/attachment file). Per-prompt maintenance docs live under `docs/prompts/`. No stray second prompts directory exists anywhere in the repo.

### Logging

Latency-critical visual `/messages` prompts (onboarding proposal/review, currency recovery,
cart-drawer, optimize, and visual verification) proceed directly to inference instead of awaiting the
advisory `count_tokens` diagnostic. Other large payloads may still use that best-effort estimate; it
never gates correctness.

Application code logs only through the request-scoped `LoggingRuntime` in `lib/logger.ts`. Each
`LOG_TARGETS_<LEVEL>` binding routes that level to `ignore`, `console`, `seq`, or a comma-separated
fan-out; environment names carry no policy. Production routes `error`/`fatal` to private Seq and all
other levels to `ignore`, with Cloudflare application console output disabled. Local configuration
routes every level to both console and Seq. Seq delivery uses `waitUntil`, is fail-open, and accepts
an optional `LOG_SEQ_API_KEY`; the configured shared endpoint supports anonymous CLEF ingestion.

`/messages` and `/chat` emit correlated TRACE records for complete model-visible input, assistant
output, tool execution, usage, status, and elapsed time. File IDs and request context IDs are retained
for correlation. The logger preserves stacks, causes, structured
provider/tool details, and redacts actual secret-bearing fields. `npm run dev` mirrors local console
output to `app-ai-dev.log`; routing TRACE to `ignore` disables inference traces without a code branch.

## Commands

- `npm run dev` — local dev server (`wrangler dev`, port 8787) via the `scripts/dev.mjs` launcher, which resolves `git rev-parse --short HEAD` IN NODE (shell-independent) and passes it as `--define __APP_AI_REV__:"<sha>"` so `/health` reports the REAL served rev as `buildRev` (not `'dev'`). It FAILS LOUD (non-zero exit, never a silent no-define) if git can't resolve a revision, so a stale `buildRev:"dev"` worker can't start green. The launcher mirrors Wrangler stdout/stderr to `app-ai-dev.log` (`APP_AI_DEV_LOG_FILE` overrides the path), making local `[InferenceTrace]` JSON events readable by another process. Local config comes from `.dev.vars` — copy `.dev.vars.example` (its default `ANTHROPIC_API_BASE` already points at the free dev shim below).
- `npm run dev:shim` — the **free dev LLM channel** (`scripts/dev-claude-shim.mjs`, port 8788). Start it, then plain `npm run dev` fulfils every inference via Claude Code — no Anthropic credits. See "Local AI dev — the free Claude-Code channel" below.
- `npm test` — vitest (watch). One-shot: `npx vitest run`.
- `npm run typecheck` — `tsc --noEmit` (strict; must be 0)
- `npm run lint` / `npm run lint:fix` — ESLint over the whole repo (worker TS, tests, `scripts/`, tooling configs)
- `npm run format-check` / `npm run format` — Prettier over the whole repo (exclusions + rationale in `.prettierignore`)
- `npm run deploy:dry-run` — build the revision-stamped bundle without deploying (verifies imports + the Text rule)
- `npm run deploy` — revision-stamped production deploy; this is also the required Cloudflare Workers Builds deploy command
- `npm run deploy:preview` — revision-stamped non-production version upload, when preview builds are enabled
- `npm run tail` — live production logs

## Local AI dev — the free Claude-Code channel (default)

Local dev fulfils Anthropic inference through **Claude Code**, not the paid API, so dev never burns Anthropic credits. This is the standard, permanent local channel.

**How it works.** The worker talks to Anthropic through exactly ONE seam — `src/lib/anthropic.ts`, where every call is `fetch(`${ANTHROPIC_API_BASE}/v1/...`)` and `ANTHROPIC_API_BASE` is read via `anthropicApiBase(env)`. So the whole toggle is one line in `.dev.vars`:

```
ANTHROPIC_API_BASE=http://127.0.0.1:8788
```

`scripts/dev-claude-shim.mjs` (started by `npm run dev:shim`) is a local Anthropic-API-compatible HTTP server on `:8788` that fulfils each request via the `@anthropic-ai/claude-agent-sdk` `query()` — using the machine's Claude Code auth. No `src/` change, no `[env.dev]` block: plain `wrangler dev` reads `.dev.vars`, which overrides the production `[vars]` (`https://api.anthropic.com`). Production is unchanged.

**Run it (two terminals, or shim in the background):**

```
npm run dev:shim     # terminal 1 — the free Claude-Code shim on :8788
npm run dev          # terminal 2 — wrangler dev on :8787, ANTHROPIC_API_BASE → the shim
```

**The FREE-stack worker MUST be started via `npm run dev` (the `scripts/dev.mjs` launcher).** It stamps the served worker with `--define __APP_AI_REV__:"<short HEAD>"`, so `/health` reports the exact rev as `buildRev`. The lib's FREE-stack preflight (`preflightMatrixStack` in `tests/e2e-playwright/studio-ai/fixtures/harness-boot.ts`) always rejects a `'dev'` / absent `buildRev`, AND — under `LS_EXACT_STACK` (the fork-matrix evidence run) — the exact-revision compare fires by default (GAP-A): it compares the served `buildRev` against an EXPECTED rev that **DEFAULTS to the sibling `../app-ai` checkout's frozen HEAD** (`git -C ../app-ai rev-parse --short HEAD`) when `LS_APP_AI_EXPECTED_REV` is unset, so a stale worker at a real short-sha FAILS CLOSED instead of passing green (the env pin overrides the default; `LS_APP_AI_REPO_PATH` points elsewhere; an unresolvable checkout is a hard stop in exact-stack mode). The auto-resolve default is GATED on `LS_EXACT_STACK` — symmetric with the lib asset-hash pin — so a NON-exact-stack caller that doesn't pin the rev stays lenient (a worker legitimately serving an earlier commit than a since-pulled `../app-ai` HEAD is not spuriously rejected). A stale worker would exercise code other than the reviewed checkpoint. See `preflight-fail-closed.spec.ts`. A bare Wrangler launch bypasses the repository stamp and is NOT valid evidence; a define-less production `/health` fails with 503. Before any evidence run, verify the served rev matches HEAD:

```
test "$(curl -s 127.0.0.1:8787/health | jq -r .buildRev)" = "$(git rev-parse --short HEAD)"
```

If it differs, the worker was launched without the define — restart it via `npm run dev`. Production and preview deploys use `npm run deploy` / `npm run deploy:preview`; both stamp the exact checked-out revision and refuse to run when Git cannot resolve it.

**What the shim implements** (exactly the surface the worker calls):

- `POST /v1/messages` non-stream — the probes / `createMessage` path. Accepts content blocks incl. `image` + `document` (`source:{type:'file',file_id}`) + a `system` array; translates to a `query()` call; returns one Anthropic body `{ content:[{type:'text',text}], usage, stop_reason }`. A wrapping `code fence` is stripped so JSON-only probes/proposals parse cleanly.
- `POST /v1/messages` `stream:true` SSE — the `/chat` `runAgentLoop` path. Maps the SDK's assistant text to `text_delta` frames and synthesizes the full Anthropic envelope (`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta{stop_reason}` / `message_stop`) that `src/handlers/chat.ts` parses.
- `POST /v1/files`, `GET /v1/files/{id}`, `DELETE /v1/files/{id}` — an in-memory temp store keyed by a generated `file_id`, remembering mime (image vs document); rehydrated into the `query()` user turn as inline base64 at message time.
- `POST /v1/messages/count_tokens` — `{ input_tokens }` (char/4 estimate; advisory).
- **Tool-use bridge** for the `/chat` tool loop: each personalizer tool (`get_store_analytics` / `list_segments` / `list_campaigns` / `get_store_config`) is registered as an in-process `createSdkMcpServer()` tool whose handler makes the SAME Personalizer `v2/ai-tools/*` call the worker's personalizer toolset makes. The SDK resolves the loop; the shim emits the equivalent `tool_use` frames (bare tool name, harness built-ins filtered out). Enable it by setting `LS_DEV_CONTEXT_ID` (a dev store's context-ID) — the worker's Anthropic seam does not forward the context-ID to Anthropic, so the shim needs it out of band. Without it, tool flows run tool-free (fall back to the real API only if you deliberately switch channels).

**Using the real, paid API from local (rarely — prod-only by policy)** requires TWO deliberate steps: set `ANTHROPIC_API_BASE=https://api.anthropic.com` AND `AI_CHANNEL=prod`. The **cred-burn guard** (`test/dev-shim.test.ts` → `assertDevAiChannel`) FAILS any dev/test config that points at `api.anthropic.com` without `AI_CHANNEL=prod`, so a credit-spending default can never slip in silently. `scripts/dev-claude-shim.mjs` and its guard/translation layer are dev-only — never bundled, never run in production.

## Tests (`test/`)

What each spec covers is [docs/TESTING.md](docs/TESTING.md) → "What each spec covers", read on demand; the layer doctrine (which layer a new case belongs in) is in the same document. The rules that bind every spec here:

- Tests mock `fetch` and `env` — no real network, no credentials.
- Never weaken an assertion to pass, and never skip on a missing precondition — throw with an actionable message instead (docs/CODE-PATTERNS.md → No Silent Skips).
- The frozen artifacts — the composed prompt baselines and the tool-definition snapshot under `test/__snapshots__/` — are contract pins: regenerating one is a contract change, reviewed as such.

An optional **live token-savings diagnostic** (`scripts/verify-caching.mjs`, `npm run verify:caching`) runs against the DEPLOYED worker. It needs a master context-ID + a reachable target, so it is OUT of `vitest run`. When explicitly invoked, it asserts `cache_read_input_tokens > 0` on a repeat call for the chat tools+system prefix and the placement file-block prefix, and throws loudly (never silently skips) on a 0-read regression or missing creds. It is not a release gate. See [docs/TESTING.md](docs/TESTING.md).

## CI + deploy

- **CI** (`.github/workflows/ci.yml`) runs on every push + PR using the repository's `.node-version` (Node 22, the minimum supported by the pinned Wrangler): `npm run lint` → `npm run format-check` → `npm run typecheck` → `npx vitest run` → `npm run deploy:dry-run`. Workers Builds reads the same `.node-version`, so CI and Cloudflare cannot silently drift onto different Node majors. All five gates must be green. The dry run goes through the same revision-stamping launcher as production. `lint` and `format-check` run over the WHOLE repo (`eslint .` / `prettier --check .`) — worker TS, tests, `scripts/verify-caching.mjs` (Node globals), tooling configs, and every `.md`/`.yml`/`.json`. The only prettier exclusions are byte-frozen contract artifacts, each with its rationale in `.prettierignore`: the prompt text under `src/prompts/` (shipped byte-for-byte) and the tool-schema snapshot in `test/__snapshots__/`.
- **Caching diagnostic workflow** (`.github/workflows/verify-caching.yml`) is an optional `workflow_dispatch` job guarded on the `APP_AI_CONTEXT_ID` + `APP_AI_TARGET` repo secrets. The guard step exits cleanly when either secret is absent, so it never fails a fork or unconfigured repo, and it is never wired into the required push/PR `build` job. It may also be run manually with `npm run verify:caching` and explicit `APP_AI_TARGET` + `APP_AI_CONTEXT_ID`/`APP_AI_CONTEXT_FILE`; the script takes no defaults.
- **Deploy** is automatic from `main` via Cloudflare's GitHub integration — **pushing `main` deploys to production**, so that push is an operator action with its own deploy approval and never an agent's (Hard rules below). Workers Builds leaves Build command blank and sets Deploy command to `npm run deploy`; if non-production builds are enabled, their command is `npm run deploy:preview`. Cloudflare stores these commands in Dashboard → Worker `app-ai` → Settings → Build; Wrangler configuration cannot encode them. `npm run deploy:dry-run` builds the same stamped bundle without deploying. A production `/health` without a hexadecimal Git revision fails closed with 503.
- **Tooling baseline:** strict TypeScript (`tsconfig.json`) + ESLint flat config with typescript-eslint (`eslint.config.js`) + Prettier (`prettier.config.cjs`) + `.editorconfig`. No production npm dependencies; dev-only `wrangler`, `vitest`, `typescript`, `typescript-eslint`, `eslint`, `prettier`.

## Automated PR review loop

Pull requests here get an automated bot reviewer, and every pull request is driven to clean before it
is considered ready. The loop that does it — trigger, poll, triage each comment as solve or reject,
reply to every comment, resolve every addressed thread, re-run the repo's gates, re-trigger, repeat —
lives once in the workspace's shared agent skill `../.agents/skills/limespot-pr-review-handle/SKILL.md`,
along with what counts as terminal. This repository restates none of it and adds only what is specific
to it:

- **The gate set a round must clear before re-triggering** is this repository's five commands, listed
  under CI + deploy above, all green.
- **A bot's claim is verified against the code before it is accepted.** A rejection is grounded in
  `file:line` or a runnable proof, never in disagreement alone; a comment raising a genuine product
  decision goes to the owner rather than being guessed.
- **Nothing in the loop escalates its own approval.** Commit, push, force-push, and pull-request
  mutation are separate authorizations, each named by the operator in the turn it is used
  (`../_standards/git-and-approval.md`); a force-push uses `--force-with-lease`, never bare `--force`.
  `main` is read-only regardless — see Hard rules below.

## Hard rules

- **The live surface is a stable external contract.** `/files`, `/messages` (image-selection), context validation, CORS, and cache_control serve production. Their routes, request/response shapes, headers, and status codes must stay identical.
- **Brain is the source of truth** for the `/v2/ai-tools/*` request/response shapes (`toolsets/personalizer/index.ts`), the per-record admin endpoints consumed by `toolsets/personalizer/entity-context.ts` (`Controllers/V2/DiscountCampaignsController.cs`, `Controllers/V2/HtmlCampaignsController.cs`, `Controllers/V1/ImageCampaignsController.cs`, `Controllers/V1/SubscriberSegmentController.cs`, `Controllers/V2/ProgressBarCampaignsController.cs`, `Controllers/V2/AccountsController.cs` → `subscriber`), and the `/v2/administrator-authentication/validate-context-id` shape (`auth.ts`). Mirror Brain's C# exactly — verify routes, query params, and fields against the sibling `brain` repo (`Controllers/V2/AiToolsController.cs` `[Route("v2/ai-tools")]` → `store-analytics` / `segments` / `campaigns` / `store-config`; `AdministratorAuthenticationController.cs` → `validate-context-id`). Brain serializes PascalCase with enums as strings and null members omitted (`NullValueHandling.Ignore`) — `entity-context.ts` mirrors that omission. Brain also owns the AI integration-bridge wire contract consumed by `toolsets/integration-bridge.ts` (`v2/integration-bridge/{platform}/rest/{path}` + `/graphql` + `/gaql` routes, the `{ Query, Variables }` / `{ Query, PageSize }` request models, the `X-Personalizer-Integration-Bridge-Token` caller header, and the `X-Ls-Integration-Bridge-Error` discrimination header). Never invent, narrow, or rename a field in `toolsets/` / `auth.ts`; never assume the shape from the sibling app TS, which can be stale.
- **One error shape — Brain's wire format — status mapped from the failure.** Every error response is structurally identical to a Brain error (`{ "Message": ..., "ExceptionType": ..., "MessageDetail": ... }`, flat PascalCase, `MessageDetail` omitted when absent), built by `errorResponse`/`errorPayload` in `lib/responses.ts`, so clients keep ONE error parser for both backends. SSE `error` events carry the same payload. Status + `ExceptionType` mirror Brain's mappings: missing context-ID → 401 `MissingContextIDException`; a Personalizer rejection of the validate call relays Personalizer's status + body UNCHANGED; client input validation → 400 `ArgumentException`; unknown route → 404 `RecordNotFoundException`; non-ok Anthropic responses keep Anthropic's status with `AnthropicApiException` + the raw upstream body in `MessageDetail` (a 500 `/files` upload also appends the beta-access hint); everything else → 500 `Exception` via the router's `errorResponseFrom` catch. Handlers do not invent per-route error envelopes. See [docs/DECISIONS.md](docs/DECISIONS.md) #7.
- Prompt `.md` text must match the intended prompt byte-for-byte.
- No new production npm dependencies (the worker bundle stays dependency-free); dev tooling only when a gate needs it.
- **No Hardcoded Config Values** (Tech / Constraints above) — URLs and deploy-time tunables live in wrangler `[vars]` / `.dev.vars` behind `src/config.ts`; missing config throws; no inline fallbacks. Fitness-tested.
- **`main` is read-only to every agent, and a push to it IS a production deploy.** Cloudflare's GitHub integration deploys `main` on push, so that one action carries both the push approval and the deploy approval, named separately, and only an operator performs it. An agent prepares work on a feature branch and never commits on, merges into, pushes to, force-pushes, resets, rebases onto, or enables a pull-request merge targeting `main` (`../_standards/git-and-approval.md`). Committing locally on a feature branch is its own separate approval.
- **Access to the running worker is read-only.** `wrangler tail`, `/health`, and the deployed diagnostics are for inspection; an agent never runs `npm run deploy`, `wrangler deploy`, a secret write, or any other command that mutates the live worker, its bindings, or its secrets. Those flow from a committed change an operator deploys.
- **No AI-attribution in commit messages.** A commit message contains NO `Co-Authored-By: Claude …` / `Claude-Session:` trailer, no "Generated with …" line, and no mention of Claude / Anthropic / any AI assistant as an author or contributor — the subject + body describe the change, nothing else. Mirrored in [CONTRIBUTING.md](CONTRIBUTING.md) → Commit message convention.
