# App AI Service

Cloudflare Worker that provides secure access to Anthropic's Claude API with context validation and system prompt management for LimeSpot applications.

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
`.dev.vars` carries EVERY local configuration value (Personalizer URL, Anthropic origin,
CORS allowlist, model choices, the key) — the worker throws on a missing variable,
naming it; there are no fallback defaults (see docs/CODE-PATTERNS.md → "No
Hardcoded Config Values").

**Note:** `.dev.vars` is gitignored and never committed. Production uses
`wrangler.toml` `[vars]` + Cloudflare encrypted secrets.

### 3. Start Development Server

Local dev fulfils Anthropic inference through **Claude Code** (free — no Anthropic
credits), via a local Anthropic-compatible shim. `.dev.vars.example` already
defaults `ANTHROPIC_API_BASE` to the shim, so the standard flow is two processes:

```bash
npm run dev:shim   # free Claude-Code channel on :8788 (uses your Claude Code auth)
npm run dev        # wrangler dev on :8787 → routes Anthropic traffic to the shim
```

Server runs at `http://localhost:8787`. See [CLAUDE.md](CLAUDE.md) →
"Local AI dev — the free Claude-Code channel" for how it works, the tool bridge
(`LS_DEV_CONTEXT_ID`), and the cred-burn guard. Using the real, paid API from
local requires `ANTHROPIC_API_BASE=https://api.anthropic.com` **and**
`AI_CHANNEL=prod` (the guard blocks it otherwise) — prod-only by policy.

### 4. Test

```bash
# Health check
curl http://localhost:8787/health

# Expected response:
# {"status":"ok","message":"App AI service is running","timestamp":"..."}
```

## API Endpoints

All endpoints except `/health` require `X-Personalizer-Context-ID` header for authentication.

| Method | Endpoint      | Description                             | Auth Required |
| ------ | ------------- | --------------------------------------- | ------------- |
| GET    | `/health`     | Health check                            | No            |
| POST   | `/files`      | Upload file to Claude                   | Yes           |
| GET    | `/files`      | List uploaded files                     | Yes           |
| DELETE | `/files/{id}` | Delete file                             | Yes           |
| POST   | `/messages`   | Send message to Claude (single-shot)    | Yes           |
| POST   | `/chat`       | Studio AI chat agent loop (SSE + tools) | Yes           |

### `POST /chat` — Studio AI agent runtime

The Studio AI runtime for LimeSpot Studio. Runs the Anthropic
tool-use **agent loop** (model ↔ tool iterations, capped at `MAX_ITERATIONS`=8)
and streams the result as **Server-Sent Events**. The endpoint's tool surface
is composed per request by the toolset registry (`src/toolsets/registry.ts`)
from its explicit allowlist (`['personalizer']` — see
[docs/TOOLSETS.md](docs/TOOLSETS.md)). The personalizer toolset dispatches
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

- **`X-Personalizer-System-Prompt`** selects the server-side prompt: `chat`
  (default), `onboarding`, `placement`, `proposals` (per-store onboarding setup
  proposer, tool-use), or `analytics-insights` (one-shot JSON insights over
  grounding data, no tools).
- **`Accept: text/event-stream`** → SSE (events: `text`, `tool_call`,
  `tool_result`, `done`, `error`). Otherwise → a single JSON object (same shape
  as the `done` payload).
- Request body: `{ messages, context?, model?, max_tokens?, fileIds? }`.
  `messages` is the full history the client wants the model to see (the client
  owns history; persistence lives in Personalizer). `context` carries grounding
  (`hostPage`, validated placement `candidates`, best-practice `grounding`,
  entity `refs`).
- **Referencing (`context.refs`)** — up to 5 entity references
  (`{ type, id?, label?, metadata? }`; types `campaign` / `segment` /
  `progress-bar` / `bundle` / `analytics-metric` / `analytics-tab`) anchoring
  the chat to specific entities. Record refs are eagerly resolved worker-side
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
Tests: `test/chat.test.ts`, `test/toolsets.test.ts`,
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
    "model": "claude-opus-4-8",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

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

```
app-ai/
├── src/
│   ├── index.ts              # Entry + router only (CORS, OPTIONS, auth, dispatch)
│   ├── config.ts             # Typed Env + fail-fast config accessors (the ONE binding reader)
│   ├── types/markdown.d.ts   # Ambient type: .md imports resolve to raw text
│   ├── handlers/
│   │   ├── health.ts         # GET  /health
│   │   ├── files.ts          # POST/GET /files, DELETE /files/{id}
│   │   ├── messages.ts       # POST /messages (single-shot proxy)
│   │   └── chat.ts           # POST /chat (Studio AI agent loop + SSE)
│   ├── lib/
│   │   ├── anthropic.ts      # The Anthropic client (files + messages + streaming + count_tokens)
│   │   ├── auth.ts           # Context-ID validation against Personalizer
│   │   ├── cors.ts           # CORS headers
│   │   ├── responses.ts      # JSON helpers + the Brain-shaped error format ({ Message, ExceptionType, MessageDetail? })
│   │   ├── cache-control.ts  # 4-block prompt-cache management + 1h extended-TTL const
│   │   ├── agent-cache.ts    # /chat conversation-turn cache breakpoints (≤3, ~15-block intervals)
│   │   ├── file-dedup.ts     # Files API SHA-256 → file_id dedup (KV-backed, graceful no-op)
│   │   ├── references.ts     # /chat context.refs intake + Referenced-Entities system block
│   │   └── logger.ts         # Scoped console logger
│   ├── toolsets/             # AI-tool layer: named toolsets + registry (docs/TOOLSETS.md)
│   │   ├── registry.ts       # composeToolsets(allowlist, authContext) — per-request tool surface
│   │   ├── types.ts          # Toolset seam types (ToolsetDescriptor / ToolsetComposition)
│   │   ├── integration-bridge.ts # Platform-toolset call channel + X-Ls-Integration-Bridge-Error discrimination
│   │   ├── personalizer/     # Personalizer-backed toolset: tool defs + /v2/ai-tools/* dispatch (index.ts)
│   │   │   └── entity-context.ts # Record-ref resolution via Personalizer's per-record admin endpoints
│   │   ├── shopify/          # shopify_rest_request + shopify_graphql (Personalizer's integration bridge)
│   │   ├── bigcommerce/      # bigcommerce_rest_request (version-prefixed paths)
│   │   ├── klaviyo/          # klaviyo_rest_request (api/… paths, JSON:API paging)
│   │   └── google-ads/       # google_ads_gaql_query (GAQL SELECT — read-only)
│   ├── prompt-registry.ts            # System-prompt registry (name → text + metadata)
│   ├── prompts/*.md          # Simple prompt text (one .md per prompt, bundled at build time)
│   └── prompts/<name>/       # Multi-file prompt: prompt.md + sample.md (attachment); maintenance doc in docs/prompts/<name>.md
├── test/
│   ├── chat.test.ts          # /chat agent loop + SSE + refs/get_entity_context dispatch
│   ├── toolsets.test.ts      # registry composition + allowlist + credential seam + tool-contract snapshot
│   ├── platform-toolsets.test.ts # integration-bridge wire shapes + X-Ls-Integration-Bridge-Error discrimination + call channel
│   ├── references.test.ts    # context.refs intake + Referenced-Entities block (frozen snapshot)
│   ├── entity-context.test.ts # per-refType fetchers + AiToolEntityContext shape parity
│   ├── proxy.test.ts         # files/messages/health + anthropic client + cors/auth/cache
│   ├── token-saving.test.ts  # caching/dedup/count_tokens/effort levers
│   ├── config.test.ts        # config no-fallback contract + production [vars] pins
│   ├── architecture.test.ts  # fitness scans (allowlists, credentials, error shape, config rule)
│   └── helpers.ts            # shared typed fixtures (Env, fetch mock, SSE parser, KV mock)
├── scripts/
│   └── verify-caching.mjs    # optional live token-savings diagnostic — see docs/TESTING.md
├── docs/                     # Standalone-project docs (CODE-PATTERNS / TESTING / TOOLSETS / DECISIONS / KNOWN-ISSUES / PROMPT-AUTHORING / prompts/<name>.md)
├── CONTRIBUTING.md           # Commit convention + push-to-main deploy rule + validate loop
├── wrangler.toml             # Configuration ([vars] + KV binding) + the `[[rules]] type = "Text"` prompt-bundling rule
├── tsconfig.json             # Strict TypeScript (full strict family; tsc --noEmit gate)
├── vitest.config.ts          # Inline Vite plugin loading .md prompts as raw text in tests
├── .dev.vars.example         # Documents every local config knob (copy to .dev.vars)
├── .dev.vars                 # Local config + secrets (gitignored)
└── package.json
```

Architecture detail lives in [CLAUDE.md](CLAUDE.md).

### Environment Variables

All configuration is read through the typed accessors in
[src/config.ts](src/config.ts) — one `Env` interface, fail-fast on a missing
variable, no fallback defaults.

**Local Development:**

- Everything in `.dev.vars` (gitignored; overrides `[vars]` under
  `wrangler dev`). Copy [.dev.vars.example](.dev.vars.example) — it documents
  every knob.

**Production:**

- Public config in `wrangler.toml` `[vars]`: `ENVIRONMENT`, `PERSONALIZER_API_URL`,
  `ANTHROPIC_API_BASE`, `CREDENTIALED_ORIGINS`, and the tier→model bindings
  `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER` (values pinned by `test/config.test.ts`)
- Secrets set via Cloudflare Dashboard:
  - Workers > app-ai > Settings > Variables > Encrypt
  - Add `CLAUDE_API_KEY` as encrypted secret
  - Add `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` as encrypted secret (the platform toolsets'
    caller-auth token toward Personalizer's integration bridge)

### Updating System Prompts

Each system prompt is a **registry entry** in [src/prompt-registry.ts](src/prompt-registry.ts) whose
TEXT lives under [src/prompts/](src/prompts/) — the ONE and only prompt location. The registry
maps `name → { prompt, tier, maxTokens, usesTools, clientTools?, description, attachments, effort? }` and is
the single source of truth for each prompt's tier / token / tool choices (consumed by both
`handlers/chat.ts` and `handlers/messages.ts`). `effort` is optional — see Token-Saving below.

The registry holds 19 prompts — `/chat` agent-loop + one-shot prompts (chat, onboarding,
onboarding-chat, placement, proposals, analytics-insights) and `/messages` one-shot JSON prompts
(image-selection, visual-verify, the four Website-Analysis probes, and the onboarding /
cart-drawer / optimize propose + review passes). The authoritative inventory — every prompt with
its shape, endpoint, tools, and role — is [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md), which
also owns the per-prompt doc-sync rule.

**Prompt-text shapes** — a prompt is one of three shapes, all resolving to the same registry
entry (full convention + inventory in [src/prompts/CLAUDE.md](src/prompts/CLAUDE.md)):

- **Simple** → one file `src/prompts/<name>.md` (e.g. `chat.md`).
- **Multi-file** → a folder `src/prompts/<name>/` with a `prompt.md` system prompt + a
  `sample.md`-style file wired as an `attachments` entry (uploaded and prepended to the first
  message). `image-selection/` is the one attachment-carrying prompt; the four `probe-<id>/`
  folders hold just a `prompt.md`.
- **Composed** → a folder of `_`-prefixed BLOCK files assembled by `composePrompt(...)` in the
  folder's own `index.ts`, mixing that prompt's fragments with SHARED blocks from
  `src/prompts/onboarding-shared/` (the onboarding / cart-drawer / optimize propose + review
  prompts). In a composed prompt the `_`-files ARE imported, bundled, and shipped as the system
  text; elsewhere a `_*.md` is the co-located exclusion convention (never imported).

The barrel `src/prompts/index.ts` re-exports every prompt's final text; `src/prompt-registry.ts`
imports it as `prompts` and pairs each with its metadata. Per-prompt design docs live at
[docs/prompts/<name>.md](docs/prompts/) (workflow: [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md)).

To change a prompt's wording: edit its `.md` file(s) under `src/prompts/` — pure text.
To add a prompt: create `src/prompts/<name>.md` (simple), or a `src/prompts/<name>/` folder
(multi-file, or composed from `_`-block files with its own `index.ts`), re-export its text from
the `src/prompts/index.ts` barrel, and add a registry entry in `src/prompt-registry.ts`.
To change a prompt's model / token budget / whether it uses tools: edit the metadata in
`src/prompt-registry.ts`.

The `.md` files are bundled at **build time** (Workers have no runtime filesystem) — the
`[[rules]] type = "Text"` rule in `wrangler.toml` (glob `**/*.md`, so nested multi-file
prompts bundle too) makes `import x from './prompts/x.md'` resolve to the file's string
contents; `vitest.config.ts` mirrors this for tests with the same import specifier.

1. Edit the `.md` text and/or the `src/prompt-registry.ts` metadata
2. `npx vitest run` and `npx wrangler deploy --dry-run` to verify
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
'1h' }` (GA — no beta header). Conversation turns use the 5-minute default. See
  `src/lib/cache-control.ts` (`EXTENDED_CACHE_CONTROL`).
- **Agent-loop breakpoints.** `src/lib/agent-cache.ts` re-applies ≤3 conversation breakpoints
  each iteration (last block + ~every-15-blocks); the system base block holds the 4th, so the
  total never exceeds Anthropic's 4-block limit.
- **Files API checksum dedup.** `src/lib/file-dedup.ts` hashes upload bytes (SHA-256) and, when
  the optional `FILES_KV` namespace is bound, reuses the stored `file_id` instead of
  re-uploading (the Files API does NOT dedup by content). **Graceful no-op until KV is
  provisioned** — uploads still work.
- **`count_tokens` pre-flight.** Large `/messages` payloads log a free token estimate (warn-only;
  never gates the request).
- **Opt-in output effort (model-gated).** A registry entry may set `effort` → handlers add
  `output_config: { effort }` **only when the resolved model supports it** (`supportsEffort` in
  `lib/anthropic.ts`: Fable 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6). On a model that doesn't support
  effort (e.g. Haiku 4.5, Sonnet 4.5) the worker omits it — sending it returns a 400. `placement`
  runs on Haiku 4.5, so it carries no `effort`.

`FILES_KV` is bound in `wrangler.toml` (`[[kv_namespaces]]`), so dedup is active in
production; the code no-ops gracefully to a plain upload if the binding is ever absent.
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

- **Commits to `main` branch** → Auto-deploy to production environment

**Setup:**

1. Connect repository to Cloudflare via dashboard
2. Configure branch-to-environment mapping (`main` → `app-ai`)
3. Set the secrets in Cloudflare Dashboard:
   - Workers > app-ai > Settings > Variables > Encrypt
   - Add secrets with keys `CLAUDE_API_KEY` and `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN`

**No manual deployment needed** - push to GitHub and Cloudflare auto-deploys.

### Manual Deployment (Testing Only)

For testing changes before committing to GitHub:

```bash
# Test manual deploy to development environment
npm run deploy

