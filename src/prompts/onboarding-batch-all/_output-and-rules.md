`appearancePatchMobile` is either `null` (the shared styling already reads well on phone — the common case) OR an object of MOBILE-ONLY overrides. Use ONLY these keys, no desktop keys:

- **`ImageHeightMobile`** — product image height on phone, in px (default `200`).
- **`MarginRightMobile`** — gap between cards on phone, in px (default `10`).

There is deliberately NO mobile items-per-row control — the phone layout is width-driven and floors at 2 products per row; a mobile items value is ignored by design, so never emit one. Set `appearancePatchMobile` only when mobile genuinely needs to diverge; leave it `null` otherwise.

## Output (JSON only)

Return EXACTLY one JSON object with a single top-level key `pages`, an object mapping each page name to that page's plan. Each page's plan is `{ boxes: [ ... ] }` where each box has the SAME per-page shape as before, PLUS an OPTIONAL `progressBar` key — present ONLY on the `Cart` page, when you decide the Smart Progress Bar fits. The `progressBar`, when present, is `{ position, anchorNumber, reasoning }` (a `position` from `before` / `after` / `replace`, an `anchorNumber` from the Cart page's shared markers, and one-sentence `reasoning`) — NO appearance keys, since the bar's look comes from its campaign template. Omit the `progressBar` key entirely on every non-Cart page (and on Cart when no bar is warranted). Include an entry for EVERY page in the manifest (a page that genuinely warrants no boxes gets `{ "boxes": [] }`). Nothing else.

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
          "reasoning": "A featured-collection carousel right after the hero; clone the store's own product grid so cards match, shorter mobile images so the row isn't too tall on phone."
        },
        {
          "boxType": "RecentViews",
          "position": "before",
          "anchorNumber": 5,
          "styleReferenceSelector": ".collection .grid",
          "appearancePatch": null,
          "appearancePatchMobile": null,
          "reasoning": "Recently Viewed just before the footer; clone the collection grid so it matches at both widths."
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
          "reasoning": "Candidate 3 is a green REPLACE candidate — the store's own static \"you may also like\" grid — so swap in a personalized Related Items box, cloning that block's own style so the swap is seamless."
        }
      ]
    },
    "Cart": {
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
  }
}
```

## Rules

1. **JSON only.** No prose, no markdown, no code fences. The entire response is a single JSON object.
2. **Exact schema.** One top-level key `pages` — an object keyed by page name. Each value is `{ "boxes": [...] }`, PLUS the OPTIONAL `progressBar` on the Cart page. Each box has `boxType`, `position`, `anchorNumber`, `appearancePatch`, `appearancePatchMobile`, `reasoning`, and the OPTIONAL `styleReferenceSelector`.
3. **Cover every manifest page.** Include a plan for EACH page in the manifest — `{ "boxes": [] }` if a page warrants none. Use the exact page names from the manifest / page vocabulary.
4. **`boxType`** — from the box vocabulary. Never invent a box name.
5. **`position`** — exactly `"before"`, `"after"`, or `"replace"`. Use `"before"` / `"after"` on a violet INSERT anchor; use `"replace"` on a green REPLACE candidate (the manifest marks its `type`) — match the candidate's `type`, and never `replace` a number that is not a replace candidate.
6. **`anchorNumber`** — an INTEGER in that PAGE's `1..N` range, equal to a numbered candidate you actually SEE on that page's images whose manifest `type` matches your `position`. Numbering is per-page and one continuous sequence across both modes. Together with `position` it is ONE responsive placement for both widths. If no candidate fits a box you wanted, drop that box rather than inventing a place. Emit only the number + `before`/`after`/`replace` — never a selector.
7. **`styleReferenceSelector`** (OPTIONAL, PREFERRED) — a CSS selector for the store's own most-representative product grid / carousel on that page to CLONE from. On a `replace` box, use the replaced candidate's own reference `selector` from the manifest (its `outerHTML` grounds the clone). Include it whenever a good reference exists; omit it (and lean on `appearancePatch`) only when the page has none. Emit a plain selector string, never a value for a block you don't see.
8. **`appearancePatch`** — `null`, OR an object using ONLY the allowed DESKTOP-and-shared keys. The FALLBACK when there is no `styleReferenceSelector`. Make it read well at BOTH widths. When you gave a `styleReferenceSelector`, leave this `null`.
9. **`appearancePatchMobile`** — `null` (common), OR an object of mobile-only overrides (`ImageHeightMobile`, `MarginRightMobile` only). No desktop keys, no mobile items-per-row.
10. **`reasoning`** — one short sentence, tied to what you SAW when you can.
11. **Focused, not exhaustive; vary across pages.** A small set of strong boxes per page beats a crowded store, and don't paste the identical stack onto every page — each page's role decides its boxes.
12. **`progressBar`** (OPTIONAL, Cart page ONLY) — omit it entirely on every non-Cart page. On the Cart page, add it when a threshold nudge fits: `{ "position", "anchorNumber", "reasoning" }` — a `position` (`before`/`after`/`replace`) + an `anchorNumber` from the Cart page's `1..N` range + one short `reasoning`. NO appearance keys (the campaign template styles the bar). Omit the key (or set it `null`) if the Cart already shows a threshold bar or one wouldn't help.
13. **Respect existing PERSONALIZATION; replace static lookalikes.** A LimeSpot-rendered widget (`limespot` / `ls-` classes) or a visible cart threshold bar that's already doing the job is left alone — never duplicate it. But a THEME's own STATIC related-products / recommendations-style grid is NOT personalization — it is exactly what a green REPLACE candidate is for: swap the playbook's box IN for it (e.g. Product: the static "you may also like" grid becomes the Related Items box) rather than deferring to it or working around it.
14. **Tolerate missing evidence.** A partial screenshot, only one width for a page, or a missing page is not an error — reason from what remains and lean on the best-practice stack.
