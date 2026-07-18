# Onboarding — Maintenance Doc

The design/maintenance record for the `onboarding` prompt — the opinionated new-merchant onboarding assistant that applies LimeSpot best-practice defaults over the server tool-use agent loop. The runtime system text lives at [`src/prompts/onboarding.md`](../../src/prompts/onboarding.md) (a SINGLE-file prompt — no `prompt.md` folder, no composed blocks), registered as `onboarding` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). It is selected via the header `X-Personalizer-System-Prompt: onboarding` on `POST /chat` (the tool-use path). The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Summary

`onboarding` is a first-time-setup assistant that guides a NEW merchant to a great default LimeSpot configuration fast — recommendation-box stacks per page, cart progress-bar offer + threshold, discount tiers, bundles, and audience segments — explaining each step in one or two friendly sentences. It runs on the tool-use `/chat` agent loop (`usesTools: true`), so during reasoning it can CALL the personalizer toolset to read the store's real analytics, AOV, existing segments, existing campaigns, and industry before recommending, then tailor the best-practice playbook to what's already there. It replies in short chat-bubble prose and, when it wants the Studio UI to act, appends a fenced `directives` JSON envelope at the END of its reply.

## Purpose

The Studio UI — not this prompt — already greeted the merchant and is driving the step-by-step flow on screen. This prompt's job is to speak to the CURRENT step and what was asked, applying the LimeSpot best-practice playbook (baked into the system text) unless the store's own data suggests otherwise. It must NOT re-greet, and NOT dump the whole plan as a wall of text unless the merchant explicitly asks for the full plan. Replies are concise, warm, and practical.

The best-practice playbook embedded in the prompt covers: per-page recommendation-box stacks (Home / Product / Cart / Collection / Search-Blog-404), ~4–5 items per box with a smart fallback strategy, cart progress-bar thresholds relative to AOV (Free Shipping first), discount tiers by loyalty or order value, minimum-3-item bundles, and the audience-segment activation order (the five journey-stage segments first, then the spending segments). The prompt is explicit that it must use the tools to ground its numbers and NEVER invent store figures.

## Model

The default `frontier` tier — the same agent-loop model as [`chat`](../../src/prompts/chat.md), resolved at deploy time via `resolveModel(env, tier)` from the `MODEL_FRONTIER` env var (see [`src/config.ts`](../../src/config.ts)). It is a deploy-time configuration choice, not a hardcoded id. `maxTokens: 4096`. No `effort` override (defaults to `high`) — pinned by `test/token-saving.test.ts` (`getSystemPrompt('onboarding', ENV).effort` is `undefined`).

## Tools

- **`usesTools: true`** — this prompt runs on the SERVER tool-use path. On `POST /chat`, `handlers/chat.ts::runAgentLoop` dispatches the always-active personalizer toolset (`src/toolsets/personalizer/index.ts`): `get_store_analytics` (real AOV / order count / revenue), `list_segments`, `list_campaigns`, `get_store_config` (platform / industry / configured boxes), and `get_entity_context`. app-ai proxies each tool server→server to Brain's `v2/ai-tools/*` endpoints, forwarding the merchant's context-ID, then feeds the result back into the loop. The AOV-derived progress-bar threshold and the "reflect what already exists" behavior come from these reads; the prompt tells the model to consult them before recommending and never fabricate a number.
- **No `clientTools`.** This is the SERVER-tool path. It is the counterpart of [`onboarding-chat`](onboarding-chat.md), which drops the server toolset for the single `look_at_page` CLIENT tool — `usesTools` and `clientTools` are mutually exclusive, which is why the two are separate registry entries.

## Attachments

None (`attachments: []`). No bundled training sample. Per-turn grounding data (any `context.grounding`, referenced entities, conversation history) rides in the request, not in the system prompt.

## Input contract (what the lib sends)

A standard Studio `POST /chat` SSE request with `X-Personalizer-System-Prompt: onboarding`: the message history + the frozen completion context (`hostPage`, `category`, `grounding`, `refs`). Per the AI-layer HARD RULE (docs/AI-LAYER.md → "Prompts live in app-ai"), the lib sends only ephemeral runtime DATA or a bare trigger — never instruction text as message content. The best-practice playbook lives here in the system prompt; the merchant's real store numbers come from the tool calls the model makes during the loop.

