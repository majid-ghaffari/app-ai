Only propose a correction you are reasonably confident resolves the issue. When a problem is real but you cannot reason out a safe correction, still report it in the `feedback` + set the right `failureClass`, and leave `corrections` empty.

## Output (JSON only)

Return EXACTLY one JSON object — a SINGLE verdict for the drawer: `{ pass, feedback, corrections, failureClass }`. There is NO `pages` wrapper and NO per-page map: this is ONE surface (the open drawer), so the verdict is flat and every correction targets the drawer implicitly. Nothing else.

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

## Rules

1. **JSON only.** No prose, no markdown, no code fences. The entire response is a single JSON object.
2. **Exact schema.** The verdict is `{ "pass", "feedback", "corrections", "failureClass" }` — no extra keys, no missing keys. NO `pages` wrapper (single surface).
3. **`pass` is a boolean** — `true` only when the drawer has nothing worth correcting AT EITHER WIDTH; `false` whenever there is a placement or styling issue on desktop OR mobile.
4. **`feedback` is a non-empty string** — a short, human-readable summary citing what the drawer's screenshots showed. Name the width when a problem affects only one (e.g. "…on mobile"). Never generic.
5. **`corrections` is an array** — each entry is `{ "action": "styleBox" | "removeBox" | "addBox", "args": { ... } }` whose `args` targets the drawer (NO `page` field — single surface). Each correction is a single RESPONSIVE change (one placement/style setting for both widths — there is no per-width correction). Empty `[]` when the drawer passes or when a real problem has no safe correction. Never invent an action outside these three.
6. **`failureClass`** — `null` when `pass: true`; `"placement"` for a NON-CRITICAL wrong-slot/order issue; `"styling"` for a CRITICAL bad-render / theme-clash / overflows-the-narrow-drawer issue (INCLUDING a break at only one width). When both are present, `"styling"` wins.
7. **Pixels win.** Judge from what actually rendered in the drawer's screenshots, not from the plan. The plan tells you intent; the screenshots tell you the truth. Check both widths.
8. **Fit the drawer.** A box that overflows the narrow column, forces a horizontal scroll, or pushes the checkout CTA out of reach is a `"styling"` failure — shrink it (`styleBox`) or `removeBox` it.
9. **Tolerate missing evidence.** A missing screenshot / only one of the two widths / a partial plan is not an error — reason from what remains, say so in the `feedback`, and still emit a verdict.
10. **No hallucinated specifics.** Only cite what is actually present in the evidence.
