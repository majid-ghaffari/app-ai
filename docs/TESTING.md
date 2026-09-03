# Testing — app-ai

**Parent:** [../CLAUDE.md](../CLAUDE.md)

The worker has four required offline test layers in the default `vitest run`
set. An optional live integration diagnostic can measure deployed prompt-cache
behavior when an operator explicitly chooses to run it.

## Layers

| Layer                    | Files                                                                                                                                                               | Network       | Catches                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                     | `test/token-saving.test.ts` (pure-fn cases)                                                                                                                         | Mocked        | Logic bugs in lib functions: `sha256Hex`, breakpoint placement, `supportsEffort`                                                                                                                                            |
| Integration (handler)    | `test/chat.test.ts`, `test/ai-tool-capabilities.test.ts`, `test/proxy.test.ts`, `test/demo-auth.test.ts`, `test/toolsets.test.ts`, `test/platform-toolsets.test.ts` | Mocked        | Handler wiring: agent loop, capability gating, sanitized Brain failures, demo exchange/scope/concurrent Durable Object ownership/quotas, prompt selection, dedup KV, toolset composition and integration-bridge wire shapes |
| Contract                 | the SSE/tool-shape assertions in `test/chat.test.ts` + the tool-definitions snapshot in `test/toolsets.test.ts`                                                     | Mocked        | Drift between the worker's wire shapes and lib `ai/CONTRACTS.md` (§1 SSE, §2 tools)                                                                                                                                         |
| Fitness (architecture)   | `test/architecture.test.ts`, `test/config.test.ts`, `test/logger.test.ts`                                                                                           | Static/mocked | Invariant erosion: an endpoint bypassing toolset composition, secrets reaching logs/model context, direct Worker console calls, malformed log routes, a bespoke error envelope, hardcoded config, production `[vars]` drift |
| Token-savings diagnostic | `scripts/verify-caching.mjs`                                                                                                                                        | LIVE          | Prompt caching silently failing to engage against the deployed worker                                                                                                                                                       |

The unit / integration / contract layers mock `fetch` and `env` — no real
network, no credentials. They run on every push and PR (`.github/workflows/ci.yml`).

## Test-layer doctrine

Pick the lowest layer that captures the bug:

1. **Unit first** — is it a pure function (a hash, a breakpoint calc, a model
   capability check)? Add a case to the relevant `describe` in
   `test/token-saving.test.ts`. Fastest, no handler plumbing.
2. **Integration next** — does it involve a handler driving the Anthropic client
   or Personalizer dispatch (the agent loop, SSE framing, demo authorization,
   attachment injection,
   cache-control distribution)? Add to `test/chat.test.ts` (the `/chat` agent
   loop) or `test/proxy.test.ts` (the `/files` + `/messages` + auth/CORS surface).
   Mock `fetch` to return the Anthropic SSE / JSON the case needs.
3. **Contract** — does the bug involve an SSE event name, a tool definition, or a
   request/response field that must agree with the lib client? Assert the wire
   shape against `packages/storefront/src/admin/ai/CONTRACTS.md` (§1 SSE protocol,
   §2 tool definitions) — the worker is the server side of that frozen contract.
   The composed tool definitions are additionally pinned byte-for-byte by the
   file snapshot in `test/toolsets.test.ts`
   (`test/__snapshots__/tool-definitions.contract.json`) — regenerating it is a
   deliberate contract change.
4. **Fitness** — is the bug a violated standing invariant (a rule from
   CODE-PATTERNS.md / TOOLSETS.md rather than a behavior)? Extend the static
   scans in `test/architecture.test.ts` (or the config/production-value pins in
   `test/config.test.ts`) so the whole CLASS of regression is caught, not the
   one instance.
5. **Optional token-savings diagnostic** — if investigating real Anthropic
   caching behavior, use the live diagnostic below. This is useful operational
   evidence, not part of the release gate set.

## What each spec covers

One entry per spec file — the map, read on demand. It names what a spec asserts, never the assertions themselves; the spec is the source of truth for those.

