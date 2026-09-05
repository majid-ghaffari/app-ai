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
  group; `inference/service.ts` owns the canonical loop;
  `inference/factory.ts` is the ONLY adapter switch; provider HTTP and wire
  types live only under `inference/adapters/`; `src/config.ts` is the ONLY
  module that reads environment bindings; toolsets own their tools end-to-end.
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
  private to `prompt-registry.ts`; consumers go through `getSystemPrompt`).

### Structured logging

- Worker code logs through the request-scoped `LoggingRuntime`; direct `console.*` is allowed only
  inside the registered Console sink in `lib/logger.ts`.
- The deployment configures each level independently through `LOG_TARGETS_TRACE` through
  `LOG_TARGETS_FATAL`. A value is `ignore` or a comma-separated target fan-out such as
  `console,seq`; environment names do not imply logging behavior.
- The router owns request/context/subscriber correlation and passes the runtime into handlers.
  Shared helpers accept a `Logger` rather than creating ambient module loggers.
- Seq delivery is attached to `waitUntil`, fail-open, and non-recursive. `LOG_SEQ_API_KEY` is
  optional; when present it is sent as `X-Seq-ApiKey`.
- Preserve diagnostic evidence (errors, stacks, causes, and redacted provider/tool payloads).
  Redact context IDs, opaque file references, encoded media, provider continuation state, and
  secret-bearing fields such as authorization, cookies, passwords, service tokens, and API keys.

---

## No Hardcoded Config Values (ENFORCED)

Every URL and every architecturally sensible deploy-time tunable lives in
CONFIGURATION, not in code:

| Channel                                | What                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wrangler.toml `[vars]`                 | Production non-secrets (Personalizer/provider origins, CORS allowlist, master subscriber, tier→model bindings and their `MODEL_OVERRIDES` exceptions)  |
| Cloudflare Dashboard encrypted secrets | Every provider API key, `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN`, `TOKEN_ENCRYPTION_SECRET`, and the three key-separated `DEMO_*_SIGNING_SECRET` values |
| `.dev.vars` (gitignored)               | Local dev values + the local secrets — overrides `[vars]` under `wrangler dev`                                                                         |
| `.dev.vars.example` (committed)        | Every binding the worker reads, grouped, marked REQUIRED or OPTIONAL; secrets blank, non-secrets at their working local value                          |

### The rules

1. **One typed `Env`.** `src/config.ts` declares the single `Env` interface
   and the accessors (`personalizerApiUrl`, the provider base/key accessors,
   `personalizerIntegrationBridgeToken`, `tokenEncryptionSecret`, `credentialedOrigins`,
   the `demo*` accessors, `masterSubscriberId`, `modelOverrides`, and
   `resolveModel` — which maps a group's capability tier to `MODEL_FAST` /
   `MODEL_BALANCED` / `MODEL_FRONTIER`). Nothing
   else reads `env.X` for a required variable. The Node scripts (`scripts/`)
   follow the same discipline with explicit REQUIRED environment variables
   (`APP_AI_TARGET`, `APP_AI_CONTEXT_ID`/`APP_AI_CONTEXT_FILE`; guarded OpenAI or
   Gemini smoke variables; or explicit `CODEX_LOCAL_MODEL`). The documented
   `LOCAL_AI_FULFILLER=claude-code` default selects a no-provider-API local
   execution strategy, never a paid target, credential, or model.
2. **Missing config = thrown error.** Every required-variable read fails
   fast with an error naming the variable and the channel to set it in.
   A known prompt with a missing tier binding, an unrecognised configured model,
   or a model that cannot satisfy its group fails closed before file or provider
   I/O; unknown-selector compatibility never catches that failure. A
   `MODEL_OVERRIDES` key naming no registered prompt or prompt group throws
   rather than being ignored, so a typo cannot become a silent no-op.
   **No fallback defaults anywhere** — `env.X || 'value'` and
   `env.X ?? 'value'` are banned.
3. **Genuinely optional knobs change behavior explicitly and documentedly.**
   `FILES_KV` is optional only for the internal file-dedup optimization, whose
   absence no-ops to a plain direct upload, stated in `src/lib/file-dedup.ts` and
   the docs — not a hidden default. Public prompt-aware references are
   self-contained authenticated ciphertext under the required `TOKEN_ENCRYPTION_SECRET`,
   and sealing configuration is validated before provider I/O. `DEMO_SESSIONS` is
   required when the scoped demo exchange or bearer path is used and fails closed
   when absent.
4. **Contract constants stay in code.** Do NOT config-ify values that are
   frozen contracts or protocol facts: wire field names, tool names, HTTP
   routes, prompt text, the model catalog (what a model IS, as opposed to which
   model a deployment chose), Anthropic's 4-breakpoint `cache_control` limit and
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

- **Verify against the sibling `brain` repo (C#)**, never the sibling Angular
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

- The optional live token-savings diagnostic (`scripts/verify-caching.mjs`) throws loudly
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
  written present-tense and describe only the choice that stands; a decision
  that changes is rewritten in its own entry, keeping that entry's number,
  which is the stable identifier other documents cite.
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
npm run deploy:dry-run
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
