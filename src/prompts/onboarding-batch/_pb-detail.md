**Include it only when it fits.** Add the progress bar on the Cart page when a threshold nudge makes sense for this store (the common case). If the Cart page already shows a visible threshold / progress bar in the images, or a bar would not help this store, omit it. On a non-Cart page — and on Cart when you choose not to add one — simply leave the `progressBar` key OUT (or set it to `null`).

### Best-practice page stacks (the LimeSpot playbook — adapt to the store)

Boxes are CAROUSELS unless stated otherwise. Each page's stack below is the DEFAULT — include EACH listed box for that page unless the page plainly warrants otherwise. Recently Viewed is the standard closer: always the LAST strip, at the very bottom of the page above the footer (empty in preview, fills in for real shoppers). Keep the page's most prominent strip CATALOG-backed so the preview shows products; a data-dependent box (Frequently Bought Together / Upsell) degrades gracefully for real shoppers via its configured fallback.

- **Home** — **Most Popular** right after the hero (or right after the store/collection intro section when one directly follows the hero); **You May Like** mid-page, one or two sections below Most Popular (audience-gated by the lib: hidden for first-time visitors); **Recently Viewed** at the bottom, above the footer.
- **Product** — **Frequently Bought Together** as a bundle right below the product details + price and ABOVE any reviews list (falls back to Cross-sell); **Related Items** directly below the FBT bundle; **Recently Viewed** at the end.
- **Collection** — **Most Popular** scoped to this collection, at the top of the collection page; **Recently Viewed** at the end.
- **Cart** — the Smart Progress Bar at the very top; **Upsell** as a slider ABOVE the cart contents (ordered by popularity; hides when it has nothing to show); **Frequently Bought Together** BELOW the cart contents (order summary + checkout button), falling back to Cross-sell; **Related Items** directly after the FBT strip; **Recently Viewed** at the end.
- **SlidingCart** — **Frequently Bought Together** in rows style, capped at 2 products, below the drawer's cart content (falls back to Cross-sell). Minimal — a narrow drawer stays uncrowded.
- **Search** / **Blog** — **Most Popular** or **You May Like** (primary) plus Recently Viewed (secondary), if the page exists.
