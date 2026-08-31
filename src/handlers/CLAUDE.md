# src/handlers/

**Parent:** [app-ai/CLAUDE.md](../../CLAUDE.md)

Route handlers. `src/index.ts` (the thin router) does CORS, the OPTIONS preflight,
and context-ID auth, then dispatches to one of these. Each handler owns one route
group and returns a `Response`; Anthropic access goes through `../lib/anthropic.ts`,
and the AI-tool surface comes from the toolset registry (`../toolsets/`).

The per-handler map — which file owns which route group — is [docs/ARCHITECTURE-MAP.md](../../docs/ARCHITECTURE-MAP.md), read on demand. What binds every handler is below.

## Structured logging and inference tracing

The router creates one request-scoped `LoggingRuntime`, retaining request/context/subscriber fields,
and handlers derive scoped loggers from it. Both `/messages` and `/chat` emit correlated TRACE
records for model-visible text/tool input, assistant output and usage, failures, client tool calls,
and server tool execution/results. Model-visible file IDs are retained; actual secret fields are
redacted by the logger. `LOG_TARGETS_*` configuration alone selects console, Seq,
multiple sinks, or ignore. Seq work is attached to Cloudflare `waitUntil`, fail-open, and never delays
or changes the inference response.

## Conventions

- Handlers receive `corsHeaders` from the router and spread them onto every `Response`.
- The context-ID is already validated by the router before any handler runs;
  the router also threads the subscriber's available integration parties
  (`AvailableIntegrationParties`, from that same validate-context-id call) into
  `handleChat` as `availableParties`.
- The demo exchange and `ls_demo_…` bearer branch are the deliberate alternate
  auth path. They never call Brain and can dispatch only `POST /files` and
  `POST /messages` for its explicit onboarding proposal and QC prompt allowlist.
- AI tools are consumed ONLY through the toolset registry
  (`../toolsets/registry.ts`): each endpoint passes the subscriber's
  `availableParties` and treats the composition as opaque — composition is
  party-driven off each toolset's `integrationParties`, so adding a toolset
  never edits handler logic. Standards: [docs/TOOLSETS.md](../../docs/TOOLSETS.md).
- **CLIENT-tool mode** is the one designed exception to server-side execution.
  Its first consumer is the **`onboarding-chat`** prompt, whose
  registry entry carries `clientTools: [LOOK_AT_PAGE_TOOL]`. A prompt whose registry
  entry carries `clientTools` (mutually exclusive with `usesTools`) has its tools
  executed on the CLIENT, not the worker: `handleChat` sends those definitions to
  the model in place of the server toolset, and on a `tool_use` returns the calls
  in `done.toolCalls` and stops the turn without touching the toolset registry. The
  client (the lib) runs them (`look_at_page` captures a store screenshot) and calls
  `/chat` again with the `tool_result` (the screenshot on `fileIds`). `look_at_page`
  is defined in `../lib/client-tools.ts`; the wire schema the model sees is the
  `page?: string` hint. See the top-level CLAUDE.md → CLIENT-tool mode.
- Accept the router's `LoggingRuntime`, derive a scoped logger, and thread it into shared helpers.
  Direct `console.*` calls are forbidden outside the logger's Console sink.
- Every HTTP error body — and every SSE `error` event payload — is the Brain wire
  shape (`{ Message, ExceptionType, MessageDetail? }`, built by `../lib/responses.ts`),
  so clients keep one error parser across app-ai and Personalizer. Handlers never invent
  per-route error envelopes ([docs/DECISIONS.md](../../docs/DECISIONS.md) #7).
- The live surface (`/files`, `/messages`) is in production — its routes, success
  request/response shapes, headers, and status codes are a stable external contract;
  keep them identical. Error bodies follow the Brain wire shape above.
