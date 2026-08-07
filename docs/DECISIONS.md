# Decisions — app-ai

**Parent:** [../CLAUDE.md](../CLAUDE.md)

Architectural decisions for the worker, with rationale. Present-tense — each
entry describes the choice that stands and why, not a change history.

### 1. Strict TypeScript — see #11.

The strict-TypeScript decision is recorded at [#11](#11-strict-typescript-no-build-step-supersedes-1).

### 2. GA 1-hour prompt cache on stable prefixes

Stable, reused prefixes carry `cache_control: { type: 'ephemeral', ttl: '1h' }`
(`EXTENDED_CACHE_CONTROL` in `lib/cache-control.ts`): the `/messages` system
block + reused file attachments, the `/chat` `buildSystem` base block, and the
placement file-block prefix. The 1h TTL is GA — no beta header. A 1h write costs
2× base input and reads cost 0.1×, so it breaks even at ≥3 reuses; the cached
prefixes (system prompt, per-page screenshot/HTML) are reused far more often
than that across a session. Volatile per-call content (the `/chat` context
block, conversation turns) is left uncached or on the 5-minute default.

### 3. Effort lever is model-gated

`output_config.effort` is a real output-token control, but it is valid only on a
specific model set (`supportsEffort` in `lib/anthropic.ts`: Fable 5, Opus
4.8/4.7/4.6/4.5, Sonnet 4.6). Sending it to a model that doesn't support it
(e.g. Haiku 4.5, Sonnet 4.5) returns a 400. The handlers gate on the resolved
model's capability and omit `output_config` otherwise, so a registry entry can
carry `effort` without risking a 400 on a model swap. Placement runs on Haiku
4.5, so it carries no `effort` — the guard would drop it regardless, and setting
it would be dead config.

### 4. No-filesystem `.md` text bundling

Prompt text lives in one `.md` file per prompt under `src/prompts/`; the
barrel (`src/prompts/index.ts`) imports each as a string (composing the
multi-block prompts) and the registry (`prompt-registry.ts`) reads its text
through that barrel. Workers have no runtime
filesystem, so the text is bundled at BUILD time, identically in both targets
with the same import specifier (no `?raw` suffix):

- **Worker** — the `[[rules]] type = "Text"` rule in `wrangler.toml` makes
  esbuild emit each `.md` as a text module.
- **Tests** — an inline Vite plugin in `vitest.config.ts` does the same
  (`transform` turns `.md` into `export default "<contents>"`).

This keeps prompt wording out of JS (pure text, byte-for-byte) while staying
filesystem-free. A prompt needing runtime `${}` interpolation can't be a static
`.md` — that dynamic piece stays in JS.

### 5. KV dedup is a graceful no-op, with a 30-day TTL and an existence check

The Files API does not dedup by content — re-uploading identical bytes mints a
fresh `file_id`. `lib/file-dedup.ts` hashes the bytes (SHA-256) and, when
`env.FILES_KV` is bound, reuses the stored `file_id` on a hash hit. Three
decisions:

- **Graceful no-op.** When the binding is absent, dedup falls back to a plain
  upload — the live path never depends on KV being provisioned.
- **30-day record TTL** (`KV_RECORD_TTL_SECONDS`). Files persist until explicitly
  deleted, so the record TTL is deliberately shorter than a file's lifetime: a
  mapping that outlives common churn (key rotation, manual cleanup) ages out on
  its own, and the TTL also bounds KV growth.
- **Live existence check.** On a KV hit the cached `file_id` is verified against
  the Files API metadata endpoint before reuse; a 404 drops the stale record and
  re-uploads, so dedup never vends a dead `file_id` that would 400 a later
  `/chat` request.

### 6. Single-`main` auto-deploy

There is one branch. Cloudflare's GitHub integration auto-deploys `main` to
production, so **pushing `main` is a production deploy**. There is no staging
environment and no manual deploy step in the normal flow. Commit locally;
docs/test-only changes are deploy-safe, but any push is live. `npx wrangler
deploy --dry-run` builds the bundle (verifying imports + the Text rule) without
deploying.

### 7. Brain's wire error shape, status mapped from the failure

Every error response is structurally identical to a Brain error — the flat
PascalCase shape Brain's `GlobalExceptionHandlerMiddleware` serializes, with
`MessageDetail` omitted when absent (Brain's `NullValueHandling.Ignore`):

```json
{ "Message": "...", "ExceptionType": "...", "MessageDetail": "..." }
```

built by `errorResponse` / `errorPayload` in `lib/responses.ts`. Clients
therefore keep ONE error parser for both backends — there is no app-ai-specific
error format to support. SSE `error` events carry the same
`{ Message, ExceptionType, MessageDetail? }` payload as their `data`.

Status + `ExceptionType` mapping, mirroring Brain's names where an analog
exists:

- **401 `MissingContextIDException`** — the router's auth gate when the
  `X-Personalizer-Context-ID` header is absent (`Message: 'Missing Context
ID.'`, Brain's exact analog).
- **Brain rejection → relayed unchanged.** When Brain answers the
  validate-context-id call with a non-2xx, its status AND body pass through
  verbatim (`WorkerError.passthroughBody`) — the client sees exactly what Brain
  said (e.g. its own 401 `InvalidContextIDException`).
- **500 `BrainUnreachableException`** — the validate fetch itself fails.
- **400 `ArgumentException`** — client input validation (invalid JSON body,
  empty `messages`, missing upload file), mirroring Brain's
  `ArgumentException → BadRequest` mapping.
- **404 `RecordNotFoundException`** — unknown route
  (`Message: 'Resource not found.'`, Brain's exact mapping).
- **`AnthropicApiException`, upstream status kept** — a non-ok Anthropic
  response (`/messages`, `/files` list/delete/upload, the `/chat` agent loop).
  `Message` is Anthropic's `error.message`; the raw upstream body rides in
  `MessageDetail`. A 500 upload failure also appends the Files-API-beta-access
  hint to `Message`.
- **500 `Exception`** — everything else (the router's catch-all via
  `errorResponseFrom`).

The single shape and this mapping are a stated contract — handlers do not
invent per-route error envelopes.

### 8. Placement system prompt is left uncached on Haiku — by design

The placement system prompt (~370 tokens) is well under Haiku 4.5's minimum
cacheable prefix. A `cache_control` marker on it would be a silent no-op, and
padding it to clear the floor would cost more than it saves. The placement
caching win is the file blocks (thousands of tokens — they dwarf the system
prompt), not the system prompt. `buildSystem` still attaches the 1h marker to
the base block because chat/onboarding share that path and DO clear the floor
via `TOOL_DEFINITIONS`; on placement the marker is harmless (the API ignores an
unmet prefix) but genuinely inert.

### 9. File-block dedup + cache design

The placement flow uploads a screenshot + cleaned HTML via `/files`, referenced
as `fileIds` in `/chat`. Two cooperating mechanisms keep the cost down:

- **Cache.** `normalizeMessages` prepends the file blocks to the first user turn
  and marks the LAST file block with the 1h breakpoint, so the whole file prefix
  caches at 0.1× on the repeat call (prefix match). The breakpoint budget stays
  ≤4: 1 system + 1 file-prefix + ≤2 conversation (`applyConversationBreakpoints`
  drops its cap to 2 when a file prefix is present, and reserves the file-prefix
  head blocks so they aren't stripped or recounted).
- **Dedup.** Same-page reuse maps to the same `file_id` via the `/files`
  content-hash dedup, so the same bytes hit the same cache entry across calls.
- **Block typing.** Each `fileId` is resolved to an `image` block (mime
  `image/*`) or a `document` block by its Files API metadata. Images MUST be
  `image` blocks — Anthropic 400s an image inside a `document` block, which is
  exactly the placement screenshot. A metadata-lookup failure falls back to
  `document`.

This can be measured live with the optional token-savings diagnostic (see
[TESTING.md](TESTING.md)).

### 10. AI tools live in named toolsets behind a registry

The AI-tool layer is organized as named TOOLSETS (`src/toolsets/<name>/`), one
per backend, each encapsulating its Anthropic tool definitions, its
dispatch/executors, its normalizers, and its degrade conventions. A registry
(`src/toolsets/registry.ts`) composes the active toolsets per request from the
subscriber's available integration parties (#14); handlers consume tools only
through the composition, so adding a toolset never edits handler logic. Each toolset
resolves its own backend credentials through a per-request seam
(`resolveCredentials`) under fixed security standards: per-request,
subscriber-scoped, never model-visible, never logged. The registered toolsets
are `personalizer` (backend = the Personalizer API; credentials = the
forwarded context-ID) and the four platform toolsets (`shopify`,
`bigcommerce`, `klaviyo`, `google-ads` — backend = Personalizer's integration bridge;
credentials = the call channel, #13). The model-visible tool contract (names, input
schemas, output shapes) is frozen regardless of module layout — pinned by the
lib repo's `admin/ai/CONTRACTS.md` §2 and the contract snapshot in
`test/toolsets.test.ts`. Full standards: [TOOLSETS.md](TOOLSETS.md).

### 11. Strict TypeScript, no build step (supersedes #1)

The whole repo — `src/`, `test/`, `vitest.config.ts` — is strict TypeScript:
`tsconfig.json` declares the full strict family plus the beyond-strict
correctness flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `verbatimModuleSyntax`), mirroring the lib repo's Studio
admin tsconfig adapted for a Worker. The type system carries the seams the
worker's guarantees hang on: the toolset registry interfaces
(`src/toolsets/types.ts`), the credential-resolution seam, the tool schemas,
the Brain wire models (the `{ Message, ExceptionType, MessageDetail? }` error
envelope, the entity-context shapes), and the single typed `Env`
(`src/config.ts`). `any` and `@ts-*` suppression comments are banned
(ESLint-enforced); `npm run typecheck` (`tsc --noEmit`) is a required gate.
There is still NO build step and no new production dependency: wrangler/esbuild
transpiles TypeScript natively at deploy time and vitest/vite at test time —
`tsc` is the type-checker only. `npx wrangler deploy --dry-run` verifies the
bundle. Standards: [CODE-PATTERNS.md](CODE-PATTERNS.md) → Strict TypeScript.

### 12. No Hardcoded Config Values — and where the config/code line sits

Every URL and deploy-time tunable lives in configuration behind the single
typed `Env` in `src/config.ts`: `PERSONALIZER_API_URL`, `ANTHROPIC_API_BASE`,
`CREDENTIALED_ORIGINS`, and the capability-tier→model bindings `MODEL_FAST` /
`MODEL_BALANCED` / `MODEL_FRONTIER` in wrangler.toml `[vars]` (production) /
`.dev.vars` (local; documented in the committed `.dev.vars.example`), and the
`CLAUDE_API_KEY` secret in Cloudflare encrypted secrets / `.dev.vars`. **A missing variable throws, naming the variable and
its channel — there are no fallback defaults**, because a fallback silently
turns a deployment mistake into wrong routing (a worker quietly talking to the
wrong Personalizer is worse than a loud 500). The classification line: frozen
contracts and protocol facts stay in code (wire field names, tool names,
routes, prompt text, Anthropic's 4-breakpoint limit + `1h` TTL, the
cross-repo-frozen `MAX_ITERATIONS`/`MAX_CHAT_REFS`), as do internal
robustness/observability constants whose doc comments state that
classification (the dedup KV TTL, the count_tokens warn threshold). The rule
is fitness-tested (`test/architecture.test.ts`: no absolute URLs in src or
scripts/ outside the config module, no inline `||`/`??` fallbacks on `env` /
`process.env` reads, accessor-only worker reads — the Node scripts take
explicit required environment variables) and the production values are pinned
by tests that read wrangler.toml
itself (`test/config.test.ts`). Full rule: [CODE-PATTERNS.md](CODE-PATTERNS.md)
→ "No Hardcoded Config Values".

### 13. Platform toolsets hold a call channel, never a platform token

The `shopify` / `bigcommerce` / `klaviyo` / `google-ads` toolsets give the
model transparent passthrough access to the merchant's platform APIs (reads
and writes), but the worker never touches a platform credential. Every tool
call goes to Personalizer's integration bridge (`v2/integration-bridge/*` on the main
API), which validates the caller, resolves the merchant, and relays the call
under the merchant's own installed-integration token — Personalizer is the sole
credential custodian. What `resolveCredentials` resolves
(`src/toolsets/integration-bridge.ts`) is a CALL CHANNEL: the Personalizer base URL, the
merchant's context-ID (`X-Personalizer-Context-ID`, the tenant), and the
`PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` Workers Secret (`X-Personalizer-Integration-Bridge-Token`, the
caller — read only through the `personalizerIntegrationBridgeToken` accessor in
`src/config.ts`; never a `wrangler.toml` var, never logged, never
model-visible). Either header alone is insufficient by design. The rejected
alternative — per-subscriber platform tokens shared from Personalizer's
`SubscriberIntegrationConfig` into the worker — would have made app-ai a
second credential holder; the call channel keeps exactly one custodian.

The proxy is a pure bridge — no path/method allowlists, no GraphQL operation
gate. The behavioral boundary is the tool descriptions (write-caution
language) plus the merchant token's own OAuth scopes. Error handling follows
the frozen cross-repo discrimination rule: the `X-Ls-Integration-Bridge-Error` response
header separates the two voices. Absent → the platform speaking, verbatim —
the executor surfaces `{ platformStatus, headers?, body }` to the model as
`ok: true` DATA at any status, so a platform 4xx/5xx is actionable feedback
the model self-corrects on, in the platform's own error language (`headers`,
lowercased keys, is the whitelisted out-of-band subset — `Link` for Shopify
REST `page_info` cursors, `Retry-After`, the platform rate-limit headers —
omitted when none are present). Present → a LimeSpot layer produced the
`{ Message, ExceptionType, MessageDetail }` envelope — the call degrades to
the standard `{ ok: false }` shape carrying `<Message> (<ExceptionType>)`, so
the model can tell a malformed request (rephrase) from a configuration
failure (stop retrying, tell the merchant).

Which subscribers see the platform toolsets is decided by their available
integration parties (#14) — each toolset's `integrationParties` gate, not any
endpoint allowlist.

### 14. Dynamic per-subscriber toolset composition, keyed off `IntegrationParty`

Toolset composition is data-driven off a single identity — `IntegrationParty`
(a verbatim mirror of Personalizer's C# enum, `src/toolsets/integration-party.ts`;
the wire form is the enum NAME, never its guid). Each descriptor declares an
`integrationParties: IntegrationParty[]` gate; a toolset is offered iff the
array is empty (always-active, e.g. personalizer) OR intersects the
subscriber's available parties — no mapping, no switch, no static endpoint
allowlist (supersedes the allowlist half of #10). The available-party set rides
the router's per-request `validate-context-id` call, which returns
`AvailableIntegrationParties: string[]` (liveness-filtered by Personalizer); the
router threads that result into `handleChat`
(`availableParties`). No new call, no new cache — the parties are exactly as
fresh as the auth gate the router already makes (a mid-session-enabled
integration appears on the very next chat request, modulo Personalizer's own
~5-min connection-status cache for the revocable OAuth/key parties).

The executor builds the integration-bridge URL party segment from the MATCHED
party — the intersection of the toolset's `integrationParties` with the
subscriber's set (`v2/integration-bridge/{IntegrationPartyName}/…`, matching
Personalizer's dispatch key). A subscriber has at most ONE commerce party
(Shopify/BigCommerce/Woo mutually exclusive) and each non-commerce party owns
its own toolset, so the intersection is always exactly one — a defensive assert
guards it; no tiebreak logic exists. v1 gates: `shopify` →
`ShopifyPersonalizer`, `bigcommerce` → `BigCommercePersonalizer`, `klaviyo` →
`Klaviyo`, `google-ads` → `Google`.

The `google-ads` GAQL tool also gained an optional `pageToken` input, threaded
to the wire body as `PageToken` (`{ Query, PageSize?, PageToken? }`); the
response `NextPageToken` surfaces verbatim in the platform body, so the model
pages by echoing it back. Additive and backward-compatible.

### 15. `/messages` sets `max_tokens` from the registry EXACTLY (D6)

`POST /messages` sets `max_tokens` to the resolved system-prompt entry's value
EXACTLY, mirroring how it derives `model` (#11 / the registry as source of truth).
`applyRegistryMaxTokens` runs between `applyRegistryModel` and
`manageCacheControl`: `max_tokens = entry.maxTokens`, UNCONDITIONALLY. There is no
floor, no cap, and no client-`max_tokens` read — a client-sent budget is
OVERRIDDEN, so changing a registry `maxTokens` literal changes the outgoing
Anthropic request one-for-one (proven per route by `test/max-tokens-exact.test.ts`

- the EXACT block in `test/proxy.test.ts`). The `/chat` path is exact too
  (`entry.maxTokens`, `chat.ts`) — a registered prompt owns its budget. An omitted
  budget is otherwise an Anthropic 400 (the field is required), so this also makes
  the registry-governed one-shot transport (a lib client that sends only the prompt
  NAME + ephemeral data, no token budget) legal. A request with no system prompt, or
  an unknown prompt name, is untouched — the caller owns its own budget, as it does
  its own model. The registry is fully authoritative: there is no client
  override or `max(client, entry)` floor.

**Cross-repo deploy ordering (HARD): this app-ai change must deploy BEFORE the
lib stops sending `max_tokens`.** Once the lib omits the field, an app-ai
deployment WITHOUT `applyRegistryMaxTokens` would forward a body with no
`max_tokens` and Anthropic would 400. Land + deploy this first, then the paired
lib change.

### 16. Brain defaults are FETCHED + projected + injected by app-ai (never serialized by the lib)

The PROPOSE prompts (onboarding / cart-drawer / optimize — the entries flagged
`injectsBrainDefaults`) benefit from knowing the store's DEFAULT box settings
(per-box fallback method, style, image dimensions, image right-margin,
add-to-cart title, items limit). Rather than have Studio serialize those into a
transport field, app-ai FETCHES them server-side: `lib/brain-defaults.ts` calls
the same authenticated Brain endpoint the toolsets use
(`GET ${PERSONALIZER_API_URL}/v1/personalizerConfig?defaultRecommendationsSettings=true`,
forwarding the `X-Personalizer-Context-ID`), behind a config seam
(`recommendationsDefaultsUrl`) so it can later point at the platform's CDN-hosted
object without touching the orchestration. It then DETERMINISTICALLY PROJECTS only
the AI-relevant per-box fields, preserving the PAGE -> BOX hierarchy and computing
the SAME effective appearance inheritance Studio does — the global
`BoxOptions.AppearanceOptions` (desktop) + `AppearanceOptionsMobile` UNDER each
per-page/per-box `AppearanceOptions` (per-box wins) — into a COMPACT, byte-STABLE
canonical JSON (`{ pages: { <Page>: { <BoxType>: { … } } } }`, sorted page + box
keys, fixed field order, absent fields omitted). Scoping per page means a
same-typed box on two pages keeps its own settings (Product FBT = bundle, Cart
FBT = carousel — no cross-leak), and identical global defaults produce identical
bytes for every store so Anthropic's prompt cache HITS cross-tenant. The block is
INJECTED as a SECOND cacheable system block (its own `cache_control` breakpoint)
AFTER the stable system prompt and BEFORE the per-store screenshots (which stay in
the user message, after the breakpoint). `manageCacheControl` counts the actual
cached system blocks (2) so the ≤4 budget stays correct.

**Caching.** One in-isolate promise/result caches the GLOBAL projected block for
all tenants and coalesces concurrent cold requests. A successful value remains the
isolate's last-known-good block; a cold fetch failure or non-ok status produces NO
injection and stays retryable, so the propose request NEVER fails on defaults. No
ETag, conditional request, content hash, defaults-version prompt binding, or
response-header handshake exists. On the propose path (`/messages`, no grounding
field) the defaults reach the model purely through this server-side fetch+inject —
there is NO new lib transport field. The cache stores only global projected data
(never tenant data); the context-ID authenticates the Brain fetch and is never
logged or stored.

### 17. Onboarding ruleset-version handshake (app-ai validates, lib sends)

The onboarding PLAYBOOK is split across two repos: app-ai encodes the advisory
framing in the prompts, the lib enforces the one deterministic mechanic. Today
the ONLY enforced-deterministically-after-proposal rule is the Cart-page progress
bar forced to the top (the lib's `rules.json` ships that ONE signed invariant).
The box fallbacks (Upsell → Related Items; FBT → Cross-Sell) are NO LONGER
lib-enforced rules — they are BRAIN SOFT DEFAULTS (seeded from the tenant's Brain
default box settings and overridable by a valid AI value); the prompts frame them
as advisory guidance only. If the two repos drift (a lib built against an older
playbook talks to a newer app-ai, or vice versa) the QC review tolerances no
longer match what the lib actually renders.

A single version string, `ONBOARDING_RULESET_VERSION = 'limespot-onboarding-playbook-v2'`,
is the seam. It is embedded VERBATIM as the FIRST LINE of
`onboarding-shared/_block-fixed-rules.md` (composed into the four onboarding
prompts' STABLE cached prefix — no new cache breakpoint; per-shop evidence still
rides AFTER the breakpoint in the first user message) AND set on those four
entries' `rulesetVersion`. A unit test pins the registry constant equal to the
block's first line. The lib holds the equal string and sends it as the
`X-Personalizer-Ruleset-Version` header on onboarding `/messages` calls;
`validateRulesetVersion` compares and, on mismatch, throws a 409
`RulesetVersionMismatchException` (Brain envelope naming BOTH versions) before
inference. Bump the string whenever the enforced-rule set changes.

The handshake also covers the THREE sibling playbook conductors that reuse the
same shared onboarding blocks (box-placement / guidance / box-vocab /
correction-verbs): `cartdrawer-batch-all`, `cartdrawer-review-all`, and
`optimize-demand` each carry `rulesetVersion` too. They do NOT compose
`_block-fixed-rules.md` (so the string is not embedded in their prompt text) —
for them the version is a pure playbook-contract identifier: a lib built against
a stale cart-drawer / optimize playbook is rejected the same way. Only the four
onboarding prompts have the block-first-line pin.

**Rollout — fail-OPEN interim default (Risk R1):** an ABSENT header SKIPS the
check, so this deploys before every lib caller sends the header. Once the lib
ships the header everywhere it can tighten to fail-closed (reject a missing
header). Prompts without a `rulesetVersion` (probes / chat / image-selection)
never participate.

### 18. Onboarding propose/review JSON uses low effort

The four `onboarding-batch{,-all}` and `onboarding-review{,-all}` routes run on
Sonnet 5 and explicitly set `effort: 'low'`. A production replay
of the 21-image whole-store request showed Sonnet 5's default adaptive thinking
consume the complete output budget, return `stop_reason: max_tokens`, and produce
no JSON text; Studio then had to fall back to per-page calls. The same payload at
low effort completed with JSON text inside the budget. This is registry-owned
worker policy: Studio does not send or know about effort. The per-page paths use
the same setting because retained production logs showed the review fallback also
consume its complete 2048-token output budget.
