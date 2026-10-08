# Multi-Provider Inference: What Ships and What Governs a Route Change

The worker runs every prompt through one provider-neutral inference runtime. A prompt names
nothing about a vendor; configuration names a model; the model decides the vendor. This document
describes what that system is made of, what each part guarantees, and what a change of production
provider has to prove before it is allowed.

The executable statements of everything here are `src/prompt-registry.ts`,
`src/inference/model-catalog.ts`, `src/inference/`, and the suites listed under
[TESTING.md](TESTING.md). Where this document and the code disagree, the code is right and this
document is a defect. The prompt inventory and evidence-reuse graph are
[PROMPT-GROUPS.md](PROMPT-GROUPS.md); which module owns which part of the runtime is
[ARCHITECTURE-MAP.md](ARCHITECTURE-MAP.md) → `src/inference/`.

## The ownership boundary

app-ai is the only owner of AI provider and model selection. A caller supplies a registered prompt
contract name, merchant/runtime data, and the opaque file references app-ai minted for it — nothing
else. It never sends, learns, or overrides a provider name, model id, model profile, provider file
purpose, or ordinary model override, and a provider, model, or capability claim is accepted from
nowhere but app-ai's own code and configuration. Controlled app-ai-local and test seams may override
a profile without widening the public contract.

The system routes through no third-party AI gateway, rewrites no prompt text in transport, and
claims no cross-provider parity by silently dropping tools, files, structured output, reasoning,
caching, or usage data. Provider-managed routes upload bytes directly. Kimi's worker-managed file
policy stores encrypted evidence in a private R2 bucket so the same public `/files` references can
be materialized as text or compact `ms://` image inputs across HTTP requests.

## The routing chain

```text
prompt name → prompt group → capability tier → configured model id → model family → provider
```

Each link is owned by exactly one place, and none of them is a caller:

- **Prompt → group.** Every registered prompt belongs to exactly one prompt group. The group
  declares the capability tier it runs on and the capabilities it requires, and nothing else about
  a vendor.
- **Group → model id.** The tier binds to `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER` in
  `wrangler.toml [vars]`, with sparse per-prompt exceptions in `MODEL_OVERRIDES`. Model IDs are
  configuration; a key in `MODEL_OVERRIDES` that names no registered prompt or prompt group throws
  rather than being ignored.
- **Model id → provider.** `src/inference/model-catalog.ts` maps versioned family prefixes and exact
  provider-fixed Kimi/Moonshot ids to the provider, API family, capabilities, and direct-file policy
  that model implies. What a model IS is a fact about the model, so it lives in code; a new release
  inherits facts only inside a versioned family. An id no family claims throws,
  naming the id and the variable that supplied it — there is no default provider to fall through
  to, because guessing one is how a credential, a file route, and a tenant's evidence reach the
  wrong vendor.
- **Route validation.** Every resolution is checked before any provider I/O: the resolved
  capabilities must cover the group's declared requirements, the file policy must fit the resolved
  API family, and a per-prompt exception may not move one prompt off the provider file route its
  group shares. This is what makes a settings-level provider switch safe rather than merely
  possible.

The group is the compatibility boundary for prompts that reuse uploaded evidence: every
file-reusing fallback, repair, retry, or chunk edge stays inside a compatible group. A file policy
declares its provider and compatible inference API families explicitly, and registry validation
rejects a group that pairs a profile with a file policy for a different route, so compatibility is
never inferred from a name. Registry initialization and `test/prompt-groups.test.ts` enforce both.

`GET /prompts`, master-gated, reports the resolved end of that chain for every registered prompt
under the live configuration, plus the names of any required secrets still blank.

## The canonical runtime

Handlers build `InferenceRequest` / `AgentRequest` values and consume canonical results and events.
They never construct a provider payload, read a provider credential, or branch on a provider name.

- `src/lib/inference-types.ts` — the canonical content, request, event, result, tool, usage, error,
  file-reference, capability, model-profile, and file-policy contracts.
- `src/inference/service.ts` — the shared multi-turn tool loop and conversation cache breakpoints.
- `src/inference/factory.ts` — the ONE place a provider name and API family select an adapter. A
  provider the catalog can name but no adapter serves fails here, before provider I/O.
- `src/inference/adapters/` — one directory per provider. Each owns its serialization, streaming,
  files, structured output, reasoning controls, usage, stop reasons, cancellation, and error
  normalization. Every transport error, abort, timeout, HTTP failure, and invalid response leaves an
  adapter as a normalized `InferenceFailure`.

