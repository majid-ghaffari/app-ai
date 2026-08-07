# Analytics Insights — Maintenance Doc

The design/maintenance record for the `analytics-insights` per-tab ANALYTICS INSIGHTS prompt. The runtime file it documents lives at [`src/prompts/analytics-insights.md`](../../src/prompts/analytics-insights.md) (single-file system prompt), registered as `analytics-insights` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## What it is

`analytics-insights` powers Studio's per-tab **AI Insights** cards in the Analytics view. When a merchant opens an Analytics tab (Overview / Audience / Recommendations / Products / ShapeShifts / Discounts / Emails & SMS), lib hands the tab's REAL loaded analytics data to this prompt and gets back up to three concrete, data-backed insights. It is a **one-shot, tool-free** call: the tab's data is handed over as grounding, never fetched. Each returned insight is mapped by `kind` onto that tab's fixed insight-card scaffolding (lib `admin/features/analytics/data/ai-insights.ts`) and rendered as light markdown. A card whose `kind` gets no grounded insight renders nothing; when there is no grounding data at all, lib makes NO call and shows a neutral empty state (an insight over no data would be fabricated — forbidden by lib `docs/AI-LAYER.md`).

This is a SINGLE-FILE prompt — not composed. There are no shared blocks under `onboarding-shared/`; the whole prompt is the one `.md` file above. Editing it affects only this prompt.

## Model

The `frontier` default tier — resolved via `resolveModel` at registration time, currently `claude-opus-4-8` (the wrangler `MODEL_FRONTIER` `[vars]` pin in [`wrangler.toml`](../../wrangler.toml)). It shares the default tier with `chat` / `onboarding-chat` / `image-selection` (they omit `tier`); it is NOT a distinct tier like `proposals`' `balanced` tier. No `temperature` / `top_p` / `top_k` / `effort` — current models reject the sampling knobs and the default output effort is fine for a short structured reply.

## Tools

None. `usesTools: false` and there is no `clientTools`. On the `/chat` transport this means the agent loop is handed `tools: undefined`, so there is no tool round-trip — it is a plain single-shot completion. All the data the prompt reasons over arrives up front as grounding; the prompt is explicitly instructed to use ONLY that data and never invent figures.

## Attachments

None (`attachments: []`). No files are uploaded or prepended to the message.

## Input contract — what the lib sends

Selected via `X-Personalizer-System-Prompt: analytics-insights` on `POST /chat` (lib `admin/ai/brain/app-ai-client.ts::completeChat('analytics-insights', …)` — the non-streaming completion path; the response's `text` carries the JSON). The lib sends:

- **The ask** — a bare trigger message plus the `context` object. lib sends `context: { hostPage: 'Analytics', category: 'analytics/{tab}', grounding }` (see lib `admin/features/analytics/components/ai-insights.tsx`).
- **`context.grounding`** — the tab's REAL loaded analytics data (the numbers already rendered in that tab). `buildSystem` (in [`src/handlers/chat.ts`](../../src/handlers/chat.ts)) folds it into the system array as a SEPARATE, UNCACHED text block after the base prompt. NOTE: `buildSystem` labels every grounding block with a generic `LimeSpot best-practice catalog (ground recommendations in this):` prefix line; for this prompt that line is cosmetic — the JSON payload beneath it is the tab's real analytics data, which is what the prompt reasons over. Do not read the prefix literally when editing.

Per lib's `docs/AI-LAYER.md` locality rule, the lib sends ONLY the prompt NAME + ephemeral data — the insight INSTRUCTION and the output format live here, server-side, never hardcoded in the lib.

## Output contract (frozen — the lib's `{ kind, text }[]` consumer)

The model MUST reply with ONLY a JSON array — no prose, no markdown fences, nothing else — of UP TO THREE insight objects:

```
[
  {
    "kind": "opportunity" | "attention" | "trending",
    "text": "<one short, specific insight referencing concrete numbers from the data>"
  }
]
```

Rules baked into the prompt:

- Include an entry only when the grounding data supports it. If the data is empty or inconclusive for a framing, OMIT that entry — never pad with vague/hedged framings.
- Never invent figures — every insight references concrete numbers from the grounding data.
- Keep each `text` to one or two sentences of light markdown.
- Return ONLY the JSON array and nothing else.

lib's `parseAnalyticsInsights` (in `admin/ai/structured-output.ts`) is tolerant — it accepts a direct array, a fenced array, or an array embedded in text — and DROPS any entry missing a valid `kind` (one of the three literals) or a non-empty `text`. Each surviving entry is mapped onto the per-tab scaffolding card of the same `kind`. Keeping the `kind` vocabulary (`opportunity` / `attention` / `trending`) and the `{ kind, text }` shape stable is what lets the Analytics cards render unchanged — changing either breaks the mapping.

`maxTokens` is `1024`, ample for three short insights; the client may override via the request body's `max_tokens` but does not.

## Caching notes

The base prompt ships as the FIRST system block with a 1h extended `cache_control` breakpoint (a stable, reused prefix). The grounding block is a SEPARATE block with NO `cache_control` — it changes every call (each tab / period carries different data), so it stays uncached and the cached prefix stays byte-stable. Do not move grounding into the cached block or the breakpoint stops being reusable.

## Tests

No prompt-specific pinning spec exists today (`analytics-insights` is not referenced by any file under `test/`). Its config resolves through the shared registry machinery covered by `test/config.test.ts` (the `resolveModel` tier mapping + the wrangler `MODEL_FRONTIER` pin). The output contract is exercised end-to-end on the lib side (`parseAnalyticsInsights` + the Analytics AI e2e). If this prompt grows enough to warrant one, add a registry-resolution spec asserting `usesTools: false`, `model = ENV.MODEL_FRONTIER`, `attachments: []`, and the JSON-array output shape.
