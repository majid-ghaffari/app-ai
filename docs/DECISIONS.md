# Decisions — app-ai

**Parent:** [../CLAUDE.md](../CLAUDE.md)

Architectural decisions for the worker, with rationale. Present-tense — each
entry describes the choice that stands and why, not a change history. An entry's
NUMBER is its stable identifier, cited from other documents as `DECISIONS.md #N`;
numbers are never reused and never renumbered. A decision that changes is rewritten
in its own entry rather than tombstoned beside a replacement — git history holds the
supersession, this log holds what stands.

### 2. GA 1-hour prompt cache on stable prefixes

Stable, reused prefixes carry canonical `cache: 'extended'` intents that the
Anthropic adapter realizes as `cache_control: { type: 'ephemeral', ttl: '1h' }`:
the `/messages` system
block + reused file attachments, the `/chat` `buildSystem` base block, and the
placement file-block prefix. `/messages` callers identify the terminal stable
user-content prefix with `limespot_stable_cache_prefix: true`; the worker turns
that internal marker into a priority 1h breakpoint within the four-slot budget,
strips the marker before forwarding, and leaves the content/file-ID sequence
unchanged. Any client-supplied breakpoint outside the proxy-owned attachment prefix
is stripped before allocation, so text or later-message markers cannot silently exceed
Anthropic's global four-breakpoint cap. Later volatile round content can miss its own ranked breakpoint without
invalidating the earlier stable-prefix entry. The 1h TTL is GA — no beta header. A 1h write costs
2× base input and reads cost 0.1×, so it breaks even at ≥3 reuses; the cached
prefixes (system prompt, per-page screenshot/HTML) are reused far more often
than that across a session. Volatile per-call content (the `/chat` context
block, conversation turns) is left uncached or on the 5-minute default.

### 3. Effort lever is model-gated

Semantic effort is a real output-token control, but Anthropic's
`output_config.effort` is valid only on a specific model set.
`EFFORT_SUPPORTED_MODELS` in `inference/adapters/anthropic-wire.ts` is that set —
the only place it is written down — and `supportsEffort(model)` is the gate over it.
Sending the parameter to a model outside the set returns a 400. The registry owns
semantic effort and the adapter gates on the resolved model, so a registry entry can
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

### 5. KV dedup is a graceful no-op, with expiry-bounded TTL and an existence check

The Files API does not dedup by content — re-uploading identical bytes mints a
fresh `file_id`. `lib/file-dedup.ts` hashes the bytes (SHA-256) and, when
`env.FILES_KV` is bound, reuses the stored `file_id` only on the same tenant +
provider account + file-policy + compatible-group + hash route. Four
decisions:

- **Best-effort optimization only.** Missing or unavailable KV reads/writes fall
  back to a direct provider upload. Prompt-aware public references are sealed,
  self-contained metadata and never depend on KV visibility for resolution.
- **Expiry-bounded record TTL.** `KV_RECORD_TTL_SECONDS` caps retention at 30
  days; when the provider supplies an earlier expiry, both dedup and opaque
  metadata expire first. A transient metadata failure propagates instead of
  fabricating a non-expiring object.
- **Route-scoped keys.** Identical bytes uploaded for another tenant, provider
  account, file policy, or compatible prompt group have a separate mapping, so
  multi-route upload cannot overwrite or reuse an incompatible opaque vendor
  object.
- **Live existence check.** On a KV hit the cached `file_id` is verified against
  the Files API metadata endpoint before reuse; a 404 drops the stale record and
  re-uploads, so dedup never vends a dead `file_id` that would 400 a later
  `/chat` request.

### 6. Single-`main` auto-deploy

There is one branch. Cloudflare's GitHub integration auto-deploys `main` to
production, so **pushing `main` is a production deploy**. There is no staging
environment and no manual deploy step in the normal flow. Commit locally;
docs/test-only changes are deploy-safe, but any push is live. Workers Builds
leaves its build command blank, sets its deploy command to `npm run deploy`, and
uses `npm run deploy:preview` when previews are enabled. Those dashboard-owned settings cannot
be encoded in Wrangler configuration. `npm run deploy:dry-run` builds the same
revision-stamped bundle (verifying imports + the Text rule) without deploying.
Production health fails with 503 when a raw, define-less build bypasses the
launcher, so an unattributable worker cannot report healthy.

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
  response (`/messages`, `/files` upload/delete, the `/chat` agent loop).
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
  ≤4: 1 system + 1 file-prefix + ≤2 conversation
  (`applyCanonicalConversationBreakpoints` drops its cap to 2 when a file prefix
  is present, and reserves the file-prefix head blocks so they aren't stripped
  or recounted).
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
per backend, each encapsulating its canonical tool definitions, its
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

