# Contributing — app-ai

This is a single-`main`, dependency-free Cloudflare Worker. Read [CLAUDE.md](CLAUDE.md)
for the architecture and the documentation-propagation rule before changing
code; read [docs/DECISIONS.md](docs/DECISIONS.md) for why the worker is shaped
the way it is.

## ⚠️ Pushing `main` is a production deploy

Cloudflare's GitHub integration auto-deploys `main` to production. There is one
branch and no staging. **A push to `main` is live.** Commit locally; push only
with intent. Docs/test-only changes are deploy-safe (no runtime behavior
change), but they still deploy — there is no "safe" branch to stage on.

## Commit message convention

`type(scope): subject`, where `scope` is `app-ai`. Use a conventional `type`:
`feat`, `fix`, `perf`, `docs`, `test`, `refactor`, `chore`.

```
docs(app-ai): add standalone-project docs (TESTING / DECISIONS / KNOWN-ISSUES)
test(app-ai): add live token-savings diagnostic (verify:caching)
fix(app-ai): only send output_config.effort on models that support it
```

Commit messages carry **no AI-attribution or tool-credit trailers** — no
`Co-Authored-By: Claude …`, no `Claude-Session:`, no "Generated with …", and no
mention of Claude / Anthropic / any AI assistant as an author or contributor.
The subject + body describe the change only. (See [CLAUDE.md](CLAUDE.md) → Hard
rules.)

## Validate before you push

Run the full offline gate locally — it mirrors CI
(`.github/workflows/ci.yml`), which runs lint → format-check → typecheck →
`vitest run` → `wrangler deploy --dry-run` on every push and PR:

```bash
npm run lint            # ESLint over the whole repo (must be 0)
npm run format-check    # Prettier check (whole repo; exclusions in .prettierignore)
npm run typecheck       # tsc --noEmit (strict; must be 0)
npx vitest run          # unit + integration + contract + fitness (must be green)
npx wrangler deploy --dry-run   # build the bundle (verifies imports + the .md Text rule)
```

For changes touching prompt text, tool definitions, or cache-control code, the
optional deployed-worker diagnostic can provide additional operational evidence;
the required offline suite mocks `fetch`:

```bash
npm run verify:caching  # optional; asserts cache_read > 0 on a repeat call
```

This diagnostic is not a release gate. When explicitly invoked, it needs a
master context-ID and a reachable target and throws loudly if either is missing.
See [docs/TESTING.md](docs/TESTING.md).

## Documentation rule

Any code change MUST update the affected folder's `CLAUDE.md`
(`src/handlers/CLAUDE.md`, `src/lib/CLAUDE.md`), then propagate up to the root
[CLAUDE.md](CLAUDE.md). Adding/renaming a handler, lib module, prompt, route, or
doc updates the relevant sections. Keep the documentation tree valid. Docs are
present-state only — describe what the code IS, never what it was (no
"previously", "now", "refactored from", before→after framing).

## Hard rules

- **Strict TypeScript, no `any`, no `@ts-*` suppressions** — see
  [docs/CODE-PATTERNS.md](docs/CODE-PATTERNS.md). No new production npm
  dependencies (the bundle stays dependency-free).
- **No Hardcoded Config Values** — URLs and deploy-time tunables live in
  wrangler `[vars]` / `.dev.vars` behind `src/config.ts`; missing config
  throws; no inline fallbacks (fitness-tested).
- **The Anthropic API key never leaves the worker** — only `lib/anthropic.ts`
  reads it, via `claudeApiKey(env)` from `src/config.ts`.
- **The live surface is a stable external contract.** `/files`, `/messages`
  (image-selection), `/chat`, context validation, CORS, and `cache_control`
  serve production — routes, request/response shapes, headers, and status codes
  stay identical.
- **Brain is the source of truth** for the `/v2/ai-tools/*` and
  validate-context-id request/response shapes — mirror Brain's C# exactly
  (verify in the `brain` repo); never invent fields in `toolsets/personalizer/` / `auth.ts`.
- Prompt `.md` text must match the intended prompt byte-for-byte.
