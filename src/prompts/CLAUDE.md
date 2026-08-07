# src/prompts/ — the prompt registry's TEXT + its doc-sync contract

**Parent:** [../../CLAUDE.md](../../CLAUDE.md) (root) — see its **Prompt registry** section for the
build-time bundling, caching, and dispatch mechanics. This folder doc owns two things the root
delegates here: the **doc-sync rule** and the **authoritative prompt inventory** (which folders are
prompts, which are shared blocks, and why the `-all` twins are not duplicates).

Every model-facing system prompt lives here as pure `.md` text. The registry that maps a prompt
NAME → `{ prompt, tier, maxTokens, usesTools, description, attachments, effort?, clientTools? }`
is [`../prompt-registry.ts`](../prompt-registry.ts). The lib references a prompt only BY NAME (the
`X-Personalizer-System-Prompt` header) and never hardcodes prompt content — the lib-side contract is
`packages/storefront/src/admin/ai/CONTRACTS.md` + `docs/AI-LAYER.md` in the lib repo.

## Doc-sync rule (HARD — mirrors the root CLAUDE.md propagation rule)

**Every registered prompt — every key in `systemPrompts` (plus the `chat` / `onboarding` / `placement` /
`proposals` entries) in [`../prompt-registry.ts`](../prompt-registry.ts) — has a maintenance doc at
[`../../docs/prompts/<name>.md`](../../docs/prompts/).** That doc is the evergreen record of the
prompt's purpose, model, tools, input contract, and frozen output contract. Keep the two in lockstep:

1. **Edit a prompt's rules or output contract → update its `docs/prompts/<name>.md` in the SAME change.**
   The doc's Input/Output-contract sections must always describe the current prompt.
