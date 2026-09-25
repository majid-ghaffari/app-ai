# Onboarding QC observability and release evaluation

`POST /messages` emits one content-free structured completion record for every onboarding QC
attempt. The SLO is **model review p50 ≤ 30 seconds and p95 ≤ 45 seconds**, measured from the
app-ai handler's `totalMs`. The release-quality objective is **zero critical false passes**.

## Durable fields

Filter Seq records to scope `Messages`, prompt `onboarding-review-all` or
`onboarding-css-review`, and message `Inference completed` / `QC inference reached max_tokens`.
Each record includes:

- registry-owned model, max-token budget, and applied effort;
- total milliseconds, stop reason, input/output tokens, cache creation tokens, and cache-read tokens;
- attempt (`full`, `lean`, `chunk`, `specialist`), escalation flag, revision/pass, and
  page/image/tile counts;
- lib-measured capture and upload milliseconds.

Failures use the configured error/fatal routes and retain the same safe dimensions. Responses,
screenshot/file IDs, manifest text, model content, and merchant evidence are not copied into QC
telemetry. A reply stopped at `max_tokens` is logged at `warn` and answered as a 502
`InferenceTruncatedException`, never as a success. Production must route `warn` to a durable sink so
`max_tokens` is visible; route `info` to a durable sink to measure successful latency and token
distributions.

## SLO query and release gate

For a representative production window, group by model, prompt, effort, attempt, and page-count
band. Compute p50/p95 over `totalMs`; report escalation rate, `max_tokens` rate, parse/coverage
recovery rate, cache-read ratio, and end-to-end `captureMs + uploadMs + totalMs`. Exclude no failed
attempts from operational counts; keep model-review percentiles separately from capture/upload.

The critical-false-pass eval set must include missing mobile evidence, one-width responsive breaks,
missing rendered boxes, wrong placement, theme-clashing styling, unresolved currency, and scoped-CSS
cases. Any critical defect receiving a final pass blocks release. Unit tests prove routing,
fail-closed mobile evidence, idempotent recovery, and telemetry shape; real p50/p95 and false-pass
rates require replay/live production-like model calls and cannot be inferred from mocked test time.

No progress UI may derive from these timings. User-visible progress advances only on concrete
readiness, capture, upload, inference, apply, and verification events.
