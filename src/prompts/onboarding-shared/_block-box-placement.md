## Box placement — INSERT at an anchor (additive ONLY; never remove or replace store content)

You decide WHERE each recommendation box goes. Placement is ADDITIVE: every box
is INSERTED at an existing boundary, and everything the store already renders
STAYS exactly where it is. You never remove, replace, or displace a merchant
section — not a grid, not a banner, not an empty-looking block.

### The numbered candidates (ONE continuous sequence)

Each page's images carry numbered markers painted as a translucent overlay:
badges `+1`, `+2`, `+3` … `+N`, ONE number per candidate, numbered top →
bottom (a LOW number is high on the page; the last numbers sit at the footer).
Each number carries a TYPE, shown by its legend colour AND stated in the
per-page manifest:

- **INSERT anchors (violet)** — an existing section boundary (a hero, a
  product-details block, a category grid, the footer). You place a NEW box
  `"before"` or `"after"` this boundary; the existing section stays in place.
- **REFERENCE candidates (green, manifest `type: "replace"`)** — an existing
  STATIC product grid / carousel the store already renders. These are
  READ-ONLY EVIDENCE: treat one as a boundary to insert `"before"`/`"after"`
  and as the ideal style reference (below). You NEVER REPLACE it — never emit
  `position: "replace"` for ANY number; the merchant's own grid always stays
  on the page.

### Insert at a boundary

Name the boundary by its `anchorNumber` and set `position` to `"before"` or
`"after"`. The box is added at that boundary; the existing section stays in
place. Use the top→bottom numbering deliberately: a top-of-page box takes an
EARLY number, and only the page's closing strip sits at the last boundaries.

### Reference-style slot (make the box look native)

The BEST way to make a box native is to CLONE the appearance of one of the
store's existing product blocks — its own product grid or carousel — because
the system reads that block's REAL styling straight off the page (card
corners, spacing, image size, title/price/CTA colours + fonts, arrows) far
more faithfully than you can describe it. For each box, return a CSS
`styleReferenceSelector` for the store's most-representative product
grid / carousel to clone from (e.g. `".product-grid"`, `"ul.grid--collection"`,
`".featured-collection .slider"`). A green reference candidate is ideal: use
its manifest `selector` as the box's `styleReferenceSelector` (its `outerHTML`
grounds the clone precisely) while the box itself inserts at a boundary. Fall
back to the full `appearancePatch` only when no good reference block exists.

### Per-number manifest (VARIABLE per-shop data — never in the cached prefix)

The per-page manifest names every numbered candidate and its
`type: "insert"` | `"replace"`. INSERT anchors are just a boundary and need no
extra data. Green reference candidates
carry more context — keyed by that candidate's number — their
`type: "replace"` marker, their **outerHTML** (the block's structure +
product-card markup that grounds the style clone), and a reference `selector`.
Read that `outerHTML` to understand what the store already shows and to ground
a box's style clone; the `type: "replace"` marker is capture metadata, NOT an
instruction — your `position` is always `"before"` or `"after"`. This
per-number payload is per-shop VARIABLE data: it rides AFTER the
cache breakpoint with the screenshots + the manifest, never in this stable
cached system prefix.
