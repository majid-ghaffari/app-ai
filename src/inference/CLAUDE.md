# src/inference/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md)

Provider-neutral inference runtime and provider translation boundary. Handlers
construct canonical requests and consume canonical results/events. Only the
factory selects an adapter; only adapter modules know provider HTTP, credentials,
wire fields, continuation details, or model-specific feature mappings.

The per-module map — what each file owns — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md), read on demand. What binds every module is below.

## Rules

- `model-catalog.ts` is the ONE place a model id implies a provider, API family,
  capability set, and direct-file policy. Versioned families match by prefix;
  provider-fixed Kimi/Moonshot service aliases match exact documented ids. A
  new release inherits facts only inside a versioned family; an id no family
  claims throws, naming the id and the variable that
  supplied it, rather than defaulting to a provider. Model IDS are
  configuration; what a model IS is a fact and lives here. Every routing
  entry resolves to exactly one provider. Versioned families match by prefix;
  the metered Moonshot account accepts its four exact `kimi-k*` ids and the
  subscription accepts its four exact `k3` / `kimi-for-coding` ids.
  Undocumented aliases, including `moonshot-*`, match no family, and the catalog
  rejects overlapping claims that would resolve one id to different providers.
  The catalog also records each model generation's documented maximum output
  (`modelMaxOutputTokens`, longest prefix wins, throwing for an unrecorded
  generation), which the registry's `MODEL_MAXIMUM_OUTPUT` budget resolves
  through and the Gemini adapter caps its shared thinking-plus-answer budget at.
  Exact Kimi/Moonshot Chat Completions ids use 131072, the documented K3
  default and the Kimi Code 128K safety ceiling, so conductor routes remain
  below the context-dependent provider maximum.
  `/health` readiness and `GET /prompts` resolve every prompt's budget, so an
  unrecorded generation is reported before a request.
- `reusableFiles` means app-ai can honor its opaque upload-reference contract
  for a model; `providerFiles` means the provider itself owns a complete Files
  lifecycle. Kimi has reusable files through encrypted R2 but its provider
  Files metadata and delete endpoints do not work.
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
  must round-trip opaquely, as Gemini does for thought signatures. Moonshot and
  Kimi ordinary text is replayable from public history; their tool transcripts
  carry sealed state because hidden reasoning and calls must remain exact.
- An adapter whose continuation contains the complete internal agent transcript
  declares `continuationOwnsAgentHistory`. The shared loop then rebuilds each
  iteration from the initial public messages plus the latest assistant/tool
  turn, and the adapter replays its sealed transcript. OpenAI, Gemini, and
  Moonshot/Kimi own that replay; Anthropic receives the canonically accumulated
  message history. Adapters that need accumulated agent usage own its
  provider-shaped aggregation; Moonshot/Kimi and Gemini sum their internal
  calls. Anthropic retains its established terminal-turn raw usage envelope, so
  production `/chat` behavior is unchanged.
- Server/client tool ownership is expressed by the `AgentRequest` discriminated
  union. Browser tools are returned; the worker never executes them.
- Every transport error, abort, timeout, HTTP failure, and invalid response is
  normalized as `InferenceFailure` before leaving an adapter.
