# Onboarding Review (All Pages) — Maintenance Doc

The design/maintenance record for the `onboarding-review-all` prompt — the WHOLE-STORE REVIEW twin of [`onboarding-batch-all`](onboarding-batch.md). It is a **COMPOSED prompt** assembled by `composePrompt(...)` in [`src/prompts/onboarding-review-all/index.ts`](../../src/prompts/onboarding-review-all/index.ts). The common review does not compose the visual-actions block: currency is a deterministic/recovery hard gate, and advanced CSS uses the targeted `onboarding-css-review` specialist. The effective text is byte-pinned by [`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts).

## Where it sits

Whole-store onboarding starts with one **propose-all** ([`onboarding-batch-all`](onboarding-batch.md)) for every page's plan. Currency validity is resolved through its deterministic/recovery gate. After rendering, **review-all** judges all current pages and returns standard page corrections. Pages explicitly requiring advanced CSS enter a separate specialist gate before release.

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is NOT a `probe-<id>` name: it is an onboarding step, not a Website-Analysis capability.

## `onboarding-review-all`

- **Purpose:** Judge every current onboarding revision against its stable round-0 baseline, clean store references, and prior history; return every independent safe page correction and store-wide/scoped visual action together, iterating until the visual result passes.
- **Consistency is in scope, store-wide:** verdicts stay per-page, but the judge compares ACROSS pages (its whole-store advantage): sibling strips on a page share one visual rhythm (card size, corner treatment, arrows) and the same box type looks the same on every page — a deviating instance gets a `styleBox` aligning it to the dominant treatment (the `bundle`-style FBT + the progress bar are exempt natures). Internal-looking TITLES (`_LS` suffix, raw type names) are reported in `feedback` with a `failureClass` and NO correction (no title verb exists).
- **`addBox` is additive-only:** its `position` is `before`/`after` (never `replace`) — corrections re-place OUR boxes; merchant content always stays.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`), like `onboarding-review`.
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **maxTokens:** 8192 — the whole-store payload (a verdict per page) needs more output room than the single-page review's 2048 (mirrors how `onboarding-batch-all` bumped 4096→8192 over `onboarding-batch`).
- **Effort:** adaptive `low` fast path → `medium` recovery. Lib marks recovery after missing page coverage, parse/schema failure, `max_tokens`, explicit uncertainty/escalation, or failed quality invariants.
- **Attachments:** none. The lib uploads every page's after-render screenshots per request.

### Input (what the lib provides)

The lib transport is `brain/batch.ts::reviewAllPages` (→ `sanitizeMultiPageReviewResult`). Its fast path ships one `POST /messages`:

- **Current revision images** — desktop/mobile screenshots for every page changed in this round, uploaded through `/files`.
- **Contextual references** — round-0 baseline and unchanged clean store pages precede current-round content. Pre-customization originals are not sent.
- **A revision manifest** — CURRENT page screenshots/plans, round-0 BASELINE references, PRIOR HISTORY of verdicts/actions, and CLEAN STORE REFERENCE pages.

The judge evaluates each page at BOTH widths; mobile is FIRST-CLASS (majority of shoppers), so a page PASSES only if it looks right on both. Placement + styling are single RESPONSIVE settings (one plan drives both widths, so a fix changes both).

### Frozen output contract

