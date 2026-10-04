/**
 * POST /audit/session/exchange — trade a website activation token for a scoped audit session.
 * GET /audit/session — read a live session's standing with its own bearer, spending nothing.
 */

import type { Env } from '../config';
import {
  assertCurrentExtensionBuild,
  assertSupportedAuditPlan,
  exchangeAuditActivation,
  readAuditSessionStatus,
} from '../lib/audit-auth';
import { AUDIT_PLAN_VERSION_HEADER, declaredAuditPlanVersion } from '../lib/audit-plan';
import { errorResponseFrom, jsonResponse, WorkerError, type CorsHeaders } from '../lib/responses';
import type { LoggingRuntime } from '../lib/logger';

/** Handle an audit-session exchange without exposing signing material to the extension. */
export async function handleAuditSessionExchange(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
): Promise<Response> {
  assertCurrentExtensionBuild(request, env);
  assertSupportedAuditPlan(request);
  let body: { activationToken?: unknown; storeUrl?: unknown };
  try {
    body = (await request.json()) as { activationToken?: unknown; storeUrl?: unknown };
  } catch {
    throw new WorkerError('The exchange body must be valid JSON.', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  if (typeof body.activationToken !== 'string' || typeof body.storeUrl !== 'string') {
    throw new WorkerError('activationToken and storeUrl are required.', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  const session = await exchangeAuditActivation(
    body.activationToken,
    body.storeUrl,
    declaredAuditPlanVersion(request.headers.get(AUDIT_PLAN_VERSION_HEADER)),
    env,
  );
  return jsonResponse(session, corsHeaders, 201);
}

/**
 * Answer a Grader session's standing — its chat terms and the two kill-switch instants — so a client
 * can check a run it cached before showing it. It reserves nothing and calls no model, and neither
 * its answer nor its refusal may be cached, because both change as the session does.
 */
export async function handleAuditSessionStatus(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
  logging: LoggingRuntime,
): Promise<Response> {
  const headers = { ...corsHeaders, 'Cache-Control': 'no-store' };
  try {
    return jsonResponse(await readAuditSessionStatus(request, env), headers);
  } catch (error) {
    logging.logger('AuditSessionStatus').error('Request handler error', error);
    return errorResponseFrom(error, headers);
  }
}
