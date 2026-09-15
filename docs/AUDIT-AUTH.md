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
  "statusCallbackUrl": "https://limespot.com/studio/activate/api/status",
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
  "statusCallbackUrl": "https://limespot.com/studio/activate/api/status",
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

## Scope and quotas

An audit session can call only:

- `POST /files` for its own evidence uploads, with a destination prompt of
  `onboarding-batch-all`, `onboarding-batch`, `onboarding-review-gate-all`, `onboarding-review-all`, or
  `onboarding-currency-recovery`. Destinations are repeated multipart `prompt`
  fields (the extension uploads one file for multiple consumers), not the
  `X-Personalizer-System-Prompt` inference header. At least one destination is
  required, values must be unique, at most four may be supplied, and every supplied value must be in
  this exact allowlist. Exactly one multipart `file` part is accepted.
- `POST /messages` with `onboarding-batch-all` or `onboarding-batch`, a matching
  `X-Personalizer-Ruleset-Version`, one structured user message, and only text or
  session-owned Files API references.

Inference remains proposal-only: review is an accepted upload destination but
not an allowed `/messages` selector. The audit path cannot delete files, call `/chat`, select another prompt,
send inline base64 files, provide tools, choose a model, raise output effort, or
fetch Brain defaults. `messages.ts` keeps the validated evidence message and
forces the registry's prompt, model, output budget, and effort.

Production per-session technical limits are configured in `wrangler.toml`: 30-minute
session lifetime, 40 successful uploads, 64 MB aggregate upload bytes, 8 MB per
upload, three successful inference calls, and 1 MB serialized JSON per inference.
The Durable Object reserves quota before paid upstream work, counts concurrent
reservations, records returned file IDs atomically, commits successful calls,
and releases reservations on an upstream non-2xx response or thrown dispatch.

Public attempt enforcement is stricter than the technical three-message ceiling: exactly two
successful allowlisted proposal inferences may complete for a stable `auditIdentifier`, including
across expired sessions and reissued activation tokens. A `started` reservation does not consume an
attempt. A non-2xx or thrown provider call produces `failed`, releases the reservation, and retries
the same `attemptNumber`; only successful proposal inference produces `completed` and increments the
strongly consistent counter. Staff activations are merchant-facing uncapped because each activation
uses a fresh audit identifier, while every staff session still has the upload, byte, message and
expiry safety ceilings above.

There is no cross-session app-ai spend counter. The limespot.com issuer therefore
owns the global controls: email-verification attempt limits, per-identity/IP
activation limits, a daily activation ceiling, and the launch-wide budget kill
switch. Cloudflare/Anthropic account alerts and hard spending controls are the
outer operational cap. The public issuer must not launch without those controls;
per-session app-ai quotas alone are not a global budget.

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
POST <the activation's statusCallbackUrl, for example https://limespot.com/studio/activate/api/status>
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

`status` is `started`, `completed`, or `failed`. Failed delivery leaves the immutable event at the
head of the outbox; a delivery attempt is bounded to five seconds so website latency cannot hold the
audit indefinitely. The Durable Object alarm retries in order with the same body and
`eventIdentifier` but a fresh signature timestamp. Website D1 deduplicates `eventIdentifier`,
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
cross-link completion counting, activation consumption, quota reservations, and concurrent file-ID
ownership strongly consistent. At expiry, an alarm releases pending work, emits `failed` where
needed, and removes provider file identifiers and per-session counters. It retains only the stable
completion ledger, activation replay identifiers and pending callback outbox needed to enforce the
cross-link contract.

Clearing an owned file identifier removes audit authorization to reference it; it does not delete the
upstream Anthropic Files object. App-ai's existing content-hash dedup layer may retain a provider
reference in `FILES_KV` for up to 30 days and can share an identical object across requests, so a
session alarm cannot safely delete it unilaterally. Public privacy copy and the processor retention
policy must describe this distinction. Provider-side deletion/retention is an operational production
policy, not a capability claimed by the audit session TTL.

Production provisioning requires all three encrypted secrets plus the HTTPS
`AUDIT_STATUS_ORIGINS` allowlist before the route is usable. `npm run deploy:dry-run` validates the class
export, binding, migration, and revision-stamped production launcher without deploying or invoking
Anthropic.

**Cross-repo deploy ordering (HARD): app-ai deploys BEFORE the website activation issuer.** The
claim set is matched exactly on both sides, so there is no shape both accept: a worker that requires
`statusCallbackUrl` refuses a token without it, and a worker that does not know the claim refuses a
token carrying it as an unexpected key. app-ai therefore deploys first, while the website mints no
activation tokens and nothing can be refused; the website issuer follows; the audit request path is
enabled last. Enabling the website issuer ahead of the worker would 401 every exchange.
