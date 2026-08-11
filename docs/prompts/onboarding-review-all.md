# Onboarding Review (All Pages) — Maintenance Doc

The design/maintenance record for the `onboarding-review-all` prompt — the WHOLE-STORE REVIEW twin of [`onboarding-batch-all`](onboarding-batch.md). It is a **COMPOSED prompt**: its system text is assembled by `composePrompt(...)` in the prompt's own barrel [`src/prompts/onboarding-review-all/index.ts`](../../src/prompts/onboarding-review-all/index.ts) from per-prompt fragments in [`src/prompts/onboarding-review-all/`](../../src/prompts/onboarding-review-all/) plus shared blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/), including `_block-visual-actions.md`, the enforced-rule block, JSON hardening, review classification, correction verbs, and the review box vocabulary. The effective text is pinned byte-for-byte by [`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts). Registered as `onboarding-review-all` in `src/prompt-registry.ts`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Where it sits

Whole-store onboarding starts with one **propose-all** ([`onboarding-batch-all`](onboarding-batch.md)) for every page's plan and initial visual actions. After the atomic application renders, **review-all** (`onboarding-review-all`, this doc) judges the current revision and returns all safe page corrections plus visual actions together. The conductor renders and calls review-all again until the current pages pass or the bounded QC loop terminates.

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is NOT a `probe-<id>` name: it is an onboarding step, not a Website-Analysis capability.

## `onboarding-review-all`

