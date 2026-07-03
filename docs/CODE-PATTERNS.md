# app-ai Code Patterns

**Parent:** [CLAUDE.md](../CLAUDE.md)

Universal coding standards for the app-ai worker. All contributors follow
these patterns; several are enforced mechanically (ESLint rules, the strict
tsconfig, and the fitness scans in `test/architecture.test.ts`).

---

## Strict TypeScript

The whole repo — `src/`, `test/`, `vitest.config.ts` — is strict TypeScript.
`tsconfig.json` declares the full strict family plus the beyond-strict
correctness flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`). `npm run typecheck`
(`tsc --noEmit`) is a required gate with zero errors.

### Forbidden

- **`any`** — anywhere, including tests. Use `unknown` + narrowing. Enforced
  by `@typescript-eslint/no-explicit-any`.
- **`@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`** — fix the types
  instead. Enforced by `@typescript-eslint/ban-ts-comment`.
- **Non-null assertion `!`** — use optional chaining plus a runtime guard.

### Type Imports

```typescript
// CORRECT — type-only imports use `import type`
import type { Env } from '../config';
import { personalizerApiUrl } from '../config';

// WRONG
import { Env, personalizerApiUrl } from '../config';
```

`verbatimModuleSyntax` makes this mechanical: a type imported without
`import type` fails the build.

### Catch Blocks

`useUnknownInCatchVariables` is on — narrow before touching the error:

```typescript
// CORRECT
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  log.error(`Failed to upload ${filename}: ${reason}`);
}

// WRONG — `error` is `unknown`, not `Error`
} catch (error) {
  log.error(error.message);
}
```

### Boundary types, not casts

Untrusted input (client request bodies, Anthropic/Personalizer responses) enters
through a NARROW structural interface (e.g. `ChatRequestBody`,
`AnthropicStreamEvent`, `ClientMessagesPayload`) and is validated at the
point of use. A single `as` cast to the narrow view at the boundary is the
pattern; sprinkling casts deeper in the code is not.

---

## Clean Code

### DRY (Don't Repeat Yourself)

- Same logic in 2+ places → extract to `src/lib/`.
- Same constant in 2+ places → one exported constant in the owning module.
- Before adding code, search first — `grep` for an existing implementation.

### Single Responsibility

- One module = one concern. The router only routes; handlers own one route
  group; `lib/anthropic.ts` is the ONLY module that talks to
  `api.anthropic.com`; `src/config.ts` is the ONLY module that reads
  environment bindings; toolsets own their tools end-to-end.
- Modules own their internals — callers use exported interfaces, never
  reach into another module's constants.

### Full Names

No abbreviated identifiers (`ctxId`, `resp`, `cfg`, `idx`). Write
`contextId`, `response`, `config`, `index`. Single-letter loop variables are
acceptable only for trivially-scoped numeric loops.

### No Magic Literals

A literal with meaning gets a named constant WITH a doc comment explaining
it (`MAX_CACHE_BLOCKS`, `KV_RECORD_TTL_SECONDS`, `LARGE_PAYLOAD_TOKEN_THRESHOLD`)
— and if it is a deploy-time tunable rather than a contract/internal
constant, it belongs in configuration (next section). Inline `4`s and
`100000`s with unstated meaning are not acceptable.

### No Dead Code / No Backwards-Compatibility Hacks

- Unused exports, functions, branches, and imports are deleted completely
  (`unused-imports/no-unused-imports` + `@typescript-eslint/no-unused-vars`
  enforce part of this).
- No re-exports "for compatibility", no renamed `_vars` to silence linters,
  no `// removed` markers, no keeping code "just in case".
- A module-internal value is not exported (e.g. the `systemPrompts` table is
  private to `prompts.ts`; consumers go through `getSystemPrompt`).

---

## No Hardcoded Config Values (ENFORCED)

Every URL and every architecturally sensible deploy-time tunable lives in
CONFIGURATION, not in code:

| Channel                                | What                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| wrangler.toml `[vars]`                 | Production non-secrets (Personalizer/Anthropic origins, CORS allowlist, model choices) |
| Cloudflare Dashboard encrypted secrets | `CLAUDE_API_KEY`, `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN`                              |
| `.dev.vars` (gitignored)               | Local dev values + the local secrets — overrides `[vars]` under `wrangler dev`         |
| `.dev.vars.example` (committed)        | Documents every knob with a working local value                                        |

### The rules

1. **One typed `Env`.** `src/config.ts` declares the single `Env` interface
   and the accessors (`personalizerApiUrl`, `anthropicApiBase`, `claudeApiKey`,
   `personalizerIntegrationBridgeToken`, `credentialedOrigins`, `modelDefault`,
   `modelPlacement`). Nothing else reads `env.X` for a required variable. The Node scripts (`scripts/`)
   follow the same discipline with explicit REQUIRED environment variables
   (`APP_AI_TARGET`, `APP_AI_CONTEXT_ID`/`APP_AI_CONTEXT_FILE`) — no default
   target, no default fixture path.
2. **Missing config = thrown error.** Every required-variable read fails
   fast with an error naming the variable and the channel to set it in.
   **No fallback defaults anywhere** — `env.X || 'value'` and
   `env.X ?? 'value'` are banned.
3. **Genuinely optional knobs change behavior explicitly and documentedly.**
   `FILES_KV` is the one optional binding: its absence makes the file-dedup
   layer no-op to a plain upload, stated in `src/lib/file-dedup.ts` and the
   docs — not a hidden default.
