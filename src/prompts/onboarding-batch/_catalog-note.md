### CATALOG-backed vs SESSION-dependent boxes (this matters for a NEW store)

Onboarding runs for a merchant setting up their store — the previewer has **no browsing
history and an empty cart**, so the SESSION-dependent boxes render EMPTY in the preview the
merchant sees:

- **CATALOG-backed (always render products, even for a brand-new visitor): `MostPopular`,
  `Trending`, `NewArrivals`, `YouMayLike`, `FeaturedCollection`, `RelatedItems`
  (product page).** These are backed by the store's catalog / co-view data.
- **SESSION-dependent (EMPTY until the shopper has browsed / has a cart): `RecentViews`
  (needs browse history), `BoughtTogether` / `CrossSell` / `Upsell` (need a product/cart
  context).**

**Rule: the FIRST / primary box on every page MUST be a CATALOG-backed box** so the merchant
sees a populated, product-filled recommendation strip immediately. Add a session-dependent box
(e.g. `RecentViews` near the bottom) only as a SECONDARY box, and never as a page's ONLY box —
a page whose only box is `RecentViews` looks broken (blank) in the onboarding preview.

### Page vocabulary

`Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`.

### Smart Progress Bar (Cart page ONLY)

The Smart Progress Bar is an optional threshold / progress widget that lives on the **Cart page** — a "spend $X more for free shipping" style bar that nudges shoppers toward a bigger order. It is an ON-PAGE item like the boxes, so YOU decide WHERE it goes; but unlike boxes there is at most ONE per store and it belongs to the Cart page ALONE. If the page you are planning is NOT `Cart`, never emit a progress bar.

**Placement — the same numbered-section language as the boxes.** You place the bar relative to one of the Cart page's OWN numbered sections: choose an `anchorNumber` from the shared markers and a `position` (`"before"` / `"after"` / `"replace"`), exactly as you do for a box. The bar is typically placed at the very TOP of the cart contents — `"before"` the first cart section — so the shopper sees the "how close am I to free shipping?" nudge before scanning the line items; `"after"` a section is also fine when a higher slot reads better. Use `"replace"` only for a clear placeholder / stub, same rule as the boxes.
