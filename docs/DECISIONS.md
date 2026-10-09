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

### 5. Uploaded files expire, and KV dedup reuses one only while a full reference fits

The Files API does not dedup by content — re-uploading identical bytes mints a
fresh `file_id`. `lib/file-dedup.ts` hashes the bytes (SHA-256) and, when
`env.FILES_KV` is bound, reuses the stored `file_id` only on the same tenant +
provider account + file-policy + compatible-group + hash route. Six
decisions:

- **Every Anthropic upload expires in 30 days.** The `anthropic-provider-files`
  policy requests a 30-day lifetime (`requestedLifetimeSeconds` in
  `inference/model-catalog.ts`), the adapter sends it as `expires_in_seconds` on
  every upload, and Anthropic deletes the file at its `expires_at`, so nothing
  app-ai uploads there outlives 30 days without a timer, a sweep, or an operator.
  Files API calls send no beta flag, because `files-api-2025-04-14` hides
  `expires_at`; the adapter reads the expiry Anthropic answers into the reference
  and the dedup record, and refuses an upload answered without a usable one
  rather than keep a file that never expires. Anthropic offers no upload purpose
  or metadata to tag a file with, and its files are workspace-wide, so the expiry
  is the one retention control that names only app-ai's own uploads.
- **Reuse only while a full reference fits.** A reference lasts at most 15 days
  (`MAX_REFERENCE_TTL_SECONDS`), and Studio's screen cache keeps one for 14. Under
  a policy that requests a lifetime, a dedup hit is reused only while its file has
  at least 15 days left; a file with less, an expired one, or one with no expiry
  is uploaded afresh and its record replaced. The old file is left to expire,
  because references minted from it may still be read. Every reference therefore
  runs its full 15 days and ends before its file, and no file is handed out after
  its first 15 days. A Grader run reads its tiles only inside the run — its batch,
  per-page fallback, repairs and a resumed "Try again" reuse references minted in
  that run — the Grader chat and a replayed `messageId` read no file, and a Studio
  screen cache yields after 14 days, so none of them needs a file past the
  reference it holds. A policy that leaves retention to its provider (the dormant
  OpenAI, Moonshot, Kimi and Gemini routes) keeps reusing until expiry, because
  app-ai cannot promise those files a 15-day remainder.
