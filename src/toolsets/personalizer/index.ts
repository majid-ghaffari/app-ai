/**
 * Personalizer toolset — every AI tool whose backend is Brain (the
 * Personalizer API).
 *
 * These tools are exposed to the Anthropic model during the chat/onboarding
 * agent loop. When the model emits a `tool_use` for one of them, app-ai
 * executes it by calling Brain's read-only AI tool proxy (`/v2/ai-tools/*`)
 * server→server, forwarding the merchant's X-Personalizer-Context-ID for
 * tenant scoping.
 *
 * The model NEVER reaches Brain directly. See lib CONTRACTS.md §2 for the
 * frozen tool definitions + the Brain endpoint each one calls.
 *
 * `get_entity_context` is the referencing deref tool: record types resolve via
 * `fetchEntityContext` (./entity-context.ts — Brain's per-record admin
 * endpoints, normalized worker-side to the frozen AiToolEntityContext shape);
 * analytics types resolve worker-side from the request's `context.refs`
 * (lib/references.ts) with no Brain call.
 *
 * The module exports ONE thing: the toolset descriptor consumed by the
 * registry (../registry.ts). Handlers never import this module directly —
 * they compose tools through the registry (see docs/TOOLSETS.md).
 *
 * Credentials (the seam, docs/TOOLSETS.md): `resolveCredentials` returns
 * `{ contextId }` — the request's forwarded, already-validated
 * X-Personalizer-Context-ID. It is subscriber-scoped, per-request, and used
 * ONLY as the Brain auth header; it never enters tool definitions, tool
 * results, or logs.
 */

import { fetchEntityContext } from './entity-context';
import { refCategoryPath, type EntityReference } from '../../lib/references';
import { brainApiUrl, type Env } from '../../config';
import type { ToolDefinition } from '../../lib/anthropic';
import type { ToolExecutionResult, ToolsetDescriptor } from '../types';

/**
 * Anthropic tool definitions (sent in the `tools` array). Kept deterministic
 * (stable order, no per-request data) so the prompt prefix caches well.
 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_store_analytics',
    description:
      "Get the merchant's store performance over a date window: order count, total revenue, average order value (AOV), and conversion rate. Call this when the merchant asks about sales, revenue, AOV, or when you need the AOV to recommend a progress-bar threshold.",
    input_schema: {
      type: 'object',
      properties: {
        fromDate: {
          type: 'string',
          description: 'Start date, YYYY-MM-DD. Optional; defaults to 90 days ago.',
        },
        toDate: {
          type: 'string',
          description: 'End date, YYYY-MM-DD. Optional; defaults to today.',
        },
      },
    },
  },
  {
    name: 'list_segments',
    description:
      "List the merchant's existing audience segments and their status. Call this before recommending which segments to activate so you don't suggest ones that already exist or are already active.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['Active', 'Inactive', 'All'],
          description: 'Filter by status. Optional; defaults to All.',
        },
        keyword: {
          type: 'string',
          description: 'Optional keyword to filter segment titles.',
        },
      },
    },
  },
  {
    name: 'list_campaigns',
    description:
      "List the merchant's existing campaigns (discount, progress bar, HTML, image) and their status. Call this before recommending a new campaign so you reflect what's already set up.",
    input_schema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['discount', 'progressbar', 'html', 'image', 'all'],
          description: 'Which kind of campaign to list. Optional; defaults to all.',
        },
        keyword: {
          type: 'string',
          description: 'Optional keyword to filter campaign titles.',
        },
      },
    },
  },
  {
    name: 'get_store_config',
    description:
      "Get the merchant's store configuration: platform, industry, currency, and the recommendation-box types currently configured per page. Call this to understand the store's setup and industry before tailoring recommendations.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_entity_context',
    description:
      'Fetch full detail for a referenced entity by type and id. Use it for deeper detail on a referenced campaign, segment, progress bar, or bundle, or to re-read an analytics reference already attached to this conversation.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'campaign',
            'segment',
            'progress-bar',
            'bundle',
            'analytics-metric',
            'analytics-tab',
          ],
          description: 'The referenced entity type.',
        },
        id: {
          type: 'string',
          description:
            'Entity Guid for campaign/segment/progress-bar/bundle. For analytics types, the category path: analytics/{tab} or analytics/{tab}/{metricKey}.',
        },
      },
      required: ['type', 'id'],
    },
  },
];

/** The model's `tool_use` input for the data-query tools (client-side of the schema). */
interface DataQueryInput {
  fromDate?: string;
  toDate?: string;
  status?: string;
  keyword?: string;
  kind?: string;
}

/** The model's `tool_use` input for `get_entity_context`. */
interface EntityContextInput {
  type?: string;
  id?: string;
}

/** Map a tool name to its Brain AI-proxy request path (query built from the input). */
const TOOL_ROUTES: Record<string, (input: DataQueryInput) => string> = {
  get_store_analytics: (input) => {
    const params = new URLSearchParams();
    if (input.fromDate) params.set('fromDate', input.fromDate);
    if (input.toDate) params.set('toDate', input.toDate);
    const qs = params.toString();
    return `v2/ai-tools/store-analytics${qs ? `?${qs}` : ''}`;
  },
  list_segments: (input) => {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.keyword) params.set('keyword', input.keyword);
    const qs = params.toString();
    return `v2/ai-tools/segments${qs ? `?${qs}` : ''}`;
  },
  list_campaigns: (input) => {
    const params = new URLSearchParams();
    if (input.kind) params.set('kind', input.kind);
    if (input.keyword) params.set('keyword', input.keyword);
    const qs = params.toString();
    return `v2/ai-tools/campaigns${qs ? `?${qs}` : ''}`;
  },
  get_store_config: () => 'v2/ai-tools/store-config',
};