### 11. Strict TypeScript, no build step

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
`tsc` is the type-checker only. `npm run deploy:dry-run` verifies the
bundle. Standards: [CODE-PATTERNS.md](CODE-PATTERNS.md) → Strict TypeScript.

### 12. No Hardcoded Config Values — and where the config/code line sits

Every URL and deploy-time tunable lives in configuration behind the single
typed `Env` in `src/config.ts`: `PERSONALIZER_API_URL`, `ANTHROPIC_API_BASE`,
`OPENAI_API_BASE`, `GEMINI_API_BASE`, `CREDENTIALED_ORIGINS`, and the capability-tier→model bindings `MODEL_FAST` /
`MODEL_BALANCED` / `MODEL_FRONTIER` in wrangler.toml `[vars]` (production) /
`.dev.vars` (local; documented in the committed `.dev.vars.example`), and the
provider API keys plus `TOKEN_ENCRYPTION_SECRET` and the Personalizer integration token
in Cloudflare encrypted secrets / `.dev.vars`. **A missing variable throws, naming the variable and
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
allowlist. The available-party set rides
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
guards it; no tiebreak logic exists. Which party gates which toolset is each
toolset descriptor's own `integrationParties` declaration, and nowhere else.

The `google-ads` GAQL tool also gained an optional `pageToken` input, threaded
to the wire body as `PageToken` (`{ Query, PageSize?, PageToken? }`); the
response `NextPageToken` surfaces verbatim in the platform body, so the model
pages by echoing it back. Additive and backward-compatible.

### 15. `/messages` sets `max_tokens` from the registry EXACTLY

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
The box fallbacks (Upsell → Related Items; FBT → Cross-Sell) are not
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

### 18. Onboarding effort matches payload and recovery scope

The four `onboarding-batch{,-all}` and `onboarding-review{,-all}` routes run on
Sonnet 5 with registry-owned effort policy; Studio does not send or know about
effort. Per-page propose/review uses `effort: 'low'` to reserve the bounded output
budget for JSON. Whole-store proposal uses `effort: 'medium'`. Whole-store review uses the
registry's adaptive low fast path and medium recovery path; currency and advanced CSS are targeted
hard gates rather than common-review reasoning. The 8192-token review budget remains a truncation
ceiling, while the compact schema keeps the ordinary response far below it.

### 19. Logging policy is level-routed configuration, with one request runtime

Worker application code emits structured records through one request-scoped `LoggingRuntime`.
The router establishes request ID, route, method, and validated subscriber context;
handlers and shared helpers derive scoped loggers from that immutable runtime. Each severity has a
required `LOG_TARGETS_<LEVEL>` binding whose value is `ignore` or a comma-separated fan-out to
registered sinks. Environment names do not select behavior.

Production routes ignore trace/debug and send info/warn/error/fatal to private Seq, with Cloudflare
application console output disabled. This retains successful QC latency/token telemetry and
`max_tokens` warnings durably. Local configuration sends every level to both console and Seq. Seq
CLEF delivery is asynchronous through `waitUntil`, fail-open, and optionally
authenticated with the `LOG_SEQ_API_KEY` secret; the configured shared endpoint accepts anonymous
ingestion. A rejected background task is caught and emitted through the same runtime.

Diagnostic records retain errors, stacks, causes, diagnostic provider text, tool decisions, and
request state. The serializer redacts credential-bearing fields (API keys,
authorization/cookies/passwords, service tokens, and context IDs), while the inference-trace
boundary also removes opaque file references, encoded media, and provider continuation state before
any sink receives the record. The inference trace is a TRACE producer, not an environment branch,
so it follows the same routing contract as every code-level record.

### 20. Relocation is its own review verb (`moveBox`), never a remove + add pair

