# src/lib/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md)

Shared library modules consumed by the handlers and the router. The Anthropic API
key is read only inside `anthropic.ts` (via `claudeApiKey(env)` from
`../config.ts` — the single typed-Env binding reader) and never leaves the
worker. `anthropic.ts` also owns the shared Anthropic Messages wire types
(content blocks, payloads, `CacheControl`) consumed across handlers and the
cache modules.

The per-module map — what each file owns — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md), read on demand. What binds every module is below.

## Conventions

- Every exported function and type carries a doc comment (TSDoc; types are in the signatures).
- Cache/effort/dedup levers are **additive** — they never change external
  request/response shapes (see the token-saving section in the root CLAUDE.md).
- Beta flags live only in `anthropic.ts`: Files calls send `files-api-2025-04-14`;
  Messages calls send `prompt-caching-2024-07-31,files-api-2025-04-14`.
