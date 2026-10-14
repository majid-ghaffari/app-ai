# Optimization: Recommendation Boxes step — Maintenance Doc

The design/maintenance record for `optimize-boxes`, the first of the Optimization conductor's four steps, and the home of what the four steps share. Its system text is composed in [`src/prompts/optimize-boxes/index.ts`](../../src/prompts/optimize-boxes/index.ts) and registered as `optimize-boxes` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). The authoring/iteration process is [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## The four steps

The Optimization conductor runs in lib: it owns the conversation with the owner, the details beside the chat, the fixed order of the areas, the buttons that keep a step in the draft or skip it, and every write to the Studio draft. Specialist agents do each area's work and lib starts them side by side early in the run: the Merchandising Agent places the recommendation boxes through Studio's single-page screenshot pipeline (`optimize-demand`, the render review and bounded corrections), with the Upsell & Cross-sell Agent's picks; the Google Ads Agent and the Audiences Agent, Brain agents, report on the ads and the audiences; the Discounts & Promotions Agent owns the Progress Bar and Bundle Discounts offers; and the Look & Feel Agent matches LimeSpot's boxes to the store's theme through onboarding's style-match prompts (`probe-style`, `onboarding-css-review`, `visual-verify`). app-ai holds one one-shot `/messages` prompt per area whose words the owner reads, and keeps no state:

| Order | Area                   | Prompt                                                | Answers                                                                    |
| ----- | ---------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| 1     | Recommendation Boxes   | `optimize-boxes`                                      | the words over the Merchandising Agent's box changes, page by page         |
| 2     | Google Ads & Audiences | [`optimize-ads-audiences`](optimize-ads-audiences.md) | audiences to add, from templates, and an answer to each Google Ads request |
| 3     | Progress Bar           | [`optimize-progress-bar`](optimize-progress-bar.md)   | one goal option per audience                                               |
| 4     | Bundle Discounts       | [`optimize-bundles`](optimize-bundles.md)             | one bundle option per audience                                             |
| 5     | Look & Feel            | none                                                  | the Look & Feel Agent's own style-match prompts; lib writes the words      |

What every step shares:

- **Code writes the numbers, the model writes the words.** lib builds every number the owner sees and every option a step can choose: the KPI tiles, the evidence table, each audience's goals sized to its own orders, the offers built from LimeSpot's templates, the discount rate Brain learned from the store's own discounted orders (or LimeSpot's default when it has too few, which the step calls a starting rate, or the rate the owner typed for the step, which the step attributes to the owner), the eligibility of each audience. The model chooses among those options by their keys and writes the words. Every figure in its words is one the request's data states; lib may check that and fall back to its own words. No step forecasts, ranks changes by expected effect, or promises a result.
- **Keys only from the data.** Every box, audience, option, template and request key a step returns is one its request carries.
- **Everything goes to the draft.** A step's plan is a set of draft changes lib applies only when the owner keeps it, or in Optimize it for me; the Recommendation Boxes changes are the Merchandising Agent's, already in the draft when the step is written, and its words say so. Nothing reaches the live store until the owner publishes.
- **The agents master rules.** Each step's words reach the owner, so each composes the agents master rules right after the shared Optimization identity, as `chat` does ([chat.md → Scope and guardrails](chat.md#scope-and-guardrails)). The conversation rules map onto the JSON: a choice neither the data nor the owner's notes settle is left out and asked about in `question`; a note the step cannot carry, or one a person should handle, gets a sentence in `summary`, pointing to Talk with Support in the Optimization chat's menu.
- **Composition**, each a composed prompt ending with one newline: `optimization-shared/_identity.md` (the Optimization agent, working for LimeSpot Assistant, its five areas in order, the specialist agent behind each, the platforms Studio serves), `assistant-shared/agents-master-rules.ts`, `optimization-shared/_step.md` (how a step works, the owner's notes, the question, and the data every step carries), `optimization-shared/_words.md` (the word fields, their lengths, placeholders, numbers and no forecasts, and how a change already in the draft is written), then the step's own fragments, then `onboarding-shared/_shared-json-tail.md`. Progress Bar and Bundle Discounts share `optimization-shared/_per-audience-offers.md`, their rules and output shape. A change to a shared block changes every step that composes it and regenerates their baselines.
- **Route:** the `optimization-conductor` group on the `balanced` tier, requiring `structuredOutput`; `usesTools: false`; no attachments; no effort set; `maxTokens` is `MODEL_MAXIMUM_OUTPUT`, the selected model's documented maximum output, as for every conductor prompt ([DECISIONS → Conductor prompts carry their model's maximum output](../DECISIONS.md#conductor-prompts-carry-their-models-maximum-output)). No step reads uploaded files, so the group has no file-reuse edge. Its data is the store's own, so the group carries customer content and in production only a provider the DPA lists may serve it ([AI-PROVIDERS.md → Routes that carry customer content](../AI-PROVIDERS.md#routes-that-carry-customer-content)). Each call is one turn with no continuation, earlier assistant turn or caller tools, so a route that serves one turn can serve it.

### Request (every step)

`POST {base}/messages` with `X-Personalizer-System-Prompt: <step>`. The body is a standard messages payload with no `model`: one user message whose content is a text block holding the step's data as JSON, followed by a short trigger text block such as "Plan this step." The data is per-store and rides after the cached system prefix. lib may send `"responseMode": "keep-alive"`, as for every `/messages` call. Every step's data carries:

| Member              | Shape                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store`             | `{ platform, industry, currencyCode, averageOrderValue? }`                                                                                                                                                       |
| `window`            | `{ days, fromUtc, toUtc }`, the period the data covers                                                                                                                                                           |
| `helpers`           | `[{ key, title, freshness: "Fresh" \| "Stale" \| "Missing", headline?, summary?, completedAtUtc?, facts?, notices? }]`, the latest results of the agents working for Optimization on this step, as lib read them |
| `ownerNotes?`       | `string[]`, what the owner typed during this step, oldest first; lib calls the step again with them                                                                                                              |
| facts, where listed | `{ label, value, unit, currencyCode? }`, as lib shows them                                                                                                                                                       |

### Response (every step)

One JSON object, its members per step below. The word fields are `headline` (at most 80 characters), `summary` (at most 500, the chat message that opens the step, every change written as one the agent would make), `basedOn` (one line: what the plan reads, the period and the helper agents by title, with a stale result's date), `question` (present only when the step asks one) and each `why` and `reason` (one sentence). lib parses tolerantly and applies its bounded repair retry, as for the other conductor steps.

## `optimize-boxes`

The Merchandising Agent has already put its box changes in the draft and checked the pages on screen when lib calls this step; the step writes what the owner reads about them and plans nothing. lib keeps the After layout, the drag and Save order, the typed moves and taking the changes back out.

### Input (beside the shared members)

| Member     | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages`    | `[{ page: "Home" \| "Product" \| "Collection", before: [{ box, boxType, title }], after: [{ box, boxType, title, change: "added" \| "moved" \| "kept" }], why }]`, each page the Merchandising Agent worked on: its LimeSpot boxes top to bottom as the live page shows them, then as the draft holds them, and the agent's own reasons. `box` is the box's key in the draft's `HostPages[page].Boxes` (`Popular`, `FeaturedCollection2`); `boxType` is its name in the shared box vocabulary (`MostPopular`, `FeaturedCollection`). A `before` box missing from `after` was taken off |
| `evidence` | `{ caption, columns, rows }`, the evidence table lib shows beside the step, such as each box's times shown and clicks in the period                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `picks?`   | `{ productCount }`, the Upsell & Cross-sell Agent's ready AI picks and the number of products they cover (Brain's `PicksReady` `ProductCount`); they go beside the owner's own picks, lib includes them in this step's changes and the summary names them                                                                                                                                                                                                                                                                                                                              |

### Output

```json
{
  "headline": "...",
  "summary": "...",
  "pages": [
    { "page": "Product", "why": "..." },
    { "page": "Home", "why": "..." },
    { "page": "Collection", "why": "..." }
  ],
  "basedOn": "...",
  "question": "..."
}
```

- `pages` holds every page the request sent, once, in its order, each with only `page` and `why`: no change list, box key or position.
- The words describe only the changes the data shows (an `added` or `moved` box, or one taken off), as the Merchandising Agent's changes waiting in the draft; they suggest no other change, which the owner asks the Merchandising Agent for in its own chat. A page whose boxes are all kept says why it stays as it is.
- A figure from `evidence` appears only as the table states it.
- It composes `onboarding-shared/_shared-box-vocab.md`, so the words can name a box type in plain words, and it carries `rulesetVersion` (`ONBOARDING_RULESET_VERSION`) like the other prompts that compose onboarding playbook blocks; lib's `X-Personalizer-Ruleset-Version` header must match.

## Caching notes

The composed text is the stable prefix; the data and trigger ride after the breakpoint in the user message. The text carries no store data: its examples state no figure, and the `<days>` placeholders stand for the request's own values.

## Pinning tests

[`test/optimization-prompts.test.ts`](../../test/optimization-prompts.test.ts) pins, for all four steps: the composed text byte for byte against `test/__snapshots__/<step>.baseline.md`; the composition order above; the identity's five areas and the specialist agent behind each; the route (group, balanced tier, no tools, no effort, no attachments, the model maximum output); that the one output example parses, carries the documented members and states no figure in its words; the shared rules (Studio writes the numbers, keys only from the data, nothing live before Publish, the owner's notes first, the question instead of a guess, Support, no arithmetic and no forecast); the box step's words over the Merchandising Agent's applied changes, with pages of only `page` and `why`; the per-audience rules, the template options and the starting-rate wording where they apply; and that only `optimize-boxes` carries the ruleset version. [`test/assistant-prompt-blocks.test.ts`](../../test/assistant-prompt-blocks.test.ts) records the four as prompts whose words the owner reads, so the master rules follow their identity.
