# Onboarding Batch (PROPOSE) — Maintenance Doc

The design/maintenance record for the `onboarding-batch` prompt — the PROPOSE half of onboarding "batch mode". It is a **COMPOSED prompt**: rather than one `prompt.md`, its system text is assembled by `composePrompt(...)` in the prompt's own barrel [`src/prompts/onboarding-batch/index.ts`](../../src/prompts/onboarding-batch/index.ts) from per-prompt fragment files in [`src/prompts/onboarding-batch/`](../../src/prompts/onboarding-batch/) (`_intro.md`, `_receive.md`, `_catalog-note.md`, `_pb-detail.md`, `_appearance-keys.md`, `_output-and-rules.md`) plus SHARED blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/) (box vocabulary, the JSON-only hardening lines, the mobile-first rule, the appearance-patch header, the PB "no styling" note, …). The four onboarding prompts (`onboarding-batch` / `-all`, `onboarding-review` / `-all`) share those blocks, so an edit to one block updates every prompt that composes it. The composed text is pinned byte-for-byte by [`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts) against the committed baselines in `test/__snapshots__/`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md).

## Batch mode in one paragraph

Onboarding runs a per-page cycle: ONE **propose** call (`onboarding-batch`) returns the whole page's plan; the lib conductor applies it box-by-box; then ONE **review** call ([`onboarding-review`](onboarding-review.md)) judges the rendered page and returns corrections. This doc covers the PROPOSE half.

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is NOT a `probe-<id>` name: probes are Website-Analysis capabilities; this is an onboarding step.

## `onboarding-batch`

