# Prompt Groups and Evidence-Reuse Graph

> **Status:** Active registry contract. The group fields, exact inventory, fallback graph, capability validation, and fitness rules are executable in `src/prompt-registry.ts` and `test/prompt-groups.test.ts`.

## Invariants

1. `src/prompt-registry.ts` is the only prompt registry.
2. Every registered prompt appears exactly once in this inventory and belongs to exactly one group.
3. A group declares the capability TIER it runs on and the capabilities it requires, and nothing else. The model id configured for that tier decides the provider, API family, capabilities, and direct-file policy through the model catalog (`src/inference/model-catalog.ts`).
4. A file-reusing fallback, retry, repair, or chunk edge stays on one compatible provider file route. A group may declare `fileRouteGroup` to ride another group's route, which is how the fast QC gate and the balanced detailed reviewer read one uploaded evidence set.
5. Lib names prompt contracts but never groups, tiers, providers, or models.
6. Evidence intended for prompts in different groups is directly uploaded to every unique required route before inference.

## Group map

| Prompt group               | Registered prompts                                                                                                                                                                     | Capability tier + class     | Evidence rationale                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image-selection`          | `image-selection`                                                                                                                                                                      | fast structured vision      | Isolated image-selection attachment and evidence contract; preserves the current effective fast path.                                                                                                |
| `studio-data-agent`        | `chat`, `onboarding`                                                                                                                                                                   | frontier server tools       | Shared server-tool agent semantics and no visual file fallback edge; a chat carrying earlier turns, so it requires `textConversation`.                                                               |
| `studio-visual-agent`      | `onboarding-chat`                                                                                                                                                                      | frontier client tools       | Browser-owned `look_at_page` continuation is distinct from the server-tool agent contract; a chat carrying earlier turns, so it requires `textConversation`.                                         |
| `placement-vision`         | `placement`                                                                                                                                                                            | fast structured             | Latency-sensitive one-shot placement result.                                                                                                                                                         |
| `setup-strategy`           | `proposals`                                                                                                                                                                            | balanced agent/vision       | Tool-grounded setup proposal contract is independent from the onboarding batch fallback graph.                                                                                                       |
| `onboarding-visual`        | `onboarding-batch`, `onboarding-batch-all`, `onboarding-review`, `onboarding-review-all`, `onboarding-currency-recovery`, `onboarding-css-review`, `optimize-demand`, `probe-currency` | balanced visual             | These paths share onboarding evidence or flow into review/currency recovery using the same captures.                                                                                                 |
| `onboarding-qc-gate`       | `onboarding-review-gate-all`                                                                                                                                                           | fast structured vision      | Shares the `onboarding-visual` provider file route so the cascade's first pass reads one uploaded evidence set on a cheaper tier.                                                                    |
| `cartdrawer-visual`        | `cartdrawer-batch-all`, `cartdrawer-review-all`                                                                                                                                        | balanced visual             | Cart Drawer proposal and review share the same captured drawer evidence.                                                                                                                             |
| `render-verification`      | `visual-verify`                                                                                                                                                                        | balanced visual             | Unified rendered-result verification contract.                                                                                                                                                       |
| `free-render-verification` | `visual-verify-free`                                                                                                                                                                   | balanced inline vision      | Protected CI sends one inline screenshot to Workers AI without changing the production visual-verification route.                                                                                    |
| `website-analysis-visual`  | `probe-cart-wiring`, `probe-style`, `probe-template`                                                                                                                                   | balanced visual             | Website-analysis probes consume the same page HTML/screenshot evidence family.                                                                                                                       |
| `website-industry`         | `probe-industry`                                                                                                                                                                       | frontier classification     | Heavy industry classification has no file-reuse edge with the visual probes.                                                                                                                         |
| `billing-narrative`        | `billing-assistant`                                                                                                                                                                    | balanced streamed narrative | Grounded subscription answers over the request's own pricing context; no evidence upload; a chat carrying earlier turns, so it requires `textConversation`.                                          |
| `analytics-narrative`      | `analytics-insights`                                                                                                                                                                   | balanced structured         | Analytics summary input and output contract is independent of visual evidence.                                                                                                                       |
| `grader-sales`             | `grader-chat`                                                                                                                                                                          | balanced text conversation  | The Grader's no-tool sales chat reads no uploaded evidence; its report travels in the request as data, so it shares no file route; it requires `textConversation`, which a visual-only family lacks. |

This table covers every prompt key registered in `src/prompt-registry.ts`. A test must compare registry keys to the declared group membership so additions cannot bypass review.

## File-reuse and fallback graph

The implementation must encode this graph as typed data or test fixtures rather than relying on comments.

### Whole-store onboarding proposal

```text
onboarding-batch-all
  -> onboarding-batch (per-page fallback)
