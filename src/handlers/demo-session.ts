/** POST /demo/session/exchange — trade a website activation token for a scoped demo session. */

import type { Env } from '../config';
import { exchangeDemoActivation } from '../lib/demo-auth';
import { jsonResponse, WorkerError, type CorsHeaders } from '../lib/responses';

/** Handle a demo-session exchange without exposing signing material to the extension. */
export async function handleDemoSessionExchange(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
): Promise<Response> {
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
  const session = await exchangeDemoActivation(body.activationToken, body.storeUrl, env);
  return jsonResponse(session, corsHeaders, 201);
}
