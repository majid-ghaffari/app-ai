# Onboarding Review — Maintenance Doc

The design/maintenance record for the `onboarding-review` prompt — the REVIEW half of onboarding "batch mode". It is a **COMPOSED prompt**: its system text is assembled by `composePrompt(...)` in the prompt's own barrel [`src/prompts/onboarding-review/index.ts`](../../src/prompts/onboarding-review/index.ts) from per-prompt fragments in [`src/prompts/onboarding-review/`](../../src/prompts/onboarding-review/) plus SHARED blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/) (the enforced-rule block `_block-fixed-rules.md` whose first line is the cross-repo `ONBOARDING_RULESET_VERSION` — see DECISIONS.md #17, the JSON-only hardening lines, the review classification bullets, the correction-verbs intro, the review box-vocabulary line), pinned byte-for-byte by [`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts). Registered as `onboarding-review` in `src/prompt-registry.ts`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Where it sits

Onboarding batch mode runs a per-page cycle: ONE **propose** call ([`onboarding-batch`](onboarding-batch.md)) returns the whole page's plan; the lib conductor applies it box-by-box; then ONE **review** call (`onboarding-review`, this doc) judges the RENDERED page and returns corrections. It mirrors [`visual-verify`](visual-verify.md) — a multi-modal judge whose truth is the pixels, not the config.

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is NOT a `probe-<id>` name: it is an onboarding step, not a Website-Analysis capability.

## `onboarding-review`

- **Purpose:** Judge whether an onboarding page rendered well after the plan was applied, and classify any failure — NON-CRITICAL placement vs CRITICAL styling — returning corrections the conductor can apply.
- **Consistency is in scope, page-wide:** sibling strips on the page share one visual rhythm (card size, corner treatment, arrows); a deviating strip gets a `styleBox` aligning it to the page's dominant treatment (the `bundle`-style FBT + the progress bar are exempt natures). Internal-looking TITLES (`_LS` suffix, raw type names) are reported in `feedback` with a `failureClass` and NO correction (no title verb exists).
- **`addBox` is additive-only:** its `position` is `before`/`after` (never `replace`) — corrections re-place OUR boxes; merchant content always stays.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`), like `visual-verify`.
- **Effort:** `low` — preserves the output budget for the required JSON, including when this route is the whole-store fallback.
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **Attachments:** none. The lib uploads the after-render screenshot per request.

### Input (what the lib provides)

- **page** — the page name (`Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`).
- **TWO after-render screenshots at two widths** (each an image, uploaded via `/files`) — a **desktop** and a **mobile** (phone-width) full-page screenshot AFTER the plan was applied. The judge evaluates the page at BOTH widths; mobile is FIRST-CLASS (majority of shoppers), so the page PASSES only if it looks right on both.
- **plan** (text block) — the plan that was applied (the same shape `onboarding-batch` emits), so the judge knows what was supposed to be on the page and where. Placement + styling are single RESPONSIVE settings (one plan drives both widths, so a fix changes both).

### Frozen output contract

The assistant text is a single JSON object, exactly:

```json
{
  "pass": true,
  "feedback": "short human-readable summary",
  "corrections": [
    { "action": "styleBox" | "removeBox" | "addBox", "args": { } }
  ],
  "failureClass": "placement" | "styling" | null
}
```

- `pass` — boolean; `true` only when nothing is worth correcting AT EITHER WIDTH (desktop and mobile).
- `feedback` — non-empty string; a short summary citing what the screenshots showed. Names the width when a problem affects only one (e.g. "…cramped on mobile but fine on desktop").
- `corrections` — array of `{ action, args }`. **Limited to the two existing write verbs** (no new mutation types): `styleBox` (an appearance patch, `args`: `{ page, boxType, appearancePatch?, appearancePatchMobile? }` — set `appearancePatch` to fix a both-widths clash, `appearancePatchMobile` (the two mobile knobs `ImageHeightMobile` / `MarginRightMobile`) to fix a MOBILE-ONLY break without touching desktop), and `addBox` / `removeBox` (toggle). Each correction is a single RESPONSIVE change (one placement/style setting for both widths — no per-width correction). `addBox` re-places by the SAME section semantics as propose — `args`: `{ page, boxType, position: "before"|"after", anchorNumber, appearancePatch|null, appearancePatchMobile|null }` (additive-only — never `replace`; a placement re-place is expressed as `removeBox` + `addBox` before/after the correct numbered section); `removeBox` `args`: `{ page, boxType }`. Empty `[]` on pass, or when a real problem has no safe correction.
- `failureClass` — **the crucial classification (hard operator requirement):**
  - `null` — everything looks good at both widths (`pass: true`, `corrections: []`).
  - `"placement"` — NON-CRITICAL: a box is in a slightly-wrong SLOT / order but otherwise fine. Surface a correction if fixable, but this alone does not make the page "broken".
  - `"styling"` — CRITICAL: a box renders badly / looks broken / clashes with the store's styling and can't be made to match — INCLUDING a break at only one width (commonly mobile) even if the other looks fine. When both a placement and a styling problem are present, `"styling"` wins.

No extra keys, no missing keys.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: onboarding-review`.
- Body: a standard Anthropic messages payload. User content = TWO after-render screenshot (image) blocks (desktop + mobile, uploaded via `POST /files`) plus a text block carrying the page name + the applied plan. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **JSON reliability:** the prompt ends with the same explicit "respond with ONLY the JSON object, no prose, no markdown code fences" hardening line + a small flat schema + inline examples. The lib parses tolerantly (`structured-output.ts`: direct / fenced / embedded) with a bounded repair-retry — the same tolerant-parse baseline `visual-verify` runs in production. Forced `tool_choice` schema-constrained output is available on the prod worker but NOT the dev shim (see the assessment note).
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.
