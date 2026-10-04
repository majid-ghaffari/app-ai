# Studio audit authorization

The browser extension can run the existing onboarding proposal transport on a
store that has no LimeSpot Context-ID, and the store owner can then chat with LimeSpot about the
report (see Grader chat below). This is a separate, tightly scoped auth path; ordinary Studio
traffic continues to authenticate against Brain.

## Trust boundary

The limespot.com activation issuer verifies the user's email and signs a
short-lived activation JWT with `AUDIT_ACTIVATION_SIGNING_SECRET`. App-ai verifies
that assertion, consumes its identifier once in an audit-keyed `AuditSessionAuthority`, and
returns an origin-bound session signed with the distinct app-ai-only
`AUDIT_SESSION_SIGNING_SECRET`. The extension receives no signing key.

Those keys and the distinct callback key `AUDIT_STATUS_SIGNING_SECRET`
contain at least 32 random bytes and are Cloudflare encrypted secrets. Key separation means the
website issuer cannot mint app-ai session tokens directly, while a leaked callback key cannot mint
either token. No secret appears in `wrangler.toml`, logs, browser code, or model-visible input.

## Activation JWT contract

Header, exactly:

```json
{ "alg": "HS256", "typ": "JWT" }
```

Payload for a public, one-store activation:

```json
{
  "version": 1,
  "kind": "activation",
  "issuer": "limespot-website",
  "audience": "app-ai",
  "tokenIdentifier": "<unique opaque identifier, 1..256 characters>",
  "auditIdentifier": "<stable D1 UUID for this store>",
  "attemptLimit": 2,
  "email": "verified-merchant@example.com",
  "emailVerified": true,
  "entitlement": {
    "type": "store-origin",
    "storeOrigin": "https://merchant.example"
  },
  "statusCallbackUrl": "https://limespot.com/extension/activate/api/status",
  "issuedAt": 1787270400,
  "expiresAt": 1787271000
}
```

Payload for LimeSpot's sales/audit staff:

```json
{
  "version": 1,
  "kind": "activation",
  "issuer": "limespot-website",
  "audience": "app-ai",
  "tokenIdentifier": "<unique opaque identifier, 1..256 characters>",
  "auditIdentifier": "<fresh UUID for this staff run>",
  "attemptLimit": null,
  "email": "<staff mailbox on the entitling domain>",
  "emailVerified": true,
  "entitlement": { "type": "limespot-staff-multi-store" },
  "statusCallbackUrl": "https://limespot.com/extension/activate/api/status",
  "issuedAt": 1787270400,
  "expiresAt": 1787271000
}
```

`statusCallbackUrl` is where app-ai mirrors this audit's attempt status. It is REQUIRED: an
activation naming no destination is refused like any other malformed claim. The website owns its own
routing table, so the exact callback path travels in the signed token; app-ai owns where a callback
may be sent. The claim must be an absolute URL carrying no credentials, query, or fragment, and its
origin must appear in `AUDIT_STATUS_ORIGINS` — a comma-separated list of bare
`scheme://host[:port]` origins in `wrangler.toml` `[vars]`, HTTPS except for a loopback host outside
production, which local development uses. Production allowlists `https://limespot.com` alone. The
allowlist is what keeps a leaked website signing key from turning the callback outbox into a request
generator aimed at a host of the attacker's choosing.

`issuedAt` and `expiresAt` are integer epoch seconds. The token must be currently
valid and its declared lifetime cannot exceed 15 minutes. `auditIdentifier` is bounded to 128
characters. Public activations require `attemptLimit: 2`; staff activations require
`attemptLimit: null`. Public entitlement accepts a requested normalized origin that is the same
store as `entitlement.storeOrigin`: the same scheme and port, and hosts equal once one leading
`www.` label, where present, is removed from each, so a store that redirects its bare domain to its
`www.` form, or the reverse, is authorized on both. No other subdomain is equivalent and nothing
crosses domains (`src/lib/store-origin.ts`). A public session is bound to the signed
`entitlement.storeOrigin`, whichever form the exchange requested, so its status events name the
store by the origin the website recorded for its run, and a website that still compares that origin
exactly keeps accepting them. A staff session is bound to the origin the exchange requested.
Multi-store entitlement is accepted only when the signed, verified email ends in
`@limespot.com`; it permits choosing any origin for that one exchange, while the
activation identifier remains one-use. The website issuer creates a fresh
activation and audit identifier for each additional staff-run store. Reissued public magic links
reuse the same audit identifier, so a new link cannot reset the two-completion limit.

## Exchange and session contract

`POST /audit/session/exchange` takes:

```json
{
  "activationToken": "<activation JWT>",
  "storeUrl": "https://merchant.example/products/example"
}
```

It returns HTTP 201:

```json
{
  "sessionIdentifier": "<opaque SHA-256-derived identifier>",
  "accessToken": "ls_audit_<session JWT>",
  "expiresAt": 1789862400000,
  "graderChat": {
    "enabled": true,
    "perAudit": 25,
    "remainingInAudit": 25,
    "maxInputCharacters": 500,
    "sessionExpiresAt": 1789862400000
  },
  "runsValidFrom": "2026-01-01T00:00:00.000Z",
  "extensionBuiltAfter": "2026-01-01T00:00:00.000Z"
}
```

`graderChat` tells the extension and lib whether to show the chat box and its count. It is enabled
only when `GRADER_CHAT_ENABLED` is on and the exchange declared plan version 2; otherwise it
reads `enabled: false` with `perAudit`, `remainingInAudit` and `maxInputCharacters` of `0`. `perAudit` is
the number of messages the audit is answered across all of its runs and sessions, and
`remainingInAudit` what is left of it after earlier sessions of the same audit, so a reopened link shows
the true count. `runsValidFrom` and `extensionBuiltAfter` are the deployment's two kill switches as
ISO-8601 UTC instants, so the extension can drop a cached run or warn about its own build before
app-ai refuses either (see Kill switches below).

The exchange resolves every setting its answer and its session depend on — the signing keys, the
callback destination, the session lifetime, both kill-switch instants and the chat terms — before it
consumes the activation or supersedes the audit's session, so a deployment fault or a refusal leaves
the link usable and the visitor's current session live. It refuses with 410 `grader_run_revoked`,
consuming nothing, while `GRADER_RUNS_VALID_FROM` is still ahead of the moment the run would open,
because that run would already be revoked.

### Session status

