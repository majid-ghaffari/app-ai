# Billing assistant prompt

## Purpose

`billing-assistant` powers a conversation inside LimeSpot subscription experiences. It
answers concise questions about the plan currently displayed to the merchant without exposing tools
or changing account state. An unrelated question is redirected to the rest of LimeSpot Growth
Agents after activation; Studio names only the on-storefront editor and is not the surrounding
platform.

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