# View logs
npm run tail
```

**Note:** Manual deployment should only be used for:

- Testing deployment process
- Emergency hotfixes
- Validating changes before pushing to GitHub

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
`PERSONALIZER_API_URL`, `ANTHROPIC_API_BASE`, `CREDENTIALED_ORIGINS`, the tier→model
bindings `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER`, and the `CLAUDE_API_KEY` +
`PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` secrets. `src/config.ts` throws on any missing one.

### View Live Logs

```bash
# Production logs
npm run tail
```

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

3. **Context Validation**

   - All protected endpoints validate the context ID against the Personalizer API
     before dispatch (`lib/auth.ts`).
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

# Deployment (Manual - for testing only)
npm run deploy           # Deploy to default environment

# Monitoring
npm run tail             # View production logs

# Maintenance
npm run update-deps      # Update dependencies and run audit fix
npm audit                # Check security
wrangler whoami          # Check authentication

# Note: Staging and production deploy automatically via GitHub integration
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
- [docs/DECISIONS.md](docs/DECISIONS.md) — numbered decision log
- [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — current limitations
- [docs/PROMPT-AUTHORING.md](docs/PROMPT-AUTHORING.md) — prompt
  authoring/iteration workflow
- [docs/TOOLSETS.md](docs/TOOLSETS.md) — toolset standards: the registry, the
  credential seam + security standards, the platform toolsets
- [docs/prompts/](docs/prompts/) — per-prompt design/maintenance docs
  (e.g. [image-selection.md](docs/prompts/image-selection.md))

---

**Platform:** Cloudflare Workers (V8 Isolates)
**Live surface:** `/files` + `/messages` serve the production smart-image
feature; `/chat` serves LimeSpot Studio AI.
**Deploy:** pushing `main` deploys to production.
