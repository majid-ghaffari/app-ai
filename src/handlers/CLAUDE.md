# src/handlers/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md)

Route handlers. `src/index.ts` (the thin router) does CORS, the OPTIONS preflight,
and context-ID auth, then dispatches to one of these. Each handler owns one route
group and returns a `Response`; inference and file operations go through the
provider-neutral services in `../inference/`, and the AI-tool surface comes from
the toolset registry (`../toolsets/`). Handlers do not import provider wire types.

The per-handler map — which file owns which route group — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md), read on demand. What binds every handler is below.

## Structured logging and inference tracing

The router creates one request-scoped `LoggingRuntime`, retaining request/subscriber fields,
and handlers derive scoped loggers from it. Both `/messages` and `/chat` emit correlated TRACE
records for model-visible text/tool input, assistant output and usage, failures, client tool calls,
and server tool execution/results. Opaque file references, encoded media, continuation state, and
actual secret fields are redacted before logging. `LOG_TARGETS_*` configuration alone selects console, Seq,
multiple sinks, or ignore. Seq work is attached to Cloudflare `waitUntil`, fail-open, and never delays
or changes the inference response.

## Conventions

- `/messages` and `/chat` resolve model and effort only through prompt → group
  → tier → configured model, with the provider inferred from that model id by
  the model catalog. Registered-prompt callers cannot override model, provider,
  profile, file policy, or effort. Canonical client tools are serialized to
  the active provider's wire shape at the provider boundary.
- `visual-verify-free` is the protected-CI-only registered prompt. It reuses the
  visual-verification prompt text but owns a separate no-file group routed to the
  Workers AI binding; ordinary `visual-verify` remains on its production route.
  The router exposes it only when Brain proves `AdministerAllSubscribers` and
  verifies the Cloudflare-only route. The adapter reserves the strongly consistent
  daily quota after validating the canonical request and immediately before binding I/O. The
  quota-class header accepts only `diagnostic` or `acceptance`; missing means diagnostic. The
  handler carries it in the typed canonical request authority and leaves caller metadata unchanged.
- A known prompt with missing route configuration fails closed before file or
  provider I/O. Unknown-selector compatibility must never hide a missing
  `MODEL_*` binding. Registered `/messages` prompts preserve non-effort output
  configuration while replacing only caller effort with registry policy.
