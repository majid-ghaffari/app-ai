# Studio Chat — Maintenance Doc

The design/maintenance record for the `chat` prompt — the general conversational assistant for LimeSpot Studio merchants. The runtime system text lives at [`src/prompts/chat.md`](../../src/prompts/chat.md) (a SINGLE-file prompt — no `prompt.md` folder, no composed `onboarding-shared/` blocks), registered as `chat` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). It is selected via the header `X-Personalizer-System-Prompt: chat` on `POST /chat` (the tool-use agent-loop path). The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md).

## Summary

`chat` is the base, general Studio AI assistant — the conversational surface a merchant talks to inside the Studio visual editor while the on-screen onboarding flow walks them through setup. It answers their specific question or handles the specific change they ask for, in the context of wherever they are, grounded in LimeSpot best practices and in the merchant's OWN store data. It runs the SERVER-side tool-use agent loop (`usesTools: true`): during reasoning the model can CALL the always-active personalizer toolset to read real store analytics, segments, campaigns, and config from Brain rather than guessing. It replies in plain chat-bubble prose and, when the merchant asks for a store change, appends a fenced `directives` JSON envelope the Studio UI executes.

## Purpose

The Studio UI — not this prompt — greets the merchant and drives the onboarding steps (welcome → audiences → connect Google → recommendation boxes → progress bar → bundle discounts → email → review) and shows the recommendations. This prompt's job is narrow: answer ONLY the merchant's specific question or apply the specific change they ask for, wherever they are in that flow. It must NOT re-greet, re-introduce itself, or recap the whole onboarding plan (the UI already did the greeting). Replies lead with the outcome and are warm, practical, and short — one to three sentences is usually right. When the merchant asks about their own store's data (sales, AOV, existing segments/campaigns, current config, industry), it looks it up via the tools rather than inventing numbers.

## Model

The default `frontier` tier — the shared agent-loop model, resolved at deploy time via `resolveModel(env, tier)` from the `MODEL_FRONTIER` env var (see [`src/config.ts`](../../src/config.ts)). It is a deploy-time configuration choice, not a hardcoded id. `maxTokens: 4096`. No `effort` override (defaults to `high`). This is the SAME tier as its client-tool twin `onboarding-chat` and as the `onboarding` assistant — every entry that OMITS `tier` shares this default `frontier` tier, and `chat` is the general default agent-loop persona, distinct from the cost/quality-tuned reasoners (`proposals` on the `balanced` tier, `placement` on the `fast` tier).

## Tools

`usesTools: true` — this is the SERVER-data tool-use agent loop. The tool surface is composed per request from the toolset registry ([`src/toolsets/registry.ts`](../../src/toolsets/registry.ts)), party-driven off the subscriber's `availableParties`: the always-active personalizer toolset for everyone, plus each party-gated platform toolset whose party is available. The loop runs in [`handlers/chat.ts`](../../src/handlers/chat.ts) (`MAX_ITERATIONS = 8`); a `tool_use` is executed server→server against Brain and fed back as a `tool_result`, streamed to the client as `tool_call` / `tool_result` SSE events.

The always-active personalizer toolset ([`src/toolsets/personalizer/index.ts`](../../src/toolsets/personalizer/index.ts) → `personalizerToolset`) is the frozen five-tool set the prompt relies on (lib CONTRACTS.md §2), dispatched to Brain's `v2/ai-tools/*` endpoints server→server, forwarding the merchant's context-ID:

- **`get_store_analytics`** → `v2/ai-tools/store-analytics` — order count, revenue, AOV, conversion over a date window (optional `fromDate` / `toDate`, default last 90 days). The AOV-derived progress-bar threshold comes from here.
- **`list_segments`** → `v2/ai-tools/segments` — existing audience segments + status (optional `status` / `keyword`), so it doesn't suggest ones that already exist.
- **`list_campaigns`** → `v2/ai-tools/campaigns` — existing campaigns of a `kind` (discount / progressbar / html / image / all), so it reflects what's already set up.
- **`get_store_config`** → `v2/ai-tools/store-config` — platform, industry, currency, and the box types configured per page.
- **`get_entity_context`** — deeper detail for a referenced entity by `type` + `id` (`campaign` / `segment` / progress bar / bundle / analytics reference). Its record dispatch goes through `entity-context.ts`; an analytics reference resolves against the request's `refs` with NO Personalizer call. Used when a `## Referenced Entities` block is attached and the model needs to drill into one of them.

This is the KEY divergence from the twin prompt `onboarding-chat`, which sets `usesTools: false` and instead carries the CLIENT `look_at_page` tool. `usesTools` and `clientTools` are MUTUALLY EXCLUSIVE (a turn is EITHER server-data-tools OR the visual client tool, never both) — that is why the two are separate registry entries sharing one identity/model, not one entry with a flag.

## Attachments

None (`attachments: []`). Unlike `image-selection` / `proposals`, this prompt carries no bundled training sample or page-evidence files. Per-turn grounding data (`currentExperience`, `## Referenced Entities`, the best-practice grounding context) rides in the conversation, not in the system prompt.

## Input contract (what the lib sends)

Standard Studio `POST /chat` SSE request with `X-Personalizer-System-Prompt: chat`. The conversation carries, in context:

- **`currentExperience`** — a snapshot of what the merchant ACTUALLY has configured in their draft right now: the enabled recommendation boxes per page and each box's current appearance (`style` layout, `itemsPerPage` cards-per-row, `itemsLimit` card count). The prompt reasons over it directly instead of asking "what does it look like now?" and describes/changes relative to what's there.
- **`## Referenced Entities`** (optional) — when present, entities the merchant attached when opening the conversation; they ARE the topic. The model must ground in them and never ask "which one do you mean?", using `get_entity_context` for deeper detail. Handler-side: `context.refs` (cap 5, [`src/lib/references.ts`](../../src/lib/references.ts)) are sanitized, eagerly prefetched, rendered as the UNCACHED final Referenced-Entities system block, and threaded into the loop.
- **The LimeSpot best-practice grounding context** — the specifics playbook; the prompt prefers it over general knowledge when present.

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
- `patch` (required) — ONLY these keys: `Style` (`carousel` | `grid` | `rows` | `slider`), `ItemsPerPage` (1–12; "2-up"/"two across" = 2), `ItemsLimit` (1–50), `ImageBorderRadius` (px, 0–100), `NavigationArrowType` (`chevron` | `circleChevron` | `circleFull` | `circleArrow`). A "2-up" grid is `{ "Style": "grid", "ItemsPerPage": 2 }`.

**`toggleBox`** — ADD or REMOVE a recommendation box.

```json
{ "action": "toggleBox", "args": { "page": "<page>", "box": "<boxType>", "on": <true|false> } }
```

- `page` (required): same page grammar as `setAppearance`.
- `box` (required): one of `Popular` | `Trending` | `NewArrival` | `YouMayLike` | `RecentViews` | `BoughtTogether` | `CrossSell` | `Upsell` | `Related` | `FeaturedCollection`. Map the merchant's words to the closest one.
- `on` (required): `true` to add, `false` to remove.

The prompt notes other actions in prose (navigate a step, apply a placement, toggle a segment, activate a template) that also ride the `directives` envelope; `setAppearance` and `toggleBox` are the two with a fully specified arg schema. If a directive vocabulary changes here, the Studio UI action executor (lib side) must be updated in lockstep — these page names, box types, and patch keys are a two-sided contract.

## Relationship to the sibling prompts

`chat` is the BASE general Studio chat assistant. Its siblings on the same `/chat` tool-use path:

- **[`onboarding-chat`](onboarding-chat.md)** — the CLIENT-tool twin. SAME identity and SAME tier (the default `frontier` tier), but it DROPS the server data toolset (`usesTools: false`) and instead carries the browser `look_at_page` client tool (the store iframe is the AI's hands) so it can SEE what rendered before it answers or refines a box. `chat` reads DATA from the server; `onboarding-chat` reads PIXELS from the browser. Mutually-exclusive tool modes → separate registry entries, not a flag.
- **[`proposals`](proposals.md)** and **`onboarding`** — the other tool-use agent-loop prompts. `proposals` (on the `balanced` tier) is the per-store SETUP PROPOSAL reasoner: it runs the same server tool loop but grounds additionally in real page evidence (cleaned HTML + screenshots) and returns a single structured JSON object, not chat prose. `onboarding` is the opinionated new-merchant assistant that applies best-practice defaults over the same loop. `chat` is the general, non-opinionated conversational default the others specialize away from.

## Caching notes

Single-file prompt, so it does NOT participate in the composed-prompt byte-equivalence baseline gate (`test/onboarding-prompt-blocks.test.ts` / `test/__snapshots__/*.baseline.md`) — those cover only the four composed onboarding prompts. Editing `src/prompts/chat.md` affects ONLY this prompt; it pulls no `onboarding-shared/` blocks and no block edit can reach it. The system text is nonetheless a stable prefix per the standard `messages.ts` `cache_control` breakpoint: keep per-shop VARIABLE data (`currentExperience`, referenced entities, grounding context) in the conversation AFTER the cached system prefix, never in this file. The `context.refs` Referenced-Entities block is rendered UNCACHED as the final system block, and a refs-free build is byte-identical to a request with no refs (cache safety).

## Pinning tests

The prompt's contract is pinned by [`test/chat.test.ts`](../../test/chat.test.ts):

- _"chat prompt reasons over currentExperience grounding"_ — the system text names `currentExperience` and `itemsPerPage`.
- _"chat prompt documents the setAppearance directive + its whitelist"_ — asserts `setAppearance`, the `page` / `patch` arg shape, the "2-up" mapping, and the whitelisted patch keys (`Style`, `ItemsPerPage`, `ItemsLimit`, `ImageBorderRadius`) — which must agree with the lib-side contract.
- _"chat prompt documents the toggleBox directive"_ — asserts `toggleBox`, the `box` / `on` arg shape, add/remove intent, and box-type keys (`BoughtTogether`, `RecentViews`) that agree with lib's `ONBOARDING_BOX_TO_BRAIN`.
- The `tool definitions` block pins the frozen five-tool order (`get_store_analytics`, `list_segments`, `list_campaigns`, `get_store_config`, `get_entity_context`) and `get_entity_context`'s `input_schema`, plus the full `/chat` agent-loop + SSE behavior these tools drive.

The registry resolution (`usesTools: true`, the default `frontier` tier, non-empty prompt) is covered alongside the other registered prompts. There is no output-JSON schema snapshot — the reply is prose + an optional directive envelope, so directive shapes are enforced by the prompt text and the lib-side executor, not a fixed JSON object.