The service surface is `complete`, `stream`, and `runAgent`. Canonical types cover system, user,
assistant, and tool content; text, image, document, and opaque file inputs; structured-output
requirements; semantic effort and reasoning controls; server and browser custom tools with
strict-tool controls, plus adapter-owned provider-hosted tool definitions; streaming deltas and
terminal results; and usage, stop reasons, normalized errors, and provider continuation state. The
agent request is a server/client discriminated union, so no server executor can be present for a
browser-owned tool mode. Canonical tool input schemas retain full JSON Schema for strict function
calling, including an object schema that declares no properties. Provider-hosted definitions stay
opaque and are accepted only by their owning adapter. Compatibility parsing never relabels ordinary
assistant history as another provider's continuation state, and `/messages` and `/chat` import no
provider wire type and construct no provider payload.

Browser-owned tool calls cross HTTP requests through an opaque continuation token. A `/chat`
terminal payload that returns `toolCalls` also returns a `continuation` token; the client appends
its tool results and echoes the token on the next `/chat` request. The token grants no
provider-selection authority: app-ai resolves the prompt route first, then authenticates and
decrypts state bound to the validated tenant, prompt group, and model profile. Malformed, tampered,
expired, cross-tenant, cross-route, and cross-provider continuation fails before provider I/O.

Anthropic additionally owns prompt caching, the free token pre-flight, and the bounded raw
`/messages` compatibility path for an absent or unknown prompt selector.

## Prompt-aware direct files

Every `POST /files` upload declares one or more registered destination prompts. app-ai resolves each
destination to its group's file route, collapses duplicates — including groups that borrow another
group's route, so a cascade's evidence is uploaded once — uploads distinct routes concurrently, and
returns opaque authenticated references: one primary reference plus a `references` map naming every
declared prompt, so a caller reads the reference for the prompt it is about to run whether the
declared prompts resolved to one route or several. Provider-managed routes send bytes directly to
the provider. A Kimi route stores encrypted image and text bytes in `INLINE_EVIDENCE_R2`, bounded
by the reference's expiry, and uses Kimi's image Files upload to keep model requests small.
When the combined uploaded HTML would crowd Kimi's request limit, the adapter
keeps large documents in R2 and asks Kimi to search or read exact fragments
through bounded internal tools before the public completion or chat stream.

A public reference carries no provider authority in its identifier: the route is sealed inside it
under `TOKEN_ENCRYPTION_SECRET` and bound to a keyed tenant pseudonym. Resolution rejects a
malformed, expired, tampered, cross-tenant, cross-account, cross-policy, or cross-group reference
before an adapter is selected. `DELETE /files/{id}` reads the provider out of that sealed reference.
No verb enumerates a provider account: one account holds every tenant's uploads, so a listing could
only answer with files its caller never uploaded, and `GET /files` is not a route.

The catalog distinguishes `reusableFiles`, which means the app-ai upload and
reference contract works, from `providerFiles`, which means the provider owns
the full upstream file lifecycle. Kimi's worker-managed evidence has the first
capability and lacks the second.

### Kimi provider constraints

The Kimi coding endpoint accepts image uploads and serves their compact `ms://`
identifiers, but its metadata, content-read, and delete operations return 404.
Deleting an app-ai reference revokes the encrypted R2 object and hosted-id
sidecar; an image already accepted by Kimi follows Kimi's retention policy.
Overlapping first use can upload unreachable duplicates because provider I/O
is request-owned; later requests reuse the completed encrypted sidecar.

Kimi limits a Chat Completions body to 2 MiB. Uploaded images stay outside that
body as `ms://` references, and oversized uploaded HTML is reduced through the
bounded internal retrieval loop. A request still over the provider limit returns
413 before paid completion I/O. Retrieval requires at least one retained exact
fragment from every stored document and stops after eight tool turns; failure to
meet either condition is an invalid provider result rather than a partial answer.

Provider-scoped dedup metadata records only what validating and deduplicating the upstream object
needs — provider, account scope, file policy, content hash, upstream file id, media type, expiry, and
compatible group identity — and expires no later than the upstream file. A group whose evidence must
survive a cross-provider fallback uploads to both routes up front; without those copies the fallback
is unavailable and fails explicitly.

## Providers

| Provider                   | Status                      | What it is used for                                                                                                                                             |
| -------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Messages         | Primary production provider | Every production prompt except the protected-CI visual judge resolves to Anthropic.                                                                             |
| Cloudflare Workers AI      | Protected visual judge      | One inline-image, non-streaming route used by protected CI within the daily free allocation.                                                                    |
| OpenAI Responses           | Adapter present, unrouted   | Deterministic adapter contract tests and the explicit paid smoke matrix.                                                                                        |
| Moonshot Chat Completions  | Adapter present, unrouted   | Metered platform account with deterministic contract tests and an opt-in paid smoke matrix; in production only a route carrying no customer content may use it. |
| Kimi Code Chat Completions | Adapter present, unrouted   | Subscription account with deterministic contract tests and an opt-in paid probe matrix; in production only a route carrying no customer content may use it.     |
| Gemini                     | Adapter present, unrouted   | Deterministic adapter contract tests and the double-opt-in paid probe matrix.                                                                                   |
| Claude Code, Codex         | Local development only      | The free local fulfillers behind the dev shim; never bundled, never reached in production.                                                                      |