- **An upload without a usable expiry is never kept.** An upload whose answered
  `expires_at` is missing, unreadable, or shorter than a full reference lifetime
  is deleted and refused, so no reference outlives its file and nothing stays
  untracked. A delete that fails twice keeps the id under its own key,
  `discard:<dedup key>:<file id>` in `FILES_KV` — a record only app-ai writes —
  and the next upload of the same bytes on the same route lists those keys,
  deletes each file, and then its key; a Grader session's own keys go with its
  uploads when the session ends
  ([A Grader session's uploads go when it ends](#38-a-grader-sessions-uploads-go-when-it-ends-and-its-audits-record-a-session-lifetime-later)). Each key is written alone, never read and
  rewritten, so concurrent failures and a failed read cannot lose an id. It has no
  expiry: it is the only proof of ownership of a file that may never expire, so a
  TTL would forget the file while the file stays.
- **Only files app-ai recorded are its to delete.** Files uploaded before uploads
  expired carry no expiry and stay until deleted. The Anthropic workspace is
  shared by every key with access to it, and an upload carries no owner mark, so
  a file's age proves nothing about who uploaded it; only an id `FILES_KV`
  recorded, or a `discard:` record, is proven app-ai's. Deleting those files is a
  one-off operator step, kept out of the repository, and safe only once no
  reference can name one: 15 days after the deploy, since no hit reuses a file
  with no expiry.
- **Best-effort optimization only.** Missing or unavailable KV reads/writes fall
  back to a direct provider upload. Prompt-aware public references are sealed,
  self-contained metadata and never depend on KV visibility for resolution.
- **Expiry-bounded record TTL.** `KV_RECORD_TTL_SECONDS` caps retention at 30
  days, and the provider's expiry shortens it, so a dedup record and the opaque
  metadata never outlive their file. A transient metadata failure propagates
  instead of fabricating a non-expiring object.
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
  `MessageDetail`.
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
`OPENAI_API_BASE`, `MOONSHOT_API_BASE`, `KIMI_API_BASE`,
`KIMI_EVIDENCE_MAX_BYTES` / `KIMI_EVIDENCE_MAX_TOTAL_BYTES` / `KIMI_EVIDENCE_MAX_TEXT_BYTES`, `GEMINI_API_BASE`,
`CREDENTIALED_ORIGINS`, and the capability-tier→model bindings `MODEL_FAST` /
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
robustness/observability constants this log classifies that way (the dedup KV
TTL, the count_tokens warn threshold). The rule is fitness-tested (`test/architecture.test.ts`: no absolute URLs in src or
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

### 22. Extension audits use key-separated JWTs and strongly consistent state

The extension audit is an alternate auth path for stores without a LimeSpot Context-ID. A website
activation assertion is signed with a website/app-ai shared key, consumed once, and exchanged for an
app-ai-only `ls_audit_…` session signed with a distinct key. Public assertions name one exact store
origin; only a signed, email-verified `@limespot.com` staff entitlement can choose another store.
The extension background worker supplies its validated active-tab origin because MV3 request Origin
is the extension, not the storefront. Exact claims and sender responsibilities are frozen in
[AUDIT-AUTH.md](AUDIT-AUTH.md).

Cloudflare KV is not used for activation consumption, quotas, file ownership, or attempt counting: it
is eventually consistent, has no compare-and-swap operation, and loses concurrent read-modify-write
updates when the onboarding conductor uploads many screenshot tiles in parallel.
`AuditSessionAuthority` is one deterministically addressed Durable Object per signed stable
`auditIdentifier`. It consumes activation identifiers, permits one live session, atomically reserves
paid work, owns provider file IDs, and preserves the public two-completion count across expired
sessions and reissued links. Failed inference releases the attempt number; only a run's first
proposal inference that returned a usable proposal consumes it. Audit scope remains five onboarding upload destinations
and two proposal inference prompts; the server forces registry model/budget/effort and never calls
Brain.

An abuse ceiling derived from the grader plan, the runs a session may start, and per-request
size limits are app-ai's paid-work guard (decision 33). Cross-session activation,
identity/IP, daily-budget, and kill-switch controls belong to the limespot.com issuer, with provider
hard spending controls outside it. App-ai HMAC-signs immutable `started`/`failed`/`completed` events
with a third, purpose-specific secret and retries them from an ordered Durable Object outbox; website
D1 is an idempotent operational mirror, while app-ai remains the attempt enforcement authority. The
website owns its routing table, so the callback destination is a required `statusCallbackUrl` claim
on the activation rather than app-ai configuration; app-ai keeps the decision of where a callback may
go as the `AUDIT_STATUS_ORIGINS` allowlist, and stores the validated URL on the session because a
run outlives the token that named it. The
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
the audit session identifier for a scoped audit session, which carries no context ID
and therefore uploads into a namespace of its own.
Self-contained tokens avoid Workers KV's eventual-consistency window in the
immediate upload→inference flow; `FILES_KV` is best-effort dedup only. A
provider-managed policy sends bytes directly to its provider. A worker-managed
policy stores encrypted bytes in private R2 for the lifetime of the reference.
Inference
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

Evidence reuse is valid only inside a compatible prompt group. Provider-managed
and worker-managed objects share the same sealed public reference contract; the
policy decides which side owns storage. A second registry, caller-supplied
provider/profile fields, and provider inference outside the model catalog remain
excluded because they split routing authority.

### 26. One canonical runtime owns inference; adapters own provider protocols

`src/inference/service.ts` implements `complete`, `stream`, and the shared
server/client/no-tool agent loop using only the canonical types in
`src/lib/inference-types.ts`. The loop preserves opaque provider continuation
state, applies canonical cache intents between turns, executes only server-owned
tools, and returns browser-owned calls without executing them.

When a browser-owned tool pauses `/chat`, the terminal payload includes an
opaque `continuation` token alongside `toolCalls`. An adapter can also mark state
as required after an ordinary terminal turn, as Gemini does for thought
signatures, in which
case `/chat` and registered `/messages` return the same sealed token. The client
echoes that token with its matching next request. The worker rejects
malformed, tampered, expired, cross-tenant, cross-group, cross-profile, or
cross-provider tokens before provider I/O. Tokens are authenticated encrypted
envelopes bound to the server-resolved route; only the owning adapter interprets
the decoded provider state. This preserves signed Anthropic thinking blocks and
provider-native continuation handles without allowing stored provider state to
cross an app-ai ownership boundary.

Adapters whose continuation owns the complete internal agent transcript declare
that capability to the shared loop. Gemini and Moonshot/Kimi therefore receive
initial public messages plus only the latest assistant/tool boundary and replay
earlier provider-native turns from their state without duplication; Anthropic
and OpenAI receive the accumulated canonical history, OpenAI replaying each of
its tool turns from the output items saved on that turn's tool calls. History-owning adapters
that need accumulated usage perform provider-shaped aggregation themselves;
Moonshot/Kimi and Gemini sum their internal calls. Anthropic retains the
terminal raw usage envelope exposed by the established production `/chat`
contract.

`src/inference/factory.ts` is the only provider/API-family switch. Provider
authentication, HTTP, wire types, file operations, request serialization,
stream parsing, effort/structured-output/cache realization, token estimates,
usage/stops, and normalized errors live under `src/inference/adapters/`. Both
registered `/messages` and `/chat` use the canonical service. Absent/unknown
`/messages` selectors retain a bounded raw Anthropic compatibility path inside
the Anthropic adapter so the external envelope stays unchanged.

The configured tier bindings resolve ordinary groups to Anthropic. The protected
`free-render-verification` group alone resolves to the exact bounded Cloudflare
Workers AI model. The adapter fixture matrix and architecture fitness tests pin
the boundary, so another provider is a configuration change rather than a change
to the seam.

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

### 27. OpenAI uses Responses statelessly, without changing production routes

The production-capable OpenAI adapter uses dependency-free Web `fetch` against the
Responses and Files APIs. Canonical instructions/messages, image and file
inputs, strict function tools, `text.format` JSON Schema, semantic reasoning
effort, typed SSE events, usage, stops, and failures are translated and
validated only under `src/inference/adapters/`. Tool results retain their
`call_id`; visual tool results may carry input images/files.
OpenAI keeps no stored Responses object: every call sends `store: false` and no
`previous_response_id`. It still holds its automatic prompt-cache state — in
memory for minutes, or up to 24 hours of extended caching for an organization
without Zero Data Retention — and app-ai requests no explicit cache (see the
paragraph below and `docs/AI-PROVIDERS.md`). No stored Responses object, app-ai continuation state or output-item replay crosses a request boundary, while OpenAI's automatic prompt-cache state can persist across calls (in memory for minutes, or up to 24 hours without Zero Data Retention), so an OpenAI route serves one public turn: it offers no continuation, and a request carrying a
continuation, any earlier assistant turn (text or tool call), a tool result, or
caller tools is refused with 400 before any provider call. The `gpt` family
declares neither `textConversation` nor `clientTools`, so no route whose
conversation carries earlier turns or browser-owned tools can select it, which
production validation refuses before serving. Within one request, following
OpenAI's stateless guidance, a reasoning model is asked for its reasoning
encrypted (`include: ["reasoning.encrypted_content"]`), and every output item of
a turn that ends in function calls is saved untouched on those calls: the next
server-tool iteration resends the conversation — the system input, the first
user turn, and each tool turn as its saved items, reasoning beside its calls,
followed by the tool outputs. Output items, encrypted reasoning included, are
replayed only within that one request. Registered
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

OpenAI requests ask for no explicit or extended prompt caching: no
`prompt_cache_options`, no `prompt_cache_breakpoint` marker, no
`prompt_cache_retention` and no `prompt_cache_key`. Every `gpt-` model resolves
to the one `gpt` profile, which declares no inline breakpoints, so canonical
cache intents are dropped and only OpenAI's automatic prompt caching applies:
in memory for minutes, or up to 24 hours of extended caching for an
organization without Zero Data Retention. That lifetime is recorded in
`docs/AI-PROVIDERS.md`, beside the abuse-monitoring logs, because it is
provider-side retention of request content.

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
accepts only tool-free visual/structured turns. The shim fulfils a tool-free
`stream: true` request as that same one-shot turn and delivers the answer as the
Messages API event sequence, so the registered prompts, which stream upstream,
reach either fulfiller. It runs
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
OpenAI, Moonshot, Kimi Code, and Gemini origins unless `AI_CHANNEL=prod` is
explicit. Offline tests mock the Codex process boundary and never invoke Codex or
a paid provider.

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

The catalog uses prefix matching for versioned families and exact matching for
provider-fixed service aliases. Prefixes let a newly released Claude/OpenAI/
Gemini version inherit stable family facts. Kimi Code and metered Moonshot
publish a fixed set of ids whose generations have different effort and file
capabilities, so exact matching prevents an invented alias from inheriting a
wire contract it cannot use. app-ai needs more than a provider name from that
match, because a profile also carries capabilities and a file policy, so each
match resolves the whole profile at once.

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
`requiresOrdinaryTurnContinuation` and complete agent-history ownership, so the
signature crosses the public HTTP boundary of a browser client-tool round trip
and every earlier signed tool cycle is replayed on later internal turns. A response whose first function
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
honours per-block cache markers on a request. Only Anthropic does; OpenAI and
Gemini do not. Naming it after the mechanism matters because a name that reads
as "can cache at all" is false — Gemini and OpenAI each cache a repeated request
PREFIX automatically, with no marker and no API call, so app-ai sends OpenAI no
cache field at all.

Because it reads as a cost characteristic rather than a correctness one, no
prompt group requires it. Requiring the mechanism made a provider that caches by
another route unroutable, which is a routing defect and not a safety property: a
group needs caching to be affordable, not to be correct. Groups still require
what they cannot work without — vision, reusable files, streaming, structured
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

### 33. The Grader conductor is never capped; a person's choices are

A fixed per-session count of uploads and inferences sized for one conductor stops being true the
moment the conductor reads more of the store, and it failed exactly that way: a count sized for a
one-page audit refused the uploads of a five-page one, and a retry reused the exhausted count. How
much evidence the conductor gathers and how often it repairs its proposal is LimeSpot's decision, so
app-ai no longer holds a legitimate run to any fixed number.

What remains is of two kinds. The abuse ceiling exists because a session key can be lifted from the
browser. It is derived in `src/lib/audit-plan.ts` from the plan the conductor
follows — the page vocabulary the proposal prompts plan, both widths, every tile Studio's capture
cuts a width into, and the proposal's bounded sends, per-page retries and repairs — times a
configured headroom. A recapture is not a second
upload: lib uploads a width's capture only when it returned an image and recaptures only a width
that returned none. It follows the
prompt vocabulary rather than a configured number, so a conductor that audits another page kind
raises it with no configuration change, and no legitimate run approaches it. The other limits sit on
what a person chooses to do: the runs one session may start (the first and every retry), two
completed public runs per stable audit identifier — held at the upload that would open another run,
so an exhausted audit reaches no provider — and the issuer's per-email, per-network and daily
activation controls, which app-ai does not duplicate.

A run boundary is drawn only from what the server observes. The first upload after a proposal was
reserved opens the next run with a fresh allowance and its own file ownership, and a new proposal
request supersedes a pending one, because the conductor never sends one while it still waits on
another. A request whose caller disconnected therefore never holds the session, which is what made
every retry after a transport timeout fail until the session expired. A superseded request still
counts toward its run's ceiling, so concurrency cannot buy more paid calls than the ceiling allows.

Inference requests are held per run, because a proposal reservation is the boundary the server
sees. Uploads are not: an attempt that fails before its proposal — a capture that broke mid-store —
leaves no trace the server can tell apart from the uploads of the attempt that follows it, so a
per-run upload count let two such attempts of a 7-page store exhaust the run before the third reached
the model. The upload allowance is therefore the session's: `AUDIT_MAX_RUNS` times the per-run
planned uploads times the headroom, the same total a session could upload before, drawn on by
every attempt in any run until it is spent.

The plan mirrors lib's capture and retry behavior, so it is a versioned contract rather than a
silent copy. The client names its plan in `X-LimeSpot-Audit-Plan-Version`, and app-ai refuses one it
holds no allowance for with 409 at the exchange, before any run starts, instead of letting the run
meet a 429 partway through or admitting it against a stale allowance. A version cannot give a worker
capacity it lacks, so the worker still deploys before the client that sends a new version. A
request naming no version follows plan 1 when its build names its build time; a build naming neither
is refused, because the plan version is then the only contract it can be held to.

### One upstream inference deadline, owned by app-ai

lib and the extension wait for app-ai's answer or its error and hold no deadline of their own, so
app-ai is the only place a model call's time limit lives: `UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS`
in `src/inference/deadline.ts`. Every upstream inference call runs under it: registered `/messages`,
each `/chat` turn, and the unregistered passthrough. The caller's own cancellation still aborts the
call. When the deadline passes first, app-ai answers `504` with its error envelope,
`{ "Message": "The AI model did not answer within the 600-second inference deadline.",
"ExceptionType": "InferenceTimeoutException", "MessageDetail": "inference_timeout" }`, and the SSE
`error` event of `/chat` carries the same payload.

The value is the provider's documented limit for one request that a client waits on for a single
answer: ten minutes. The Claude API's [Long requests](https://platform.claude.com/docs/en/api/errors#long-requests)
guidance names ten minutes as the point past which a request should not be held open for one
response, and the official SDKs validate that a non-streaming Messages request is not expected to
exceed a ten-minute timeout, which is also their default request timeout. The same guidance advises
against a large `max_tokens` without streaming, because some networks drop idle connections, so the
Anthropic adapter's `complete` asks for `stream: true` and assembles the event stream into the exact
message body the non-streaming API returns: every `message_start` member, the content blocks, and
every member the one or more `message_delta` events carry, such as a refusal's `stop_details`. A
stream answer with no body is an invalid provider response, never a success. The `/messages`
response contract stays one JSON message.

### Conductor prompts carry their model's maximum output

Every conductor prompt — the onboarding proposals, reviews, QC gate, CSS specialist and currency
recovery, the cart-drawer proposal and review, and `optimize-demand` — declares the semantic budget
`MODEL_MAXIMUM_OUTPUT` in `src/prompt-registry.ts`. `getSystemPrompt` resolves it to the documented
maximum output of whichever model the prompt's route selects, through `modelMaxOutputTokens` in
`src/inference/model-catalog.ts`: in production 128000 for `claude-sonnet-5` on the balanced tier and
64000 for `claude-haiku-4-5`, the fast-tier QC gate
([Models overview](https://platform.claude.com/docs/en/about-claude/models/overview), "Max output").
The catalog records a limit per model generation, as model-id prefixes where the longest match wins:
the current Claude families at 128000 (Fable, Opus, Sonnet) and 64000 (Haiku), the earlier
`claude-opus-4-5` and `claude-sonnet-4-5` at 64000 (their model pages), GPT-5 at 128000
([GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2)), and Gemini 3 at 65536
([Gemini 3 Pro](https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-preview)). Exact
Kimi/Moonshot Chat Completions ids use 131072: K3 documents that default while
allowing a context-dependent larger value, and Kimi Code caps compaction output
at 128K to avoid provider `max_tokens` failures. A settings-only
route change therefore carries its own model's ceiling, and a model whose generation records no limit
fails route resolution before any provider call. Gemini's one output budget covers thinking and the
answer, so its adapter never asks for more than that model maximum.

Two provider facts make any smaller number a guess that can break a run. On `claude-sonnet-5` a
request that omits `thinking` runs adaptive thinking, and `max_tokens` is a hard limit on thinking
plus the answer together, so the room a prompt leaves for its JSON shrinks with every token the
model spends reasoning; `effort` steers how much it thinks, but it does not reserve anything for the
answer. And the ceiling costs nothing when unused: output is billed as produced, and
[OTPM rate limits](https://platform.claude.com/docs/en/api/rate-limits) count only the tokens
generated, since `max_tokens` does not factor into them. `claude-haiku-4-5` runs without thinking
unless a request enables it, which none does.

A reply the model stopped at `max_tokens` is incomplete. Registered `/messages` answers it `502`,
`{ "Message": "The AI model's reply was cut off at its output limit.", "ExceptionType":
"InferenceTruncatedException", "MessageDetail": "stop_reason max_tokens at max_tokens <n>" }`, after
logging it at `warn` with its QC telemetry, so a truncated proposal is never delivered, and never
counted, as a success. Registered prompts stream upstream
([One upstream inference deadline, owned by app-ai](#one-upstream-inference-deadline-owned-by-app-ai)),
which is the transport the provider recommends for budgets this large.

### 34. Moonshot serves two accounts over one Chat Completions adapter

The dormant Moonshot adapter uses dependency-free Web `fetch` against the
official `/v1/chat/completions` and Files APIs. One implementation serves two
credentialed accounts that speak the same wire contract — the metered Moonshot
platform (`MOONSHOT_API_BASE` / `MOONSHOT_API_KEY`, exact ids `kimi-k3`,
`kimi-k2.6`, `kimi-k2.7-code`, and `kimi-k2.7-code-highspeed`) and the Kimi Code
subscription (`KIMI_API_BASE` / `KIMI_API_KEY`, exact ids `k3`, `k3-256k`,
`kimi-for-coding`, and `kimi-for-coding-highspeed`) — separated by an account descriptor carrying
transport, provider identity, model namespace, and whether a provider Files API
exists at all. Exact matching keeps undocumented aliases from inheriting a
generation's effort or file capabilities. Provider and API selection stay in
`inference/factory.ts`; every
production prompt group remains on Anthropic. The implementation contract was
checked against the current official
[Chat Completions](https://platform.moonshot.ai/docs/api/chat),
[model-parameter](https://platform.moonshot.ai/docs/api/models-overview),
[thinking](https://platform.moonshot.ai/docs/guide/use-thinking-models),
[tool-call](https://platform.moonshot.ai/docs/guide/use-kimi-api-to-complete-tool-calls),
[vision](https://platform.moonshot.ai/docs/guide/use-kimi-vision-model), and
[Files](https://platform.moonshot.ai/docs/api/files-upload) documentation. Kimi Code
publishes its separate [subscription endpoint and model IDs](https://www.kimi.com/code/docs/en/)
and [model effort controls](https://www.kimi.com/code/docs/en/kimi-code/models.html).

Conversation continuation is stateless at the HTTP layer but stateful in message
history. Ordinary assistant text replays from public history without a token.
Tool transcripts replay complete assistant messages, including
`reasoning_content` and exact `tool_calls`, before tool results; the adapter
stores that accumulated transcript in opaque provider state and marks it
required across the tool boundary. The state owns internal agent history, so the
shared runtime compacts to the latest boundary while the adapter replays the
complete transcript without duplication. The shared runtime never interprets it, and
public `/chat` and registered `/messages` tool continuations ride the one sealed-token
implementation in `inference/token-sealing.ts` through
`inference/continuation.ts`, tenant/group/profile-bound and expiring. The adapter
verifies raw state against canonical assistant content and tool calls
semantically while preserving the provider's exact JSON argument string, so
foreign or stale state — including state minted for the sibling account — fails
before provider I/O.

Streaming is accepted only when strict Chat Completion chunk identities remain
stable, reasoning precedes visible or tool output, tool-call indexes are
contiguous, IDs are unique and unchanging, a terminal finish reason matches the
assembled calls, final usage is valid and consistent, and the provider sends the
documented `data: [DONE]` marker. Both usage placements — top-level and nested
final choice — normalize into the same canonical usage contract. Kimi Code may
repeat identical nested terminal usage in a following empty-choices chunk; the
adapter accepts equality and rejects disagreement. Malformed JSON, truncation, missing terminal state, and
provider or transport failures leave the adapter as normalized
`InferenceFailure`s, and an upstream failure from either account is answered as
`MoonshotApiException` because both name the same API. A sealed file reference
that will not open is client input instead — `ArgumentException` or
`UnauthorizedAccessException`, decided before any provider was consulted.

The metered account's direct-file policy is `provider-managed` with purpose
`image`. Upload, retrieve and delete success envelopes are shape-checked, and
route-scoped dedup metadata retains upload MIME because Moonshot metadata does
not expose it. Kimi's worker-managed policy stores encrypted uploaded bytes in
`INLINE_EVIDENCE_R2`. The upload response stays the existing prompt-aware sealed
reference; a later request opens it under the same tenant, account, policy, and
group checks. Kimi's image Files upload returns an `ms://` reference small enough
to keep screenshots out of the message body, and an encrypted sidecar reuses the
same id across repeated inference. Cleaned HTML and prompt sample documents are
decoded into text. Oversized uploaded HTML stays in encrypted storage; the
adapter offers Kimi bounded read/search tools and passes exact selected
fragments into the final request. Smart image detection can finish within that
tool loop; chat and other routes retain their original public tools and stream
after retrieval. Internal provider continuation stays in app-ai and usage is
aggregated across calls. A 2 MiB request-size guard fails
before the completion call; existing bounded lib callers can fan out a holistic
onboarding request on 413. Kimi's
coding endpoint accepted image and text uploads in live probes, but its
metadata, content-read, and delete endpoints answered 404. Deleting the public
reference revokes app-ai's encrypted object and sidecar, while Kimi retains any
native image upload under its own provider policy. External image URLs,
unsupported documents, and media tool results fail closed. Sampling values are
model-fixed; explicit sampling overrides
and the undocumented parallel-tool toggle likewise fail before I/O. K3 and the
K2.8 `kimi-for-coding` model support semantic effort. K2.7 HighSpeed preserves
thinking without an effort control. Specific-function tool choice remains gated
to K3 until the subscription host's behavior is verified. Requests use the current
`max_completion_tokens` field rather than the deprecated `max_tokens`. Neither
account claims inline cache breakpoints, even though Moonshot may perform
provider-managed prefix caching.

The optional `npm run verify:moonshot` and `npm run verify:kimi` matrices are
paid and each requires two explicit acknowledgements plus an explicit base, key,
and model. Kimi Code documents the subscription endpoint and model IDs; the
probes verify the remaining wire behavior. Both sit outside CI and release
gates and activate no production route.

### 35. The Grader chat is its own traffic, admitted on the server's own evidence

The Grader's sales chat runs on the scoped audit session, but it is not part of the audit's plan
of work, so it never touches the audit's accounting: no run inference, attempt, upload, or status
event, and no part in the rule that a new proposal supersedes a pending one. Mixing the two would let
a chat message cancel a proposal the visitor is waiting on, or spend the run ceiling that exists to
stop a lifted key. The session record keeps the chat's count, its reply fingerprints, and its one
message in flight apart from `pending`.

The client resends the whole conversation on every message, so app-ai cannot trust an assistant
turn it did not write: a planted "LimeSpot is free forever" would steer the next reply. Each reply
app-ai returns is stored as a fingerprint of the transcript through it, and every assistant turn a
request carries must match one. Binding the transcript rather than the reply alone also refuses a
genuine reply re-paired with a different question.

The report is lib's structure plus model-written reasons and titles, so it is validated strictly,
capped, and handed to the model as a fenced data block in the first user message — never the system
prompt — with every backtick escaped so it cannot close its own fence. What the model may claim is
marketing's booklet, and the prompt carries that rule rather than a filter in code. A deterministic
claim filter cannot be made complete: each synonym, tense or word order it misses is a claim
delivered, and closing those gaps one by one either never ends or ends by withholding ordinary
replies, because telling a claim from harmless wording takes language understanding. So the
boundaries block forbids promised or predicted results, guarantees, timelines, and any price or plan
detail the booklet does not word, lib shows an "AI can make mistakes" disclaimer beside the chat,
and the one deterministic check on a reply is the link guard: any link off limespot.com is withheld,
because an off-site link is the clearest injection risk and recognizing one needs no understanding
of the sentence around it. The report is no authority for any claim: it arrives from the client,
the audited page's scripts can reach the bridge it travels through, and its figures describe the
store's own suggestions rather than LimeSpot's commitments. A withheld reply still counts: the model
was paid for, and not counting it would let a visitor spin unbounded calls.

The three chat ledgers live in independent Durable Objects, so no transaction spans them. The
audit's ledger is the authority — it holds the count and the fingerprints the next request's history
is matched against — so it commits first, idempotently by the message's reservation, together with a
settlement record for the two daily counters, and only then does the reply leave. The daily counters
commit or release by the same reservation, so the request and the audit's alarm may both try without
counting twice. A daily hold stays charged until a settlement commits or releases it, so a late
settlement can never carry a counter past its limit; the audit releases a lapsed message explicitly
and refuses that reservation's commit, so each reservation settles one way. A threshold alert is
queued in the deployment counter's own outbox in the transaction that crosses it, and the counter's
alarm delivers it, so a response lost after the commit cannot lose the alert; its id names the day,
so a carried-over alert and today's equal threshold settle apart. A request captures its UTC day
once for the visitor's counter name and both holds, and a counter refuses a hold dated another day,
so midnight cannot hand one visitor two allowances.

An HTTP retry must not buy a second answer. The server-made reservation identifies an attempt, not a
message, so the caller sends a `messageId` per visitor turn and keeps it across retries. The audit
binds it to a fingerprint of the transcript and stores the message's outcome in the transaction that
counts it, so a retry after a lost response is answered from that outcome with no inference and no
charge, a retry while the original runs is refused as busy, and the identifier cannot be reused for
another conversation.

None of it is kept longer than a session needs it. The outcome, the identifier, its transcript
fingerprint and the reply's fingerprint live `AUDIT_SESSION_TTL_SECONDS` from the answer and are
deleted together by the audit's alarm, while the audit keeps only its counts. A session is shorter
than that from any answer it was given, so inside its own session a retry is always replayed and
every reply it was given still verifies as history; only a conversation carried into a reissued link
loses the replies older than 30 days, which then no longer verify. After the window the identifier is
unknown, so a request carrying it is a new message under the same allowance. Admission deletes
expired entries and their outcomes in its own transaction before it reads the record, and an outcome
key is deleted only while no live entry names its identifier, so how late the alarm runs never
changes an answer and never takes the outcome of a message that reused an identifier.
Fingerprints an earlier worker stored name no message; each is deleted with the last live entry that
worker wrote, so it too is gone within 30 days.

An answered-message allowance alone bounds nothing a caller can abandon: a call aborted after the
provider began answers nothing and would be released. So every admitted message is also an attempt,
counted by the audit and by the visitor's day and held to twice their answered allowances; a
message keeps its attempt once its model call began, and only one released before any call gets it
back. The visitor still sees answered messages only.

Limits follow where abuse lands. The allowance belongs to the audit, like the completion ledger, and
neither a retry nor a reopened link restores it, because both are free to start. Reopening is
cheap on purpose: a new activation supersedes the active session rather than waiting out its
lifetime, and the old bearer is refused from then on. A visitor's day is keyed by a day-scoped HMAC pseudonym of
`CF-Connecting-IP`, so the raw address is never stored, and the deployment's day has a ceiling and an
alert every `GRADER_CHAT_ALERT_EVERY` messages, decided inside the counter's transaction so each
threshold alerts once. The chat is plan version 2 because lib must send it and show its terms;
plan 1 clients are refused rather than offered something they cannot render.

### 36. A long `/messages` call can keep its connection alive, by the caller's choice

Some client networks drop an HTTP request that receives no reply bytes for a while: a VPN's proxy
or an office proxy cutting at 60 seconds is common, and a Grader proposal, review or verification
routinely takes longer than that. A plain `/messages` answer sends nothing — no status, no headers,
no body — until the model has finished, so on such a network the call is lost before app-ai answers,
however healthy the inference was.

A caller that sets `"responseMode": "keep-alive"` in its JSON request body is answered at once:
status 200 and the headers immediately, one whitespace byte straight away and another every
`MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS` (15 seconds in production) while the request runs, and
then one JSON envelope. Leading whitespace is valid JSON, so the body still parses as one value.
Because the status is committed before the outcome is known, the outcome moves into the body:
`{ "responseMode": "keep-alive", "status": <n>, "result": <body> }` when the request would have
answered a 2xx, and `{ "responseMode": "keep-alive", "status": <n>, "error": <Brain error envelope> }`
otherwise. `status` and the body are exactly what the plain answer would have carried — the upstream
deadline's 504, a truncated reply's 502, a provider failure, a Grader chat refusal made once the
message is being admitted — and a body that is not JSON travels as a string.

The opt-in rides in the body rather than a header so the browser extension's relay, which forwards
a `/messages` body verbatim but only an allowlisted set of headers, needs no change. Reading a body
costs memory and CPU, so app-ai reads it for the opt-in only once the caller has authenticated, and
reads each `/messages` body exactly once, parses it once and keeps no second copy: a merchant
request's body is read and parsed after its context-ID validated, and a Grader session request's
body is read after its bearer verified, stopping as soon as it passes the audit's byte limit, then
parsed once. The opt-in is looked for in that parsed value, and the same value — never a clone, a
re-read or a re-serialized copy — is what the handler receives. The keep-alive answer begins only once that authorization has admitted
the request, so a request refused while authenticating or authorizing — a missing or invalid
credential, an unsupported plan, an oversized or malformed Grader body, a switched-off chat, a
refused reservation — is answered with its own status and plain error body, which a client that
opted in reads exactly as it would without the opt-in. The opt-in is
then removed, so every handler, the strict Grader chat body check and the unregistered passthrough
see exactly the body they always did, and no provider ever receives it. Because the body has already
been read before the keep-alive answer begins, the handler never reads the request again, which
matters because the runtime discards a request body nobody has read once that answer has begun.
Only the exact value `keep-alive` opts in: a request without it — or with any other value — is
answered exactly as before, which keeps every released client, and the lib embedded in an installed
extension, on the contract it was built for.

The two releases are ordered in both directions. app-ai deploys before a lib that sends the opt-in,
and a rollback runs the other way: the lib sender is rolled back, or its opt-in removed, before
app-ai is. An app-ai without this mode does not know the member — the strict Grader chat body
refuses it with 400 `ArgumentException`, and the unregistered passthrough forwards it to the
provider, which refuses an unknown member — so rolling app-ai back under a lib that still sends it
breaks the Grader chat and every unregistered-selector call that carries it.

The interval is configuration because it is sized against client networks, not against anything in
the worker. The keep-alive answer is marked `Cache-Control: no-store, no-transform`: Cloudflare does
not compress a response carrying `no-transform`, so the single whitespace bytes are not held back to
fill a compression block. Waiting costs no CPU time, and a streamed body keeps the invocation alive
while the client is reading it. The pending work is also handed to `waitUntil`, so a caller that
disconnects leaves it the runtime's 30-second grace to settle what it holds — the audit's ledger and a
Grader chat message's stored outcome — rather than leaving the reservation to its lease. Work that
outlives that grace ends with the invocation and settles exactly as a plain request whose caller
disconnected does: its reservation stays held until the lease ends and the audit's alarm releases
it. A Grader chat message released that way counts as a failed attempt and answers nothing, so a
retry of the same `messageId` is admitted afresh. Replay is unaffected: a Grader chat `messageId`
already answered is answered from its stored outcome before any model call, and that outcome
reaches a keep-alive caller as the envelope's `result`, identical to the plain answer's body. The upstream inference deadline stays the only time limit; keep-alive adds none.

### 37. A Grader session lasts 30 days, and two dated switches can end every cached run

A store gets its Grader run, and its report and chat stay usable for 30 days: the extension keeps the
report, the chat and the session for that long, so a visitor who returns days later goes on chatting
while the run's allowance lasts. After 30 days the store may run the Grader again; the website counts an
audit's completed runs for as long as it reuses the audit identifier, so that reset is the website's
to make by issuing a new one, and app-ai keeps the audit's own ledger and chat allowance until its
record is deleted a session lifetime after the latest session expired
([A Grader session's uploads go when it ends](#38-a-grader-sessions-uploads-go-when-it-ends-and-its-audits-record-a-session-lifetime-later)).
`AUDIT_SESSION_TTL_SECONDS` is therefore `2592000`, and it stays the one value that bounds a session
in app-ai — the bearer's `expiresAt` claim, the session record's expiry and its alarm,
`graderChat.sessionExpiresAt`, how long an answered chat message's stored outcome and fingerprints
are kept for replay, and how long the audit's record outlives its latest session. A reissued session still
supersedes the old one at once, so the old bearer answers `audit_session_expired` from then on.

Time is not what holds spending. Every cap is per run or per day — the run ceiling, retries per
session, the two completed public runs, the 25 chat messages an audit (50 at most under plan 2),
twice that in attempts, and the visitor's and deployment's UTC-day counters — so a longer session
admits no more paid work than a shorter one; it only lets the same allowance be used later. The
longer bearer is still narrow: it reaches only `POST /files` for the proposal and QC destinations,
`POST /messages` for the two proposal prompts and the Grader chat, and the read-only
`GET /audit/session`, under one audit, from the same store origin. Every request that can spend is
reserved against the audit's record, which names only the newest session, and the status read checks
the same record while reserving and writing nothing.

Lifetimes no live session needs stay shorter rather than following it: a provider file reference
lasts at most 15 days, because a run reads its tiles only while it runs and the chat reads none, and
lengthening it would widen every merchant upload's reference window and the secret-rotation bound;
a sealed continuation lasts 24 hours and no audit route uses one; the chat's counters stay UTC days.

A cache that lives a month needs a way to end it. `GRADER_RUNS_VALID_FROM` is an instant before which
a run no longer counts, by its completion or, when it never completed, its start; the exchange and
every chat reply report it so the extension drops an older cached run, and app-ai refuses such a
session `grader_run_revoked`, so a stale client cannot keep using it either. It is a date rather than
a counter because the question a client asks of its cache is "is my run older than this?", which a
date answers with no state of its own, and because the server can answer the same question from the
run's own times. `GRADER_EXTENSION_BUILT_AFTER` is the matching instant for extension builds: a build
names when it was made in `X-LimeSpot-Extension-Built-At`, and an older one is refused
`extension_update_required` at exchange and on every Grader call. The build cutoff applies only to a
build that names its build time. Firefox lets a user refuse the optional technical data the build
time is, and Mozilla requires that refusing it costs no function, so a build naming none is held to
the one compatibility contract it still carries, the plan version it declares, rather than to a
substituted date any later cutoff would refuse; a build naming neither is refused. The cost is that
the build cutoff cannot retire a build naming no build time: removing its plan version from
`SUPPORTED_AUDIT_PLAN_VERSIONS` does. Neither switch restores an attempt or a message. The run cutoff is enforced from the server's own run times; the build cutoff is a
compatibility switch, not a security boundary, because the build time is whatever the caller says.
A per-run switch would need an operator write path into the audit's Durable Object that does not
exist, so there is none.

A client that restores a cached run makes no call that would be refused, so a raised cutoff would
reach it only when it next spent something. `GET /audit/session` closes that: the extension reads the
session's standing with its own bearer before it reopens a cached run, and the call spends and writes
nothing. Run times name their session and run, because a rolled-back worker carries an unknown member
onto its next run; times it left absent or stale on a run that reached a proposal read as the
bearer's issue time, which errs toward a fresh run without refusing every run regardless, and a run
it opened with uploads alone, which has no report to revoke, is adopted as opening now. The exchange resolves every setting it answers with
before it consumes the one-time activation, so a deployment fault never costs the visitor the link or
the session they still hold.

### 38. A Grader session's uploads go when it ends, and its audit's record a session lifetime later

A Grader session uploads screenshots of a store to Anthropic. Anthropic's 30-day expiry alone would
let an upload made late in a 30-day session outlive the session by almost a month, and nothing else
would end the audit's Durable Object record, with its store origin, callback URL and chat state.
Both end on the session's own clock instead.

Every successful upload records its provider objects under the session it was admitted in, and the
audit's alarm deletes them one reservation lease after the session ends, by expiry or by a new
activation superseding it. The lease is the wait because a proposal the session admitted before it
ended may still be reading its tiles; after it nothing can, since dedup shares an object only under
one tenant pseudonym and a session's pseudonym is derived from its own identifier. The session's
`FILES_KV` dedup records and `discard:` keys go in the same pass, with the objects they name, so an
upload whose success never reached the Durable Object is caught through its dedup record, and the
same provider-neutral delete removes Kimi's encrypted R2 evidence. A delete that fails is kept and
retried a minute later and then at doubling intervals of at most an hour, until it succeeds or the
object's provider expiry deletes it anyway; it is never dropped while the object can still exist.
An expiry stands in for a delete only where the provider itself deletes at it, which is a
provider-managed file policy. Evidence in app-ai's own storage carries the expiry of its reference,
which ends before the bucket rule removes the object, so it is always deleted explicitly.
A retry only helps if the alarm lives to record it, and a Durable Object alarm that never returns is
retried a finite number of times and then left unscheduled, which would strand the uploads and the
record with them. Every delete is therefore abandoned as failed after ten seconds, whether or not
its transport honours the abort — an R2 binding call cannot be aborted — and an alarm starts no
delete once its pass has run a minute, so a provider that stops answering costs one pass and the
retry is always written.
The deletes run on the Durable Object alarm the session already keeps, because only the audit's own
object knows which sessions uploaded what and when each ended, and it adds no binding, cron or
configuration.

The record and every key of the audit's object are deleted `AUDIT_SESSION_TTL_SECONDS` after the
latest session expired: at most 60 days after the last activation the audit exchanged. That instant
is the first at which the record holds nothing a rule still needs — every chat outcome and
fingerprint, kept a session lifetime after its answer, every audit upload, which Anthropic deletes
30 days after it was made, and every activation, which exchanges within 15 minutes, have all ended
by then — so the deletion never cuts a documented lifetime short and keeps nothing past it, and it
reuses the session's own setting rather than adding another. A shorter grace would delete chat
outcomes and pending upload deletes the documentation still promises; the website's 180-day lead
retention, the other candidate, would keep a store origin for months after any session needed it.

limespot.com's privacy policy tells visitors when these uploads and records are deleted, so the
worker that deletes them is live before that copy is published, and a rollback below it takes the
copy back with it.

Deleting the record ends app-ai's copy of the audit's completed runs and chat allowance. A later
activation for the same audit identifier starts a fresh record, whose chat offers the full allowance
again once a run in it completes. Completed runs stay capped, because the website refuses an
activation once it has mirrored two completions for the audit and keeps that count for as long as it
reuses the identifier.

### 39. The AI providers app-ai may use are the DPA's, enforced before serving

LimeSpot's Privacy Policy says its AI model providers process content under commercial terms that do
not allow them to train on it and keep it only for a stated window, and its DPA lists them as AI
sub-processors. Routing alone could not keep that true: a tier binding or a `MODEL_OVERRIDES` entry
moves a prompt to any catalogued provider as a settings change. So `src/lib/ai-providers.ts` holds
the DPA's list, and every catalogued provider maps to a name on it or to none. The list is a copy of
the workspace's canonical `ai-providers.json`, which every repository calling a model provider holds
its code to, and its test pins it to that file rather than to names of its own, so the copy cannot
drift from the file's names or origins without failing CI. The file itself is held to the DPA as
published: CI fetches the live page and fails while its sub-processor list leaves out any provider
the file names, so a provider added to the file is blocked here until the website DPA naming it is
merged.

Moonshot and Kimi Code map to none. Moonshot's platform terms let it use customer inputs to improve
its services unless a separate written agreement says otherwise, and the Kimi Code subscription has
no processor terms at all, so neither may receive merchant, shopper, user or captured-page content.
Each prompt group therefore declares whether it carries such content, and a provider off the DPA
list may serve only a group that does not; every group carries it today. Outside production every
provider stays routable, because the adapter tests and the opt-in paid smoke matrices need them and
no customer content reaches those channels.

The check runs before serving, not when a route is first used: Workers give a script its
configuration only with its first event, so the router validates the whole provider configuration
before an isolate answers anything but `/health`, and refuses every request while it is invalid. A
partly valid configuration that served some routes would send the rest elsewhere the moment they
were used. Route resolution and the provider base accessors check again at request time, so a
configuration changed after validation still cannot reach a disallowed provider or origin.

In production each provider is reached only at its own API base, written exactly, and no transport
follows a redirect, because a proxy or a redirect would hand content, keys or file ids to a party
the DPA does not name. workerd implements no `redirect: 'error'`, so every call asks for `manual`
and refuses the 3xx answer itself.

Retention deletion is the one exception to routing: it reaches a stored object through the provider
that holds it, at that provider's own origin, whatever the current routing, because the promise is
that the object ends, and a routing change must not strand it. OpenAI uploads ask for a 30-day expiry
like Anthropic's, because an OpenAI file otherwise persists until something deletes it.

### 40. One set of agents master rules, with its core held in limespot/root

LimeSpot Assistant and its agents run in two places: the conversations an owner has in Studio and
the subscription chat are prompts here, and the agents that run unattended on a schedule are Brain
prompts. The rules on what an agent works on, what it never does and what it treats as data are
the same in both, so they are one text, `limespot/root`'s `_standards/agent-rules-core.md`, beside
the `ai-providers.json` both runtimes already hold their provider lists to. Each runtime ships a
copy, because a worker cannot read another repository while it serves: here
`src/prompts/assistant-shared/_shared-agents-core.md`, in Brain
`LimeSpot.AI/Agents/Prompts/agents-core.md`. Each adds what holds only there: app-ai the rules of a
conversation with the owner (out of scope, ask before acting, when a person takes over, stay
helpful), Brain the rules of an unattended run; those may narrow the core, never widen it. Fetching
the root text at runtime was the alternative; it would put prompt text outside `src/prompts/` and
add a dependency to every call.

`test/shared-agents-core.test.ts` compares this copy with the root file byte for byte, with nothing
normalized, at the root revision CI's `test` job checks out for `ai-providers.json`, reading the
same `LIMESPOT_ROOT_STANDARDS` directory, and fails naming both files and the first line that
differs. Brain's test does the same with its copy. A change to the core is therefore a root pull
request first, and each runtime's CI stays red until its copy matches, so the two runtimes cannot
drift apart and the root text, not either copy, decides which is right. Neither repository pins a
hash of the text: a hash pinned in each could say only that a copy changed, never which side had
the rule as agreed.

The core opens with its own heading, which limits its override to what an agent works on, never
does and treats as data; tone, length and what a prompt works out from its own context stay with
the instructions after it. A rule that beat every later fragment would also beat Studio's own
"answer only what was asked" and its page inference. The conversation rules come right after the
core, and every prompt whose words the owner reads in a conversation composes both right after its
identity; `test/assistant-prompt-blocks.test.ts` records for every registered prompt whether it
does and why not, so a new prompt cannot ship without that choice. The Grader's chat and its two
onboarding proposal prompts do not, because they speak to stores that have not installed LimeSpot.