4. **Contract constants stay in code.** Do NOT config-ify values that are
   frozen contracts or protocol facts: wire field names, tool names, HTTP
   routes, prompt text, Anthropic's 4-breakpoint `cache_control` limit and
   its `1h` extended TTL, the `anthropic-version`/beta headers, and the
   cross-repo-frozen `MAX_ITERATIONS` (= 8) / `MAX_CHAT_REFS` (= 5) (lib
   `CONTRACTS.md` §1). Internal robustness/observability constants with a
   written rationale (the dedup KV TTL, the count_tokens warn threshold)
   also stay in code — their doc comments say so explicitly.

### Enforcement

- `test/architecture.test.ts` scans `src/` AND `scripts/`: no absolute URL
  literals anywhere outside the config module, no inline `||`/`??` fallbacks
  on `env` or `process.env` reads, required worker variables read only through
  the `src/config.ts` accessors.
- `test/config.test.ts` proves the fail-fast contract and pins the
  PRODUCTION `[vars]` values by reading wrangler.toml itself.

---

## Brain Is the Single Source of Truth (API Models & Shapes)

Anything sent to or received from Brain (the Personalizer API) mirrors
Brain's C# definition **exactly**. Brain owns the contract; this worker
mirrors it.

- **Verify against the sibling `brain` repo (C#)**, never the legacy Angular
  `app` TypeScript (it is just another client mirror and can be stale).
- **Don't invent fields.** If Brain's entity doesn't have it, it doesn't
  exist.
- **Don't narrow types.** Model the full shape or carry the original
  through.
- **Mirror Brain's serialization:** PascalCase, enums as strings, null
  members omitted (`NullValueHandling.Ignore`) — `entity-context.ts` mirrors
  the omission.
- Cite the Brain controller/entity path in a comment above the mirrored
  shape so the next reader can re-verify.

The authoritative list of mirrored surfaces is in the root
[CLAUDE.md](../CLAUDE.md) → Hard rules.

---

## Error Handling

### One error shape

Every HTTP error body and every SSE `error` event payload is the Brain wire
envelope — `{ "Message": …, "ExceptionType": …, "MessageDetail": … }`, flat
PascalCase, `MessageDetail` omitted when absent — built by
`lib/responses.ts` (`errorResponse` / `errorPayload` / `WorkerError` /
`errorResponseFrom`). Handlers never invent per-route envelopes
([DECISIONS.md](DECISIONS.md) #7). Enforced by the
`test/architecture.test.ts` scan (no bespoke `{ error: { message } }`
serialization anywhere in `src/`).

### No silent swallowing

A caught error is handled (logged with context + mapped to the envelope or
the documented degrade shape) or rethrown — never dropped. The narrow
sanctioned degrades are the documented ones: tool execution degrades to
`{ ok: false, … }` so the agent loop can continue; a failed reference
resolve degrades to a `(could not load)` line; the count_tokens pre-flight
is advisory-only. Each degrade site says what it degrades to and why.

### No mock-data fallbacks

A failure never fabricates a success value (no `.catch(() => [])`). Degrade
shapes are explicit error states the consumer can see, not fake data.

### Include error details

Preserve upstream context: Anthropic failures keep Anthropic's status and
carry the raw upstream body in `MessageDetail`; Brain auth rejections relay
Brain's status + body unchanged; wrapped errors name the operation that
failed.

---

## Over-Engineering Avoidance

- Only make necessary changes — a bug fix doesn't need surrounding cleanup.
- Don't add abstractions for one-time use; three similar lines beat a
  premature helper.
- Trust internal code — validate at system boundaries (client input,
  Anthropic/Personalizer responses), not against impossible internal states.

---

## No Silent Skips (tests)

Tests never `skip()` around a missing precondition — a skipped test is a
green CI that lies. Throw with an actionable error instead:

- The live token-savings gate (`scripts/verify-caching.mjs`) throws loudly
  on missing credentials or an unreachable target — it never exits 0
  without measuring.
- A fixture that can't build its precondition throws with the command that
  fixes it.
- Never weaken an assertion to get to green.

---

## Documentation Maintenance

- **Current state only.** Docs and comments describe what the code IS —
  no chronological narratives, no references to prior structures (root
  CLAUDE.md → Documentation conventions).
- **Propagation.** Any code change updates the affected folder's
  `CLAUDE.md`, then the root CLAUDE.md, in the SAME commit.
- **DECISIONS log contract.** Every architecturally significant decision
  (a contract choice, a security posture, a config-vs-code classification,
  a caching strategy) gets a numbered entry in
  [DECISIONS.md](DECISIONS.md) — what was decided, the rationale, and the
  alternatives rejected — in the same commit as the change. Entries are
  written present-tense and are append-only: a superseded decision gets a
  new entry that names the entry it supersedes.
- **Single source of truth.** Each fact lives in ONE canonical doc; other
  docs link to it.

---

## Git & Version Control

### Pre-commit gates (all must pass with zero errors)

```bash
npx vitest run
npm run lint
npm run format-check
npm run typecheck
npx wrangler deploy --dry-run
```

### Commit messages

```
feat(app-ai): add per-request toolset composition
fix(app-ai): keep upstream status on Anthropic failures
```

### Never push without explicit intent

Pushing `main` deploys to production (Cloudflare GitHub integration).
Committing and pushing are separate approvals — see
[CONTRIBUTING.md](../CONTRIBUTING.md).
