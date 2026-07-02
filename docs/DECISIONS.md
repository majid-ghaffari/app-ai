# Decisions — app-ai

**Parent:** [../CLAUDE.md](../CLAUDE.md)

Architectural decisions for the worker, with rationale. Present-tense — each
entry describes the choice that stands and why, not a change history.

### 1. Superseded by #11 (strict TypeScript).

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
registry (`prompts.ts`) imports each as a string. Workers have no runtime
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

This is verified live by the token-savings gate (see [TESTING.md](TESTING.md)).

### 10. AI tools live in named toolsets behind a registry

The AI-tool layer is organized as named TOOLSETS (`src/toolsets/<name>/`), one
per backend, each encapsulating its Anthropic tool definitions, its
dispatch/executors, its normalizers, and its degrade conventions. A registry
(`src/toolsets/registry.ts`) composes the active toolsets per request from an
explicit per-endpoint allowlist; handlers consume tools only through the
composition, so adding a toolset never edits handler logic. Each toolset
resolves its own backend credentials through a per-request seam
(`resolveCredentials`) under fixed security standards: per-request,
subscriber-scoped, never model-visible, never logged. The one registered
toolset is `personalizer` (backend = Brain / the Personalizer API; credentials
= the forwarded context-ID). Planned platform toolsets (`shopify-core`,
`bigcommerce-core`, `google`, `klaviyo` — per-subscriber tokens from Brain's
`SubscriberIntegrationConfig`) are pure additions through the same seams; the
secure token-sharing mechanism is an open future design, deliberately not
specified yet. The model-visible tool contract (names, input schemas, output
shapes) is frozen regardless of module layout — pinned by the lib repo's
`admin/ai/CONTRACTS.md` §2 and the contract snapshot in
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
typed `Env` in `src/config.ts`: `BRAIN_API_URL`, `ANTHROPIC_API_BASE`,
`CREDENTIALED_ORIGINS`, `MODEL_DEFAULT`, `MODEL_PLACEMENT` in wrangler.toml
`[vars]` (production) / `.dev.vars` (local; documented in the committed
`.dev.vars.example`), and the `CLAUDE_API_KEY` secret in Cloudflare encrypted
secrets / `.dev.vars`. **A missing variable throws, naming the variable and
its channel — there are no fallback defaults**, because a fallback silently
turns a deployment mistake into wrong routing (a worker quietly talking to the
wrong Brain is worse than a loud 500). The classification line: frozen
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
