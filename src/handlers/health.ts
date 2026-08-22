/**
 * GET /health — liveness check. No auth, no Anthropic call.
 */

import { errorResponse, jsonResponse, type CorsHeaders } from '../lib/responses';
import { silentLoggingRuntime, type LoggingRuntime } from '../lib/logger';
import { BUILD_REV, isAttributableBuildRevision } from '../build-rev';
import { deploymentEnvironment, type Env } from '../config';

export function handleHealth(
  corsHeaders: CorsHeaders,
  env: Env,
  logging: LoggingRuntime = silentLoggingRuntime,
  buildRev: string = BUILD_REV,
): Response {
  logging.logger('Health').info('Health check requested');
  if (deploymentEnvironment(env) === 'production' && !isAttributableBuildRevision(buildRev)) {
    return errorResponse(
      'App AI deployment has no attributable source revision.',
      corsHeaders,
      503,
      'UnattributableBuildException',
      'Configure Cloudflare Workers Builds to deploy with `npm run deploy`.',
    );
  }
  return jsonResponse(
    {
      status: 'ok',
      message: 'App AI service is running',
      timestamp: new Date().toISOString(),
      // The EXACT served-worker revision (build-time `--define __APP_AI_REV__`; `'dev'` when absent).
      // The FREE-stack preflight asserts this is present + non-`'dev'` (C0014 item 14).
      buildRev,
    },
    corsHeaders,
  );
}
