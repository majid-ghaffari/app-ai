/**
 * Integration-bridge call channel — the shared plumbing behind the platform
 * toolsets (shopify / bigcommerce / klaviyo / google-ads).
 *
 * Every platform tool call goes through Personalizer's integration bridge
 * (`v2/integration-bridge/*` on the main API): app-ai never holds a platform
 * token. What each platform toolset resolves through the credential seam is a
 * CALL CHANNEL — the Personalizer base URL, the merchant's context-ID (tenant),
 * and the worker's service token (caller, the
 * `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` Workers Secret), both read through the
 * src/config.ts accessors. Personalizer validates both headers, resolves the
 * subscriber, and relays the call to the platform under the merchant's own
 * installed-integration credentials.
 *
 * Error discrimination (the frozen cross-repo rule): the `X-Ls-Integration-Bridge-Error`
 * response header separates the two voices a tool call can hear.
 *
 *   • Header ABSENT — the response is the PLATFORM speaking, verbatim
 *     (status + raw body, any status). It surfaces to the model as
 *     `{ ok: true, result: { platformStatus, headers?, body } }` — including
 *     platform 4xx/5xx error payloads, so the model can self-correct (fix a
 *     path, adjust a GraphQL field, respect a 429) using the platform's own
 *     error language. A platform error is data, not a degrade. `headers`
 *     (lowercased keys) carries exactly the whitelisted out-of-band platform
 *     headers — `Link` (Shopify REST cursor paging), `Retry-After`, and the
 *     platform rate-limit headers — and is omitted when none are present.
 *   • Header PRESENT — a LimeSpot layer produced the response; the body is the
 *     standard `{ Message, ExceptionType, MessageDetail }` envelope. The call
 *     degrades to `{ ok: false, result: { error: '<Message> (<ExceptionType>)' } }`
 *     so the model can distinguish a malformed request (rephrase the call)
 *     from a configuration failure (stop retrying, tell the merchant).
 *
 * Nothing here throws toward the agent loop, and no line logs the channel —
 * the context-ID and service token stay out of tool definitions, tool
 * results, and console output (docs/TOOLSETS.md security standards).
 */

import { personalizerApiUrl, personalizerIntegrationBridgeToken } from '../config';
import type { IntegrationParty } from './integration-party';
import type { ToolAuthContext, ToolExecutionResult } from './types';

/** Route base of Personalizer's integration bridge (public v2 surface). */
const INTEGRATION_BRIDGE_ROUTE_BASE = 'v2/integration-bridge';

/** The LimeSpot-layer error marker header (presence, not value, is the contract). */
const INTEGRATION_BRIDGE_ERROR_HEADER = 'X-Ls-Integration-Bridge-Error';

/**
 * The whitelisted platform response headers surfaced to the model as
 * `result.headers` (lowercased keys) — the frozen out-of-band metadata subset
 * the bridge forwards: `Link` (Shopify REST cursor paging — `page_info` lives
 * here), `Retry-After`, and the per-platform rate-limit headers (Shopify
 * call-limit, BigCommerce `X-Rate-Limit-*`, Klaviyo `RateLimit-*`). Every
 * other response header is dropped.
 */
const FORWARDED_HEADER_NAMES: readonly string[] = [
  'link',
  'retry-after',
  'x-shopify-shop-api-call-limit',
  'x-rate-limit-requests-left',
  'x-rate-limit-time-reset-ms',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
];

/** The call channel a platform toolset resolves — never a platform token. */
export interface BridgeChannel {
  /** Tenant scoping — sent as `X-Personalizer-Context-ID`. */
  contextId: string;
  /** Caller auth — sent as `X-Personalizer-Integration-Bridge-Token` (a Workers Secret). */
  serviceToken: string;
  /** Personalizer API base URL, no trailing slash. */
  baseUrl: string;
}

/**
 * The model's `tool_use` input for a REST passthrough tool (client side of the
 * frozen schema — `method` and `path` are schema-required).
 */
