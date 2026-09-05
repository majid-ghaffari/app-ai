# Known Issues — app-ai

**Parent:** [../CLAUDE.md](../CLAUDE.md)

Honest current limitations. Each entry is a present-state constraint, not a bug
to be ashamed of — most are deliberate trade-offs documented so a reviewer
isn't surprised.

## Active

### Placement system prompt is not cacheable on Haiku 4.5

The placement system prompt (~370 tokens) sits below Haiku 4.5's minimum
cacheable prefix, so it is left uncached. The caching win on the placement path
is the uploaded file blocks (thousands of tokens), not the system prompt.
Padding the prompt to clear the floor would cost more than it saves. See
[DECISIONS.md](DECISIONS.md) #8. Not a defect — a measured choice.

### `count_tokens` pre-flight is advisory only

`handlers/messages.ts` calls the free `count_tokens` endpoint for large payloads
and logs the estimate (warning past a soft threshold). It NEVER gates or rejects
the live request — it is wrapped in try/catch and a failure is swallowed with a
log line. So a payload that would exceed the model's context window is not
blocked here; the live Messages call surfaces that as the real error. By design:
the pre-flight is observability, not a guard.

### Image-block typing may add a metadata GET per fileId

To choose `image` vs `document` for each `/chat` `fileId`, `buildFileContent`
(`handlers/chat.ts`) reads the media type sealed in the resolved reference and
issues a provider metadata GET only for a reference that carries none. Those
lookups run in parallel (`Promise.all`) but are real extra round-trips, and a
lookup failure falls back to `document`. This is the price of sending images as
`image` blocks (Anthropic 400s an image inside a `document` block); the typing
is not cached across calls within a session.

### Optional live token-savings diagnostic requires manual credentials

`scripts/verify-caching.mjs` proves caching engages against the deployed worker,
but it needs a master `X-Personalizer-Context-ID` and a reachable target. It
cannot run in plain push-CI (no secrets). Operators may run it manually or via a
`workflow_dispatch` job guarded on repo secrets. It is not a release gate. See
[TESTING.md](TESTING.md).
This is an inherent property of integration-testing a deployed, authenticated
target, not a gap to close.

### Offline tests can't catch a silent cache invalidator

The unit/integration suite mocks `fetch`, so it verifies the worker _attaches_
`cache_control` breakpoints correctly — it cannot verify Anthropic actually
_reads_ from cache. The optional live diagnostic can expose a real silent
invalidator (a per-request byte sneaking into a cached prefix) when that behavior
needs investigation.

### `FILES_KV` must be bound for dedup to be active

Content-hash dedup is LIVE only when `env.FILES_KV` is bound (it is, in
production — see `wrangler.toml`). If the binding is ever removed, dedup
gracefully no-ops to a plain upload: uploads keep working, but identical bytes
mint fresh `file_id`s and the placement file-block cache entry won't be shared
across calls (each upload is a distinct cache key). Not a failure mode — a
degradation that the code handles silently.

### Rotating `TOKEN_ENCRYPTION_SECRET` is a hard cutover

Neither sealed envelope carries a key identifier: a file reference
(`file_ref_v1_…`, `inference/file-references.ts`) and a continuation token
(`continuation_v2_…`, `inference/continuation.ts`) are AES-GCM ciphertext under
subkeys derived from the one secret. Rotating it fails every outstanding
reference (at most 15 days old) and continuation (at most 24 hours old) closed
at once; there is no overlap window in which both the old and the new secret
open a token.

### Rotating `CLAUDE_API_KEY` also invalidates every sealed file reference

The Anthropic account scope sealed into a reference is a hash prefix of the API
key (`adapters/anthropic-wire.ts::fileAccountScope`), and resolution requires it
to equal the current key's scope (`file-references.ts::validateReferenceRoute`).
A key rotation is therefore a reference cutover as well, even though the
uploaded objects still exist in the same Anthropic workspace. `FILES_KV` dedup
records are keyed by the same scope, so they miss rather than mis-read.

### Reference lifetimes: a rejected cached reference is not recovered client-side

A sealed file reference expires 15 days after it is minted. Studio's screen cache
reuses a proposal — and the uploaded tile references inside it — for up to 14 days,
one day less, so the cache yields before the worker refuses. What remains is the
recovery path: when a cached reference is rejected for any other reason (a rotated
`TOKEN_ENCRYPTION_SECRET`, a rotated `CLAUDE_API_KEY`, a reference minted at the
boundary), Studio ends the review instead of dropping the tile, re-capturing and
re-uploading. That recovery is a Studio-side change.

### Grey-clouded `preview.personalizer.io` origin → "Too many redirects" (500)

Production is not subject to this. `wrangler.toml [vars] PERSONALIZER_API_URL` points at
`https://personalizer.io`, which is Cloudflare-fronted end to end, so the worker's
server-side subrequest reaches Personalizer over real HTTPS with no redirect loop.

The loop only appears when the worker's `PERSONALIZER_API_URL` targets the grey-clouded
preview Azure origin (`https://preview.personalizer.io`): the `personalizer.io`
Cloudflare zone's SSL/TLS mode is **"Flexible"**, so Cloudflare connects to that
origin over **HTTP** even when the Worker's `fetch` asks for HTTPS. The preview
Azure app has **HTTPS-Only** on → it 308-redirects HTTP→HTTPS to the same URL →
the Worker follows → still HTTP → 308 → loops until "Too many redirects", which
`lib/auth.ts`'s throw-to-500 maps to HTTP 500. Browsers/curl reach the CF edge as
real HTTPS → 200, so only the server-side Worker subrequest loops. The clean fix
for a preview target is a **"Full"** zone SSL/TLS mode, or dropping the preview
app's `HTTPS-Only` / `UseHttpsRedirection()`. Pointing at the raw Azure hostname
is a dead end — the cert is for `preview.personalizer.io`.

For fully-local development the worker talks to Personalizer over plain HTTP
(`.dev.vars`: `PERSONALIZER_API_URL=http://127.0.0.1:5000`) — see lib
`packages/storefront/src/admin/docs/LOCAL-AI-DEV.md`.