- `test/chat.test.ts` — the `/chat` agent loop, SSE protocol, tool-use loop, MAX_ITERATIONS, placement no-tools path, non-streaming JSON, prompt selection, `get_entity_context` dispatch through the registry composition (record → per-record Personalizer routes/header + normalized result, analytics → refs, error degrade), and the `context.refs` handler flow (prefetch-per-ref, uncached final block, no-refs byte-identical system, 5-ref cap + one shared subscriber lookup, failure degrade, refs threaded into the loop).
- `test/ai-tool-capabilities.test.ts` — the real Worker `/chat` route through context validation, Anthropic tool-use, registry dispatch, and the mocked Brain boundary: contract-version fail-closed behavior, exact-name definition filtering, zero-call execution for unadvertised tools, required response-member validation, and raw Brain error bodies remaining operationally logged but absent from model-visible tool results.
- `test/toolsets.test.ts` — `src/toolsets/registry.ts`: composition (stable definition order, no-parties case, a party no toolset declares, per-request independence), party gating (a tool outside the composition degrades with zero backend calls), the credential seam (contextId resolved per composition and forwarded as the Personalizer header, never in the model-visible definitions, per-call `refs` extras), and the FROZEN model-visible tool contract (byte-for-byte file snapshot of the composed definitions, `test/__snapshots__/tool-definitions.contract.json`). It also drives `personalizerToolset.execute` directly, past the registry's owners map, to cover that toolset's OWN capability guard: an unadvertised name degrades with zero Brain calls, an advertised one reaches its `/v2/ai-tools/*` route, and `get_entity_context` stays available under an empty capability set.
- `test/platform-toolsets.test.ts` — the platform toolsets (`toolsets/{shopify,bigcommerce,klaviyo,google-ads}/` + `toolsets/integration-bridge.ts`): the REST/GraphQL/GAQL wire shapes toward Personalizer's `v2/integration-bridge/*` (URLs, mirrored verbs, PascalCase `Query`/`Variables`/`PageSize` bodies, JSON POST/PUT bodies, body-less DELETE), the `X-Ls-Integration-Bridge-Error` discrimination (platform 4xx/5xx surface verbatim as `ok: true` data; whitelisted `Link`/`Retry-After`/rate-limit headers surface as `result.headers`, omitted when absent; LimeSpot envelopes degrade with `<Message> (<ExceptionType>)`; network failures degrade), and the call-channel credential seam (no proxy call without a service token/context; the token never model-visible).
- `test/references.test.ts` — `lib/references.ts`: intake sanitization + cap, `refCategoryPath`, per-type `resolveRef` (record → normalized entity-context payload vs analytics → metadata, throw on subscriber failure, Found:false pass-through), the FROZEN Referenced-Entities block string (contract snapshot), label fallbacks, allSettled degradation, analytics-only → zero Personalizer calls, one-subscriber-lookup-per-block.
- `test/entity-context.test.ts` — `toolsets/personalizer/entity-context.ts`: the frozen AiToolEntityContext shape per record type (member order, Summary grammar incl. `0.##` amounts + schedule, Fields minimums, null-member omission), the campaign discount→html→image probe, tenant re-checks (cross-subscriber/deleted → Found:false), one-hop Related filtering, failure semantics (miss vs throw: 404/204/5xx → Found:false; malformed guid / unknown type / subscriber failure / 401/403 → throw), the shared subscriber lookup, and no validate-context-id roundtrip.
- `test/proxy.test.ts` — the proxy surface: CORS, response/error shape, context validation, the Anthropic client (headers/beta/URLs, config-error rejection), `manageCacheControl` (size-based ranking of user blocks plus explicit stable-prefix priority across one/two system blocks and attachments, the four-slot cap, marker stripping/order preservation), and the `/files` + `/messages` + `/health` handlers.
- `test/demo-auth.test.ts` — activation/session claims, public-origin and verified-staff entitlement, one-use exchange, stable cross-link public cap, bearer/route/prompt scope, parallel upload ownership, failed-attempt reuse, server-owned inference settings, quotas, and durable ordered callback retry.
- `test/demo-audit-status.test.ts` — exact callback JSON, timestamp and HMAC header contract plus retryable delivery failure.
- `test/probes.test.ts` — the Website-Analysis probe mechanism: the registry resolves `probe-industry` (text/metadata/model), resolves the Sonnet probes `probe-cart-wiring` + `probe-style` on the `balanced` tier (≠ the default `frontier` tier, `usesTools: false`, no attachments) with their selector/style-descriptor prompt contracts, the `probe-<id>` convention (`PROBE_PREFIX` / `isProbeName`) + the `PROBE_SCHEMAS` index ↔ registry coherence, `/messages` routing the `probe-industry` / `probe-cart-wiring` / `probe-style` headers (system block injected, no attachments, model defaulted to the registry entry, caller blocks pass through), and the frozen `{ industry, confidence, findings }` output contract (schema/parse checks: well-formed, `Unknown`/empty-findings sink, rejects missing keys / out-of-range confidence / non-string findings).
- `test/proposals.test.ts` — the TOOL-CAPABLE per-store SETUP PROPOSALS prompt: the registry resolves `proposals` on the `balanced` tier (Sonnet, ≠ the default `frontier` tier) + `usesTools: true`, the prompt reasons over page evidence (screenshots + cleaned HTML) AND instructs the model to pull real store data via the personalizer tools (AOV-derived progress-bar threshold), and `POST /chat` with the `proposals` header sends the personalizer tool surface + the page-evidence file blocks and drives the tool loop (tool_call → Brain `v2/ai-tools` → tool_result → final JSON proposal).
- `test/config.test.ts` — `src/config.ts`: the no-fallback contract (every accessor throws on a missing/empty variable, naming it and where to set it), the `resolveModel(env, tier)` tier→model mapping (each tier → its bound var, throws named when absent), and the PRODUCTION `[vars]` pins, which the spec reads out of `wrangler.toml` itself rather than restating: the Personalizer and Anthropic origins, the three tier→model bindings, the credentialed-origin allowlist, and the absence of any secret in that file.
- `test/architecture.test.ts` — fitness scans over `src/` + `scripts/` enforcing the standing invariants: party- and AI-capability-driven toolset composition, the exact version-1 router gate, credentials never in logs or the model-visible system builder, degraded tool results structurally unable to carry raw bodies, one error shape (no bespoke `{ error: { message } }` envelopes), and No Hardcoded Config Values (no absolute URL literals in src or scripts, no inline `||`/`??` fallbacks on `env`/`process.env` reads, required worker vars read only through `src/config.ts`). The dev Claude-Code shim (`scripts/dev-claude-shim.mjs`) is carved out of the no-URL-literal scan only — it is standalone local tooling with overridable dev-default endpoints, outside the worker's fail-fast config contract (never bundled); it still passes the env-fallback scan (it reads config via `envOr(name, fallback)` bracket access, not inline `||`/`??`).
- `test/dev-shim.test.ts` — the free dev Claude-Code channel (`scripts/dev-claude-shim.mjs`): the pure Anthropic⇄Claude-Code translation layer (`systemToString`, `rehydrateBlock` file→inline base64 image/document + tool_result flatten + unknown-file degrade, `normalizeContent`, `buildPromptMessages` user turn + assistant-history preamble, `estimateTokens` char/4, `bareToolName` mcp-prefix strip, `stripCodeFence`, `usageFrom`, `extractFilePart` multipart), plus the **cred-burn GUARD** (`assertDevAiChannel`: throws when a dev/test run points `ANTHROPIC_API_BASE` at `api.anthropic.com` without `AI_CHANNEL=prod`; allows the local shim; opt-in with `AI_CHANNEL=prod`) and a check that `.dev.vars.example` ships the free-shim default.
- `test/dev-inference-trace.test.ts` + `test/logger.test.ts` — correlated inference events, complete diagnostic text/tool/file decisions, per-level multi-sink routing, context/error detail, secret-field redaction, optional Seq authentication, fail-open delivery, and background rejection capture.
- `test/helpers.ts` — shared typed fixtures: the complete `Env` fixture, fetch-mock accessors, the worker-SSE parser, and the KV mock.
- `test/token-saving.test.ts` — the cost-reduction levers: 1h-TTL placement (system/context/kept user blocks), `applyConversationBreakpoints` (last-block, ~15-block intervals, cap + `reservedHeadBlocks`, stale-strip), `file-dedup` (sha256Hex vector, KV hit + stale-id verify/re-upload + miss + no-op, 30d TTL), `fileIds` document/image block typing + 1h file-prefix breakpoint + ≤4-breakpoint-with-file-prefix invariant, `countTokens` body/header, model+effort routing, and an end-to-end agent-loop breakpoint-count ≤4 assertion.

