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
  families are validated before upload or inference. `requestedLifetimeSeconds`
  names the lifetime app-ai asks the provider to give each upload, or `null`
  when the provider's own retention applies.
- `file-dedup.ts` keeps a record no longer than its file: its TTL is the file's
  remaining life, capped at `KV_RECORD_TTL_SECONDS` (30 days). A hit backs a new
  reference only while its file can outlive it: never once expired, and under a
  policy with a requested lifetime only while the file has at least a full
  reference lifetime (15 days) left and an expiry at all. Otherwise the bytes are
  uploaded afresh and the record replaced, and the old object is left to expire,
  because references minted from it may still be read. A fresh upload that could
  not back a reference by the same rule is deleted and refused; a delete that
  fails twice keeps the id under its own key, `DISCARD_KEY_PREFIX` + the dedup key + the
  file id, written alone and with no expiry, so concurrent failures and a failed read never lose
  one; the next upload on that dedup key lists those keys, deletes each file, then its key.
  `releaseTenantFiles` releases every record one tenant owns, dedup and `discard:` alike, deleting
  the object each names through `deleteStoredFile` and keeping a record whose delete fails; only a
  tenant none of whose references can be read again is released, which is a Grader session once it
  has ended. `deleteStoredFile` deletes through the provider that holds the object, whatever the
  current routing (the file service's `deleteStored`), counts a provider's 404 as deleted, and abandons a delete still unsettled
  after `STORED_FILE_DELETE_TIMEOUT_MILLISECONDS` as failed, racing the abort so a transport that
  ignores it, an R2 binding call included, cannot hold its caller.
- `ai-providers.ts` is the AI provider allow-list: `AI_SUBPROCESSORS`, the DPA's AI sub-processors
  by stable name, each with its name exactly as the DPA prints it and its API origin's host. Its one
  source is `_standards/ai-providers.json` in the workspace repository `limespot/root`: a provider is
  added there first, then to the website DPA, then here; `test/ai-providers.test.ts` matches this
  list to that file exactly; and CI's published-DPA gate runs root's
  `_enforcement/check-published-dpa.py`, which fails until the live DPA prints every provider the file
  names. It also holds each catalogued provider's sub-processor (`null` for Moonshot and Kimi Code);
  whether a provider
  may serve a route (`mayServeRoute`: a listed provider any route, an unlisted one only a route
  carrying no customer content); and each provider's own API base (`isOfficialProviderBase`), built
  on its sub-processor's host where it has one. It imports nothing at runtime, because `config.ts`
  uses it.
- `brain-usage.ts` reports each completed provider response under a merchant Context-ID to
  Brain's `POST v2/agents/report-chat-usage`, so Studio chat counts toward the store's monthly AI
  cap. The body mirrors the route's request model in PascalCase: `RequestGuid`, `PromptName`,
  `Model`, `InputTokens`, `OutputTokens`, `CacheReadTokens`, `CacheWriteTokens` and
  `WebSearchRequests`, with the merchant's `X-Personalizer-Context-ID`. The tokens follow Brain's
  `Pricing.Cost` for the provider. Gemini's entries carry no cache rate, so a Gemini response is
  reported as Brain's own Gemini client counts one: its whole prompt, cache hits included, as
  `InputTokens`, its thinking added to `OutputTokens`, and both cache fields 0. Every other provider
  reports cache reads apart from `InputTokens`, which Brain prices at their own rate, so one that
  counts them inside its input total has them subtracted. `WebSearchRequests` is 0 because no route
  offers a web search. Brain owns the prices (`AI:ModelPricing`) and the stored record, so app-ai
  sends tokens and the model, never a cost; Brain marks use under a LimeSpot staff session as staff
  and leaves it out of the cap. Each report runs on the request's `runBackground`, after the reply;
  a refusal or failure is logged and never retried, and a response that reported no token counts
  sends nothing. Because nothing is retried, Brain's route deploys before a worker that reports to
  it, and a rollback removes this sender before that route (root `CLAUDE.md` → Hard rules).
- Client-correctable canonical validation uses `WorkerError` with the Brain
  `ArgumentException` envelope. `InferenceFailure` is reserved for provider or
  provider-protocol failures after a route reaches its adapter.
- `request-body.ts` reads a `/messages` body exactly once: `readJsonBody` reads and parses a
  validated merchant request's JSON body, keeping a read or parse failure for the handler to answer
  as it always did, and `readBodyBytesWithin` reads a Grader session request's body and stops as
  soon as it passes the audit byte limit. The router and `audit-auth.ts` hand that one parsed
  value to the handler (`handleMessages` takes it as `body`), so no request is cloned, re-read or
  re-serialized, and nothing reads a request again once a keep-alive answer has begun — the
  runtime discards an unread body then.
- `keep-alive-response.ts` owns the `/messages` keep-alive mode, and none of it runs before the
  caller authenticated. `readKeepAliveOptIn` separates an exact `"responseMode": "keep-alive"` from
  a body read once — the router calls it on a merchant's, `audit-auth.ts` on a Grader session's
  after the byte limit and before the strict Grader chat check — and returns any other body
  untouched. `keepAliveResponse` answers 200 at once with
  `Cache-Control: no-store, no-transform`, writes a whitespace byte immediately and every
  configured interval while the routed response is pending, then writes
  `{ responseMode, status, result | error }` from it and hands the pending work to `waitUntil`.
- `logger.ts` sanitizes every string on its way into a record — opaque provider
  handles and the value of any credential-bearing query parameter — so a URL
  quoted in a message, detail, or stack cannot carry a credential into a sink.
- Continuation values stay opaque. An adapter may set `requiredOnNextTurn` when
  its state must be echoed after an ordinary terminal assistant turn; handlers
  only seal/carry the value and never interpret the provider payload.
- Storefront-origin equality on the audit path goes through `isSameStoreOrigin`
  in `store-origin.ts`: a store's bare domain and its `www.` form are one store,
  and nothing else is. The exchange entitlement, the request's
  `X-LimeSpot-Audit-Store-Origin` header and the authority's reissued-exchange
  check use it; the session-to-authority binding and every other origin check
  stay exact. A public session carries the signed entitlement origin, never the
  requested form, so its status events name the store as the website recorded it.
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
- The grader plan is a versioned contract with lib. `audit-plan.ts` keeps
  `SUPPORTED_AUDIT_PLAN_VERSIONS` beside the plan values, and `audit-auth.ts`
  refuses an exchange, status read, upload or inference whose `X-LimeSpot-Audit-Plan-Version`
  names any other value with 409 `AuditPlanVersionException` /
  `audit_plan_version_unsupported`, before it consumes an activation or reserves
  quota. A request naming no version follows plan 1 when its extension build names its build time,
  and is refused the same way when it names none. A lib change to a mirrored plan input is a new
  version, added here with its allowance before the client ships it. Plan version 2 keeps version
  1's capture plan and adds the Grader chat, held to `GRADER_CHAT_MESSAGE_CEILING` messages an audit
  above any configured allowance.
- The Grader conductor is never held to a fixed count. `audit-plan.ts` derives one
  run's abuse ceiling from the grader plan — the proposal prompts' page vocabulary,
  both widths, the most tiles Studio's capture cuts a width into, and the
  proposal's whole-store sends, per-page retries and repairs — times
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
  finalized and delivered. A session's uploads are recorded, by `audit-capture-files.ts`, under the
  session that admitted them, and deleted one lease after that session ends, by expiry or
  superseding; the audit's whole record goes a session lifetime after its latest session expired. Only an inference that returned a usable proposal —
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
  holds live sessions to them. The session record is one Durable Object entry and
  stays inside its 2 MB limit: a run owns each file as the SHA-256 digest of its
  reference (a stored file reference is accepted too), a reservation is refused
  with 503 `AuditSessionBacklogException` while the stored record serializes past
  1 MB, and the record keeps only the latest 1,024 consumed activation
  identifiers and two sessions' worth of abandoned reservation identifiers. The model is stated in
  `docs/AUDIT-AUTH.md`.
- A separately addressed `AuditSessionAuthority` instance is the strongly consistent UTC-day
  counter for the master-only protected visual route. It determines the current UTC date inside
  the authority, resets on the next UTC date, and returns 429 after the configured limit without
  requiring a new Durable Object class migration. Diagnostics stop before the configured
  acceptance reserve, while acceptance requests may use the entire daily allowance. The canonical
  inference request carries quota class separately from caller metadata. The internal
  request's `limit` member is the class's effective ceiling; a request carrying only `limit` is
  admitted as an acceptance reservation with no reserve.
- The Grader chat is audit traffic with its own accounting. `audit-auth.ts` answers a `grader-chat`
  selector with an unreserved `GraderChatAuthorization` after the switch, plan, and strict body
  checks; the handler reserves and finalizes it. Inside `audit-session-authority.ts` the chat keeps
  `chatMessages`, `chatReplies`, `chatInFlight`, `chatAnswered` and `chatSettlements` apart from
  `pending`, so no chat message is a run inference, an attempt, an upload, a status event, or a
  superseded proposal, and no proposal ever releases a chat message. Chat opens only on a run whose
  analysis completed. The chat state belongs to the audit, like the completion ledger: neither a
  retry, an expiry, nor a superseding exchange resets it, so no reopened link restores a spent
  message. Every assistant turn must match a stored transcript fingerprint of a reply this audit
  was given in the last `AUDIT_SESSION_TTL_SECONDS`.
- A chat message is idempotent by the caller's `messageId`, bound to the audit and to a fingerprint
  of the request's whole transcript. `chatAnswered` records each answered message identifier with
  its transcript fingerprint, its reply's fingerprint (`null` when withheld) and reservation, and its
  outcome — the `/messages` envelope, booklet version and withheld flag — is stored under
  `chat-outcome:<messageId>` in the same transaction that counts it. The entry, its outcome and its
  reply's fingerprint in `chatReplies` live `AUDIT_SESSION_TTL_SECONDS` (30 days, the session's own
  lifetime) from the answer and are deleted together (`withoutExpiredChat`) by the alarm, or first by
  the next chat admission inside its own transaction, so a late alarm changes no answer and an
  identifier reused after the window never shares an outcome key with the entry it replaced. An
  outcome key is deleted only when no live entry names its identifier. A reply
  fingerprint an earlier worker stored names no entry; it is deleted with the last live entry that
  worker wrote. A replay with the same transcript returns that outcome with no reservation,
  inference or charge; the same identifier with another transcript answers 400
  `grader_chat_message_reused`; a replay while the original is in flight answers 409
  `grader_chat_busy`. After the 30 days the identifier is unknown and is admitted as a new message.
  A model failure answers nothing, so its retry is admitted afresh.
