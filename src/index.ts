/**
 * App AI Service — Cloudflare Worker entry + router.
 *
 * Validates the merchant's `X-Personalizer-Context-ID` against Personalizer,
 * holds every provider API key server-side, and runs each inference through
 * the provider-neutral runtime in src/inference/. Routes:
 *
 *   GET    /health                — liveness (no auth)
 *   POST   /demo/session/exchange — one-time website activation exchange
 *                                   (authenticated by the website's JWT)
 *   POST   /files                 — prompt-aware direct upload to each declared
 *                                   prompt's provider file route; returns
 *                                   sealed opaque references
 *   DELETE /files/{id}            — delete the provider object a sealed
 *                                   reference names
 *   POST   /messages              — single-shot inference for the header-selected
 *                                   registered prompt (absent/unknown selector →
 *                                   the bounded raw Anthropic proxy)
 *   POST   /chat                  — Studio AI agent loop (SSE + tool-use)
 *   GET    /prompts               — master-only prompt/model routing diagnostics
 *                                   (context-ID by header or query parameter)
 *
 * Every route except /health and the demo exchange requires a validated
 * context-ID; POST /files and POST /messages alone also accept a scoped
 * `ls_demo_…` bearer. There is no GET /files: nothing enumerates a provider
 * account, so it reaches the 404 below.
 *
 * This file is the router only: it builds CORS headers, handles the OPTIONS
 * preflight, selects scoped demo auth or normal Context-ID auth, and dispatches
 * to a handler. All logic lives in handlers/, inference/, lib/, and toolsets/.
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
import { handleHealth } from './handlers/health';
import { handleFileUpload, handleDeleteFile } from './handlers/files';
import { handleMessages } from './handlers/messages';
import { handleChat } from './handlers/chat';
import { handleDemoSessionExchange } from './handlers/demo-session';
import { handlePrompts, promptsDiagnosticsContextId } from './handlers/prompts';
import { authorizeDemoRequest, finalizeDemoUsage, releaseDemoUsage } from './lib/demo-auth';
import { demoFileTenantScope } from './inference/file-references';
export { DemoSessionAuthority } from './lib/demo-session-authority';
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
    if (pathname === '/demo/session/exchange' && method === 'POST') {
      return await handleDemoSessionExchange(request, env, corsHeaders);
    }

    const demoAuthorization = await authorizeDemoRequest(request, env);
    if (demoAuthorization) {
      let response: Response;
      try {
        // A demo session authenticates by bearer token and carries no merchant
        // context-ID, so its provider files are sealed into a tenant namespace of
        // its own — never reachable from a merchant tenant, nor the reverse. The
        // sealing key that derives that namespace is configuration, and a
        // rejected one throws here, inside the guard that releases the
        // reservation the authorization just took.
        const tenantScope = await demoFileTenantScope(demoAuthorization.sessionIdentifier, env);
        if (pathname === '/files' && method === 'POST') {
          response = await handleFileUpload(request, env, corsHeaders, logging, { tenantScope });
        } else if (pathname === '/messages' && method === 'POST') {
          response = await handleMessages(request, env, corsHeaders, logging, {
            demo: true,
            tenantScope,
          });
        } else {
          response = errorResponse(
            'Resource not found.',
            corsHeaders,
            404,
            'RecordNotFoundException',
          );
        }
      } catch (error) {
        // A reserved request must never remain pending until session expiry merely because a
        // handler threw instead of returning its normal error Response.
        await releaseDemoUsage(demoAuthorization, env);
        throw error;
      }
      await finalizeDemoUsage(demoAuthorization, response, env);
      return response;
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

    if (pathname === '/files' && method === 'POST') {
      return await handleFileUpload(request, env, corsHeaders, logging);
    }
    if (pathname.startsWith('/files/') && method === 'DELETE') {
      const fileId = pathname.split('/').pop() ?? '';
      return await handleDeleteFile(fileId, request, env, corsHeaders, logging);
    }
    if (pathname === '/messages' && method === 'POST') {
      return await handleMessages(request, env, corsHeaders, logging);
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