/** This toolset's credentials: the merchant's forwarded context-ID. */
interface PersonalizerCredentials {
  contextId: string;
}

/**
 * The toolset descriptor (contract in ../types.ts + docs/TOOLSETS.md).
 * Personalizer credentials = the merchant's forwarded context-ID (validated
 * upfront by the router; Brain re-validates it on every proxied call).
 *
 * `execute` is defensive: a Brain failure is returned as `{ ok: false, ... }`
 * with an error message rather than thrown, so the agent loop can feed the
 * error back to the model (which can then apologize / proceed) instead of
 * aborting the turn.
 */
export const personalizerToolset: ToolsetDescriptor = {
  name: 'personalizer',

  definitions: TOOL_DEFINITIONS,

  resolveCredentials({ contextId }): PersonalizerCredentials {
    return { contextId };
  },

  async execute(name, input, { credentials, env, refs = [] }) {
    // The registry hands back what resolveCredentials returned — this module
    // owns both sides of that seam, so the cast is the module boundary.
    const { contextId } = credentials as PersonalizerCredentials;

    if (name === 'get_entity_context') {
      return executeGetEntityContext((input ?? {}) as EntityContextInput, contextId, env, refs);
    }

    const buildPath = TOOL_ROUTES[name];
    if (!buildPath) {
      return {
        ok: false,
        name,
        result: { error: `Unknown tool: ${name}` },
        summary: `Unknown tool: ${name}`,
      };
    }

    return fetchBrainTool(name, buildPath((input ?? {}) as DataQueryInput), contextId, env);
  },
};

/**
 * Dispatch `get_entity_context` per the frozen table (lib CONTRACTS.md §2):
 * record types (`campaign`/`segment`/`progress-bar`/`bundle`) →
 * `fetchEntityContext` (Brain's per-record admin endpoints, normalized
 * worker-side); analytics types (`analytics-metric`/`analytics-tab`) →
 * resolved from the request's refs (match `refCategoryPath(ref) === input.id`,
 * fallback first ref of matching `type`), returning the ref's `metadata` —
 * NO Brain call.
 */
async function executeGetEntityContext(
  input: EntityContextInput,
  contextId: string,
  env: Env,
  refs: readonly EntityReference[],
): Promise<ToolExecutionResult> {
  const name = 'get_entity_context';
  const { type, id } = input;

  if (type === 'analytics-metric' || type === 'analytics-tab') {
    const list = Array.isArray(refs) ? refs : [];
    const ref =
      list.find((r) => r && refCategoryPath(r) === id) ?? list.find((r) => r && r.type === type);
    if (!ref) {
      return {
        ok: false,
        name,
        result: { error: 'analytics reference not attached to this request' },
        summary: `${name}: analytics reference not attached`,
      };
    }
    return {
      ok: true,
      name,
      result: ref.metadata ?? {},
      summary: `${type} ${refCategoryPath(ref)}`,
    };
  }

  try {
    const data = await fetchEntityContext(String(type), id, contextId, env);
    return { ok: true, name, result: data, summary: summarize(name, data) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      name,
      result: { error: `Brain AI tool ${name} error: ${reason}` },
      summary: `${name} error`,
    };
  }
}

/**
 * GET one Brain AI-tool proxy path server→server, forwarding the merchant's
 * context-ID. Non-ok / network failures come back as `{ ok: false, ... }`.
 */
async function fetchBrainTool(
  name: string,
  path: string,
  contextId: string,
  env: Env,
): Promise<ToolExecutionResult> {
  const url = `${brainApiUrl(env)}/${path}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Personalizer-Context-ID': contextId,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        name,
        result: { error: `Brain AI tool ${name} failed: ${response.status}`, body },
        summary: `${name} failed (${response.status})`,
      };
    }

    const data: unknown = await response.json();
    return { ok: true, name, result: data, summary: summarize(name, data) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      name,
      result: { error: `Brain AI tool ${name} error: ${reason}` },
      summary: `${name} error`,
    };
  }
}

/** The result members `summarize` peeks at (all optional — degrade to placeholders). */
interface SummarizableResult {
  AverageOrderValue?: unknown;
  Currency?: unknown;
  OrderCount?: unknown;
  Platform?: unknown;
  IndustryName?: unknown;
  Found?: unknown;
  Type?: unknown;
  Title?: unknown;
}

/** Build a short human-readable summary of a tool result for the SSE event. */
function summarize(name: string, data: unknown): string {
  try {
    // A null/primitive result throws on member access here and degrades to the
    // `${name} done` fallback below — same as any other malformed result.
    const record = data as SummarizableResult;
    if (name === 'get_store_analytics') {
      return `AOV ${record.AverageOrderValue ?? '?'} ${record.Currency ?? ''}, ${record.OrderCount ?? '?'} orders`;
    }
    if (name === 'list_segments') {
      return `${Array.isArray(data) ? data.length : 0} segments`;
    }
    if (name === 'list_campaigns') {
      return `${Array.isArray(data) ? data.length : 0} campaigns`;
    }
    if (name === 'get_store_config') {
      return `${record.Platform ?? 'store'} / ${record.IndustryName ?? 'industry'}`;
    }
    if (name === 'get_entity_context') {
      if (record.Found === false) return `${record.Type ?? 'entity'} not found`;
      return `${record.Type ?? 'entity'}: ${record.Title ?? 'ok'}`;
    }
  } catch {
    // fall through
  }
  return `${name} done`;
}
