/**
 * App AI Service — Cloudflare Worker entry + router.
 *
 * A secure proxy in front of Anthropic: it holds the Anthropic API key, validates
 * the merchant's `X-Personalizer-Context-ID` against Brain, and exposes:
 *
 *   GET    /health       — liveness (no auth)
 *   POST   /files        — upload to the Anthropic Files API
 *   GET    /files        — list files
 *   DELETE /files/{id}   — delete a file
 *   POST   /messages     — single-shot Messages proxy (LIVE smart-image feature)
 *   POST   /chat         — Studio AI agent loop (SSE + tool-use)
 *
 * This file is the router only: it builds CORS headers, handles the OPTIONS
 * preflight, validates the context-ID for every non-/health route, and dispatches
 * to a handler. All logic lives in handlers/, lib/, and toolsets/. Configuration
 * is read exclusively through src/config.ts (typed `Env`, fail-fast on a missing
 * variable — the catch below maps that to the Brain-shaped 500 envelope).
 */

import { getCorsHeaders } from './lib/cors';
import { createLogger } from './lib/logger';
import { validateContextId } from './lib/auth';
import { errorResponse, errorResponseFrom, type CorsHeaders } from './lib/responses';
import { handleHealth } from './handlers/health';
import { handleFileUpload, handleListFiles, handleDeleteFile } from './handlers/files';
import { handleMessages } from './handlers/messages';
import { handleChat } from './handlers/chat';
import type { Env } from './config';

const log = createLogger('Router');

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

/** Route a request to its handler, with shared CORS / auth / error handling. */
async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const { method } = request;
  let corsHeaders: CorsHeaders = {};

  try {
    corsHeaders = getCorsHeaders(request, env);

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (pathname === '/health' && method === 'GET') {
      return handleHealth(corsHeaders);
    }

    // Every endpoint except /health requires a valid context-ID.
    await validateContextId(request.headers.get('X-Personalizer-Context-ID'), env);

    if (pathname === '/files' && method === 'POST') {
      return await handleFileUpload(request, env, corsHeaders);
    }
    if (pathname === '/files' && method === 'GET') {
      return await handleListFiles(env, corsHeaders);
    }
    if (pathname.startsWith('/files/') && method === 'DELETE') {
      const fileId = pathname.split('/').pop() ?? '';
      return await handleDeleteFile(fileId, env, corsHeaders);
    }
    if (pathname === '/messages' && method === 'POST') {
      return await handleMessages(request, env, corsHeaders);
    }
    if (pathname === '/chat' && method === 'POST') {
      return await handleChat(request, env, corsHeaders);
    }

    return errorResponse('Resource not found.', corsHeaders, 404, 'RecordNotFoundException');
  } catch (error) {
    log.error('Request handler error:', error);
    return errorResponseFrom(error, corsHeaders);
  }
}
