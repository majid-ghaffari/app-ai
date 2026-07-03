/**
 * Shopify toolset — transparent passthrough access to the merchant's Shopify
 * Admin API (REST + GraphQL), reads AND writes, through Personalizer's
 * integration bridge (`v2/integration-bridge/shopify/*`). app-ai never holds
 * the merchant's Shopify token — Personalizer is the credential custodian; this
 * toolset resolves only the call channel (../integration-bridge.ts).
 *
 * The integration bridge is a pure passthrough (no path/method allowlists). The
 * behavioral boundary is these tool descriptions (the write-caution
 * instruction) plus the merchant token's own OAuth scopes. REST paths are
 * version-less — Personalizer pins the Admin API version. GraphQL documents
 * forward verbatim, mutations included.
 *
 * The module exports ONE thing: the toolset descriptor consumed by the
 * registry (../registry.ts). Handlers never import this module directly —
 * they compose tools through the registry (docs/TOOLSETS.md).
 */

import {
  resolveBridgeChannel,
  executeRestRequest,
  executeGraphQlRequest,
  unknownToolResult,
  type BridgeChannel,
} from '../integration-bridge';
import type { ToolDefinition } from '../../lib/anthropic';
import type { ToolsetDescriptor } from '../types';

/**
 * Anthropic tool definitions (sent in the `tools` array). Frozen cross-repo
 * contract shapes — names, schemas, and descriptions are pinned by the
 * contract snapshot; the descriptions carry the write-caution instruction the
 * integration bridge itself does not enforce.
 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'shopify_rest_request',
    description:
      "Call the merchant's Shopify Admin REST API. Provide the HTTP method, the version-less resource path (e.g. 'products.json'), and optional query parameters and JSON body. Reads are always safe; perform writes (POST/PUT/DELETE) only when the merchant has explicitly asked for the change, and confirm destructive actions first.",
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: {
          type: 'string',
          description: "Version-less Admin REST path, e.g. 'products.json' or 'orders/123.json'.",
        },
        query: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Query parameters, e.g. {"limit":"50","page_info":"…"}.',
        },
        body: { type: 'object', description: 'JSON request body for POST/PUT.' },
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'shopify_graphql',
    description:
      "Run a GraphQL operation against the merchant's Shopify Admin API. Queries are always safe; run mutations only when the merchant has explicitly asked for the change, and confirm destructive actions first. Use variables for values.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A GraphQL document (query or mutation).' },
        variables: { type: 'object', description: 'GraphQL variables.' },
      },
      required: ['query'],
    },
  },
];

/**
 * The toolset descriptor (contract in ../types.ts + docs/TOOLSETS.md).
 * Credentials = the integration-bridge call channel (context-ID + service token +
 * Personalizer base URL) — per-request, subscriber-scoped, never model-visible,
 * never logged. `execute` returns the degrade-safe `{ ok, name, result,
 * summary }` shape (never throws); platform responses — including platform
 * 4xx/5xx — surface verbatim as data (../integration-bridge.ts).
 */
export const shopifyToolset: ToolsetDescriptor = {
  name: 'shopify',

  // Gated on the Shopify commerce party — composed only when the subscriber has
  // ShopifyPersonalizer available (registry composition).
  integrationParties: ['ShopifyPersonalizer'],

  definitions: TOOL_DEFINITIONS,

  resolveCredentials(authContext) {
    return resolveBridgeChannel(authContext);
  },

  async execute(name, input, { credentials, matchedParty }) {
    // The registry hands back what resolveCredentials returned — this module
    // owns both sides of that seam, so the cast is the module boundary.
    const channel = credentials as BridgeChannel;
    // The matched party is the integration-bridge URL segment. The registry
    // only routes to an active toolset, so it is always set here.
    if (!matchedParty) {
      return unknownToolResult(name);
    }

    if (name === 'shopify_rest_request') {
      return executeRestRequest(name, matchedParty, input, channel);
    }
    if (name === 'shopify_graphql') {
      return executeGraphQlRequest(name, matchedParty, input, channel);
    }
    return unknownToolResult(name);
  },
};
