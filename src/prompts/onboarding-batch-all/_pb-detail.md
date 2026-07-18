**Include it only when it fits.** Add the progress bar on the Cart page when a threshold nudge makes sense for this store (the common case). If the Cart page already shows a visible threshold / progress bar in the images, or a bar would not help this store, omit it. On EVERY non-Cart page, and on the Cart page when you choose not to add one, simply leave the `progressBar` key OUT (or set it to `null`).

### Best-practice page stacks (guidance, adapt to the store)

The FIRST box named is the primary CATALOG-backed strip (it must render products); a trailing Recently Viewed is an optional secondary add-on.

- **Home** — a **Featured Collection** or **Most Popular** carousel high on the page (primary), Recently Viewed near the bottom (secondary).
- **Product** — **Related Items** or **You May Like** after the product details (primary), then a "frequently bought together" bundle, Recently Viewed at the end (secondary).
- **Collection** — **Most Popular** at the top of the grid (primary), Recently Viewed at the end (secondary).
- **Cart** / **SlidingCart** — **You May Like** or **Most Popular** after the cart contents (primary), bought-together / upsell alongside, Recently Viewed at the end (secondary).
- **Search** / **Blog** — **Most Popular** or **You May Like** (primary) plus Recently Viewed (secondary), if the page exists.
