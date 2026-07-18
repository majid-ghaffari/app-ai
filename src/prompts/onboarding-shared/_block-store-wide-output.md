## Store-wide OFF-PAGE output (segments + discounts)

The whole-store propose returns the on-page `pages` plan AND, alongside it, the
two OFF-PAGE natures — audience segments + discount / bundle campaigns — as
store-wide top-level keys of the SAME JSON object. They are NOT nested under any
page (they belong to the store, not a page), and they carry NO placement and NO
appearance (off-page items have no anchor and no screenshot).

Add these two OPTIONAL top-level keys next to `pages`:

- **`segments`** — an array of `{ title, rationale }` audience segments (the
  `_block-audience-segments` output slot). Omit the key or return `[]` when the
  store warrants none.
- **`discounts`** — an array of `{ title, audience, discountRate, rationale }`
  campaigns (the `_block-discount-specs` output slot). Omit the key or return `[]`
  when the store warrants none.

The full whole-store object is therefore:

```json
{
  "pages": {
    "Home": { "boxes": [ /* … */ ] },
    "Cart": { "boxes": [ /* … */ ], "progressBar": { /* … */ } }
  },
  "segments": [
    {
      "title": "Potential Buyers",
      "rationale": "Browsers who haven't purchased yet — the core audience for a first-visit apparel store."
    },
    {
      "title": "Repeat Customers",
      "rationale": "The store's returning shoppers, worth their own targeting for loyalty offers."
    }
  ],
  "discounts": [
    {
      "title": "Frequently Bought Together",
      "audience": "Potential Buyers",
      "discountRate": 10,
      "rationale": "A 10% bundle nudge on the FBT box to lift first-order value."
    }
  ]
}
```

### Store-wide output rules

1. **`segments` / `discounts` are STORE-WIDE, not per-page.** They sit next to
   `pages` at the top level, never inside a page's plan. A page's plan carries
   only `boxes` (+ the Cart-only `progressBar`).
2. **Each `segments` item** is `{ title, rationale }` — `title` from the segment
   vocabulary (the lib resolves it to a real segment template), `rationale` one
   short sentence. No other keys.
3. **Each `discounts` item** is `{ title, audience, discountRate, rationale }` —
   `title` from the campaign vocabulary, `audience` naming one of the `segments`
   you proposed (or an already-active audience), `discountRate` a number or
   `null` (template default), `rationale` one short sentence. No other keys.
4. **Tie discounts to segments you proposed.** A campaign's `audience` must be a
   population this store has — one of your `segments` titles or an active
   audience. Never offer a discount for an audience the store lacks.
5. **Both are OPTIONAL and FOCUSED.** Omit a key entirely (or return `[]`) when
   the store warrants nothing; propose a small high-value set, never every
   template. These additions never change the `pages` plan — the on-page boxes +
   Cart `progressBar` are decided exactly as before.
