# Onboarding Batch ALL (WHOLE-STORE PROPOSE) — Maintenance Doc

The design/maintenance record for the `onboarding-batch-all` prompt — the WHOLE-STORE PROPOSE of onboarding "batch mode", the ONE HOLISTIC propose pass. It is the whole-store twin of [`onboarding-batch`](onboarding-batch.md): where `onboarding-batch` plans ONE page per call, `onboarding-batch-all` plans EVERY page (and the two store-wide off-page natures) in a SINGLE completion. It is a **COMPOSED prompt**: rather than one `prompt.md`, its system text is assembled by `composePrompt(...)` in the prompt's own barrel [`src/prompts/onboarding-batch-all/index.ts`](../../src/prompts/onboarding-batch-all/index.ts) from per-prompt fragment files in [`src/prompts/onboarding-batch-all/`](../../src/prompts/onboarding-batch-all/) (`_intro.md`, `_receive.md`, `_catalog-note.md`, `_pb-detail.md`, `_appearance-keys.md`, `_output-and-rules.md`) plus SHARED blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/) — including THREE off-page blocks (`_block-audience-segments.md`, `_block-discount-specs.md`, `_block-store-wide-output.md`) that ONLY this prompt composes. The four onboarding prompts (`onboarding-batch` / `-all`, `onboarding-review` / `-all`) share the common blocks, so **an edit to a shared block updates every prompt that composes it.** The composed text is pinned by [`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts) against the committed baseline in `test/__snapshots__/onboarding-batch-all.baseline.md`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Whole-store batch in one paragraph

`onboarding-batch-all` proposes the WHOLE store in ONE call: given EVERY page at both widths in one completion, it returns `{ pages: { Home: { boxes }, Product: { boxes }, … } }`, so the merchant's "reading → thinking → reveal" show has a SINGLE masked wait rather than one per page. It is also the ONE HOLISTIC propose pass (CONDUCTOR-FRAMEWORK.md → "One holistic propose pass"): the same call ADDITIONALLY returns the two STORE-WIDE OFF-PAGE natures — audience `segments` + `discounts` (bundle/discount campaigns) — as optional top-level keys next to `pages`. This doc covers that whole-store PROPOSE; the QC-side twin is [`onboarding-review-all`](onboarding-review-all.md), the single-page propose is [`onboarding-batch`](onboarding-batch.md).

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is NOT a `probe-<id>` name: probes are Website-Analysis capabilities; this is an onboarding step. The lib falls back to looping per-page `onboarding-batch` if `onboarding-batch-all` is unavailable or omits a page.

## `onboarding-batch-all`

