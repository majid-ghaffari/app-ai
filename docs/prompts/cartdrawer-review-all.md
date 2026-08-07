# Cart-Drawer Review (Single Surface) — Maintenance Doc

The design/maintenance record for the `cartdrawer-review-all` prompt — the SINGLE-SURFACE REVIEW twin of the cart-drawer PROPOSE prompt [`cartdrawer-batch-all`](cartdrawer-batch-all.md), and the drawer-scoped analogue of the whole-store [`onboarding-review-all`](onboarding-review-all.md). It is a **COMPOSED prompt**: its system text is assembled by `composePrompt(...)` in the prompt's own barrel [`src/prompts/cartdrawer-review-all/index.ts`](../../src/prompts/cartdrawer-review-all/index.ts) from per-prompt fragments in [`src/prompts/cartdrawer-review-all/`](../../src/prompts/cartdrawer-review-all/) plus the SAME SHARED review blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/) that `onboarding-review` / `onboarding-review-all` compose (the JSON-only hardening line, the review classification bullets, the correction-verbs intro, the review box-vocabulary line, the JSON-only tail). Registered as `cartdrawer-review-all` in `src/prompt-registry.ts`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Where it sits

The cart-drawer conductor is the framework's SECOND flow (a peer of onboarding, see the lib's `ai/conductor/`): it opens the merchant's cart DRAWER — the slide-out overlay — in place, screenshots the OPEN drawer at desktop + mobile widths, PROPOSES recommendation box(es) to place INSIDE it ([`cartdrawer-batch-all`](cartdrawer-batch-all.md)), applies them, then does a VISUAL REVIEW (`cartdrawer-review-all`, this doc). It is a SINGLE surface (the open drawer), NOT paginated — so, unlike `onboarding-review-all` (which returns a per-page `pages` map), this prompt returns ONE **flat** verdict for the drawer, no `pages` wrapper. It is the QC-side twin of `cartdrawer-batch-all` in the exact way `onboarding-review-all` is the QC-side twin of `onboarding-batch-all`.

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is NOT a `probe-<id>` name: it is a conductor step, not a Website-Analysis capability.

## `cartdrawer-review-all`

