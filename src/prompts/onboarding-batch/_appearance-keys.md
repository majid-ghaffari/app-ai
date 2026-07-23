- **`Style`** — the layout: `"carousel"` | `"grid"` | `"bundle"` | `"rows"` | `"slider"` (`"bundle"` is the Frequently-Bought-Together bundle layout).
- **`ItemsPerPage`** — number of cards shown per row / page. MATCH the store's own cards-per-row — count the cards in its product/collection grids in the screenshots.
- **`ImageMaxHeight`** — px cap on the card image height. Set ≈ the store's own card-image height when this catalog's natural images run taller than the store's cards (keeps our cards from towering over the theme's).
- **`ItemsLimit`** — total number of products the box pulls.
- **`ImageBorderRadius`** — image corner radius in px (0 for square-cornered stores; a small value like 8 for rounded).
- **`NavigationArrowType`** — the carousel arrow SHAPE: `"chevron"` | `"circleChevron"` | `"circleFull"` | `"circleArrow"` | `"strikingChevron"`. MATCH the store's own slider arrows as SEEN in the screenshots (a chevron inside a circular border = `"circleChevron"`; a bare chevron = `"chevron"`); when the store shows no slider arrows of its own, DEFAULT to `"circleChevron"`.
- **`Default.QuickActions.AddToCart`** — a CSS-declaration map for the card's Add-to-cart button, cloned from the STORE'S OWN primary button as seen in the screenshots (its Add to cart / View all): e.g. `{ "background-color": "#121212", "color": "#ffffff", "border-radius": "0px" }`. The box's button must read as the store's button.
- **`Default.NextPrev`** — a CSS-declaration map for the carousel arrow buttons when the store's arrows carry visible styling (border, background) to match.
- **`Default.Title`** — a CSS-declaration map for the box heading. ALL boxes on ALL pages share ONE title style — clone the store's own section-heading typography (font family / size / weight / case as seen in the screenshots) and emit the SAME map on every box.
- **`ExtraClasses`** — the theme's own content-wrapper class(es), copied VERBATIM from the page's section wrappers (read them off a green candidate's `outerHTML`, e.g. `page-width`) — this puts the box in the same gutter/max-width as the sections around it. Class tokens only, never invented.

These keys are the box's DESKTOP-and-shared styling — they apply at both widths unless a mobile override below changes them.
