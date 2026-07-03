/**
 * CORS header construction.
 *
 * The AI endpoints carry NO cookies — authentication is the
 * `X-Personalizer-Context-ID` header, validated against Personalizer (see auth.ts).
 * That makes it safe to echo arbitrary request Origins without credentials,
 * which is required because the Studio admin runs injected into arbitrary
 * merchant storefront pages (so the request Origin is the merchant's domain).
 * A small allowlist of known dev origins — the `CREDENTIALED_ORIGINS` config
 * variable (src/config.ts) — is additionally permitted to send credentialed
 * requests.
 */

import { credentialedOrigins, type Env } from '../config';
import type { CorsHeaders } from './responses';

const BASE_HEADERS: CorsHeaders = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Accept, X-Requested-With, X-Personalizer-Context-ID, X-Personalizer-System-Prompt',
  'Access-Control-Max-Age': '86400',
};

/** Build the CORS headers for a request, based on its Origin. */
export function getCorsHeaders(request: Request, env: Env): CorsHeaders {
  const origin = request.headers.get('Origin');
  const headers: CorsHeaders = { ...BASE_HEADERS };

  if (!origin) {
    return headers;
  }

  if (credentialedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }

  return headers;
}
