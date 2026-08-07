# On-Demand Optimize (PROPOSE) — Maintenance Doc

The design/maintenance record for the `optimize-demand` prompt — the on-demand OPTIMIZE propose (#98). It is a **COMPOSED prompt**: rather than one `prompt.md`, its system text is assembled by `composePrompt(...)` in the prompt's own barrel [`src/prompts/optimize-demand/index.ts`](../../src/prompts/optimize-demand/index.ts) from per-prompt fragment files in [`src/prompts/optimize-demand/`](../../src/prompts/optimize-demand/) (`_intro.md`, `_receive.md`, `_appearance-keys.md`, `_output-and-rules.md`) plus SHARED blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/) — including the NEW [`_block-user-demand.md`](../../src/prompts/onboarding-shared/_block-user-demand.md) authored for this prompt, and blocks reused verbatim from the onboarding twins (box vocabulary, the JSON-only hardening line, the mobile-first rule, the INSERT+REPLACE box-placement capability, the appearance-patch header, the guidance line, the JSON tail). Because those blocks are SHARED, an edit to one updates every prompt that composes it — a change to `_block-box-placement.md` or `_shared-json-tail.md` here also changes `onboarding-batch` / `-all` and `cartdrawer-batch-all`. The composition and cache-first order are pinned by [`test/optimize-demand-prompt.test.ts`](../../test/optimize-demand-prompt.test.ts). The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## On-demand optimize in one paragraph

Onboarding plans a whole store from scratch. On-demand optimize is the merchant-driven counterpart: a merchant looking at ONE live page of their store TYPES a request — "add a bought-together strip under the product details", "put bestsellers at the top", "optimize this page" — and this prompt fulfills it. It is 100% AI like onboarding, but scoped to the SINGLE page the merchant is looking at and driven by the request they typed. The lib captures that one page at desktop + mobile widths, calls `optimize-demand` for ONE JSON page plan (which boxes to place, at which numbered candidate, styled to look native), the conductor applies it box-by-box, and then the rendered page is QC'd by REUSING the [`onboarding-review`](onboarding-review.md) prompt — single-page QC is identical, and the demand does not gate the verdict (a decision recorded in the test; there is no separate `optimize-review` prompt). This doc covers the PROPOSE half.

It is the demand-first sibling of the single-page [`onboarding-batch`](onboarding-batch.md) PROPOSE. Where onboarding proposes from a blank slate, `optimize-demand` inserts ONE change to the composition — the `_block-user-demand.md` block right after the intro, so "the merchant's explicit request comes FIRST" frames the entire plan before any placement / vocabulary / styling instruction.

## `optimize-demand`

- **Purpose:** Given ONE store page the merchant is looking at, plus the request they TYPED, return ONE JSON plan for the whole page — which boxes to place, at which numbered candidate (INSERT `before`/`after`, or `replace`), and how to style each so it looks native — honoring the merchant's explicit demand FIRST, then rounding out the page with best practice.
- **Additive-only placement:** `position` is `before`/`after` ONLY — the prompt never emits `replace`; merchant sections (including a theme's own static product grid) always stay, and a green manifest candidate serves as a boundary + style reference. Every box's `appearancePatch` carries its playbook `Style` explicitly (`carousel` default; Cart Upsell `slider`; Product FBT `bundle`); only Recently Viewed anchors at the footer boundary.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`) — the same reasoner class as `onboarding-batch` and the `proposals` strategist. The body omits `model` so the registry is authoritative. `maxTokens: 4096`.
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **Attachments:** none (`attachments: []`). The lib uploads the page's two screenshots per request.
- **Box vocabulary + page vocabulary:** from the shared [`_shared-box-vocab.md`](../../src/prompts/onboarding-shared/_shared-box-vocab.md) block, the same list the onboarding propose uses.

### Composition (frozen, cache-first order)

`optimizeDemand` (in [`src/prompts/optimize-demand/index.ts`](../../src/prompts/optimize-demand/index.ts)) composes these blocks IN THIS ORDER — reordering busts the cache, so the order is frozen and pinned by the test:

1. `optimize-demand/_intro.md` — the demand-first single-page framing.
2. `onboarding-shared/_block-user-demand.md` — **NEW block: "the merchant's explicit request comes FIRST"** (demand → then best-practice gap-fill → never contradict → a vague demand is still a demand).
3. `onboarding-shared/_shared-mobile-first.md` — mobile is first-class; every choice works at BOTH widths.
4. `onboarding-shared/_shared-json-hardening.md` — machine-readable JSON only.
5. `onboarding-shared/_block-box-placement.md` — the INSERT+REPLACE placement capability (violet insert anchors / green replace candidates over ONE continuous `1..N` numbering), REUSED verbatim from onboarding.
6. `optimize-demand/_receive.md` — what you receive (demand, page, two screenshots, manifest) + what to decide (demand first, then complete the page; place / style; clone the store's own look).
7. `onboarding-shared/_shared-guidance.md` — "this is guidance, not a script."
8. `onboarding-shared/_shared-box-vocab.md` — the box names.
9. `onboarding-shared/_shared-appearance-header.md` — the appearance-patch allowed-keys-only header.
10. `optimize-demand/_appearance-keys.md` — the desktop/shared appearance keys (`Style`, `ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`, `NavigationArrowType`).
11. `onboarding-shared/_shared-mobile-rule.md` — the `appearancePatchMobile` allowed-keys-only header.
12. `optimize-demand/_output-and-rules.md` — the mobile-override keys, the SINGLE-PAGE `{ page, boxes }` output contract (no `pages` wrapper, no `progressBar`, no `segments` / `discounts`), and the numbered per-box rules.
13. `onboarding-shared/_shared-json-tail.md` — the closing "respond with ONLY the JSON object" line (the prompt ENDS here).

Only the four fragments under `optimize-demand/` are authored anew; everything else is reused from the shared library. The intro → demand → mobile-first → box-placement ordering is the frozen cache-first prefix.

### Input (what the lib provides)

For the ONE page being optimized — **no full HTML for INSERT anchors** (the model reads the store from pixels and places by number). Placement has TWO modes over ONE continuous number sequence — INSERT a new box at a boundary OR REPLACE an existing static grid — from the shared `_block-box-placement.md` (identical to `onboarding-batch`):

- **the merchant's DEMAND** (a text block) — the request they typed, in their own words. This is the model's FIRST obligation (per the `_block-user-demand.md` block) — it is read before anything else and sets the direction of the plan.
- **page** — the page name, one of: `Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`.
- **TWO screenshots at two widths** (each an image, uploaded via `/files`) — a **desktop** and a **mobile** (phone-width) full-page screenshot of the SAME page, each with numbered `+1 +2 +3 … +N` markers painted as a TRANSLUCENT overlay (~50% opacity), **ONE number per CANDIDATE** — each number labels a placement candidate (a **violet INSERT anchor** = an existing section boundary the box sits before/after, OR a **green REPLACE candidate** = an existing static product grid/carousel the box can swap IN for). The store's real design shows THROUGH the markers, so the model reads the aesthetic (card style, palette, spacing, arrows-or-not) from the page underneath AND the candidate numbers from the overlay. Mobile is FIRST-CLASS.
- **the per-page MANIFEST** (text block) — the candidate range (`1..N`) plus, per number, its `type` (`"insert"` | `"replace"`), and for a `replace` candidate its **`outerHTML`** (the block's structure + product-card markup) + a reference **`selector`**. INSERT anchors carry no extra data. **The numbering is ONE continuous sequence shared across BOTH widths:** marker `+3` is the SAME logical candidate on desktop and mobile. A box is placed RELATIVE to a numbered candidate: the model emits `anchorNumber` (which candidate) + `position` (`"before"` | `"after"` an insert anchor, or `"replace"` a replace candidate — matching that candidate's `type`). That pair is ONE responsive placement for both widths. The `number → real element sibling selector` mapping is conductor-internal; the model never emits a selector.

**The DEMAND, the two screenshots, the manifest, and each replace candidate's `outerHTML` are per-shop VARIABLE data — they ride AFTER the cache breakpoint in the first user message (a DATA text block + the image blocks), never in the cached system prefix.** The `_block-user-demand.md` block in the prefix describes the SHAPE of "honor the demand" (shop-independent); the merchant's ACTUAL typed demand text rides after the breakpoint.

### Frozen output contract

The assistant text is a single JSON object with EXACTLY two top-level keys, `page` and `boxes` — the per-page shape (like `onboarding-batch`, NOT the whole-store `pages` map). There is **NO `progressBar` key** (a Smart Progress Bar is set up through onboarding, not here) and **NO off-page `segments` / `discounts` keys** (those are store-wide, decided by onboarding).

```json
{
  "page": "Product",
  "boxes": [
    {
      "boxType": "BoughtTogether",
      "position": "after",
      "anchorNumber": 2,
      "styleReferenceSelector": ".product-grid",
      "appearancePatch": null,
      "appearancePatchMobile": null,
      "reasoning": "short why — tied to the demand and to what was seen"
    }
  ]
}
```

- `page` — echoed from the input (page vocabulary).
- `boxType` — from the box vocabulary (`MostPopular`, `Trending`, `NewArrivals`, `YouMayLike`, `RecentViews`, `BoughtTogether`, `CrossSell`, `Upsell`, `RelatedItems`, `FeaturedCollection`). Never invented.
- `position` — exactly `"before"`, `"after"`, or `"replace"`: before the numbered candidate, after it (a violet INSERT anchor), or swaps IN for it (a green REPLACE candidate). `position` MUST match the candidate's manifest `type`. Matches the lib's `PlacementMethod` union.
- `anchorNumber` — an INTEGER in `1..N` from the ONE continuous SHARED numbering, equal to a candidate painted on the page (desktop and/or mobile) whose `type` matches `position`. With `position`, ONE responsive placement for both widths. Never invented / never out of range / never a `replace` on a non-replace number. If the demand asks for a box but no candidate fits, the model places what it can and notes the constraint in that box's `reasoning` — it does not invent a location.
- `styleReferenceSelector` — OPTIONAL, PREFERRED: a CSS selector for the store's own most-representative product grid / carousel to CLONE the box's appearance from (the system reads that block's REAL computed styling — the most faithful way to look native). On a `replace` box, point it at the replaced candidate's own reference `selector` from the manifest (its `outerHTML` grounds the clone precisely). Include it whenever a good reference block exists; omit it only when the store has none to clone on this page.
- `appearancePatch` — `null`, OR an object of DESKTOP-and-shared keys using ONLY: `Style` (`"carousel"`|`"grid"`|`"bundle"`|`"rows"`), `ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`, `NavigationArrowType`. The FALLBACK when no `styleReferenceSelector` reference exists. When a `styleReferenceSelector` is given, this stays `null` (the clone supplies the styling).
- `appearancePatchMobile` — `null` (the common case), OR an object of MOBILE-ONLY overrides using ONLY `ImageHeightMobile` (px, default 200) + `MarginRightMobile` (px, default 10). No desktop keys; NO mobile items-per-row (the phone row is width-driven, floored at 2 products/row — a mobile items value is ignored by design). Set only when mobile must diverge.
- `reasoning` — one short sentence on why this box, here, styled this way — tied to the demand and to what was seen.

No extra keys, no missing keys. `boxes` may be empty — a page that genuinely warrants no change gets `{ "page": "...", "boxes": [] }`. **Demand first:** everything the merchant explicitly asked for on this page must be in the plan; best-practice additions come after and never at the expense of the demand.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: optimize-demand` (header-selected on `POST /messages`, exactly like the onboarding propose — not a `probe-<id>` name).
- Body: a standard Anthropic messages payload. User content = TWO image blocks (the desktop + mobile screenshots, each with the translucent numbered-candidate overlay, uploaded via `POST /files`) plus a text block carrying the merchant's DEMAND + the page name + the manifest (`1..N` range with per-number `type` and each replace candidate's `outerHTML` / `selector`). Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **JSON reliability:** the prompt opens with the shared JSON-hardening line and ends with the shared JSON tail ("respond with ONLY the JSON object, no prose, no markdown code fences"), keeping a small flat schema + one inline example. The lib parses tolerantly (its `structured-output.ts` extractor: direct / fenced / embedded) and applies a bounded repair-retry — the same tolerant-parse baseline the onboarding propose uses.
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.

### Caching notes

The composed system text is the STABLE, shop-independent prefix (a `cache_control` breakpoint sits after it in `handlers/messages.ts`), so repeated per-shop calls HIT the cached prefix. The `_block-user-demand.md` block is deliberately part of that prefix — it describes the SHAPE of "honor the demand," never a live shop's demand text. The merchant's ACTUAL typed demand + the two screenshots + the manifest are per-shop VARIABLE data and ride AFTER the breakpoint in the first user message. A reordered block (or a file id / screenshot reference leaking into the system text) would bust the cache — the composition order is frozen, and the test asserts the prefix carries no `file_id` / `fileIds`.

### Pinning test

[`test/optimize-demand-prompt.test.ts`](../../test/optimize-demand-prompt.test.ts) pins:

- **(a) Registry resolution** — resolves by name to non-trivial text, `usesTools: false`, `clientTools` undefined; the model equals `onboarding-batch`'s model and equals `ENV.MODEL_BALANCED`; `maxTokens === 4096`.
- **(b) Frozen cache-first order** — the composed text contains the `_block-user-demand.md` block (marker `"The merchant's explicit request comes FIRST"`) placed RIGHT AFTER the intro and BEFORE the placement instruction, in the order intro → demand → mobile-first (`"Mobile is the majority of ecommerce shoppers"`) → box-placement (`"INSERT anchors (violet)"`).
- **(c) Demand block is optimize-only** — it must NOT leak into `onboarding-batch` / `-all`, `onboarding-review`, or `cartdrawer-batch-all`.
- **(d) Single-page output contract** — the text states `` `page` and `boxes` ``, contains `"page": "Product"`, has NO `"pages": {` wrapper, and explicitly states NO `progressBar` key / NO off-page `segments` / `discounts` keys; all seven per-box fields (`boxType`, `position`, `anchorNumber`, `styleReferenceSelector`, `appearancePatch`, `appearancePatchMobile`, `reasoning`) appear.
- **(e) Reuse + tail** — the shared box-placement block and the JSON tail are present, and the prompt ENDS with the tail.
- **(f) Cache-prefix stability** — the composed prompt carries no per-shop VARIABLE data (no `file_id` / `fileIds` in the system text).

Unlike the onboarding twins, `optimize-demand` has NO byte-equivalence baseline in `test/__snapshots__/` (it is composed purely from fragments + shared blocks, with no single-file `prompt.md` to snapshot) — the assertions above are its contract gate. If an edit changes the effective text on purpose (e.g. a new box field), update the relevant fragment/block AND the matching assertion in this test; a shared-block edit here also touches the onboarding baselines (`test/onboarding-prompt-blocks.test.ts`).