- Every model call is an attempt, apart from the answered allowance the visitor sees. The audit's
  `chatAttempts` and the visitor's daily counter count each admitted message, answered or not, and
  refuse past `GRADER_CHAT_ATTEMPTS_PER_ANSWER` (`audit-plan.ts`) times the audit's and the
  visitor's daily allowance with 429 `grader_chat_attempt_limit`. A settlement names its outcome —
  `answered`, `failed` once the model call began (aborted and lapsed messages included), or
  `released` before any call — and only `released` refunds the attempt, so abandoning calls after
  provider I/O begins cannot start unbounded paid calls.
- Chat settlement spans three Durable Objects with no shared transaction, so the audit's ledger is
  the authority. The message in flight names its reservation and visitor counter. Once the model
  answered, `commitGraderChatMessage` counts the message, stores its reply fingerprint and outcome,
  records it in `chatAnswered`, and appends a `chatSettlements` record that commits the visitor and
  deployment counters, in one transaction, idempotent by the reservation and retried; the reply
  leaves only after that lands. A message that produced no reply is released the same way: the
  release removes it from flight and appends a settlement, `failed` or `released`, for both
  counters. The handler settles and acknowledges either; the alarm settles whatever remains, a
  minute later and each minute after, and drops a settlement older than a day. A message whose lease
  lapses unanswered is released by the alarm, or by the next admission, with a settlement due at
  once, and a commit for a reservation no longer in flight answers 410, which the handler returns as
  504 `InferenceTimeoutException`, so each reservation is either committed or released, never both.