- **Purpose:** Judge whether the recommendation box(es) rendered well INSIDE the OPEN cart drawer after the plan was applied, at BOTH widths, and classify any failure — NON-CRITICAL placement vs CRITICAL styling (INCLUDING a box that overflows the narrow drawer or pushes the checkout CTA out of reach) — returning corrections the conductor can write, re-render, and re-review.
- **Consistency is in scope:** everything in the drawer reads as ONE designed column — strips share card size / corner treatment / arrow style with each other and with the store's own card styling; a deviating strip gets a `styleBox`. Internal-looking TITLES are reported in `feedback` with a `failureClass` and NO correction (no title verb exists).
- **`addBox` is additive-only:** its `position` is `before`/`after` (never `replace`) — corrections re-place OUR boxes; merchant content always stays.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`), like `onboarding-review` / `onboarding-review-all`.
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **maxTokens:** 2048 — a SINGLE surface's verdict fits the single-page review budget (matches `onboarding-review`), not the whole-store `onboarding-review-all` bump to 8192 (which pays for a verdict PER PAGE).
- **Attachments:** none. The lib uploads the open drawer's after-render screenshots per request.

### Input (what the lib provides)

The lib transport is `brain/batch.ts::reviewCartDrawer` (→ `sanitizeDrawerReviewResult`), invoked by the cart-drawer conductor (`conductor/cartdrawer-conductor.ts`). It ships, in ONE `POST /messages`:

- **The OPEN drawer's after-render tiles** — the DESKTOP tile(s) then the MOBILE (phone-width) tile(s), concatenated into one ordered image block list, each uploaded via `/files`. These are CLEAN after-render screenshots (no markers) of the OPEN cart drawer — the drawer as the merchant sees it now, with the applied box(es) in place. When no mobile companion is available the mobile tiles degrade to the desktop tiles.
- **A drawer MANIFEST** (a text block) — ONE line naming which uploaded images are the drawer's DESKTOP tiles vs its MOBILE tiles (by 1-based position in the image list) plus the drawer's serialized **applied plan** (the flat `{ boxes }` shape `cartdrawer-batch-all` emits). Example line:
  - `DRAWER: DESKTOP TILES images 1-1, MOBILE TILES images 2-2, APPLIED PLAN {"boxes":[…]}`
  - plus a bare trigger line (`DRAWER_REVIEW_TRIGGER`, e.g. `Review the rendered cart drawer above.`).

The judge evaluates the drawer at BOTH widths; mobile is FIRST-CLASS (majority of ecommerce shoppers), so the drawer PASSES only if it looks right on both. Placement + styling are single RESPONSIVE settings (one plan drives both widths, so a fix changes both). The drawer is a COMPACT slide-out OVERLAY — a narrow column with line items, a subtotal, and a checkout CTA — so a box that fits a full page can be too big for it: the box must be small, must not push the checkout CTA out of reach, and must not overflow the narrow column at either width.

### Frozen output contract

The assistant text is a single JSON object — a FLAT verdict for the drawer, `{ pass, feedback, corrections, failureClass }`. There is NO `pages` wrapper and NO per-page map: this is ONE surface (the open drawer), so every correction targets the drawer implicitly (there is NO `page` field). Nothing else.

```json
{
  "pass": false,
  "feedback": "The cross-sell strip rendered below the line items and above checkout as planned and matches the store's flat, square cards on desktop, but on mobile the row of 3 cards overflows the narrow drawer and forces a horizontal scroll — drop it to 2 per row so it fits the phone width.",
  "corrections": [
    {
      "action": "styleBox",
      "args": {
        "boxType": "CrossSell",
        "appearancePatch": { "ItemsPerPage": 2, "ItemsLimit": 4 }
      }
    }
  ],
  "failureClass": "styling"
}
```

- The verdict is exactly `{ pass, feedback, corrections, failureClass }` — the identical per-verdict contract as [`onboarding-review`](onboarding-review.md), MINUS the surface/page dimension:
  - `pass` — boolean; `true` only when the drawer has nothing worth correcting AT EITHER WIDTH; `false` whenever there is a placement or styling issue on desktop OR mobile.
  - `feedback` — non-empty string; a short summary citing what the drawer's screenshots showed. Names the width when a problem affects only one (e.g. "…overflows the drawer on mobile but fine on desktop"). Never generic.
  - `corrections` — array of `{ action, args }`, **limited to the three existing write verbs** (`styleBox` / `removeBox` / `addBox`), each `args` targeting the drawer implicitly (NO `page` field — single surface). Each correction is a single RESPONSIVE change (one placement/style setting for both widths — there is no per-width correction). Empty `[]` on pass, or when a real problem has no safe correction. `styleBox` `args`: `{ boxType, appearancePatch?, appearancePatchMobile? }` (`appearancePatch` = the desktop-and-shared keys `Style` / `ItemsPerPage` / `ItemsLimit` / `ImageBorderRadius` / `NavigationArrowType`; use it to SHRINK a box that overflows the narrow drawer; `appearancePatchMobile` = the two mobile knobs `ImageHeightMobile` / `MarginRightMobile`, to fix a MOBILE-ONLY break without touching desktop); `removeBox` `args`: `{ boxType }`; `addBox` `args`: `{ boxType, position: "before"|"after", anchorNumber, appearancePatch|null, appearancePatchMobile|null }` (additive-only — never `replace`; a re-place is `removeBox` + `addBox`).
  - `failureClass` — `null` on `pass: true`; `"placement"` (NON-CRITICAL wrong-slot/order); `"styling"` (CRITICAL bad-render / theme-clash / **overflows-the-narrow-drawer**, INCLUDING a one-width break). When both are present, `"styling"` wins.

A drawer-specific styling failure to watch for: a box too BIG for the narrow drawer — overflowing the column, forcing a horizontal scroll, or pushing the checkout CTA below the fold / out of reach. That is `"styling"` (critical); fix it by shrinking the box (`styleBox` with a lower `ItemsPerPage` / `ItemsLimit`, smaller images) or, if it can't be made to fit, `removeBox`.

### Lib parser (the shape MUST match)

The lib parses this reply with `brain/batch-output.ts::sanitizeDrawerReviewResult` → a flat `PageReviewResult` (the drawer reuses that page-agnostic shape so the shared QC routing/apply path consumes it unchanged). That sanitizer reads the FLAT `{ pass, feedback, corrections, failureClass }` this prompt emits (keyed off `pass` via `extractJsonObject`), enforces the `pass ⇄ failureClass` invariant (a `pass` result carries NO corrections + `failureClass: null`), and runs each correction through `sanitizeDrawerCorrection` — the verb allow-list plus a drawer→shared arg-name NORMALIZATION that aliases `boxType`→`box` and `appearancePatch`→`patch` onto the keys the shared correction dispatch (`applyCorrection`) reads, so the drawer conductor reuses that ONE write path with no per-surface branch. So the output contract here is field-for-field what the lib parses; a malformed / missing blob degrades to a SAFE failing verdict (`pass: false`, no corrections, no failure class) rather than a false pass — the sanitizer NEVER throws.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: cartdrawer-review-all`.
- Body: a standard Anthropic messages payload. User content = the open drawer's after-render screenshot (image) blocks (desktop then mobile, uploaded via `POST /files`) plus a text block carrying the drawer manifest (tile ranges + serialized applied plan) and a bare trigger. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the flat JSON verdict above.
- **JSON reliability:** the prompt ends with the shared explicit "respond with ONLY the JSON object, no prose, no markdown code fences" hardening line + a small flat schema + an inline drawer example. The lib parses tolerantly (`extractJsonObject` keyed off `pass`: direct / fenced / embedded) inside the bounded `withBatchRepairRetry` seam — the SAME tolerant-parse baseline the other batch prompts run in production. A repair attempt is earned when a FAILING verdict has no feedback + no corrections (indistinguishable from the safe empty fallback), mirroring the onboarding `isEmptyReview` gate.
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.

