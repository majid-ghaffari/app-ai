# Onboarding Currency Recovery — Maintenance Doc

The design/maintenance record for the exceptional `onboarding-currency-recovery` prompt. Its runtime text is [`src/prompts/onboarding-currency-recovery/prompt.md`](../../src/prompts/onboarding-currency-recovery/prompt.md), and its registry entry is in [`src/prompt-registry.ts`](../../src/prompt-registry.ts).

## Where it sits

Currency is a first-class action in the holistic `onboarding-batch-all` proposal and every `onboarding-review-all` QC response. The proposal must return an explicit `setCurrencyFormat` verdict. This prompt runs only when that required initial action is missing or invalid. It is a bounded recovery inside the same visual-action pipeline, not the normal currency workflow and not the legacy `probe-currency` flow.

The lib reuses at most four already-uploaded price-bearing tiles, prioritized from Product, Collection, Cart, Home, then Search. It does not capture or upload again. A valid result is materialized before the first QC render; omission or an invalid result remains unresolved and prevents a silent pass.

## Contract

- **Model:** `balanced` tier, low effort.
- **maxTokens:** 512.
- **Tools/attachments:** none.
- **Input:** selected existing image file IDs followed by `activeCurrency` and deterministic candidates.
- **Output:** JSON-only `{ "visualActions": [{ "action": "setCurrencyFormat", "args": ... }] }`; no page corrections, CSS, prose, or additional actions.

When candidates exist, they are authoritative. The response selects one supplied candidate ID or the explicit `none` decision; it must not infer formatting. When candidates do not exist, it may return `none` or a six-argument format (`currencyCode`, `prefix`, `suffix`, thousands `separator`, decimal `delimiter`, and `decimalDigits` 0..4). The lib validates every field, resolves the code against the active JavaScript currency when available, rejects conflicts, and writes only the managed per-currency `ApplyCustomFormat` block. It never globally resets merchant formats or hardcodes a currency.

The recovery route is latency-critical and bypasses the awaited advisory `count_tokens` pre-flight. Tests pin its registry budget, no-hardcoded-currency prompt text, and direct transport behavior.