- `AUDIT_SESSION_TTL_SECONDS` is the one bound on a session's life: `audit-auth.ts` signs it into the
  bearer's `expiresAt` claim, the authority stores and alarms on that expiry, chat outcomes and
  the fingerprints of the messages they answer are kept for it, and the audit's record is deleted
  that long after its latest session expired. Shorter lifetimes beside it — a file reference's 15 days, a continuation's 24 hours,
  the chat's UTC-day counters — are owned elsewhere and no audit session depends on them outliving it.
- The authority keeps the current run's `runTimes`, named by session and run number because a worker
  without them carries the member onto its next run. `runRevoked` compares the completion, or the
  start when the run never completed, with `GRADER_RUNS_VALID_FROM`; on a run that reached a
  proposal, times that are absent or name another run read as the bearer's issue time, and a
  completed run without a completion time as its start, while an upload-only run without times is
  adopted as opening now (`withAdoptedRunTimes` stamps it on its next upload or proposal). A revoked run's chat message (a replay included), proposal, upload and status read are
  refused 412 internally, answered 410 `grader_run_revoked`, while an upload that opens the next run
  is admitted, since that run opens now. `/status` is the authority's one read-only path: it checks
  the session and the run and answers the audit's answered chat count, writing nothing.
  `exchangeAuditActivation` resolves every setting its answer depends on, the cutoffs and chat terms
  included, and refuses a run the cutoff would already revoke, before the activation is consumed.
  `audit-auth.ts` refuses an extension build older than `GRADER_EXTENSION_BUILT_AFTER`, read from
  `X-LimeSpot-Extension-Built-At`, with 409 `extension_update_required` at exchange before the
  activation is read and on every audit request before any reservation; a malformed value is 400.
  The cutoff applies only to a build that names its build time. A build naming none is held to the
  plan-version contract instead: it must name a supported `X-LimeSpot-Audit-Plan-Version`, and one
  naming neither is refused 409 `audit_plan_version_unsupported` at the same points, whatever the
  cutoff. `assertCompatibleAuditClient` is the one check, applied to the exchange,
  `GET /audit/session`, `POST /files` and `POST /messages`.
