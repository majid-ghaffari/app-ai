# src/toolsets/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md) · Standards: [docs/TOOLSETS.md](../../docs/TOOLSETS.md)

The worker's AI-tool layer: named TOOLSETS (one directory per backend) plus
the registry that composes them per request. Handlers consume tools ONLY
through the registry — each endpoint passes the subscriber's available
integration parties (`handlers/chat.ts` takes `availableParties`, threaded from
the router's validate-context-id call) and treats the composition
(`{ names, definitions, execute }`) as its whole tool surface. Composition is
data-driven off each descriptor's `integrationParties` gate (empty =
always-active); adding a toolset never edits handler logic.

This registry is SERVER-executed tools only (the worker dispatches each
`tool_use` against a backend). The handler also has a CLIENT-tool mode
(a prompt registry entry's `clientTools`; first consumer = the `onboarding-chat`
prompt with `look_at_page` — see the top-level CLAUDE.md → CLIENT-tool mode)
whose tools execute in the client, not the worker. Such client tools are NOT
toolsets and do NOT live here: they live in `../lib/client-tools.ts`, WITH their
prompt, because the worker never dispatches or credentials them — it only hands
the model's calls back to the client.

The per-module map — what each toolset file owns — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md), read on demand. What binds every toolset is below.

## Conventions

- **Descriptor contract** (`name` / `definitions` / `resolveCredentials` /
  `execute`) and the full how-to-add-a-toolset guide live in
  [docs/TOOLSETS.md](../../docs/TOOLSETS.md).
- **Degrade, never throw:** every `execute` resolves to
  `{ ok, name, result, summary }` so the agent loop can feed failures back to
  the model (`tool_result` with `is_error`) instead of aborting the turn. Tool
  input is untrusted despite the frozen schema, so the platform executors guard
  their required fields (`method`/`path` for REST, `query` for GraphQL/GAQL)
  and degrade to an `Invalid input: …` result — a clean local signal the model
  can act on, and no malformed proxy round-trip (e.g. a `path`-less REST call
  becoming `/rest/undefined`; an array is not mistaken for an object). The REST
  executor also normalizes sloppy input that is still well-formed enough to
  send: leading slashes on `path` are stripped (no `rest//v3/...` double-slash
  misroute), a query string embedded in `path` is split off and merged with the
  `query` object (no malformed double-`?` URL), an array `query` is
  ignored rather than serialized as `?0=…&1=…`, and `null`/`undefined` query
  values are dropped rather than serialized as `"null"`/`"undefined"`; a
  lowercase `method` is uppercased so it still matches the body-forwarding check
  and reaches the platform as a standard HTTP verb.
- **Model-visible contract is frozen:** tool names, input schemas, and output
  shapes are pinned by the lib repo's `admin/ai/CONTRACTS.md` §2 and the
  contract snapshot in `test/toolsets.test.ts` — schema changes are contract
  changes.
- **Credentials:** resolved per request via `resolveCredentials` and never model-visible. The
  context-ID is retained only as private request-log correlation; service tokens are redacted and
  never logged. Endpoints expose a
  toolset only when the subscriber's available parties satisfy its
  `integrationParties` gate (the five standards in docs/TOOLSETS.md).
- **Brain is the source of truth** for every shape this layer touches — the
  personalizer toolset's `/v2/ai-tools/*` + per-record admin shapes AND the
  AI integration-bridge wire contract consumed by `integration-bridge.ts` — mirror
  the sibling `brain` repo's C# exactly (root CLAUDE.md → Hard rules).
- **Platform toolsets never hold a platform token.** The `shopify` /
  `bigcommerce` / `klaviyo` / `google-ads` toolsets resolve only the call
  channel toward Personalizer's integration bridge (`integration-bridge.ts`); Personalizer is the
  credential custodian and relays each call under the merchant's own
  installed-integration credentials. The behavioral boundary is the tool
  descriptions' write-caution language plus the merchant token's OAuth scopes
  (docs/TOOLSETS.md → Platform toolsets).
- **Platform errors are data, not degrades.** The `X-Ls-Integration-Bridge-Error` header is
  the discrimination rule: absent → the platform's status + body surface
  verbatim to the model (`ok: true`, any status); present → the LimeSpot
  envelope degrades the call (`ok: false`).
- **Every platform toolset is party-gated, and its own descriptor declares the gate.** Each
  toolset's `integrationParties` in its `index.ts` is the source of truth for which
  `IntegrationParty` opens it; no document restates the pairing. A subscriber sees a toolset only
  when that party is in their available set (from validate-context-id) — no endpoint allowlist.
