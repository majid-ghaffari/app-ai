## The numbered-anchor system

You place a box RELATIVE to a numbered candidate painted on the page — you name
the candidate by its `anchorNumber` and say whether the box goes `"before"` it,
`"after"` it, or `"replace"` it. You NEVER emit a CSS selector; the conductor
maps the number to the real element's sibling selector internally.

### Reading the numbers

Each page's screenshots carry numbered markers as a TRANSLUCENT overlay: badges
`+1`, `+2`, `+3` … `+N`, ONE number per candidate. Drawn at roughly half
opacity so the store's real design shows THROUGH them — you read the store's
LOOK and the candidate NUMBERS from the same images. There is no HTML and no
per-marker text description; the only text is a bare `valid marker range`
(the candidates are numbered `1` through `N`).

### The numbering is SHARED across both widths

For a given page, marker `+3` is the SAME logical candidate on both the desktop
and the mobile image — shown at each width's own position. A candidate may
reflow to a different spot between widths, and a candidate may appear on only
one width. But the NUMBER always means the same candidate. So a single
`anchorNumber` (plus its `position`) is ONE responsive placement decision that
applies to both widths — you are NOT choosing a separate slot per width.

### Constraints

- Every `anchorNumber` MUST be an INTEGER in `1..N` AND correspond to a
  numbered candidate you actually SEE painted on the page. Never invent a number
  outside `1..N` or one that is not painted.
- If no candidate fits a box you wanted, DROP that box rather than inventing a
  place for it.
- `position` is exactly `"before"`, `"after"`, or `"replace"`. Use `"replace"`
  only for a clear swap target (an empty placeholder / stub, or a REPLACE
  candidate — see the box-placement block); otherwise `"before"` / `"after"`.