> **Selection note — the batch flow is what ships, not this prompt.** Today the live Studio onboarding "show" runs through the COMPOSED batch/review prompts (`onboarding-batch(-all)` / `onboarding-review(-all)`), not this conversational agent-loop prompt. In the lib, `'onboarding'` is the DEFAULT `systemPrompt` argument of `brain/chat.ts::sendChatTurn` / `sendChatTurnWithClientTools`, but both live callers (`chat/open.ts`, `orchestrator.ts::sendMessage`) pass `'chat'` (and the mid-flow visual chat uses `'onboarding-chat'`). So `onboarding` is a registered, self-contained conversational best-practice agent-loop variant — the lighter-touch alternative to the batch pipeline — that is exercisable by name (the lib `SystemPromptName` union carries `'onboarding'`) but not currently selected by a live lib path. Its registry wiring (model, `usesTools`, effort) is pinned; it is not woven into the shipped batch show.

## Output contract

The reply is NOT JSON-only. It is plain conversational chat-bubble prose, OPTIONALLY followed by a single fenced `json` action envelope at the END. Formatting rules the prompt enforces (it is writing into a small chat bubble): no markdown tables, no headings, short bullet lists only when genuinely listing 2–4 things, `**bold**` used sparingly.

When the model wants the Studio UI to act, it appends exactly one fenced block after the prose:

````
```json
{ "directives": [ { "action": "<name>", "args": { ... } } ] }
```
````

Plain prose comes before the block. The `directives` array is the two-sided contract with the lib-side Studio action executor: an action name + its args, executed by the UI (previews live; the merchant still hits Save/Publish). If the directive vocabulary is changed here, the lib executor must be updated in lockstep.

## Relationship to the other onboarding prompts

`onboarding` is the CONVERSATIONAL, best-practice AGENT-LOOP variant of the onboarding family. It is distinct from every other onboarding-named prompt:

- **`onboarding-chat`** ([doc](onboarding-chat.md)) — the mid-flow VISUAL chat: a single-file CLIENT-tool prompt carrying `look_at_page` (no server tools). Where `onboarding` reads store DATA via the server toolset, `onboarding-chat` SEES the rendered page via the client screenshot tool. Same default `frontier` tier; different tool mode.
- **`onboarding-batch` / `onboarding-batch-all`** — the JSON PROPOSE passes (per-page / whole-store). COMPOSED prompts (per-prompt fragments + the SHARED blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/)), `usesTools: false`, structured JSON output over page-tile screenshots. They are the placement reasoners the shipped batch show actually drives.
- **`onboarding-review` / `onboarding-review-all`** — the JSON QC passes (per-page / whole-store) that verify the applied render and emit corrections. Also COMPOSED, `usesTools: false`, JSON-only.

`onboarding` is **NOT** one of the composed prompts: it is a single `.md` file that pulls NO shared blocks. Editing an `onboarding-shared/` block does NOT touch this prompt, and editing this prompt cannot affect the batch/review prompts.

## Caching notes

Single-file prompt, so it does NOT participate in the composed-prompt byte-equivalence baseline gate (`test/onboarding-prompt-blocks.test.ts` / `test/__snapshots__/*.baseline.md`) — those cover only the four composed onboarding prompts. The system text is nonetheless a stable prefix per the standard `messages.ts` `cache_control` breakpoint: keep per-shop VARIABLE data (the merchant's numbers arrive via tool results, referenced entities, grounding) in the conversation AFTER the cached system prefix, never in this file.

## Pinning tests

- `test/chat.test.ts` → _"exposes the Studio system prompts"_ asserts `onboarding` resolves with a non-empty prompt.
- `test/token-saving.test.ts` pins the registry wiring: `onboarding` resolves to the default `frontier` tier (not the fast/balanced tiers), and it carries NO `effort`.

There is no separate output-JSON schema pin — the reply is prose + an optional directive envelope, not a fixed JSON object, so directive shapes are enforced by the prompt text and the lib-side executor, not a snapshot.
