# Cart-Drawer Batch (PROPOSE) — Maintenance Doc

The design/maintenance record for the `cartdrawer-batch-all` prompt — the PROPOSE half of the cart-drawer conductor (#96). It is a **COMPOSED prompt**: rather than one `prompt.md`, its system text is assembled by `composePrompt(...)` in the prompt's own barrel [`src/prompts/cartdrawer-batch-all/index.ts`](../../src/prompts/cartdrawer-batch-all/index.ts) from per-prompt fragment files in [`src/prompts/cartdrawer-batch-all/`](../../src/prompts/cartdrawer-batch-all/) (`_intro.md`, `_receive.md`, `_drawer-guidance.md`, `_appearance-keys.md`, `_output-and-rules.md`) plus SHARED blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/) (box-placement, box vocabulary, the mobile-first rule, the JSON-only hardening lines, the appearance-patch header, the JSON tail). Those shared blocks are the SAME files the four onboarding prompts and `optimize-demand` compose, so **an edit to a shared block updates every prompt that composes it** — change a drawer behavior in a `cartdrawer-batch-all/` fragment, not in a shared block, unless you intend the change to land store-wide. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## The cart-drawer conductor in one paragraph

This is the CART-DRAWER twin of the onboarding batch pair (see the cousin doc, [onboarding-batch.md](onboarding-batch.md)). The conductor is 100% AI, like onboarding: it opens the merchant's cart DRAWER (a rendered slide-out overlay), screenshots the OPEN drawer at desktop + mobile widths, calls `cartdrawer-batch-all` for ONE plan of the box(es) to place INSIDE the drawer, the lib conductor applies that plan box-by-box, then [`cartdrawer-review-all`](cartdrawer-review-all.md) does the VISUAL REVIEW. The one hard difference from onboarding: the drawer is a **SINGLE surface**, not a paginated store — so both drawer prompts drop the `pages` wrapper the onboarding twins use. This doc covers the PROPOSE half. (The `probe-cart-wiring` prompt separately DETECTS/classifies the drawer and emits selectors; these placement prompts are downstream of it.)

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is NOT a `probe-<id>` name: probes are Website-Analysis capabilities; this is a cart-drawer conductor step.

## `cartdrawer-batch-all`

- **Purpose:** Given ONE surface — the OPEN cart drawer at two widths — return ONE JSON plan of which recommendation box(es) to place INSIDE the drawer, at which numbered candidate (INSERT before/after or REPLACE), and how to style each so it looks native to the store and FITS the narrow drawer column on BOTH phone and desktop.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`) — the same reasoner class as `onboarding-batch-all`. Body omits `model`, so the registry is authoritative.
- **`maxTokens`:** 4096.
- **Tools:** none (one-shot JSON, `usesTools: false`, no `clientTools`).
- **Attachments:** none (`attachments: []`). The lib uploads the drawer's two screenshots per request via `POST /files`.
- **Box vocabulary:** from the shared [`_shared-box-vocab.md`](../../src/prompts/onboarding-shared/_shared-box-vocab.md) block (`MostPopular`, `Trending`, `NewArrivals`, `YouMayLike`, `RecentViews`, `BoughtTogether`, `CrossSell`, `Upsell`, `RelatedItems`, `FeaturedCollection`). The drawer's own rules NARROW this list — see the frozen output contract below.

### How it composes (frozen block order)

`cartdrawerBatchAllPrompt = composePrompt(...)` joins these parts in this exact order (a reordered block busts the prompt cache — the order is load-bearing). D = drawer-specific fragment (authored anew), S = shared block reused verbatim from onboarding:

1. `_intro.md` (D) — cart-drawer expert framing; ONE surface, TWO widths, compact overlay.
2. [`_shared-mobile-first.md`](../../src/prompts/onboarding-shared/_shared-mobile-first.md) (S) — mobile is first-class.
3. [`_shared-json-hardening.md`](../../src/prompts/onboarding-shared/_shared-json-hardening.md) (S) — machine-readable JSON only.
4. [`_block-box-placement.md`](../../src/prompts/onboarding-shared/_block-box-placement.md) (S) — INSERT (violet) vs REPLACE (green) numbered-candidate placement.
5. `_receive.md` (D) — the drawer MANIFEST + images contract, scoped to the open drawer.
6. [`_shared-guidance.md`](../../src/prompts/onboarding-shared/_shared-guidance.md) (S) — "this is guidance, not a script."
7. [`_shared-box-vocab.md`](../../src/prompts/onboarding-shared/_shared-box-vocab.md) (S) — the box-type names.
8. `_drawer-guidance.md` (D) — the compact-overlay best practice (below line items / above checkout CTA; small box; drawer-strong types).
9. [`_shared-appearance-header.md`](../../src/prompts/onboarding-shared/_shared-appearance-header.md) (S) — allowed-keys header.
10. `_appearance-keys.md` (D) — the desktop-and-shared `appearancePatch` keys.
11. [`_shared-mobile-rule.md`](../../src/prompts/onboarding-shared/_shared-mobile-rule.md) (S) — the `appearancePatchMobile` header.
12. `_output-and-rules.md` (D) — the SINGLE-SURFACE `{ boxes }` output contract + the 12 rules (incl. the mobile-only keys and the cart-context box constraint).
13. [`_shared-json-tail.md`](../../src/prompts/onboarding-shared/_shared-json-tail.md) (S) — the closing "respond with ONLY the JSON object" line.

### Input (what the lib provides)

For the ONE surface — the OPEN cart drawer — the lib sends a pair of translucent-marked screenshots + a drawer MANIFEST. Placement has TWO modes over ONE continuous number sequence — INSERT a new box at a numbered violet anchor OR REPLACE an existing static grid at a numbered green candidate — via the shared `_block-box-placement.md` capability block (the SAME block onboarding composes):

- **TWO screenshots of the OPEN drawer at two widths** (each an image, uploaded via `/files`) — a **desktop** and a **mobile** (phone-width) screenshot of the same open drawer, each with numbered `+1 +2 +3 … +N` markers painted as a TRANSLUCENT overlay (~50% opacity), **ONE number per CANDIDATE** — each number labels a placement candidate INSIDE the drawer (a **violet INSERT anchor** = an existing boundary the box sits before/after, OR a **green REPLACE candidate** = an existing static grid/carousel the box can swap IN for). Dual purpose per image: the store's real drawer design (card style, palette, spacing, typography) shows THROUGH the markers, so the model reads the aesthetic from the drawer underneath AND the candidate numbers from the overlay. Mobile is FIRST-CLASS.
- **The drawer MANIFEST** (text block) — which uploaded images are the drawer's DESKTOP tiles and which are its MOBILE tiles (by 1-based position in the image list), the candidate range (`1..N`) **plus, per number, its `type` (`"insert"` | `"replace"`)**, and for a `replace` candidate its **`outerHTML`** (block structure + product-card markup) + a reference **`selector`**. Example line: `DRAWER: DESKTOP TILES images 1-1, MOBILE TILES images 2-2, CANDIDATE ANCHORS 1..4`. INSERT anchors carry no extra data; the `outerHTML` grounds both the replace decision and the style clone. **The numbering is ONE continuous sequence SHARED across both widths:** marker `+3` is the SAME logical candidate on the drawer's desktop and mobile image (it may reflow, or exist on only one width). A box is placed RELATIVE to a numbered candidate: the model emits `anchorNumber` (which candidate) + `position` (`"before"`/`"after"` an insert anchor, or `"replace"` a replace candidate — matching that candidate's `type`). That pair is ONE responsive placement for both widths, not one per width. The `number → real element sibling selector` mapping is conductor-internal (the lib keeps it; the model never emits a selector). Every `anchorNumber` must be an integer in `1..N` the model actually SEES painted, whose `type` matches its `position`.
- **This whole payload — the images, the manifest, and each replace candidate's `outerHTML` — is per-shop VARIABLE data. It rides AFTER the cache breakpoint in the first user message, never in the cached (composed) system prefix.**

### Frozen output contract

The assistant text is a single JSON object with a top-level key `boxes` plus an OPTIONAL `progressBar`. **There is NO `pages` wrapper and NO per-page map** — this is ONE surface (the open drawer), so the surface is IMPLICIT and every box in `boxes` belongs to the drawer. **The OPTIONAL `progressBar`** is the Smart Progress Bar's SECOND host (the playbook places one on the Cart page AND at the top of the drawer when the store uses one): `{ position, anchorNumber, reasoning }`, no appearance keys, `before`/`after` only (never `replace`), omitted when the drawer already shows a threshold bar. **NO off-page `segments` / `discounts` keys** (those are store-wide, decided by onboarding). A drawer that genuinely warrants no box returns `{ "boxes": [] }`.

```json
{
  "boxes": [
    {
      "boxType": "CrossSell",
      "position": "before",
      "anchorNumber": 2,
      "styleReferenceSelector": ".cart-drawer__items",
      "appearancePatch": {
        "Style": "carousel",
        "ItemsPerPage": 2,
        "ItemsLimit": 6,
        "ImageBorderRadius": 0,
        "NavigationArrowType": "none"
      },
      "appearancePatchMobile": null,
      "reasoning": "A compact cross-sell strip just before the checkout CTA (anchor 2) and below the line items, cloning the drawer's own item cards; carousel of 2 with a 6-item pull keeps it small enough for the narrow drawer at both widths."
    }
  ]
}
```

- `boxType` — from the box vocabulary, but the drawer NARROWS it: the box MUST be a **cart-context** recommendation (one that reasons about what the shopper is buying). Favor the drawer-strong types (`CrossSell`, `BoughtTogether`, `Upsell`, `YouMayLike`, `RelatedItems`). `RecentViews` is a WEAK fit inside a drawer. **NEVER a pure catalog strip** (`MostPopular`, `Trending`, `NewArrivals`, `FeaturedCollection`) — those render the same products regardless of the cart, so they are not a genuine cart-drawer cross-sell.
- `position` — exactly `"before"`, `"after"`, or `"replace"`: before/after a violet INSERT anchor, or `replace` a green REPLACE candidate. MUST match the candidate's manifest `type`; never `replace` a non-replace number.
- `anchorNumber` — an INTEGER in the drawer's `1..N` shared numbering, equal to a candidate the model actually SEES painted on the drawer's images whose `type` matches `position`. With `position`, ONE responsive placement for both widths. Never invented / out of range / a `replace` on a non-replace number. The lib maps the number to the element's sibling selector internally; the model never emits a selector.
- `styleReferenceSelector` — OPTIONAL, PREFERRED: a CSS selector for the store's own most-representative product block to CLONE the box's appearance from (e.g. `".cart-drawer__items"`, `".product-grid"`, `"ul.grid--collection"`). On a `replace` box, point it at the replaced candidate's own reference `selector` from the manifest — its `outerHTML` grounds the clone precisely. Include it whenever a good reference exists.
- `appearancePatch` — `null`, OR an object of DESKTOP-and-shared keys using ONLY: `Style` (`"carousel"`|`"grid"`|`"bundle"`|`"rows"`), `ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`, `NavigationArrowType`. The FALLBACK used ONLY when there is no `styleReferenceSelector`. Keep it COMPACT for the narrow drawer (low `ItemsPerPage` / `ItemsLimit`, small images, no big arrows) and readable at BOTH widths.
- `appearancePatchMobile` — `null` (the common case), OR an object of MOBILE-ONLY overrides using ONLY `ImageHeightMobile` (px, default 200) + `MarginRightMobile` (px, default 10). No desktop keys; NO mobile items-per-row (the phone row is width-driven, floored at 2 products/row). Set only when mobile must diverge.
- `reasoning` — one short sentence, tied to what the model SAW in the drawer when possible.

No extra keys, no missing keys, no `page` field on a box (single surface). `boxes` may be empty. **Usually ONE box is right for a compact drawer** — occasionally two; a cramped drawer is worse than none, so if nothing fits cleanly the model returns `{ "boxes": [] }`. Don't add a strip when the drawer already shows a working cross-sell / LimeSpot widget.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: cartdrawer-batch-all`.
- Body: a standard Anthropic messages payload. User content = TWO image blocks (the open drawer's desktop + mobile screenshots, each with the translucent numbered-candidate overlay, uploaded via `POST /files`) plus a text block carrying the drawer MANIFEST (desktop/mobile tile indexes, the `1..N` candidate range, per-number `type`, and each replace candidate's `outerHTML` + `selector`). Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **JSON reliability:** the prompt ends with the shared `_shared-json-tail.md` hardening line ("respond with ONLY the JSON object, no prose, no markdown code fences") and keeps a small flat schema + one inline example. The lib parses tolerantly (its `structured-output.ts` extractor: direct / fenced / embedded) and applies a bounded repair-retry.
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke.

### Caching notes

- Same cache-first design as onboarding. The composed blocks are the STABLE, shop-independent prefix that `handlers/messages.ts` places before the `cache_control` (extended) breakpoint, so repeated per-shop calls HIT the cached prefix.
- **No per-shop VARIABLE data lives in any composed block** — the open-drawer screenshots, the numbered candidate manifest, and a replace candidate's `outerHTML` all ride AFTER the breakpoint in the first user message. A file id / screenshot reference leaking into the composed system text would bust the cache; the pinning test asserts none is present.
- The composed block ORDER (listed above) is frozen — a reordered block busts the cache.

### Pinning test

[`test/cartdrawer-prompts.test.ts`](../../test/cartdrawer-prompts.test.ts) covers both drawer prompts. For `cartdrawer-batch-all` it pins: (a) the entry resolves by name to non-trivial text with `usesTools: false` and no `clientTools`; (b) it is the `balanced` tier (Sonnet) model, `maxTokens` 4096, same model as `onboarding-batch-all`; (c) it carries the drawer-specific guidance ("BELOW the line items and ABOVE the checkout CTA", "FITS the drawer's narrow width", "compact slide-out OVERLAY", cross-sell); (d) it states the SINGLE-SURFACE `{ boxes: [...], progressBar? }` contract with NO `"pages"` JSON key, the OPTIONAL `progressBar` slot, NO off-page `segments`/`discounts`, and carries every box field the lib parser matches (`boxType`, `position`, `anchorNumber`, `styleReferenceSelector`, `appearancePatch`, `appearancePatchMobile`, `reasoning`); (e) the shared box-placement block ("INSERT anchors (violet)") and the shared JSON tail are REUSED; and (f) the composed prompt carries no `file_id`/`fileIds` per-shop data. Unlike the onboarding prompts there is no byte-equivalence snapshot baseline — the drawer prompts are authored directly as composed prompts (there is no single-file `prompt.md`), so coverage is marker-based rather than a `__snapshots__` diff.