The onboarding and cart-drawer review prompts emit four correction verbs: `styleBox`, `removeBox`,
`addBox`, and `moveBox`. `moveBox` is the ONLY correct way to re-place a box that is already on the
page/drawer; `addBox` is reserved for a box the surface does not yet have.

**Why this exists.** The lib is the authority on which verbs it can apply, and it accepts all four:
`CorrectionAction` and the `CORRECTION_ACTIONS` allow-list carry `moveBox`; `sanitizeCorrection`
normalizes and validates its args (`boxType` → `box`, a `PLACEMENT_METHOD_VALUES` position, an
`anchorNumber` within `[1, MAX_ANCHOR_NUMBER]`); and both apply paths implement it —
`applyCorrectionsToPlan` rewrites the plan entry's `position`/`anchorNumber`, and `applyCorrection`
rewrites `PlacementSibling`/`PlacementMethod` from the anchor map. The lib unit-tests it
(`ai-batch-output.test.ts`) and states the contract in `ai-batch-runner.ts`: existing boxes are
styled with `styleBox` or relocated with `moveBox`.

A prompt that omits `moveBox` therefore has no way to express a relocation. The remove + add pair
that looks like a substitute is not a move, so lib rejects both halves atomically. It also drops an
`addBox` naming a box already present in the applied plan and keys cross-round `addBox`/`removeBox`
history for the same box into one `presence:<box>` slot so a later reversal is rejected. These are
load-bearing non-destructive/anti-oscillation guards; the explicit verb is the only supported way to
relocate an existing box.

**Contract.** `moveBox` args are `{ page?, boxType, position, anchorNumber }` (`page` on the
onboarding review prompts; omitted for the single-surface drawer). It carries no appearance keys —
relocation never restyles, so a look fix is a separate `styleBox`. The prompts state the
never-remove-and-re-add rule explicitly, because the failure it prevents is invisible to the model.

**Scope.** Worker prompt text: `onboarding-shared/_shared-correction-verbs.md` (shared verb-count
preamble) plus the per-prompt `_correction-verbs-detail.md`, `_classify-tail.md`, and
`_output-and-rules.md` fragments of `onboarding-review`, `onboarding-review-all`, and
`cartdrawer-review-all`, with the two affected `test/__snapshots__` baselines regenerated. Lib owns
the paired atomic guard and the four-verb validation/application runtime. A model that never emits
`moveBox` produces byte-identical worker behavior to a three-verb prompt, so the worker change is a
strict superset.

### 21. Holistic QC uses adaptive effort and targeted specialist gates

`onboarding-review-all` runs on the registry-owned balanced model at low effort by default. Lib sends
content-free attempt metadata and sets the escalation flag only for incomplete page coverage,
parse/schema failure, `max_tokens`, explicit uncertainty/escalation, or failed quality invariants;
the registry maps an escalated request to medium effort. Lib never selects the provider, model, or
effort value.

The common-path schema is compact: required page verdicts and human feedback, optional closed issue
codes, plus `needsEscalation`. Retry results replace verdicts by page key so corrections are
idempotent. Deterministic currency validation/recovery remains a hard pre-QC gate.
`advanced-css-required` routes only the affected pages to the medium-effort
`onboarding-css-review` specialist, whose managed selectors remain component/page scoped. Common
review responses cannot apply currency or CSS actions.

Every attempt produces content-free structured telemetry for model/prompt/effort, total latency,
token/cache usage, stop reason, evidence counts, revision/pass, attempt kind, and lib capture/upload
spans. The operational SLO and release-eval contract live in `docs/QC-OBSERVABILITY.md`.

### 22. Extension demos use key-separated JWTs and strongly consistent state

The extension demo is an alternate auth path for stores without a LimeSpot Context-ID. A website
activation assertion is signed with a website/app-ai shared key, consumed once, and exchanged for an
app-ai-only `ls_demo_…` session signed with a distinct key. Public assertions name one exact store
origin; only a signed, email-verified `@limespot.com` staff entitlement can choose another store.
The extension background worker supplies its validated active-tab origin because MV3 request Origin
is the extension, not the storefront. Exact claims and sender responsibilities are frozen in
[DEMO-AUTH.md](DEMO-AUTH.md).