2. **Add a prompt →** create its `.md` (single file) or `<name>/` folder (multi-file / composed) here,
   add its registry entry in `../prompt-registry.ts` (+ its `PROBE_SCHEMAS` entry if it's a `probe-<id>`), write
   `docs/prompts/<name>.md`, and add a row to the root CLAUDE.md's registry table.
3. **Rename a prompt →** rename the text file(s), the registry key, and `docs/prompts/<name>.md` together.
4. **Retire a prompt →** delete the text, the registry entry, and the doc together (No Dead Code). A doc
   with no registered prompt, or a registered prompt with no doc, is a broken tree.
5. **Edit a SHARED block (`onboarding-shared/_shared-*.md` / `_block-*.md`) →** it changes EVERY prompt
   that composes it. Update the doc of each composing prompt (or the shared note they carry) and, when the
   composed text changes on purpose, regenerate that prompt's byte baseline in `test/__snapshots__/` — the
   byte-equivalence gate [`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts)
   fails otherwise.

The authoring/iteration workflow (artifact rules, length enforcement, what belongs in a maintenance doc) is
[`../../docs/PROMPT-AUTHORING.md`](../../docs/PROMPT-AUTHORING.md).

## The three shapes (a prompt folder vs a shared-block folder)

A registered prompt is ONE of three shapes (full mechanics in the root CLAUDE.md → Prompt registry):

Every prompt's FINAL text is re-exported by the barrel [`./index.ts`](./index.ts) as a named export, so
`../prompt-registry.ts` is just the registry (`import * as prompts from './prompts'` resolves to that barrel;
each entry's `prompt:` references `prompts.<name>`).

- **Single-file** — one `<name>.md` (e.g. `chat.md`, `placement.md`, `analytics-insights.md`). The barrel
  re-exports its raw `.md` text; the registry uses it directly as `prompt`.
- **Multi-file** — a `<name>/` folder with `prompt.md` (system text) + a non-prompt attachment file
  (`sample.md`); the barrel re-exports both, and `sample.md` is wired through the registry's `attachments`.
  Only `image-selection/` today.
- **Composed** — a `<name>/` folder of `_`-prefixed BLOCK files (no `prompt.md`) PLUS its own
  [`index.ts`](./onboarding-batch/index.ts) that assembles the final text via `composePrompt(...)`
  (from [`./_compose.ts`](./_compose.ts)) out of that prompt's own fragments PLUS shared blocks from
  `onboarding-shared/`, in a STABLE order (the cacheable prefix). The barrel re-exports that folder's
  default. The `_` prefix here marks a BLOCK PART that IS imported and composed — it is not a standalone
  name you can select via the header.

**`onboarding-shared/` is NOT a prompt — it is the shared block library.** Its `_shared-*.md` /
`_block-*.md` files are the instruction fragments duplicated across MORE THAN ONE composed prompt (box
vocabulary, the JSON-only hardening lines, the mobile rule, the correction verbs, the INSERT-only
placement block, the off-page segment/discount blocks, the `_block-fixed-rules.md` enforced-rule block
whose first line is the cross-repo `ONBOARDING_RULESET_VERSION`, …). They live in their own folder precisely BECAUSE
they are used in multiple places: a block used by one prompt only stays a fragment inside that prompt's own
folder; a block shared across prompts is hoisted to `onboarding-shared/` so a single edit updates every
composer. It never gets a registry entry and never gets a `docs/prompts/` doc.

## Registered-prompt inventory (the authoritative list)

Every folder here EXCEPT `onboarding-shared/` is exactly one registered prompt. Single-file prompts are the
loose `.md` files. The full set:

| Prompt                 | Shape           | Endpoint · tools        | Role                                                                                      |
| ---------------------- | --------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `image-selection`      | multi-file¹     | `/messages` · none      | Page HTML + screenshot → CSS selectors for image/text/CTA personalization. LIVE.          |
| `visual-verify`        | single-file     | `/messages` · none      | Multi-modal render → `{ pass, reason, fix }` quality verdict. The shared visual gate.      |
| `chat`                 | single-file     | `/chat` · server tools  | General Studio chat; runs the server-data tool-use agent loop.                            |
| `onboarding-chat`      | single-file     | `/chat` · client tool   | Visual chat twin of `chat`: drops server tools, carries the browser `look_at_page` tool.  |
| `onboarding`           | single-file     | `/chat` · server tools  | New-merchant onboarding assistant; best-practice defaults over the agent loop.            |
| `placement`            | single-file     | `/chat` · none          | One-shot JSON placement proposer on the `fast` tier (currently Haiku).                    |
| `proposals`            | single-file     | `/chat` · server tools  | Per-store SETUP proposer over real page evidence + real store data (`balanced` tier).     |
| `analytics-insights`   | single-file     | `/chat` · none          | One-shot per-tab `{ kind, text }[]` insights over a tab's real analytics data.            |
| `onboarding-batch`     | composed        | `/messages` · none      | Propose one page's boxes (INSERT-only by number + explicit playbook styling). Single-page (`balanced`).  |
| `onboarding-batch-all` | composed        | `/messages` · none      | Whole-store twin of `onboarding-batch`: EVERY page in one call + off-page segments/discounts. |
| `onboarding-review`    | composed        | `/messages` · none      | QC verdict on one rendered page's boxes.                                                   |
| `onboarding-review-all`| composed        | `/messages` · none      | Whole-store twin of `onboarding-review`: QC every page in one call.                        |
| `cartdrawer-batch-all` | composed        | `/messages` · none      | Propose cart-context boxes inside the open cart drawer (single surface) + the OPTIONAL `progressBar` slot (the bar's second host, top of the drawer). |
| `cartdrawer-review-all`| composed        | `/messages` · none      | QC verdict on the cart-drawer boxes (single surface).                                      |
| `optimize-demand`      | composed        | `/messages` · none      | On-demand optimize: propose boxes for the current page, led by the merchant's demand.      |
| `probe-industry`       | probe folder²   | `/messages` · none      | Website-Analysis probe: homepage → `{ industry, confidence, findings }`.                   |
| `probe-cart-wiring`    | probe folder²   | `/messages` · none      | Website-Analysis probe: behavioral cart classification → selectors + `surfaceType`.        |
| `probe-style`          | probe folder²   | `/messages` · none      | Website-Analysis probe: existing product-card styling → style descriptor.                  |
| `probe-template`       | probe folder²   | `/messages` · none      | Website-Analysis probe: template detection → structured descriptor.                        |
| `probe-currency`       | probe folder²   | `/messages` · none      | Website-Analysis probe: SELECT the currency KIND (money vs money_with_currency, two candidates each carrying its sample list) matching the store → `{ candidateId, confidence, reasoning }`. Select-only; never emits format metadata. |

¹ `image-selection/` is the one multi-file prompt that carries an attachment — `prompt.md` (system text)
+ `sample.md` (training examples, wired through the registry's `attachments`, uploaded as a document block).
² A probe is a `<name>/` folder holding just `prompt.md` (no attachment, no composed blocks); it follows the
`probe-<id>` sub-convention below.

### The `-all` twins are NOT duplicates

`onboarding-batch` and `onboarding-batch-all` are DIFFERENT registered prompts with DIFFERENT scope, and
BOTH ship:

- **`onboarding-batch`** plans ONE page per call.
- **`onboarding-batch-all`** plans EVERY page in a SINGLE completion (the fast-show's one masked wait) and
  additionally returns the store-wide off-page `segments` + `discounts`. The lib falls back to looping
  `onboarding-batch` per page when `-all` is unavailable or omits a page — so the single-page twin is a live
  fallback, not dead code.

The same single-page ↔ whole-store split holds for `onboarding-review` ↔ `onboarding-review-all`. The
`cartdrawer-*-all` and `optimize-demand` prompts are single-surface conductors that reuse the same shared
blocks. They share the `onboarding-shared/` library, so the shape looks similar — but each is its own
registered prompt selected by its own header name, with its own maintenance doc. `-batch`/`-batch-all`
propose; `-review`/`-review-all` judge — propose and QC are distinct passes, never the same prompt.

## `probe-<id>` sub-convention

A probe is a `/messages` prompt for Website Analysis (evidence in → JSON out, no tools). Beyond the doc-sync
rule above, a probe ALSO registers its frozen output schema in `PROBE_SCHEMAS` (`../prompt-registry.ts`) under its
`probe-<id>` name and ships its text at `probe-<id>/prompt.md`. See the root CLAUDE.md → Website-Analysis
probes.
