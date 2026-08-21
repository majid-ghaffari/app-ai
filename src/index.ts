/**
 * App AI Service — Cloudflare Worker entry + router.
 *
 * A secure proxy in front of Anthropic: it holds the Anthropic API key, validates
 * the merchant's `X-Personalizer-Context-ID` against Personalizer, and exposes:
 *
 *   GET    /health       — liveness (no auth)
 *   POST   /demo/session/exchange — one-time website activation exchange
 *   POST   /files        — upload to the Anthropic Files API
 *   GET    /files        — list files
 *   DELETE /files/{id}   — delete a file
 *   POST   /messages     — single-shot Messages proxy (LIVE smart-image feature)
 *   POST   /chat         — Studio AI agent loop (SSE + tool-use)
 *
 * This file is the router only: it builds CORS headers, handles the OPTIONS
 * preflight, selects scoped demo auth or normal Context-ID auth, and dispatches
 * to a handler. All logic lives in handlers/, lib/, and toolsets/. Configuration
 * is read exclusively through src/config.ts (typed `Env`, fail-fast on a missing
 * variable — the catch below maps that to the Brain-shaped 500 envelope).
 */

import { getCorsHeaders } from './lib/cors';
import {
  createLoggingRuntime,
  type BackgroundTaskScheduler,
  type LoggingRuntime,
} from './lib/logger';
import { validateContextId } from './lib/auth';
import { errorResponse, errorResponseFrom, type CorsHeaders } from './lib/responses';
import { handleHealth } from './handlers/health';
import { handleFileUpload, handleListFiles, handleDeleteFile } from './handlers/files';
import { handleMessages } from './handlers/messages';
import { handleChat } from './handlers/chat';
import { handleDemoSessionExchange } from './handlers/demo-session';
import { authorizeDemoRequest, finalizeDemoUsage, releaseDemoUsage } from './lib/demo-auth';
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
  const { pathname } = new URL(request.url);
  const { method } = request;
  const contextId = request.headers.get('X-Personalizer-Context-ID');
  let corsHeaders: CorsHeaders = {};
  let logging: LoggingRuntime | undefined;

  try {
    corsHeaders = getCorsHeaders(request, env);
    logging = createLoggingRuntime(env, schedule, {
      requestId: crypto.randomUUID(),
      contextId,
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
        if (pathname === '/files' && method === 'POST') {
          response = await handleFileUpload(request, env, corsHeaders, logging);
        } else if (pathname === '/messages' && method === 'POST') {
          response = await handleMessages(request, env, corsHeaders, logging, { demo: true });
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
    // per-request validation call carries the subscriber's available
    // IntegrationParty set (AvailableIntegrationParties) — captured here, not
    // discarded, and threaded into /chat for dynamic toolset composition
    // (no extra call, no cache — the parties are exactly as fresh as this gate).
    const validation = await validateContextId(contextId, env, logging.logger('Auth'));
    logging = logging.child({
      ...(validation.SubscriberID === undefined ? {} : { subscriberId: validation.SubscriberID }),
      ...(validation.SubscriberTitle === undefined
        ? {}
        : { subscriberTitle: validation.SubscriberTitle }),
    });

    if (pathname === '/files' && method === 'POST') {
      return await handleFileUpload(request, env, corsHeaders, logging);
    }
    if (pathname === '/files' && method === 'GET') {
      return await handleListFiles(env, corsHeaders, logging);
    }
    if (pathname.startsWith('/files/') && method === 'DELETE') {
      const fileId = pathname.split('/').pop() ?? '';
      return await handleDeleteFile(fileId, env, corsHeaders, logging);
    }
    if (pathname === '/messages' && method === 'POST') {
      return await handleMessages(request, env, corsHeaders, logging);
    }
    if (pathname === '/chat' && method === 'POST') {
      return await handleChat(
        request,
        env,
        corsHeaders,
        validation.AvailableIntegrationParties ?? [],
        logging,
      );
    }

    return errorResponse('Resource not found.', corsHeaders, 404, 'RecordNotFoundException');
  } catch (error) {
    logging?.logger('Router').error('Request handler error', error);
    return errorResponseFrom(error, corsHeaders);
  }
}
