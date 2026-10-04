/**
 * App AI Service — Cloudflare Worker entry + router.
 *
 * Validates the merchant's `X-Personalizer-Context-ID` against Personalizer,
 * holds every provider API key server-side, and runs each inference through
 * the provider-neutral runtime in src/inference/. Routes:
 *
 *   GET    /health                 — liveness (no auth)
 *   POST   /audit/session/exchange — one-time website activation exchange
 *                                    (authenticated by the website's JWT)
 *   GET    /audit/session          — a Grader session's standing, read with its
 *                                    own `ls_audit_…` bearer; spends nothing
 *   POST   /files                  — prompt-aware direct upload to each declared
 *                                    prompt's provider file route; returns
 *                                    sealed opaque references
 *   DELETE /files/{id}             — delete the provider object a sealed
 *                                    reference names
 *   POST   /messages               — single-shot inference for the header-selected
 *                                    registered prompt (absent/unknown selector →
 *                                    the bounded raw Anthropic proxy); an audit
 *                                    session's `grader-chat` selector reaches the
 *                                    Grader sales chat
 *   POST   /chat                   — Studio AI agent loop (SSE + tool-use)
 *   GET    /prompts                — master-only prompt/model routing diagnostics
 *                                    (context-ID by header or query parameter)
 *
 * Every route except /health and the two audit-session routes requires a
 * validated context-ID; POST /files and POST /messages alone also accept a
 * scoped `ls_audit_…` bearer, which GET /audit/session requires. There is no GET /files: nothing enumerates a provider
 * account, so it reaches the 404 below.
 *
 * This file is the router only: it builds CORS headers, handles the OPTIONS
 * preflight, selects scoped audit auth or normal Context-ID auth, and dispatches
 * to a handler, answering an authenticated `/messages` request that opted in to
 * keep-alive through lib/keep-alive-response.ts. All logic lives in handlers/,
 * inference/, lib/, and toolsets/.
 * Configuration is read exclusively through src/config.ts (typed `Env`,
 * fail-fast on a missing variable — the catch below maps that to the
 * Brain-shaped 500 envelope).
 */

import { getCorsHeaders } from './lib/cors';
import {
  createLoggingRuntime,
  type BackgroundTaskScheduler,
  type LoggingRuntime,
} from './lib/logger';
import {
  SUPPORTED_AI_TOOLS_CONTRACT_VERSION,
  missingContextIdError,
  validateContextId,
  type ContextValidation,
} from './lib/auth';
import { errorResponse, errorResponseFrom, type CorsHeaders } from './lib/responses';
import { keepAliveResponse, readKeepAliveOptIn, type KeepAlive } from './lib/keep-alive-response';
import { readJsonBody } from './lib/request-body';
import { handleHealth } from './handlers/health';
import { handleFileUpload, handleDeleteFile } from './handlers/files';
import { handleMessages } from './handlers/messages';
import { handleChat } from './handlers/chat';
import { handleAuditSessionExchange, handleAuditSessionStatus } from './handlers/audit-session';
import { handleGraderChat } from './handlers/grader-chat';
import { handlePrompts, promptsDiagnosticsContextId } from './handlers/prompts';
import {
  GRADER_CHAT_PROMPT,
  authorizeAuditRequest,
  finalizeAuditUsage,
  releaseAuditUsage,
  type AuditAuthorization,
} from './lib/audit-auth';
import { auditFileTenantScope } from './inference/file-references';
import { assertFreeVisualVerifyRoute, FREE_VISUAL_VERIFY_PROMPT } from './prompt-registry';
export { AuditSessionAuthority } from './lib/audit-session-authority';
import type { Env } from './config';

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx ? (task) => ctx.waitUntil(task) : undefined);
  },
} satisfies ExportedHandler<Env>;