Cloudflare KV is not used for activation consumption, quotas, file ownership, or attempt counting: it
is eventually consistent, has no compare-and-swap operation, and loses concurrent read-modify-write
updates when the onboarding conductor uploads many screenshot tiles in parallel.
`DemoSessionAuthority` is one deterministically addressed Durable Object per signed stable
`auditIdentifier`. It consumes activation identifiers, permits one live session, atomically reserves
paid work, owns provider file IDs, and preserves the public two-completion count across expired
sessions and reissued links. Failed inference releases the attempt number; only successful proposal
inference consumes it. Demo scope remains four onboarding upload destinations and two proposal
inference prompts; the server forces registry model/budget/effort and never calls Brain.

Per-session byte/upload/message ceilings are app-ai's paid-work guard. Cross-session activation,
identity/IP, daily-budget, and kill-switch controls belong to the limespot.com issuer, with provider
hard spending controls outside it. App-ai HMAC-signs immutable `started`/`failed`/`completed` events
with a third, purpose-specific secret and retries them from an ordered Durable Object outbox; website
D1 is an idempotent operational mirror, while app-ai remains the attempt enforcement authority. The
Durable Object binding and first migration are part of `wrangler.toml`, while all signing keys remain
encrypted secrets.

### 23. Onboarding QC uses a fast gate and failed-page detailed escalation

The common QC path sends bounded first/middle/last evidence for every dirty page to the fast-tier
`onboarding-review-gate-all` prompt. Pages that pass cleanly complete without balanced-model work.
Failed, uncertain, malformed, and uncovered pages enter the correction-capable
`onboarding-review-all` prompt in independent chunks of two with full evidence and history. A
complete, invariant-valid detailed JSON response remains usable when its provider stop reason is
`max_tokens`; response completeness, rather than the stop label alone, determines recovery.

### 24. Brain data tools require a versioned identity capability

The context-validation response is the per-request authority for the four Brain-backed data tools.
app-ai accepts `AvailableAiTools` only when `AiToolsContractVersion` equals the
`SUPPORTED_AI_TOOLS_CONTRACT_VERSION` owned by `src/lib/auth.ts`, and composes only exact known tool
names from that array. Missing, malformed, and unsupported versions grant no data tools. Brain still
re-authorizes every proxied call; the advertised set narrows the model-visible surface to what that
identity can use.

`get_entity_context` remains independent because it is not part of Brain's versioned AI-tool route
catalog: record references use existing administrator endpoints, and analytics references resolve
from request grounding. An unadvertised data-tool call degrades to `Unknown tool` before credential
resolution or network dispatch.

Successful data-tool responses must carry the required PascalCase members of Brain's wire models.
Malformed successes, non-success envelopes, and transport exceptions retain diagnostic detail only
in operational logs and become generic model-visible failures. Raw upstream bodies never enter a
tool result.

The rejected alternatives are treating tool-name presence as sufficient without a version,
composing all known tools and relying on downstream authorization failures, coupling
`get_entity_context` to a catalog that does not own it, and returning upstream diagnostic bodies to
the model.

### 25. Prompt groups own provider routes and direct-file compatibility

`src/prompt-registry.ts` owns the internal resolution chain: prompt name →
prompt group → capability tier → configured model id, with the provider, API
family, capabilities, and direct-file policy following from that model id
(decision 30). Every prompt entry has one required `group`; the 13 groups and
eleven file-reusing fallback edges are typed registry data. Module
initialization and `test/prompt-groups.test.ts` reject orphan groups, feature
requirements a group does not declare, a borrowed file route that is itself
borrowed, and a file-reusing fallback crossing file routes; route resolution
additionally rejects a model whose capabilities miss the group's requirements
and a file policy incompatible with the resolved API family. This keeps
provider and model authority inside app-ai; callers name prompt contracts
only.

