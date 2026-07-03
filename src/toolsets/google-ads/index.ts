/**
 * Google Ads toolset — GAQL (Google Ads Query Language) queries against the
 * merchant's linked Google Ads account through Personalizer's integration bridge
 * (`v2/integration-bridge/google/gaql`). Read-only by nature of the surface —
 * GAQL expresses only SELECT; Google Ads mutations are not reachable through
 * this toolset.
 *
 * app-ai never holds Google credentials — Personalizer is the credential custodian
 * and resolves the subscriber's linked ads account itself (the account
 * identifier is not caller input); this toolset resolves only the call
 * channel (../integration-bridge.ts). Results come back as
 * `{ Results: [...rows], NextPageToken }` in the platform body; a Google-side
 * failure arrives as the `GoogleAdsFailure` payload with the mapped HTTP
 * status — still the platform speaking, surfaced verbatim as data.
 *
 * The module exports ONE thing: the toolset descriptor consumed by the
 * registry (../registry.ts). Handlers never import this module directly —
 * they compose tools through the registry (docs/TOOLSETS.md).
 */

import {
  resolveBridgeChannel,
  executeGaqlRequest,
  unknownToolResult,
  type BridgeChannel,
} from '../integration-bridge';
import type { ToolDefinition } from '../../lib/anthropic';
import type { ToolsetDescriptor } from '../types';

/** Frozen contract shape — pinned by the contract snapshot. */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'google_ads_gaql_query',
    description:
      "Run a GAQL (Google Ads Query Language) SELECT query against the merchant's linked Google Ads account. GAQL is read-only. When the response carries a non-empty NextPageToken there are more rows: call again with the SAME query and that value as pageToken to fetch the next page.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A GAQL SELECT statement.' },
        pageSize: { type: 'integer', minimum: 1, maximum: 1000 },
        pageToken: {
          type: 'string',
          description:
            'Cursor for the next page — the NextPageToken from a previous response for the SAME query. Omit for the first page.',
        },
      },
      required: ['query'],
    },
  },
];

/**
 * The toolset descriptor (contract in ../types.ts + docs/TOOLSETS.md).
 * Credentials = the integration-bridge call channel — per-request,
 * subscriber-scoped, never model-visible, never logged. `execute` never
 * throws; platform responses (any status) surface verbatim as data.
 */
export const googleAdsToolset: ToolsetDescriptor = {
  name: 'google-ads',

  // Gated on the Google party — composed only when the subscriber has Google
  // available (registry composition).
  integrationParties: ['Google'],

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

    if (name === 'google_ads_gaql_query') {
      return executeGaqlRequest(name, matchedParty, input, channel);
    }
    return unknownToolResult(name);
  },
};
