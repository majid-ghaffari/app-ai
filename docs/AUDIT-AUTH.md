# Studio audit authorization

The browser extension can run the existing onboarding proposal transport on a
store that has no LimeSpot Context-ID. This is a separate, tightly scoped auth
path; ordinary Studio traffic continues to authenticate against Brain.

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
  "expiresAt": 1787272200000
}
```

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
  "expiresAt": 1787272200
}
```

The extension background worker sends `Authorization: Bearer ls_audit_<session
JWT>`, `X-LimeSpot-Audit-Store-Origin: <active-tab origin>`, and the
`X-LimeSpot-Audit-Plan-Version` it follows (see "The plan is versioned" below). App-ai requires
that explicit store-origin header to be the same store as the signed `storeOrigin`. MV3
background requests have a `chrome-extension://…` Origin (or none), and browser
JavaScript cannot set the forbidden HTTP `Origin` header, so HTTP Origin is not
the storefront proof. The extension must derive the dedicated header from the
active tab and reject a sender/tab mismatch before making the request. The
header is a consistency check, not a substitute for bearer secrecy; an attacker
who steals the bearer could copy it. Unprefixed bearer values do not enter audit
auth and continue through normal Context-ID auth.

Only HTTPS storefront origins are accepted. Loopback HTTP is allowed solely for local development.
One audit identifier may have only one unexpired browser session; a second activation receives a
conflict until that session expires. The one-use token is not consumed by this active-session
conflict and can be retried after expiry.

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

Inference remains proposal-only: review is an accepted upload destination but
not an allowed `/messages` selector. The audit path cannot delete files, call `/chat`, select another prompt,
send inline base64 files, provide tools, choose a model, raise output effort, or
fetch Brain defaults. `messages.ts` keeps the validated evidence message and
forces the registry's prompt, model, output budget, and effort.

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
an activation exchanges at most 900 seconds after it is issued and each exchange waits for the
previous session to expire, at least a second, so every activation still able to exchange is among
them. It keeps the latest two sessions' worth of abandoned reservation identifiers (5,904 at the
production limits), more than can still finalize inside any reservation's lease. Once callbacks are
delivered the outbox drains and reservations resume. `test/audit-auth.test.ts` runs a callback
outage across reissued sessions at the full 66-request churn against the 2 MB-refusing fake: the
fifth session's inference is refused at a 1.0 MB record, where without the budget the tenth
session's write fails past 2 MB.

### The plan is versioned

The plan above is version 1 of a contract lib and app-ai share. A Grader client names the version it
follows in `X-LimeSpot-Audit-Plan-Version` on `POST /audit/session/exchange`, `POST /files` and
`POST /messages`. `SUPPORTED_AUDIT_PLAN_VERSIONS` in `src/lib/audit-plan.ts` lists the versions this
worker holds an allowance for, beside the plan values themselves.

| Version | Capture                                                                                                | Proposal                                                                                                    | Allowance                                                                          |
| ------: | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
|       1 | 7 page kinds × 2 widths × at most 24 tiles: 1,500 px tiles overlapping by 100 px of a 32,767 px canvas | the whole-store request sent at most 4 times, then one per-page request a page, each repaired at most twice | 672 uploads and 66 inference requests a run, 2,688 uploads a session (table above) |

A request naming any other value — a version this worker does not list, or anything other than a
bare positive integer — answers 409 `AuditPlanVersionException` with `MessageDetail`
`audit_plan_version_unsupported`. The exchange checks it before it reads or consumes the activation,
and `/files` and `/messages` check it after the bearer and store origin and before any reservation,
so a refused request spends nothing.

A missing declaration uses the current plan, so a client that sends no header keeps working.

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
  duplicate them.
- **Session lifetime.** 30 minutes (`AUDIT_SESSION_TTL_SECONDS`). The lifetime is a security
  boundary for new work only: no upload or inference is admitted after it. A reservation holds a
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

There is no cross-session app-ai spend counter. The limespot.com issuer therefore
owns the global controls: email-verification attempt limits, per-identity/IP
activation limits, a daily activation ceiling, and the launch-wide budget kill
switch. Cloudflare/Anthropic account alerts and hard spending controls are the
outer operational cap. The public issuer must not launch without those controls;
per-session app-ai limits alone are not a global budget.

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
counters and session totals. Work still inside its lease stays pending, carried into a reissued
session if one opens; the alarm is always set for the earliest lease end, so a lease lapses on time
even while a reissued session is active, and the lapsed reservation is released and mirrored
`failed`. It retains only the stable
completion ledger, activation replay identifiers and pending callback outbox needed to enforce the
cross-link contract.

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
