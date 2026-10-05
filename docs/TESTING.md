# Testing — app-ai

**Parent:** [../CLAUDE.md](../CLAUDE.md)

The worker has four required offline test layers in the default `vitest run`
set. Optional live diagnostics can measure deployed prompt caching or explicitly
exercise paid OpenAI or Gemini candidate models when an operator chooses to run
them.

## Layers

| Layer                    | Files                                                                                                                                                                                                                        | Network       | Catches                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                     | `test/token-saving.test.ts` (pure-fn cases), `test/store-origin.test.ts`                                                                                                                                                     | Mocked        | Logic bugs in lib functions: `sha256Hex`, breakpoint placement, `supportsEffort`, `isSameStoreOrigin`                                                                                                                                                                                                                                                                           |
| Adapter/runtime          | `test/anthropic-adapter.test.ts`, `test/openai-adapter.test.ts`, `test/gemini-adapter.test.ts`, `test/continuation.test.ts`                                                                                                  | Mocked        | Canonical↔Anthropic media/tools/cache/effort/service-tier/structured-output mapping, including strict custom and provider-hosted tools; path-aware continuation cache cleanup; complete/stream/malformed-envelope/error/timeout/cancellation normalization; modern usage/reasoning fields; file lifecycle; server/client tool behavior                                          |
| Integration (handler)    | `test/chat.test.ts`, `test/ai-tool-capabilities.test.ts`, `test/proxy.test.ts`, `test/audit-auth.test.ts`, `test/grader-chat.test.ts`, `test/file-expiry.test.ts`, `test/toolsets.test.ts`, `test/platform-toolsets.test.ts` | Mocked        | Handler wiring: agent loop, capability gating, prompt-aware routed uploads, sanitized Brain failures, audit exchange/scope/concurrent Durable Object ownership/grader runs, prompt selection, dedup KV and file expiry, toolset composition and integration-bridge wire shapes                                                                                                  |
| Network (real HTTP)      | `test/keep-alive-network.test.ts`                                                                                                                                                                                            | Loopback only | A `/messages` answer lost on a client network that cuts a request idle for a while: the Worker runs in workerd through Wrangler's test harness behind a TCP proxy that drops a connection receiving no reply bytes for two seconds, with a loopback stub as Personalizer, the model and the website's status callback, and the audit Durable Object in workerd                  |
| Contract                 | the SSE/tool-shape assertions in `test/chat.test.ts` + the tool-definitions snapshot in `test/toolsets.test.ts`                                                                                                              | Mocked        | Drift between the worker's wire shapes and lib `ai/CONTRACTS.md` (§1 SSE, §2 tools)                                                                                                                                                                                                                                                                                             |
| Fitness (architecture)   | `test/architecture.test.ts`, `test/config.test.ts`, `test/logger.test.ts`, `test/prompt-groups.test.ts`                                                                                                                      | Static/mocked | Invariant erosion: prompt/group/profile/file-policy drift, destination validation before upload, incompatible fallback reuse, provider authority leaking into callers, an endpoint bypassing toolset composition, secrets reaching logs/model context, direct Worker console calls, malformed log routes, a bespoke error envelope, hardcoded config, production `[vars]` drift |
| Token-savings diagnostic | `scripts/verify-caching.mjs`                                                                                                                                                                                                 | LIVE          | Prompt caching silently failing to engage against the deployed worker                                                                                                                                                                                                                                                                                                           |
| OpenAI candidate smoke   | `scripts/verify-openai.mjs`                                                                                                                                                                                                  | LIVE, PAID    | Explicit candidate models rejecting the current Responses structured/reasoning contract                                                                                                                                                                                                                                                                                         |
| Gemini probe matrix      | `scripts/verify-gemini.mjs`                                                                                                                                                                                                  | LIVE, PAID    | The documented Gemini unknowns: whether the catalog serves the configured smoke model, structured-output shape, SSE framing and terminal sentinel, error envelope, single-shot upload protocol, snake_case media aliases, the thinking control and what it spends of the shared output budget, and the mandatory thought signature on a function call                           |

The unit / integration / contract layers mock `fetch` and `env` — no real
network, no credentials. The network layer opens loopback sockets only — the
Worker, its stub upstream and the idle-cutting proxy all listen on `127.0.0.1` —
and carries no credential beyond the test `Env` fixture. They run on every push and PR (`.github/workflows/ci.yml`).

## OpenAI Responses adapter coverage inventory

Every executable OpenAI seam is paired with deterministic offline coverage:

| Changed seam                                                                                                      | Direct coverage                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Responses request/media/cache/tool/structured/reasoning translation and strict complete/SSE lifecycle             | `test/openai-adapter.test.ts`                                                            |
| Stored-response continuation, public AES-GCM sealing, route ownership, tamper/expiry, large and over-limit states | `test/openai-adapter.test.ts`, `test/continuation.test.ts`, `test/chat.test.ts`          |
| OpenAI Files transport, account scoping, success-envelope validation, MIME-preserving dedup                       | `test/openai-adapter.test.ts`, `test/token-saving.test.ts`                               |
| Adapter factory selection and dormant-route capability/policy fitness                                             | `test/openai-adapter.test.ts`, `test/prompt-groups.test.ts`, `test/architecture.test.ts` |
| Existing `/messages` compatibility serialization for canonical non-Anthropic results                              | `test/openai-adapter.test.ts`                                                            |
| OpenAI config/secrets, production non-secret vars, dependency-free/provider-boundary rules                        | `test/config.test.ts`, `test/architecture.test.ts`, TypeScript typecheck                 |
| Paid smoke double opt-in, required config, multi-model request, structured result, usage validation               | `test/openai-live-guard.test.ts`                                                         |

Declaration shims added for executable scripts contain no runtime behavior and are
covered by the repository typecheck plus the architecture ban on TypeScript
suppression directives. No live provider credit is required by this inventory.

## Moonshot/Kimi Chat Completions coverage inventory

Every executable Moonshot and Kimi Code seam is paired with deterministic offline
coverage:

| Changed seam                                                                                                                                                           | Direct coverage                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Chat Completions text/image/file/tool/strict-structured/reasoning translation and complete validation                                                                  | `test/moonshot-adapter.test.ts`                                                                                          |
| SSE framing, required `[DONE]`, text/reasoning deltas, fragmented parallel tools, data after `[DONE]`, exact lifecycle failures, and repeated identical terminal usage | `test/moonshot-adapter.test.ts`, `test/kimi-adapter.test.ts`                                                             |
| Preserved `reasoning_content` across complete, ordinary, capped, and shared-runtime server-tool turns                                                                  | `test/moonshot-adapter.test.ts`                                                                                          |
| Moonshot Files transport, account scope, success validation, MIME-preserving upload result, and abort signals                                                          | `test/moonshot-adapter.test.ts`                                                                                          |
| A sealed file reference that will not open answered as client input, never as a provider exception                                                                     | `test/moonshot-adapter.test.ts`, `test/proxy.test.ts`                                                                    |
| The subscription account's own origin, credential, file scope, inline-only policy, and refused Files operations                                                        | `test/kimi-adapter.test.ts`                                                                                              |
| K3/K2.8 effort, K2.7 HighSpeed thinking, tool-choice gates, and sibling-account continuation rejection before I/O                                                      | `test/kimi-adapter.test.ts`, `test/moonshot-adapter.test.ts`                                                             |
| Factory selection, complete catalog/profile tables, and dormant-route provider/file-policy/capability fitness                                                          | `test/moonshot-adapter.test.ts`, `test/model-catalog.test.ts`, `test/prompt-groups.test.ts`, `test/architecture.test.ts` |
| Both accounts' config/secrets, production non-secret origins, dependency-free/provider-boundary rules                                                                  | `test/config.test.ts`, `test/architecture.test.ts`, TypeScript typecheck                                                 |
| Paid smoke double opt-in, required config, structured output, streamed tool assembly, full-reasoning replay, and exact usage                                           | `test/moonshot-live-guard.test.ts`, `test/kimi-live-guard.test.ts`                                                       |

The adapter rejects external image URLs (current Kimi Vision accepts base64 or
`ms://` file references), non-image direct-file policies, sampling overrides,
provider-hosted tools, arbitrary metadata and service tiers, media tool results,
unsupported image MIME including SVG, the K2.7 forced-specific and undocumented
parallel-tool controls, and unsupported document forms before provider I/O. Those
negative capability boundaries are frozen rather than silently degraded.
Production prompt groups remain on Anthropic.

## Test-layer doctrine

Pick the lowest layer that captures the bug:

1. **Unit first** — is it a pure function (a hash, a breakpoint calc, a model
   capability check)? Add a case to the relevant `describe` in
   `test/token-saving.test.ts`. Fastest, no handler plumbing.
2. **Adapter/runtime next** — does it translate canonical content, streams,
   tools, continuation, usage, errors, cancellation, or files? Add a deterministic
   fixture to the owning provider suite (`test/anthropic-adapter.test.ts`,
   `test/openai-adapter.test.ts`, `test/moonshot-adapter.test.ts`,
   `test/kimi-adapter.test.ts`, or `test/gemini-adapter.test.ts`).
3. **Integration next** — does it involve a handler driving the inference service
   or Personalizer dispatch (the agent loop, SSE framing, audit authorization,
   attachment injection,
   cache-control distribution)? Add to `test/chat.test.ts` (the `/chat` agent
   loop) or `test/proxy.test.ts` (the `/files` + `/messages` + auth/CORS surface).
   Mock `fetch` to return the Anthropic SSE / JSON the case needs.
4. **Contract** — does the bug involve an SSE event name, a tool definition, or a
   request/response field that must agree with the lib client? Assert the wire
   shape against `packages/storefront/src/admin/ai/CONTRACTS.md` (§1 SSE protocol,
   §2 tool definitions) — the worker is the server side of that frozen contract.
   The composed tool definitions are additionally pinned byte-for-byte by the
   file snapshot in `test/toolsets.test.ts`
   (`test/__snapshots__/tool-definitions.contract.json`) — regenerating it is a
   deliberate contract change.
5. **Fitness** — is the bug a violated standing invariant (a rule from
   CODE-PATTERNS.md / TOOLSETS.md rather than a behavior)? Extend the static
   scans in `test/architecture.test.ts` (or the config/production-value pins in
   `test/config.test.ts`) so the whole CLASS of regression is caught, not the
   one instance.
6. **Optional token-savings diagnostic** — if investigating real Anthropic
   caching behavior, use the live diagnostic below. This is useful operational
   evidence, not part of the release gate set.

## What each spec covers

One entry per spec file — the map, read on demand. It names what a spec asserts, never the assertions themselves; the spec is the source of truth for those.

