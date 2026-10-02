/** POST /audit/session/exchange — trade a website activation token for a scoped audit session. */

import type { Env } from '../config';
import { assertSupportedAuditPlan, exchangeAuditActivation } from '../lib/audit-auth';
import { AUDIT_PLAN_VERSION_HEADER, declaredAuditPlanVersion } from '../lib/audit-plan';
import { jsonResponse, WorkerError, type CorsHeaders } from '../lib/responses';

/** Handle an audit-session exchange without exposing signing material to the extension. */
export async function handleAuditSessionExchange(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
): Promise<Response> {
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
