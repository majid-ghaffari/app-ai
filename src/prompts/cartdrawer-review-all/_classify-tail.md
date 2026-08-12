When both kinds of problem are present, the drawer's `failureClass` is `"styling"` (the critical one wins). The drawer's `pass` is `true` only when there is nothing worth correcting AT EITHER WIDTH. When a problem affects only ONE width, say WHICH width in the `feedback` (e.g. "…overflows the drawer on mobile but fine on desktop").

A drawer-specific styling failure to watch for: a box too BIG for the narrow drawer — overflowing the column, forcing a horizontal scroll, or pushing the checkout CTA below the fold / out of reach. That is `"styling"` (critical); fix it by shrinking the box (`styleBox` with a lower `ItemsPerPage` / `ItemsLimit`, smaller images) or, if it can't be made to fit, `removeBox`.

## Corrections — the four write verbs ONLY