`src/lib/inference-types.ts` is the canonical provider-neutral contract for
content, requests, tools, streams, results, usage, errors, continuation state,
model capabilities, and file references. Canonical tools retain full JSON
Schema, and agent requests are a server/client discriminated union so a
browser-owned tool cannot enter the server executor path. The public file reference is opaque;
provider/account/upstream identifiers exist only in an internal reference.
The frozen prompt-aware file contract uses one `file` multipart part plus one
or more repeated `prompt` string parts. Every success has one shape: `{ id, type }`
plus a prompt-addressable `references` map naming every declared prompt, with the
top-level reference representing the first declared prompt. Destinations sharing a
route share the reference minted for it, so an upload resolving to a single route
names every declared prompt against that one value rather than omitting the map —
one parse path for the caller, whatever the route count.
`test/__snapshots__/prompt-aware-files.contract.json` is byte-checked, and the lib
holds a byte-identical copy, so the two repositories move it together.
The `/files` handler validates every repeated `prompt` field, resolves prompt → group → profile/provider/account/file
policy after multipart parsing and before provider I/O, collapses same-route
destinations, and starts distinct route uploads concurrently. It returns random
`file_ref_v1_*` tokens carrying authenticated encrypted route metadata under
`TOKEN_ENCRYPTION_SECRET`, bound to a keyed tenant pseudonym: the validated context ID for a merchant, and
the demo session identifier for a scoped demo session, which carries no context ID
and therefore uploads into a namespace of its own.
Self-contained tokens avoid Workers KV's eventual-consistency window in the
immediate upload→inference flow; `FILES_KV` is best-effort dedup only. File bytes
are sent directly to each provider and never retained by app-ai. Inference
recursively resolves public tokens to internal provider references and validates
tenant, provider, account, policy, API family, expiry, and compatible group
before adapter I/O. Registered/canonical inference rejects raw provider IDs, and
the bounded absent/unknown-selector `/messages` passthrough refuses any
`source.type === 'file'` block with 400 `ArgumentException` and replaces the
caller's `model` and `max_tokens` with the registry's unregistered route (the
`fast` tier binding, which must resolve to the Anthropic Messages family, and a
fixed output budget), so no path forwards a raw provider id or a caller-chosen
cost. The worker-first deployment order and the paired rollback this
contract imposes on app-ai and Studio are a hard rule in the root
[CLAUDE.md](../CLAUDE.md) → Hard rules.

The direct-upload path sends provider bytes to every resolved vendor
route without production byte retention, and evidence reuse is valid only
inside a compatible prompt group. The alternatives — a second registry,
model-prefix provider inference, caller-supplied provider/profile fields, and
intermediary blob storage — split authority or add an avoidable custody
boundary, so they are excluded.

### 26. One canonical runtime owns inference; adapters own provider protocols

`src/inference/service.ts` implements `complete`, `stream`, and the shared
server/client/no-tool agent loop using only the canonical types in
`src/lib/inference-types.ts`. The loop preserves opaque provider continuation
state, applies canonical cache intents between turns, executes only server-owned
tools, and returns browser-owned calls without executing them.

When a browser-owned tool pauses `/chat`, the terminal payload includes an
opaque `continuation` token alongside `toolCalls`. An adapter can also mark state
as required after an ordinary terminal turn (Gemini thought signatures), in which
case `/chat` and registered `/messages` return the same sealed token. The client
echoes that token with its matching next request. The worker rejects
malformed, tampered, expired, cross-tenant, cross-group, cross-profile, or
cross-provider tokens before provider I/O. Tokens are authenticated encrypted
envelopes bound to the server-resolved route; only the owning adapter interprets
the decoded provider state. This preserves signed Anthropic thinking blocks and
provider-native continuation handles without allowing stored provider state to
cross an app-ai ownership boundary.

`src/inference/factory.ts` is the only provider/API-family switch. Provider
authentication, HTTP, wire types, file operations, request serialization,
stream parsing, effort/structured-output/cache realization, token estimates,
usage/stops, and normalized errors live under `src/inference/adapters/`. Both
registered `/messages` and `/chat` use the canonical service. Absent/unknown
`/messages` selectors retain a bounded raw Anthropic compatibility path inside
the Anthropic adapter so the external envelope stays unchanged.

The configured tier bindings resolve every group to Anthropic. The adapter
fixture matrix and architecture fitness tests pin the boundary, so another
provider is a configuration change rather than a change to the seam.

