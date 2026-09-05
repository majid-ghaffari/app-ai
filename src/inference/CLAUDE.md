# src/inference/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md)

Provider-neutral inference runtime and provider translation boundary. Handlers
construct canonical requests and consume canonical results/events. Only the
factory selects an adapter; only adapter modules know provider HTTP, credentials,
wire fields, continuation details, or model-specific feature mappings.

The per-module map — what each file owns — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md), read on demand. What binds every module is below.

## Rules

- `model-catalog.ts` is the ONE place a model id implies a provider, API family,
  capability set, and direct-file policy. It matches by model-id FAMILY PREFIX,
  never by exact id, so a new release inside a family inherits its family's
  facts; an id no family claims throws, naming the id and the variable that
  supplied it, rather than defaulting to a provider. Model IDS are
  configuration; what a model IS is a fact and lives here. A family prefix
  resolves to exactly one provider: two accounts serving one vendor's weights
  are separated at the prefix rather than guessed, and the catalog rejects a
  nested prefix pair that would resolve to different providers.
- Adapters accept only fully resolved `ModelProfile`/`FilePolicy` authority from
  the registry path. They do not infer providers from model names.
- The runtime never switches on a provider. Adapter selection belongs only in
  `factory.ts`, and a provider the catalog can name but no adapter serves fails
  there, before provider I/O.
- Public file tokens carry no provider authority. The preparation seam resolves
  them from metadata and validates provider account, file policy, API family,
  expiry, and compatible prompt group before selecting an adapter.
- A public file token that cannot open is client input, not a provider fault:
  malformed, tampered, expired, or off-route references raise `WorkerError`
  400 `ArgumentException`, and one sealed for another tenant raises 403
  `UnauthorizedAccessException` — the same answers `DELETE /files/{id}` gives.
  No provider was consulted, so no `*ApiException` is ever the envelope.
- Provider state stays opaque to the runtime and is forwarded on continuation
  turns. The adapter validates whether it can consume that backend state.
- Public continuation is authenticated, expires, and is bound to the validated
  tenant + prompt group + model profile before provider I/O. It may name only a
  production provider: the local development fulfillers `InferenceBackendName`
  also covers exist inside the dev shim, so a token naming one is refused.
- `token-sealing.ts` is the ONE implementation of sealed public tokens: the
  shared secret's validation, HKDF key derivation per named purpose, the
  AES-GCM envelope with the token prefix as associated data, and unpadded
  base64url. `file-references.ts` and `continuation.ts` consume it and own
  only their prefix, purpose, envelope shape, and route checks. Their wire
  formats are pinned by fixtures in `test/token-sealing.test.ts`.
- Adapters mark state `requiredOnNextTurn` only when an ordinary terminal turn
  must round-trip opaquely (Gemini thought signatures). `/chat` and registered
  `/messages` then return/accept the sealed token; ordinary Anthropic text keeps
  its established response shape.
- Server/client tool ownership is expressed by the `AgentRequest` discriminated
  union. Browser tools are returned; the worker never executes them.
- Every transport error, abort, timeout, HTTP failure, and invalid response is
  normalized as `InferenceFailure` before leaving an adapter.
- Production code remains dependency-free and uses Web `fetch` plus local types.
- Paid local/test provider calls require the explicit channel opt-in documented
  in the root and `docs/TESTING.md`.
- OpenAI is factory-selectable for deterministic adapter tests and the explicit
  paid smoke matrix, but no production prompt group selects it before recorded
  prompt-level evaluations. Responses continuation uses adapter-owned
  `previous_response_id`; the runtime and public client carry it opaquely.
- OpenAI File metadata does not report MIME. Route-scoped dedup records retain
  validated upload MIME so cached images cannot be reclassified as documents.
- Canonical OpenAI cache intents become explicit breakpoints only on Responses
  `input_text`, `input_image`, and `input_file` blocks. The adapter uses explicit
  `30m` mode, supplies a group/profile-stable cache key, and rejects more than
  four writable breakpoints before provider I/O. OpenAI currently exposes no
  distinct extended TTL, so `short` and `extended` preserve the same canonical
  boundary under that provider policy.
- Gemini is factory-selectable only for deterministic adapter tests and the
  double-opt-in paid probe matrix. No production prompt group selects it. It
  serves the `gemini-3` family exclusively — the generation with a documented
  `thinkingLevel`, a documented `functionCall.id`, and mandatory thought
  signatures — and refuses any other id, including models that publish other
  generation methods.
- Gemini carries `thoughtSignature` in sealed continuation state. The value is
  part-level, present only on the first `functionCall` part of a parallel batch,
  and mandatory on replay, so the adapter stores the exact `role:"model"`
  content it received and replays it verbatim; a response whose first function
  call carries no signature, and a replay whose signature was lost, both fail
  before provider I/O. `requiresOrdinaryTurnContinuation` is always true, which
  is what carries the signature across the browser client-tool hop.
- Gemini honours no INLINE cache breakpoint, so a canonical cache intent maps to
  no request field. It caches implicitly instead, rewarding a request PREFIX that
  repeats across calls, so the intent is honoured by ORDER: every component that
  repeats for a prompt — system instruction, tool declarations and config,
  generation config — is emitted before `contents`, canonical block order inside
  `contents` is preserved so reusable evidence leads and per-call content trails,
  and nothing in that prefix varies per request. The explicit `cachedContents`
  resource is a separate lifecycle no adapter owns. `inlineCacheBreakpoints` is
  therefore false for this family — a statement about the mechanism, not about
  whether the provider caches.
- Gemini's `maxOutputTokens` is ONE budget covering thinking AND the answer,
  where a canonical `maxOutputTokens` means the answer alone. The adapter sends
  the canonical budget plus a thinking allowance chosen for the resolved
  `thinkingLevel`, and always sends that level — including for a request that
  declares no effort — so the reserved share is declared rather than guessed.
  `adapters/gemini-output-budget.ts` states that sizing once and carries no
  imports, because the paid probe matrix sizes its requests through it too.
- A terminal Gemini turn carrying neither visible text nor a tool call is a
  normalized failure, not an empty success: a shared budget spent entirely on
  thoughts returns HTTP 200 with only `thought: true` parts, which is
  indistinguishable downstream from a model that said nothing. A prompt-level
  block stays the `content-filter` stop reason.
- Gemini structured output sends the normative REST reference's flat
  `responseMimeType`/`responseSchema` fields. A current guide page shows a
  nested `responseFormat.text` wrapper instead; that shape is unverified and is
  closed by `npm run verify:gemini`. Gemini guarantees syntax only, so a strict
  structured-output requirement and a strict tool schema are both refused.
- Gemini reports a cache hit INSIDE `promptTokenCount`, the opposite of
  Anthropic's disjoint accounting, so `cachedInputTokens` is a subset of
  `inputTokens` for this provider.
