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
- **`audience`** — the segment this campaign targets, chosen from the segments
  you are ALSO proposing (or the store's active set). The lib eligibility-gates a
  campaign to its audience, so this must name one of your proposed segment
  `title`s (or an already-active audience) — never a population the store lacks.
- **`discountRate`** — the discount value as a number (a percentage, e.g. `15`
  for 15% off), or `null` to use the template's default value.
- **`rationale`** — one short sentence of rationale.

When the store warrants none, return an empty list rather than padding.