The canonical custom-tool contract preserves strict execution and current
provider-neutral controls while provider-hosted tools carry adapter-owned opaque
definitions. Anthropic compatibility accepts content-backed documents as either
strings or text/image-block arrays, preserves citation and service-tier controls,
strips cache markers only from cache-capable block positions before canonical
allocation, validates message and file success envelopes fail-closed, and
normalizes `output_tokens_details.thinking_tokens` as reasoning usage. Ordinary
assistant history receives opaque provider state only at the Anthropic
compatibility boundary; selecting another provider never fabricates
provider-owned continuation state.

### 27. OpenAI uses Responses with stored opaque continuation, without changing production routes

The production-capable OpenAI adapter uses dependency-free Web `fetch` against the
Responses and Files APIs. Canonical instructions/messages, image and file
inputs, strict function tools, `text.format` JSON Schema, semantic reasoning
effort, typed SSE events, usage, stops, and failures are translated and
validated only under `src/inference/adapters/`. Tool results retain their
`call_id`; visual tool results may carry input images/files. Successful turns
return adapter-owned `previous_response_id` state, which the shared runtime and
browser continuation contract carry opaquely. The initial stable system input
and its explicit cache boundary remain in stored response state; a continuation
therefore sends only input after the referenced assistant turn.
The public envelope is authenticated and tenant/group/profile-bound before
`previous_response_id` can reach the shared OpenAI project. Registered
`/messages` results without an Anthropic raw envelope are serialized from the
canonical result into the existing public message shape.
Provider-hosted OpenAI tools remain fail-closed until their provider-specific
output Items are explicitly modeled; this candidate currently owns custom
server/client function tools only.

The OpenAI Files policy is `provider-managed` with purpose `user_data`.
Upload/retrieve/delete success envelopes are shape-checked, and file IDs
remain sealed behind the same tenant/account/policy/group-bound public
references when a prompt group is eventually routed there. The adapter factory
can select `openai/openai-responses` for internal tests, but every production
prompt group remains on Anthropic until prompt-level quality/latency/cost
evaluations are recorded. Candidate-route fitness checks reject provider/file
policy and capability mismatches before a group can select OpenAI.
Best-effort dedup metadata retains validated upload MIME because OpenAI File
objects omit MIME; a reused image therefore remains an image on later turns.

Canonical prompt-cache intent is realized through Responses explicit
`prompt_cache_breakpoint` markers on the supported text/image/file content
blocks, a group/profile-stable `prompt_cache_key`, and request-wide explicit
`30m` policy. The adapter rejects more than four writable markers before
provider I/O. Because OpenAI currently offers only the `30m` explicit TTL,
canonical `short` and `extended` preserve the requested stable-prefix boundary
but share that provider retention policy.

The optional `npm run verify:openai` matrix is paid and refuses to run unless
both `OPENAI_LIVE_SMOKE=1` and `AI_CHANNEL=prod` are explicit. It is not a CI or
release gate; the adapter's contract is held offline by the deterministic
fixtures in `test/openai-adapter.test.ts` and the guard in
`test/openai-live-guard.test.ts`.

### 28. Local inference uses one Claude Code/Codex fulfiller boundary