`GET /audit/session` reads a live session's standing with its own bearer, so the extension can check
a run it cached before showing it again. It sends the same `Authorization: Bearer ls_audit_<session
JWT>`, `X-LimeSpot-Audit-Store-Origin`, `X-LimeSpot-Audit-Plan-Version` and
`X-LimeSpot-Extension-Built-At` headers as every audit request, and no body. Every answer, a refusal
included, carries `Cache-Control: no-store`, because the standing changes as the session does and a
410 is otherwise heuristically cacheable. It answers 200:

```json
{
  "sessionIdentifier": "<opaque identifier>",
  "expiresAt": 1789862400000,
  "graderChat": {
    "enabled": true,
    "perAudit": 25,
    "remainingInAudit": 24,
    "maxInputCharacters": 500,
    "sessionExpiresAt": 1789862400000
  },
  "runsValidFrom": "2026-01-01T00:00:00.000Z",
  "extensionBuiltAfter": "2026-01-01T00:00:00.000Z"
}
```

`graderChat` is the exchange's shape for the plan the request names, with the allowance as it stands
now. The call reserves nothing, writes nothing, starts no attempt, touches no daily counter and calls
no model. It refuses exactly as an audit request does: no audit bearer or an invalid one 401
`AuditAuthorizationException`, an expired or superseded session 401 `audit_session_expired`, a
session whose current run is older than `GRADER_RUNS_VALID_FROM` 410 `grader_run_revoked`, an
outdated build 409 `extension_update_required`, an unsupported plan 409
`audit_plan_version_unsupported`, and a store-origin header naming another store 403.

The session JWT uses the same exact HS256 header and this payload:

```json
{
  "version": 1,
  "kind": "audit-session",
  "issuer": "app-ai",
  "audience": "studio-extension",
  "sessionIdentifier": "<opaque identifier>",
  "auditIdentifier": "<activation audit identifier>",
  "attemptLimit": 2,
  "storeOrigin": "https://merchant.example",
  "issuedAt": 1787270400,
  "expiresAt": 1789862400
}
```

The extension background worker sends `Authorization: Bearer ls_audit_<session
JWT>`, `X-LimeSpot-Audit-Store-Origin: <active-tab origin>`, the
`X-LimeSpot-Audit-Plan-Version` it follows (see "The plan is versioned" below), and the
`X-LimeSpot-Extension-Built-At` instant its build was made (see Kill switches below). App-ai requires
that explicit store-origin header to be the same store as the signed `storeOrigin`. MV3
background requests have a `chrome-extension://…` Origin (or none), and browser
JavaScript cannot set the forbidden HTTP `Origin` header, so HTTP Origin is not
the storefront proof. The extension must derive the dedicated header from the
active tab and reject a sender/tab mismatch before making the request. The
header is a consistency check, not a substitute for bearer secrecy; an attacker
who steals the bearer could copy it. Unprefixed bearer values do not enter audit
auth and continue through normal Context-ID auth.

Only HTTPS storefront origins are accepted. Loopback HTTP is allowed solely for local development.

One audit identifier has one active browser session. A valid new activation for the same audit —
the visitor reopening the Grader from a fresh email link — supersedes it: the exchange issues the new
session, and the authority's record names only that session, so every later upload, inference or
chat message on the old bearer answers 401 `AuditAuthorizationException` with `MessageDetail`
`audit_session_expired`. The audit's progress carries across exactly as it does into a session
reissued after expiry: completed attempts, every reservation still inside its lease (finalized and
mirrored under the session that admitted it), the status outbox, the consumed activations, and the
Grader chat's count, replies, answered message identifiers with their stored outcomes, settlements
and message in flight. The new session starts a fresh first run that
owns no files. A replayed activation is still refused 409 `AuditActivationConsumedException`, and
superseding never opens an audit whose public attempts are spent.

## Scope

An audit session can call only:

- `POST /files` for its own evidence uploads, with a destination prompt of
  `onboarding-batch-all`, `onboarding-batch`, `onboarding-review-gate-all`, `onboarding-review-all`, or
  `onboarding-currency-recovery`. Destinations are repeated multipart `prompt`
  fields (the extension uploads one file for multiple consumers), not the
  `X-Personalizer-System-Prompt` inference header. At least one destination is
  required, values must be unique, at most five may be supplied, and every supplied value must be in
  this exact allowlist. Exactly one multipart `file` part is accepted.
- `POST /messages` with `onboarding-batch-all` or `onboarding-batch`, a matching
  `X-Personalizer-Ruleset-Version`, one structured user message, and only text or
  session-owned Files API references.
- `POST /messages` with `grader-chat` under plan version 2: the Grader chat, a text-only
  conversation about the audit's own report, described below.
- `GET /audit/session`, the one read-only exception: the session's standing, described under
  Session status above. Every other call in this list is reserved against the audit's record before
  any paid work; this one reserves, writes and spends nothing.

Proposal inference remains proposal-only: review is an accepted upload destination but
not an allowed `/messages` selector. The audit path cannot delete files, call `/chat`, select another prompt,
send inline base64 files, provide tools, choose a model, raise output effort, or
fetch Brain defaults. `messages.ts` keeps the validated evidence message and
forces the registry's prompt, model, output budget, and effort. A merchant context-ID that names
`grader-chat` on `/messages` or `/chat` is answered as an unknown route: the chat exists only for a
grader session.

## Limits: the conductor is never capped, a person's choices are

The Grader conductor decides how many pages it reads, how many tiles it uploads, and how often it
sends and repairs its proposal, and app-ai never holds a legitimate run to a fixed count. Every
limit app-ai keeps is either an abuse ceiling no legitimate run can reach — because a session key
can be lifted out of the browser — or a limit on something the person chooses to do.

### A session is a sequence of runs

A run is one Grader pass: its evidence uploads, then its proposal inferences. The first run opens at
exchange. An upload that arrives after the current run has reserved a proposal inference opens the
next run, which is what Studio's retry produces, and no client signal is trusted to draw that
boundary. The new run starts with a fresh allowance, owns only the files it uploads itself, and
releases any proposal request the previous run left pending.

The conductor sends a proposal request only after it has given up on the one before, so a new
proposal request supersedes a pending one instead of being refused: a request whose caller's
transport timed out and disconnected never holds the session. The superseded request is mirrored as
`failed`, and its late outcome, if the worker still produces one, changes nothing.

### One abuse ceiling, derived from the grader plan

`src/lib/audit-plan.ts` derives the most one run can need from the way the conductor captures and
proposes, which is Studio onboarding's own:

- every page kind the proposal prompts plan — their page vocabulary of seven, pinned to the prompt
  text by `test/audit-plan.test.ts` — read at desktop and mobile width;
