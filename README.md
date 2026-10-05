# App AI Service

Cloudflare Worker that provides context-validated, prompt-grouped inference for LimeSpot applications. Production routes use Anthropic except the protected-CI visual judge, which uses the configured Cloudflare Workers AI vision binding within its free daily allocation. OpenAI Responses, Moonshot/Kimi Chat Completions (the metered platform and Kimi Code subscription accounts), and Gemini `generateContent` adapters are implemented as dormant candidates pending evaluations.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create a `.dev.vars` file for local development (gitignored) from the committed
example, then fill in your API key:

```bash
cp .dev.vars.example .dev.vars
```

Get your API key from [Anthropic Console](https://console.anthropic.com/) → API Keys.
`.dev.vars` carries every local configuration value (Personalizer/provider origins,
CORS allowlist, model choices, and provider keys) — the worker throws on a selected missing variable,
naming it; there are no fallback defaults (see docs/CODE-PATTERNS.md → "No
Hardcoded Config Values").

**Note:** `.dev.vars` is gitignored and never committed. Production uses
`wrangler.toml` `[vars]` + Cloudflare encrypted secrets.

### 3. Start Development Server

Local dev fulfils inference through **Claude Code** by default (free — no Anthropic
API credits), via a local Anthropic-compatible shim. `.dev.vars.example` already
defaults `ANTHROPIC_API_BASE` to the shim, so the standard flow is two processes:

```bash
npm run dev:shim   # free local AI channel on :8788 (Claude Code by default)
npm run dev        # wrangler dev on :8787 → routes Anthropic traffic to the shim
```

Claude Code fulfilment is free but slow, so the shim records each response to
disk and replays a repeated identical call instead of re-running the model. It is
ON by default — `SHIM_CACHE=0` opts out and fulfils everything fresh. Because a
replayed answer is byte-for-byte the fresh one, the shim always says which it
gave you: every response carries `x-dev-shim-cache: hit | miss | off`, and
`GET /health` reports the cache's state plus running hit/miss/record counts (per
process, never reset — read it either side of a run and subtract). The shim log
also prints `cache HIT` / `cache MISS` / `cache RECORD` per call. Entries live in
the gitignored `.dev-cache/claude-shim/` (`SHIM_CACHE_DIR` overrides it); delete
the directory or use `SHIM_CACHE_RESET=1` to invalidate.

Server runs at `http://localhost:8787`. See [CLAUDE.md](CLAUDE.md) →
"Local AI dev — provider-neutral Claude Code/Codex fulfillers" for how it works, the
tool bridge (`LS_DEV_CONTEXT_ID`), the response cache's key derivation and its one
limitation, and the cred-burn guard. Using the real, paid API from local requires the
relevant official provider base **and** `AI_CHANNEL=prod` (the guard blocks it
otherwise) — prod-only by policy.

For one-shot visual/structured prompts, set `LOCAL_AI_FULFILLER=codex` and an
explicit `CODEX_LOCAL_MODEL`, then start the same shim. This runs `codex exec`
ephemerally with a read-only sandbox, image files, JSON output schema, parseable
JSONL usage, cancellation, and no inherited user/project instructions or
configuration. It also disables Codex shell/web/plugin/subagent/app-connector/
dependency-install tools and exposes only a minimal child environment. Saved
authentication is forced to ChatGPT by default; using `CODEX_API_KEY` requires
`AI_CHANNEL=prod`. It rejects streaming and tools; use Claude Code for full
`/chat` behavior.

Local `LOG_TARGETS_*` values route every level to the terminal and private Seq, and `npm run dev`
mirrors terminal output to `app-ai-dev.log`. Inference TRACE records include the selected prompt,
complete model-visible text/tool input, redacted file-block structure, assistant output, tool
execution, status, usage, and elapsed time. Opaque file IDs, encoded media, continuation state,
and request context IDs are removed; request/subscriber IDs remain for private correlation. Follow
a run with:

```bash
tail -f app-ai-dev.log | grep InferenceTrace
```

Set `APP_AI_DEV_LOG_FILE` to choose another path. Logging policy is entirely configuration-driven:
each `LOG_TARGETS_<LEVEL>` accepts `ignore`, `console`, `seq`, or a comma-separated fan-out.
`LOG_SEQ_INGEST_URL` selects the CLEF endpoint and optional `LOG_SEQ_API_KEY` authenticates when
required. Seq delivery failure never fails or delays inference. Production routes only error/fatal
to Seq and emits no application console logs.

### 4. Test

```bash
# Health check
curl http://localhost:8787/health

# Expected response:
# {"status":"ok","message":"App AI service is running","timestamp":"..."}
```

## API Endpoints

Normal protected endpoints require `X-Personalizer-Context-ID`. The extension audit has a separate one-time activation/session path documented in [docs/AUDIT-AUTH.md](docs/AUDIT-AUTH.md).

| Method | Endpoint                  | Description                             | Auth Required  |
| ------ | ------------------------- | --------------------------------------- | -------------- |
| GET    | `/health`                 | Health check                            | No             |
| POST   | `/audit/session/exchange` | Exchange a website activation JWT       | Activation JWT |
| GET    | `/audit/session`          | A Grader session's standing, read-only  | Audit bearer   |
| POST   | `/files`                  | Prompt-aware direct provider upload     | Yes            |
| DELETE | `/files/{id}`             | Delete one opaque file reference        | Yes            |
| POST   | `/messages`               | Registered prompt completion            | Yes            |
| POST   | `/chat`                   | Studio AI chat agent loop (SSE + tools) | Yes            |
| GET    | `/prompts`                | Prompt/model routing diagnostics        | Master only    |

A master context-ID reaches `GET /prompts` through the `X-Personalizer-Context-ID`
header or a `personalizerContextId` query parameter; every other route reads the
header only.

Scoped `ls_audit_…` sessions may use only `POST /files`, proposal-only `POST
/messages`, and — under plan version 2 — the `grader-chat` sales chat on `POST /messages`, plus the
read-only `GET /audit/session`, which reserves and writes nothing. They are
bound to the activated store, atomically quota-controlled
by an audit-keyed `AuditSessionAuthority`, never call Brain, and cannot delete files or use
`/chat`. A session lasts 30 days, and two dated kill switches, `GRADER_RUNS_VALID_FROM` and
`GRADER_EXTENSION_BUILT_AFTER`, end older runs and older extension builds. The exact public/staff
entitlement claims, headers, limits, kill switches, and signed website-status callback contract are
in [docs/AUDIT-AUTH.md](docs/AUDIT-AUTH.md).

### `POST /files` — prompt-aware direct upload

Send multipart form data with exactly one `file` part and one or more repeated
`prompt` string parts. Every prompt must be registered. app-ai resolves all
prompt-group routes before provider I/O, uploads each unique route directly,
and retains metadata only—never the uploaded bytes.

Every success returns one shape: `{ "id": "<opaque>", "type": "file",
"references": { "<prompt>": { "id": "<opaque>", "type": "file" }, … } }`. The
`references` map is keyed by every declared prompt and the top-level `id`
belongs to the first prompt. Declared prompts that share a route share one
reference, so an upload resolving to a single route names them all against the
same value. Callers must treat every ID as opaque and send the reference the map
holds for the inference prompt that will consume it.

Anthropic deletes every uploaded object 30 days after the upload. A reference
stays openable for at most 15 days and always ends before its object does.

### `DELETE /files/{id}` — one reference at a time

The reference IS the route. `DELETE /files/{id}` takes an opaque reference
minted by `POST /files` and reads the provider, tenant, and upstream object id
out of the token itself; a reference belonging to another tenant is refused with
403, and one whose route has since been configured onto another provider with 409.

No verb enumerates a provider account. One account holds every tenant's
uploads, so a listing could only answer with files this caller never uploaded;
`GET /files` is not a route and falls through to the router's 404
`RecordNotFoundException`.

### `GET /prompts` — routing diagnostics (master only)

Because a prompt's provider is inferred from the configured model id, what a
deployment actually routes each prompt to is a property of that deployment. This
endpoint answers it without running an inference: per registered prompt, its
group, capability tier, resolved model, provider, API family, file policy,
declared capability requirements, and whether the resolved model honours inline
cache breakpoints, plus whether the route validates and why it does not. It also lists the NAMES of required secrets that are still blank —
never a value, a prefix, or a length.

It validates the context-ID like every other protected route and then requires
the resolved `SubscriberID` to equal `MASTER_SUBSCRIBER_ID`. Any other validated
merchant receives the router's unknown-route answer (404
`RecordNotFoundException`) byte for byte, so the endpoint cannot be confirmed to
exist. Scoped audit sessions never reach it.