An unrouted adapter is reachable only by configuring a model in its family. Doing so is a
deliberate act with the conditions below attached to it, and in production it is possible only for a
provider the AI provider allow-list lets serve that route: the allow-list mirrors the DPA's AI
sub-processors, and Moonshot and Kimi Code may serve only a route that carries no customer content
([AI-PROVIDERS.md](AI-PROVIDERS.md)).

The Workers AI route is isolated in `free-render-verification`: it shares prompt text and the
public `/messages` envelope with `visual-verify`, but it accepts exactly one inline image and no
provider-file reference, tools, continuation, or streaming. Its request path and production health
fail closed unless the route resolves to exact model `@cf/qwen/qwen3.8-27b` through the Cloudflare
family and has the `AI` binding. Brain must prove the caller holds `AdministerAllSubscribers`, and a separately
addressed instance of the existing Durable Object authority reserves one of the configured UTC-day
calls before inference. The deployment kill switch is required; the license-free Qwen vision model
still receives one authenticated live smoke before lib targets the route.

Anthropic Messages is the parity reference: streaming, files, attachments, server/client tools,
prompt caching, effort, token estimates, usage, errors, and the handler responses are defined by its
behavior, and every other adapter is measured against them. Provider-specific behavior the adapters
own, and which a route change inherits:

- OpenAI keeps no stored Responses object: every Responses call sends `store: false` and no
  `previous_response_id`. It still holds its automatic prompt-cache state — in memory for minutes,
  or up to 24 hours of extended caching for an organization without Zero Data Retention — and app-ai
  requests no explicit cache. No stored Responses object, app-ai continuation state or output-item replay crosses a request boundary, while OpenAI's automatic prompt-cache state can persist across calls (in memory for minutes, or up to 24 hours without Zero Data Retention), so an OpenAI route serves one public turn: it offers no
  continuation, refuses a request carrying one, an earlier assistant turn, a tool result or caller
  tools, and cannot route a conversation that carries earlier turns or browser-owned tools. Within a request, a
  reasoning model returns its reasoning encrypted (`include: ["reasoning.encrypted_content"]`), and
  a tool-call turn's untouched output items are replayed on the next server-tool iteration, only
  within that one request. OpenAI File metadata omits MIME, so route-scoped dedup records
  retain the validated upload MIME and a cached image can never be reclassified as a document.
  OpenAI requests ask for no explicit or extended prompt caching (no cache options, breakpoints,
  retention or cache key); every `gpt-` model is the one `gpt` profile, which declares no inline
  breakpoints, and OpenAI's automatic prompt caching is all that applies
  ([AI-PROVIDERS.md](AI-PROVIDERS.md) → Retention, per provider). The adapter follows the current
  Responses schema rather than Anthropic assumptions.
- Gemini uses `generateContent` over `x-goog-api-key`, serves the `gemini-3` family only, and
  completes a stream on a clean close after a finish reason because the provider publishes no
  terminal sentinel. `thoughtSignature` is part-level, mandatory on replay, and therefore stored and
  replayed verbatim through sealed continuation state, so Gemini also marks state
  `requiredOnNextTurn`. Its `maxOutputTokens` is one budget shared by thinking and the answer, so the
  adapter sends the canonical answer budget plus an allowance for the thinking level it always
  declares, and a terminal turn that produced neither visible text nor a tool call is a normalized
  failure rather than an empty success. It honours no inline cache breakpoint — canonical cache
  intents map to no request field and its capability declaration says `inlineCacheBreakpoints:
false` — and caches a repeated request prefix implicitly instead, which the adapter earns by
  emitting every repeating component before `contents` and preserving canonical block order inside
  it. Strict structured output and strict tool schemas are refused because its schema guarantee is
  syntactic only.

## Local fulfillers

The development channel is selected by app-ai configuration alone and defaults to the free path.
Claude Code carries streaming and the server/client tool bridge. Codex serves one-shot, tool-free
visual/structured prompts through the official non-interactive `codex exec` path — ephemeral
execution, an explicit model, image inputs, structured output, cancellation, strict parseable
events, disabled agent tools, and a secret-minimized child environment — and a streaming or tool
request to it fails closed: no Codex path skips, fabricates, or silently executes a browser-owned
tool. Concrete model ids are configuration for both.

## Cost isolation

