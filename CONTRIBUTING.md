# Contributing — app-ai

This is a single-`main`, dependency-free Cloudflare Worker. Read [CLAUDE.md](CLAUDE.md)
for the architecture and the documentation-propagation rule before changing
code; read [docs/DECISIONS.md](docs/DECISIONS.md) for why the worker is shaped
the way it is.

## ⚠️ Pushing `main` is a production deploy

Cloudflare's GitHub integration auto-deploys `main` to production. There is one
branch and no staging. **A push to `main` is live**, so that one action carries
both the push approval and the deploy approval and is an operator step: `main` is
read-only to every agent, which prepares work on a feature branch and lets a human
merge and push it ([CLAUDE.md](CLAUDE.md) → Hard rules,
`../_standards/git-and-approval.md`). Docs/test-only changes are deploy-safe (no
runtime behavior change), but they still deploy — there is no "safe" branch to
stage on.

## Commit message convention

`type(scope): subject`, where `scope` is `app-ai`. Use a conventional `type`:
`feat`, `fix`, `perf`, `docs`, `test`, `refactor`, `chore`.

```
docs(app-ai): add standalone-project docs (TESTING / DECISIONS / KNOWN-ISSUES)
test(app-ai): add live token-savings diagnostic (verify:caching)
fix(app-ai): only send output_config.effort on models that support it
```

Commit messages carry **no AI-attribution or tool-credit trailers**: never a
`Co-Authored-By:` naming a model or a tool, never a session or generation link,
never a "generated with" tagline, and never a mention of any AI assistant as an
author or contributor. This repository names no human co-author trailer either,
so its commits carry none at all. The subject + body describe the change only.
(See [AGENTS.md](AGENTS.md) → hard rule 4, and [CLAUDE.md](CLAUDE.md) → Hard
rules.)

## Validate before you push

Before a push, run the format check, the linter and the typecheck:

```bash
npm run format-check    # Prettier check (whole repo; exclusions in .prettierignore)
npm run lint            # ESLint over the whole repo (must be 0)
npm run typecheck       # tsc --noEmit (strict; must be 0)
```

The pre-push hook runs the typecheck and the linter on every push that updates a branch. A push of
tags or deletions only skips both, and a checkout whose packages are not installed is refused until
`npm ci` has run.

A test runs locally only for an exception `../_standards/testing.md` → Local gates names: a
reported bug's reproduction, visual evidence for a UI change, a suite CI does not run, reproducing
a red exact-head CI test, or a vacuity probe.

CI (`.github/workflows/ci.yml`) runs the full Vitest suite and the revision-stamped deploy dry
run on every push and PR, beside lint, format check and typecheck, as parallel jobs that the one
`build` check gathers. Its result on the pushed head is the authority: never re-run the suite
locally to confirm or contradict it.

CI's `test` job reads `ai-providers.json` from a checkout of the workspace repository
`limespot/root`, first for the published-DPA check, which fails until the live DPA's
sub-processor list prints every provider the file names
([docs/AI-PROVIDERS.md](docs/AI-PROVIDERS.md)), then for the suite, which also compares the
agents core with that checkout's `agent-rules-core.md` byte for byte. A change to the agents core
is a `limespot/root` pull request first, and this repository's copy then takes the root text
unchanged ([src/prompts/CLAUDE.md](src/prompts/CLAUDE.md), doc-sync rule 6). A local run of
`test/ai-providers.test.ts` or `test/shared-agents-core.test.ts`, under one of those exceptions,
reads the root files from the directory `LIMESPOT_ROOT_STANDARDS` names, or from `../_standards`,
so keep that checkout current ([docs/TESTING.md](docs/TESTING.md) → Running the offline suite).

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
(`src/handlers/CLAUDE.md`, `src/inference/CLAUDE.md`, `src/lib/CLAUDE.md`,
`src/toolsets/CLAUDE.md`, `src/prompts/CLAUDE.md`), then propagate up to the root
[CLAUDE.md](CLAUDE.md). Adding/renaming a handler, inference module, lib module, toolset, prompt, route,
or doc updates the relevant sections. Keep the documentation tree valid.
Documentation and comment style is `../_standards/documentation-and-comments.md`.

## Hard rules

- **Strict TypeScript, no `any`, no `@ts-*` suppressions** — see
  [docs/CODE-PATTERNS.md](docs/CODE-PATTERNS.md). No new production npm
  dependencies (the bundle stays dependency-free).
- **No Hardcoded Config Values** — URLs and deploy-time tunables live in
  wrangler `[vars]` / `.dev.vars` behind `src/config.ts`; missing config
  throws; no inline fallbacks (fitness-tested).
- **The Anthropic API key never leaves the worker** — only `inference/adapters/anthropic-wire.ts`
  reads it, via `claudeApiKey(env)` from `src/config.ts`.
- **The live surface is a stable external contract.** `/files`, `/messages`
  (image-selection), `/chat`, context validation, CORS, and `cache_control`
  serve production — routes, request/response shapes, headers, and status codes
  stay identical.
- **Brain is the source of truth** for the `/v2/ai-tools/*` and
  validate-context-id request/response shapes — mirror Brain's C# exactly
  (verify in the `brain` repo); never invent fields in `toolsets/personalizer/` / `auth.ts`.
- Prompt `.md` text must match the intended prompt byte-for-byte.
