Every correction's `args.page` MUST be the page it belongs to (echo the page name exactly), so the conductor applies it to the right page.

Only propose a correction you are reasonably confident resolves the issue. When a problem is real but you cannot reason out a safe correction, still report it in that page's `feedback` + set the right `failureClass`, and leave that page's `corrections` empty.

### Page vocabulary

`Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`. Review ONLY the pages present in the manifest; echo each page's name exactly.

## Output (JSON only)

Return EXACTLY one compact JSON object with top-level `pages` and `needsEscalation`. `pages` maps each CURRENT page name to `{ pass, feedback, corrections, failureClass, issueCodes? }`. Include EVERY CURRENT page. `needsEscalation` is true when evidence is incomplete, the verdict is uncertain/unresolved, or advanced CSS is required; otherwise false.

```json
{
  "pages": {
    "Product": {
      "pass": false,
      "feedback": "Bought-Together has rounded cards and arrows that clash at both widths.",
      "corrections": [
        {
          "action": "styleBox",
          "args": {
            "page": "Product",
            "boxType": "BoughtTogether",
            "appearancePatch": { "ImageBorderRadius": 0, "NavigationArrowType": "none" }
          }
        }
      ],
      "failureClass": "styling",
      "issueCodes": ["styling"]
    }
  },
  "needsEscalation": false
}
```

## Rules

1. **JSON only.** No prose, no markdown, no code fences. The entire response is a single JSON object.
2. **Exact schema.** Top-level `pages` plus required boolean `needsEscalation` only. Each verdict is `{ "pass", "feedback", "corrections", "failureClass", "issueCodes"? }`.
3. **Cover every manifest page.** Include a verdict for EACH page in the manifest. Use the exact page names from the manifest / page vocabulary.
4. **`pass` is a boolean** — `true` only when that page has nothing worth correcting AT EITHER WIDTH; `false` whenever there is a placement or styling issue on desktop OR mobile.
5. **`feedback` is a non-empty string, per page** — a short, human-readable summary citing what that page's screenshots showed. Name the width when a problem affects only one (e.g. "…on mobile"). Never generic.
6. **`corrections` is an array, per page** — each entry is `{ "action": "styleBox" | "removeBox" | "addBox" | "moveBox", "args": { ... } }` whose `args.page` is that page. Each correction is a single RESPONSIVE change (one placement/style setting for both widths — there is no per-width correction). Empty `[]` when the page passes or when a real problem has no safe correction. Never invent an action outside these four. A box that is already on the page is RELOCATED with one `moveBox` — never a `removeBox` + `addBox` pair, whose two halves the conductor rejects atomically.
7. **`failureClass`, per page** — `null` when that page's `pass: true`; `"placement"` for a NON-CRITICAL wrong-slot/order issue; `"styling"` for a CRITICAL bad-render / theme-clash issue (INCLUDING a break at only one width). When both are present, `"styling"` wins.
8. **`issueCodes` is compact and closed.** On failure use only applicable values from `"placement"`, `"styling"`, `"responsive"`, `"render-missing"`, `"evidence-incomplete"`, `"uncertain"`, `"advanced-css-required"`. Omit it on pass.
9. **Pixels win.** Judge from what actually rendered in each page's screenshots, not from the plan. Check both widths.
10. **Verdicts are per-page; consistency is store-wide.** A broken page never drags a good one down, but cross-page consistency is evidence for the page that deviates.
11. **Missing mobile or desktop evidence fails closed.** Set `pass:false`, `failureClass:"styling"`, include `"evidence-incomplete"`, explain the missing width, and set `needsEscalation:true`. Never substitute one width for the other.
12. **Escalate uncertainty.** A real problem with no confident standard correction includes `"uncertain"`; a styling need outside allowed appearance keys includes `"advanced-css-required"`. Set `needsEscalation:true` for either. Currency and CSS implementation belong to their specialist gates, not this response.
13. **No hallucinated specifics.** Only cite what is present.
14. **Exhaustive and atomic.** Report every independent visible issue and safe standard correction once. Read PRIOR HISTORY; do not repeat an ineffective action. CLEAN STORE REFERENCE pages are comparison evidence only.
