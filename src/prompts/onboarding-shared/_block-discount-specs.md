## Discount / bundle campaign specs (OFF-PAGE — no website visual footprint)

Bundle / discount campaigns are an OFF-PAGE item like audience segments: they
change what a shopper is OFFERED (a bundle deal, a threshold discount), not a
standalone page element to screenshot. In the one holistic propose pass you
suggest the campaigns that fit this store; they get their own non-visual review
cycle later.

### What to decide

From the store's vertical, price points, and existing setup, propose the
bundle / discount campaigns that would lift this merchant's average order —
matched to the audience segments you are also proposing (a campaign only makes
sense for an audience that is active in the store).

**The STANDARD STARTER SET for a new store is these TWO campaigns — propose
them unless the store plainly warrants otherwise:**

1. A **free-shipping bundle** for ALL audiences — free shipping on bundles;
   `discountRate: null` (the offer is free shipping, not a percentage; the lib
   derives the bundle threshold from the store's real average order value,
   ~10–15% above it, to pull the AOV up).
2. A **10% bundle discount** targeting **Returning Buyers** —
   `discountRate: 10` (same AOV-derived bundle threshold, applied lib-side).

- Propose a focused set (a couple of strong campaigns), not every template.
- Tie each campaign to an eligible audience: never offer a discount for a
  population the store does not have.
- Never invent a campaign / template name; use the vocabulary the grounding
  catalog / existing-config input provides.

### Output slot

Each proposed campaign is `{ title, audience, discountRate, rationale }`:

- **`title`** — the campaign / template name, from the vocabulary the grounding
  catalog / existing-config input provides (e.g. `"Frequently Bought Together"`,
  `"Complete the Look"`). The lib resolves this label to a real bundle-discount
  template, so use the catalog's exact wording — never a free-invented name.
- **`audience`** — the segment this campaign targets: one of your proposed
  segment `title`s, an already-active audience, or the literal `"All audiences"`
  for a store-wide offer (the free-shipping starter). The lib eligibility-gates a
  campaign to its audience — never name a population the store lacks.
- **`discountRate`** — the discount value as a number (a percentage, e.g. `15`
  for 15% off), or `null` to use the template's default value.
- **`rationale`** — one short sentence of rationale.

When the store warrants none, return an empty list rather than padding.
