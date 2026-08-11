/**
 * GET /health — liveness check. No auth, no Anthropic call.
 */

import { jsonResponse, type CorsHeaders } from '../lib/responses';
import { silentLoggingRuntime, type LoggingRuntime } from '../lib/logger';
import { BUILD_REV } from '../build-rev';

export function handleHealth(
  corsHeaders: CorsHeaders,
  logging: LoggingRuntime = silentLoggingRuntime,
): Response {
  logging.logger('Health').info('Health check requested');
  return jsonResponse(
    {
      status: 'ok',
      message: 'App AI service is running',
      timestamp: new Date().toISOString(),
      // The EXACT served-worker revision (build-time `--define __APP_AI_REV__`; `'dev'` when absent).
      // The FREE-stack preflight asserts this is present + non-`'dev'` (C0014 item 14).
      buildRev: BUILD_REV,
    },
    corsHeaders,
  );
}