```

The same uploaded page captures may be consumed by the holistic and per-page calls, so both prompts belong to `onboarding-visual`.

### Holistic onboarding review recovery

```text
onboarding-review-all (full holistic)
  -> onboarding-review-all (lean current + state/history)
  -> onboarding-review-all (parallel page chunks)
```

All three recovery shapes deliberately use the same registered prompt. Prompt grouping still fitness-tests this path because the request manifests reuse the same provider file references.

### Cascaded quality control

```text
onboarding-review-gate-all (fast whole-store gate)
  -> onboarding-review-all (detailed review of the failed/uncertain/uncovered pages)
  -> onboarding-css-review (advanced-CSS specialist, entered on `advanced-css-required`)
```

The gate reads the same uploaded evidence as the detailed reviewer on a cheaper tier, so
`onboarding-qc-gate` declares `fileRouteGroup: onboarding-visual` and both passes accept one
minted reference. The CSS specialist is in `onboarding-visual` itself.

### Original/current review and currency recovery

```text
onboarding-batch-all / onboarding-batch captures
  -> onboarding-review-all
  -> onboarding-currency-recovery (bounded omission recovery)
```

Original, round-baseline, current, and price-priority evidence can be reused across these calls. The involved prompts remain in `onboarding-visual`.

### Optimize

```text
optimize-demand
  -> onboarding-review (rendered-result review)
```

Optimize's capture must remain consumable by its review fallback, so both prompts use `onboarding-visual`.

### Cart Drawer

```text
cartdrawer-batch-all
  -> cartdrawer-review-all
  -> cartdrawer-review-all (subsequent correction rounds)
```

Both prompts use `cartdrawer-visual`.

### Same-prompt repairs and retries

Parse repair, schema retry, lean retry, chunk retry, and transport retry that preserve a prompt name naturally remain in that prompt's group. Tests must ensure request recovery cannot substitute a prompt from an incompatible group while retaining file references.

## Multi-destination upload examples

### One group

A capture destined for `onboarding-batch-all`, its `onboarding-batch` fallback, and `onboarding-review-all` resolves to one `onboarding-visual` upload route and one upstream object per provider/account/file policy. The response names all three prompts in its `references` map, each holding that one shared reference.

### Several groups

A capture knowingly destined for `onboarding-review-all` and `visual-verify` resolves to `onboarding-visual` and `render-verification`. If the groups resolve to distinct routes, app-ai uploads directly to both routes in parallel and the `references` map holds each destination's own reference.

### Cross-provider fallback

If `onboarding-visual` is configured to fall back from Anthropic to OpenAI for a file-bearing request, both provider copies must exist before inference. The runtime never downloads from one provider and rehosts to another during fallback.

## Registry fitness tests

- The union of all group prompt lists equals the exact registry key set.
- No prompt occurs twice.
- Every group resolves through its tier to a model the catalog recognises, and to a file policy compatible with that model's API family.
- Every fallback graph endpoint resolves to the required compatible group.
- Every prompt's requirements are a subset of its resolved model's capabilities.
- No provider/model override exists in a prompt caller or lib request; the only per-prompt exception is `MODEL_OVERRIDES`, whose keys must name a registered prompt or prompt group and which may not move one prompt off its group's shared provider file route.
- `image-selection` resolves through the fast tier, so the prompt carries no lib-side model pin and its effective latency/cost class is unchanged.

## Change procedure

Adding or changing a prompt requires, in the same change:

1. update the existing registry entry;
2. assign exactly one group here and in typed registry data;
3. declare any file-reuse/fallback edges;
4. update capability requirements;
5. update the prompt maintenance doc;
6. pass the inventory, fallback, upload, and adapter fitness gates.
