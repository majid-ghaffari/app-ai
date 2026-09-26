# src/lib/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md)

Shared provider-neutral modules consumed by handlers, the router, toolsets, and
the inference runtime. `inference-types.ts` owns the canonical contracts;
provider HTTP, credentials, wire types, and serialization live only under
`../inference/adapters/`.

`auth.ts` mirrors the consumed members of Brain's validate-context-id response,
including `AiToolsContractVersion`, `AvailableAiTools`, and
`AvailableIntegrationParties`. It also carries `CanAdministerAllSubscribers`, the
permission proof the router requires before reserving a protected visual verdict.
The router accepts AI-tool capabilities only for
the `SUPPORTED_AI_TOOLS_CONTRACT_VERSION` owned here; missing and unsupported
versions fail closed to no Brain data tools.

The per-module map — what each file owns — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md), read on demand. What binds every module is below.

## Conventions

- Doc comments on exports follow `../../../_standards/documentation-and-comments.md` —
  TSDoc only where the contract is not evident from the name and signature.
- Cache/effort/dedup levers are **additive** — they never change external
  request/response shapes (see the token-saving section in the root CLAUDE.md).
- Provider wire fields, beta flags, authentication, and HTTP calls live only in
  `../inference/adapters/`; shared lib must not import provider modules.
- `ProviderName`, `ProviderApiFamily`, and `ModelCapabilities` are the canonical
  routing vocabulary. `reusableFiles` means app-ai can preserve opaque file
  references across requests; `providerFiles` separately reports that the
  provider owns a complete file lifecycle.
- `FilePolicy.inputMode` distinguishes provider objects, encrypted worker-managed
  objects, and request-scoped inline bytes. Its lifecycle and compatible API
  families are validated before upload or inference.
- Client-correctable canonical validation uses `WorkerError` with the Brain
  `ArgumentException` envelope. `InferenceFailure` is reserved for provider or
  provider-protocol failures after a route reaches its adapter.
- `logger.ts` sanitizes every string on its way into a record — opaque provider
  handles and the value of any credential-bearing query parameter — so a URL
  quoted in a message, detail, or stack cannot carry a credential into a sink.
- Continuation values stay opaque. An adapter may set `requiredOnNextTurn` when
  its state must be echoed after an ordinary terminal assistant turn; handlers
  only seal/carry the value and never interpret the provider payload.
- `audit-auth.ts` resolves every dependency an exchange needs — the session
  signing key, the callback signing key, and the activation's allowlisted
  `statusCallbackUrl` — BEFORE it consumes the one-time activation, so a
  deployment error cannot burn an otherwise valid link. Delivery outages belong
  to the Durable Object outbox, not to the exchange.
- Status delivery never runs in a request: exchange, reserve and finalize append
  to the outbox and set the alarm, and only the alarm calls the website.
  `audit-status.ts` classifies each attempt as delivered, retry (no answer,
  timeout, 5xx, 401/408/425/429 — the head waits a minute), or rejected (any other
  4xx — the event is dropped with a warning so it cannot block the ones behind
  it).
- `resolveStatusCallbackUrl` is where app-ai keeps the decision the website does
  not own: the signed claim carries the path, and only an absolute URL with no
  credentials, query, or fragment whose origin is in `AUDIT_STATUS_ORIGINS`
  reaches the outbox, so a leaked website signing key cannot aim it at a host of
  its own choosing.
- `audit` is the technical name at every layer — the `/audit/session/exchange`
  route, the `X-LimeSpot-Audit-*` headers, the `AUDIT_*` bindings, the
  `ls_audit_` bearer, the `AuditSessionAuthority` Durable Object, and these file
  names. The human-readable text of an error body names the feature `grader`,
  because a person reads it.
- The Grader conductor is never held to a fixed count. `audit-plan.ts` derives one
  run's abuse ceiling from the grader plan — the proposal prompts' page vocabulary,
  both widths, the tiles a width takes, and the proposal's repairs and sends — times
  `AUDIT_RUN_HEADROOM`; a recapture adds no upload, because lib uploads only a
  capture that returned an image. `test/audit-plan.test.ts` pins the vocabulary to
  the prompt text. `audit-session-authority.ts` holds inference requests to that
  ceiling per run and uploads to `AUDIT_MAX_RUNS` runs' worth per session, since an
  attempt that fails before its proposal leaves no run boundary; it opens a fresh
  run on the first upload after a proposal was reserved, lets a new proposal request supersede a
  pending one, and limits only what a person chooses: runs per session and
  completed public runs, the latter refusing the upload that would open another
  run. Session expiry refuses new reservations only: a reservation records the
  session that admitted it and when, and stays open for a lease of the upstream
  inference deadline plus a finalization grace, released on the alarm whichever
  session is current, so paid work admitted before expiry is still
  finalized and delivered. Only an inference that returned a usable proposal —
  complete, parseable as its prompt's proposal contract, covering every page the
  request's manifest names, with every box a vocabulary box type at a valid
  position and candidate number (at most 500), and never for a request whose
  manifest did not parse, as `audit-proposal.ts` decides from the request
  and response app-ai already holds — completes a public run; any
  other reply is mirrored `failed` and leaves the attempt for the next request. A session stored without runs is read as its first run, derived from its
  stored counters and pending reservations and not yet completed, so its next
  proposal is admitted as an attempt as that shape promised; a reservation it
  admitted carries no run and lands in whichever run is current. The session's
  successful uploads, with its pending ones, hold its upload allowance; the
  record also keeps the byte and inference totals and each run's upload count
  that earlier worker versions enforce their limits from, so a rollback still
  holds live sessions to them. The model is stated in
  `docs/AUDIT-AUTH.md`.
- A separately addressed `AuditSessionAuthority` instance is the strongly consistent UTC-day
  counter for the master-only protected visual route. It determines the current UTC date inside
  the authority, resets on the next UTC date, and returns 429 after the configured limit without
  requiring a new Durable Object class migration.