Paid inference never runs from development or test. Provider base accessors refuse a non-loopback
origin outside production unless `AI_CHANNEL=prod` is explicit, and the cred-burn guard fails any
dev or test configuration that points at a paid origin without it. The local shim fulfils inference
through Claude Code or Codex using the machine's own auth, so a local run spends nothing.

## Stable external contracts

These stay backward compatible and change only through a separately approved versioned migration:
the `/chat` SSE and JSON events, `/messages` responses, Brain-shaped errors, authentication and
CORS, the onboarding ruleset handshake, and `/health`. Every reference `POST /files` mints is
route-validatable and opaque; the one path that carries a raw Anthropic file id is the bounded
absent/unknown-selector `/messages` proxy. The `/files` body's in-place versioning and the
deployment order it imposes are the live-surface hard rule in the root [CLAUDE.md](../CLAUDE.md) →
Hard rules.

## Observability

A trace records the resolved prompt, prompt group, model profile, provider, normalized usage,
tools, latency, and failure class — never file contents, image/document ids, credentials, context
IDs, or provider secrets; the redaction is the logger's ([ARCHITECTURE-MAP.md](ARCHITECTURE-MAP.md)
→ `src/lib/`). Local inference traces are development-only, fail open, and never delay inference.

## Gates

Every change clears this repository's five gates — `npm run lint`, `npm run format-check`,
`npm run typecheck`, `npx vitest run` with root's published-DPA checker beside it,
`npm run deploy:dry-run` — listed with their CI wiring in
[CLAUDE.md](../CLAUDE.md) → CI + deploy. The suites that specifically hold this system together are
registry inventory/fallback/capability fitness, model-catalog resolution, upload
routing/dedup/reference compatibility, adapter request/response/stream fixtures, canonical
server/client tool-loop parity, handler architecture boundaries, local fulfiller translation and
no-credit guards, and the cross-repo app-ai/lib contract fixtures. What each spec covers is
[TESTING.md](TESTING.md) → "What each spec covers".

The fitness suites reject: a prompt without exactly one valid group; an orphan group, model family,
or file policy; a configured model id no family claims; a `MODEL_OVERRIDES` key naming no
registered prompt or group; a file-reusing fallback edge crossing incompatible groups; provider or
model selection outside the registry and config modules; provider imports or provider `fetch` calls
outside adapters; an upload without a valid prompt destination; a file reference used by an
incompatible group; a capability/profile mismatch; and a paid local provider call without the
explicit opt-in.

## What a production route change must prove

Pointing a tier at another provider's model is a configuration change, and the guardrails above make
it fail closed rather than silently degrade. That is not the same as it being a good idea. Before a
production prompt group is served by a different provider:

1. **The capability claim is real.** The catalog's declared capabilities for that model family are
   verified against the provider's current documentation, not inherited from a sibling family. A
   capability declared wider than reality is how an unsupported request reaches a provider.
2. **Prompt-level evaluations are recorded.** Quality, latency, and cost are measured per prompt
   against the current route. A prompt's output contract is frozen; a new provider either satisfies
   it or the prompt is re-authored as its own change.
3. **File-bearing routes have both copies.** The runtime never downloads evidence from one provider
   and rehosts it to another. A group whose evidence must survive a fallback uploads to both routes
   before inference.
4. **The review looks at the failure paths, not the happy one.** Provider leakage, fallback file
   reuse, no-byte-storage compliance, stale and expired references, tool continuation, streaming
   cancellation, usage and error normalization, credit guards, and whether the documentation still
   tells the truth.
5. **The change is reversible.** It is one `[vars]` edit, so the revert is one too — which only
   holds while no prompt, handler, or lib caller has grown a provider-shaped assumption.
6. **A Kimi route clears its provider gates.** The required paid smoke matrix passes against the
   configured subscription model, on a route that carries no customer content.
7. **The provider is on the allow-list for that route.** Production validation refuses any other
   before serving. A provider not yet on the DPA's AI sub-processor list is added to the root
   `ai-providers.json` first, then to the website DPA, and the Privacy Policy where its retention or
   training terms differ, then to the allow-list; no route carrying customer content selects it
   before that DPA is live, which CI's published-DPA check enforces
   ([AI-PROVIDERS.md](AI-PROVIDERS.md)).

## Adding a provider

A provider is complete when it has an adapter under `src/inference/adapters/`, its model families
in the catalog, its endpoint and key in configuration, deterministic offline contract fixtures for
every capability it claims, and a credit-guarded opt-in smoke path. Until a model in its family is
configured on a tier, it is present and unrouted — which is what makes the adapter's fixtures the
only thing standing behind a route change. The Worker stays dependency-free in production; adapters
use `fetch` and local canonical types.

`main` is read-only to every agent and a push to it deploys production, so the deploy itself is an
operator action carrying its own approval ([CLAUDE.md](../CLAUDE.md) → Hard rules).