- **Purpose:** Judge every current onboarding revision against its stable round-0 baseline, clean store references, and prior history; return every independent safe page correction and store-wide/scoped visual action together, iterating until the visual result passes.
- **Consistency is in scope, store-wide:** verdicts stay per-page, but the judge compares ACROSS pages (its whole-store advantage): sibling strips on a page share one visual rhythm (card size, corner treatment, arrows) and the same box type looks the same on every page — a deviating instance gets a `styleBox` aligning it to the dominant treatment (the `bundle`-style FBT + the progress bar are exempt natures). Internal-looking TITLES (`_LS` suffix, raw type names) are reported in `feedback` with a `failureClass` and NO correction (no title verb exists).
- **`addBox` is additive-only:** its `position` is `before`/`after` (never `replace`) — corrections re-place OUR boxes; merchant content always stays.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`), like `onboarding-review`.
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **maxTokens:** 8192 — the whole-store payload (a verdict per page) needs more output room than the single-page review's 2048 (mirrors how `onboarding-batch-all` bumped 4096→8192 over `onboarding-batch`).
- **Effort:** `medium` — supports exhaustive multi-page comparison, prior-round reasoning, and a complete atomic correction set within the 8192-token output budget.
- **Attachments:** none. The lib uploads every page's after-render screenshots per request.

### Input (what the lib provides)

The lib transport is `brain/batch.ts::reviewAllPages` (→ `sanitizeMultiPageReviewAllRoundTrip`). It ships, in ONE `POST /messages`:

- **Current revision images** — desktop/mobile screenshots for every page changed in this round, uploaded through `/files`.
- **Stable and contextual references** — the original pre-customization and round-0 baseline references stay before volatile current-round content; unchanged clean store pages provide store-wide comparison evidence.
- **A revision manifest** — CURRENT page screenshots/plans, round-0 BASELINE references, PRIOR HISTORY of verdicts/actions, CLEAN STORE REFERENCE pages, and currency metadata/candidates when available.

The judge evaluates each page at BOTH widths; mobile is FIRST-CLASS (majority of shoppers), so a page PASSES only if it looks right on both. Placement + styling are single RESPONSIVE settings (one plan drives both widths, so a fix changes both).

### Frozen output contract

The assistant text is a single JSON object with a top-level `pages` object and optional `visualActions`. `pages` maps each current page name to the SAME per-page verdict shape `onboarding-review` emits:

```json
{
  "pages": {
    "Home": {
      "pass": true,
      "feedback": "short human-readable summary of Home",
      "corrections": [],
      "failureClass": null
    },
    "Product": {
      "pass": false,
      "feedback": "short summary of what's off on Product (name the width if one-sided)",
      "corrections": [
        { "action": "styleBox" | "removeBox" | "addBox", "args": { "page": "Product", ... } }
      ],
      "failureClass": "placement" | "styling"
    }
  },
  "visualActions": []
}
```

- Top-level `pages` — an object keyed by page name (`Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`), one entry per manifest page.
- Optional top-level `visualActions` — sanitized currency-format and page/component-scoped advanced-CSS upsert/remove actions. Appearance properties are preferred; managed CSS selectors begin with `&` and never target merchant/theme elements globally.
- Each page's verdict is exactly `{ pass, feedback, corrections, failureClass }` — the identical per-page contract as [`onboarding-review`](onboarding-review.md):
  - `pass` — boolean; `true` only when nothing is worth correcting on that page AT EITHER WIDTH.
  - `feedback` — non-empty string; a short summary citing that page's screenshots. Names the width when a problem affects only one.
  - `corrections` — array of `{ action, args }`, **limited to the three existing write verbs** (`styleBox` / `removeBox` / `addBox`), each `args.page` echoing that page so the conductor targets it. `styleBox` `args`: `{ page, boxType, appearancePatch?, appearancePatchMobile? }` (`appearancePatchMobile` = the two mobile knobs `ImageHeightMobile` / `MarginRightMobile`, to fix a MOBILE-ONLY break without touching desktop); `removeBox` `args`: `{ page, boxType }`; `addBox` `args`: `{ page, boxType, position: "before"|"after", anchorNumber, appearancePatch|null, appearancePatchMobile|null }` (additive-only — never `replace`; a re-place is `removeBox` + `addBox`). Empty `[]` on pass, or when a real problem has no safe correction.
  - `failureClass` — `null` on `pass: true`; `"placement"` (NON-CRITICAL wrong-slot/order); `"styling"` (CRITICAL bad-render / theme-clash, INCLUDING a one-width break). When both are present on a page, `"styling"` wins.

Each page is judged on its OWN evidence — one page's verdict never affects another's. A page cannot pass in a revision that changes it through a page correction or visual action; the next render/review decides whether that revision passes.

### Lib parser (the shape MUST match)

The lib parses this reply with `brain/batch-output.ts::sanitizeMultiPageReviewResult` → `MultiPageReviewResult = { pages: Array<{ page } & PageReviewResult> }`. That sanitizer accepts BOTH the page-keyed-object form this prompt emits (`{ "Home": { pass, … } }` — the key is the page label, injected onto each verdict) AND the array form (`[{ page, pass, … }]`). Each page's value runs through `sanitizePageReviewResult`, which enforces the `pass ⇄ failureClass` invariant and the three-verb / clamp discipline per page. So the output contract here is field-for-field what the lib parses; a malformed page degrades to a safe failing verdict rather than breaking the batch.

### Fallback (why the lib works even before this deploys)

`reviewAllPages` calls `onboarding-review-all` first and, on a transport error OR any page the reply omits, falls back to looping the per-page [`onboarding-review`](onboarding-review.md) prompt and assembling the same `MultiPageReviewResult` (mirroring how `resolveAllPlans` degrades `onboarding-batch-all` → per-page `onboarding-batch`). So the QC works today via the per-page fallback and upgrades transparently once this prompt is deployed.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: onboarding-review-all`.
- Body: a standard Anthropic messages payload. User content orders the stable original/round-0 reference image prefix before volatile current-revision images, followed by the revision manifest (CURRENT pages/plans, BASELINE, PRIOR HISTORY, CLEAN STORE REFERENCES, and currency evidence). The terminal stable reference block carries the internal cache-prefix marker consumed by `lib/cache-control.ts`. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **JSON reliability:** the prompt ends with the same explicit "respond with ONLY the JSON object, no prose, no markdown code fences" hardening line + a small flat schema + an inline whole-store example. The lib parses tolerantly (`extractJsonObject` keyed off `pages`: direct / fenced / embedded) with a bounded repair-retry — the same tolerant-parse baseline the other batch prompts run in production.
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.
