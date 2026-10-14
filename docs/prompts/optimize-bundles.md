# Optimization: Bundle Discounts step — Maintenance Doc

The design/maintenance record for `optimize-bundles`, the last of the Optimization conductor's four steps. Its system text is composed in [`src/prompts/optimize-bundles/index.ts`](../../src/prompts/optimize-bundles/index.ts) and registered in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). What the four steps share is in [optimize-boxes.md → The four steps](optimize-boxes.md#the-four-steps), and its input and output follow the per-audience offers contract in [optimize-progress-bar.md → Per-audience offers](optimize-progress-bar.md#per-audience-offers-shared-with-optimize-bundles).

## Purpose

The step sets bundle discounts per audience, for the audiences whose facts show they answer offers, such as orders that used one of LimeSpot's offers in the period. It is the Discounts & Promotions Agent's area, beside the Progress Bar. lib builds each audience's bundle options from Brain's bundle templates with the discount rate Brain learned from the store's own discounted orders, or LimeSpot's default, which the summary calls a starting rate, or a rate the owner typed, which the summary calls the rate the owner asked for. An audience given a Progress Bar, in the draft or live, carries `takenBy: "progress-bar"` and gets no bundle, so no audience gets both. With no product holding bundle picks the step offers nothing and says that bundles need picks first.

## Input (beside the per-audience members)

| Member      | Shape                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| options     | each `{ optionKey, label, templateKey, templateName, discountRate }`                                 |
| `picks?`    | `{ productsWithPicks }`, the products that have bundle picks to offer                                |
| `requests?` | `[{ headline, summary }]`, Google Ads promotion requests the Google Ads & Audiences step routed here |

## Output

The per-audience offers shape, unchanged.

## Pinning tests

[`test/optimization-prompts.test.ts`](../../test/optimization-prompts.test.ts) pins the composed text against `test/__snapshots__/optimize-bundles.baseline.md`, its composition and route, its output example, the per-audience rules and the `takenBy: "progress-bar"` rule.
