# Onboarding Chat — Maintenance Doc

The design/maintenance record for the `onboarding-chat` prompt — the Studio chat that can look at the store. Its system text is COMPOSED in [`src/prompts/onboarding-chat/index.ts`](../../src/prompts/onboarding-chat/index.ts), per client, through `assistant-shared/studio-chat.ts`, and registered as `onboarding-chat` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). It is selected via the header `X-Personalizer-System-Prompt: onboarding-chat` on `POST /chat`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Summary

`onboarding-chat` is [`chat`](chat.md) with one difference: instead of the SERVER data toolset it carries ONE client tool, `look_at_page`, which runs in the merchant's browser (the store iframe is the AI's hands), so the model can SEE what actually rendered before it answers or changes how something looks. Everything else is `chat`'s, block for block: LimeSpot Assistant leading the agent team, the agents master rules, the Studio context and grounding, the team with its agent and conductor chats, the chat-bubble formatting, every directive and choice, and Support, with `moveBox` and `requestSupport` taught only to a client that lists them in `clientActions` ([chat.md → Client actions](chat.md#client-actions)). Studio's optimizer chats — the Optimization conductor's and the Merchandising, Discounts & Promotions and Look & Feel agents' — select it, so each can look at a page on demand while it answers from the same `growthAgents` grounding `chat` reads.

## Composition

Each block is shared with `chat` from `src/prompts/assistant-shared/`, except the one that replaces `chat`'s server data tools:

1. `_shared-studio-identity.md` — LimeSpot Assistant, the store's eCommerce manager leading its team, naming the platforms Studio serves.
2. The agents master rules (`agents-master-rules.ts`).
3. `_shared-studio-context.md` — the Studio editor, the onboarding flow the UI drives, answer only what was asked.
4. `onboarding-chat/_look-at-page.md` — this prompt's own block, in the place `chat` puts `chat/_data-tools.md`: `look_at_page` is the one tool; look before saying how a box, an offer, a Progress Bar or the store's look appears or whether a change landed, before changing how something looks, and when the merchant says "here", "this" or "how does it look"; never claim to see what it has not looked at; no tool for analytics, sales, order value or existing campaigns and segments, so a number the data does not hold is said to be out of sight here, never invented.
5. `_shared-studio-grounding.md` — best practices, `currentExperience` and Referenced Entities as the topic.
6. `_shared-studio-team.md` — the team, agent chats and conductor chats.
7. `_shared-chat-formatting.md` — the chat-bubble formatting.
8. `_shared-studio-directives.md` — the directive envelope, `setAppearance` and `toggleBox`.
9. `_shared-studio-move-box.md` — `moveBox`, only for a client that lists it.
10. `_shared-studio-choices.md` — choices, `runAgentAgain` and `openPath`.
11. `_shared-studio-support.md` — Support in Studio through Talk with Support and `requestSupport`, for a client that lists `requestSupport`; any other client gets `_shared-studio-support-ask.md`, which sends the owner to ask for a person in the chat.

A change to a shared block changes both prompts and regenerates both baselines.

## Model

The `studio-visual-agent` group runs on the `frontier` tier, whose model resolves from `MODEL_FRONTIER` through [`src/config.ts`](../../src/config.ts). `maxTokens: 4096`. The registry entry omits effort, so the provider default applies. Its group is distinct from `chat`'s because browser-owned visual tool continuation is a separate capability contract.

## Tools

- **`usesTools: false`** — the SERVER data toolset (`get_store_analytics` / `get_entity_context` / the platform toolsets) is NOT sent, and the look-at-page block says so.
- **`clientTools: [LOOK_AT_PAGE_TOOL]`** — a single CLIENT tool, defined in [`src/lib/client-tools.ts`](../../src/lib/client-tools.ts). `usesTools` and `clientTools` are MUTUALLY EXCLUSIVE (a turn is EITHER server-data-tools OR the visual client tool, never both), which is why this is a separate registry entry rather than a flag on `chat`.

### `look_at_page` (client tool)

`look_at_page` asks the browser to capture (or serve a cached) full-page screenshot of a store page and hand it back so the model can visually inspect what rendered. Its only input is an OPTIONAL `page` name hint (`Home` / `Product` / `Collection` / `Cart` / …); omitted means "the page the merchant is currently on."

Loop behavior (client-tool mode, `handlers/chat.ts`): on a `look_at_page` `tool_use` the worker does NOT execute the tool — it returns the call in `done.toolCalls`, stops with `stopReason: 'tool_use'`, and surfaces a `tool_call` SSE event (no `tool_result`). lib then runs the capture, uploads the screenshot via `/files` for this prompt's route, appends it as an image block on the `tool_result` turn, and re-calls `/chat` so the model can see the page before it answers. lib owns the capture/cache seam and the bounded relay loop (`ai/agent/look-at-page.ts`, `ai/brain/chat.ts` → `sendChatTurnWithClientTools`); `src/lib/client-tools.ts` owns ONLY the wire schema the model sees. The free local shim ignores tools, so only a real model exercises a look.

## Attachments

None (`attachments: []`). Per-turn grounding (`currentExperience`, `growthAgents`, `## Referenced Entities`) rides in the conversation, not in the system prompt.

## Input and output contract

The same as [`chat`](chat.md#input-contract-what-the-lib-sends): the request carries `context.grounding` with `currentExperience` and, in the optimizer chats, `growthAgents` with the team and the `agentChat` or `conductor` member; a `look_at_page` re-call adds the screenshot as an image block on the `tool_result` turn. The reply is chat-bubble prose, optionally ending with the one fenced `json` envelope of `directives` and `choices` [`chat`'s output contract](chat.md#output-contract) describes. The directive vocabulary is a two-sided contract with lib's executor.

## Caching notes

The composed text is the stable cacheable prefix; per-shop data (screenshots, `currentExperience`, `growthAgents`, referenced entities) rides in the conversation after it.

## Pinning tests

- `test/assistant-prompt-blocks.test.ts` pins the composed text byte for byte against `test/__snapshots__/onboarding-chat.baseline.md` for a client that lists every gated action and `test/__snapshots__/onboarding-chat.without-client-actions.baseline.md` for one that lists none, its composition for every set of them as `chat`'s blocks with the look-at-page block in place of the data tools, its one client tool and group, and records it among the prompts that carry the agents master rules after the Studio identity.
- `test/chat.test.ts` → _"onboarding-chat clientTools mode: a look_at_page tool_use returns done.toolCalls + stops, no server tool call"_ pins the wiring: the CLIENT tool is sent in place of the server toolset (`sentTools` is exactly `['look_at_page']`); a `look_at_page` `tool_use` stops after ONE iteration with `stopReason: 'tool_use'` and returns the call in `done.toolCalls`; a `tool_call` SSE event and NO `tool_result` are emitted; exactly ONE provider fetch and NO Brain `/v2/ai-tools/` call are made.
- `test/chat.test.ts` → _"pins the merchant-facing assistant and platform names"_ freezes the `LimeSpot Assistant` identity.
- `test/client-actions.test.ts` pins, through `/chat`, that a client listing no actions is taught neither `requestSupport` nor `moveBox`, that each action is taught only when listed, that every client streams and receives the reply unchanged, and that a `clientActions` other than a list of names is refused.