The development-only Anthropic-compatible shim selects a canonical local
one-shot fulfiller through `LOCAL_AI_FULFILLER`. Claude Code remains the default
and retains the established streaming, server-tool, and browser-tool bridge.
Codex is deliberately narrower: it requires an explicit `CODEX_LOCAL_MODEL` and
accepts only non-streaming, tool-free visual/structured turns. It runs
`codex exec` ephemerally with inherited AGENTS/project instruction bytes set to
zero, ignored user configuration/rules, a read-only sandbox,
disabled shell/web/plugin/subagent/app-connector/dependency-install tools, image files, an optional JSON Schema output
contract, strict terminal JSONL events, and request cancellation. Saved auth is
forced to ChatGPT by default; `CODEX_API_KEY` requires `AI_CHANNEL=prod`. The
child receives only an allowlisted runtime/auth environment, so app/provider
secrets never reach model-invoked processes. Unsupported content or capability
fails before process spawn, cancellation waits for child exit with bounded
SIGKILL escalation, and temporary schema/image/result artifacts are removed in
a `finally` path. The invocation follows the current official
[Codex non-interactive](https://developers.openai.com/codex/noninteractive),
[CLI reference](https://developers.openai.com/codex/cli/reference), and
[configuration reference](https://developers.openai.com/codex/config-reference).

The production Worker remains dependency-free and unchanged by this Node-only
tooling. Outside production, provider-base accessors reject non-loopback Anthropic,
OpenAI, and Gemini origins unless `AI_CHANNEL=prod` is explicit. Offline tests
mock the Codex process boundary and never invoke Codex or a paid provider.

### 29. The configured model id decides the provider

A prompt group declares the capability TIER it runs on and the capabilities it
requires. It names no provider, no API family, and no file policy. Those follow
from the model id configured for its tier, resolved by the model catalog in
`src/inference/model-catalog.ts`.

The split is between what a DEPLOYMENT chose and what a model IS. Which model a
tier runs is a deployment choice, so model ids stay in `wrangler.toml [vars]`
(`MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER`, plus the sparse
`MODEL_OVERRIDES` exceptions). Which vendor serves a model, over which API
family, with which capabilities and direct-file policy, is a fact about the
model, so it lives in code. Configuration that carried facts would let a
deployment assert a capability the model does not have.

The catalog matches by model-id FAMILY PREFIX, following the same routing
principle as Brain's `ModelProviders`/`ModelClientRouter`, and not by exact id:
an exact-id table silently drops a newly released version out of its family,
and an effort gate keyed by exact id drops `output_config.effort` on every
version bump. app-ai needs more than a provider
name from that match, because a profile also carries capabilities and a file
policy, so each family resolves the whole profile at once.

An id no family claims THROWS at resolution, naming the id and the variable
that supplied it. There is no default provider to fall through to: guessing one
is how a credential, a file route, and a tenant's evidence reach the wrong
vendor. Every resolution is then validated — capabilities against the group's
declared requirements, file policy against the resolved API family, and a
per-prompt override against its group's shared provider file route — so a
settings-level provider switch fails closed instead of degrading.

`GET /prompts` reports the resolved end of that chain per prompt under the live
configuration, master-gated by `MASTER_SUBSCRIBER_ID` and answering every other
validated merchant with the router's unknown-route body byte for byte. It also
names the required secrets that are still blank, by name only.

### 30. Gemini carries thought signatures in sealed continuation state

The dormant Gemini adapter uses dependency-free Web `fetch` against
`generateContent`, authenticating with `x-goog-api-key` rather than a bearer
token, with the API version carried as a path segment inside `GEMINI_API_BASE`.
It serves the `gemini-3` family only — the generation with a documented
`thinkingLevel`, a documented `functionCall.id`, and mandatory thought
signatures — and refuses every other id, including the image, speech, audio,
embedding, live, and transcription models that publish other generation methods.

`thoughtSignature` is the adapter's defining constraint. It is a part-level
sibling of `functionCall`, present only on the FIRST call part of a parallel
batch, and Gemini 3 rejects a replayed call part that has lost it. The adapter
therefore stores the exact `role:"model"` content it received in opaque
`backend: 'gemini'` provider state, replays it verbatim, and declares
`requiresOrdinaryTurnContinuation`, so the signature crosses the public HTTP
boundary of a browser client-tool round trip. A response whose first function
call carries no signature, and a replay whose signature was stripped, both fail
before provider I/O rather than becoming a provider 400 mid-loop.

Three seams are implemented to documented behaviour and marked unverified in
code, because official pages disagree or are silent. Structured output sends the
normative REST reference's flat `responseMimeType`/`responseSchema`; the
structured-output guide's nested `responseFormat.text` wrapper is the rejected
alternative. Streaming publishes no terminal sentinel, so a clean close after a
chunk carrying a finish reason IS the success condition and a close without one
is a truncation failure. The error envelope is parsed defensively for both a
lowercase string `code` and the classic integer `code` plus uppercase `status`,
and 429 is split so a transient rate limit retries while an exhausted quota does
not.

Gemini has no cache breakpoints, so canonical cache intents map to no request
field and capability declarations claim no canonical prompt caching; implicit
caching still rewards the existing stable-prefix ordering discipline. Gemini
counts a cache hit inside `promptTokenCount`, the opposite of Anthropic's
disjoint accounting, and the mapping site says so. Strict structured output and
strict tool schemas are refused because Gemini's parameters are an OpenAPI
subset with a syntactic guarantee only. Files use the documented two-call
resumable protocol; the provider-returned upload endpoint is validated against
the configured origin before it is used, the reconstructed `fileUri` is pinned
against the one the provider returned, and a non-active file is polled to a
terminal state rather than referenced. The optional `npm run verify:gemini`
probe matrix is paid, requires both `GEMINI_LIVE_SMOKE=1` and `AI_CHANNEL=prod`,
and is outside CI/release gates.

### 31. Gemini's shared output budget is split explicitly, and an invisible turn fails

A canonical `maxOutputTokens` means the budget for the ANSWER. That is what a
prompt group sizes, what `/messages` echoes back as `maxTokens`, and what
`test/max-tokens-exact.test.ts` pins as passing through untouched. Anthropic's
`max_tokens` bounds exactly that. Gemini's `maxOutputTokens` does not: it is ONE
budget covering thinking tokens and the answer together.

Forwarding the canonical number unchanged therefore hands a prompt a smaller
answer for no reason other than which provider served it, and a small budget can
be consumed entirely by thoughts — HTTP 200, `finishReason: MAX_TOKENS`, and
nothing but `thought: true` parts. The Gemini adapter instead sends the canonical
answer budget PLUS a thinking allowance, so the canonical meaning survives the
translation.

The allowance is chosen per THINKING LEVEL rather than pinned as a token count,
because Gemini 3 exposes thinking as the qualitative `thinkingLevel` and offers
no numeric split to fix. The level is consequently always sent — a request that
declares no effort resolves to `high`, the most expensive level the model could
otherwise pick — so the reserved share is a declared translation rather than a
guess at a provider default. Unused output tokens are not billed, so a generous
allowance costs nothing on a turn that thinks less than it reserves.

The budget alone cannot make starvation impossible, so the second half of the
decision is that it must never be silent. A terminal turn carrying neither
visible text nor a tool call leaves the adapter as an `InferenceFailure`
(`empty_response`, `invalid-response`) naming the provider's finish reason,
through the same path as every other normalized adapter failure. An empty
success is indistinguishable downstream from a model that legitimately said
nothing, and it reaches a caller as a valid response with no content and nothing
in the logs to explain it. A prompt-level block keeps its `content-filter` stop
reason: that is a rejected request, not an invisible answer.

The paid probe matrix carries the same correction. Every probe budgets thinking
alongside its answer, a probe whose turn is starved anyway reports the distinct
`starved` outcome instead of failing the contract, and the catalog probe runs
first and fails by name when the configured smoke model is not one this API
surface serves — a well-formed id that does not exist costs no inference to
discover.

### 32. Gemini caches implicitly, so cache intent is honoured by order

`inlineCacheBreakpoints` is a capability about a MECHANISM: whether a provider
honours per-block cache markers on a request. Anthropic and OpenAI do; Gemini
does not. Naming it after the mechanism matters because a name that reads as
"can cache at all" is false — Gemini caches a repeated request PREFIX
automatically, above a size floor, with no request field and no API call.

Because it reads as a cost characteristic rather than a correctness one, no
prompt group requires it. Requiring the mechanism made a provider that caches by
another route unroutable, which is a routing defect and not a safety property: a
group needs caching to be affordable, not to be correct. Groups still require
what they cannot work without — vision, provider files, streaming, structured
output, tools, reasoning — and `GET /prompts` reports, per prompt, whether the
resolved model honours the markers its canonical request carries, so an operator
can see which prompts pay for reuse by another route.

The Gemini adapter earns that other route deliberately. Implicit caching rewards
a prefix that repeats byte for byte, so a canonical cache intent is honoured by
ORDER instead of by a field: every component that repeats across calls of one
prompt — system instruction, tool declarations, tool config, generation config —
is emitted before `contents`, and the canonical block order inside `contents` is
preserved exactly, because that is where the handlers already place reusable
evidence first and per-call content last. Nothing in that prefix may vary per
request, which is pinned by an adapter test asserting that two requests sharing a
prompt produce byte-identical leading request bytes and diverge only at the
per-call text.

The explicit `cachedContents` named-cache resource is a separate lifecycle with
its own creation, TTL, and deletion, and no adapter owns it.