- every tile Studio's capture cuts one width of a page into, at most 24;
- the whole-store proposal sent at most four times, then a per-page proposal for every page, each
  request repaired at most twice.

**Tiles.** `sliceImageIntoTiles` (`packages/storefront/src/admin/ai/page-perception.ts`) cuts a
capture into `TILE_MAX_HEIGHT` (1,500 px) tiles that overlap by `TILE_OVERLAP` (100 px): a capture
`H` pixels tall yields one tile up to 1,500 px and `⌈(H − 100) / 1,400⌉` beyond. Lib caps neither the
page height nor the tile count. A capture is one canvas, so the tallest canvas the browser holds —
32,767 px in Chrome, where the extension runs — bounds it: `⌈32,667 / 1,400⌉ = 24` tiles. Scaling a
desktop capture to at most 1,200 px wide and capturing a page taller than 3,000 px at 0.7 scale only
shortens the raster.

**Uploads.** Each tile is one `/files` upload naming `onboarding-batch-all` and `onboarding-batch`;
an audit session uploads no HTML and no review capture. A recapture adds no upload. In lib,
`relayCaptureRaw` (`packages/storefront/src/admin/ai/agent/batch-runner.ts`) enqueues a width's
upload only after its capture returned a non-empty image, and `readPuppetsWithOneRecapture`
recaptures only a width that returned none, so each width of a page contributes one capture. The
proposal-only audit conductor exits before the QC walk, so a run captures each page once per width.

**Inference requests.** `resolveAllPlans` (`batch-runner.ts`) sends the whole-store
`onboarding-batch-all` request and sends it again after a failure the same request can recover from:
`inferenceAttemptsFor` (`packages/storefront/src/admin/ai/brain/inference-provider-error.ts`)
allows four attempts after a 429 and three after a 5xx or 408. Each attempt is repaired at most twice
(`MAX_BATCH_REPAIR_ATTEMPTS`, `packages/storefront/src/admin/ai/brain/batch-output.ts`), three
requests in all. When the whole-store request answers 413 or its reply leaves a page out, every page
it did not plan gets its own `onboarding-batch` request from the tiles already uploaded, repaired at
most twice and never resent. Neither retry uploads anything, so both stay in the run whose tiles they
read.

| Allowance                                      | Uploads | Inference requests | Arithmetic                                                                |
| ---------------------------------------------- | ------: | -----------------: | ------------------------------------------------------------------------- |
| Planned run                                    |     336 |                 33 | 7 page kinds × 2 widths × 24 tiles; (1 + 2 repairs) × (4 sends + 7 pages) |
| Run ceiling, `AUDIT_RUN_HEADROOM` `2`          |     672 |                 66 | planned run × 2                                                           |
| Session upload allowance, `AUDIT_MAX_RUNS` `4` |   2,688 |                  — | run ceiling × 4                                                           |

The Grader walks at most five of those page kinds — Home, Product, Collection, Cart and Search, in
lib's `packages/storefront/src/admin/ai/agent/onboarding-page-order.ts` — so its own worst run is
`5 × 2 × 24 = 240` uploads and `(1 + 2) × (4 + 5) = 27` inference requests. Its two public attempts
in one session come to 480 uploads, and all four runs a session may start to 960, against the
session's 2,688; each run's 27 requests sit against the run's 66. The margin is the headroom of 2 on
top of the seven-kind plan, which already exceeds the five pages the Grader reads. For scale, a
measured five-page run on a live SHOPLINE storefront made 18 uploads (1.14 MB in total, the largest
193 KB) and one proposal request of 17.5 KB; a run on another live storefront made 39 uploads, and
runs on development stores 19 to 26.

Inference requests are held to the run ceiling per run. Uploads are held to it per session —
`AUDIT_MAX_RUNS` runs' worth — because an attempt that fails before its proposal leaves no boundary
the server can see: its uploads and those of the attempt that retries it arrive in the same run, and a
per-run count refused the third attempt of a 7-page store after two such failures. Every attempt
draws on the session allowance until it is spent. The ceiling follows the page vocabulary, so a
conductor that audits another page kind raises it without a configuration change. Every inference
request a run reserves counts, including one later superseded or failed, so a lifted key cannot fan
concurrent paid calls out past it. An upload beyond the session allowance or an inference beyond the
run ceiling answers 429 `AuditQuotaException`.

One upload is at most `AUDIT_MAX_UPLOAD_BYTES` (8 MB) and one inference request at most
`AUDIT_MAX_MESSAGE_BYTES` (1 MB) of serialized JSON. A tile is a JPEG of at most 1,200 × 1,500 px,
far under the upload limit. A whole-store request names its tiles by file reference, about 750 bytes
each: the seven-kind plan's 336 tiles serialize to 271 KB, which `test/audit-auth.test.ts` admits.
The rest of the request is at most 12 candidates a page with 2,000-character excerpts, 168 KB for
seven pages, which leaves more than 500 KB of the limit for the previous reply a repair carries. The
extension enforces the same two limits before it sends (its `lib/contracts.ts`), so they stay as they
are: raising one here alone would admit no larger request. There is no aggregate byte or token cap: a
session's bytes are bounded by its upload allowance times the upload size limit.

The Durable Object reserves before paid upstream work, counts concurrent reservations, records
returned file IDs atomically, commits successful calls, and releases a reservation on an upstream
non-2xx response or thrown dispatch.

The whole session is one Durable Object entry, and Cloudflare holds a SQLite-backed object's key and
value together to 2 MB. A file reference is about 750 bytes, so a run holding the session's 2,688
uploads by reference would pass that limit near its 2,500th upload and fail to record a file the
provider had already accepted. The run therefore owns each file as the SHA-256 digest of its
reference, 43 characters, and checks a proposal's references by their digests. A session that spends
its whole upload allowance in one run then stores about 230 KB, which `test/audit-auth.test.ts`
proves through `worker.fetch` against a storage fake that refuses an entry past 2 MB.

The status outbox, the abandoned-reservation identifiers and the consumed activation identifiers
carry into every reissued session. While callbacks fail, each failed inference leaves a `started` and
a `failed` event, up to 528 a session at the production ceilings, so reissued sessions would grow the
record until a write failed, possibly just after a paid inference returned. The authority therefore
refuses every reservation, with 503 `AuditSessionBacklogException` and before any provider call,
while the stored record serializes past 1 MB (`SESSION_RECORD_BUDGET_BYTES`). Between reservations
the record grows only by finalizing work already reserved — one status event for the one pending
inference a session can hold, and for an upload a digest in place of its larger pending entry — and
by an exchange's activation identifier. It keeps the latest 1,024 consumed activation identifiers:
an activation exchanges at most 900 seconds after it is issued, and the issuer's resend interval and
per-email and per-network windows hold one audit far below 1,024 activations in that time, so every
activation still able to exchange is among them. It keeps the latest two sessions' worth of abandoned reservation identifiers (5,904 at the
production limits), more than can still finalize inside any reservation's lease. Once callbacks are
delivered the outbox drains and reservations resume. `test/audit-auth.test.ts` runs a callback
outage across reissued sessions at the full 66-request churn against the 2 MB-refusing fake: the
fifth session's inference is refused at a 1.0 MB record, where without the budget the tenth
session's write fails past 2 MB.