- A valid new activation supersedes the audit's active session. `releaseSession` ends the old
  session exactly as expiry does — run, files and totals go; completed attempts, leased
  reservations, the outbox, consumed activations and chat state stay — and the record then names
  only the new session, so the old bearer's next reservation answers 401 `audit_session_expired`.
  The old session's uploads fall due for deletion one lease after the exchange.
- `audit-capture-files.ts` turns a successful upload's public references into the provider objects
  behind them, opened under the uploading session's own tenant, and `finalizeAuditUsage` hands them
  to the authority with the session the upload was admitted under. The authority keeps each as a
  `capture-file:<sessionIdentifier>:<digest>` key apart from the session record and names each
  session that admitted an upload in `captureReleases`, whose `dueAt` it sets one reservation lease
  after the session ends: at expiry, at a superseding exchange, or at once plus a lease for an
  upload that finished after its session ended. The alarm deletes at most 50 objects a pass, then
  the session's `FILES_KV` records through `releaseTenantFiles`, and runs again at once while more
  remain. An object its provider reports gone counts as deleted, and so does one past its expiry
  under a provider-managed file policy, where the provider deleted it then
  (`providerDeletesAtExpiry`); worker-managed evidence is always deleted explicitly, because its
  expiry ends the reference while the object stays in app-ai's own storage. A failed delete is kept
  and retried a minute later, then at doubling intervals of at most an hour, until it succeeds or
  that provider expiry passes. An alarm starts no delete once its release pass has run
  a minute, and every delete is bounded, so the alarm always reaches the transaction that records
  the retry: an alarm that never returned would exhaust the runtime's finite alarm retries and
  leave the uploads and the record unscheduled. The record and every key of the audit's object are
  deleted `AUDIT_SESSION_TTL_SECONDS` after its latest session expired, once no reservation lease,
  chat message in flight or capture release is outstanding; a capture file no release names is
  scheduled for deletion first, and undelivered status events are dropped with a warning. An
  instance without a session record, such as a daily counter, is never deleted this way.
