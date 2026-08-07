# Onboarding Chat — Maintenance Doc

The design/maintenance record for the `onboarding-chat` prompt — the mid-flow chat assistant for the Studio onboarding subject. The runtime system text lives at [`src/prompts/onboarding-chat.md`](../../src/prompts/onboarding-chat.md) (a SINGLE-file prompt — no `prompt.md` folder, no composed blocks), registered as `onboarding-chat` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). It is selected via the header `X-Personalizer-System-Prompt: onboarding-chat` on `POST /chat`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Summary

`onboarding-chat` is the conversational assistant the merchant talks to WHILE the Studio onboarding flow is running — it answers their specific question or handles the specific change they ask for, in context of wherever the on-screen flow currently is. It is the CLIENT-tool twin of the general [`chat`](../../src/prompts/chat.md) prompt: same identity and same model, but instead of the SERVER data toolset it carries ONE client tool, `look_at_page`, that runs in the merchant's browser (the store iframe is the AI's hands) so the model can SEE what actually rendered before it answers or refines a box. It replies in plain chat-bubble prose and, when the merchant asks for a store change, appends a fenced `directives` JSON envelope the Studio UI executes.

## Purpose

The Studio UI — not this prompt — drives the onboarding steps (welcome → audiences → connect Google → recommendation boxes → progress bar → bundle discounts → email → review) and shows the recommendations. This prompt's job is narrow: answer ONLY the merchant's specific question or apply the specific change they ask for, wherever they are in that flow. It must NOT re-greet, re-introduce itself, or recap the whole onboarding plan (the UI already did the greeting). Replies are warm, practical, and short — one to three sentences is usually right.

## Model

The default `frontier` tier — the same agent-loop model as `chat`, resolved at deploy time via `resolveModel(env, tier)` from the `MODEL_FRONTIER` env var (see [`src/config.ts`](../../src/config.ts)). It is a deploy-time configuration choice, not a hardcoded id. `maxTokens: 4096`. No `effort` override (defaults to `high`).

## Tools

- **`usesTools: false`** — the SERVER data toolset (`get_store_analytics` / `get_entity_context` / the platform toolsets) is NOT sent. This is the key divergence from `chat`: `onboarding-chat` deliberately DROPS the server-data-tool guidance. In this mode the model has no tool for store analytics, sales, order value, or existing campaign/segment data, and the prompt tells it to say so plainly rather than invent a number.
- **`clientTools: [LOOK_AT_PAGE_TOOL]`** — a single CLIENT tool, defined in [`src/lib/client-tools.ts`](../../src/lib/client-tools.ts). `usesTools` and `clientTools` are MUTUALLY EXCLUSIVE (a turn is EITHER server-data-tools OR the visual client tool, never both) — that is why this is a separate registry entry, not a flag on `chat`. `onboarding-chat` is the FIRST live consumer of the otherwise-dormant client-tool mode.

### `look_at_page` (client tool)

`look_at_page` asks the browser to capture (or serve a cached) full-page screenshot of a store page and hand it back so the model can visually inspect what rendered. Its only input is an OPTIONAL `page` name hint (`Home` / `Product` / `Collection` / `Cart` / …); omitted means "the page the merchant is currently on."

Loop behavior (client-tool mode, `handlers/chat.ts`): on a `look_at_page` `tool_use` the worker does NOT execute the tool — it returns the call in `done.toolCalls`, stops with `stopReason: 'tool_use'`, and surfaces a `tool_call` SSE event (no `tool_result`). The lib side then runs the capture, uploads the screenshot via `/files`, appends it as an image block on the `tool_result` turn, and re-calls `/chat` so the model can SEE the page before it answers or refines. The lib owns the capture/cache seam and the bounded relay loop (`lib ai/agent/look-at-page.ts`); `src/lib/client-tools.ts` owns ONLY the wire schema the model sees.

The prompt steers the model to look whenever seeing the page would make the answer right instead of guessed (before describing how something LOOKS; before refining a box the merchant is unhappy with; when the merchant says "here" / "this" / "how does it look"), and NOT to claim it can see something it hasn't looked at. Purely conversational questions get answered directly, without a needless look.

## Attachments

None (`attachments: []`). Unlike `image-selection`, this prompt carries no bundled training sample. Per-turn grounding data (`currentExperience`, `## Referenced Entities`, any provided grounding context) rides in the conversation, not in the system prompt.

## Input contract (what the lib sends)

Standard Studio `POST /chat` SSE request with `X-Personalizer-System-Prompt: onboarding-chat`. The conversation carries, in context:

- **`currentExperience`** — a snapshot of what the merchant ACTUALLY has configured in their draft right now: the enabled recommendation boxes per page and each box's current appearance (`style` layout, `itemsPerPage` cards-per-row, `itemsLimit` card count). The prompt reasons over it directly instead of asking "what does it look like now?" — and pairs it with `look_at_page` to see the render.
- **`## Referenced Entities`** (optional) — when present, entities the merchant attached when opening the conversation; they ARE the topic. The model must ground in them and never ask "which one do you mean?".
- On a `look_at_page` re-call, the captured screenshot is appended by the lib as an image block on the `tool_result` turn.