### The plan is versioned

The plan above is the capture and proposal plan of versions 1 and 2 of a contract lib and app-ai
share. A Grader client names the version it
follows in `X-LimeSpot-Audit-Plan-Version` on `POST /audit/session/exchange`, `POST /files` and
`POST /messages`. `SUPPORTED_AUDIT_PLAN_VERSIONS` in `src/lib/audit-plan.ts` lists the versions this
worker holds an allowance for, beside the plan values themselves.

| Version | Capture                                                                                                | Proposal                                                                                                    | Allowance                                                                          | Chat                                                                                       |
| ------: | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
|       1 | 7 page kinds × 2 widths × at most 24 tiles: 1,500 px tiles overlapping by 100 px of a 32,767 px canvas | the whole-store request sent at most 4 times, then one per-page request a page, each repaired at most twice | 672 uploads and 66 inference requests a run, 2,688 uploads a session (table above) | none: `grader-chat` answers 403 `grader_chat_not_in_plan`                                  |
|       2 | as version 1                                                                                           | as version 1                                                                                                | as version 1                                                                       | at most 50 messages an audit, across its runs and sessions (`GRADER_CHAT_MESSAGE_CEILING`) |

A request naming any other value — a version this worker does not list, or anything other than a
bare positive integer — answers 409 `AuditPlanVersionException` with `MessageDetail`
`audit_plan_version_unsupported`. The exchange checks it before it reads or consumes the activation,
and `/files` and `/messages` check it after the bearer and store origin and before any reservation,
so a refused request spends nothing.

A missing declaration follows plan 1, so a client that sends no header keeps working and is offered
no chat.

A lib change to any input the plan mirrors — the page kinds, the widths, the tile height or overlap,
the whole-store sends, the per-page requests or the repairs — is a new plan version. Lib names it,
app-ai adds it here with its allowance, and the worker deploys before the client that sends it. A
worker that has not learned the version refuses the run at its exchange rather than failing it with
429 partway through.

### User choices are limited where they are made

- **Retries per session.** A session starts at most `AUDIT_MAX_RUNS` runs (production `4`): the
  first run and the three retries Studio offers. The upload that would open one more answers 429
  `AuditQuotaException` "This grader session has no retries remaining."
- **Completed public audits.** Exactly two runs may complete for a stable `auditIdentifier` — one
  lead and one store — including across expired sessions and reissued activation tokens. A run
  completes at its first proposal inference that returned a usable proposal: a complete reply, not
  cut off at its output limit, whose assistant text parses as the proposal contract of its prompt
  and plans every page the request's manifest names, each box naming a box type from the prompts'
  box vocabulary, a `before` / `after` / `replace` position, and a candidate number inside its
  page's range and the conductor's bound of 500. A request whose manifest does not parse — no page
  for the whole-store prompt, or not exactly one page with a range for the per-page prompt — sets
  no contract, so no reply to it completes a run (`src/lib/audit-proposal.ts`, decided from the request and response app-ai already
  holds, so the extension bridge reports nothing). This is at least as strict as the conductor's
  own reading, so a reply the conductor would reject never spends a run. A repair later in the same run consumes nothing more. A `started`
  reservation does not consume an attempt, and a non-2xx, thrown, superseded or unusable provider
  reply produces `failed` and leaves the same `attemptNumber` for the next request. After two completions, the upload that would open the next run answers 429 "This public
  grader has no attempts remaining." before any provider call. Staff activations carry no completion cap, because each uses a fresh audit
  identifier, while every staff session keeps the run limit, the per-run ceiling, the size limits
  and the session lifetime.
- **Audits per email, network and day.** These belong to the limespot.com issuer, which already
  enforces them before it signs an activation: per-IP and per-email hourly windows, the resend
  interval, the UTC-day email budget, Turnstile, and the launch kill switch. App-ai does not
  duplicate them. The Grader chat's own daily limits are app-ai's (see Grader chat).
- **Session lifetime.** 30 days (`AUDIT_SESSION_TTL_SECONDS`, `2592000`), and the Grader chat ends
  with it, so a visitor who keeps the session can return days later and go on chatting while the
  audit's message allowance lasts. That one value sets the bearer's `expiresAt` claim, the session
  record's expiry and alarm, `graderChat.sessionExpiresAt`, and how long a chat message's stored
  outcome is kept after it was answered; nothing else in app-ai bounds a session. Spending is held
  per run and per day, not by time: the session lifetime changes no allowance, attempt cap or daily
  limit. A visitor who lost the session — a closed tab or browser — reopens the Grader from a fresh
  link, whose activation supersedes the old session at once (see "Exchange and session contract").
  Three lifetimes stay shorter on purpose, because no live session needs them longer. A provider
  file reference lasts at most 15 days (`src/inference/file-references.ts`): a run reads its tiles
  only while it runs, the chat reads no file, and a retry uploads its own; holding references
  longer would widen every merchant upload's reference window and the `TOKEN_ENCRYPTION_SECRET`
  rotation bound with it. A sealed continuation lasts 24 hours (`src/inference/continuation.ts`),
  and no audit route uses one: the proposal prompts are one-shot and the chat's route refuses a
  model that needs provider state between turns. The chat's visitor and deployment counters stay
  UTC-day windows, and a settlement older than a day is dropped because the counters it names have
  reset. The lifetime is a security boundary for new work only: no upload, inference or chat message is
  admitted after it, and an expired or superseded bearer answers 401
  `AuditAuthorizationException` with `MessageDetail` `audit_session_expired`. A reservation holds a
  lease from its admission: the upstream inference deadline (`src/inference/deadline.ts`), which
  an audit inference counts from that same admission, plus a one-minute finalization grace. The
  proposal it guards is therefore finalized, counted and delivered even when the model answers
  after the session expired, including after a reissued link opened the next session. The alarm
  releases a lapsed lease on its own schedule, whichever session is current, and mirrors it
  `failed`; a result that still arrives afterwards reaches its caller without being counted. A
  reservation carried into a reissued session never counts toward that session's upload or
  inference totals, and its status events keep the session identifier and store origin of the
  session that admitted it, even when the reissued session is bound to the store's other form. A
  reservation an earlier worker admitted without its origin takes the origin of the session it is
  carried out of.

