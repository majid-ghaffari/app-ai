/**
 * GET /health — liveness check. No auth, no provider call.
 *
 * In production it is also the readiness check: a deployment whose required
 * secrets are not all set, or whose model bindings do not route every prompt,
 * answers 503 — status only. Which secret, which binding, and which model id
 * are operator facts that go to the log and to the master-gated `GET /prompts`,
 * never to this unauthenticated body.
 */

import { errorResponse, jsonResponse, type CorsHeaders } from '../lib/responses';
import { silentLoggingRuntime, type LoggingRuntime } from '../lib/logger';
import { BUILD_REV, isAttributableBuildRevision } from '../build-rev';
import { deploymentEnvironment, missingRequiredSecretNames, type Env } from '../config';
import { providersInUse, validateModelRouting } from '../prompt-registry';

export function handleHealth(
  corsHeaders: CorsHeaders,
  env: Env,
  logging: LoggingRuntime = silentLoggingRuntime,
  buildRev: string = BUILD_REV,
): Response {
  const log = logging.logger('Health');
  log.info('Health check requested');
  if (deploymentEnvironment(env) === 'production') {
    if (!isAttributableBuildRevision(buildRev)) {
      return errorResponse(
        'App AI deployment has no attributable source revision.',
        corsHeaders,
        503,
        'UnattributableBuildException',
        'Configure Cloudflare Workers Builds to deploy with `npm run deploy`.',
      );
    }
    const notReady = productionReadinessFailure(env);
    if (notReady) {
      log.error('Production deployment is not ready', notReady);
      return errorResponse(
        'App AI service is not ready.',
        corsHeaders,
        503,
        'ServiceUnavailableException',
      );
    }
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

/** Why a production deployment cannot serve, for the log; `null` when it can. */
function productionReadinessFailure(env: Env): Error | null {
  const missingSecrets = missingRequiredSecretNames(env, providersInUse(env));
  if (missingSecrets.length > 0) {
    return new Error(`Required secrets are not set: ${missingSecrets.join(', ')}`);
  }
  try {
    validateModelRouting(env);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
