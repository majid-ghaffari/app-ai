# Optimization: Progress Bar step — Maintenance Doc

The design/maintenance record for `optimize-progress-bar`, the third of the Optimization conductor's four steps, and the home of the per-audience offers contract it shares with [`optimize-bundles`](optimize-bundles.md). Its system text is composed in [`src/prompts/optimize-progress-bar/index.ts`](../../src/prompts/optimize-progress-bar/index.ts) and registered in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). What the four steps share is in [optimize-boxes.md → The four steps](optimize-boxes.md#the-four-steps).

## Purpose

The step sets the cart Progress Bar per audience: each audience's goal and its reward (free shipping or a discount). It is the Discounts & Promotions Agent's area, which lib runs beside the other specialists and checks on screen after it applies. lib builds each option from one of Brain's Progress Bar templates (`GET v2/progress-bar-campaigns/templates`) and sizes its goal to that audience's own orders; a discount uses the rate Brain learned from the store's own discounted orders (`GET v2/agents/store-figures`, `DiscountRate`), or LimeSpot's default when the store has too few, which the step's summary calls a starting rate the owner can change; a rate the owner typed in the step's notes replaces both, and the summary calls it the rate the owner asked for. The step chooses one option per audience the facts support, writes why and what it is based on, and leaves the rest out with a reason. An audience that already has a bundle discount it keeps carries `takenBy: "bundles"`, so no audience gets both; an audience whose facts show it buys through LimeSpot's bundle offers may be left for the Bundle Discounts step. A promotion request the Google Ads & Audiences step sent here is named in the reason of the offer that carries it.

## Per-audience offers (shared with `optimize-bundles`)

The block is `optimization-shared/_per-audience-offers.md`.

### Input (beside the shared members)

| Member          | Shape                                                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audiences`     | `[{ audienceKey, title, facts, eligible, ineligibleReason?, takenBy?: "progress-bar" \| "bundles", options: [{ optionKey, label, templateKey, templateName, ... }] }]`; `eligible` and `ineligibleReason` are lib's, from the data it has (for example too few orders); every option names the Brain template it starts from |
| `everyoneElse?` | the same members for shoppers in no listed audience; absent when lib built nothing for them                                                                                                                                                                                                                                  |
| `current`       | `[{ label, audienceKey? }]`, the offers of this kind the store runs today; no `audienceKey` targets everyone                                                                                                                                                                                                                 |
| `requests?`     | `[{ headline, summary }]`, Google Ads promotion requests the Google Ads & Audiences step routed here                                                                                                                                                                                                                         |
| `discountRate`  | `{ percent, source: "orders" \| "default" \| "owner", discountedOrders? }`, the rate the discount options use: learned from the store's own discounted orders (`orders`, with how many were read), LimeSpot's default (`default`), or typed by the owner in the step's notes (`owner`)                                       |

### Output

```json
{
  "headline": "...",
  "summary": "...",
  "offers": [
    { "audienceKey": "returning-buyers", "optionKey": "rb-1", "reason": "...", "basedOn": "..." }
  ],
  "everyoneElse": { "optionKey": "ee-1", "reason": "...", "basedOn": "..." },
  "leaveOut": [{ "audienceKey": "first-time-visitors", "reason": "..." }],
  "basedOn": "...",
  "question": "..."
}
```

- Every audience appears once, in `offers` (one of its own `optionKey`s) or in `leaveOut` with its reason; an audience that is `eligible: false` or carries `takenBy` is always left out.
- `everyoneElse` is an offer only when its `eligible` is true and its facts support one, otherwise `null`.
- An offer replaces the `current` offer for the same audience, and `everyoneElse` the one for everyone; the reason says so.
- When a chosen offer gives a discount and `discountRate.source` is `default`, the summary says the rate is a starting rate the owner can change; a reason that names a rate learned from `orders` says it is the usual discount on the store's own discounted orders; when the source is `owner`, the summary says the rate is the one the owner asked for, never one learned from the store's orders or a starting rate.
- The step chooses only among the options and names a template in words by its `templateName`.
- Each offer's `basedOn` names the facts it rests on and the period.
- `offers` and `leaveOut` are always present.

## Progress Bar options

Each option carries `templateKey`, `templateName`, `goal`, `currencyCode`, `reward` (`FreeShipping` | `Discount`) and, for a discount, `discountRate`. lib owns the goals; the step never proposes an amount.

## Pinning tests

[`test/optimization-prompts.test.ts`](../../test/optimization-prompts.test.ts) pins the composed text against `test/__snapshots__/optimize-progress-bar.baseline.md`, its composition and route, its output example, the per-audience rules, the template options, and the wording for each discount-rate source lib sends (`orders`, `default` and `owner`), against a fixture of each.
