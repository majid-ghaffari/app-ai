# Optimization: Google Ads & Audiences step — Maintenance Doc

The design/maintenance record for `optimize-ads-audiences`, the second of the Optimization conductor's four steps. Its system text is composed in [`src/prompts/optimize-ads-audiences/index.ts`](../../src/prompts/optimize-ads-audiences/index.ts) and registered in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). What the four steps share — code writes the numbers and the model the words, keys only from the data, the master rules, the composition, the route, the request and the shared data members — is in [optimize-boxes.md → The four steps](optimize-boxes.md#the-four-steps).

## Purpose

The step plans the audiences the store should have for its ads and its later offers, and answers the requests the Google Ads Agent raised for Optimization (its `AdsAudienceRequest` and `AdsPromotionRequest` proposals, whose `TargetConductor` is Optimization). The Google Ads Agent, a Brain agent, owns the ads: the step suggests nothing inside Google Ads beyond what a request proposes, and nothing changes in the store's Google Ads account unless the owner asks for it. lib reads that agent's and the Audiences Agent's latest results through Brain's `latest-result` with Optimization as the requester, asking for one fresh run only when one is missing or stale, and sends them as data; app-ai calls no agent route. Audiences come only from Brain's segment templates: the step drafts none outside them, even when a note or a request asks, and says so.

When the store's Google Ads account is not connected, lib offers Connect Google Ads or Skip this step and lists no change; the step still chooses the audiences the store's own data supports, its summary says what the Google Ads Agent can check once connected, carries the line every Google Ads connect point shows, "Nothing changes in your Google Ads account unless you ask for it.", and names no audience, and it answers no requests.

## Input (beside the shared members)

| Member      | Shape                                                                                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `googleAds` | `{ connected, latestResult?: { headline, summary, severity, completedAtUtc, freshness, facts, notices }, requests: [{ noticeKey, kind: "AdsAudienceRequest" \| "AdsPromotionRequest", headline, summary }] }`; `noticeKey` is lib's key for the request (`ads-request-1`, `ads-request-2`, ...), which lib maps back to the request's notice |
| `audiences` | `[{ audienceKey, title, active, facts }]`, the store's audiences with the facts lib has for each (members, orders, average order)                                                                                                                                                                                                            |
| `templates` | `[{ templateKey, title, description }]`, Brain's segment templates, the only audiences lib can create in the draft                                                                                                                                                                                                                           |

## Output

```json
{
  "headline": "...",
  "summary": "...",
  "audiences": [{ "templateKey": "cart-abandoners", "reason": "..." }],
  "requests": [
    { "noticeKey": "n-1", "answer": "audience", "templateKey": "cart-abandoners", "reason": "..." },
    { "noticeKey": "n-2", "answer": "progress-bar", "reason": "..." }
  ],
  "basedOn": "...",
  "question": "..."
}
```

- `audiences`, at most four, are drafted from `templates` by `templateKey`: one a request asks for, one the Audiences Agent's latest result says the store lacks, or one the Progress Bar and Bundle Discounts steps need for shoppers no active audience covers; never one for shoppers the store lacks, one that repeats an active audience, or one outside `templates`.
- `requests` answers every request once: `audience` (with the `templateKey` of an audience in `audiences`), `progress-bar` or `bundles` (lib passes the request to that step as its `requests` data), or `none` with the reason. `audiences` and `requests` are always present.

## Pinning tests

[`test/optimization-prompts.test.ts`](../../test/optimization-prompts.test.ts) pins the composed text against `test/__snapshots__/optimize-ads-audiences.baseline.md`, its composition and route, its output example, and that it leaves Google Ads to the Google Ads Agent, answers every request, drafts only template audiences and handles an unconnected account without naming an audience.