- **Purpose:** Given ONE store page, return ONE JSON plan for the whole page — which boxes to place, at which anchor (from a fixed valid list), and how to style each so it looks native to the store.
- **Additive-only placement:** `position` is `before`/`after` ONLY — the prompt never emits `replace`; merchant sections (including a theme's own static product grid) always stay, and a green manifest candidate serves as a boundary + style reference. Every box's `appearancePatch` carries its playbook `Style` explicitly (`carousel` default; Cart Upsell `slider`; Product FBT `bundle`) plus its count keys under the HARD caps (carousel 4/line; grid 8 at 4/row; bundle 3; slider 1; rows 2 — lower allowed, never more). Bottom closers are Related Items then Recently Viewed (RV always last at the footer boundary); every other box anchors in its own page region.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`) — the same reasoner class as the `proposals` strategist.
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **Attachments:** none. The lib uploads the page's screenshot + cleaned HTML per request.
- **Box vocabulary + page vocabulary:** from the shared [`_shared-box-vocab.md`](../../src/prompts/onboarding-shared/_shared-box-vocab.md) block, composed into this and the whole-store `onboarding-batch-all` prompt.

### Input (what the lib provides)

For the ONE page being planned — **no full HTML, no per-marker text descriptors for INSERT anchors** (a deliberate token + reliability choice; the model reads the store from pixels and places by number). Placement has TWO modes within the on-page nature — INSERT a new box at a boundary OR REPLACE an existing static grid — via ONE continuous number sequence (the `_block-box-placement.md` capability block, composed into this prompt AND `onboarding-batch-all`):

- **page** — the page name, one of: `Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`.
- **TWO screenshots at two widths** (each an image, uploaded via `/files`) — a **desktop** and a **mobile** (phone-width) full-page screenshot of the same page, each with numbered `+1 +2 +3 … +N` markers painted as a TRANSLUCENT overlay (~50% opacity), **ONE number per CANDIDATE** — each number labels a placement candidate (a **violet INSERT anchor** = an existing section boundary the box sits before/after, OR a **green REPLACE candidate** = an existing static product grid/carousel the box can swap IN for). Dual purpose per image: the store's real design shows THROUGH the markers, so the model reads the aesthetic (card style, palette, spacing, arrows-or-not) from the page underneath AND the candidate numbers from the overlay. Mobile is FIRST-CLASS (the majority of shoppers) — the model decides boxes + styling considering BOTH widths.
- **the per-page MANIFEST** (text block) — the candidate range (`1..N`) **plus, per number, its `type` (`"insert"` | `"replace"`)**, and for a `replace` candidate its **`outerHTML`** (the block's structure + product-card markup) + a reference **`selector`**. INSERT anchors carry no extra data; the `outerHTML` grounds both the replace decision and the style clone. **The numbering is ONE continuous sequence across BOTH modes** and SHARED across both widths: marker `+3` is the SAME logical candidate on desktop and mobile (it may reflow, or exist on only one width). A box is placed RELATIVE to a numbered candidate: the model emits `anchorNumber` (which candidate) + `position` (`"before"` | `"after"` an insert anchor, or `"replace"` a replace candidate — matching that candidate's `type`). That pair is ONE responsive placement for both widths, not one per width. The `number → real element sibling selector` mapping is conductor-internal (the lib keeps it; the model never emits a selector). Every `anchorNumber` the model returns must be an integer in `1..N` it actually SEES painted on the page whose `type` matches its `position`. **This manifest is the INPUT contract lib #99 builds and sends in the DATA block (per-number `type`; a replace candidate's `outerHTML` + `selector`) — it rides AFTER the cache breakpoint (per-shop VARIABLE data), never in the cached system prefix.**

### Frozen output contract

The assistant text is a single JSON object, exactly:

```json
{
  "page": "Home",
  "boxes": [
    {
      "boxType": "FeaturedCollection",
      "position": "after",
      "anchorNumber": 1,
      "appearancePatch": {
        "Style": "carousel",
        "ItemsPerPage": 4,
        "ImageBorderRadius": 0,
        "NavigationArrowType": "chevron"
      },
      "appearancePatchMobile": { "ImageHeightMobile": 160, "MarginRightMobile": 8 },
      "reasoning": "short why — one sentence"
    }
  ]
}
```

- `page` — echoed from the input (page vocabulary).
- `boxType` — from the box vocabulary (`MostPopular`, `Trending`, `NewArrivals`, `YouMayLike`, `RecentViews`, `BoughtTogether`, `CrossSell`, `Upsell`, `RelatedItems`, `FeaturedCollection`).
- `position` — exactly `"before"`, `"after"`, or `"replace"`: whether the box goes before the numbered candidate, after it (a violet INSERT anchor), or swaps IN for it (a green REPLACE candidate — the store's own static grid — or a clear placeholder / stub the manifest marks `replace`). `position` MUST match the candidate's manifest `type`. Matches the lib's `PlacementMethod` union (`brain/batch-output.ts`).
- `anchorNumber` — an INTEGER in `1..N` from the ONE continuous SHARED numbering, equal to a candidate painted on the page (desktop and/or mobile) whose `type` matches `position`. With `position`, ONE responsive placement for both widths, not one per width. Never invented / never out of range / never a `replace` on a non-replace number. The lib maps the number back to that element's sibling selector internally; the model never emits a selector.
- `styleReferenceSelector` — OPTIONAL, PREFERRED: a CSS selector for the store's own most-representative product grid / carousel to CLONE the box's appearance from. On a `replace` box, point it at the replaced candidate's own reference `selector` from the manifest — the candidate's `outerHTML` grounds the clone precisely. Mirrors `PlacedBoxProposal.styleReferenceSelector` (`brain/batch-output.ts`).
- `appearancePatch` — `null`, OR an object of DESKTOP-and-shared keys using ONLY: `Style` (`"carousel"`|`"grid"`|`"rows"`|`"slider"` — no `"bundle"` value; the FBT box renders its bundle layout from the box type), `ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`, `NavigationArrowType`. The FALLBACK when no `styleReferenceSelector` reference exists. Chosen as a compromise that reads well at BOTH widths.
- `appearancePatchMobile` — `null` (the common case), OR an object of MOBILE-ONLY overrides using ONLY `ImageHeightMobile` (px, default 200) + `MarginRightMobile` (px, default 10). No desktop keys; NO mobile items-per-row (the phone row is width-driven, floored at 2 products/row). Set only when mobile must diverge. Mirrors the lib's `AppearancePatchMobile` type.
- `reasoning` — one short sentence.

No extra keys, no missing keys. `boxes` may be empty when a page warrants no boxes.

#### Smart Progress Bar — the OPTIONAL `progressBar` slot (Cart page ONLY)

A **Cart** page's plan MAY carry one additional top-level key, `progressBar`, when the model decides a threshold / free-shipping nudge fits. It is an ON-PAGE item like the boxes — the AI decides WHERE it goes; the lib hardcodes nothing — but there is at most ONE per store and it belongs to the Cart page ALONE. On every non-Cart page (and on Cart when no bar is warranted) the key is OMITTED (or `null`).

```json
{
  "position": "before",
  "anchorNumber": 1,
  "reasoning": "free-shipping bar at the very top of the cart"
}
```

- `position` — exactly `"before"` / `"after"` / `"replace"`, the SAME `PlacementMethod` union the boxes use, relative to a numbered Cart section.
- `anchorNumber` — an INTEGER in the Cart page's `1..N` shared marker range, a section the model actually SEES painted. Same rule as a box.
- `reasoning` — one short sentence.
- **No appearance keys** — the bar's look comes from its campaign template (Shopify Free Shipping, etc.), NOT an appearance patch: there is deliberately NO `appearancePatch` / `appearancePatchMobile` / `styleReferenceSelector` on the progress bar. Its ONE placement setting applies to both widths, like a box.

This mirrors the lib's follow-up `ProgressBarPlacement = { position: PlacementMethod; anchorNumber: number; reasoning: string }` and the optional `PageBatchProposal.progressBar` field (`brain/batch-output.ts`); the lib sanitizer validates `position` + `anchorNumber` with the SAME rules as a box and drops an invalid bar (falling back to the deterministic Cart-top default). The whole-store `onboarding-batch-all` carries the identical `progressBar` slot inside each Cart page's plan (`{ pages: { Cart: { boxes, progressBar? } } }`).

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: onboarding-batch`.
- Body: a standard Anthropic messages payload. User content = TWO image blocks (the desktop + mobile screenshots, each with the translucent numbered-SECTION overlay, uploaded via `POST /files`) plus a text block carrying the page name + the shared `1..N` marker range. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **JSON reliability:** the prompt ends with an explicit "respond with ONLY the JSON object, no prose, no markdown code fences" hardening line and keeps a small flat schema + one inline example. The lib parses tolerantly (its `structured-output.ts` extractor: direct / fenced / embedded) and applies a bounded repair-retry (feed the model its own invalid output + the parse error, 1–2×) — the same tolerant-parse baseline `visual-verify` uses in production on this stack. (Forced schema-constrained tool-use via `tool_choice` is available on the prod worker but NOT the dev Claude-Code shim — see the assessment note.)
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.
