# src/prompts/ — the prompt registry's TEXT + its doc-sync contract

**Parent:** [../../CLAUDE.md](../../CLAUDE.md) (root) — see its **Prompt registry** section for the
build-time bundling, caching, and dispatch mechanics. This folder doc owns what the root delegates
here: the **doc-sync rule**, which folders are prompts and which are shared blocks, and why the
`-all` twins are not duplicates.

Every model-facing system prompt lives here as pure `.md` text. The registry that maps a prompt
NAME to its text and metadata is [`../prompt-registry.ts`](../prompt-registry.ts), whose
`SystemPromptEntry` interface is the source of truth for what an entry carries. The lib references a prompt only BY NAME (the
`X-Personalizer-System-Prompt` header) and never hardcodes prompt content — the lib-side contract is
`packages/storefront/src/admin/ai/CONTRACTS.md` + `docs/AI-LAYER.md` in the lib repo.

`kimi-html-retrieval.md` is an adapter-internal prompt for selecting exact fragments from oversized
uploaded HTML. It has no public prompt name or registry entry; the Kimi adapter invokes it before
the original registered prompt and keeps its tool transcript inside app-ai.

Every prompt belongs to exactly one typed compatibility group. The same registry owns each group's
capability tier, capability requirements, and file-reusing fallback edges. The
registry resolves prompt → group → tier → configured model, and the model id decides provider,
API family, capabilities, and file policy through the model catalog; callers never
name a group, profile, provider, file purpose, or model. The exact group inventory and reuse graph
are frozen by [`../../test/prompt-groups.test.ts`](../../test/prompt-groups.test.ts).

## Doc-sync rule (HARD — mirrors the root CLAUDE.md propagation rule)

**Every registered prompt — every key in `systemPrompts` (plus the `chat` / `onboarding` / `placement` /
`proposals` entries) in [`../prompt-registry.ts`](../prompt-registry.ts) — has a maintenance doc at
[`../../docs/prompts/<name>.md`](../../docs/prompts/).** That doc is the evergreen record of the
prompt's purpose, model, tools, input contract, and frozen output contract. Keep the two in lockstep:

1. **Edit a prompt's rules or output contract → update its `docs/prompts/<name>.md` in the SAME change.**
   The doc's Input/Output-contract sections must always describe the current prompt.