It takes that context-ID from either of two positions, and the master gate is
identical in both:

```
curl -H 'X-Personalizer-Context-ID: <master-context-id>' https://<worker>/prompts
https://<worker>/prompts?personalizerContextId=<master-context-id>
```

The header wins whenever a request carries both. The query form exists so an
operator can open the diagnostics in a browser — and a credential in a URL is
visible to browser history, bookmarks, and any intermediary that records URLs,
so it is a master-operator convenience, never the form automation uses. app-ai
strips the value of a credential-bearing query parameter from every log record
(`src/lib/logger.ts`), which covers this worker's sinks and nothing upstream of
it.

### `POST /chat` — Studio AI agent runtime

The Studio AI runtime for LimeSpot Studio. Runs the Anthropic
tool-use **agent loop** (model ↔ tool iterations, capped at `MAX_ITERATIONS`=8)
and streams the result as **Server-Sent Events**. The endpoint's tool surface
is composed per request by the toolset registry (`src/toolsets/registry.ts`)
from the validate-context-id response. Platform toolsets are selected from
available integration parties. The four Personalizer data tools are selected
only from exact `AvailableAiTools` names when `AiToolsContractVersion` is `1`;
missing and unknown versions fail closed. See [docs/TOOLSETS.md](docs/TOOLSETS.md).
The personalizer toolset dispatches
tool calls server→server to Personalizer — the read-only AI tool proxy
(`/v2/ai-tools/*`) for the data-query tools, the per-record admin endpoints
(`src/toolsets/personalizer/entity-context.ts`) for `get_entity_context`
record derefs — forwarding the merchant's `X-Personalizer-Context-ID`. The
registry also holds the four platform toolsets (`shopify`, `bigcommerce`,
`klaviyo`, `google-ads`) — transparent passthroughs to the merchant's platform
APIs through Personalizer's integration bridge (`v2/integration-bridge/*`): app-ai
resolves only a call channel (context-ID + the `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` Workers
Secret), never a platform token, and the `X-Ls-Integration-Bridge-Error` response header
discriminates platform responses (surfaced verbatim to the model, any status)
from LimeSpot-layer failures (degraded). No endpoint allowlist names the
platform toolsets. The Anthropic key never leaves the worker.

