# Prompt Authoring & Maintenance Workflow

The process for iterating on and maintaining app-ai system prompts with Claude. It covers artifact conventions for iteration sessions, when/how to update the prompt files, automatic length enforcement, brainstorming mode, and how each prompt's own maintenance doc — `docs/prompts/<name>.md` — is kept.

## Where things live

- **Runtime prompt text** lives ONLY under `src/prompts/` — a single `.md` for a simple prompt, a `src/prompts/<name>/` folder for a multi-file prompt (`prompt.md` system text + a sample/attachment file such as `sample.md`), a COMPOSED prompt (a folder of `_`-prefixed BLOCK files, no `prompt.md`, assembled by `composePrompt(...)` in that folder's own `index.ts` from per-prompt fragments + SHARED blocks under `src/prompts/onboarding-shared/` — the onboarding, cart-drawer, and optimize-demand prompts — or `src/prompts/assistant-shared/` and `src/prompts/optimization-shared/` — the conversational prompts and the Optimization conductor's steps), or an explicit SHARED-TEXT ALIAS in the barrel when two registered names intentionally have the same semantic contract but different routing or access. The `src/prompts/` barrel (`index.ts`) exports every prompt's final text by its registered name; the registry in `src/prompt-registry.ts` maps each prompt name to that text + its required compatibility group and execution metadata. Groups own model profiles and provider-file policy; prompt authors never put a provider or model override in prompt callers. All `.md` files are bundled at build time (Workers have no runtime filesystem), so anything imported by the barrel and read through the registry ships to production.
- **Maintenance docs** live at `docs/prompts/<name>.md` — one per prompt that has design decisions worth recording. A maintenance doc is an evergreen, present-state record of the prompt's goals, constraints (character/token budgets), selector or output rules, and the rationale behind them. It describes what the prompt IS and why, never a change log. It is documentation, never bundled, never sent to the API.
- Underscore-prefixed files inside a prompt folder follow the LimeSpot `_` convention. In a COMPOSED prompt they are BLOCK PARTS — explicitly imported by that prompt folder's `index.ts` and composed into the prompt (they just aren't a standalone `<name>` you select via the header). Elsewhere `_*.md` remains a supported exclusion mechanism (never imported) for a co-located non-runtime file. Editing a COMPOSED prompt means editing its block/fragment `.md` files — and, if the effective text changes on purpose, the matching baseline in `test/__snapshots__/` (the byte-equivalence gate `test/onboarding-prompt-blocks.test.ts` fails otherwise).

## Editing a prompt: the three things that bite

1. **Restart the local worker after ANY prompt edit, and verify the restart took.** Wrangler's
   watcher misses `.md`-only edits, and a failed restart false-passes a health check because the old
   process keeps the port. Grep the served module files under `.wrangler/tmp/dev-*/` for a phrase
   from the edit before trusting a local run.
2. **A change to a PROPOSE prompt needs the lib's `SCREEN_CACHE_PLAYBOOK_VERSION` bumped in the same
   change** (`lib/packages/storefront/src/admin/ai/screen-cache.ts`), or warmed stores replay plans
   cached under the old playbook. That constant is the only place the version is written down.
3. **Regenerate the byte-equivalence baselines after any block edit**, and keep the prompt's
   `docs/prompts/<name>.md` in sync in the same change — both are review gates, and a composed
   prompt's block order lives in its own folder's `index.ts`.

Prompt text ships to production from the DEPLOYED worker, so repository ancestry never proves which
prompt a live store is served. Verify the served worker's `buildRev` against the checkout before
treating a live run as evidence.

## Iteration sessions with Claude

Prompt distillation happens in a Claude chat session. Seed the session with the prompt's runtime files (`prompt.md`, `sample.md`) plus its maintenance doc (`docs/prompts/<name>.md`) so Claude has full context; when hitting chat limits, start a new chat seeded the same way. The resulting file contents are then committed back to the repo (runtime files under `src/prompts/`, the maintenance doc under `docs/prompts/`).

### Artifact presentation rules (in-session)

All three files must be kept as markdown artifacts in the chat sidebar:

1. **prompt.md** — artifact titled "System Prompt (prompt.md)"
2. **sample.md** (or the prompt's sample/attachment file) — artifact titled "Training Examples (sample.md)"
3. **The maintenance doc** — artifact titled "Project Context"

- Use artifact blocks: start with title, set type to markdown
- Each update creates a new version visible in sidebar history
- Never provide as inline code blocks or downloadable files
- User should see all 3 artifacts in sidebar at all times
- Version numbers in artifact updates help track changes

### When to update artifacts

- **After every significant decision** that changes rules or examples
- **When fixing issues** in prompt.md or sample.md
- **When adding new patterns** or edge cases
- **Maintenance-doc updates** after updating the runtime files

### Automatic length enforcement

Prompts on the hot path carry a character budget (recorded in their maintenance doc) because every system-prompt token is paid on every API call.

- **ALWAYS check prompt.md character count** after any update using `wc -c`
- **If it exceeds the prompt's hard character limit:** IMMEDIATELY regenerate with optimizations, NO confirmation needed
- **Process:** trim verbose sections, condense lists, remove redundancy while keeping all rules
- **Target:** stay under the limit with a safety buffer (e.g. <4,400 characters against a 4,500 limit)
- **This overrides brainstorming mode** — length violations trigger automatic action

### Brainstorming mode

- Keep answers short
- No artifact generation unless explicitly requested
- Discuss changes first, regenerate only after confirmation
- **Exception:** length limit violations trigger automatic regeneration

## How to maintain the maintenance doc (`docs/prompts/<name>.md`)

### Claude's responsibilities

1. **Update after every significant change** to the prompt's runtime files (prompt.md, sample.md)
2. **Document the key decisions** as present-state rationale — why the prompt is shaped the way it is
3. **Preserve all constraints and rules** that inform the current design

### What to include

- Project overview and goals
- Current state of the runtime files (prompt.md, sample.md), with measured sizes
- Key technical decisions and why they hold
- Lists of classes/patterns to avoid (with examples)
- Character limits and other constraints
- Working examples and edge cases covered

### What NOT to include

- Long code snippets (those go in prompt.md/sample.md)
- Plans, task lists, next steps, or an iteration record — those belong in the pull request that
  carries the work, never in the tree
- Repetitive information already in the runtime files
- Temporary debugging discussions