Apart from the Grader chat's daily counters, there is no cross-session app-ai spend counter. The
limespot.com issuer therefore owns the global controls: email-verification attempt limits, per-identity/IP
activation limits, a daily activation ceiling, and the launch-wide budget kill
switch. Cloudflare/Anthropic account alerts and hard spending controls are the
outer operational cap. The public issuer must not launch without those controls;
per-session app-ai limits alone are not a global budget.

## Kill switches

The extension keeps a run's report, chat and session for as long as the session lasts, so the
deployment holds two switches that make every client drop what it cached, both ISO-8601 UTC instants
in `wrangler.toml` `[vars]`, both read-only to clients, and both shipped at a past instant so a deploy
invalidates nothing. Each is configuration, so it changes through a committed `wrangler.toml` edit
merged to `main`, which deploys it.

### Run validity: `GRADER_RUNS_VALID_FROM`

A run no longer counts once it is older than `GRADER_RUNS_VALID_FROM`: it completed before that
instant, or, never having completed, it opened before it. The session record keeps the current run's
times for this (`runTimes`, below). A session whose current run is older is refused 410
`GraderRunRevokedException` / `grader_run_revoked` on a chat message (a replay of an answered one
included), a proposal inference, an upload into that run, and `GET /audit/session`. An upload that opens the next run —
the first upload after the run reserved a proposal, which is how a retry starts — is admitted while
the session has a retry left, because that run opens now; the next exchange's run opens now as well.
The exchange and `GET /audit/session` report the instant as `runsValidFrom` and every chat reply as
`graderChat.runsValidFrom`, normalized to `toISOString()` form. The extension calls `GET
/audit/session` before it reopens a cached run, so a raised instant drops that run before it is shown,
with no upload, proposal or chat message spent to learn it.

Revoking a run restores nothing: a completed public attempt still counts toward the audit's two, and
answered chat messages still count toward its allowance, because both belong to the audit and the
operator decision keeps every spending cap as it is. A visitor whose run is revoked starts a fresh run
within those limits. App-ai enforces the instant on its own routes only; the website's report-email
endpoints verify the bearer themselves and refuse a revoked run only once they apply the same instant.

To invalidate every run so far, set `GRADER_RUNS_VALID_FROM` to the current UTC instant, for example
`GRADER_RUNS_VALID_FROM = "2026-11-02T18:00:00Z"`, and merge the change to `main`.

### Extension build: `GRADER_EXTENSION_BUILT_AFTER`

The extension names the instant its build was made in `X-LimeSpot-Extension-Built-At`, an ISO-8601
UTC instant such as `2026-10-15T09:30:00Z`, on the exchange and on every relayed `/files` and
`/messages` call. A build made before `GRADER_EXTENSION_BUILT_AFTER` answers 409
`ExtensionUpdateRequiredException` / `extension_update_required`. The exchange checks it before it
reads or consumes the activation, so the visitor can exchange the same link after updating while the
link is still valid; every other audit request checks it after the bearer and store origin and before
any reservation, so a refused request spends nothing. A request naming no build time is read as made
at `2026-10-03T00:00:00Z`, because the header did not exist before then, so every build that sends
none is older than any later cutoff; a malformed value answers 400 `ArgumentException`. The exchange
reports the cutoff as `extensionBuiltAfter`, so a build can warn before it is refused. The header is
a compatibility switch, not a security boundary: any caller can name any instant. An extension
released before the header shows its generic failure for this refusal, since it shows its update
notice only for `audit_plan_version_unsupported`.

To make every older build update, set `GRADER_EXTENSION_BUILT_AFTER` to the build instant of the
oldest build still allowed and merge the change to `main`.

### No per-run switch

There is no switch that revokes one run. Its natural place, a flag on the audit's Durable Object
record, has no operator write path — only the worker writes Durable Object storage, so flipping it
would need a new authenticated operator route — and `FILES_KV` holds best-effort dedup metadata that
is never an authority, so a revocation key there would contradict its contract. One session already
ends early when a fresh activation for the same audit supersedes it, which only the visitor's
extension can exchange.

## Grader chat

