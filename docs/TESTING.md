# Testing — app-ai

**Parent:** [../CLAUDE.md](../CLAUDE.md)

The worker has five test layers. Each catches a different class of bug. The
first four are offline tests in the default `vitest run` set; the fifth is a
live integration gate run as a pre-release step.

## Layers

| Layer                  | Files                                                                                                           | Network | Catches                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                   | `test/token-saving.test.ts` (pure-fn cases)                                                                     | Mocked  | Logic bugs in lib functions: `sha256Hex`, breakpoint placement, `supportsEffort`                                                                                                                                     |
| Integration (handler)  | `test/chat.test.ts`, `test/proxy.test.ts`, `test/toolsets.test.ts`, `test/platform-toolsets.test.ts`            | Mocked  | Handler wiring: agent loop, SSE protocol, MAX_ITERATIONS, prompt selection, dedup KV, toolset composition/allowlist/credential seam, integration-bridge wire shapes + `X-Ls-Integration-Bridge-Error` discrimination |
| Contract               | the SSE/tool-shape assertions in `test/chat.test.ts` + the tool-definitions snapshot in `test/toolsets.test.ts` | Mocked  | Drift between the worker's wire shapes and lib `ai/CONTRACTS.md` (§1 SSE, §2 tools)                                                                                                                                  |
| Fitness (architecture) | `test/architecture.test.ts`, `test/config.test.ts`                                                              | Static  | Invariant erosion: an endpoint bypassing its toolset allowlist, credentials reaching logs/model context, a bespoke error envelope, a hardcoded URL or inline config fallback, production `[vars]` drift              |
| Token-savings gate     | `scripts/verify-caching.mjs`                                                                                    | LIVE    | Prompt caching silently failing to engage against the deployed worker                                                                                                                                                |

The unit / integration / contract layers mock `fetch` and `env` — no real
network, no credentials. They run on every push and PR (`.github/workflows/ci.yml`).

## Test-layer doctrine

Pick the lowest layer that captures the bug:

1. **Unit first** — is it a pure function (a hash, a breakpoint calc, a model
   capability check)? Add a case to the relevant `describe` in
   `test/token-saving.test.ts`. Fastest, no handler plumbing.
2. **Integration next** — does it involve a handler driving the Anthropic client
   or Personalizer dispatch (the agent loop, SSE framing, attachment injection,
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
5. **Token-savings gate last** — does the bug only manifest against real
   Anthropic caching behavior (a cached prefix that stops engaging)? That can't
   be mocked meaningfully — it's the live gate below.

## No silent skips

A test never `it.skip()`s because an env var or fixture is missing. If a
precondition is absent, the test (or the gate) THROWS with an actionable
message:

- The caching gate throws if no master context-ID is available — naming the env
  var to set and the fixture path to provide (see below).
- The caching gate throws if a deployed-worker call returns a non-2xx or a
  Brain-shaped error body (`{ Message, ExceptionType, ... }`).

A skipped test is invisible in CI green. A louder red is the trade we make.

## Running the offline suite

```bash
npx vitest run          # one-shot: unit + integration + contract + fitness
npm test                # watch mode
npm run typecheck       # tsc --noEmit (strict; must be 0)
npm run lint            # ESLint over the whole repo (src, test, scripts/, configs)
npm run format-check    # Prettier check (whole repo; exclusions + rationale in .prettierignore)
npx wrangler deploy --dry-run   # build the bundle (verifies imports + the .md Text rule)
```

## The token-savings gate (pre-release)

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
APP_AI_CONTEXT_FILE=/tmp/storefront-test/shop-context.lsdev1.myshopify.com.json \
  npm run verify:caching
```

**Configuration** (all explicit, no defaults):

- `APP_AI_TARGET` (required) — the deployed worker base URL to gate.
- `APP_AI_CONTEXT_ID`, or `APP_AI_CONTEXT_FILE` pointing at a shop-context
  fixture JSON (`{ "contextID": ... }`). The lib E2E suite mints these via the
  `aidin@limespot.com` master login; context-IDs are subscriber-scoped, so the
  gate targets the `lsdev1` dev store.

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

GATE PASSED — both cached prefixes engage against the deployed worker.
```

## Why the gate is a manual / dispatch step, not push-CI

The gate needs deployed-worker access, Anthropic billing, and a master
context-ID. Plain push-CI has no secrets, so the gate cannot run there
truthfully. Two paths:

- **Manual pre-release step** — run `npm run verify:caching` against the deployed
  worker before cutting a release (this is the required gate).
- **GitHub Actions** (`.github/workflows/verify-caching.yml`) — a
  `workflow_dispatch` job guarded on the `APP_AI_CONTEXT_ID` + `APP_AI_TARGET`
  repo secrets. When either is absent (forks, unconfigured repos) the guard
  step exits the job cleanly so nothing fails; when both are present, it runs
  the gate. It is never wired into the push/PR `build` job, because that job
  has no secrets and a faked step would be a lie.
