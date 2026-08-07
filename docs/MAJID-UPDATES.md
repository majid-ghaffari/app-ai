# Majid's prompt program on `aidin/website-analysis-probes` — eng review guide

**Branch:** `aidin/website-analysis-probes` (pushed to the fork
`majid-ghaffari/app-ai`; Majid's account is pull-only on `limespot/app-ai`, so
this lands via a cross-fork PR). **Read together with the lib companion doc**
`lib/packages/storefront/src/admin/docs/MAJID-UPDATES.md` — every prompt round
here pairs with a lib commit on `aidin/studio-website-analysis`, and the two
were validated TOGETHER on live fresh-store onboarding runs (majiddev-plus,
FREE Claude-Code shim channel — zero paid API).

## What this branch encodes

The AI onboarding's PROPOSE + REVIEW prompts now carry LimeSpot's best-practice
playbook verbatim: per-page box stacks (Home / Product / Collection / Cart /
SlidingCart / **Search**), placement discipline, store-matched styling, and the
QC review's consistency judgments. The prompts are COMPOSED from `_`-prefixed
block files (`composePrompt`, byte-pinned by `test/__snapshots__/*.baseline.md`
— see `docs/PROMPT-AUTHORING.md`); the per-prompt maintenance docs live in
`docs/prompts/`.

## The engineering principles behind the prompt choices (review lens)

1. **Guideline + deterministic lib backstop, never prompt-only.** Every rule a
   model might under-apply has a deterministic twin in the lib (an anchor the
   enumerator refuses to offer, a derive seed, a whitelist). The prompt earns
   adherence; the lib guarantees the invariant. Where you see a prompt rule,
   expect its lib twin in the companion doc.
2. **Models imitate the example JSON far more than prose.** The single most
   effective adherence lever all week was enriching the CANONICAL EXAMPLE in
   `_output-and-rules.md` to model the FULL appearance patch (Style, counts,
   ExtraClasses, arrows, button clone, title map). Review the examples as
   normative, not decorative.
3. **Additive-only placement (operator hard rule).** Onboarding NEVER removes
   or replaces merchant content — `position` is `before`/`after` only; green
   REPLACE candidates are boundaries + style references. The replace machinery
   remains in the lib for a future Optimization process; re-enabling it is a
   prompt-level change.
4. **Store-matched, never fixed numbers.** Counts, image cells, buttons,
   arrows, titles, and gutters are all read OFF THE STORE (screenshots + the
   reference candidate's outerHTML), with hard CEILINGS (≤6/line, grid ≤2
   rows, bundle 3, slider 1, rows 2) — the AI may go lower, never higher.

## Uncommitted-round changes in THIS commit (2026-07-23) — with rationale

- **`_block-box-placement.md` — "SECTIONS ARE ATOMIC" rule.** Live runs wedged
  boxes between a section's grid and its own "View all", and over the Home
  hero. The prompt now teaches that a theme section is ONE unit and boxes land
  only at SECTION SEAMS. _Why prompt + lib both:_ the lib twin (the
  outer-section anchor LIFT in `injection-points.ts`) removes inner seams from
  the offered menu entirely; the prompt rule keeps the model's reasoning
  aligned with the menu it sees.
- **`_pb-detail.md` (batch + batch-all) — the Search stack.** Most Popular
  DIRECTLY UNDER the search field (anchor labeled "the search field",
  `"after"`), Recently Viewed at the bottom. _Iteration record:_ "top of the
  page" (v1) and "before the search results" (v2) both failed live — Dawn's
  heading + field + results share ONE section, so a section-seam anchor could
  only offer the space ABOVE the field. The final wording names the exact
  labeled anchor + edge and explains WHY (Most Popular reacts to the searched
  keywords), because rules that carry their motivation measurably adhere
  better.
- **`_pb-detail.md` — uniform image cells + gutter fallback classes.** The
  styling discipline now requires the `ImageMaxWidth`+`ImageMaxHeight` PAIR
  (one uniform image cell per strip — a towering natural-height image beside
  small ones is called out as broken), and the gutter rule carries the
  fallback wrapper classes support uses in the field (`page-width` /
  `container` / `content-container` — sourced from the support KB; emit only
  what the store's own markup shows). Lib twins: `DEFAULT_IMAGE_MAX_HEIGHT`
  derive seed; `detectContentWrapperClass`.
- **`_appearance-keys.md` (batch + batch-all) + review `_why-and-receive.md`
  (review + review-all).** The appearance vocabulary and the QC's consistency
  judgment updated in lockstep with the above (the review judges uniform image
  cells: "a strip whose images render at DIFFERENT sizes fails").
- **`docs/prompts/onboarding-batch{,-all}.md` re-synced** — stale caps
  (fixed "4/line" → store-matched ≤6), the outdated "no `bundle` Style value",
  and the missing Search line. The maintenance docs are the eng-facing
  contract record; they must never lag the served prompts.
- **Baselines regenerated** (`test/__snapshots__/*.baseline.md`) — the
  byte-equivalence pins over the composed prompts; 388/388 vitest green.

## Prior rounds on this branch (each a paired lib round; see the lib doc)

- `591303e` — the playbook encoded (per-page stacks + the drawer PB slot).
- `664f808` — Related Items joins the Cart stack (after FBT, above RV).
- `a32f986` — additive-only placement; explicit playbook styles per box; QC
  consistency judgments (within-page rhythm).
- `29d8460` — store-matched card geometry (`ItemsPerPage` = the store's own
  per-row count), button clone (`Default.QuickActions.AddToCart`),
  `circleChevron` arrow default, ONE `Default.Title` store-wide, FBT `bundle`
  on Product only (Cart FBT is a carousel), labeled-anchor placement ("TRUST
  the labels"), enriched canonical examples.

## Operational rules for anyone iterating these prompts

1. **Restart the local worker after ANY prompt edit and VERIFY** by grepping
   the served module files under `.wrangler/tmp/dev-*/` for a phrase from your
   edit — wrangler's watcher misses .md-only edits, and a failed restart can
   false-pass health checks (the old process keeps the port).
2. **Every propose-prompt change needs a lib-side
   `SCREEN_CACHE_PLAYBOOK_VERSION` bump** (`lib admin/ai/screen-cache.ts`, now 22) or warmed stores replay stale cached plans.
3. **Regenerate the baselines** after any block edit (the compose orders live
   in each prompt's `index.ts`) and keep `docs/prompts/<name>.md` in sync —
   both are review gates.

## Deploy note

Prod serves prompts from the DEPLOYED worker. Until this branch is merged into
`limespot/app-ai` and deployed, prod runs the older playbook — the lib
references prompts by name, so the lib branch is safe to merge independently
but only realizes the new behavior once this worker ships.