export interface RestToolInput {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

/** The model's `tool_use` input for a GraphQL passthrough tool (`query` is schema-required). */
export interface GraphQlToolInput {
  query: string;
  variables?: unknown;
}

/** The model's `tool_use` input for a GAQL passthrough tool (`query` is schema-required). */
export interface GaqlToolInput {
  query: string;
  pageSize?: number;
  pageToken?: string;
}

/**
 * Resolve the integration-bridge call channel for one composition. Shared by every
 * platform toolset's `resolveCredentials`. A missing context or an unset
 * `PERSONALIZER_INTEGRATION_BRIDGE_TOKEN` / `PERSONALIZER_API_URL` throws (the config accessors name
 * the variable and its channel) — the registry degrades that tool call, never
 * the turn.
 */
export function resolveBridgeChannel({ contextId, env }: ToolAuthContext): BridgeChannel {
  if (!contextId) {
    throw new Error('Missing context');
  }
  return {
    contextId,
    serviceToken: personalizerIntegrationBridgeToken(env),
    baseUrl: personalizerApiUrl(env),
  };
}

/** The frozen degrade shape for a tool name the toolset does not own. */
export function unknownToolResult(name: string): ToolExecutionResult {
  return {
    ok: false,
    name,
    result: { error: `Unknown tool: ${name}` },
    summary: `Unknown tool: ${name}`,
  };
}

/** A non-null, non-array object — the shape every tool input must have before field access. */
function isObjectInput(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/**
 * The degrade shape for model input that fails a required-field guard. Tool
 * input arrives from the model's `tool_use` and is untrusted despite the frozen
 * input schema; a missing `path` string-interpolated into the bridge URL would
 * become `/rest/undefined`. Guarding returns a clean `ok: false` the model can
 * act on locally instead of spending a bridge round-trip on a malformed call —
 * same never-throw degrade contract as every other executor path.
 */
function invalidInputResult(name: string, detail: string): ToolExecutionResult {
  return {
    ok: false,
    name,
    result: { error: `Invalid input: ${detail}` },
    summary: `${name} error`,
  };
}

/**
 * Execute one REST passthrough tool call:
 * `{method} {baseUrl}/v2/integration-bridge/{party}/rest/{path}?{query}`,
 * mirroring the verb the platform should receive. The `{party}` segment is the
 * matched `IntegrationParty` name (Personalizer's dispatch key). The path is
 * platform-relative (Personalizer owns the base URL and any pinned API version);
 * the query parameters forward as sent; POST/PUT bodies forward as JSON; DELETE
 * carries no body.
 */
export async function executeRestRequest(
  name: string,
  party: IntegrationParty,
  input: unknown,
  channel: BridgeChannel,
): Promise<ToolExecutionResult> {
  if (!isObjectInput(input)) {
    return invalidInputResult(name, 'input must be an object.');
  }
  const { method, path, query, body } = input;
  if (typeof method !== 'string' || !method || typeof path !== 'string' || !path) {
    return invalidInputResult(name, "'method' and 'path' must be non-empty strings.");
  }
  // Normalize the verb defensively — a model that sends `'post'` still matches
  // the body-forwarding check and reaches the platform as a standard uppercase
  // HTTP method.
  const upperMethod = method.toUpperCase();

  // Split any query string the model embedded in the path so it merges with the
  // query object instead of producing a malformed double-`?` URL. Split on the
  // FIRST `?` only and treat any later `?` as `&`, so a doubly-sloppy
  // `products.json?limit=50?other=1` keeps both params. Leading slashes are
  // normalized too — the bridge path is platform-relative, and `rest//v3/...`
  // misroutes on the bridge side.
  const questionIndex = path.indexOf('?');
  const rawPath = questionIndex === -1 ? path : path.slice(0, questionIndex);
  const pathQuery =
    questionIndex === -1 ? undefined : path.slice(questionIndex + 1).replace(/\?/g, '&');
  const relativePath = rawPath.replace(/^\/+/, '');

  const params = new URLSearchParams(pathQuery ?? '');
  // An array is `typeof 'object'` too; guard it so its indices never serialize
  // as query keys (`?0=…&1=…`). The query object takes precedence over any
  // same-named param embedded in the path.
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    for (const [key, value] of Object.entries(query)) {
      // Drop null/undefined so they never serialize as the literal
      // "null"/"undefined" the model never meant to send.
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
  }
  const queryString = params.toString();
  const url = `${channel.baseUrl}/${INTEGRATION_BRIDGE_ROUTE_BASE}/${party}/rest/${relativePath}${
    queryString ? `?${queryString}` : ''
  }`;

  const headers = channelHeaders(channel);
  const init: RequestInit = { method: upperMethod, headers };
  if ((upperMethod === 'POST' || upperMethod === 'PUT') && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  return sendBridgeCall(name, `${upperMethod} ${relativePath}`, url, init);
}

/**
 * Execute one GraphQL passthrough tool call:
 * `POST {baseUrl}/v2/integration-bridge/{party}/graphql` with the wire body
 * `{ Query, Variables? }` (PascalCase — Personalizer's request model). The
 * `{party}` segment is the matched `IntegrationParty` name. The document
 * forwards verbatim; queries and mutations alike.
 */
export async function executeGraphQlRequest(
  name: string,
  party: IntegrationParty,
  input: unknown,
  channel: BridgeChannel,
): Promise<ToolExecutionResult> {
  if (!isObjectInput(input)) {
    return invalidInputResult(name, 'input must be an object.');
  }
  const { query, variables } = input;
  if (typeof query !== 'string' || !query) {
    return invalidInputResult(name, "'query' must be a non-empty string.");
  }

  const url = `${channel.baseUrl}/${INTEGRATION_BRIDGE_ROUTE_BASE}/${party}/graphql`;
  const wireBody: { Query: string; Variables?: unknown } = { Query: query };
  if (variables !== undefined) {
    wireBody.Variables = variables;
  }

  return sendBridgeCall(name, 'graphql', url, {
    method: 'POST',
    headers: { ...channelHeaders(channel), 'Content-Type': 'application/json' },
    body: JSON.stringify(wireBody),
  });
}

/**
 * Execute one GAQL passthrough tool call:
 * `POST {baseUrl}/v2/integration-bridge/{party}/gaql` with the wire body
 * `{ Query, PageSize?, PageToken? }` (PascalCase — Personalizer's request model).
 * The `{party}` segment is the matched `IntegrationParty` name. Read-only by
 * nature of GAQL; Personalizer resolves the subscriber's linked ads account.
 * `PageToken` (optional) is the cursor from a prior response's `NextPageToken`;
 * the response body — including `NextPageToken` — surfaces verbatim as data, so
 * the model can page by echoing it back on the next call.
 */
export async function executeGaqlRequest(
  name: string,
  party: IntegrationParty,
  input: unknown,
  channel: BridgeChannel,
): Promise<ToolExecutionResult> {
  if (!isObjectInput(input)) {
    return invalidInputResult(name, 'input must be an object.');
  }
  const { query, pageSize, pageToken } = input;
  if (typeof query !== 'string' || !query) {
    return invalidInputResult(name, "'query' must be a non-empty string.");
  }

  const url = `${channel.baseUrl}/${INTEGRATION_BRIDGE_ROUTE_BASE}/${party}/gaql`;
  const wireBody: { Query: string; PageSize?: number; PageToken?: string } = { Query: query };
  if (typeof pageSize === 'number') {
    wireBody.PageSize = pageSize;
  }
  if (typeof pageToken === 'string' && pageToken) {
    wireBody.PageToken = pageToken;
  }

  return sendBridgeCall(name, 'gaql', url, {
    method: 'POST',
    headers: { ...channelHeaders(channel), 'Content-Type': 'application/json' },
    body: JSON.stringify(wireBody),
  });
}

/** The two call-channel headers every bridge call carries. */
function channelHeaders(channel: BridgeChannel): Record<string, string> {
  return {
    'X-Personalizer-Context-ID': channel.contextId,
    'X-Personalizer-Integration-Bridge-Token': channel.serviceToken,
  };
}

/** The LimeSpot error envelope as the discrimination path reads it (Brain's wire shape). */
interface BridgeErrorEnvelope {
  Message?: string;
  ExceptionType?: string;
}

/** The platform-speaking result the model sees (`headers` omitted when none are whitelisted). */
interface PlatformCallResult {
  platformStatus: number;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * Send one bridge call and discriminate the response per the frozen rule:
 * `X-Ls-Integration-Bridge-Error` absent → the platform speaking, surfaced verbatim as data
 * (`ok: true`, `result: { platformStatus, headers?, body }` — `headers` is the
 * whitelisted subset, omitted when none are present); present →
 * LimeSpot-layer envelope, degraded (`ok: false`). Network failures degrade
 * too — never throws.
 */
async function sendBridgeCall(
  name: string,
  callLabel: string,
  url: string,
  init: RequestInit,
): Promise<ToolExecutionResult> {
  try {
    const response = await fetch(url, init);
    const raw = await response.text().catch(() => '');

    if (response.headers.has(INTEGRATION_BRIDGE_ERROR_HEADER)) {
      // Non-object bodies leave both members undefined — the fallbacks apply.
      const envelope = (parseJson(raw) ?? {}) as BridgeErrorEnvelope;
      const message = envelope.Message || `Integration bridge request failed (${response.status})`;
      const exceptionType = envelope.ExceptionType || 'Exception';
      return {
        ok: false,
        name,
        result: { error: `${message} (${exceptionType})` },
        summary: `${name} error`,
      };
    }

    const forwarded: Record<string, string> = {};
    for (const headerName of FORWARDED_HEADER_NAMES) {
      const value = response.headers.get(headerName);
      if (value !== null) {
        forwarded[headerName] = value;
      }
    }
    const parsed = parseJson(raw);
    const result: PlatformCallResult = {
      platformStatus: response.status,
      ...(Object.keys(forwarded).length > 0 ? { headers: forwarded } : {}),
      body: parsed !== undefined ? parsed : raw,
    };

    return {
      ok: true,
      name,
      result,
      summary: `${callLabel} → ${response.status}`,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      name,
      result: { error: `Integration bridge ${name} error: ${reason}` },
      summary: `${name} error`,
    };
  }
}

/** Parse JSON, returning `undefined` (not a throw) on non-JSON text. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