/** Route a request to its handler, with shared CORS / auth / error handling. */
async function handleRequest(
  request: Request,
  env: Env,
  schedule?: BackgroundTaskScheduler,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const { pathname } = requestUrl;
  const { method } = request;
  // `GET /prompts` is the ONE route that also accepts the context-ID in the
  // URL, so a master operator can open the routing diagnostics from a browser
  // address bar. The header wins whenever it carries a value, and no other
  // route reads a credential from a query string (test/architecture.test.ts).
  const headerContextId = request.headers.get('X-Personalizer-Context-ID');
  const urlContextId =
    headerContextId === null && pathname === '/prompts' && method === 'GET'
      ? promptsDiagnosticsContextId(requestUrl)
      : null;
  const contextId = headerContextId ?? urlContextId;
  let corsHeaders: CorsHeaders = {};
  let logging: LoggingRuntime | undefined;

  try {
    corsHeaders = getCorsHeaders(request, env);
    logging = createLoggingRuntime(env, schedule, {
      requestId: crypto.randomUUID(),
      route: pathname,
      method,
    });
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (pathname === '/health' && method === 'GET') {
      return handleHealth(corsHeaders, env, logging);
    }
    if (pathname === '/audit/session/exchange' && method === 'POST') {
      return await handleAuditSessionExchange(request, env, corsHeaders);
    }
    if (pathname === '/audit/session' && method === 'GET') {
      return await handleAuditSessionStatus(request, env, corsHeaders, logging);
    }

    const answerKeptAlive = (
      keepAlive: KeepAlive,
      requestLogging: LoggingRuntime,
      answer: (keptAliveLogging: LoggingRuntime) => Promise<Response>,
    ): Response =>
      keepAliveResponse(
        answer(requestLogging).catch((error: unknown) => {
          requestLogging.logger('Router').error('Request handler error', error);
          return errorResponseFrom(error, corsHeaders);
        }),
        corsHeaders,
        keepAlive,
        schedule,
      );

    const auditAuthorization = await authorizeAuditRequest(request, env);
    if (auditAuthorization?.kind === 'grader-chat') {
      const { keepAlive } = auditAuthorization;
      return keepAlive
        ? answerKeptAlive(keepAlive, logging, (keptAliveLogging) =>
            handleGraderChat(request, env, corsHeaders, keptAliveLogging, auditAuthorization),
          )
        : await handleGraderChat(request, env, corsHeaders, logging, auditAuthorization);
    }
    if (auditAuthorization) {
      const { keepAlive } = auditAuthorization;
      return keepAlive
        ? answerKeptAlive(keepAlive, logging, (keptAliveLogging) =>
            answerAuditRequest(request, env, corsHeaders, keptAliveLogging, auditAuthorization),
          )
        : await answerAuditRequest(request, env, corsHeaders, logging, auditAuthorization);
    }

    // Every endpoint except /health requires a valid context-ID. The same
    // validation response carries the subscriber's integration-party and
    // AI-tool capabilities for /chat composition (no extra call or cache).
    let validation: ContextValidation;
    try {
      validation = await validateContextId(contextId, env, logging.logger('Auth'));
    } catch (error) {
      // A credential that arrived only in the URL counts only while it
      // authenticates as the master operator. Every other outcome — Personalizer's
      // own rejection included — answers exactly as a request carrying no
      // credential, so the query form of this route cannot be told apart from a
      // path that reads no credential from a URL, and an unauthenticated caller
      // learns nothing from what Personalizer said about the value they guessed.
      throw urlContextId === null ? error : missingContextIdError();
    }
    logging = logging.child({
      ...(validation.SubscriberID === undefined ? {} : { subscriberId: validation.SubscriberID }),
      ...(validation.SubscriberTitle === undefined
        ? {}
        : { subscriberTitle: validation.SubscriberTitle }),
    });

    if (request.headers.get('X-Personalizer-System-Prompt') === GRADER_CHAT_PROMPT) {
      return errorResponse('Resource not found.', corsHeaders, 404, 'RecordNotFoundException');
    }

    const freeVisualVerify =
      pathname === '/messages' &&
      method === 'POST' &&
      request.headers.get('X-Personalizer-System-Prompt') === FREE_VISUAL_VERIFY_PROMPT;
    if (freeVisualVerify) {
      if (validation.CanAdministerAllSubscribers !== true) {
        return errorResponse('Resource not found.', corsHeaders, 404, 'RecordNotFoundException');
      }
      assertFreeVisualVerifyRoute(env);
    }

    if (pathname === '/files' && method === 'POST') {
      return await handleFileUpload(request, env, corsHeaders, logging);
    }
    if (pathname.startsWith('/files/') && method === 'DELETE') {
      const fileId = pathname.split('/').pop() ?? '';
      return await handleDeleteFile(fileId, request, env, corsHeaders, logging);
    }
    if (pathname === '/messages' && method === 'POST') {
      const { body, keepAlive } = readKeepAliveOptIn(await readJsonBody(request), env);
      return keepAlive
        ? answerKeptAlive(keepAlive, logging, (keptAliveLogging) =>
            handleMessages(request, env, corsHeaders, keptAliveLogging, { body }),
          )
        : await handleMessages(request, env, corsHeaders, logging, { body });
    }
    if (pathname === '/prompts' && method === 'GET') {
      return handlePrompts(validation, env, corsHeaders, logging, {
        credentialFromUrl: urlContextId !== null,
      });
    }
    if (pathname === '/chat' && method === 'POST') {
      const availableAiTools =
        validation.AiToolsContractVersion === SUPPORTED_AI_TOOLS_CONTRACT_VERSION
          ? (validation.AvailableAiTools ?? [])
          : [];
      return await handleChat(
        request,
        env,
        corsHeaders,
        validation.AvailableIntegrationParties ?? [],
        availableAiTools,
        logging,
      );
    }

    return errorResponse('Resource not found.', corsHeaders, 404, 'RecordNotFoundException');
  } catch (error) {
    logging?.logger('Router').error('Request handler error', error);
    return errorResponseFrom(error, corsHeaders);
  }
}

async function answerAuditRequest(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
  logging: LoggingRuntime,
  authorization: AuditAuthorization,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  let response: Response;
  try {
    const tenantScope = await auditFileTenantScope(authorization.sessionIdentifier, env);
    if (pathname === '/files' && method === 'POST') {
      response = await handleFileUpload(request, env, corsHeaders, logging, { tenantScope });
    } else if (pathname === '/messages' && method === 'POST') {
      response = await handleMessages(request, env, corsHeaders, logging, {
        audit: true,
        tenantScope,
        deadlineStartedAt: authorization.admittedAt,
        ...(authorization.messageBody === undefined ? {} : { body: authorization.messageBody }),
      });
    } else {
      response = errorResponse('Resource not found.', corsHeaders, 404, 'RecordNotFoundException');
    }
  } catch (error) {
    await releaseAuditUsage(authorization, env);
    throw error;
  }
  await finalizeAuditUsage(authorization, response, env);
  return response;
}