## No silent skips

A test never `it.skip()`s because an env var or fixture is missing. If a
precondition is absent, the test (or the gate) THROWS with an actionable
message:

- When invoked, the caching diagnostic throws if no master context-ID is available — naming the env
  var to set and the fixture path to provide (see below).
- When invoked, the caching diagnostic throws if a deployed-worker call returns a non-2xx or a
  Brain-shaped error body (`{ Message, ExceptionType, ... }`).

A skipped test is invisible in CI green. A louder red is the trade we make.

## Running the offline suite

```bash
npx vitest run          # one-shot: unit + integration + contract + fitness
npm test                # watch mode
npm run typecheck       # tsc --noEmit (strict; must be 0)
npm run lint            # ESLint over the whole repo (src, test, scripts/, configs)
npm run format-check    # Prettier check (whole repo; exclusions + rationale in .prettierignore)
npm run deploy:dry-run  # build the revision-stamped bundle (verifies imports + the .md Text rule)
```

## Local AI dev channel + cred-burn guard

Local dev fulfils Anthropic inference through **Claude Code**, not the paid API, so dev never burns credits (see the root `CLAUDE.md` → "Local AI dev — the free Claude-Code channel"). Two pieces are covered offline in `test/dev-shim.test.ts`:

- **Translation layer** — the pure Anthropic⇄Claude-Code mapping helpers exported by `scripts/dev-claude-shim.mjs` (system/message/file-block translation, token estimate, code-fence strip, multipart parse, usage mapping). These are the risk surface: the shim's HTTP behavior is only correct if these map the wire shapes the worker's `chat.ts` / `messages.ts` parsers expect.
- **Cred-burn GUARD** (`assertDevAiChannel`) — FAILS a dev/test config that points `ANTHROPIC_API_BASE` at `api.anthropic.com` without an explicit `AI_CHANNEL=prod` opt-in, and asserts `.dev.vars.example` ships the free-shim default (`http://127.0.0.1:8788`). This makes accidental credit-burn impossible: plain `wrangler dev` uses the free shim, and the paid API requires saying so out loud.