The assistant text is one compact JSON object with required `pages` and `needsEscalation`. Each verdict keeps human-readable feedback and may include closed `issueCodes` for deterministic recovery routing:

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
        { "action": "styleBox" | "removeBox" | "addBox" | "moveBox", "args": { "page": "Product", ... } }
      ],
      "failureClass": "placement" | "styling",
      "issueCodes": ["styling" | "responsive" | "render-missing" | "evidence-incomplete" | "uncertain" | "advanced-css-required"]
    }
  },
  "needsEscalation": false
}
```

- Top-level `pages` — an object keyed by page name (`Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`), one entry per manifest page.
- Required `needsEscalation` — true for incomplete evidence, uncertainty, unresolved defects, or a CSS specialist requirement.
- Each page's verdict is exactly `{ pass, feedback, corrections, failureClass }` — the identical per-page contract as [`onboarding-review`](onboarding-review.md):
  - `pass` — boolean; `true` only when nothing is worth correcting on that page AT EITHER WIDTH.
  - `feedback` — non-empty string; a short summary citing that page's screenshots. Names the width when a problem affects only one.
  - `corrections` — array of `{ action, args }`, **limited to the four existing write verbs** (`styleBox` / `removeBox` / `addBox` / `moveBox`), each `args.page` echoing that page so the conductor targets it. `styleBox` `args`: `{ page, boxType, appearancePatch?, appearancePatchMobile? }` (`appearancePatchMobile` = the two mobile knobs `ImageHeightMobile` / `MarginRightMobile`, to fix a MOBILE-ONLY break without touching desktop); `removeBox` `args`: `{ page, boxType }`; `addBox` `args`: `{ page, boxType, position: "before"|"after", anchorNumber, appearancePatch|null, appearancePatchMobile|null }` (additive-only — never `replace`; only for a box the page does NOT already have); `moveBox` `args`: `{ page, boxType, position: "before"|"after", anchorNumber }` (no appearance keys) RE-PLACES a box the page ALREADY has. A re-place is ONE `moveBox`, never a `removeBox` + `addBox` pair: lib rejects both halves of that ambiguous pair atomically. Empty `[]` on pass, or when a real problem has no safe correction.
  - `failureClass` — `null` on `pass: true`; `"placement"` (NON-CRITICAL wrong-slot/order); `"styling"` (CRITICAL bad-render / theme-clash, INCLUDING a one-width break). When both are present on a page, `"styling"` wins.

Each page is judged on its OWN evidence. Missing desktop or mobile screenshots fail closed and request recapture/escalation; desktop pixels are never substituted for mobile. A page cannot pass in a revision that changes it; the next render/review decides whether it passes.

### Lib parser (the shape MUST match)

The lib parses this reply with `brain/batch-output.ts::sanitizeMultiPageReviewResult` → `MultiPageReviewResult = { pages: Array<{ page } & PageReviewResult> }`. That sanitizer accepts BOTH the page-keyed-object form this prompt emits (`{ "Home": { pass, … } }` — the key is the page label, injected onto each verdict) AND the array form (`[{ page, pass, … }]`). Each page's value runs through `sanitizePageReviewResult`, which enforces the `pass ⇄ failureClass` invariant and the three-verb / clamp discipline per page. So the output contract here is field-for-field what the lib parses; a malformed page degrades to a safe failing verdict rather than breaking the batch.

### Adaptive recovery

`reviewAllPages` calls `onboarding-review-all` once at low effort. It retries the same schema at medium effort with a lean payload when coverage, parsing, truncation, uncertainty, or invariants require recovery, then uses bounded two-page chunks only for pages still missing. Verdicts replace by page key, so retries never append duplicate corrections. `advanced-css-required` pages enter `onboarding-css-review`; common-path visual actions are discarded.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: onboarding-review-all`.
- Body: a standard Anthropic messages payload. User content orders round-0 and clean references before current-revision images, followed by the manifest. There is no pre-customization original set and no user-evidence stable-prefix marker. Body omits `model`, `max_tokens`, and effort; the registry owns model/budget and maps the content-free escalation header to effort.
- Telemetry headers: attempt/escalation, revision/pass, page/image/tile counts, and capture/upload spans. The handler records model, max token budget, applied effort, total latency, stop reason, and token/cache usage without evidence content.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **JSON reliability:** the prompt ends with the explicit "respond with ONLY the JSON object" hardening line, a compact schema, and a one-page example. Lib parses tolerantly (`extractJsonObject` keyed off `pages`) and routes malformed/partial output through adaptive lean/chunk recovery.
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.
