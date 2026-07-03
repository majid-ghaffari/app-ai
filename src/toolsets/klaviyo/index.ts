/**
 * Klaviyo toolset — transparent passthrough access to the merchant's Klaviyo
 * API (reads AND writes) through Personalizer's integration bridge
 * (`v2/integration-bridge/klaviyo/rest/*`). app-ai never holds the merchant's
 * Klaviyo token — Personalizer is the credential custodian (it also owns the pinned
 * `revision` header and the 401 auto-refresh); this toolset resolves only the
 * call channel (../integration-bridge.ts).
 *
 * Paths follow Klaviyo's own convention (`api/…`). JSON:API paging
 * (`links.next` / `links.prev`) is body-native and passes through in the
 * platform body; the model follows cursors via the `page[cursor]` query
 * param. The behavioral boundary is the tool description's write-caution
 * instruction plus the merchant token's scopes.
 *
 * The module exports ONE thing: the toolset descriptor consumed by the
 * registry (../registry.ts). Handlers never import this module directly —
 * they compose tools through the registry (docs/TOOLSETS.md).
 */

import {
  resolveBridgeChannel,
  executeRestRequest,
  unknownToolResult,
  type BridgeChannel,
} from '../integration-bridge';
import type { ToolDefinition } from '../../lib/anthropic';
import type { ToolsetDescriptor } from '../types';

/** Frozen contract shape — pinned by the contract snapshot. */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'klaviyo_rest_request',
    description:
      "Call the merchant's Klaviyo API. Provide the HTTP method, the path (e.g. 'api/segments'), and optional query parameters (JSON:API style, e.g. filter, page[cursor]) and JSON body. Reads are always safe; perform writes only when the merchant has explicitly asked for the change, and confirm destructive actions first.",
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: "Klaviyo path, e.g. 'api/segments'." },
        query: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'object' },
      },
      required: ['method', 'path'],
    },
  },
];

/**
 * The toolset descriptor (contract in ../types.ts + docs/TOOLSETS.md).
 * Credentials = the integration-bridge call channel — per-request,
 * subscriber-scoped, never model-visible, never logged. `execute` never
 * throws; platform responses (any status) surface verbatim as data.
 */
export const klaviyoToolset: ToolsetDescriptor = {
  name: 'klaviyo',

  // Gated on the Klaviyo party — composed only when the subscriber has Klaviyo
  // available (registry composition).
  integrationParties: ['Klaviyo'],

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

    if (name === 'klaviyo_rest_request') {
      return executeRestRequest(name, matchedParty, input, channel);
    }
    return unknownToolResult(name);
  },
};