- The chat's daily limits live in `grader-chat-quota.ts`, on separately addressed
  `AuditSessionAuthority` instances: `grader-chat-daily` and a `grader-chat-visitor:` instance named
  by a day-scoped HMAC of `CF-Connecting-IP`, keyed from `TOKEN_ENCRYPTION_SECRET` — the raw address
  is never stored or logged. A request captures its UTC day once, and that one value names the
  visitor's counter and dates both holds; a counter whose own UTC day is another refuses the hold
  with 421, and the handler releases what it took and admits the message again on the new day's
  counters, so midnight never splits a visitor across two days. Every hold counts against its
  counter's limit until it is explicitly committed or released, so a counter never admits past its
  limit however late a settlement lands. Records an earlier worker stored — a flat single-day
  counter, and an undated chat message in flight or settlement on the audit — are read and upgraded
  wherever they are read. A counter keeps one entry per UTC day and settles a hold on its admitting
  day's entry, so an answer that lands after midnight counts and alerts on that day; a past day
  stays while it holds a message, until the end of the following day plus an hour. The deployment
  counter decides each volume-alert threshold inside its transaction and queues it in its own outbox
  under a day-qualified id, `YYYY-MM-DD:<count>`, which the counter's alarm drains, settling exactly
  that entry, through `grader-chat-alerts.ts`: a delivered or refused alert leaves, one that may
  succeed later is retried each minute for up to a day, so a lost response never loses an alert. The
  authority's log sites hand each Seq delivery to its state's `waitUntil`, so a log-only alert is
  attached to the alarm event before its outbox entry settles. Every chat refusal is built by
  `graderChatRefusal`, so its `MessageDetail` vocabulary has one owner.
- `client-actions.ts` owns `CLIENT_ACTIONS`, the Studio chat directives app-ai teaches only to a
  client whose `/chat` request lists them in `clientActions`: `requestSupport` and `moveBox`,
  which a lib build without their handlers would leave undone after telling the owner they
  happened. `readClientActions` reads the list, ignoring a name it does not gate. The gate is the
  prompt alone: app-ai neither holds nor rewrites a reply.
- `grader-chat-output.ts` is the Grader chat's link guard, the one deterministic check on a reply.
  It first finds the buttons block exactly as lib's `parseChatEnvelope` does — the whole reply as
  JSON, else the first fenced block that parses as an object carrying an envelope key, else the span
  from the first `{` to the last `}` — and holds it to the one shape the prompt's buttons block
  teaches: only a non-empty `choices` array of objects with a non-empty string `label`, an optional
  `action` that is exactly one of its exported `GRADER_CHAT_CHOICE_ACTIONS` as `JSON.parse` decodes
  it — the closed list held in step with the buttons block by `test/assistant-prompt-blocks.test.ts`
  — and `args` holding only a string `href` for `grader.open-link` alone. lib shows a Grader reply
  as plain text, so beside that one block a reply may hold only sentences, paragraphs and list lines
  opening with `- ` or a number: the prose around the block, the whole reply when none parsed, and
  every label withhold the reply as `malformed-choices` when they hold a backtick, an asterisk, a
  tilde, a vertical bar, a square bracket, a brace, a backslash before ASCII punctuation or at a
  line's end, an underscore not between two letters or digits, an HTML or XML tag shape or an
  entity or numeric reference, or a line holding text indented four spaces or a tab, holding only
  `-`, `=` and spaces, or opening with a heading, quote or `+` bullet — every GitHub Flavored
  Markdown construct and JSON form lib would show as raw characters. A whole reply that `JSON.parse` reads as any value but the block is withheld too. The
  guard then reads the prose outside the block and every decoded label and `href`, never an action
  name, after NFKC folding, invisible-character removal and mapping WHATWG dot equivalents to `.`,
  so neither a JSON escape nor a folded character hides a link. Every link is a button, so prose and
  labels carry no URL: any URI-shaped token — a letter-first scheme, a colon and then any
  non-whitespace character, `https://limespot.com` and `mailto:` included — is withheld by
  structure, never by a scheme list, and so is a hostname opening with `www.` or followed by a path,
  port, query or fragment. A bare hostname names a site and passes only when the WHATWG `URL` parser
  reads it with no credentials, no backslash in its authority and a limespot.com host; a plain email
  address passes only as exactly one recipient at limespot.com with no `%`. Any four dot-separated
  octets withhold the reply, and so does an unfinished or empty one. A brand on its list of names
  shaped like a hostname (`Judge.me`) passes only as a plain whitespace-bounded word, in any letter
  case, with nothing but opening or closing punctuation or a possessive around it; with a scheme,
  path, port, query, fragment, subdomain or `@` it is read as a hostname like any other, and brands
  are recognized only after folding. A button's `href` must be a whole `https` URL with no
  credentials, no backslash in its authority and a limespot.com host, and an action name written
  anywhere but a valid block's `action` is read as a hostname. The withhold reason is logged and
  never sent. It judges no claim: what the chat may claim is the boundaries prompt's to govern,
  grounded in the booklet, beside the "AI can make mistakes" disclaimer lib shows in the chat UI.