## Composition — the fragment files + shared blocks

`cartdrawerReviewAll = composePrompt(...)` in [`src/prompts/cartdrawer-review-all/index.ts`](../../src/prompts/cartdrawer-review-all/index.ts), in this FROZEN order (a reordered block busts the cache — the composed blocks are the stable, shop-independent prefix `messages.ts` places before the `cache_control` breakpoint; the per-shop VARIABLE data — the open-drawer screenshots + the serialized applied plan — rides AFTER the breakpoint in the first user message, never in a composed block):

| Order | Block                                   | Source                                                                                                                     | Kind       |
| ----- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1     | `cartdrawerReviewIntro`                 | [`cartdrawer-review-all/_intro.md`](../../src/prompts/cartdrawer-review-all/_intro.md)                                     | per-prompt |
| 2     | `sharedJsonHardening`                   | [`onboarding-shared/_shared-json-hardening.md`](../../src/prompts/onboarding-shared/_shared-json-hardening.md)             | **SHARED** |
| 3     | `cartdrawerReviewWhyAndReceive`         | [`cartdrawer-review-all/_why-and-receive.md`](../../src/prompts/cartdrawer-review-all/_why-and-receive.md)                 | per-prompt |
| 4     | `sharedReviewClassify`                  | [`onboarding-shared/_shared-review-classify.md`](../../src/prompts/onboarding-shared/_shared-review-classify.md)           | **SHARED** |
| 5     | `cartdrawerReviewClassifyTail`          | [`cartdrawer-review-all/_classify-tail.md`](../../src/prompts/cartdrawer-review-all/_classify-tail.md)                     | per-prompt |
| 6     | `sharedCorrectionVerbs`                 | [`onboarding-shared/_shared-correction-verbs.md`](../../src/prompts/onboarding-shared/_shared-correction-verbs.md)         | **SHARED** |
| 7     | `cartdrawerReviewCorrectionVerbsDetail` | [`cartdrawer-review-all/_correction-verbs-detail.md`](../../src/prompts/cartdrawer-review-all/_correction-verbs-detail.md) | per-prompt |
| 8     | `sharedBoxVocabReview`                  | [`onboarding-shared/_shared-box-vocab-review.md`](../../src/prompts/onboarding-shared/_shared-box-vocab-review.md)         | **SHARED** |
| 9     | `cartdrawerReviewOutputAndRules`        | [`cartdrawer-review-all/_output-and-rules.md`](../../src/prompts/cartdrawer-review-all/_output-and-rules.md)               | per-prompt |
| 10    | `sharedJsonTail`                        | [`onboarding-shared/_shared-json-tail.md`](../../src/prompts/onboarding-shared/_shared-json-tail.md)                       | **SHARED** |

- **Per-prompt fragments** (drawer-specific, authored anew for this prompt): the intro framing (single-surface visual-verification judge; the drawer is a compact narrow overlay); the receive/manifest note scoped to the OPEN drawer (drawer manifest + both-widths-are-the-same-drawer); a drawer-specific classify tail (the too-big-for-the-narrow-drawer styling failure + the width-naming rule); the correction-verbs DETAIL (`styleBox` / `removeBox` / `addBox` args — with the explicit "NO `page` field, single surface" note + shrink-to-fit guidance); and the SINGLE-SURFACE output+rules (the flat `{ pass, feedback, corrections, failureClass }` contract, NO `pages` wrapper, "fit the drawer" rule).
- **SHARED blocks** (byte-identical files under `onboarding-shared/`, reused verbatim by the onboarding review prompts too): the JSON-only hardening line, the review classification bullets (all-good / placement / styling), the correction-verbs intro (the three-verb allow-list preamble), the review box-vocabulary line, and the JSON-only tail. **⚠️ Editing a shared block updates EVERY prompt that composes it** — `onboarding-review`, `onboarding-review-all`, and this prompt all pull the same review shared blocks. A drawer-only wording change must go in a `cartdrawer-review-all/_*.md` fragment, NEVER in an `onboarding-shared/_shared-*.md` block. Effective-text changes must also update the matching baseline in `test/__snapshots__/` (the byte-equivalence gate fails otherwise).

## The pinning test

`test/cartdrawer-prompts.test.ts` (Vitest) pins both cart-drawer prompts against `src/prompt-registry.ts` registry resolution:

- `cartdrawer-review-all is the \`balanced\` tier (Sonnet), like onboarding-review-all`— asserts`getSystemPrompt('cartdrawer-review-all', ENV)`resolves the SAME model class as`onboarding-review-all` (`ENV.MODEL_BALANCED`).
- `cartdrawer-review-all (REVIEW) — single-surface verdict` — asserts the composed system text carries the flat single-surface verdict contract (the `{ pass, feedback, corrections, failureClass }` shape with NO `pages` wrapper) and reuses the shared review blocks.
- `cart-drawer prompts — cache-prefix stays stable (no per-shop data)` — asserts the composed prefix carries ZERO per-shop VARIABLE data (no live screenshots / applied-plan JSON in a composed block).