- `test/anthropic-adapter.test.ts` — the canonical↔Anthropic adapter: media/tool/cache/effort/service-tier/structured-output mapping, strict complete and streaming envelope validation, path-aware continuation cache cleanup, normalized failures for malformed envelopes/timeouts/cancellations, modern usage and reasoning fields, and the provider file lifecycle.
- `test/inference-deadline.test.ts` — the one upstream inference deadline through the real Worker: a model call that outlives it answers 504 `InferenceTimeoutException` / `inference_timeout`, one that answers inside it is kept, and a registered prompt streams upstream while the caller still receives one JSON message — a bodyless upstream 200 answering as a failure, and every `message_delta` member, a refusal's `stop_details` included, surviving into that message.
- `test/keep-alive-network.test.ts` — the `/messages` keep-alive answer over real HTTP: behind a proxy that cuts a connection idle for two seconds, a three-second model call is lost to a request that did not opt in and delivered whole, as the keep-alive envelope, to one that did, its bytes never two seconds apart; a model failure reaches the opted-in request as exactly the status and error body the plain answer carries; a request without the opt-in is still answered after the model with its own status and one plain JSON body; a request with no credential, and one with a Grader bearer that does not verify, are refused while all but the first bytes of their declared body are still unsent, then answered 401 with a plain error body; and a Grader session whose caller disconnects after the first whitespace byte of a keep-alive proposal and of a keep-alive chat message still has its run recorded completed through the status callback and the message answered, logged and stored, so replaying its `messageId` returns that reply with the allowance spent once and no second model call.
- `test/keep-alive-response.test.ts` — the keep-alive mode through the Worker's fetch handler: status 200, CORS and `Cache-Control: no-store, no-transform` committed before the model answers; whitespace for the whole wait and the inference deadline's 504 as the envelope; a truncated reply's 502 carried the same way; a request without a credential answered 401 with a plain error body while its body is still unread; a large authenticated body, with and without the opt-in, read once, parsed once and never cloned on its way to the provider; the opt-in never forwarded on the unregistered passthrough; and a request with no `responseMode`, another value, or a body that is not JSON answered exactly as before.
- `test/openai-adapter.test.ts` + `test/openai-live-guard.test.ts` — the dormant OpenAI Responses candidate: dependency-free Responses/Files translation, strict complete/SSE validation, multimodal/structured/reasoning/tool/continuation/usage/error fixtures, and the offline guard that keeps the paid smoke matrix behind its explicit opt-ins.
- `test/moonshot-adapter.test.ts` — the dormant metered Moonshot candidate: dependency-free Chat Completions/Files translation, strict complete and terminal-`[DONE]` SSE validation, multimodal/structured/reasoning/tool/usage/error fixtures, preserved `reasoning_content` round-tripping through both public continuation transports and the shared server-tool loop, key-isolated file scopes with incompatible policies refused before I/O, a sealed reference that will not open answered as client input rather than a provider exception, and selection only through the provider-neutral factory.
- `test/kimi-adapter.test.ts` — the dormant Kimi Code subscription candidate on the same adapter: its own origin, bearer credential, and file scope kept off the metered account, K3 and K2.8 effort, K2.7 HighSpeed preserved thinking, tool-choice gates, inline base64 images, sealed reasoning across a streamed turn, a continuation minted for the metered account refused, quota exhaustion normalized as a fatal 403 against a retryable 429 overload, bounded retrieval turn exhaustion, complete multi-document inspection, per-request decryption reuse with failed-read eviction, and Unicode-safe fragment fitting and retrieval boundaries.
- `test/kimi-evidence-route.test.ts` — real worker HTTP upload→message and upload→chat paths for Kimi: encrypted R2 image/text evidence, smart image detection's registry sample and bounded tool retrieval of oversized HTML, combined large-HTML onboarding chat retrieval before its client-tool stream and across an ordinary continuation, thirty shared tiled images through five-page onboarding proposal, review, and QC prompts, stable hosted image reuse, one retry after an expired hosted image id, tenant isolation, deletion, storage tamper rejection, a missing-R2 failure before any provider upload, and the 2 MiB preflight before the completion call.
- `test/moonshot-live-guard.test.ts` + `test/kimi-live-guard.test.ts` — the offline guards on the two paid matrices (`scripts/verify-moonshot.mjs`, `scripts/verify-kimi.mjs`): both explicit opt-ins required, a missing precondition throwing before any provider call, and the probe selection the subscription host's absent API reference makes necessary.
- `test/gemini-adapter.test.ts` — the dormant Gemini `generateContent` candidate: the documented request contract and `x-goog-api-key` header, stable-prefix emission ahead of the volatile conversation tail, canonical system messages joined into `systemInstruction`, the shared thinking/answer budget split, rejection of every undocumented canonical control before provider I/O, camelCase `inlineData` and full `fileData` uris with undocumented media and foreign references refused, response translation (visible text, dropped thought parts, usage, a `functionCall` as a tool-call stop whatever `finishReason` says, a function call missing its thought signature, a thinking-starved or otherwise empty terminal turn, a prompt-level block as a content filter), sentinel-free streaming that completes on a clean close and fails on a truncated or in-band error frame, part-level thought-signature replay across the client-tool round trip and server-executed iterations, sealed capped tool results, fail-closed lost/foreign/mismatched continuation state, the two-call resumable Files upload with its `PROCESSING` poll and fail-closed endpoint/uri checks, stable non-secret account scope on read/delete, the `countTokens` wrapper, normalized cancellation/transport/invalid-JSON failures, and selection only through the provider-neutral factory.
- `test/gemini-live-guard.test.ts` — the offline guard on the paid Gemini probe matrix (`scripts/verify-gemini.mjs`): both explicit opt-ins required, a missing precondition throwing before any provider call, every documented unknown recorded and asserted against the shipped contract, a thinking-starved turn reported as its own outcome rather than a contract failure, a broken required probe failing loudly, an aliased smoke model accepted as the numbered snapshot it resolves to, and every generating probe budgeting thinking alongside its answer.
- `test/free-visual-verify.test.ts` — the protected visual-verification route: only the free prompt resolves to the configured Workers AI vision family, production visual verification stays on Anthropic, one inline screenshot and its intent reach the binding, and the model's verdict returns through the established `/messages` envelope.
- `test/continuation.test.ts` — the authenticated encrypted continuation transport: tenant/prompt-group/model-profile binding, expiry, and tamper rejection before any adapter state is recovered.
- `test/prompt-groups.test.ts` — the registry's group contracts: the approved prompt inventory and group map, group→tier→configured-model→provider and file-policy resolution, capability fitness, the file-reusing fallback edges and the shared provider file route behind the QC cascade, orphan validation, dormant candidate-route rejection, and the frozen prompt-aware `/files` fixture (`test/__snapshots__/prompt-aware-files.contract.json`).
- `test/chat.test.ts` — the `/chat` agent loop, SSE protocol, tool-use loop, MAX_ITERATIONS, placement no-tools path, non-streaming JSON, prompt selection, `get_entity_context` dispatch through the registry composition (record → per-record Personalizer routes/header + normalized result, analytics → refs, error degrade), and the `context.refs` handler flow (prefetch-per-ref, uncached final block, no-refs byte-identical system, 5-ref cap + one shared subscriber lookup, failure degrade, refs threaded into the loop).
- `test/ai-tool-capabilities.test.ts` — the real Worker `/chat` route through context validation, Anthropic tool-use, registry dispatch, and the mocked Brain boundary: contract-version fail-closed behavior, exact-name definition filtering, zero-call execution for unadvertised tools, required response-member validation, and raw Brain error bodies remaining operationally logged but absent from model-visible tool results, and the partial-list notice the model reads when Brain answers `X-Ls-Has-More-Results: true`.
- `test/toolsets.test.ts` — `src/toolsets/registry.ts`: composition (stable definition order, no-parties case, a party no toolset declares, per-request independence), party gating (a tool outside the composition degrades with zero backend calls), the credential seam (contextId resolved per composition and forwarded as the Personalizer header, never in the model-visible definitions, per-call `refs` extras), and the FROZEN model-visible tool contract (byte-for-byte file snapshot of the composed definitions, `test/__snapshots__/tool-definitions.contract.json`). It also drives `personalizerToolset.execute` directly, past the registry's owners map, to cover that toolset's OWN capability guard: an unadvertised name degrades with zero Brain calls, an advertised one reaches its `/v2/ai-tools/*` route, and `get_entity_context` stays available under an empty capability set.
- `test/platform-toolsets.test.ts` — the platform toolsets (`toolsets/{shopify,bigcommerce,klaviyo,google-ads}/` + `toolsets/integration-bridge.ts`): the REST/GraphQL/GAQL wire shapes toward Personalizer's `v2/integration-bridge/*` (URLs, mirrored verbs, PascalCase `Query`/`Variables`/`PageSize` bodies, JSON POST/PUT bodies, body-less DELETE), the `X-Ls-Integration-Bridge-Error` discrimination (platform 4xx/5xx surface verbatim as `ok: true` data; whitelisted `Link`/`Retry-After`/rate-limit headers surface as `result.headers`, omitted when absent; LimeSpot envelopes degrade with `<Message> (<ExceptionType>)`; network failures degrade), and the call-channel credential seam (no proxy call without a service token/context; the token never model-visible).
- `test/references.test.ts` — `lib/references.ts`: intake sanitization + cap, `refCategoryPath`, per-type `resolveRef` (record → normalized entity-context payload vs analytics → metadata, throw on subscriber failure, Found:false pass-through), the FROZEN Referenced-Entities block string (contract snapshot), label fallbacks, allSettled degradation, analytics-only → zero Personalizer calls, one-subscriber-lookup-per-block.
- `test/entity-context.test.ts` — `toolsets/personalizer/entity-context.ts`: the frozen AiToolEntityContext shape per record type (member order, Summary grammar incl. `0.##` amounts + schedule, Fields minimums, null-member omission), the campaign discount→html→image probe, tenant re-checks (cross-subscriber/deleted → Found:false), one-hop Related filtering, failure semantics (miss vs throw: 404/204/5xx → Found:false; malformed guid / unknown type / subscriber failure / 401/403 → throw), the shared subscriber lookup, and no validate-context-id roundtrip.
- `test/proxy.test.ts` — the proxy surface: CORS, response/error shape, context validation, the Anthropic client (headers/beta/URLs, config-error rejection), `manageCacheControl` (size-based ranking of user blocks plus explicit stable-prefix priority across one/two system blocks and attachments, the four-slot cap, marker stripping/order preservation), and the `/files` + `/messages` + `/health` handlers.
- `test/audit-auth.test.ts` — activation/session claims, public-origin and verified-staff entitlement, a public activation on both the bare and the `www.` form of its store with its session and status events kept on the signed origin and another store refused at the entitlement and at the authority, a reservation carried into a counterpart-form session finalizing or lapsing under the origin that admitted it, one-use exchange, stable cross-link public cap counted per completed run, the required `statusCallbackUrl` claim and its origin allowlist, bearer/route/prompt scope, parallel upload ownership, failed-attempt reuse, server-owned inference settings, grader runs (a five-page run and every offered retry, two worst-case Studio-capture runs with every whole-store resend and per-page retry, a retry's fresh run, an abandoned proposal superseded, the per-run inference ceiling and the session upload allowance at their exact production values, the whole allowance spent in one run inside a storage fake that refuses a Durable Object entry past 2 MB, a whole-store request naming every tile of a worst-case run inside the message size limit, the run limit), each owned file recorded by the digest of its reference and ownership stored as file references admitted, the session record held inside the Durable Object entry limit through a callback outage across reissued sessions at the full inference churn (reservations refused 503 `AuditSessionBacklogException` past its 1 MB budget and resumed once delivery drains it), the latest 1,024 consumed activations and two sessions of abandoned reservations retained, a new activation superseding the active session (the old token refused `audit_session_expired`, completed attempts, outbox and consumed activations carried, a fresh run owning no files, a reservation still in flight finalized under its admitting session, the public cap still holding), audit plan versions (plan versions 1 and 2 and a request naming none admitted through exchange, upload and inference under the same run ceiling, any other value refused 409 `AuditPlanVersionException` / `audit_plan_version_unsupported` before the activation is consumed or quota reserved, and the header allowed through a browser preflight), sessions stored without runs read across the cutover, the whole-session totals and run upload count a rolled-back worker reads, and durable ordered callback retry.
- `test/grader-chat.test.ts` — the Grader sales chat through the real route with a stubbed provider and the in-memory Durable Object harness (`test/audit-harness.ts`, shared with `test/audit-auth.test.ts`, whose `AUTHORITY_FAULTS` breaks a named internal authority call before it arrives or after it ran): plan version 2 answered, version 1 or none refused 403 `grader_chat_not_in_plan`, the disabled switch refused 503 `grader_chat_disabled`, the exchange's `graderChat` terms, a merchant context-ID answered as an unknown route, history matched to the transcript fingerprints of the session's own replies (planted, edited, re-paired, reordered and withheld history refused 403), chat accounting kept out of the audit's inferences, attempts, uploads and status events and neither cancelling nor cancelled by a proposal, the chat opening only after a completed run (`grader_chat_not_open`, `grader_chat_run_failed`), a retry restoring no message, a reopened link superseding the session while carrying the chat count, replies and in-flight message and refusing the old token, the audit, visitor and deployment limits, one message in flight, counting only answered messages, expiry with the token, a 2-day-old session still chatting and one 30 days and a second old refused, the kill switches (`runsValidFrom` reported at exchange and on every reply, a run completed or started before a raised `GRADER_RUNS_VALID_FROM` refused 410 `grader_run_revoked` on chat, replay, proposal and same-run upload while a fresh run in the same session chats again, and an extension build older than `GRADER_EXTENSION_BUILT_AFTER` — or naming no build time once the cutoff passes the header's introduction — refused 409 `extension_update_required` at exchange without consuming the activation and on every upload, proposal and chat call, a malformed build time refused 400, every exchange setting resolved before the activation is consumed or a live session superseded — a malformed cutoff or chat setting answering 500 and a cutoff still ahead answering 410 while the same link exchanges once repaired — `GET /audit/session` answering the chat terms and both cutoffs with no provider call and no record written, and refusing a missing bearer, an outdated build, a revoked run and a superseded session, every answer and refusal carrying `Cache-Control: no-store`, an upload-only run such a worker opened, with or without stale times, adopted and continued through its upload, proposal and chat, and run times a worker without them left behind — absent, carried onto the next run, or a completion with no time — read as the bearer's issue time or the run's start, forcing a fresh run that then chats), the input cap in code points, the strict body and report with a required UUID v4 `messageId`, the report fenced as data with backticks escaped, effort only on a reasoning model, the link guard end to end (an off-site link withheld and still counted, a link a tampered but shape-valid report planted withheld, every off-site and parser-confusion link form withheld through the route while limespot.com links and ordinary wording are delivered), `messageId` idempotency (a replay answered from the stored outcome with no inference or charge, a withheld outcome replayed as withheld, a lost committed response retried with one inference and one charge, a replay in flight refused 409 `grader_chat_busy`, the identifier with another transcript refused 400 `grader_chat_message_reused`, a failed message's retry answered, and a replay across a reopened link and history naming the reply accepted for 30 days, after which the outcome, the identifier and both fingerprints are deleted by the alarm, history naming that reply is refused and the identifier is admitted as a new message — an identifier reused before a delayed alarm keeping its new outcome through that alarm and replaying it with no second inference or charge — while reply fingerprints an earlier worker stored are deleted with its last live entry), the volume alert queued once per threshold in the deployment counter's outbox and delivered by its alarm, delivered once when the counter's answer is lost after it committed, retried after a failed or throttled webhook and dropped after a refusal, the daily counters never admitting past their limit when a lapsed hold settles late (the beyond-lease sequence) and charging an unsettled hold to its own day only, a hold dated another day refused, a visitor whose request crosses midnight re-admitted on the new day's counters only, an answer admitted before midnight and committed after counted on its admitting day with its 499 → 500 alert still queued, a past day kept while it holds a message and dropped once settled or past its retention, flat single-day counter records and an undated message in flight and settlement an earlier worker stored, seeded in storage and upgraded through the real endpoints and alarm, calls aborted after the upstream request began charged as attempts until 429 `grader_chat_attempt_limit` per audit and per visitor day, a log-only alert's Seq delivery handed to the counter's `waitUntil` before its outbox entry settles, `GET /health` 503 for a visual-only `grader-sales` override, equal alert thresholds on consecutive days settled by their day-qualified ids through the route, the counter's internal endpoints and its alarm (day one retrying while day two settles), with a direct counter test as a supplement, production readiness through `GET /health` on the worker with a stubbed build revision — every chat misconfiguration, a model route the handler refuses included, 503 while the chat is on and 200 with it off — with the handler-level route check as a supplement, the exchange and reply `graderChat` shapes and the `grader_chat_audit_limit` refusal pinned for the extension and lib, settlement after a fault injected at each step (the visitor commit, the deployment commit, the acknowledgement, a lost commit answer retried, and a commit that never lands, whose holds the alarm releases once the lease ends) leaving every ledger counted exactly once, no message text in any log, and a session over keep-alive answers (a proposal completing its run, the strict chat body admitted beside the opt-in, the reply and its stored-outcome replay as the same envelope a plain replay's body equals, a closed switch and an oversized chat or proposal body answered with their own plain status because the opt-in is read only after them, a Grader inference and chat message each read once, never cloned, and parsed once, a streamed inference body read no further than just past the byte limit and refused plainly, a refusal made once admission began carried as its own status and Brain envelope, and a message whose work outlives the runtime grace held until its lease, then released as a failed attempt whose retry is admitted afresh while the late reply answers 504 and counts nothing).
- `test/grader-chat-output.test.ts` — the link guard alone: every off-site link form withheld (scheme URLs, `www.` hosts, `mailto:` addresses, Markdown targets relative or not, bare hostnames with a port or path, look-alike limespot.com hosts, fullwidth and invisible-character evasions), every parser-confusion form withheld as a browser parses it (backslash before `@`, `@` userinfo and credentials, percent-encoded hosts, internationalized and punycode lookalikes, trailing-dot hosts), IP literals and every URI-shaped token but an allowed `http(s)` or `mailto:` withheld by structure (bracketed IPv6, bare IPv4 with a port or path, `tel:`, `javascript:`, `bitcoin:`, `xmpp:`, `matrix:`, `otpauth://`, an unregistered `foo:bar`, `localhost:8080`), WHATWG dot equivalents mapped before reading (`evil。example`, `evil｡example`, `evil．example`), bodies that open with punctuation (`mailto:?to=…%40…`, `data:,hello`, `foo:?bar`, `foo:*bar`) and `**Tip:**` withheld, a scheme of any length withheld, tens of kilobytes of adversarial text read in linear time, while prose with a colon then a space, `**Tip**:`, times and ratios passes, every `mailto:` and plain address but one bare recipient at limespot.com withheld (a `?bcc=` header, an encoded recipient, several recipients, a header-only form, any `%`), any four dot-separated octets withheld whatever follows while a version string passes, limespot.com and its subdomains passing in every form, wording never withheld, and unfinished or empty replies.
- `test/assistant-prompt-blocks.test.ts` — the shared assistant blocks: Studio's `chat` byte for byte against `test/__snapshots__/chat.baseline.md` with its Studio identity naming its platforms, the `grader-chat` composition byte for byte against `test/__snapshots__/grader-chat.baseline.md` with its one boundaries block, no Studio-only instruction, and no platform named outside the booklet, the configured booklet resolution, and every booklet's fixed headings, size cap, and editor-only notes, with v1 stating no price.
- `test/audit-proposal.test.ts` — the usable-proposal decision: the request manifest read in the line format the proposal prompt defines, box types pinned to the prompts' box vocabulary, complete plans accepted directly, fenced, or embedded, and every shape the conductor would reject — object or unknown boxes, bad positions, out-of-range candidates, missing or wrong pages, prose, malformed JSON, unfinished replies — refused.
- `test/audit-plan.test.ts` — the grader plan: its page vocabulary pinned to the proposal prompts' text, the most tiles Studio's capture cuts a width into, the whole-store sends and per-page retries with their repairs, the per-run ceiling it derives with the deployment headroom, plan versions 1 and 2 with a missing declaration following plan 1, and the chat allowance held under version 2's 50-message ceiling.
- `test/audit-status.test.ts` — delivery to the session's signed callback URL, exact callback JSON, timestamp and HMAC header contract, and the delivered / retry / rejected classification of each callback answer.
- `test/probes.test.ts` — the Website-Analysis probe mechanism: the registry resolves `probe-industry` (text/metadata/model), resolves the Sonnet probes `probe-cart-wiring` + `probe-style` on the `balanced` tier (≠ the default `frontier` tier, `usesTools: false`, no attachments) with their selector/style-descriptor prompt contracts, the `probe-<id>` convention (`PROBE_PREFIX` / `isProbeName`) + the `PROBE_SCHEMAS` index ↔ registry coherence, `/messages` routing the `probe-industry` / `probe-cart-wiring` / `probe-style` headers (system block injected, no attachments, model defaulted to the registry entry, caller blocks pass through), and the frozen `{ industry, confidence, findings }` output contract (schema/parse checks: well-formed, `Unknown`/empty-findings sink, rejects missing keys / out-of-range confidence / non-string findings).
- `test/proposals.test.ts` — the TOOL-CAPABLE per-store SETUP PROPOSALS prompt: the registry resolves `proposals` on the `balanced` tier (Sonnet, ≠ the default `frontier` tier) + `usesTools: true`, the prompt reasons over page evidence (screenshots + cleaned HTML) AND instructs the model to pull real store data via the personalizer tools (AOV-derived progress-bar threshold), and `POST /chat` with the `proposals` header sends the personalizer tool surface + the page-evidence file blocks and drives the tool loop (tool_call → Brain `v2/ai-tools` → tool_result → final JSON proposal).
- `test/config.test.ts` — `src/config.ts`: the no-fallback contract (every accessor throws on a missing/empty variable, naming it and where to set it), the `resolveModel(env, tier)` tier→model mapping (each tier → its bound var, throws named when absent), the PRODUCTION `[vars]` pins, which the spec reads out of `wrangler.toml` itself rather than restating (the Personalizer and provider origins, the three tier→model bindings, the empty `MODEL_OVERRIDES`, the master subscriber, the credentialed-origin allowlist, the status-callback origin allowlist, the 30-day audit session, the two Grader kill switches shipped at a past instant and their strict ISO-8601 UTC parsing, the Grader chat on by default with `GRADER_CHAT_ENABLED = "true"` as its off switch, and its operator defaults), enabled production readiness through `GET /health` with every deployed binding and the model `grader-chat` resolves to, the Grader chat accessors and the optional HTTPS alert webhook, and the reconciliation between the two configuration files and the typed `Env`: every declared binding is documented in `.dev.vars.example`, every declared secret is blank there, and no declared secret appears in `[vars]` — all three derived from `src/config.ts` rather than retyped, so a new binding or secret cannot slip past them.
- `test/model-catalog.test.ts` — `src/inference/model-catalog.ts` and the configured-model routing over it: the catalog's own consistency contract (unique prefixes and profiles, each family on a file policy its provider and API family own), catalog ↔ adapter profile-table parity, prefix matching for versioned families plus exact matching for fixed Kimi/Moonshot IDs, provider inference for non-Anthropic ids, capabilities stated as model facts, the unrecognised-id throw naming the id and the supplying variable, every registered Studio group routable to Kimi by model name while the protected free judge stays separate, a tier routed to another provider from configuration alone, the capability-mismatch rejection naming the group and the missing capability, and `MODEL_OVERRIDES` (empty by default, group and prompt precedence, unknown-key throw listing the valid keys, malformed and repeated entries, and the rejection of an override that would move one prompt off its shared provider file route).
- `test/prompts-route.test.ts` — `GET /prompts` driven through the real router: the master subscriber receives every registered prompt's resolved route, a validated non-master merchant and a validation payload without a `SubscriberID` receive the unknown-route answer byte for byte, a missing context-ID is refused before any Personalizer call, an unroutable prompt is reported with its reason rather than throwing, blank required secrets are named without leaking a value or prefix, and `/health` stays unauthenticated with its exact shape. The `personalizerContextId` query parameter is covered on the same path: the master context-ID is accepted from the URL, the header wins when a request carries both, a non-master URL credential gets the unknown-route answer byte for byte, no other route or method reads the parameter, and a request carrying the credential in the URL produces no log record containing it.
- `test/architecture.test.ts` — fitness scans over `src/` + `scripts/` enforcing the standing invariants: party- and AI-capability-driven toolset composition, the exact version-1 router gate, credentials never in logs or the model-visible system builder, degraded tool results structurally unable to carry raw bodies, one error shape (no bespoke `{ error: { message } }` envelopes), query-string credentials confined to the master-gated `GET /prompts` diagnostics (one module naming the parameter, one guarded router call, no other `searchParams` read, and the logger sanitizer every logged string passes through), and No Hardcoded Config Values (no absolute URL literals in src or scripts, no inline `||`/`??` fallbacks on `env`/`process.env` reads, required worker vars read only through `src/config.ts`). The dev Claude-Code shim (`scripts/dev-claude-shim.mjs`) is carved out of the no-URL-literal scan only — it is standalone local tooling with overridable dev-default endpoints, outside the worker's fail-fast config contract (never bundled); it still passes the env-fallback scan (it reads config via `envOr(name, fallback)` bracket access, not inline `||`/`??`).
- `test/dev-shim.test.ts` — the free dev Claude-Code channel (`scripts/dev-claude-shim.mjs`): the pure Anthropic⇄Claude-Code translation layer (`systemToString`, `rehydrateBlock` file→inline base64 image/document + tool_result flatten + unknown-file degrade, `normalizeContent`, `buildPromptMessages` user turn + assistant-history preamble, `estimateTokens` char/4, `bareToolName` mcp-prefix strip, `stripCodeFence`, `usageFrom`, `extractFilePart` multipart, `extractFormField` and an upload answered with the `expires_at` its `expires_in_seconds` asked for), plus the **cred-burn GUARD** (`assertDevAiChannel`: throws when a dev/test run points `ANTHROPIC_API_BASE` at `api.anthropic.com` without `AI_CHANNEL=prod`; allows the local shim; opt-in with `AI_CHANNEL=prod`) and a check that `.dev.vars.example` ships the free-shim default.
- `test/dev-shim-cache.test.ts` — the shim's record/replay response cache (`scripts/dev-shim-cache.mjs`). The request path is driven through the shim's REAL router (`handleHttp`) with the Claude Code SDK mocked, because record/replay is only true end to end: a miss reaches the fulfiller and writes an entry, the repeat reproduces the same bytes without reaching it again (the mock's call count is the proof a hit costs no model time), a changed prompt records its own entry instead of reusing the neighbour, the SSE path replays the frame SEQUENCE event by event, a stream recording is never served to a non-stream request, `SHIM_CACHE` is an opt-OUT (on unless a falsy spelling turns it off), and the `cache HIT` / `cache MISS` / `cache RECORD` log lines are asserted verbatim. The loudness that pays for that default is covered as its own concern: every served response carries `x-dev-shim-cache: hit|miss|off` on both transports (a replay is byte-identical to the fresh answer EXCEPT for that marker, which the replay test pins), and `GET /health` reports the cache state plus hit/miss/record counts that advance per call. The key derivation is covered directly: everything that can change the answer changes the key (model, context-ID, transport, prompt, system block, token budget, tool schema, tool-result CONTENT, and adding or removing an attachment), while the values minted fresh per run do not — a per-upload `file_id`, `tool_use` ids with their LINKAGE still counted, and whether two attachment positions came from one deduped upload or two, which is the run-to-run difference that kept the onboarding whole-store call from matching its own recording. The documented limitation is pinned in both directions: differing image bytes share a key by default and stop sharing it under `SHIM_CACHE_ATTACHMENT_BYTES=1`.
- `test/dev-local-fulfillers.test.ts` — the Claude Code/Codex local fulfiller boundary (`scripts/dev-local-fulfillers.mjs`): Claude Code by default and Codex by explicit selection, loopback provider endpoints without the paid opt-in, the API-key opt-in with an allowlisted child environment, the ephemeral read-only explicit-model/image/schema `codex exec` invocation, the bounded transcript and final JSONL usage normalization, one structured visual turn through an injected process with temp-artifact cleanup, both fulfillers dispatched through one canonical local result contract and serialized into the exact shim response envelope, malformed-result rejection before serialization, child termination on cancellation and no spawn for an already-cancelled request, normalized successful/nonzero/spawn-error/stdin-error outcomes, artifact removal on failure, and rejection of a missing model, streaming, and tools before spawn.
- `test/dev-inference-trace.test.ts` + `test/logger.test.ts` — correlated inference events, complete diagnostic text/tool/file decisions, per-level multi-sink routing, context/error detail, secret-field and URL-credential redaction, optional Seq authentication, fail-open delivery, and background rejection capture.
- `test/helpers.ts` — shared typed fixtures: the complete `Env` fixture, fetch-mock accessors, the worker-SSE parser, and the KV mock. `stubFetch` plays the provider: a test answers with the Anthropic message it wants, and a request that asked for `stream: true` receives that message as the Messages API event stream (`anthropicStreamResponse`).
- `test/store-origin.test.ts` — `lib/store-origin.ts`: a store's bare domain and its `www.` subdomain are one store in either direction after lowercase and IDN normalisation, while another subdomain, a lookalike domain, a second `www.` label, a suffix attack, another scheme or another port is not.
- `test/file-expiry.test.ts` — Anthropic file retention: every upload sending `expires_in_seconds` for the policy's 30 days with no beta flag, the `expires_at` Anthropic answers sealed into the reference and shortening the dedup record, an upload answered with no, a missing, or a too-short expiry refused and its object deleted, a delete that fails once retried and one that keeps failing kept under its own `discard:` key that the next upload of the same bytes clears, two concurrent failed cleanups keeping both ids, every page of 150 discard keys drained before the next upload, and a failed KV read or first KV write losing none, a dedup hit reused with 15 days left and uploaded afresh with less, once expired, or with no expiry while the cached object is left to expire, a provider-retained policy still reusing until expiry, and a Grader run through the real route reusing a re-uploaded tile and resuming a failed proposal on the same uploaded file.
- `test/token-saving.test.ts` — the cost-reduction levers: 1h-TTL placement (system/context/kept user blocks), `applyCanonicalConversationBreakpoints` (`inference/cache.ts` — last-block, ~15-block intervals, cap, stale-strip, only the last extended file-prefix intent kept), `file-dedup` (sha256Hex vector, KV hit + stale-id verify/re-upload + miss + no-op, 30d TTL cap), `fileIds` document/image block typing + 1h file-prefix breakpoint + ≤4-breakpoint-with-file-prefix invariant, `countTokens` body/header, model+effort routing, and an end-to-end agent-loop breakpoint-count ≤4 assertion.

## No silent skips

A test never `it.skip()`s because an env var or fixture is missing. If a
precondition is absent, the test (or the gate) THROWS with an actionable
message:

- When invoked, the caching diagnostic throws if no master context-ID is available — naming the env
  var to set and the fixture path to provide (see below).
- When invoked, the caching diagnostic throws if a deployed-worker call returns a non-2xx or a
  Brain-shaped error body (`{ Message, ExceptionType, ... }`).

A skipped test is invisible in CI green. A louder red is the trade we make.

## Running the offline suite

```bash
npx vitest run          # one-shot: unit + integration + contract + fitness
npm test                # watch mode
npm run typecheck       # tsc --noEmit (strict; must be 0)
npm run lint            # ESLint over the whole repo (src, test, scripts/, configs)
npm run format-check    # Prettier check (whole repo; exclusions + rationale in .prettierignore)
npm run deploy:dry-run  # build the revision-stamped bundle (verifies imports + the .md Text rule)
```

## Local AI dev channels + cred-burn guard

Local dev fulfils inference through the local shim, with **Claude Code** as the
default and Codex as an explicit one-shot option (see the root `CLAUDE.md` →
"Local AI dev — provider-neutral Claude Code/Codex fulfillers"), so dev never
burns credits. Four pieces are covered offline:

- **Translation layer** — the pure Anthropic⇄Claude-Code mapping helpers exported by `scripts/dev-claude-shim.mjs` (system/message/file-block translation, token estimate, code-fence strip, multipart parse, usage mapping). These are the risk surface: the shim's HTTP behavior is only correct if these map the wire shapes the worker's `chat.ts` / `messages.ts` parsers expect.
- **Cred-burn GUARD** (`assertDevAiChannel`) — FAILS a dev/test config that points `ANTHROPIC_API_BASE` at `api.anthropic.com` without an explicit `AI_CHANNEL=prod` opt-in, and asserts `.dev.vars.example` ships the free-shim default (`http://127.0.0.1:8788`). This makes accidental credit-burn impossible: plain `wrangler dev` uses the free shim, and the paid API requires saying so out loud.

- **Record/replay response cache** — `test/dev-shim-cache.test.ts` drives the shim's REAL router (`handleHttp`) so a recorded fulfilment is replayed byte-identically on both transports, an opted-out cache records and replays nothing, every served response carries its `x-dev-shim-cache` outcome, and `GET /health` reports the running counters.
- **Local fulfiller selection** — `test/dev-local-fulfillers.test.ts` freezes the Claude Code/Codex boundary described below.

Importing the shim for these tests is side-effect free — the HTTP server only binds its port when the file is run directly (`npm run dev:shim`), never on import.

`test/dev-local-fulfillers.test.ts` freezes the selectable Claude Code/Codex
boundary and exact Anthropic-compatible result envelope. Codex coverage asserts
an explicit model and reasoning effort,
ephemeral/read-only execution, zero-byte inherited AGENTS/project instructions,
image and output-schema arguments, JSONL usage,
request-abort child termination, temp-file cleanup, and rejection of unsupported
streaming, tools, media, and structured-output shapes before spawn.
It also freezes the exact secret-minimized child environment, ChatGPT-vs-API
authentication mode, API-key opt-in, shell/web/plugin/subagent/app-connector/dependency-install disablement, strict
terminal JSONL usage (including cached input), delayed SIGTERM/SIGKILL lifecycle,
process failures, and the real shim non-stream/error/stream-rejection handlers.
The worker config suite proves every non-loopback Anthropic, OpenAI, Moonshot,
Kimi Code, and Gemini origin requires `AI_CHANNEL=prod` outside production.

## Optional paid OpenAI smoke matrix

`npm run verify:openai` calls the configured OpenAI Responses endpoint directly
for every comma-separated `OPENAI_SMOKE_MODELS` candidate. It requests a strict
structured result with low reasoning effort, verifies the response served the
requested model — accepting the dated or numbered snapshot an alias resolves to,
and reporting which one served — parses the schema-conformant `{ ok: true }`
result, validates terminal usage, and records latency.
It is outside CI and the default gates. The script refuses to make any call
unless both credit acknowledgements are present:

```bash
OPENAI_LIVE_SMOKE=1 \
AI_CHANNEL=prod \
OPENAI_API_BASE=https://api.openai.com \
OPENAI_API_KEY=<paid-key> \
OPENAI_SMOKE_MODELS=<candidate-model-1>,<candidate-model-2> \
  npm run verify:openai
```

`test/openai-live-guard.test.ts` proves the two-key guard and multi-model
matrix offline. Running the smoke does not authorize production prompt routing;
prompt-level evaluations and a separate registry change remain required.

## Optional paid Moonshot smoke matrix

`npm run verify:moonshot` calls the configured metered Moonshot Chat Completions
endpoint for every comma-separated `MOONSHOT_SMOKE_MODELS` candidate. It requests
strict JSON Schema output with low K3 reasoning effort or preserved K2 thinking,
validates the selected model, terminal stop, exact `{ ok: true }` result, and
internally consistent usage. It is outside CI/default gates and requires both
explicit credit acknowledgements:

```bash
MOONSHOT_LIVE_SMOKE=1 \
AI_CHANNEL=prod \
MOONSHOT_API_BASE=https://api.moonshot.ai \
MOONSHOT_API_KEY=<paid-key> \
MOONSHOT_SMOKE_MODELS=<candidate-model-1>,<candidate-model-2> \
  npm run verify:moonshot
```

`test/moonshot-live-guard.test.ts` proves the guard and matrix offline. Running
it neither activates a production route nor authorizes deployment.

## Optional paid Kimi Code probe matrix

`npm run verify:kimi` calls the configured Kimi Code subscription Chat
Completions endpoint for the single `KIMI_SMOKE_MODEL` candidate. Kimi documents
the subscription endpoints and model IDs, while the probes verify the remaining
wire behavior: bearer auth, the metered request body under a subscription id,
`data: [DONE]` framing, streamed tool-call assembly, strict `json_schema` output,
inline base64 images, whether `/v1/files` exists at all, positive full-reasoning
tool replay, whether omitting historical `reasoning_content` is rejected, and the
literal error envelope. It is outside
CI/default gates and requires both explicit credit acknowledgements:

```bash
KIMI_LIVE_SMOKE=1 \
AI_CHANNEL=prod \
KIMI_API_BASE=https://api.kimi.com/coding \
KIMI_API_KEY=<subscription-key> \
KIMI_SMOKE_MODEL=<subscription-model> \
  npm run verify:kimi
```

`test/kimi-live-guard.test.ts` proves the guard and probe selection offline.
Running it neither activates a production route nor authorizes deployment.

The required live matrix validates authentication, strict structured output,
terminal SSE framing and usage, streamed tool calls, full reasoning replay, and
image upload plus `ms://` inference. Inline base64 input, the deliberately
incomplete reasoning replay, and the provider error envelope remain observational.
Metadata and delete results are recorded because the coding
endpoint does not expose a complete file lifecycle.

Worker-path coverage exercises encrypted R2 image/text evidence, smart image
selector output, five-page onboarding proposal/review/QC requests, stable
hosted-image reuse, large-HTML retrieval, and deletion. Visual quality on
representative merchant pages remains a prompt-level evaluation gate.

## Optional paid Gemini probe matrix

`npm run verify:gemini` calls the configured Gemini `generateContent` endpoint
for the single `GEMINI_SMOKE_MODEL` candidate. It closes the seams the official
pages leave open or contradict: the structured-output request shape, SSE framing
and the absent terminal sentinel, the error envelope's `code`/`status` spelling,
single-shot multipart upload, snake_case media aliases, `countTokens` wrapping,
`x-goog-api-key` authentication, and the authoritative `GET /models` id and
context-window list. That catalog probe runs FIRST and fails by name when the
configured model is not served for `generateContent`, so a well-formed id that
does not exist costs no inference; an id the catalog publishes only as a dated or
numbered snapshot resolves. `maxOutputTokens` covers thinking and the answer
together, so every probe budgets both, and a turn that still spends the whole
budget on thoughts is reported as the `starved` outcome rather than as a contract
failure. It is outside CI/default gates and requires both explicit credit
acknowledgements:

```bash
GEMINI_LIVE_SMOKE=1 \
AI_CHANNEL=prod \
GEMINI_API_BASE=https://generativelanguage.googleapis.com/v1beta \
GEMINI_API_KEY=<paid-key> \
GEMINI_SMOKE_MODEL=gemini-3.5-flash \
  npm run verify:gemini
```

`test/gemini-live-guard.test.ts` proves the guard and probe selection offline.
Running it neither activates a production route nor authorizes deployment.

## Optional token-savings diagnostic

`scripts/verify-caching.mjs` (`npm run verify:caching`) proves prompt caching
engages against a DEPLOYED worker. It is an integration check — it needs the
network, a valid master `X-Personalizer-Context-ID`, and a reachable `/chat` +
`/files` target — so it is deliberately OUT of `vitest run`.

**What it asserts.** Two identical requests for each of the two cached prefixes
the worker's cost reduction depends on; the second call must read from cache:

1. **chat tools+system prefix (Opus 4.8)** — `TOOL_DEFINITIONS` + the
   `buildSystem` base block. Two identical `/chat` calls; call 2 must report
   `cache_read_input_tokens > 0`. Live-measured: `cache_read = 1351`.
2. **placement file-block prefix (Haiku 4.5)** — an HTML file uploaded via
   `/files` and referenced by `fileId`. Call 1 writes the cache
   (`cache_creation_input_tokens > 0`), call 2 reads it
   (`cache_read_input_tokens > 0`). Live-measured: `cache_creation ≈ 23217` on
   call 1, the same value as `cache_read` on call 2. Same bytes map to the same
   `file_id` via the `/files` content-hash dedup, so both calls hit one cache
   entry.

It fails loudly: a `cache_read` of 0 on a repeat call throws as a regression;
missing creds or an unreachable target throws with setup instructions. There is
no silent skip.

**How to run.** All configuration is EXPLICIT — the script carries no default
target and no default fixture path (No Hardcoded Config Values,
[CODE-PATTERNS.md](CODE-PATTERNS.md)); a missing variable throws, naming it:

```bash
# Target + context-ID, both required:
APP_AI_TARGET=https://app-ai.personalizer.io \
APP_AI_CONTEXT_ID=<master-context-id> \
  npm run verify:caching

# Or point at a shop-context fixture JSON instead of a raw id:
APP_AI_TARGET=https://app-ai.personalizer.io \
APP_AI_CONTEXT_FILE=/tmp/storefront-test/shop-context.<dev-store>.myshopify.com.json \
  npm run verify:caching
```

**Configuration** (all explicit, no defaults):

- `APP_AI_TARGET` (required) — the deployed worker base URL to gate.
- `APP_AI_CONTEXT_ID`, or `APP_AI_CONTEXT_FILE` pointing at a shop-context
  fixture JSON (`{ "contextID": ... }`). The lib E2E suite mints these from a
  master login; context-IDs are subscriber-scoped, so the gate runs against the
  dev store that login owns.

**Sample passing output:**

```
[1/2] chat tools+system prefix (Opus 4.8)
  call 1: input=85 cache_creation=0 cache_read=1351
  call 2: input=85 cache_creation=0 cache_read=1351
  ✓ chat tools+system prefix: cache engaged (call 2 cache_read=1351 > 0)

[2/2] placement file-block prefix (Haiku 4.5)
  uploaded fixture → file_...
  call 1: input=3 cache_creation=23217 cache_read=0
  call 2: input=3 cache_creation=0 cache_read=23217
  ✓ placement file-block prefix: cache engaged (call 2 cache_read=23217 > 0)

CHECK PASSED — both cached prefixes engage against the deployed worker.
```

## Why the diagnostic is manual / dispatch-only

The diagnostic needs deployed-worker access, Anthropic billing, and a master
context-ID. It is intentionally optional and is not part of push-CI or release
readiness. Two ways to invoke it when useful:

- **Manual diagnostic** — run `npm run verify:caching` against the deployed
  worker when investigating or measuring prompt-cache behavior.
- **GitHub Actions** (`.github/workflows/verify-caching.yml`) — a
  `workflow_dispatch` job guarded on the `APP_AI_CONTEXT_ID` + `APP_AI_TARGET`
  repo secrets. When either is absent (forks, unconfigured repos) the guard
  step exits the job cleanly so nothing fails; when both are present, it runs
  the diagnostic. It is never wired into the required push/PR `build` job.
