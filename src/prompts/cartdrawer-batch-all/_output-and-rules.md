`appearancePatchMobile` is either `null` (the shared styling already reads well on phone — the common case) OR an object of MOBILE-ONLY overrides. Use ONLY these keys, no desktop keys:

- **`ImageHeightMobile`** — product image height on phone, in px (default `200`).
- **`MarginRightMobile`** — gap between cards on phone, in px (default `10`).

There is deliberately NO mobile items-per-row control — the phone layout is width-driven and floors at 2 products per row; a mobile items value is ignored by design, so never emit one. Set `appearancePatchMobile` only when mobile genuinely needs to diverge; leave it `null` otherwise.

## Output (JSON only)

Return EXACTLY one JSON object with a SINGLE top-level key `boxes` — an array of the box(es) to place INSIDE the drawer. There is NO `pages` wrapper and NO per-page map: this is ONE surface (the open drawer), so the surface is IMPLICIT and every box in `boxes` belongs to the drawer. There is NO `progressBar` key (the Smart Progress Bar is a Cart-PAGE item, not a drawer item — the drawer is too compact) and NO off-page `segments` / `discounts` keys (those are store-wide, decided by onboarding, not here). A drawer that genuinely warrants no box gets `{ "boxes": [] }`. Nothing else.

```json
{
  "boxes": [
    {
      "boxType": "CrossSell",
      "position": "before",
      "anchorNumber": 2,
      "styleReferenceSelector": ".cart-drawer__items",
      "appearancePatch": { "Style": "carousel", "ItemsPerPage": 2, "ItemsLimit": 6, "ImageBorderRadius": 0, "NavigationArrowType": "none" },
      "appearancePatchMobile": null,
      "reasoning": "A compact cross-sell strip just before the checkout CTA (anchor 2) and below the line items, cloning the drawer's own item cards; carousel of 2 with a 6-item pull keeps it small enough for the narrow drawer at both widths."
    }
  ]
}
```

## Rules

1. **JSON only.** No prose, no markdown, no code fences. The entire response is a single JSON object.
2. **Exact schema.** One top-level key `boxes` — an array. NO `pages` wrapper, NO `progressBar`, NO `segments` / `discounts`. Each box has `boxType`, `position`, `anchorNumber`, `appearancePatch`, `appearancePatchMobile`, `reasoning`, and the OPTIONAL `styleReferenceSelector`. The surface is implicit (the drawer) — a box carries no `page` field.
3. **`boxType`** — from the box vocabulary. Never invent a box name. The drawer's box MUST be a CART-CONTEXT recommendation — one that reasons about what the shopper is buying: favor the drawer-strong types (`YouMayLike`, `CrossSell`, `BoughtTogether`, `Upsell`, `Related`). `RecentViews` is a weak fit inside a drawer. NEVER use a pure catalog strip (`Popular` / `MostPopular`, `Trending`, `NewArrival` / `NewArrivals`, `FeaturedCollection*`): those render the same products regardless of what's in the cart, so they are NOT a genuine cart-drawer cross-sell — a shopper mid-checkout needs a strip relevant to their cart, not a generic best-sellers row.
4. **`position`** — exactly `"before"`, `"after"`, or `"replace"`. Use `"before"` / `"after"` on a violet INSERT anchor; use `"replace"` on a green REPLACE candidate (the manifest marks its `type`) — match the candidate's `type`, and never `replace` a number that is not a replace candidate.
5. **`anchorNumber`** — an INTEGER in the drawer's `1..N` range, equal to a numbered candidate you actually SEE on the drawer's images whose manifest `type` matches your `position`. Numbering is one continuous sequence shared across both widths. Together with `position` it is ONE responsive placement for both widths. If no candidate fits a box you wanted, drop that box rather than inventing a place. Emit only the number + `before`/`after`/`replace` — never a selector.
6. **`styleReferenceSelector`** (OPTIONAL, PREFERRED) — a CSS selector for the store's own most-representative product block to CLONE from (the drawer's own line-item cards, or a product grid / carousel). On a `replace` box, use the replaced candidate's own reference `selector` from the manifest (its `outerHTML` grounds the clone). Include it whenever a good reference exists; omit it (and lean on `appearancePatch`) only when there is none. Emit a plain selector string, never a value for a block you don't see.
7. **`appearancePatch`** — `null`, OR an object using ONLY the allowed DESKTOP-and-shared keys. The FALLBACK when there is no `styleReferenceSelector`. Keep it COMPACT for the narrow drawer (low `ItemsPerPage` / `ItemsLimit`, small images, no big arrows) and make it read well at BOTH widths. When you gave a `styleReferenceSelector`, leave this `null`.
8. **`appearancePatchMobile`** — `null` (common), OR an object of mobile-only overrides (`ImageHeightMobile`, `MarginRightMobile` only). No desktop keys, no mobile items-per-row.
9. **`reasoning`** — one short sentence, tied to what you SAW in the drawer when you can.
10. **Fit the drawer; usually ONE box.** The canonical spot is BELOW the line items and ABOVE the checkout CTA. A small, well-fitted box beats a crowded drawer; occasionally two, rarely more. If nothing fits cleanly, return `{ "boxes": [] }` rather than crowd the drawer.
11. **Respect existing setup.** Don't add a strip when the drawer already shows a working cross-sell / LimeSpot widget.
12. **Tolerate missing evidence.** Only one width, a partial screenshot, or a sparse manifest is not an error — reason from what remains and lean on the drawer-strong best practice.
