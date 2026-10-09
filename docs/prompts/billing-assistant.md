# Billing assistant prompt

## Purpose

`billing-assistant` powers a conversation inside LimeSpot subscription experiences. It
answers concise questions about the plan currently displayed to the merchant without exposing tools
or changing account state. An unrelated question is redirected to the rest of LimeSpot Growth
Agents after activation; Studio names only the on-storefront editor and is not the surrounding
platform.

## Composition

The system text is composed in
[`src/prompts/billing-assistant/index.ts`](../../src/prompts/billing-assistant/index.ts): its
identity (`_identity.md`), then the agents master rules every conversational owner-facing prompt
carries (`assistant-shared/agents-master-rules.ts`, described in
[chat.md → Scope and guardrails](chat.md#scope-and-guardrails)), then its own rules (`_rules.md`):
the narrower billing scope, the grounding authority, the latest-slider rule, no secrets and no
mutation, and its tone. The master rules set the outer bounds and its own rules narrow them: it
answers only about the displayed plan and no other LimeSpot feature, not even in part, explains what the plan data says about trials, cancellation
and coupons, and offers Support for a refund, a cancellation, a plan exception or a disputed charge
rather than acting on one. The composed text, final newline included, is byte-pinned to
`test/__snapshots__/billing-assistant.baseline.md`.

## Runtime contract

- Endpoint: `POST /chat`
- Header selector: `X-Personalizer-System-Prompt: billing-assistant`
- Capability tier: `balanced`
- Output budget: 768 tokens
- Tools: none
- Attachments: none

## Input

The normal `/chat` message history is accompanied by `context.grounding`. The grounding object owns
the live plan title, currency, billing period, trial length, platform billing description,
calculated monthly GMV, currently selected tier, and the complete displayed tier list. The client
refreshes that object on every turn so a slider change takes precedence over an older conversational
reference.

No plan identifier, payment credential, or other secret is needed. Card data belongs exclusively in
the secure payment form and must never enter the chat.

## Output

The output is short conversational prose. A small bullet list is allowed when useful; headings,
tables, code blocks, JSON, directives, and account mutations are forbidden. Commercial facts must
come from the current grounding. Missing facts produce an explicit limitation and a support or sales
handoff instead of a guess.

## Safety boundary

The prompt is explanatory only. It cannot activate, cancel, change, discount, or otherwise mutate a
subscription. Merchant messages and grounding values are treated as untrusted data and cannot
override the system rules.

## Verification

`test/chat.test.ts` pins the registry metadata and the prompt's grounding, no-secrets, no-mutation,
concise-output requirements, Growth Agents handoff, and absence of the retired product names.
`test/assistant-prompt-blocks.test.ts` pins the composition byte for byte and that the agents
master rules follow its identity.