2. **Add a prompt →** create its `.md` (single file), `<name>/` folder (multi-file / composed), or
   explicit barrel alias to a semantically identical registered prompt here,
   add its registry entry in `../prompt-registry.ts` (+ its `PROBE_SCHEMAS` entry if it's a `probe-<id>`), write
   `docs/prompts/<name>.md`, and add a row to the prompt table in `docs/ARCHITECTURE-MAP.md`.
3. **Rename a prompt →** rename the text file(s), the registry key, and `docs/prompts/<name>.md` together.
4. **Retire a prompt →** delete the text, the registry entry, and the doc together (No Dead Code). A doc
   with no registered prompt, or a registered prompt with no doc, is a broken tree.
5. **Edit a SHARED block (`onboarding-shared/_shared-*.md` / `_block-*.md`, or
   `assistant-shared/_shared-*.md`) →** it changes EVERY prompt that composes it. Update the doc of each composing prompt (or the shared note they carry) and, when the
   composed text changes on purpose, regenerate that prompt's byte baseline in `test/__snapshots__/` — the
   byte-equivalence gate [`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts)
   fails otherwise. An `assistant-shared/` block reaches `chat` and `grader-chat`; their byte gate is
   [`test/assistant-prompt-blocks.test.ts`](../../test/assistant-prompt-blocks.test.ts) against
   `test/__snapshots__/chat.baseline.md` and `test/__snapshots__/grader-chat.baseline.md`.

The authoring/iteration workflow (artifact rules, length enforcement, what belongs in a maintenance doc) is
[`../../docs/PROMPT-AUTHORING.md`](../../docs/PROMPT-AUTHORING.md).

## The four shapes (a prompt folder vs a shared-block folder)

A registered prompt is ONE of four shapes (full mechanics in the root CLAUDE.md → Prompt registry):

Every prompt's FINAL text is re-exported by the barrel [`./index.ts`](./index.ts) as a named export, so
`../prompt-registry.ts` is just the registry (`import * as prompts from './prompts'` resolves to that barrel;
each entry's `prompt:` references `prompts.<name>`).

- **Single-file** — one `<name>.md` (e.g. `placement.md`, `analytics-insights.md`). The barrel
  re-exports its raw `.md` text; the registry uses it directly as `prompt`.
- **Multi-file** — a `<name>/` folder with `prompt.md` (system text) + a non-prompt attachment file
  (`sample.md`); the barrel re-exports both, and `sample.md` is wired through the registry's `attachments`.
  Only `image-selection/` today.
- **Composed** — a `<name>/` folder of `_`-prefixed BLOCK files (no `prompt.md`) PLUS its own
  [`index.ts`](./onboarding-batch/index.ts) that assembles the final text via `composePrompt(...)`
  (from [`./_compose.ts`](./_compose.ts)) out of that prompt's own fragments PLUS shared blocks from
  `onboarding-shared/` or `assistant-shared/`, in a STABLE order (the cacheable prefix). The barrel
  re-exports that folder's default. `chat` composes the shared chat formatting around its
  Studio-only fragments, its identity among them, which names the platforms Studio serves;
  `grader-chat` composes the same formatting block around its own platform-neutral identity, its
  one boundaries block and a booklet — the only part of its text that names a platform — and
  exports its composition function and booklet map instead of a default, because the booklet is
  chosen by configuration. Both are byte-pinned against `test/__snapshots__/`. The `_` prefix here marks a BLOCK PART that IS imported and composed — it is not a standalone
  name you can select via the header.
- **Shared-text alias** — an explicit named export in the barrel points to another registered
  prompt's final text when the semantic input/output contract is identical but routing or access is
  intentionally different. The alias owns its own registry entry and maintenance doc but no duplicate
  runtime text. `visual-verify-free` is the only alias. A change to shared text updates both maintenance
  docs in the same change.

**`onboarding-shared/` is NOT a prompt — it is the shared block library.** Its `_shared-*.md` /
`_block-*.md` files are the instruction fragments duplicated across MORE THAN ONE composed prompt (box
vocabulary, the JSON-only hardening lines, the mobile rule, the correction verbs, the INSERT-only
placement block, the off-page segment/discount blocks, the `_block-fixed-rules.md` enforced-rule block
whose first line is the cross-repo `ONBOARDING_RULESET_VERSION`, …). They live in their own folder precisely BECAUSE
they are used in multiple places: a block used by one prompt only stays a fragment inside that prompt's own
folder; a block shared across prompts is hoisted to `onboarding-shared/` so a single edit updates every
composer. It never gets a registry entry and never gets a `docs/prompts/` doc.

**`assistant-shared/` is the second shared block library**, for the conversational assistant
prompts: `_shared-chat-formatting.md` (the chat-bubble formatting rules), composed by `chat` and
`grader-chat`. Each of the two keeps its identity in its own folder, because Studio names the
platforms it serves and the Grader leaves platforms to the booklet. Like `onboarding-shared/`, it is
never a registered prompt.

## Grader chat booklets

`grader-chat/booklets/v<version>.md` are marketing's booklets; `GRADER_CHAT_BOOKLET_VERSION` selects
one and the barrel's `graderChatBookletSources` maps each version to its file. A booklet keeps
exactly the six level-2 headings `GRADER_CHAT_BOOKLET_HEADINGS` names (`grader-chat/index.ts`), in
order, and stays under the size cap `test/assistant-prompt-blocks.test.ts` pins. HTML comments are
editor notes, stripped before the model sees the text. The boundaries block names its sections: a
price is stated only by quoting Prices we may state word for word, so a price carries its currency
and, when recurring, its period, and a trial or fee fact only as Claims we may make states it. No
check in code holds the model to the booklet; the prompt does. A reply that repeats a booklet line
still goes through the link guard, so every non-blank line of every booklet passes it, which
`test/assistant-prompt-blocks.test.ts` pins; a brand whose name is shaped like a hostname joins the
guard's brand list in `src/lib/grader-chat-output.ts` before a booklet names it. New wording is a
new version file, never an edit to a published one, so the `bookletVersion` a reply reports names
the text it was grounded in; the change updates `docs/prompts/grader-chat.md`. The repository has
no CODEOWNERS file, so marketing's ownership is a review convention, not an enforced rule.

## Registered-prompt inventory

`../prompt-registry.ts` is the authoritative list of registered prompts; the reading aid over it — every prompt with its shape, endpoint, tools, and role — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md) → "Registered prompts", read on demand. Every folder in `src/prompts/` EXCEPT `onboarding-shared/` and `assistant-shared/` is exactly one registered prompt; every loose prompt `.md` at this level EXCEPT the adapter-internal `kimi-html-retrieval.md` is a single-file registered prompt; and every shared-text alias is declared explicitly in the barrel.

### The `-all` twins are NOT duplicates

`onboarding-batch` and `onboarding-batch-all` are DIFFERENT registered prompts with DIFFERENT scope, and
BOTH ship:

- **`onboarding-batch`** plans ONE page per call.
- **`onboarding-batch-all`** plans EVERY page in a SINGLE completion (the fast-show's one masked wait) and
  additionally returns store-wide/scoped `visualActions` plus off-page `segments` + `discounts`. The lib falls back to looping
  `onboarding-batch` per page when `-all` is unavailable or omits a page — so the single-page twin is a live
  fallback, not dead code.

The same single-page ↔ whole-store split holds for `onboarding-review` ↔ `onboarding-review-all`. The
`cartdrawer-*-all` and `optimize-demand` prompts are single-surface conductors that reuse the same shared
blocks. They share the `onboarding-shared/` library, so the shape looks similar — but each is its own
registered prompt selected by its own header name, with its own maintenance doc. `-batch`/`-batch-all`
propose; `-review`/`-review-all` judge — propose and QC are distinct passes, never the same prompt.

All three review composers (`onboarding-review`, `onboarding-review-all`, and
`cartdrawer-review-all`) expose exactly four correction verbs: `styleBox`, `removeBox`, `addBox`, and
`moveBox`. `addBox` is only for a missing box; relocation of an existing box is one `moveBox` with
`position` + `anchorNumber` and no appearance keys. A `removeBox` + `addBox` pseudo-move is forbidden;
lib rejects both halves atomically. Keep the shared verb preamble, each prompt's verb-detail/rules
fragments, maintenance docs, and byte baselines synchronized.

The holistic proposal must always make an explicit currency decision. When deterministic candidates
exist it selects one of them (including the explicit `none` decision); without candidates it may return
a tightly validated six-argument inferred format. `onboarding-currency-recovery` is only the bounded
omission-recovery seam before first QC. It sees a compact subset of the already-uploaded price-bearing
tiles, never captures again, and returns the same `setCurrencyFormat` visual-action union.
Common `onboarding-review-all` responses contain page corrections, closed issue codes, and
`needsEscalation`, not visual actions. `advanced-css-required` pages enter
`onboarding-css-review`; that medium-effort specialist is the only review stage allowed to emit
managed scoped-CSS actions.

## `probe-<id>` sub-convention

A probe is a `/messages` prompt for Website Analysis (evidence in → JSON out, no tools). Beyond the doc-sync
rule above, a probe ALSO registers its frozen output schema in `PROBE_SCHEMAS` (`../prompt-registry.ts`) under its
`probe-<id>` name and ships its text at `probe-<id>/prompt.md`. See the root CLAUDE.md → Website-Analysis
probes.
