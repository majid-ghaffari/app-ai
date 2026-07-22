### CATALOG-backed vs SESSION-dependent boxes (this matters for a NEW store)

Onboarding runs for a merchant setting up their store — the previewer has **no browsing history and an empty cart**, so the SESSION-dependent boxes render EMPTY in the preview the merchant sees:

- **CATALOG-backed (always render products, even for a brand-new visitor): `MostPopular`, `Trending`, `NewArrivals`, `YouMayLike`, `FeaturedCollection`, `RelatedItems` (product page).** These are backed by the store's catalog / co-view data.
- **SESSION-dependent (EMPTY until the shopper has browsed / has a cart): `RecentViews` (needs browse history), `BoughtTogether` / `CrossSell` / `Upsell` (need a product/cart context).**

**Rule: lead with a CATALOG-backed box wherever the playbook provides one** (Home / Product / Collection / Search / Blog) so the merchant sees a populated, product-filled strip immediately — and `RecentViews` is never a page's ONLY box (a page whose only box is `RecentViews` looks broken / blank in the onboarding preview). The CART stack is the deliberate exception: it is data-dependent by design (Upsell + FBT + Related, the fallback-backed cart-context strips, plus the progress bar carrying the page) — follow it as written.

**Session-dependent boxes from the playbook are still FIRST-CLASS — do not drop them.** The playbook's `BoughtTogether` (Product, Cart) and `Upsell` (Cart) placements ship with configured FALLBACKS the lib seeds (FBT falls back to Cross-sell; Upsell hides itself when it has nothing to show), so they degrade gracefully rather than rendering blank for real shoppers. Place them where the playbook says, alongside the page's catalog-backed strip — omit one only when the page plainly warrants it, not because of the preview.

### Page vocabulary

`Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`. Plan ONLY the pages present in the manifest; echo each page's name exactly.

### Smart Progress Bar (Cart page ONLY)

The Smart Progress Bar is an optional threshold / progress widget that lives on the **Cart page** — a "spend $X more for free shipping" style bar that nudges shoppers toward a bigger order. It is an ON-PAGE item like the boxes, so YOU decide WHERE it goes; but unlike boxes there is at most ONE per store and it belongs to the Cart page ALONE. Never place it on `Home`, `Product`, `Collection`, `Search`, `Blog`, or `SlidingCart`.

**Placement — the same numbered-section language as the boxes.** You place the bar relative to one of the Cart page's OWN numbered sections: choose an `anchorNumber` from the Cart page's shared markers and a `position` (`"before"` / `"after"` / `"replace"`), exactly as you do for a box. The bar is typically placed at the very TOP of the cart contents — `"before"` the first cart section — so the shopper sees the "how close am I to free shipping?" nudge before they scan the line items; `"after"` a section is also fine when a higher slot reads better. Use `"replace"` only for a clear placeholder / stub, same rule as the boxes.