- **`X-Personalizer-System-Prompt`** selects the server-side prompt by NAME; `chat`
  is the default. Which names are valid is the registry in `src/prompt-registry.ts`,
  read there rather than listed here.
- **`Accept: text/event-stream`** → SSE (events: `text`, `tool_call`,
  `tool_result`, `done`, `error`). Otherwise → a single JSON object (same shape
  as the `done` payload).
- Request body: `{ messages, context?, max_tokens?, fileIds?, continuation? }`.
  Continuation values are authenticated opaque tokens bound to the validated
  tenant and resolved prompt route. They accompany browser-tool handoffs and
  provider-required ordinary turns (Gemini thought signatures); echo them
  unchanged only on the matching follow-up turn.
  `messages` is the full history the client wants the model to see (the client
  owns history; persistence lives in Personalizer). `context` carries grounding
  (`hostPage`, validated placement `candidates`, best-practice `grounding`,
  entity `refs`).
- **Referencing (`context.refs`)** — a capped list of entity references anchoring
  the chat to specific entities. The wire shape, the cap, and the valid type
  literals are declared in `src/lib/references.ts`. Record refs are eagerly resolved worker-side
  by `src/toolsets/personalizer/entity-context.ts`: per-refType fetchers over Personalizer's per-record
  admin endpoints (discount/html/image campaigns, subscriber segments,
  progress-bar campaigns, plus `v2/accounts/subscriber` for the tenant
  re-check and currency), normalized into the frozen `AiToolEntityContext`
  shape. Analytics refs resolve from their own `metadata` (no Personalizer call). The
  results render as the frozen `## Referenced Entities` system block (final,
  uncached; a failed ref degrades to `(could not load)`), and the
  `get_entity_context` tool lets the model re-deref any referenced entity
  mid-conversation. Block grammar + dispatch table: `src/lib/references.ts`
  and the lib repo CONTRACTS.md §8. Requests without refs are unaffected.

The frozen cross-repo contract is in the lib repo at
`packages/storefront/src/admin/ai/CONTRACTS.md` (§1 SSE protocol, §2 tools,
§8 referencing). Source: `src/handlers/chat.ts` (agent loop + SSE),
`src/toolsets/` (toolset registry + the personalizer toolset's tool defs,
Personalizer dispatch, and entity-context normalizer), `src/lib/references.ts` (refs
intake + Referenced-Entities block), `src/prompt-registry.ts` (system prompts).
Tests: `test/chat.test.ts`, `test/ai-tool-capabilities.test.ts`, `test/toolsets.test.ts`,
`test/platform-toolsets.test.ts`, `test/references.test.ts` (`npm test`).

### Headers

- **`X-Personalizer-Context-ID`** (required for protected endpoints): Authentication token validated against Personalizer API
- **`X-Personalizer-System-Prompt`** (optional): System prompt name (e.g., "image-selection")

### Example Request

```bash
curl -X POST http://localhost:8787/messages \
  -H "Content-Type: application/json" \
  -H "X-Personalizer-Context-ID: your-context-id" \
  -H "X-Personalizer-System-Prompt: image-selection" \
  -d '{
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

Registered selectors take model and output policy from the prompt registry. If
the response includes an opaque `continuation`, echo it unchanged as the
top-level `continuation` field on the matching next `/messages` request; Gemini
routes require this to preserve the assistant's thought signatures. Unknown
selectors take the bounded Anthropic-wire passthrough body.

A caller whose network may drop a request that receives no reply bytes for a
while adds `"responseMode": "keep-alive"` to the JSON body. app-ai then answers
200 at once, writes a whitespace byte every
`MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS` while the request runs, and ends with
`{ "responseMode": "keep-alive", "status": <n>, "result": <body> }`, or `"error":
<Brain error envelope>` in place of `result` when the status is not a 2xx. The
status and body are those the plain answer would carry. app-ai reads the field
only once the caller has authenticated and begins the keep-alive answer only once
the request is authorized, so a request refused before then — a missing or
invalid credential, or a Grader body over its size limit or outside its shape —
is answered with its own status and plain error body. A request without the field
is answered exactly as before ([docs/DECISIONS.md #36](docs/DECISIONS.md)).

## Development

### Local Setup

```bash
# Start dev server
npm run dev

# Watch logs
# (logs appear in same terminal)

