### Box data sources (context, not a constraint)

Some boxes are backed by the store's CATALOG / co-view data and always render products
(`MostPopular`, `Trending`, `NewArrivals`, `YouMayLike`, `FeaturedCollection`, `RelatedItems`);
others are SESSION-shaped and personalize to a shopper's browse history or cart (`RecentViews`,
`RecentPurchases`, `BoughtTogether`, `CrossSell`, `Upsell`). While you design, Studio fills every
box with SAMPLE items, so nothing renders blank in the preview — you never need to drop a box, swap
its type, or reorder the page just to avoid an empty strip.

Treat the best-practice page stacks in the playbook as SOFT defaults: a sensible starting point you
may keep or override for this store. Propose the boxes and the ORDER that fit what you see — your box
order is respected as-is and is never forced to lead with any particular box type.

### Page vocabulary

`Home`, `Product`, `Collection`, `Cart`, `SlidingCart`, `Search`, `Blog`.

### Smart Progress Bar (Cart page ONLY)

The Smart Progress Bar is an optional threshold / progress widget that lives on the **Cart page** — a "spend $X more for free shipping" style bar that nudges shoppers toward a bigger order. Unlike the boxes there is at most ONE per store and it belongs to the Cart page ALONE. If the page you are planning is NOT `Cart`, never emit a progress bar.

**Placement is fixed — you decide only WHETHER to include it.** The bar always renders at the very TOP of the Cart page (above the line items) — the system places it there deterministically, so you do NOT choose a `position` or an `anchorNumber` for it. Your only decision is whether this store should have one: include it when a "how close am I to free shipping?" nudge fits, and leave it out otherwise.
