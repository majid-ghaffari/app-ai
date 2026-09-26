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
  "auditIdentifier": "<stable D1 UUID for this lead and exact store origin>",
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
`attemptLimit: null`. Public entitlement matches the requested normalized origin exactly.
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
JWT>` and `X-LimeSpot-Audit-Store-Origin: <active-tab origin>`. App-ai requires
that explicit store-origin header to equal the signed `storeOrigin`. MV3
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

`src/lib/audit-plan.ts` derives the most one run can need from the plan the conductor follows:

- every page kind the proposal prompts plan — their page vocabulary, pinned to the prompt text by
  `test/audit-plan.test.ts` — read at desktop and mobile width, with at most two tiles a width;
- one whole-store proposal, repaired at most twice and sent at most twice.

A recapture adds no upload. In lib, `relayCaptureRaw` (`packages/storefront/src/admin/ai/agent/batch-runner.ts`)
enqueues a width's upload only after its capture returned a non-empty image, and
`readPuppetsWithOneRecapture` recaptures only a width that returned none, so each width of a page
contributes one capture. `enqueueRawCapture` (`packages/storefront/src/admin/ai/agent/onb-capture-queue.ts`)
slices an audit session's capture to at most two tiles, and the proposal-only audit conductor exits
before the QC walk, so a run captures each page once per width.

That planned run is 28 uploads and 6 proposal inference requests. A run's ceiling is the plan times
`AUDIT_RUN_HEADROOM` (production `2`): 56 uploads and 12 inference requests. Inference requests are
held to it per run. Uploads are held to it per session — `AUDIT_MAX_RUNS` runs' worth, 224 uploads in
production — because an attempt that fails before its proposal leaves no boundary the server can
see: its uploads and those of the attempt that retries it arrive in the same run, and a per-run count
refused the third attempt of a 7-page store after two such failures. Every attempt draws on the
session allowance until it is spent. For scale, one
measured five-page run on a live SHOPLINE storefront made 18 uploads (1.14 MB in total, the largest
193 KB) and one proposal request of 17.5 KB. The ceiling follows the page vocabulary, so a conductor
that audits another page kind raises it without a configuration change. Every inference request a
run reserves counts, including one later superseded or failed, so a lifted key cannot fan concurrent
paid calls out past it. An upload beyond the session allowance or an inference beyond the run ceiling answers 429
`AuditQuotaException`.

One upload is at most `AUDIT_MAX_UPLOAD_BYTES` (8 MB) and one inference request at most
`AUDIT_MAX_MESSAGE_BYTES` (1 MB) of serialized JSON — the extension's own transport limits, far
above anything the conductor sends. There is no aggregate byte cap: a session's bytes are bounded by
its upload allowance times the upload size limit.

The Durable Object reserves before paid upstream work, counts concurrent reservations, records
returned file IDs atomically, commits successful calls, and releases a reservation on an upstream
non-2xx response or thrown dispatch.

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
  inference totals.

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