Importing the shim for these tests is side-effect free — the HTTP server only binds its port when the file is run directly (`npm run dev:shim`), never on import.

## Optional token-savings diagnostic

`scripts/verify-caching.mjs` (`npm run verify:caching`) proves prompt caching
engages against a DEPLOYED worker. It is an integration check — it needs the
network, a valid master `X-Personalizer-Context-ID`, and a reachable `/chat` +
`/files` target — so it is deliberately OUT of `vitest run`.

**What it asserts.** Two identical requests for each of the two cached prefixes
the worker's cost reduction depends on; the second call must read from cache:

1. **chat tools+system prefix (Opus 4.8)** — `TOOL_DEFINITIONS` + the
   `buildSystem` base block. Two identical `/chat` calls; call 2 must report
   `cache_read_input_tokens > 0`. Live-measured: `cache_read = 1351`.
2. **placement file-block prefix (Haiku 4.5)** — an HTML file uploaded via
   `/files` and referenced by `fileId`. Call 1 writes the cache
   (`cache_creation_input_tokens > 0`), call 2 reads it
   (`cache_read_input_tokens > 0`). Live-measured: `cache_creation ≈ 23217` on
   call 1, the same value as `cache_read` on call 2. Same bytes map to the same
   `file_id` via the `/files` content-hash dedup, so both calls hit one cache
   entry.

It fails loudly: a `cache_read` of 0 on a repeat call throws as a regression;
missing creds or an unreachable target throws with setup instructions. There is
no silent skip.

**How to run.** All configuration is EXPLICIT — the script carries no default
target and no default fixture path (No Hardcoded Config Values,
[CODE-PATTERNS.md](CODE-PATTERNS.md)); a missing variable throws, naming it:

```bash
# Target + context-ID, both required:
APP_AI_TARGET=https://app-ai.personalizer.io \
APP_AI_CONTEXT_ID=<master-context-id> \
  npm run verify:caching

# Or point at a shop-context fixture JSON instead of a raw id:
APP_AI_TARGET=https://app-ai.personalizer.io \
APP_AI_CONTEXT_FILE=/tmp/storefront-test/shop-context.<dev-store>.myshopify.com.json \
  npm run verify:caching
```

**Configuration** (all explicit, no defaults):

- `APP_AI_TARGET` (required) — the deployed worker base URL to gate.
- `APP_AI_CONTEXT_ID`, or `APP_AI_CONTEXT_FILE` pointing at a shop-context
  fixture JSON (`{ "contextID": ... }`). The lib E2E suite mints these from a
  master login; context-IDs are subscriber-scoped, so the gate runs against the
  dev store that login owns.

**Sample passing output:**

```
[1/2] chat tools+system prefix (Opus 4.8)
  call 1: input=85 cache_creation=0 cache_read=1351
  call 2: input=85 cache_creation=0 cache_read=1351
  ✓ chat tools+system prefix: cache engaged (call 2 cache_read=1351 > 0)

[2/2] placement file-block prefix (Haiku 4.5)
  uploaded fixture → file_...
  call 1: input=3 cache_creation=23217 cache_read=0
  call 2: input=3 cache_creation=0 cache_read=23217
  ✓ placement file-block prefix: cache engaged (call 2 cache_read=23217 > 0)

CHECK PASSED — both cached prefixes engage against the deployed worker.
```

## Why the diagnostic is manual / dispatch-only

The diagnostic needs deployed-worker access, Anthropic billing, and a master
context-ID. It is intentionally optional and is not part of push-CI or release
readiness. Two ways to invoke it when useful:

- **Manual diagnostic** — run `npm run verify:caching` against the deployed
  worker when investigating or measuring prompt-cache behavior.
- **GitHub Actions** (`.github/workflows/verify-caching.yml`) — a
  `workflow_dispatch` job guarded on the `APP_AI_CONTEXT_ID` + `APP_AI_TARGET`
  repo secrets. When either is absent (forks, unconfigured repos) the guard
  step exits the job cleanly so nothing fails; when both are present, it runs
  the diagnostic. It is never wired into the required push/PR `build` job.