# Test endpoints
curl http://localhost:8787/health
```

### File Structure

The folder-by-folder map of `src/` — which module owns what — is
[docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md), and what each spec covers is
[docs/TESTING.md](docs/TESTING.md). Both are kept beside the code they describe rather than
copied here, because a second copy of a tree drifts silently. Architecture detail and the
invariants that hold the layout together live in [CLAUDE.md](CLAUDE.md).

### Environment Variables

All configuration is read through the typed accessors in
[src/config.ts](src/config.ts) — one `Env` interface, fail-fast on a missing
variable, no fallback defaults.

**Local Development:**

- Everything in `.dev.vars` (gitignored; overrides `[vars]` under
  `wrangler dev`). Copy [.dev.vars.example](.dev.vars.example) — it lists every
  binding the worker reads, grouped and marked REQUIRED or OPTIONAL, with every
  secret left blank for you to fill in. `test/config.test.ts` derives the
  inventory from the typed `Env`, so a new binding cannot be added without being
  documented there.

**Production:**

- Public config in `wrangler.toml` `[vars]`: `ENVIRONMENT`, `PERSONALIZER_API_URL`,
  the provider origins `ANTHROPIC_API_BASE` / `OPENAI_API_BASE` / `MOONSHOT_API_BASE` /
  `KIMI_API_BASE` / `GEMINI_API_BASE`, the Kimi evidence limit
  `KIMI_EVIDENCE_MAX_BYTES` / `KIMI_EVIDENCE_MAX_TOTAL_BYTES` / `KIMI_EVIDENCE_MAX_TEXT_BYTES`, `CREDENTIALED_ORIGINS`, `MASTER_SUBSCRIBER_ID`, the
  tier→model bindings `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER` and their sparse
  per-prompt `MODEL_OVERRIDES` exceptions, plus `LOG_TARGETS_*` and
  `LOG_SEQ_INGEST_URL`, `AUDIT_STATUS_ORIGINS`, plus the `AUDIT_*` session/quota limits (values pinned by `test/config.test.ts`)
- Secrets set via Cloudflare Dashboard:
  - Workers > app-ai > Settings > Variables > Encrypt
  - Add `CLAUDE_API_KEY` as encrypted secret
  - Add `OPENAI_API_KEY` before configuring an OpenAI model or smoke-testing one
  - Add `MOONSHOT_API_KEY` before configuring a metered Moonshot/Kimi model or smoke-testing one
  - Add `KIMI_API_KEY` before configuring a Kimi Code subscription model or smoke-testing one
  - Provision the private `app-ai-inline-evidence` R2 bucket and its preview bucket before deploying this configuration. Apply a 16-day expiry lifecycle to the `inline-evidence/v1/` prefix; app-ai refuses references after 15 days and deletes its own objects when the caller deletes a reference.
  - Add `GEMINI_API_KEY` before configuring a model in the Gemini family
  - Add `TOKEN_ENCRYPTION_SECRET` as encrypted secret (exactly 32 random bytes encoded as base64,
    the HKDF root for every app-ai-sealed token; rotating it invalidates outstanding opaque file
    references and continuation tokens)
  - Add `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` as encrypted secret (the platform toolsets'
    caller-auth token toward Personalizer's integration bridge)
  - Add distinct `AUDIT_ACTIVATION_SIGNING_SECRET`, `AUDIT_SESSION_SIGNING_SECRET`, and
    `AUDIT_STATUS_SIGNING_SECRET` values containing at least 32 random bytes each; allowlist
    the website's callback origins in `AUDIT_STATUS_ORIGINS`
  - Optionally add `LOG_SEQ_API_KEY` when the Seq endpoint requires authentication

### Updating System Prompts

Each system prompt is a **registry entry** in [src/prompt-registry.ts](src/prompt-registry.ts) whose
TEXT lives under [src/prompts/](src/prompts/) — the ONE and only prompt location. The registry
maps each name to its text and metadata (`SystemPromptEntry` in that file is the source of truth for the fields) and is
the single source of truth for each prompt's tier / token / tool choices (consumed by both
`handlers/chat.ts` and `handlers/messages.ts`). `effort` is optional — see Token-Saving below.

The registry holds 26 prompts — `/chat` agent-loop + one-shot prompts (chat, billing-assistant,
onboarding, onboarding-chat, placement, proposals, analytics-insights) and `/messages` prompts
(image-selection, visual-verify, visual-verify-free, the five Website-Analysis probes, the onboarding /
cart-drawer / optimize propose + review passes with the currency-recovery and CSS-review
specialists, and the audit session's grader-chat). The authoritative inventory — every prompt with
its shape, endpoint, tools, and role — is [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md), which
also owns the per-prompt doc-sync rule.

**Prompt-text shapes** — a prompt is one of four shapes, all resolving to the same registry
entry (full convention + inventory in [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md)):

- **Simple** → one file `src/prompts/<name>.md` (e.g. `placement.md`).
- **Multi-file** → a folder `src/prompts/<name>/` with a `prompt.md` system prompt + a
  `sample.md`-style file wired as an `attachments` entry (uploaded and prepended to the first
  message). `image-selection/` is the one attachment-carrying prompt; the five `probe-<id>/`
  folders hold just a `prompt.md`.
- **Composed** → a folder of `_`-prefixed BLOCK files assembled by `composePrompt(...)` in the
  folder's own `index.ts`, mixing that prompt's fragments with SHARED blocks from
  `src/prompts/onboarding-shared/` (the onboarding / cart-drawer / optimize propose + review
  prompts), or the Markdown chat-formatting block in `src/prompts/assistant-shared/` (`chat`;
  `grader-chat` composes its own plain-text formatting block). In a composed prompt the `_`-files ARE imported, bundled, and shipped as the system
  text; elsewhere a `_*.md` is the co-located exclusion convention (never imported).
- **Shared-text alias** → an explicit barrel export reuses another registered prompt's final text
  when the semantic contract is identical but routing or access is intentionally different.
  `visual-verify-free` is the only alias and keeps its own maintenance doc.

The barrel `src/prompts/index.ts` re-exports every prompt's final text; `src/prompt-registry.ts`
imports it as `prompts` and pairs each with its metadata. Per-prompt design docs live at
[docs/prompts/<name>.md](docs/prompts/) (workflow: [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md)).

To change a prompt's wording: edit its `.md` file(s) under `src/prompts/` — pure text.
To add a prompt: create `src/prompts/<name>.md` (simple), a `src/prompts/<name>/` folder
(multi-file, or composed from `_`-block files with its own `index.ts`), or an explicit shared-text
barrel alias; export its text from `src/prompts/index.ts` and add a registry entry in
`src/prompt-registry.ts`.
To change a prompt's model / token budget / whether it uses tools: edit the metadata in
`src/prompt-registry.ts`.

The `.md` files are bundled at **build time** (Workers have no runtime filesystem) — the
`[[rules]] type = "Text"` rule in `wrangler.toml` (glob `**/*.md`, so nested multi-file
prompts bundle too) makes `import x from './prompts/x.md'` resolve to the file's string
contents; `vitest.config.ts` mirrors this for tests with the same import specifier.

1. Edit the `.md` text and/or the `src/prompt-registry.ts` metadata
2. `npx vitest run` and `npm run deploy:dry-run` to verify
3. Commit and push to GitHub (auto-deploys to production)

### Token-Saving Levers

Cost-reduction is additive and never changes external request/response shapes.

**What caches, live-measured against the deployed worker** (the optional `npm run verify:caching` diagnostic can remeasure this — see [docs/TESTING.md](docs/TESTING.md)):

- **chat + onboarding (Opus 4.8):** the `tools` (TOOL_DEFINITIONS, ~6.4KB JSON)
  - `buildSystem` base block cache at **~1351 input tokens**; a repeat call reads
    the full prefix from cache (`cache_read_input_tokens: 1351`). The
    TOOL_DEFINITIONS block is what clears Opus 4.8's cacheable floor.
- **placement file blocks (Haiku 4.5) — the dominant cost and the big win:** the
  uploaded screenshot + cleaned HTML file prefix is **tens of thousands of
  tokens** (e.g. a ~24.9K-token screenshot+HTML prefix). Call 1 writes the cache
  (`cache_creation_input_tokens` ≈ the prefix size); the repeat call on the same
  page reads it at 0.1× (`cache_read_input_tokens` > 0). Same bytes map to the
  same `file_id` via the `/files` content-hash dedup, so both calls hit one cache
  entry.
- **placement _system_ prompt (~370 tokens, Haiku 4.5) is NOT cached — by
  design:** it is below Haiku's minimum cacheable prefix, so a marker would be a
  silent no-op and padding it would cost more than it saves. The placement win is
  the file blocks, not the system prompt. See [docs/DECISIONS.md](docs/DECISIONS.md) #8.

**The levers:**

- **Extended 1h prompt cache.** Stable prefixes (the system prompt, reused file
  attachments, the `/chat` base prompt block) carry `cache_control: { type: 'ephemeral', ttl:
'1h' }` (GA — no beta header). For `/messages` customization/QC calls, the client places
  `limespot_stable_cache_prefix: true` only when a caller has a genuinely stable user prefix. The
  onboarding review-all payload does not mark user evidence: it sends round-0, clean-reference, and
  current images as variable content and sends no pre-customization originals;
  the worker gives that 1h breakpoint priority within the four-slot system/attachment budget,
  removes the internal marker before Anthropic forwarding, and leaves block/file-ID order intact.
  Conversation turns use the 5-minute default. See `src/inference/cache.ts`;
  the Anthropic adapter realizes the canonical intents on its wire payload.
- **Agent-loop breakpoints.** `src/inference/service.ts` invokes the canonical
  allocator each iteration (last block + ~every-15-blocks); the stable prefix
  reserves the remaining Anthropic parity budget.
- **Prompt-aware direct upload + checksum dedup.** `POST /files` carries one `file` and one or
  more repeated registered `prompt` fields. app-ai resolves every destination route first,
  uploads unique tenant/provider/account/policy/group routes in parallel, and returns random opaque
  authenticated encrypted references bound to a keyed pseudonym of the validated context ID.
  Registered/canonical inference rejects raw provider IDs; the bounded unregistered-selector
  `/messages` passthrough refuses raw file blocks and resolves its own model route from the registry. `src/lib/file-dedup.ts` hashes bytes so a route
  can reuse its upstream object and retains validated MIME because OpenAI metadata omits it.
  `FILES_KV` stores metadata, never file bytes: expiring dedup records, and a non-expiring
  `discard:` key for each upload app-ai could not delete, removed once a later upload of the same
  bytes deletes that file. It can no-op without affecting reference correctness. Sealed route metadata is
  self-contained under `TOKEN_ENCRYPTION_SECRET`, avoiding eventually-consistent read-after-write.
  A dedup record's lifetime is capped at 30 days and never outlives upstream expiry. Every Anthropic
  upload asks for a 30-day expiry, and a hit is reused only while its file has at least 15 days
  left, so each reference runs its full 15 days and ends before its file.
- **`count_tokens` pre-flight.** Large `/messages` payloads log a free token estimate (warn-only;
  never gates the request).
- **Opt-in output effort (model-gated).** A registry entry may set semantic
  `effort`; the selected adapter maps or omits it for its concrete model. The
  Anthropic gate lives in `src/inference/adapters/anthropic-wire.ts`.

`FILES_KV` is bound in `wrangler.toml` (`[[kv_namespaces]]`) for best-effort dedup.
Opaque route-reference validation is self-contained and authenticated by `TOKEN_ENCRYPTION_SECRET`.
The 1h cache and placement file-block prefix can be live-measured by the optional
token-savings diagnostic (`npm run verify:caching` — see [docs/TESTING.md](docs/TESTING.md)).

### CORS Configuration

The AI endpoints carry no cookies (auth is the `X-Personalizer-Context-ID` header,
validated against Personalizer), so any merchant Origin is echoed back without credentials
(`src/lib/cors.ts`). The `CREDENTIALED_ORIGINS` configuration variable (wrangler
`[vars]` / `.dev.vars`, comma-separated) additionally permits known dev origins to send
credentialed requests — add a credentialed dev origin there, not in code.

## Deployment

### Automated Deployment (GitHub Integration)

This project uses Cloudflare's GitHub integration for automatic deployment:

- **A push to `main`** → auto-deploy to production. `main` is read-only to every agent; an operator
  performs that push, and it carries its own deploy approval.

**Setup:**

1. Connect repository to Cloudflare via dashboard
2. Configure branch-to-environment mapping (`main` → `app-ai`)
3. Under Worker `app-ai` → Settings → Build ([Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)), leave **Build command** blank and set **Deploy command** to exactly `npm run deploy`. If non-production branch builds are enabled, set their
   command to exactly `npm run deploy:preview`. Cloudflare owns these two Git
   integration settings in the dashboard and does not read them from
   `wrangler.toml`; its raw defaults bypass the required revision stamp.
4. Set the secrets in Cloudflare Dashboard:
   - Workers > app-ai > Settings > Variables > Encrypt
   - Add secrets with keys `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`,
     `KIMI_API_KEY`, `GEMINI_API_KEY`,
     `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN`, `TOKEN_ENCRYPTION_SECRET` (32 random bytes
     encoded as base64), `AUDIT_ACTIVATION_SIGNING_SECRET`,
     `AUDIT_SESSION_SIGNING_SECRET`, and `AUDIT_STATUS_SIGNING_SECRET`
   - Provision `app-ai-inline-evidence` and `app-ai-inline-evidence-preview` as private R2 buckets with a 16-day expiration lifecycle on `inline-evidence/v1/` before the worker receives the new binding. Kimi stores encrypted merchant evidence there; no public bucket route is needed.
5. Deploy the Brain `CanAdministerAllSubscribers` validation response first, then deploy this
   worker and make one authenticated `visual-verify-free` request. The live-store workflow is not
   pointed at the route until that smoke returns a parseable `{ pass, reason, fix }` verdict from
   `@cf/qwen/qwen3.8-27b`.
6. Deploy this worker before a lib that sends the `/messages` `"responseMode": "keep-alive"`
   opt-in, and roll back in the reverse order: roll the lib sender back, or remove its opt-in,
   before rolling this worker back. A worker without the keep-alive mode refuses the member on the
   strict Grader chat body
   ([docs/DECISIONS.md #36](docs/DECISIONS.md#36-a-long-messages-call-can-keep-its-connection-alive-by-the-callers-choice)).

Pushing `main` then auto-deploys through the repository launcher. The launcher
injects the checked-out Git revision; a production worker built without it
returns 503 from `/health` instead of claiming to be healthy as `buildRev: "dev"`.
Production health also requires the Workers AI binding, the protected-route kill switch, and the
strongly consistent daily-quota authority.

### Manual deployment — operator only

There is one deployed worker and no staging environment, so `npm run deploy` publishes to
**production**. It is an operator action needing its own explicit deploy approval in the turn it is
taken, and it is never an agent's: agent access to the running worker is read-only
([CLAUDE.md](CLAUDE.md) → Hard rules, `../_standards/git-and-approval.md`). The same holds for a
secret or binding change in the Cloudflare dashboard.

```bash
npm run deploy:dry-run   # builds the same revision-stamped bundle without publishing — safe
npm run tail             # read the live worker's logs — read-only
```

An operator reaches for the manual publish only when the normal `main` auto-deploy path is
unavailable — an emergency hotfix, or validating the deploy mechanism itself.

### Environments

All configured in [wrangler.toml](wrangler.toml):

- **Local** (`wrangler dev` via `npm run dev`): `http://localhost:8787`

  - Config + secrets: `.dev.vars` (gitignored; see `.dev.vars.example`)
  - Personalizer API: `http://127.0.0.1:5000` (plain HTTP — workerd's `fetch` can't
    accept nginx's self-signed cert on `https://local.personalizer.io`, so the
    local worker talks to the same Personalizer process over HTTP)

- **Production** (Cloudflare auto-deploy): `https://app-ai.personalizer.io`
  - Config: `wrangler.toml` `[vars]`
  - Secrets: Cloudflare Dashboard (encrypted)
  - Personalizer API: `https://personalizer.io`
  - Auto-deploys from `main` branch

Every environment provides the full variable set — `ENVIRONMENT`,
`PERSONALIZER_API_URL`, `ANTHROPIC_API_BASE`, `OPENAI_API_BASE`, `MOONSHOT_API_BASE`,
`KIMI_API_BASE`, `KIMI_EVIDENCE_MAX_BYTES` / `KIMI_EVIDENCE_MAX_TOTAL_BYTES` / `KIMI_EVIDENCE_MAX_TEXT_BYTES`, `GEMINI_API_BASE`,
`CREDENTIALED_ORIGINS`, the tier→model bindings `MODEL_FAST` / `MODEL_BALANCED` /
`MODEL_FRONTIER`, and the provider API keys + `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` +
`TOKEN_ENCRYPTION_SECRET` + three audit signing secrets, the `AUDIT_STATUS_ORIGINS` allowlist,
six `LOG_TARGETS_*` routes, and
`LOG_SEQ_INGEST_URL` whenever any route selects Seq. `LOG_SEQ_API_KEY` is optional.
`src/config.ts` throws on malformed or missing required configuration.

### View Logs

Production application errors and fatals are queried in private Seq. Cloudflare application console
logging is disabled by configuration. Local logs appear in the terminal and `app-ai-dev.log`, and
are mirrored to Seq by the example local routes.

## Security

### Best Practices

1. **API Keys**

   - Never commit API keys to git
   - Local: Store in `.dev.vars` (gitignored)
   - Production: Use Cloudflare encrypted secrets
   - Rotate keys regularly

2. **CORS**

   - The allow-listed first-party origins (the `CREDENTIALED_ORIGINS` config
     variable, consumed by `lib/cors.ts`) receive
     `Access-Control-Allow-Credentials: true`.
   - Other origins (embedded merchant storefronts) are echoed back **without**
     credentials, with `Vary: Origin`. These endpoints are authenticated by the
     `X-Personalizer-Context-ID` header, not cookies, so credential-less
     cross-origin access is safe and intended — the worker must serve arbitrary
     merchant domains, so a fixed allow-list is deliberately not used here.

3. **Authentication**

   - Normal protected endpoints validate the context ID against Personalizer
     before dispatch (`lib/auth.ts`). Audit exchange/session requests use the
     key-separated, one-time, scope/quota-controlled contract in
     [docs/AUDIT-AUTH.md](docs/AUDIT-AUTH.md).
   - Every error response uses Brain's wire shape
     (`{ "Message": ..., "ExceptionType": ..., "MessageDetail": ... }`) — app-ai
     errors are structurally identical to Brain errors, so clients keep one
     parser. A missing context-ID is a **401 `MissingContextIDException`**; a
     Brain rejection relays Brain's own status + body unchanged; an unreachable
     Brain is a **500 `BrainUnreachableException`**. See
     [docs/DECISIONS.md](docs/DECISIONS.md) #7.

4. **Input Validation**
   - File upload size limits enforced
   - Request payloads validated
   - Appropriate error codes returned

### Development Dependencies

Some npm audit warnings exist for development dependencies (esbuild, vite). These are:

- **Not in production** (dev-only tools)
- **Not critical** (development server vulnerabilities)
- **Mitigated** by not exposing dev server to internet

**For production:** No action needed - vulnerabilities don't affect deployed workers.

### Security Checklist

Before deploying:

- [ ] API keys set as Cloudflare encrypted secrets (not in code)
- [ ] `.dev.vars` is gitignored
- [ ] CORS origins restricted to production domains
- [ ] No sensitive data in logs
- [ ] Context validation working
- [ ] `AUDIT_SESSIONS` binding/migration, all three audit signing secrets, and the status-callback origin allowlist provisioned
- [ ] Website/app-ai activation claims and signed status callback pass cross-repository contract tests
- [ ] Website verification/rate limits/daily cap and the provider budget kill switch tested
- [ ] Dependencies updated

## Troubleshooting

### Port 8787 already in use

```bash
lsof -i :8787
kill -9 <PID>
```

### API key not working

- Check `.dev.vars` file exists with `CLAUDE_API_KEY`
- Verify API key starts with `sk-ant-api03-`
- Ensure no extra spaces or quotes in `.dev.vars`
- Restart dev server after changes

### Opaque file reference configuration

- Set `TOKEN_ENCRYPTION_SECRET` in `.dev.vars` and as a Cloudflare encrypted secret.
- It must be exactly 32 random bytes encoded as base64 (`openssl rand -base64 32`).
- Rotating it invalidates outstanding opaque file references; their maximum lifetime is 15 days.

### CORS errors

- Verify the app origin is in the `CREDENTIALED_ORIGINS` config variable (wrangler `[vars]` / `.dev.vars`)
- Restart dev server after changes
- Check browser console for specific error

### Context validation failing

- Verify context ID is valid in Personalizer API
- Check `PERSONALIZER_API_URL` environment variable
- Review validation logs in worker output

### Deployment issues

```bash
# Check account ID in wrangler.toml
wrangler whoami

# Verify configuration
cat wrangler.toml | grep -A3 "\[vars\]"

# Check deployment logs
wrangler tail
```

## Commands Reference

```bash
# Development
npm run dev              # Start local server (port 8787; config from .dev.vars)
npm run test             # Run tests (watch); one-shot: npx vitest run
npm run typecheck        # tsc --noEmit (strict)
npm run lint             # ESLint over the whole repo
npm run format-check     # Prettier check (exclusions documented in .prettierignore)
npm run deploy:dry-run   # Build the revision-stamped bundle without deploying

# Deployment (operator only — see "Manual deployment")
npm run deploy           # PUBLISHES TO PRODUCTION
npm run deploy:preview   # Upload a revision-stamped non-production version

# Monitoring (read-only)
npm run tail             # View production logs

# Maintenance
npm run update-deps      # Update dependencies and run audit fix
npm audit                # Check security
wrangler whoami          # Check authentication

# Note: production deploys automatically when an operator pushes `main`
```

## Platform Details

### Cloudflare Workers

- **Runtime:** V8 Isolates (not Node.js) — Web-standard `fetch` / `Request` /
  `Response` / `FormData`, no Node APIs, no runtime filesystem.
- **APIs:** Web Standards (fetch, Request, Response, FormData)
- **Limits:** 50,000ms CPU time per request (configured in `wrangler.toml`).
- **Deploy:** `main` auto-deploys to production via Cloudflare's GitHub
  integration (see [docs/DECISIONS.md](docs/DECISIONS.md) #6).

## Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [Anthropic API Docs](https://docs.anthropic.com/)
- [Personalizer API](https://personalizer.io)

## Project Docs

- [CLAUDE.md](CLAUDE.md) — architecture + the documentation-propagation rule
- [CONTRIBUTING.md](CONTRIBUTING.md) — commit convention, the push-to-main
  deploy rule, the validate-before-push loop
- [docs/CODE-PATTERNS.md](docs/CODE-PATTERNS.md) — coding standards (strict
  TypeScript, clean code, error handling, No Hardcoded Config Values)
- [docs/TESTING.md](docs/TESTING.md) — the required offline gate set and the
  optional live token-savings diagnostic
- [docs/QC-OBSERVABILITY.md](docs/QC-OBSERVABILITY.md) — adaptive QC telemetry,
  latency SLO measurement, and the zero-critical-false-pass release gate
- [docs/DECISIONS.md](docs/DECISIONS.md) — numbered decision log
- [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — current limitations
- [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md) — prompt
  authoring/iteration workflow
- [docs/TOOLSETS.md](docs/TOOLSETS.md) — toolset standards: the registry, the
  credential seam + security standards, the platform toolsets
- [docs/ARCHITECTURE-MAP.md](docs/ARCHITECTURE-MAP.md) — the folder-by-folder map of `src/` and
  the registered-prompt table
- [docs/AUDIT-AUTH.md](docs/AUDIT-AUTH.md) — extension audit claims, entitlement, scope, quotas,
  and the signed website status callback
- [docs/PROMPT-GROUPS.md](docs/PROMPT-GROUPS.md) —
  the prompt inventory and evidence-reuse graph
- [docs/MULTI-PROVIDER-DELIVERY.md](docs/MULTI-PROVIDER-DELIVERY.md)
  — the delivered multi-provider system and what a production route change must prove
- [docs/prompts/](docs/prompts/) — per-prompt design/maintenance docs
  (e.g. [image-selection.md](docs/prompts/image-selection.md))

---

**Platform:** Cloudflare Workers (V8 Isolates)
**Live surface:** `/files` + `/messages` serve the scoped extension audit sessions in
production; production Studio carries no app-ai client, and a Studio build that ships
one reaches `/files`, `/messages`, and `/chat`.
**Deploy:** pushing `main` deploys to production — an operator action carrying its own deploy
approval; `main` is read-only to every agent.