## Output contract

The reply is NOT JSON-only. It is plain conversational chat-bubble prose, OPTIONALLY followed by a single fenced `json` action envelope at the END. Formatting rules the prompt enforces: no markdown tables, no headings, short bullet lists only when genuinely listing 2–4 things, occasional `**bold**`, don't over-format.

When the merchant clearly asks for a store change, the model appends exactly one fenced block:

````
```json
{ "directives": [ { "action": "<name>", "args": { ... } } ] }
```
````

If there is no action to take, the JSON block is OMITTED entirely. Only directives the merchant has clearly asked for are emitted. The prompt prefers ACTING (a directive) over telling the merchant to click around. Directives preview live; the merchant still hits Save/Publish themselves.

Two directive shapes are frozen in the prompt:

**`setAppearance`** — change how boxes LOOK.

```json
{
  "action": "setAppearance",
  "args": { "page": "<page>", "box": "<boxType, optional>", "patch": {} }
}
```

- `page` (required): `Home` | `Product` | `Collection` | `Cart` | `SlidingCart` | `Search` | `Blog`.
- `box` (optional): a specific box type from `currentExperience` (e.g. `BoughtTogether`, `Popular`, `RecentViews`); omit to change every box on the page.
- `patch` (required) — ONLY these keys: `Style` (`carousel` | `grid` | `rows` | `slider`), `ItemsPerPage` (1–12), `ItemsLimit` (1–50), `ImageBorderRadius` (px, 0–100), `NavigationArrowType` (`chevron` | `circleChevron` | `circleFull` | `circleArrow`). A "2-up" grid is `{ "Style": "grid", "ItemsPerPage": 2 }`.

**`toggleBox`** — ADD or REMOVE a recommendation box.

```json
{ "action": "toggleBox", "args": { "page": "<page>", "box": "<boxType>", "on": <true|false> } }
```

- `page` (required): same page grammar as `setAppearance`.
- `box` (required): one of `Popular` | `Trending` | `NewArrival` | `YouMayLike` | `RecentViews` | `BoughtTogether` | `CrossSell` | `Upsell` | `Related` | `FeaturedCollection`. Map the merchant's words to the closest one.
- `on` (required): `true` to add, `false` to remove.

The prompt notes other actions in prose (navigate a step, apply a placement, toggle a segment, activate a template) that also ride the `directives` envelope; `setAppearance` and `toggleBox` are the two with a fully specified arg schema.

If a directive vocabulary changes here, the Studio UI action executor (lib side) must be updated in lockstep — these page names, box types, and patch keys are a two-sided contract.

## Relationship to the other onboarding prompts

`onboarding-chat` is the mid-flow CHAT surface of the onboarding subject. It is distinct from the store-setup reasoners it sits alongside:

- The COMPOSED onboarding prompts (`onboarding-batch`, `onboarding-batch-all`, `onboarding-review`, `onboarding-review-all`) are the propose/review passes assembled from per-prompt fragments + the SHARED blocks under [`src/prompts/onboarding-shared/`](../../src/prompts/onboarding-shared/). `onboarding-chat` is **NOT** one of them: it is a single `.md` file that pulls NO shared blocks, so editing an `onboarding-shared/` block does NOT touch this prompt (and editing this prompt cannot affect them).
- It shares its identity and model with `chat` but is a separate entry because of the mutually-exclusive tool mode.

## Caching notes

Single-file prompt, so it does NOT participate in the composed-prompt byte-equivalence baseline gate (`test/onboarding-prompt-blocks.test.ts` / `test/__snapshots__/*.baseline.md`) — those cover only the four composed onboarding prompts. The system text is nonetheless a stable prefix per the standard `messages.ts` `cache_control` breakpoint: keep per-shop VARIABLE data (screenshots, `currentExperience`, referenced entities) in the conversation AFTER the cached system prefix, never in this file.

## Pinning test

The client-tool wiring is pinned by `test/chat.test.ts` → _"onboarding-chat clientTools mode: a look_at_page tool_use returns done.toolCalls + stops, no server tool call"_. It asserts that a request selecting `onboarding-chat`:

- sends the CLIENT tool to Anthropic in place of the server toolset — `sentTools` is exactly `['look_at_page']`;
- on a `look_at_page` `tool_use`, stops after ONE iteration with `stopReason: 'tool_use'` and returns the call in `done.toolCalls` (name `look_at_page`, `input.page` preserved);
- emits a `tool_call` SSE event and NO `tool_result` (the worker never executes the tool);
- makes exactly ONE Anthropic fetch and NO Brain `/v2/ai-tools/` call.

There is no separate output-JSON schema pin — the reply is prose + an optional directive envelope, not a fixed JSON object, so directive shapes are enforced by the prompt text and the lib-side executor, not a snapshot.
