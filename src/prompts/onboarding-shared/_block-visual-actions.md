## Store-wide visual actions

The same completion that plans/reviews the pages may return OPTIONAL top-level
`visualActions`. These are part of the same visual revision: the conductor
sanitizes them, materializes them atomically with page actions, renders once,
and includes the result in the next visual review.

### Currency format

Inspect real visible product prices across the supplied screenshots. Emit at
most one currency action:

- Prefer deterministic `CURRENCY EVIDENCE.candidates` when one exactly matches
  the visible format:
  `{ "action":"setCurrencyFormat", "args":{ "candidateId":"CAD:money_with_currency" } }`.
- When candidates are absent or none matches, infer the documented format from
  pixels and emit:
  `{ "action":"setCurrencyFormat", "args":{ "format":{ "currencyCode":"CAD", "prefix":"$", "suffix":" CAD", "separator":",", "delimiter":".", "decimalDigits":2 } } }`.
  `currencyCode` may be omitted only when `activeCurrency` is supplied. Use an
  ISO 4217 three-letter code when present; never guess a code contradicted by
  `activeCurrency`. `separator` is the thousands separator; `delimiter` is the
  decimal separator and MUST be empty when `decimalDigits` is 0.
- Omit the action when no price is legible enough to decide safely. Never emit
  both candidate and explicit format in one action.

### Scoped advanced CSS

Appearance properties are preferred. When they cannot express a visible design
requirement, emit managed component/page-scoped CSS:

```json
{
  "action": "advancedCss",
  "args": {
    "operation": "upsert",
    "page": "Product",
    "boxType": "BoughtTogether",
    "rules": [
      { "selector": "& .ls-box-title", "declarations": "letter-spacing: 0.02em" },
      { "selector": "& .ls-product-card", "declarations": "gap: 8px", "media": "(max-width: 749px)" }
    ]
  }
}
```

Every selector MUST start with `&`; `&` is replaced by the conductor's concrete
LimeSpot component scope. Declarations only: no braces or at-rules. `media`, when
needed, is exactly `(min-width: Npx)` or `(max-width: Npx)`. To remove a prior
managed block, emit `{ "action":"advancedCss", "args":{ "operation":"remove",
"page":"Product", "boxType":"BoughtTogether" } }`. Never target merchant/theme
elements, global selectors, or unscoped page CSS.

Return `visualActions: []` when no visual action is needed. In review, inspect
all independent visual defects exhaustively in the current revision and emit
every safe action together; do not drip one correction per round. Use the prior
history to avoid repeating an ineffective action with slightly different
numbers. A page cannot pass if a visual action changes it in this revision.