- `deadline.ts` is the ONE upstream inference deadline. The service runs every
  adapter `complete`/`stream` call, and the factory runs the unregistered
  passthrough, under it, alongside the caller's cancellation. No adapter,
  handler, or prompt sets another time limit on a model call. A call the
  deadline ends becomes the 504 `InferenceTimeoutException` failure with code
  `inference_timeout`
  ([docs/DECISIONS.md → One upstream inference deadline, owned by app-ai](../../docs/DECISIONS.md#one-upstream-inference-deadline-owned-by-app-ai)).
- The Anthropic adapter's `complete` streams upstream and assembles the events
  into the exact non-streaming message body, so registered `/messages` keep
  their JSON response while large output budgets stay on the transport the
  provider recommends for them.
- Production code remains dependency-free and uses Web `fetch` plus local types.
- The Cloudflare adapter accepts one inline image, emits Qwen's OpenAI-compatible
  multimodal message shape, disables thinking, propagates request cancellation,
  enforces the documented text/token/PNG byte-and-dimension free-allocation bounds,
  reserves the protected daily quota only after validation under the canonical diagnostic or
  acceptance class, never derives that class from caller metadata, and reads raw binding responses
  so provider status and error codes survive normalization.
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
- Moonshot/Kimi is factory-selectable only for deterministic adapter tests and
  the double-opt-in paid smoke matrix. No production prompt group selects it.
  The candidate uses strict Chat Completions JSON Schema/tools, base64 or
  `ms://` image inputs, an image-purpose direct file policy, and adapter-owned
  assistant `reasoning_content` replay. External image URLs, non-image direct
  files, Kimi sampling overrides, arbitrary metadata/service tiers, hosted
  tools, unsupported image MIME, forced-specific/undocumented parallel-tool
  controls, and media tool results fail before provider I/O. A stream is successful
  only after an exact terminal finish, validated final usage, and `data: [DONE]`.
  A following empty-choices chunk may repeat identical terminal usage; conflicting
  counts fail the stream. Captured nullable members are accepted on their known
  fields and unknown delta members fail closed. The Kimi paid matrix verifies
  streamed tool-call assembly and full-reasoning tool replay live. Deterministic
  split-frame tests pin every streamed delta and lifecycle boundary for both
  accounts. Usage normalization reads cached input tokens from the
  top-level or nested prompt detail and reasoning tokens from the nested
  completion detail, rejecting inconsistent duplicate cache counts.
  Neither account honours an inline cache breakpoint, so `inlineCacheBreakpoints`
  is false for both even though the platform may cache a prefix on its own.
- One Chat Completions implementation serves two credentialed accounts. An
  account descriptor in `adapters/moonshot.ts` carries the transport, provider
  identity, model namespace, and metered Files API. The catalog resolves exact
  Kimi/Moonshot ids to stable profiles; the adapter keys wire behavior from
  those profiles rather than maintaining a second model-id authority.
- Kimi's `worker-file` / `worker-managed` policy stores encrypted image and
  text evidence in `INLINE_EVIDENCE_R2` behind the existing tenant- and
  route-bound reference. `kimi/evidence.ts` owns encryption, expiry,
  revocation, and byte recovery. Kimi's image upload returns a compact `ms://`
  reference; an encrypted R2 sidecar reuses that upstream id for repeated
  inference. A missing-resource 404 before a complete response or any stream
  event invalidates the sidecar and retries once from encrypted bytes. Text
  evidence is decoded and sent as text. Uploads are bounded before buffering,
  and oversized uploaded HTML is accessed through bounded internal search/read
  tools. One request decrypts each selected HTML object once and reuses that
  bounded plaintext across its internal agent turns. All routes retain their public tools after exact selected fragments
  replace the full HTML. The internal transcript
  stays in app-ai and usage is aggregated across calls. A remaining request
  over 2 MiB fails before the completion call with 413. Kimi's coding
  endpoint currently answers 404 for
  file metadata and deletion, so deleting a public reference revokes app-ai's
  copy and sidecar, while upstream retention follows Kimi's own policy.
- Ordinary assistant text is replayable from public history without a
  continuation token. Tool transcripts still require sealed provider state so
  hidden reasoning and tool calls remain exact across internal and client-tool
  boundaries. That state owns the accumulated internal agent transcript, so the
  shared loop sends only initial public history plus the latest tool boundary;
  the adapter replays every earlier reasoning, call, and result exactly once.
- The subscription endpoint accepts `k3`, `k3-256k`, `kimi-for-coding`, and
  `kimi-for-coding-highspeed`. K3 and the K2.8 model behind `kimi-for-coding`
  accept semantic effort through `reasoning_effort`; K2.7 HighSpeed preserves
  thinking without an effort control. The Kimi Code CLI can connect to other
  providers with separate credentials; those model IDs do not become Kimi
  subscription models.
- Both accounts speak one Chat Completions API, so an upstream failure from
  either is answered as `MoonshotApiException` (`lib/responses.ts`). A sealed
  file reference that will not open is client input under the shared rule above
  and consults no provider, so it is never that envelope.
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
- Cloudflare Workers AI serves only the protected visual-verification group, which
  fails closed unless it resolves to exact model `@cf/qwen/qwen3.8-27b`. Its adapter accepts one inline base64 image plus text, performs one
  non-streaming binding call, and returns the existing canonical result. It has
  no tools, continuation, direct uploads, streaming, or reasoning controls. Its
  inline image uses the documented data URI and provider failures preserve their
  HTTP status and internal code; only 408, 429, and transport failures are retryable.
