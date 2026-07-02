/**
 * GET /health — liveness check. No auth, no Anthropic call.
 */

import { jsonResponse, type CorsHeaders } from '../lib/responses';
import { createLogger } from '../lib/logger';

const log = createLogger('Health');

export function handleHealth(corsHeaders: CorsHeaders): Response {
  log.info('Health check requested');
  return jsonResponse(
    {
      status: 'ok',
      message: 'App AI service is running',
      timestamp: new Date().toISOString(),
    },
    corsHeaders,
  );
}