- A registered `/messages` reply the model stopped at `max_tokens` is never a
  success: it is logged at `warn` and answered 502 `InferenceTruncatedException`
  ([docs/DECISIONS.md → Conductor prompts carry their model's maximum output](../../docs/DECISIONS.md#conductor-prompts-carry-their-models-maximum-output)).
- A `/messages` request naming no registered prompt is a bounded Anthropic-wire
  passthrough: the caller owns its conversation, the registry's
  `getUnregisteredMessagesRoute` owns the model and `max_tokens` (a caller-sent
  value is replaced), and any `source.type === 'file'` block at any depth is
  refused as 400 `ArgumentException` before provider I/O — a raw provider id is
  not tenant-bound, so it never crosses this path.
- `/chat` resolves its whole route — registry entry, model profile, file
  policy, and the adapter's continuation requirement — inside one guard, so a
  rejected route (an unclaimed model id, an unmet capability, an override that
  moves the prompt off its group's shared file route, an absent binding)
  answers in the shape the caller's `Accept` negotiated: an SSE `error` event
  under `text/event-stream`, the JSON envelope otherwise. Nothing on that path
  reaches the router's Accept-blind catch.
- Handlers receive `corsHeaders` from the router and spread them onto every `Response`.
- The context-ID is already validated by the router before any handler runs.
  The same validation response supplies `AvailableIntegrationParties` and the
  version-gated `AvailableAiTools`; the router threads both into `handleChat`.
  An absent or unsupported `AiToolsContractVersion` supplies no Brain data tools.
- `GET /health` (`health.ts`) stays unauthenticated and keeps its success
  shape. In production it is also readiness: a required secret not set (a
  provider's key counting only while a resolved route uses that provider) or
  model bindings that do not route every prompt answer 503 with a status-only
  envelope — no secret name, binding, or model id. Provider-specific bindings and configuration
  required by a resolved route are validated there too; the protected Workers AI route checks its
  binding, authority, internal origin, enable switch, daily limit, and acceptance reserve. The
  reason goes to the log.
- A merchant route hit by an absent required secret answers the generic
  `SECRET_CONFIGURATION_PUBLIC_MESSAGE` envelope (`../lib/responses.ts`); the
  secret's name and the secret-store instruction stay in the thrown
  `SecretConfigurationError` and the log.
- `GET /prompts` (`prompts.ts`) is the one MASTER-gated route. The router
  validates the context-ID as usual; the handler then requires the resolved
  `SubscriberID` to equal `MASTER_SUBSCRIBER_ID` and otherwise returns the
  router's unknown-route body byte for byte, so a merchant cannot confirm the
  route exists. It resolves routes without inference and reports required
  secrets by NAME only — never a value, a prefix, or a length.
- It is also the one route whose context-ID may arrive in the URL, in a
  `personalizerContextId` query parameter. `prompts.ts` owns that parameter
  name and its only reader, `promptsDiagnosticsContextId`; the router calls the
  reader on that one dispatch alone, and only when the
  `X-Personalizer-Context-ID` header carries nothing, so the header wins and
  the master gate is identical either way. The URL form lets an operator open
  the diagnostics in a browser, at the honest cost that browser history and any
  URL-recording intermediary sees the credential — automation sends the header.
  A URL credential counts only while it authenticates as the master: a
  non-master one, and one Personalizer rejects, both answer exactly as a request
  carrying no credential, so the one route that reads the parameter is
  indistinguishable from every path that does not.
  `../lib/logger.ts` strips the value of a credential-bearing query parameter
  from every string entering a sink, so no log record carries it, and
  `test/architecture.test.ts` fails if a second module reads a credential from
  a query string.
- `/files` never assumes a provider, and no verb reaches an object this caller
  did not create. Upload names its destinations by registered prompt and answers
  with one shape: the first prompt's reference plus a `references` map naming
  every declared prompt, where prompts sharing a route share the one reference
  minted for it. A multi-route upload is one caller action: when any route
  fails, the objects the succeeding routes created carry no reference the caller
  can reach, so upload deletes them on a best-effort basis before answering with
  the failure, and a deduped result is left alone because an earlier upload
  still owns it. Delete resolves the route out of the sealed reference it is
  given and refuses one belonging to another tenant or to a route since
  configured onto another provider. Nothing enumerates a provider account — one
  account holds every tenant's uploads, so `GET /files` is not a route and falls
  through to the router's 404.
- The audit exchange and `ls_audit_…` bearer branch are the deliberate alternate
  auth path. They never call Brain and can dispatch only `POST /files` and
  `POST /messages` for its explicit onboarding proposal and QC prompt allowlist.
  The exchange refuses an unsupported `X-LimeSpot-Audit-Plan-Version` before it
  reads the activation.
- AI tools are consumed ONLY through the toolset registry
  (`../toolsets/registry.ts`): each endpoint passes the subscriber's available
  integration parties and AI-tool capabilities and treats the composition as
  opaque. Standards: [docs/TOOLSETS.md](../../docs/TOOLSETS.md).
- **CLIENT-tool mode** is the one designed exception to server-side execution.
  Its first consumer is the **`onboarding-chat`** prompt, whose
  registry entry carries `clientTools: [LOOK_AT_PAGE_TOOL]`. A prompt whose registry
  entry carries `clientTools` (mutually exclusive with `usesTools`) has its tools
  executed on the CLIENT, not the worker: `handleChat` sends those definitions to
  the model in place of the server toolset, and on a `tool_use` returns the calls
  in `done.toolCalls` and stops the turn without touching the toolset registry. The
  same done payload carries an opaque `continuation` token when provider state
  must survive the HTTP boundary. The client (the lib) runs them (`look_at_page`
  captures a store screenshot) and calls `/chat` again with the `tool_result`
  (the screenshot on `fileIds`) plus that token. The handler rejects malformed or
  cross-provider continuation before provider I/O. `look_at_page`
  is defined in `../lib/client-tools.ts`; the wire schema the model sees is the
  `page?: string` hint. See the top-level CLAUDE.md → CLIENT-tool mode.
- An adapter can set the provider-neutral `requiredOnNextTurn` hint when an
  ordinary terminal assistant turn must also survive the HTTP boundary, as
  Gemini does for thought signatures. `/chat` and registered `/messages` seal and return that
  state, accept the opaque token on the matching next request, and validate it
  before attachment/file/provider I/O. Ordinary Anthropic, Moonshot, and Kimi
  text adds no token; Moonshot/Kimi tool transcripts still carry sealed state.
- Accept the router's `LoggingRuntime`, derive a scoped logger, and thread it into shared helpers.
  Direct `console.*` calls are forbidden outside the logger's Console sink.
- Every HTTP error body — and every SSE `error` event payload — is the Brain wire
  shape (`{ Message, ExceptionType, MessageDetail? }`, built by `../lib/responses.ts`),
  so clients keep one error parser across app-ai and Personalizer. Handlers never invent
  per-route error envelopes ([docs/DECISIONS.md](../../docs/DECISIONS.md) #7).
- The live surface (`/files`, `/messages`) is in production — its routes, success
  request/response shapes, headers, and status codes are a stable external contract;
  keep them identical. Error bodies follow the Brain wire shape above.