Once a run's analysis has completed, the store owner can chat with LimeSpot about the report. The
extension relays `POST /messages` with `X-Personalizer-System-Prompt: grader-chat`, the session's
bearer and store-origin headers, and `X-LimeSpot-Audit-Plan-Version: 2`. The body is exactly
`{ messageId, messages, graderReport }`; its contract, the prompt, and the link guard are in
[docs/prompts/grader-chat.md](prompts/grader-chat.md). A request may also carry
`"responseMode": "keep-alive"`. Authorization reads it only after the bearer verified and the body
passed the byte limit, and removes it before this check. The keep-alive envelope begins only once
authorization admitted the message, so a refusal on the way — the switch, the plan, the size or the
shape — keeps its own status and plain error body
([DECISIONS #36](DECISIONS.md#36-a-long-messages-call-can-keep-its-connection-alive-by-the-callers-choice)).

The chat is enabled by default in production, and `GRADER_CHAT_ENABLED = "false"` is its off switch.
Rollout needs no toggle: the chat is offered only to a client that declares plan version 2, so a
published extension that sends plan 1 or no plan gets no chat, and the new extension build that
declares plan 2 and sends `messageId` is the first to offer it. Switching the variable off refuses
every message 503 `grader_chat_disabled` and offers no chat at exchange; switching it back on needs
no other change. What a reply claims is governed by the hardened boundaries prompt, grounded in the
booklet, beside an "AI can make mistakes" disclaimer lib shows in the chat UI; the one check in code
is the link guard, and a reply that links off limespot.com returns `withheld: true` with no text.

### The message identifier

`messageId` is a UUID v4 that lib mints for each visitor turn and sends unchanged on every retry of
that turn; it is matched without regard to case. It is bound to the audit and to the request's whole
transcript, the `messages` array. The first request that is answered records the identifier with a
fingerprint of that transcript and stores its outcome: the `/messages` envelope, the booklet version
and whether the reply was withheld. A later request with the same identifier and the same transcript
is a replay: it is answered from that stored outcome before any quota is held, with no inference and
no charge, and its `remainingInAudit` is the audit's allowance as it stands now. A replay is valid
from any live session of the audit, a reopened link included. The outcome is kept for
`AUDIT_SESSION_TTL_SECONDS` after the message was answered and then deleted by the audit's alarm.

- The same identifier with a different transcript, or an identifier whose outcome has been
  deleted, answers 400 `ArgumentException` / `grader_chat_message_reused`.
- A replay while the original is still being answered answers 409 `GraderChatBusyException` /
  `grader_chat_busy`; the caller retries it once the original has finished.
- A message the model failed, or that was refused, answered nothing, so a retry with the same
  identifier is admitted as a new message.

A caller that loses a response therefore retries the identical body, and a new visitor turn always
carries a new identifier.

### Admission, in order

Like every audit request, a chat message is first refused when its extension build predates
`GRADER_EXTENSION_BUILT_AFTER` (409 `extension_update_required`) or its plan version is unsupported
(409 `audit_plan_version_unsupported`).

1. `GRADER_CHAT_ENABLED` off → 503 `ServiceUnavailableException` / `grader_chat_disabled`.
2. A plan without chat (version 1, or no header) → 403 `AuditScopeException` /
   `grader_chat_not_in_plan`. An unsupported version is refused 409 first, as for every audit
   request.
3. A body past `AUDIT_MAX_MESSAGE_BYTES`, or a visitor turn longer than
   `GRADER_CHAT_MAX_INPUT_CHARACTERS` code points → 400 `ArgumentException` /
   `grader_chat_input_too_long`; any other departure from the strict body, a missing or malformed
   `messageId` included → 400 `ArgumentException`.
4. The session authority takes the message atomically:
   - the session is missing, expired or replaced → 401 `AuditAuthorizationException` /
     `audit_session_expired`;
   - the session's current run is older than `GRADER_RUNS_VALID_FROM` → 410
     `GraderRunRevokedException` / `grader_run_revoked`, a replay of an answered message included;
   - the identifier was answered: the same transcript is replayed from its stored outcome, and
     anything else answers 400 `ArgumentException` / `grader_chat_message_reused`;
   - another message of the audit is in flight → 409 `GraderChatBusyException` /
     `grader_chat_busy`, or 400 `grader_chat_message_reused` when it carries the same identifier
     with a different transcript;
   - the current run has not completed: still before or inside its analysis → 409
     `GraderChatUnavailableException` / `grader_chat_not_open`; its analysis failed or errored,
     with none pending → 409 `GraderChatUnavailableException` / `grader_chat_run_failed`. A run
     that completed with zero findings opens the chat;
   - the audit has been answered `GRADER_CHAT_MESSAGES_PER_AUDIT` messages → 429
     `GraderChatQuotaException` / `grader_chat_audit_limit`;
   - the audit has started twice that many messages, answered or not → 429
     `GraderChatQuotaException` / `grader_chat_attempt_limit`;
   - an assistant turn is not a reply this audit was given → 403 `AuditScopeException` /
     `grader_chat_history_unverified`.
5. The visitor's daily allowance, `GRADER_CHAT_MESSAGES_PER_VISITOR_PER_DAY` → 429
   `GraderChatQuotaException` / `grader_chat_visitor_limit`; then the deployment's,
   `GRADER_CHAT_MESSAGES_PER_DAY` → 429 `GraderChatQuotaException` / `grader_chat_daily_limit`. The
   visitor's counter also refuses once the visitor has started twice their daily allowance of
   messages that day, answered or not → 429 `GraderChatQuotaException` /
   `grader_chat_attempt_limit`. Each refusal releases the message and every hold it took, and
   refunds its attempt.

A refused message reaches no model. The 200 body is the `/messages` envelope plus
`graderChat: { remainingInAudit, sessionExpiresAt, bookletVersion, withheld, runsValidFrom }`, where
`runsValidFrom` is the deployment's run-validity instant as the exchange reports it.

### Accounting is the chat's own

Chat traffic never enters the audit's reservations. The audit's record keeps `chatMessages`, the
transcript fingerprints of the replies it was given (`chatReplies`), the one message in flight
(`chatInFlight`), every answered message identifier (`chatAnswered`) and the settlements still owed
to the daily counters (`chatSettlements`), apart from `pending`. A chat message therefore never
counts as a run inference, an attempt, an upload or a completed run, never produces a website status
event, never supersedes a pending proposal, and is never superseded by one. A message holds its slot
for the inference deadline plus the finalization grace, like a proposal reservation, and counts
against the visitor-visible allowance only once the model answered it, a withheld reply included; a
failed or cancelled call releases it.

Every model call is also an attempt. The audit's `chatAttempts` and the visitor's daily counter
record each admitted message, answered or not, and are held to `GRADER_CHAT_ATTEMPTS_PER_ANSWER` (2)
times the audit's allowance and the visitor's daily allowance. A message that fails, is aborted, or
lapses after its model call began keeps its attempt; only a message released before any model call —
refused at a daily limit, or restarted on a new UTC day — refunds it. So a caller who abandons calls
after provider I/O begins reaches 429 `grader_chat_attempt_limit` instead of starting unbounded paid
calls, while `remainingInAudit` still counts answered messages only.

### Settlement

One message is one reservation identifier, held in all three ledgers — the audit's slot, the
visitor's day and the deployment's day — before the model is called. The message in flight names
its reservation, its identifier, its transcript fingerprint and its visitor counter. Once the model
answered, the audit's ledger commits first, in one transaction: the count, the reply's transcript
fingerprint, the message in `chatAnswered`, its stored outcome, and a settlement record that
commits both daily counters. That commit is idempotent by the reservation and retried, so an answer
lost on the way back counts the message once; the reply reaches the visitor only after it lands, so
a delivered reply's fingerprint, count and outcome are never lost. A message that produced no reply
is released the same way: the release takes it out of flight and records a settlement for both
counters, `failed` when its model call began, so the attempt stays charged, or `released` when it
never did, so the attempt is refunded.

The request then settles the visitor's and the deployment's counters, each keyed by the same
reservation so a repeat changes nothing, and acknowledges the settlement. Whatever it leaves undone —
a counter unreachable, the worker stopped — the audit's alarm finishes a minute later and retries
each minute until it succeeds; a settlement older than a day is dropped, because the counters it
names have reset. A message whose lease lapses without an answer is released by the alarm, or by
the audit's next admission, with a settlement due at once. A commit for a reservation no longer in
flight is refused, and the visitor receives 504 `InferenceTimeoutException` / `inference_timeout`,
so every reservation is either committed or released, never both, and a commit that never lands
delivers nothing.

The allowance belongs to the audit — the store and lead the website signed — like the public
completion ledger: a retry opens a new run, an expiry or a reopened link opens a new session, and none
restores a spent message. A reopened session continues the same count and history, and its chat opens
once its own run completes. A message the superseded session still had in flight holds the audit's
one slot until it is answered, and counts.

### Daily limits and the visitor

The visitor and the deployment each have a named UTC-day counter in a separately addressed
`AuditSessionAuthority` instance, never the audit's: `grader-chat-daily`, and
`grader-chat-visitor:<pseudonym>`, where the pseudonym is an HMAC of the UTC day and
`CF-Connecting-IP` under a key derived from `TOKEN_ENCRYPTION_SECRET`. The raw address is never
stored, and the pseudonym changes every day. A request without the header shares one bucket. A
request captures its UTC day once: that one value names the visitor's counter and dates the holds on
both counters. A counter whose own UTC day is another — midnight passed between the capture and the
hold — refuses the hold with 421, and the handler releases the message and every hold it took and
admits it again on the new day's counters, so one visitor's day never lands on another day's
counter. Every hold counts against its counter's limit until the audit's settlement explicitly
commits or releases it, however long that takes, so a counter never admits more messages than its
limit. A counter keeps one entry per UTC day, and a hold settles on the entry of the day that took
it, named by the request's captured day: a new day starts an entry of its own, and a past day keeps
its entry while it still holds a message, so an answer that lands after midnight counts — and queues
its threshold alert — on the day that admitted it. The counter's alarm drops a past day once it
holds nothing, or at the end of the following day plus an hour when a hold no settlement reached is
all that is left.

### Volume alert

The deployment counter decides, inside the transaction that commits a message, whether its count
reached a multiple of `GRADER_CHAT_ALERT_EVERY` that has not alerted today, so each threshold alerts
exactly once however many messages commit at the same moment, and queues that alert in its own
outbox in the same transaction, under an id naming the counter's day and the threshold
(`YYYY-MM-DD:500`). Alerts still owed stay in the outbox across days, and each delivery settles
exactly the entry it delivered, so equal thresholds on consecutive days never collide. The counter's
alarm then posts `{ "text": "Grader chat: 500 messages today, limit 10,000" }` to the Slack incoming
webhook in the optional `GRADER_CHAT_ALERT_SLACK_WEBHOOK_URL` secret. A delivered alert leaves the
outbox. A network failure, a timeout, or a 408, 429 or 5xx answer is retried each minute for up to a
day; any other refusal, or an unusable destination, is logged as an error and dropped. Without a
webhook the alert is a logged warning, whose Seq delivery the counter hands to its Durable Object
event's `waitUntil` before the entry settles. Because the outbox belongs to the counter, a response
lost after the commit never loses an alert, and delivery never changes the chat's response.

### Logging

Message text is never logged: the handler records counts only and runs no inference trace.

## Website status mirror

App-ai is the enforcement authority for attempt state. It mirrors every transition to the website
through an ordered Durable Object outbox. The validated `statusCallbackUrl` is stored on the audit
session at exchange, so every event in a run reaches the same destination — a run outlives the
short-lived activation token that named it, and no later event re-reads the token. A re-exchange
under the same `auditIdentifier` re-resolves the claim of the newest activation and the retained
outbox drains to that destination, and narrowing `AUDIT_STATUS_ORIGINS` does not reach a URL
already stored on a live session — it governs the next exchange, not the sessions already running.
The exact callback is:

```text
POST <the activation's statusCallbackUrl, for example https://limespot.com/extension/activate/api/status>
Content-Type: application/json
X-LimeSpot-Audit-Timestamp: <current integer epoch second>
X-LimeSpot-Audit-Signature: v1=<base64url HMAC-SHA256(secret, timestamp + "." + rawBody)>
```

The raw JSON body has exactly these fields:

```json
{
  "version": 1,
  "eventIdentifier": "<unique idempotency UUID>",
  "auditIdentifier": "<signed activation audit identifier>",
  "sessionIdentifier": "<app-ai session identifier>",
  "storeOrigin": "https://merchant.example",
  "attemptNumber": 1,
  "status": "started",
  "occurredAt": 1787270400
}
```

`status` is `started`, `completed`, or `failed`. Delivery is asynchronous: exchange, reserve and
finalize only append the event and set the Durable Object alarm, so no upload or inference ever waits
on the website. The alarm delivers the outbox in order, each attempt bounded to five seconds, with the
same body and `eventIdentifier` but a fresh signature timestamp. An attempt that may succeed later —
no answer, a timeout, a 5xx, or a 401, 408, 425 or 429 — leaves the immutable event at the head and
retries it a minute later. Any other 4xx, such as the website's 404 for an unknown audit or its 409
for a conflicting event, is a refusal resending cannot change: the event is dropped with a warning
log, so it can never hold the events behind it. The alarm reschedules itself whenever events remain,
including after a handler failure. Website D1 deduplicates `eventIdentifier`,
allows `started -> failed -> started -> completed` for one attempt number, and treats completed as
terminal. It reports remaining public runs and refuses new public activations after two mirrored
completions; app-ai still enforces the cap if the mirror is delayed.

## Durable Object deployment

`wrangler.toml` binds `AUDIT_SESSIONS` to the exported `AuditSessionAuthority` class. New Durable
Object namespaces must use Wrangler's `new_sqlite_classes`; the retired `new_classes` form asks
Cloudflare to create a key-value-backed namespace and production rejects it. The
binding is required for exchange or audit-token requests; missing configuration
fails closed.

The `[[migrations]]` list is an append-only ledger, and Cloudflare resolves a deployment against the
tag the live script recorded. The first entry therefore keeps the tag and class name it was applied
under — `demo-sessions-v1`, creating `DemoSessionAuthority` — and the `audit-sessions-v2` entry after
it renames that class to `AuditSessionAuthority` through `renamed_classes`, which carries each
existing object's storage across. Those two strings are the live namespace's identity, not a missed
rename: editing or removing either one detaches every object's storage, including the completed
attempt ledger that enforces the public two-run cap, with no way to reattach it. One object is addressed deterministically per `auditIdentifier`, which makes
cross-link completion counting, activation consumption, run reservations, and concurrent file-ID
ownership strongly consistent. At expiry, an alarm removes provider file identifiers, per-run
counters and session totals; the chat's count, replies, answered messages, settlements and message in flight stay with the audit, and each stored chat outcome under its `chat-outcome:<messageId>` key until its own expiry. Work still inside its lease stays pending, carried into a reissued
session if one opens; the alarm is always set for the earliest lease end, so a lease lapses on time
even while a reissued session is active, and the lapsed reservation is released and mirrored
`failed`. It retains only the stable
completion ledger, activation replay identifiers and pending callback outbox needed to enforce the
cross-link contract.

The Grader chat's members — `chatMessages`, `chatReplies`, `chatInFlight`, `chatAnswered` and
`chatSettlements` — are optional: a session written before the chat existed reads as having answered
none, and a rolled-back worker carries them through untouched because chat traffic never enters
`pending`. Stored chat outcomes are separate keys of the same object and never count toward the
session record's 1 MB budget. The chat's daily counters live in their own named instances and add no
class, binding or migration.

An earlier worker stored a daily counter as one flat day — `{ day, count, attempts, pending,
alertedThrough, alertOutbox }` — and a session's chat message in flight and its settlements without
the day their holds were taken on. This worker reads both where it reads the record: a flat counter
becomes that day's entry with its count, attempts (the count plus the held messages when an older
record has none), held messages, alert threshold and queued alerts, an alert without an id taking
`YYYY-MM-DD:<count>` of that day; an undated message in flight takes the UTC day it was admitted,
and an undated settlement the day it was recorded. Each record is written back in the current shape
on its next change. Rolling back below this release is not supported for the chat's counters: an
earlier worker does not read the per-day record and starts the day's counters afresh, which loses
that day's counts and held messages. That is acceptable because the counters are daily and no other
data rides on them; the audit's own chat state, whose new members an earlier worker ignores, is
unaffected.

A rolled-back worker that refuses a new activation while a session is active, instead of
superseding it, locks a visitor who lost theirs out until the session expires, which under 30-day
sessions is up to 30 days; roll `AUDIT_SESSION_TTL_SECONDS` back with such a worker.

A session record carries `runTimes: { sessionIdentifier, run, startedAt, completedAt? }`, epoch
milliseconds for the current run, which `GRADER_RUNS_VALID_FROM` is compared with. A worker without
them carries the member through untouched: its next run keeps the previous run's times, and a run it
completes gets no completion time. The times therefore name their session and run, and the authority
trusts them only when both match the record. A run that has reached a proposal with times that are
absent or name another run reads as the session's issue time, taken from the request's verified
bearer, the earliest any run of the session can have opened; a run marked completed without a
completion time reads as its start. Both err toward a fresh run: such a run is revoked only when its
session was issued before the instant, never accepted forever and never refused regardless, and the
visitor's next upload opens a run with its own times. A run that only uploaded — the state such a
worker leaves when it opens a retry run with its first upload — has no report to revoke, so it is
adopted as opening at the moment it is next read: the status read and chat admission take it as
current, and its next upload or proposal records that moment as its start and continues with the
files it owns.

The authority writes one session shape, divided into runs, and also reads a session stored without
runs, whose counters cover the whole session. It reads such a session as its first run: the stored
successful uploads are the run's uploads, the stored successful and pending inference requests are
the run's inference requests, and the run owns every stored file. That shape counted every
inference as an attempt and kept no boundary between one run's files and the next, so it cannot
tell a repair from a retry whose uploads it has already accepted. The run is therefore read as not
yet completed: its next proposal is admitted as the next attempt, exactly as that session was
promised, and a pending inference completes the attempt number it was given when it succeeds. Once
that attempt completes, repairs consume nothing more, and the next upload opens a fresh run that
owns only its own files. A session that had already used both public attempts is refused any
further proposal or run, as it was before. A reservation admitted before the session had runs
carries no run number: it counts toward, and lands in, whichever run is current when it finishes, so
a retry upload admitted before the cutover is owned by the run its sibling uploads open after it.

The session record also carries whole-session totals — successful uploads, their bytes and
successful inference requests — and every pending reservation its upload bytes. The successful
uploads the session admitted, with the uploads it has pending, are what its upload allowance is
held against. The byte and inference totals, and each run's own count of successful uploads, hold
nothing in the current worker: they are the counts earlier worker versions enforce their limits
from, the whole-session limits of a version without runs and the per-run upload ceiling of the first
version with runs. A rollback to either therefore reads finite counts for every session the current
worker wrote and holds it to those limits, rather than comparing absent fields that never refuse
anything.

A run's stored ownership entries may be SHA-256 digests or file references, and the authority
accepts a proposal reference that matches either form. An authority that matches file references
only refuses, with 403 `AuditScopeException` and before any reservation, a proposal naming files
stored as digests; the retry's fresh uploads are stored as references there and admitted.

Clearing an owned file identifier removes audit authorization to reference it; it does not promise
immediate deletion of the underlying provider evidence. Anthropic's content-hash dedup layer may
retain a provider reference in `FILES_KV` for up to 30 days and can share an identical object across
requests, so a session alarm cannot safely delete it unilaterally. An audit route configured onto Kimi
stores encrypted evidence in R2; session expiry removes authorization immediately and the bucket's
16-day rule removes the object and hosted-id sidecar, while an image already accepted upstream
follows Kimi's retention policy because its delete operation is unavailable. Public privacy copy and
the processor retention policy must describe these provider-specific lifetimes before any audit route
resolves to Kimi. Provider-side deletion and retention are
operational production policy, not capabilities claimed by the audit session TTL.

Production provisioning requires all three encrypted secrets plus the HTTPS
`AUDIT_STATUS_ORIGINS` allowlist before the route is usable. `npm run deploy:dry-run` validates the class
export, binding, migration, and revision-stamped production launcher without deploying or invoking
an inference provider.

**Cross-repo deploy ordering (HARD): app-ai deploys BEFORE the website activation issuer.** The
claim set is matched exactly on both sides, so there is no shape both accept: a worker that requires
`statusCallbackUrl` refuses a token without it, and a worker that does not know the claim refuses a
token carrying it as an unexpected key. app-ai therefore deploys first, while the website mints no
activation tokens and nothing can be refused; the website issuer follows; the audit request path is
enabled last. Enabling the website issuer ahead of the worker would 401 every exchange.

**The 30-day session and the kill switches deploy before the extension and lib.** Every field they
add is additive — `runsValidFrom` and `extensionBuiltAfter` on the exchange, `graderChat.runsValidFrom`
on a chat reply — and the released extension and lib copy only the fields they know, so they keep
working unchanged. The website's report-email endpoints hold their own 24-hour window from the run's
start, so a report email for an older run is refused there however long the app-ai session lasts. Raising `GRADER_EXTENSION_BUILT_AFTER` past `2026-10-03T00:00:00Z` refuses
every build that sends no `X-LimeSpot-Extension-Built-At`, so it waits until the build that sends the
header is the one visitors have.