- **Purpose:** Given the WHOLE STORE (several pages, each at two widths), return ONE JSON object holding a per-page plan for EACH page — which boxes to place, at which numbered candidate (INSERT or REPLACE, from that page's fixed valid list), and how to style each so it looks native — PLUS the store-wide off-page `segments` + `discounts`.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`) — the same reasoner class as `onboarding-batch` and the `proposals` strategist.
- **Max tokens:** `8192` (double the per-page `onboarding-batch`'s `4096` — the whole-store plan is a larger completion).
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **Attachments:** none. The lib uploads every page's screenshots per request.
- **Box vocabulary + page vocabulary:** from the shared [`_shared-box-vocab.md`](../../src/prompts/onboarding-shared/_shared-box-vocab.md) block and the fragment `_catalog-note.md`'s page-vocabulary section, composed into this and the single-page `onboarding-batch` prompt.

### Composition — which blocks compose this prompt

`composePrompt(...)` in [`src/prompts/onboarding-batch-all/index.ts`](../../src/prompts/onboarding-batch-all/index.ts) assembles the system text from these parts, in this STABLE order (the order is load-bearing for prompt caching — a reorder busts the cached prefix):

1. `onboarding-batch-all/_intro.md` — whole-store framing (plan all pages at once, return one JSON object per page).
2. `onboarding-shared/_shared-mobile-first.md` (shared) — mobile is first-class at both widths.
3. `onboarding-shared/_shared-json-hardening.md` (shared) — machine-readable JSON only.
4. `onboarding-shared/_block-box-placement.md` (**shared, composed into BOTH propose prompts**) — the canonical INSERT-vs-REPLACE placement instruction over ONE continuous `1..N` sequence, the reference-style slot, and the per-number `type` / `outerHTML` MANIFEST contract.
5. `onboarding-batch-all/_receive.md` — what the lib sends (the per-page manifest + the marked screenshots) and what to decide, whole-store.
6. `onboarding-shared/_shared-guidance.md` (shared) — "guidance, not a script".
7. `onboarding-shared/_shared-box-vocab.md` (shared) — the ten box names.
8. `onboarding-batch-all/_catalog-note.md` — CATALOG-backed vs SESSION-dependent boxes (lead with a catalog-backed box where the playbook provides one; the Cart stack is the deliberate data-dependent exception), the page vocabulary, and the Cart-only Smart Progress Bar note.
9. `onboarding-shared/_block-pb-placement.md` (shared) — the progress bar carries NO styling; placement only.
10. `onboarding-batch-all/_pb-detail.md` — include the bar only when it fits + the best-practice per-page stacks (the LimeSpot playbook: Home = Most Popular after the hero + a mid-page You May Like [lib-audience-gated: hidden for first-time visitors] + Recently Viewed above the footer; Product = an FBT bundle below the product details [Cross-sell fallback] + Related Items + Recently Viewed; Collection = collection-scoped Most Popular on top + Recently Viewed; Cart = the Progress Bar on top + an Upsell slider above the cart contents + FBT below them [Cross-sell fallback] + Recently Viewed; SlidingCart = a 2-product rows-style FBT).
11. `onboarding-shared/_shared-appearance-header.md` (shared) — `appearancePatch` is `null` or allowed keys only.
12. `onboarding-batch-all/_appearance-keys.md` — the allowed DESKTOP-and-shared appearance keys.
13. `onboarding-shared/_shared-mobile-rule.md` (shared) — the `appearancePatchMobile` header.
14. `onboarding-batch-all/_output-and-rules.md` — the frozen output JSON + the numbered rules.
15. `onboarding-shared/_block-audience-segments.md` (**shared, off-page — this prompt ONLY**) — propose audience segments.
16. `onboarding-shared/_block-discount-specs.md` (**shared, off-page — this prompt ONLY**) — propose bundle/discount campaigns.
17. `onboarding-shared/_block-store-wide-output.md` (**shared, off-page — this prompt ONLY**) — the `segments` / `discounts` top-level output keys next to `pages`.
18. `onboarding-shared/_shared-json-tail.md` (shared) — the closing JSON-only hardening line.

The three OFF-PAGE blocks (15–17) are the INTENDED divergence from `onboarding-batch`: they are appended AFTER the on-page output+rules, so the box/PB portion stays byte-identical to the per-page twin and only the store-wide segments/discounts output is added. The per-page `onboarding-batch` does NOT carry them (segments + discounts are store-wide, not a single-page decision). **Editing any shared block (`_shared-*` / `_block-*`) updates every prompt that composes it** — e.g. editing `_block-box-placement.md` changes BOTH propose prompts at once; editing an off-page block changes only this one.

### Input (what the lib provides)

For the WHOLE STORE in one call — **no full HTML, no per-marker text descriptors for INSERT anchors** (a deliberate token + reliability choice; the model reads each store page from pixels and places by number). Placement has TWO modes within the on-page nature — INSERT a new box at a boundary OR REPLACE an existing static grid — via ONE continuous number sequence PER PAGE (the shared `_block-box-placement.md` capability block, composed into this prompt AND `onboarding-batch`):

- **the pages** — several pages, each named from the page vocabulary: `Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`. Plan ONLY the pages present in the manifest.
- **TWO screenshots per page at two widths** (each an image, uploaded via `/files`) — a **desktop** and a **mobile** (phone-width) full-page screenshot of each page, each with numbered `+1 +2 +3 … +N` markers painted as a TRANSLUCENT overlay (~50% opacity), **ONE number per CANDIDATE** — each number labels a placement candidate (a **violet INSERT anchor** = an existing section boundary the box sits before/after, OR a **green REPLACE candidate** = an existing static product grid/carousel the box can swap IN for). Dual purpose per image: the store's real design shows THROUGH the markers, so the model reads the aesthetic (card style, palette, spacing, arrows-or-not) from the page underneath AND the candidate numbers from the overlay. Mobile is FIRST-CLASS (the majority of shoppers) — the model decides boxes + styling considering BOTH widths.
- **the per-page MANIFEST** (a single text block covering ALL pages) — for EACH page: the page name, which uploaded images are that page's DESKTOP tiles and which are its MOBILE tiles (by their 1-based position in the image list), that page's candidate range (`1..N`, where `N` differs per page), and — per number — its `type` (`"insert"` | `"replace"`), with a `replace` candidate additionally naming its **`outerHTML`** (the block's structure + product-card markup) + a reference **`selector`**. Example lines: `PAGE Home: DESKTOP TILES images 1-2, MOBILE TILES images 3-3, CANDIDATE ANCHORS 1..6`. INSERT anchors carry no extra data; the `outerHTML` grounds both the replace decision and the style clone.
- **numbering is PER-PAGE and shared across both widths.** On a given page, marker `+3` is the SAME logical candidate on that page's desktop and mobile image (it may reflow, or exist on only one width). Home's `+3` and Product's `+3` are UNRELATED — numbering is scoped to each page. A box is placed RELATIVE to a numbered candidate ON ITS PAGE: the model emits `anchorNumber` (which candidate) + `position` (`"before"` | `"after"` an insert anchor, or `"replace"` a replace candidate — matching that candidate's `type`). That pair is ONE responsive placement for both widths of that page, not one per width. The `number → real element sibling selector` mapping is conductor-internal (the lib keeps it; the model never emits a selector). Every `anchorNumber` must be an integer in that page's `1..N` it actually SEES painted, whose `type` matches its `position`.
- **This manifest is the INPUT contract lib #99 builds and sends in the DATA block** (per-number `type`; a replace candidate's `outerHTML` + `selector`) — it rides AFTER the cache breakpoint (per-shop VARIABLE data), never in the cached system prefix.

### Frozen output contract

The assistant text is a single JSON object with a top-level `pages` map keyed by page name, and OPTIONAL store-wide `segments` / `discounts` keys next to it:

```json
{
  "pages": {
    "Home": {
      "boxes": [
        {
          "boxType": "FeaturedCollection",
          "position": "after",
          "anchorNumber": 1,
          "styleReferenceSelector": ".product-grid",
          "appearancePatch": null,
          "appearancePatchMobile": { "ImageHeightMobile": 160, "MarginRightMobile": 8 },
          "reasoning": "short why — one sentence"
        }
      ]
    },
    "Product": {
      "boxes": [
        {
          "boxType": "RelatedItems",
          "position": "replace",
          "anchorNumber": 3,
          "styleReferenceSelector": ".product-recommendations .grid",
          "appearancePatch": null,
          "appearancePatchMobile": null,
          "reasoning": "candidate 3 is a green REPLACE candidate — swap in a personalized Related Items box"
        }
      ]
    },
    "Cart": {
      "boxes": [
        /* … */
      ],
      "progressBar": {
        "position": "before",
        "anchorNumber": 1,
        "reasoning": "free-shipping bar at the very top of the cart"
      }
    }
  },
  "segments": [{ "title": "First-Time Visitors", "rationale": "the journey-stage starter set" }],
  "discounts": [
    {
      "title": "Frequently Bought Together",
      "audience": "Returning Buyers",
      "discountRate": 10,
      "rationale": "a 10% bundle nudge to lift first-order value"
    }
  ]
}
```

**`pages`** — an object keyed by page name; include an entry for EVERY page in the manifest (a page that warrants no boxes gets `{ "boxes": [] }`). Each page's plan is `{ boxes: [...] }`, PLUS the OPTIONAL `progressBar` on the Cart page. Each box carries the SAME per-page shape as `onboarding-batch`:

- `boxType` — from the box vocabulary (`MostPopular`, `Trending`, `NewArrivals`, `YouMayLike`, `RecentViews`, `BoughtTogether`, `CrossSell`, `Upsell`, `RelatedItems`, `FeaturedCollection`). Never invent a name. The FIRST/primary box on every page MUST be a CATALOG-backed box (renders products for a brand-new visitor); session-dependent boxes (`RecentViews`, `BoughtTogether`, `CrossSell`, `Upsell`) are SECONDARY only.
- `position` — exactly `"before"`, `"after"`, or `"replace"`: `before`/`after` a violet INSERT anchor, or `replace` a green REPLACE candidate. `position` MUST match the candidate's manifest `type`. Matches the lib's `PlacementMethod` union (`brain/batch-output.ts`).
- `anchorNumber` — an INTEGER in that PAGE's `1..N` (per-page, one continuous sequence across both modes), equal to a candidate painted on that page whose `type` matches `position`. With `position`, ONE responsive placement for both widths. Never invented / never out of range / never a `replace` on a non-replace number. The lib maps the number back to the element's sibling selector internally.
- `styleReferenceSelector` — OPTIONAL, PREFERRED: a CSS selector for the store's own most-representative product grid/carousel on that page, to CLONE the box's appearance from. On a `replace` box, point it at the replaced candidate's own reference `selector` from the manifest (its `outerHTML` grounds the clone). Mirrors `PlacedBoxProposal.styleReferenceSelector` (`brain/batch-output.ts`).
- `appearancePatch` — `null`, OR an object using ONLY: `Style` (`"carousel"`|`"grid"`|`"rows"`|`"slider"` — no `"bundle"` value; the FBT box renders its bundle layout from the box type), `ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`, `NavigationArrowType`. The FALLBACK when no `styleReferenceSelector` exists. Chosen to read well at BOTH widths.
- `appearancePatchMobile` — `null` (the common case), OR an object of MOBILE-ONLY overrides using ONLY `ImageHeightMobile` (px, default 200) + `MarginRightMobile` (px, default 10). No desktop keys; NO mobile items-per-row (the phone row is width-driven, floored at 2 products/row). Mirrors the lib's `AppearancePatchMobile` type.
- `reasoning` — one short sentence.

**`progressBar`** — the Smart Progress Bar, a Cart-page-ONLY optional key. Present only on the `Cart` page when a threshold / free-shipping nudge fits; OMITTED (or `null`) on every non-Cart page and on Cart when no bar is warranted. Shape `{ position, anchorNumber, reasoning }` — the SAME `PlacementMethod` union + Cart `1..N` anchor rules as a box, with **NO appearance keys** (its look comes from its campaign template — Shopify Free Shipping, etc.; there is deliberately NO `appearancePatch` / `appearancePatchMobile` / `styleReferenceSelector`). Mirrors the lib's `ProgressBarPlacement` type + the optional `PageBatchProposal.progressBar` field (`brain/batch-output.ts`).

**`segments`** — OPTIONAL store-wide, sitting NEXT TO `pages` (never nested in a page). An array of `{ title, rationale }`: `title` from the segment vocabulary the grounding catalog / existing-config input provides (the lib resolves it to a real built-in segment template — never a free-invented name), `rationale` one short sentence. Off-page (no placement, no appearance, no screenshot). Omit the key or return `[]` when the store warrants none.

**`discounts`** — OPTIONAL store-wide, next to `pages`. An array of `{ title, audience, discountRate, rationale }`: `title` from the campaign/template vocabulary the grounding input provides (never invented), `audience` naming one of the `segments` titles you proposed (or an already-active audience — the lib eligibility-gates a campaign to its audience), `discountRate` a number (percentage, e.g. `15`) or `null` for the template default, `rationale` one short sentence. Omit the key or return `[]` when the store warrants none.

Both off-page keys are OPTIONAL and FOCUSED — a small high-value set, never every template. Off-page items get a SEPARATE non-visual review later (a separate lib task) — this prompt only PROPOSES them. No extra keys, no missing keys. A page's `boxes` may be empty when the page warrants no boxes.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: onboarding-batch-all`.
- Body: a standard Anthropic messages payload. User content = the image blocks for EVERY page (each page's desktop + mobile marked screenshots, uploaded via `POST /files`) plus a text block carrying the whole-store manifest (per-page names, image-tile ranges, `1..N` marker ranges, per-number `type`, and a replace candidate's `outerHTML` + `selector`). Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **JSON reliability:** the prompt ends with an explicit "respond with ONLY the JSON object, no prose, no markdown code fences" hardening line (`_shared-json-tail.md`) and keeps a small flat schema + one inline example. The lib parses tolerantly (its `structured-output.ts` extractor: direct / fenced / embedded) and applies a bounded repair-retry (feed the model its own invalid output + the parse error, 1–2×) — the same tolerant-parse baseline `visual-verify` uses in production on this stack. (Forced schema-constrained tool-use via `tool_choice` is available on the prod worker but NOT the dev Claude-Code shim.)
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.

### Caching notes

The composed system text is the STABLE, shop-independent prefix (`cache_control` 1h breakpoint in [`handlers/messages.ts`](../../src/handlers/messages.ts)), and the per-shop screenshots + whole-store manifest ride AFTER it in the first user message, so repeated per-shop calls HIT the cached prefix. `composePrompt(a, b, c)` === `[a,b,c].map(trim).join('\n\n')`, so the STABLE part order (above) yields a byte-stable prefix — a reordered block busts the cache. NEVER put per-shop VARIABLE data (screenshots, the per-page manifest, a candidate's `outerHTML`, file ids) in any block; that is the "variable data last" expectation (see CACHING in `messages.ts` / `lib/cache-control.ts`). The off-page blocks are equally stable — no per-shop data in segments/discounts either.

### Pinning test

[`test/onboarding-prompt-blocks.test.ts`](../../test/onboarding-prompt-blocks.test.ts) is the byte-equivalence gate. Because `onboarding-batch-all` is the ONE intended divergence (the holistic off-page additions), it is NOT asserted byte-identical to its baseline as a whole. Instead the suite pins it in parts:

- **The box+PB portion is byte-identical as a PREFIX** — the baseline body (everything before the closing JSON-only tail) must survive verbatim as the composed prompt's prefix; the holistic build only APPENDS off-page content, never edits the box/PB portion.
- **The JSON-only tail still CLOSES the prompt** — the off-page blocks sit BEFORE it.
- **The three off-page blocks are all present AND new** — `_block-audience-segments`, `_block-discount-specs`, `_block-store-wide-output` each compose in verbatim, are genuinely NEW vs the baseline body, and the output names the two store-wide keys (`` `segments` ``, `` `discounts` ``) the lib parser consumes.
- **The off-page blocks compose into `onboarding-batch-all` ONLY** — a separate suite asserts their markers do NOT leak into `onboarding-batch`, `onboarding-review`, or `onboarding-review-all`.
- **No per-shop VARIABLE data** leaks into any composed onboarding prompt (no `file_id` / screenshot marker / `fileIds`), keeping the cache prefix stable.

When you change the box/PB portion ON PURPOSE, regenerate the shared `onboarding-batch-all.baseline.md` (and note the box-placement change also flows to `onboarding-batch`). When you change an off-page block on purpose, the "present AND new" and marker assertions guard it; update the block and re-run the gate.
