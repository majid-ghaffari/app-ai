# onboarding-review-gate-all

The latency-sensitive first stage of onboarding quality control. It reviews all currently dirty
pages together on the registry's `fast` tier and returns compact per-page pass/fail classifications.

## Contract

- Endpoint: `POST /messages` with `X-Personalizer-System-Prompt: onboarding-review-gate-all`.
- Model tier: `fast`; concrete model comes from `MODEL_FAST`.
- Budget: 1536 output tokens; no tools and no effort setting.
- Input: a DATA manifest plus at most first/middle/last current-render tiles per width and page,
  including deterministic render evidence when available.
- Output: JSON-only `{ "pages": { "<page>": { "pass": boolean, "issueCodes": [] } } }`.
- Allowed issue codes are `placement`, `styling`, `responsive`, `render-missing`,
  `evidence-incomplete`, `uncertain`, and `advanced-css-required`.

The gate cannot emit corrections. Lib accepts an all-clear page immediately and sends only failed,
uncertain, malformed, or uncovered pages to `onboarding-review-all` in independent chunks of two.
The detailed balanced-tier prompt remains the sole correction authority.

## Evidence rationale

First/middle/last tiles preserve bounded top-to-bottom context for both widths without paying to
submit every full-page band to the common path. A page requiring detailed judgment receives its full
current evidence, relevant references, plan, render geometry, and history in the escalation call.
