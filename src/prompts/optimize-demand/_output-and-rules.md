`appearancePatchMobile` is either `null` (the desktop/shared styling already reads well on phone — the common case) OR an object of MOBILE-ONLY overrides you set when the phone layout needs to differ. Use ONLY these keys — do not invent keys, and do NOT put desktop keys here:

- **`ImageHeightMobile`** — the product image height on phone, in px (default `200`). Lower it when the cards are too tall on a narrow screen; raise it when they look cramped.
- **`MarginRightMobile`** — the gap between cards on phone, in px (default `10`). Adjust so the row breathes without wasting width.

There is deliberately NO mobile items-per-row control — the phone layout is width-driven and floors at 2 products per row; a mobile items-per-page value is ignored by design, so never emit one. Set `appearancePatchMobile` only when mobile genuinely needs to diverge; leave it `null` otherwise.

## Output (JSON only)

Return EXACTLY one JSON object of this shape and nothing else. The top-level keys are `page` and `boxes`. There is NO `progressBar` key (on-demand optimize places recommendation boxes; a Smart Progress Bar is set up through onboarding, not here) and NO off-page `segments` / `discounts` keys (those are store-wide, decided by onboarding). A page that genuinely warrants no change gets `{ "page": "...", "boxes": [] }` — and in that case `boxes` MUST be an empty array with ZERO elements (`[]`), NEVER an array containing empty or placeholder objects like `[{}]` or `[{},{}]`. Every element of `boxes`, if any, is a COMPLETE box object with a real `boxType` from the vocabulary — never an empty or partial placeholder.

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
      "reasoning": "The merchant asked for a frequently-bought-together strip under the product details, so a BoughtTogether box after candidate 2 (the product-details section), cloning the store's own product grid so the cards match exactly."
    },
    {
      "boxType": "RelatedItems",
      "position": "after",
      "anchorNumber": 3,
      "styleReferenceSelector": ".product-grid",
      "appearancePatch": null,
      "appearancePatchMobile": { "ImageHeightMobile": 160, "MarginRightMobile": 8 },
      "reasoning": "Related Items after the bought-together strip rounds out the page with catalog-backed recommendations, with shorter mobile images so the row isn't too tall on phone."
    }
  ]
}
```

When the page already reads well and NO box is warranted, the ENTIRE response is this — `boxes` is a zero-length array:

```json
{ "page": "Cart", "boxes": [] }
```

That is `[]` with ZERO elements. It is NEVER `{ "page": "Cart", "boxes": [{}] }` or `{ "page": "Cart", "boxes": [{}, {}] }` — an array of empty or partial objects is malformed output, not "no boxes". If you have no box to add, write literally `"boxes": []` and stop.

## Rules

1. **Honor the demand first.** Everything the merchant explicitly asked for on this page must be in the plan. Best-practice additions come after, and never at the expense of the demand. (See the demand block above.)
2. **JSON only.** No prose, no markdown, no code fences. The entire response is a single JSON object.
3. **Exact schema.** Top-level keys `page` and `boxes` — no `progressBar`, no `segments` / `discounts`. Each box has `boxType`, `position`, `anchorNumber`, `appearancePatch`, `appearancePatchMobile`, `reasoning`, and the OPTIONAL `styleReferenceSelector` (include it only when you have a reference block to clone).
4. **`page`** — echo back the page you were given (from the page vocabulary).
5. **`boxType`** — from the box vocabulary above. Never invent a box name.
6. **`position`** — exactly `"before"` or `"after"`: whether the box goes before or after the numbered candidate named by `anchorNumber`. No other value — placement is ADDITIVE ONLY, `"replace"` is never emitted, and the merchant's own sections all stay on the page.
7. **`anchorNumber`** — an INTEGER in `1..N` (the valid SHARED continuous candidate range), equal to a numbered candidate you actually SEE painted on the page (on the desktop and/or mobile image) . Together with `position`, it is ONE responsive placement for both widths, not one per width. Pick ONLY from the visible numbered candidates. Never invent a number that is not painted on the page or is outside `1..N`. If the demand asked for a box but no candidate fits it, place what you can and note the constraint in that box's `reasoning` — do not invent a place.
8. **`styleReferenceSelector`** (OPTIONAL, PREFERRED) — a CSS selector string for the store's own most-representative product grid / carousel to CLONE the box's appearance from (e.g. `".product-grid"`, `"ul.grid--collection"`). The system reads that block's REAL computed styling and applies it to the box — the most faithful way to look native. A green reference candidate's manifest `selector` is ideal (its `outerHTML` grounds the clone precisely). Include it whenever a good reference block exists; omit it (and lean on `appearancePatch`) only when the store has none to clone on this page. Emit a plain selector string, never a value for a block you don't actually see.
9. **`appearancePatch`** — `null`, OR an object using ONLY the allowed DESKTOP-and-shared keys (`Style`, `ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`, `NavigationArrowType`). It is the FALLBACK when there is no `styleReferenceSelector` reference to clone. Set it to make the box match the store's native card style as seen in the images, and to read well at BOTH widths. When you gave a `styleReferenceSelector`, leave this `null` (the clone supplies the styling).
10. **`appearancePatchMobile`** — `null` (the common case — the shared styling already reads well on phone), OR an object of mobile-only overrides using ONLY `ImageHeightMobile` (px, default 200) and `MarginRightMobile` (px, default 10). No desktop keys here, and NO mobile items-per-row (the phone row is width-driven, floored at 2 products/row; a mobile items value is ignored). Set it only when mobile genuinely needs to differ.
11. **`reasoning`** — one short sentence on why this box, here, styled this way — tied to the demand and to what you SAW when you can.
12. **Respect existing setup.** If the page already has the right widgets (a LimeSpot carousel, a related-products strip you can see in either image), don't pad it with redundant boxes — but always still deliver what the merchant explicitly asked for.
13. **Tolerate missing evidence.** A partial screenshot, or only one of the two widths, is not an error — reason from what remains and lean on the best-practice stack for this page, while still honoring the demand.
14. **Empty means empty.** When no box is warranted for this page, emit `"boxes": []` — a ZERO-LENGTH array — NEVER `[{}]`, `[{},{}]`, or any array of empty / partial objects. A placeholder object is not "no boxes"; it is a malformed box. Every element you DO include is a complete box with a real `boxType`.
