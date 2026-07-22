`appearancePatchMobile` is either `null` (the desktop/shared styling already reads well on phone — the common case) OR an object of MOBILE-ONLY overrides you set when the phone layout needs to differ. Use ONLY these keys — do not invent keys, and do NOT put desktop keys here:

- **`ImageHeightMobile`** — the product image height on phone, in px (default `200`). Lower it when the cards are too tall on a narrow screen; raise it when they look cramped.
- **`MarginRightMobile`** — the gap between cards on phone, in px (default `10`). Adjust so the row breathes without wasting width.

There is deliberately NO mobile items-per-row control — the phone layout is width-driven and floors at 2 products per row; a mobile items-per-page value is ignored by design, so never emit one. Set `appearancePatchMobile` only when mobile genuinely needs to diverge; leave it `null` otherwise.

## Output (JSON only)

Return EXACTLY one JSON object of this shape and nothing else. The top-level keys are `page` and `boxes`, PLUS an OPTIONAL `progressBar` — present ONLY when `page` is `Cart` and you decide the Smart Progress Bar fits. The `progressBar`, when present, is `{ position, anchorNumber, reasoning }` (a `position` from `before` / `after` / `replace`, an `anchorNumber` from the page's shared markers, and one-sentence `reasoning`) — NO appearance keys, since the bar's look comes from its campaign template. On a non-Cart page, or on Cart with no bar warranted, omit the `progressBar` key (or set it to `null`).

```json
{
  "page": "Home",
  "boxes": [
    {
      "boxType": "FeaturedCollection",
      "position": "after",
      "anchorNumber": 1,
      "styleReferenceSelector": ".product-grid",
      "appearancePatch": null,
      "appearancePatchMobile": { "ImageHeightMobile": 160, "MarginRightMobile": 8 },
      "reasoning": "A featured-collection carousel right after the hero section; clone the store's own product grid so the cards match exactly, with shorter mobile images so the row isn't too tall on phone."
    },
    {
      "boxType": "RecentViews",
      "position": "before",
      "anchorNumber": 5,
      "styleReferenceSelector": ".collection .grid",
      "appearancePatch": null,
      "appearancePatchMobile": null,
      "reasoning": "Recently Viewed just before the footer section; clone the collection grid so it matches the store at both widths."
    },
    {
      "boxType": "MostPopular",
      "position": "after",
      "anchorNumber": 3,
      "styleReferenceSelector": ".featured-collection .grid",
      "appearancePatch": { "Style": "carousel" },
      "appearancePatchMobile": null,
      "reasoning": "Most Popular right after the store's featured-collection section, cloning that grid's own style so it reads native beside it."
    }
  ]
}
```

On the **Cart page**, a plan MAY additionally carry the `progressBar` slot (Cart ONLY):

```json
{
  "page": "Cart",
  "boxes": [
    {
      "boxType": "YouMayLike",
      "position": "after",
      "anchorNumber": 2,
      "styleReferenceSelector": ".cart__items",
      "appearancePatch": null,
      "appearancePatchMobile": null,
      "reasoning": "You May Like after the cart contents, cloned from the store's own product cards."
    }
  ],
  "progressBar": {
    "position": "before",
    "anchorNumber": 1,
    "reasoning": "A free-shipping threshold bar at the very top of the cart, before the line items, so shoppers see how close they are to the reward."
  }
}
```

## Rules

1. **JSON only.** No prose, no markdown, no code fences. The entire response is a single JSON object.
2. **Exact schema.** Top-level keys `page` and `boxes`, PLUS the OPTIONAL `progressBar` (Cart page only) — no others. Each box has `boxType`, `position`, `anchorNumber`, `appearancePatch`, `appearancePatchMobile`, `reasoning`, and the OPTIONAL `styleReferenceSelector` (include it only when you have a reference block to clone).
3. **`page`** — echo back the page you were given (from the page vocabulary).
4. **`boxType`** — from the box vocabulary above. Never invent a box name.
5. **`position`** — exactly `"before"` or `"after"`: whether the box goes before or after the numbered candidate named by `anchorNumber`. No other value — placement is ADDITIVE ONLY, `"replace"` is never emitted, and the merchant's own sections all stay on the page.
6. **`anchorNumber`** — an INTEGER in `1..N` (the valid SHARED continuous candidate range), equal to a numbered candidate you actually SEE painted on the page (on the desktop and/or mobile image) . Together with `position`, it is ONE responsive placement for both widths, not one per width. Pick ONLY from the visible numbered candidates. Never invent a number that is not painted on the page or is outside `1..N`. If no candidate fits a box you wanted, drop that box rather than inventing a place for it. You emit only the number + `before`/`after` — never a selector; the conductor resolves the number to the real element's sibling selector.
7. **`styleReferenceSelector`** (OPTIONAL, PREFERRED) — a CSS selector string for the store's own most-representative product grid / carousel to CLONE the box's appearance from (e.g. `".product-grid"`, `"ul.grid--collection"`). The system reads that block's REAL computed styling and applies it to the box — the most faithful way to look native. A green reference candidate's manifest `selector` is ideal (its `outerHTML` grounds the clone precisely). Include it whenever a good reference block exists; omit the non-`Style` appearance keys when you have one. Emit a plain selector string, never a value for a block you don't actually see.
8. **`appearancePatch`** — an object that ALWAYS carries the box's playbook `Style` (`"carousel"` unless the stack names another — the Cart Upsell `"slider"`, the Product Frequently Bought Together `"bundle"`). When there is NO `styleReferenceSelector` to clone from, also set the other allowed DESKTOP-and-shared keys (`ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`, `NavigationArrowType`) to match the store's native card style at BOTH widths; when you gave a reference, emit `Style` alone (the clone supplies the rest).
9. **`appearancePatchMobile`** — `null` (the common case — the shared styling already reads well on phone), OR an object of mobile-only overrides using ONLY `ImageHeightMobile` (px, default 200) and `MarginRightMobile` (px, default 10). No desktop keys here, and NO mobile items-per-row (the phone row is width-driven, floored at 2 products/row; a mobile items value is ignored). Set it only when mobile genuinely needs to differ.
10. **`reasoning`** — one short sentence on why this box, here, styled this way — tied to what you SAW when you can.
11. **Focused, not exhaustive.** A small set of strong boxes that fit this store beats a crowded page. `boxes` may be empty if this page genuinely warrants no boxes.
12. **`progressBar`** (OPTIONAL, Cart page ONLY) — omit it entirely unless `page` is `Cart`. On Cart, add it when a threshold nudge fits: `{ "position", "anchorNumber", "reasoning" }` — a `position` (`before`/`after`) + an `anchorNumber` from the page's `1..N` range + one short `reasoning`. NO appearance keys (the campaign template styles the bar). Omit the key (or set it `null`) if the Cart already shows a threshold bar or one wouldn't help.
13. **Respect existing content; ADD, never remove.** A LimeSpot-rendered widget (`limespot` / `ls-` classes) or a cart threshold bar you can see in either image is left alone — never duplicate it. A THEME's own STATIC related-products / recommendations-style grid also STAYS — never replace or displace it; place the playbook's box at the nearest sensible boundary and point `styleReferenceSelector` at that grid so the new box reads native beside it.
14. **Tolerate missing evidence.** A partial screenshot, or only one of the two widths, is not an error — reason from what remains and lean on the best-practice stack for this page.
