# src/lib/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md)

Shared provider-neutral modules consumed by handlers, the router, toolsets, and
the inference runtime. `inference-types.ts` owns the canonical contracts;
provider HTTP, credentials, wire types, and serialization live only under
`../inference/adapters/`.

`auth.ts` mirrors the consumed members of Brain's validate-context-id response,
including `AiToolsContractVersion`, `AvailableAiTools`, and
`AvailableIntegrationParties`. The router accepts AI-tool capabilities only for
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
- `resolveStatusCallbackUrl` is where app-ai keeps the decision the website does
  not own: the signed claim carries the path, and only an absolute URL with no
  credentials, query, or fragment whose origin is in `AUDIT_STATUS_ORIGINS`
  reaches the outbox, so a leaked website signing key cannot aim it at a host of
  its own choosing.
