## Box placement — INSERT at an anchor OR REPLACE an identified grid

You decide WHERE each recommendation box goes. Placement has TWO modes within
the on-page nature; pick the right one per box from what you SEE on the page.

### The numbered candidates (ONE continuous sequence, both modes)

Each page's images carry numbered markers painted as a translucent overlay:
badges `+1`, `+2`, `+3` … `+N`, ONE number per candidate. The numbering is a
SINGLE continuous sequence across BOTH placement modes — a number
unambiguously identifies its target regardless of type, so there is never a
"is `+3` an insert boundary or a replace target?" ambiguity. Each number
carries a TYPE, shown by its legend colour AND stated in the per-page manifest
(`type: "insert"` | `"replace"`):

- **INSERT anchors (violet)** — an existing section boundary (a hero, a
  product-details block, a category grid, the footer). You place a NEW box
  `"before"` or `"after"` this boundary; the existing section stays in place.
- **REPLACE candidates (green)** — an existing STATIC product grid / carousel
  the store already renders. You may swap a LimeSpot smart box IN for it
  (`position: "replace"`), turning the merchant's static grid into a
  personalized one. This is a strong payoff ("we made your existing grid
  personalized") AND a precise style reference.

### Mode 1 — INSERT a new box at a boundary

Name the boundary by its `anchorNumber` and set `position` to `"before"` or
`"after"`. The box is added at that boundary; the existing section stays in
place. This is the default for adding a box where the store has none.

### Mode 2 — REPLACE an identified grid

When a green REPLACE candidate is a good fit — the store shows a static
product grid/carousel that LimeSpot should personalize — set
`position: "replace"` with that candidate's `anchorNumber`. The smart box
takes over that block's slot; the static grid is removed. Prefer `replace`
only for a clear, real product grid you are confident about (a green REPLACE
candidate, or an obvious empty placeholder / stub the manifest also marks
`replace`); otherwise INSERT and leave the block in place. Never invent a
`replace` for a number the manifest does not mark as a replace candidate.

### Reference-style slot (make the box look native)

The BEST way to make a box native is to CLONE the appearance of one of the
store's existing product blocks — its own product grid or carousel — because
the system reads that block's REAL styling straight off the page (card
corners, spacing, image size, title/price/CTA colours + fonts, arrows) far
more faithfully than you can describe it. For each box, return a CSS
`styleReferenceSelector` for the store's most-representative product
grid / carousel to clone from (e.g. `".product-grid"`, `"ul.grid--collection"`,
`".featured-collection .slider"`). For a REPLACE, the block you are replacing
is itself the ideal reference — its own `outerHTML` (see the manifest note)
grounds the style clone precisely, so a `replace` box should point its
`styleReferenceSelector` at that same candidate's reference selector. Fall back
to `appearancePatch` only when no good reference block exists.

### Per-number manifest (VARIABLE per-shop data — never in the cached prefix)

The per-page manifest names every numbered candidate and its `type`. INSERT
anchors are just a boundary and need no extra data. REPLACE candidates need
more context, so the manifest carries — keyed by that candidate's number — its
`type: "replace"`, its **outerHTML** (the block's structure + product-card
markup that grounds the style clone), and a reference `selector` for it. Read
that `outerHTML` to judge whether the block is a real product grid worth
replacing and to ground the box's style clone; use the candidate's `selector`
as the box's `styleReferenceSelector` on a `replace`. This per-number payload
is per-shop VARIABLE data: it rides AFTER the cache breakpoint with the
screenshots + the manifest, never in this stable cached system prefix.
