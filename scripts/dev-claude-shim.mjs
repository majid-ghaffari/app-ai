/**
 * dev-claude-shim.mjs — the OFFICIAL dev LLM channel for app-ai.
 *
 * A local, Anthropic-API-compatible HTTP server (default :8788) that fulfils
 * inference via Claude Code (the `@anthropic-ai/claude-agent-sdk` `query()`)
 * instead of the paid Anthropic API — so dev NEVER burns Anthropic credits.
 *
 * The worker talks to Anthropic through exactly one seam (`src/lib/anthropic.ts`,
 * every call `fetch(`${ANTHROPIC_API_BASE}/v1/...`)`). Point `ANTHROPIC_API_BASE`
 * at this server (the dev default in `.dev.vars.example`) and every worker
 * inference is fulfilled by Claude Code, free, using the machine's Claude Code
 * auth. No `src/` change is needed.
 *
 * Endpoints (the subset the worker actually calls):
 *   POST /v1/messages                      — non-stream (probes: createMessage) + stream:true SSE (/chat)
 *   POST /v1/messages/count_tokens         — { input_tokens } char/4 estimate (advisory)
 *   POST /v1/files, GET/DELETE /v1/files/{id} — local temp store keyed by generated file_id
 *
 * The two response shapes are built to the EXACT specs the worker parses:
 *   - non-stream: `src/handlers/messages.ts` reads `data.error?`, `data.usage`,
 *     and passes the whole body through (probes read `content[0].text`).
 *   - stream: `src/handlers/chat.ts` `streamAnthropicTurn` (~L508-551) consumes
 *     Anthropic stream events: message_start / content_block_start /
 *     content_block_delta{text_delta,input_json_delta} / content_block_stop /
 *     message_delta{stop_reason} / message_stop. We emit exactly those.
 *
 * Tool-use bridge (for the /chat tool-loop) — two mutually-exclusive modes:
 *   - SERVER tools: each app-ai personalizer tool (get_store_analytics /
 *     list_segments / list_campaigns / get_store_config) is registered as an
 *     in-process `createSdkMcpServer()` tool whose handler makes the SAME
 *     Personalizer `v2/ai-tools/*` call the worker would, so the SDK resolves
 *     the loop and we emit tool_use frames. See TOOL BRIDGE below for the
 *     context-ID gap (the worker's Anthropic seam does not forward the
 *     context-ID, so the shim reads it from LS_DEV_CONTEXT_ID / a header).
 *   - CLIENT tools (onboarding-agent hands — anything in body.tools that is NOT
 *     a personalizer tool): registered as in-process MCP tools ONLY so Claude
 *     Code knows they exist; the shim NEVER runs them (they execute in a browser
 *     it can't reach). On a call, the shim surfaces the tool_use with the BARE
 *     name and STOPS the query (stop_reason: 'tool_use') — the worker returns
 *     done.toolCalls, the browser runs the tool, and /chat is called again with
 *     the tool_result appended. See CLIENT-TOOL BRIDGE below.
 *
 * This file is dev-only tooling. It is NOT bundled into the worker and never
 * runs in production.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// ── Config (env, with dev-sane defaults) ─────────────────────────────────────
//
// Config values are read through the `envOr` / `envRaw` helpers (bracket
// access + an explicit fallback argument, not an inline OR/nullish default) so
// the env-fallback fitness scan over scripts/ stays green. Endpoint defaults
// (the local Personalizer, the shim's own listen host) are dev-only and each
// overridable by an env var; the shim is carved out of the no-URL-literal scan.

/** Read `process.env[name]`, returning `fallback` when unset/empty. */
function envOr(name, fallback) {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
/** Read `process.env[name]`, returning '' when unset. */
function envRaw(name) {
  return envOr(name, '');
}

const PORT = Number(envOr('SHIM_PORT', '8788'));
const HOST = envOr('SHIM_HOST', '127.0.0.1');
/**
 * Personalizer base URL the tool bridge calls for v2/ai-tools/* (matches the
 * worker's PERSONALIZER_API_URL). Defaults to the local Personalizer; override
 * with PERSONALIZER_API_URL.
 */
const PERSONALIZER_API_URL = envOr('PERSONALIZER_API_URL', 'http://127.0.0.1:5000').replace(
  /\/+$/,
  '',
);
/**
 * Dev context-ID for the tool bridge. The worker's Anthropic seam does not
 * forward X-Personalizer-Context-ID to Anthropic, so the shim needs it out of
 * band to make the same v2/ai-tools/* call. Single dev store (e.g. majiddev-4).
 */
const DEV_CONTEXT_ID = envRaw('LS_DEV_CONTEXT_ID');
/** Default fulfiller model when a request omits `model`. */
const DEFAULT_MODEL = envOr('SHIM_DEFAULT_MODEL', 'claude-opus-4-8');
const DEBUG = /^(1|true|yes)$/i.test(envRaw('SHIM_DEBUG'));

function log(...args) {
  console.log('[dev-claude-shim]', ...args);
}
function debug(...args) {
  if (DEBUG) log(...args);
}

// ── Cred-burn GUARD ──────────────────────────────────────────────────────────

/**
 * The "never again" guard. Given an env-like object, THROW if a dev/test run
 * points `ANTHROPIC_API_BASE` at the real Anthropic API (`api.anthropic.com`)
 * WITHOUT an explicit `AI_CHANNEL=prod` opt-in. This makes accidental
 * credit-burn in local dev impossible: plain `wrangler dev` uses the free shim
 * (127.0.0.1), and a dev who genuinely wants the paid API must say so out loud.
 *
 * Pure (takes the env object) so it is unit-testable and reusable — the shim
 * runs it at startup against `process.env`, and app-ai's test suite runs it in
 * test/dev-shim.test.ts.
 */
function assertDevAiChannel(env) {
  const base = (env?.ANTHROPIC_API_BASE ?? '').toString();
  const channel = (env?.AI_CHANNEL ?? '').toString().trim().toLowerCase();
  const pointsAtRealApi = /(^|\/\/|\.)api\.anthropic\.com(\b|\/|:)/i.test(base);
  if (pointsAtRealApi && channel !== 'prod') {
    throw new Error(
      'Refusing to run: ANTHROPIC_API_BASE points at api.anthropic.com (the PAID API) ' +
        'in a dev/test run. This would burn Anthropic credits. Use the free dev channel ' +
        '(ANTHROPIC_API_BASE=http://127.0.0.1:8788 + `npm run dev:shim`), or, only if you ' +
        'truly intend to hit the real API, set AI_CHANNEL=prod explicitly to opt in.',
    );
  }
}

// ── In-memory Files store ────────────────────────────────────────────────────
// Keyed by generated file_id. Remembers mime (image vs document) so the /messages
// translation can rehydrate the file into the query() user turn as the right block.

/** @type {Map<string, { id: string, mime_type: string, filename: string, data: Buffer, created_at: string }>} */
const files = new Map();

function isImageMime(mime) {
  return typeof mime === 'string' && mime.startsWith('image/');
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Anthropic-shaped error body (what messages.ts reads via `data.error`). */
function sendAnthropicError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString('utf8'));
}

// ── Anthropic → Claude Code translation ──────────────────────────────────────

/**
 * Flatten the Anthropic `system` field (string | TextBlock[]) to a plain string
 * for `options.systemPrompt`.
 */
function systemToString(system) {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return undefined;
}

/**
 * Rehydrate one content block into an Anthropic MessageParam block for the
 * query() user turn. `file` sources (Files API) become base64 image/document
 * blocks from the in-memory store (the SDK talks to the real API under the hood,
 * so it needs inline bytes — it can't reference our fake file_ids). Text and
 * already-inline image/document blocks pass through.
 */
function rehydrateBlock(block) {
  if (!block || typeof block !== 'object') {
    return { type: 'text', text: String(block ?? '') };
  }
  const type = block.type;
  if (type === 'text') return { type: 'text', text: String(block.text ?? '') };

  // File-referenced image/document → inline base64 from the store.
  if ((type === 'image' || type === 'document') && block.source?.type === 'file') {
    const stored = files.get(block.source.file_id);
    if (!stored) {
      // Unknown file_id — degrade to a text note rather than fail the turn.
      return { type: 'text', text: `[missing file ${block.source.file_id}]` };
    }
    const mediaType = stored.mime_type || (type === 'image' ? 'image/png' : 'text/plain');
    if (type === 'image' || isImageMime(mediaType)) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: stored.data.toString('base64') },
      };
    }
    // Document: plaintext inline, PDFs as base64 document.
    if (mediaType === 'application/pdf') {
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: stored.data.toString('base64'),
        },
      };
    }
    return {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: stored.data.toString('utf8') },
    };
  }

  // Already-inline image/document (base64/url) → pass through.
  if (type === 'image' || type === 'document') return block;

  // tool_result blocks (from an /chat conversation the SDK didn't originate)
  // are flattened to text so the SDK sees the content without needing a
  // matching tool_use in its own transcript.
  if (type === 'tool_result') {
    const content =
      typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
    return { type: 'text', text: `[tool_result ${block.tool_use_id ?? ''}] ${content}` };
  }

  // Fallback: stringify.
  return { type: 'text', text: JSON.stringify(block) };
}

/**
 * Strip a wrapping markdown code fence from fulfilled text. The probe prompts
 * demand raw JSON ("no code fences"), but Claude Code's harness sometimes wraps
 * JSON in ```json … ```. This unwraps a single leading/trailing fence so the
 * probe parser sees clean JSON. Only strips when the WHOLE trimmed body is one
 * fenced block (never touches prose that merely contains a fence).
 */
function stripCodeFence(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1].trim() : text;
}

/** Normalize a message's content (string | block[]) into an Anthropic block[]. */
function normalizeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content.map(rehydrateBlock);
  return [{ type: 'text', text: String(content ?? '') }];
}

/**
 * Build the `prompt` (AsyncIterable<SDKUserMessage>) for query() from the
 * Anthropic `messages` array. Assistant turns are folded into the transcript as
 * synthetic context; user turns drive the query. We collapse to a single
 * combined user message per conversation (the SDK is single-turn per query());
 * prior assistant text is prepended as context so the model has the history.
 */
function buildPromptMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const userBlocks = [];
  const historyLines = [];

  for (const msg of list) {
    const role = msg?.role;
    const blocks = normalizeContent(msg?.content);
    if (role === 'assistant') {
      // Fold assistant history into a text preamble (SDK query is single-shot).
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) historyLines.push(`Assistant: ${text}`);
    } else {
      // user (or unknown) — accumulate real blocks (may include images).
      userBlocks.push(...blocks);
    }
  }

  const finalBlocks = [];
  if (historyLines.length > 0) {
    finalBlocks.push({
      type: 'text',
      text: `Conversation so far:\n${historyLines.join('\n')}\n\n---\n`,
    });
  }
  finalBlocks.push(...(userBlocks.length > 0 ? userBlocks : [{ type: 'text', text: '' }]));

  async function* gen() {
    yield {
      type: 'user',
      message: { role: 'user', content: finalBlocks },
      parent_tool_use_id: null,
    };
  }
  return gen();
}

// ── Tool bridge ──────────────────────────────────────────────────────────────
// Register each personalizer AI tool as an in-process MCP tool whose handler
// makes the SAME Personalizer v2/ai-tools/* GET the worker's personalizer
// toolset makes (src/toolsets/personalizer/index.ts). The SDK drives the loop.

/** GET one Personalizer AI-tool path, forwarding the dev context-ID. */
async function callPersonalizerAiTool(path, contextId) {
  const url = `${PERSONALIZER_API_URL}/${path}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'X-Personalizer-Context-ID': contextId, 'Content-Type': 'application/json' },
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    return { ok: false, status: response.status, body: text };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: text };
  }
}

/** A CallToolResult wrapping arbitrary JSON as a text block (MCP shape). */
function toolText(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  };
}

/**
 * Build the in-process MCP server exposing the four personalizer data tools,
 * bound to `contextId`. Returns null when no context-ID is available (the loop
 * then runs tool-free and the worker/model can note the fallback).
 */
function buildPersonalizerMcpServer(contextId) {
  if (!contextId) return null;

  const tools = [
    tool(
      'get_store_analytics',
      "Get the merchant's store performance (order count, revenue, AOV, conversion) over a date window.",
      { fromDate: z.string().optional(), toDate: z.string().optional() },
      async (args) => {
        const params = new URLSearchParams();
        if (args.fromDate) params.set('fromDate', args.fromDate);
        if (args.toDate) params.set('toDate', args.toDate);
        const qs = params.toString();
        const r = await callPersonalizerAiTool(
          `v2/ai-tools/store-analytics${qs ? `?${qs}` : ''}`,
          contextId,
        );
        return toolText(
          r.ok ? r.data : { error: `store-analytics failed: ${r.status}`, body: r.body },
        );
      },
    ),
    tool(
      'list_segments',
      "List the merchant's audience segments and their status.",
      { status: z.enum(['Active', 'Inactive', 'All']).optional(), keyword: z.string().optional() },
      async (args) => {
        const params = new URLSearchParams();
        if (args.status) params.set('status', args.status);
        if (args.keyword) params.set('keyword', args.keyword);
        const qs = params.toString();
        const r = await callPersonalizerAiTool(
          `v2/ai-tools/segments${qs ? `?${qs}` : ''}`,
          contextId,
        );
        return toolText(r.ok ? r.data : { error: `segments failed: ${r.status}`, body: r.body });
      },
    ),
    tool(
      'list_campaigns',
      "List the merchant's campaigns (discount, progress bar, HTML, image) and their status.",
      {
        kind: z.enum(['discount', 'progressbar', 'html', 'image', 'all']).optional(),
        keyword: z.string().optional(),
      },
      async (args) => {
        const params = new URLSearchParams();
        if (args.kind) params.set('kind', args.kind);
        if (args.keyword) params.set('keyword', args.keyword);
        const qs = params.toString();
        const r = await callPersonalizerAiTool(
          `v2/ai-tools/campaigns${qs ? `?${qs}` : ''}`,
          contextId,
        );
        return toolText(r.ok ? r.data : { error: `campaigns failed: ${r.status}`, body: r.body });
      },
    ),
    tool(
      'get_store_config',
      "Get the merchant's store configuration: platform, industry, currency, box types per page.",
      {},
      async () => {
        const r = await callPersonalizerAiTool('v2/ai-tools/store-config', contextId);
        return toolText(
          r.ok ? r.data : { error: `store-config failed: ${r.status}`, body: r.body },
        );
      },
    ),
  ];

  return createSdkMcpServer({ name: 'personalizer', version: '1.0.0', tools });
}

/** The bare app-ai names of the four SERVER-executed personalizer data tools. */
const PERSONALIZER_TOOL_NAMES = [
  'get_store_analytics',
  'list_segments',
  'list_campaigns',
  'get_store_config',
];

/** The MCP-prefixed tool names the SDK exposes for our personalizer server. */
const PERSONALIZER_MCP_TOOLS = PERSONALIZER_TOOL_NAMES.map((n) => `mcp__personalizer__${n}`);

/**
 * Map an SDK MCP tool name back to the bare app-ai tool name (strip any
 * `mcp__<server>__` prefix). Covers both the `personalizer` server (SERVER
 * tools) and the `client` server (CLIENT tools bridged from `body.tools`).
 */
function bareToolName(mcpName) {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(mcpName);
  return m ? m[1] : mcpName;
}

/**
 * True for a personalizer SERVER tool — one the shim EXECUTES internally (its
 * MCP handler makes the real v2/ai-tools/* GET) so the SDK resolves the loop.
 * The Claude Code harness may also emit its OWN built-in tool calls (Bash,
 * ToolSearch, Read, …) while reasoning — those are Claude Code's private
 * plumbing and must NEVER reach the worker's tool loop.
 */
function isPersonalizerTool(mcpName) {
  return PERSONALIZER_MCP_TOOLS.includes(mcpName) || PERSONALIZER_TOOL_NAMES.includes(mcpName);
}

// ── Client-tool bridge ───────────────────────────────────────────────────────
// The onboarding-agent (and any future `clientTools` prompt) sends tools in
// `body.tools` that run in a BROWSER the shim can't reach (screenshot, queryDom,
// applyBox, styleBox, …). The shim must NOT execute them — it must make Claude
// Code aware they exist (so it chooses to call one) and, on a call, surface that
// tool_use to the worker with the BARE name and STOP the query. The worker then
// returns `done.toolCalls` (stop_reason: 'tool_use'); the browser runs the tool
// and calls /chat again with the tool_result appended.

/** Extract the bare names of the CLIENT tools in a request (`body.tools` minus the personalizer four). */
function clientToolNamesFrom(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools
    .map((t) => (typeof t?.name === 'string' ? t.name : ''))
    .filter((name) => name && !PERSONALIZER_TOOL_NAMES.includes(name));
}

/**
 * A permissive Zod raw-shape for a client tool. We don't re-validate the model's
 * input (the browser does); we only need the SDK to register the tool by name so
 * the model can call it. Each declared property becomes an optional `z.any()`;
 * unknown keys pass through so nothing the model sends is dropped before we
 * surface it. (The handler never actually runs — canUseTool denies first.)
 */
function clientToolShape(inputSchema) {
  const shape = {};
  const props = inputSchema && typeof inputSchema === 'object' ? inputSchema.properties : null;
  if (props && typeof props === 'object') {
    for (const key of Object.keys(props)) shape[key] = z.any().optional();
  }
  return shape;
}

/** The MCP-prefixed id the SDK exposes for a bridged client tool. */
function clientMcpToolName(bareName) {
  return `mcp__client__${bareName}`;
}

/**
 * Build the in-process MCP server that makes the CLIENT tools visible to Claude
 * Code. Their handlers must never resolve normally (the tool runs in a browser),
 * so they simply signal that a client tool was reached — the real stop happens
 * in `canUseTool` (deny + interrupt) and by breaking the message loop the moment
 * a client tool_use is seen. Returns null when the request carries no client tools.
 */
function buildClientToolMcpServer(body) {
  const defs = (Array.isArray(body.tools) ? body.tools : []).filter(
    (t) => typeof t?.name === 'string' && !PERSONALIZER_TOOL_NAMES.includes(t.name),
  );
  if (defs.length === 0) return null;
  const tools = defs.map((def) =>
    tool(
      def.name,
      typeof def.description === 'string' ? def.description : def.name,
      clientToolShape(def.input_schema),
      async () =>
        toolText({ note: 'client tool — surfaced to the host; not executed by the shim' }),
    ),
  );
  return createSdkMcpServer({ name: 'client', version: '1.0.0', tools });
}

// ── query() runner ───────────────────────────────────────────────────────────

/**
 * Build the shared query() options for a request, plus the set of CLIENT tool
 * names (bare) the caller must forward-and-stop on.
 *
 * Two tool MODES, mutually exclusive per request (the worker sends a
 * `clientTools` prompt's tools IN PLACE OF the server toolset):
 *   - SERVER tools (the four personalizer data tools): registered as an
 *     in-process MCP server the shim EXECUTES; allowed + auto-run under
 *     `bypassPermissions` so the SDK resolves the loop. Unchanged.
 *   - CLIENT tools (anything else in `body.tools` — the onboarding hands):
 *     registered as an in-process MCP server so the model can call them, but
 *     NEVER executed. `permissionMode: 'default'` + a `canUseTool` that DENIES
 *     each client tool with `interrupt: true` stops the loop the moment the
 *     model reaches for one; the message loop also breaks on the first client
 *     tool_use it sees and reports `stop_reason: 'tool_use'`.
 *
 * @returns {{ options: Record<string, unknown>, clientToolNames: string[] }}
 */
function buildQueryOptions(body, contextId) {
  const model = body.model || DEFAULT_MODEL;
  const systemPrompt = systemToString(body.system);
  /** @type {Record<string, unknown>} */
  const options = {
    model,
    settingSources: [], // don't inherit repo/user Claude Code settings
    permissionMode: 'bypassPermissions',
    // The shim is a pure inference fulfiller — no filesystem/bash tools. Only
    // our bridged MCP tools are allowed. Disallow the harness built-ins so the
    // model reasons directly and calls only our bridged tools (the stream also
    // filters any that slip through).
    disallowedTools: [
      'Bash',
      'BashOutput',
      'Edit',
      'Write',
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'Task',
      'ToolSearch',
      'NotebookEdit',
      'TodoWrite',
    ],
    maxTurns: 12,
  };
  if (systemPrompt) options.systemPrompt = systemPrompt;

  const wantsTools = Array.isArray(body.tools) && body.tools.length > 0;
  const clientToolNames = clientToolNamesFrom(body);
  const clientMcp = buildClientToolMcpServer(body);

  if (clientMcp) {
    // CLIENT-tool mode (onboarding-agent). Register the client tools so the
    // model can call them, but keep them OUT of allowedTools and DENY them in
    // canUseTool (with interrupt) so they're surfaced-and-stopped, never run.
    // The personalizer server is attached too (when a context-ID is present) in
    // case a request ever mixes the two; canUseTool allows those to execute.
    const clientMcpIds = new Set(clientToolNames.map(clientMcpToolName));
    /** @type {Record<string, unknown>} */
    const mcpServers = { client: clientMcp };
    const allowedTools = [];
    const personalizerMcp = contextId ? buildPersonalizerMcpServer(contextId) : null;
    if (personalizerMcp) {
      mcpServers.personalizer = personalizerMcp;
      allowedTools.push(...PERSONALIZER_MCP_TOOLS);
    }
    options.permissionMode = 'default';
    options.mcpServers = mcpServers;
    options.allowedTools = allowedTools;
    options.canUseTool = async (toolName) => {
      if (clientMcpIds.has(toolName)) {
        // Surface-and-stop: the browser runs it, not us. interrupt halts the loop.
        return { behavior: 'deny', message: 'client tool — surfaced to the host', interrupt: true };
      }
      // Personalizer/server tools (and only those, everything else is disallowed)
      // execute as before.
      return { behavior: 'allow' };
    };
    return { options, clientToolNames };
  }

  // SERVER-tool mode (personalizer) — unchanged. Attach the bridge only when
  // the request carries tools AND we have a context-ID; a tool-free request
  // (probes) runs with allowedTools: [].
  const mcp = wantsTools ? buildPersonalizerMcpServer(contextId) : null;
  if (mcp) {
    options.mcpServers = { personalizer: mcp };
    options.allowedTools = [...PERSONALIZER_MCP_TOOLS];
  } else {
    options.allowedTools = [];
    if (wantsTools && !contextId) {
      debug(
        'tools requested but no context-ID — running tool-free (dev fallback to real API for tool flows)',
      );
    }
  }
  return { options, clientToolNames };
}

/**
 * Estimate usage from an SDKResult, mapped to Anthropic's `usage` shape (only
 * the fields the worker reads). Claude Code's usage carries the same field
 * names, so we pass through what's present.
 */
function usageFrom(result) {
  const u = result?.usage || {};
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

// ── POST /v1/messages — NON-STREAM ───────────────────────────────────────────

async function handleMessagesNonStream(body, contextId, res) {
  const { options, clientToolNames } = buildQueryOptions(body, contextId);
  const clientNameSet = new Set(clientToolNames);
  const q = query({ prompt: buildPromptMessages(body.messages), options });

  let text = '';
  /** @type {Array<{type:string,[k:string]:unknown}>} */
  const contentBlocks = [];
  let stopReason = 'end_turn';
  let usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let resultText = null;
  /** @type {Array<{id:string,name:string,input:unknown}>} */
  const clientToolUses = [];

  try {
    for await (const m of q) {
      if (m.type === 'assistant') {
        let sawClientTool = false;
        for (const b of m.message.content || []) {
          if (b.type === 'text') {
            text += b.text;
          } else if (b.type === 'tool_use') {
            const bare = bareToolName(b.name);
            if (clientNameSet.has(bare)) {
              // A CLIENT tool the worker declared. Surface it (bare name) and
              // stop — the browser executes it, then /chat is called again.
              clientToolUses.push({ id: b.id, name: bare, input: b.input ?? {} });
              sawClientTool = true;
            }
            // Non-client tool_use (personalizer server tools resolve internally;
            // harness built-ins are dropped) — nothing to surface here.
          }
        }
        if (sawClientTool) {
          // Break the loop the moment a client tool is reached (canUseTool's
          // deny+interrupt is the safety net; this makes the stop deterministic).
          stopReason = 'tool_use';
          break;
        }
      } else if (m.type === 'result') {
        usage = usageFrom(m);
        if (m.subtype === 'success') {
          resultText = m.result;
          stopReason = m.stop_reason || 'end_turn';
        } else {
          // Error result — surface as an Anthropic error body.
          return sendAnthropicError(
            res,
            502,
            'api_error',
            `Claude Code fulfilment error: ${m.subtype}${m.result ? ` — ${m.result}` : ''}`,
          );
        }
      }
    }
  } catch (err) {
    return sendAnthropicError(
      res,
      502,
      'api_error',
      `Claude Code query failed: ${err?.message || err}`,
    );
  }

  if (clientToolUses.length > 0) {
    // CLIENT-tool turn: assistant content is any lead-in text + the tool_use
    // block(s), stop_reason 'tool_use' — the shape the worker maps to done.toolCalls.
    const leadIn = stripCodeFence(text || '');
    if (leadIn) contentBlocks.push({ type: 'text', text: leadIn });
    for (const c of clientToolUses) {
      contentBlocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
    }
    stopReason = 'tool_use';
  } else {
    // Prefer the accumulated assistant text; fall back to the result string.
    // Strip a wrapping code fence so JSON-only probes/proposals parse cleanly.
    const finalText = stripCodeFence(text || resultText || '');
    contentBlocks.push({ type: 'text', text: finalText });
  }

  // One Anthropic Messages response body (the shape probes/messages.ts read).
  const responseBody = {
    id: `msg_dev_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
  sendJson(res, 200, responseBody);
}

// ── POST /v1/messages — STREAM (SSE) ─────────────────────────────────────────
// Emits the EXACT Anthropic stream envelope src/handlers/chat.ts parses.

function sseFrame(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function handleMessagesStream(body, contextId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const model = body.model || DEFAULT_MODEL;
  const { options, clientToolNames } = buildQueryOptions(body, contextId);
  const clientNameSet = new Set(clientToolNames);
  const q = query({ prompt: buildPromptMessages(body.messages), options });

  // message_start — carries usage the parser seeds from.
  res.write(
    sseFrame('message_start', {
      type: 'message_start',
      message: {
        id: `msg_dev_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  );

  // We synthesize the block envelope ourselves from assistant/result messages.
  // Block index counter across text + tool_use blocks in emission order.
  let blockIndex = 0;
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };
  // Track which text we've already streamed (SDK emits cumulative assistant
  // messages per turn; we diff to emit only new text).
  let emittedText = '';

  /** Emit a full text block (start → delta → stop) for new text. */
  function emitTextBlock(newText) {
    if (!newText) return;
    const index = blockIndex++;
    res.write(
      sseFrame('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      }),
    );
    res.write(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: newText },
      }),
    );
    res.write(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
  }

  /** Emit a tool_use block (start → input_json_delta → stop). */
  function emitToolUseBlock(id, name, input) {
    const index = blockIndex++;
    res.write(
      sseFrame('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id, name, input: {} },
      }),
    );
    res.write(
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) },
      }),
    );
    res.write(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
  }

  // Set once a CLIENT tool_use is surfaced — we break the loop and report
  // stop_reason 'tool_use' (the browser runs it, then /chat is called again).
  let sawClientTool = false;

  try {
    for await (const m of q) {
      if (m.type === 'assistant') {
        // Assistant message content: text + (bridged) tool_use blocks.
        for (const b of m.message.content || []) {
          if (b.type === 'text') {
            // Diff against already-emitted text (SDK may re-send cumulative).
            const full = b.text || '';
            if (full.startsWith(emittedText)) {
              const delta = full.slice(emittedText.length);
              emitTextBlock(delta);
              emittedText = full;
            } else {
              emitTextBlock(full);
              emittedText += full;
            }
          } else if (b.type === 'tool_use') {
            const bare = bareToolName(b.name);
            if (clientNameSet.has(bare)) {
              // A CLIENT tool the worker declared (onboarding hands). Surface the
              // tool_use with the BARE name and mark for stop — the browser runs
              // it; the client appends the tool_result and calls /chat again.
              emitToolUseBlock(b.id, bare, b.input);
              sawClientTool = true;
            } else if (isPersonalizerTool(b.name)) {
              // Bridged personalizer SERVER tool — forward with the BARE name.
              emitToolUseBlock(b.id, bare, b.input);
            } else {
              // Drop the Claude Code harness's own built-in tool calls (Bash,
              // ToolSearch, Read, …) — internal plumbing the worker never sees.
              debug(`dropping harness tool_use from stream: ${b.name}`);
            }
          }
        }
        if (sawClientTool) {
          // Break the moment a client tool is reached (canUseTool deny+interrupt
          // is the safety net; this makes the stop deterministic).
          stopReason = 'tool_use';
          break;
        }
      } else if (m.type === 'result') {
        usage = usageFrom(m);
        stopReason = m.subtype === 'success' ? m.stop_reason || 'end_turn' : 'end_turn';
        if (m.subtype !== 'success') {
          // Emit an Anthropic stream `error` event (chat.ts throws on it).
          res.write(
            sseFrame('error', {
              type: 'error',
              error: {
                type: 'api_error',
                message: `Claude Code fulfilment error: ${m.subtype}`,
              },
            }),
          );
          res.end();
          return;
        }
      }
    }
  } catch (err) {
    res.write(
      sseFrame('error', {
        type: 'error',
        error: { type: 'api_error', message: `Claude Code query failed: ${err?.message || err}` },
      }),
    );
    res.end();
    return;
  }

  // message_delta (stop_reason + cumulative usage) then message_stop.
  res.write(
    sseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens ?? 0 },
    }),
  );
  res.write(sseFrame('message_stop', { type: 'message_stop' }));
  res.end();
}

// ── POST /v1/messages/count_tokens ───────────────────────────────────────────

function estimateTokens(body) {
  // char/4 estimate over system + messages (advisory; matches the task spec).
  let chars = 0;
  const sys = systemToString(body.system);
  if (sys) chars += sys.length;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    const content = msg?.content;
    if (typeof content === 'string') chars += content.length;
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text') chars += String(b.text ?? '').length;
        else chars += 1500; // rough per-block (image/document) placeholder
      }
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

// ── Files API ────────────────────────────────────────────────────────────────

/**
 * POST /v1/files — multipart upload. Parses the `file` part out of the
 * multipart body (the worker's uploadFile sends FormData with a `file` field).
 * Returns an Anthropic-shaped file object.
 */
async function handleFileUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  const raw = await readBody(req);

  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundaryMatch) {
    return sendAnthropicError(res, 400, 'invalid_request_error', 'Expected multipart/form-data');
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const part = extractFilePart(raw, boundary);
  if (!part) {
    return sendAnthropicError(res, 400, 'invalid_request_error', 'No `file` part in upload');
  }

  const id = `file_dev_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const record = {
    id,
    mime_type: part.mimeType || 'application/octet-stream',
    filename: part.filename || 'upload.bin',
    data: part.data,
    created_at: new Date().toISOString(),
  };
  files.set(id, record);
  debug(`stored file ${id} (${record.mime_type}, ${record.data.length} bytes)`);

  sendJson(res, 200, {
    id,
    type: 'file',
    filename: record.filename,
    mime_type: record.mime_type,
    size_bytes: record.data.length,
    created_at: record.created_at,
    downloadable: false,
  });
}

/**
 * Minimal multipart parser — pulls the FIRST file part (the one with a
 * `filename` in its Content-Disposition). Sufficient for the worker's single-
 * file uploads. Returns { filename, mimeType, data } or null.
 */
function extractFilePart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(buffer, delimiter);
  for (const part of parts) {
    // A part starts with headers, then CRLFCRLF, then body.
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd).toString('utf8');
    if (!/content-disposition/i.test(header)) continue;
    const filenameMatch = /filename="([^"]*)"/i.exec(header);
    if (!filenameMatch) continue; // not the file field
    const mimeMatch = /content-type:\s*([^\r\n]+)/i.exec(header);
    // Body is between headerEnd+4 and a trailing CRLF before the next boundary.
    let body = part.slice(headerEnd + 4);
    // Trim trailing CRLF that precedes the boundary delimiter.
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.slice(0, body.length - 2);
    }
    return {
      filename: filenameMatch[1],
      mimeType: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream',
      data: body,
    };
  }
  return null;
}

function splitBuffer(buffer, delimiter) {
  const out = [];
  let start = 0;
  let idx;
  while ((idx = buffer.indexOf(delimiter, start)) !== -1) {
    if (idx > start) out.push(buffer.slice(start, idx));
    start = idx + delimiter.length;
  }
  if (start < buffer.length) out.push(buffer.slice(start));
  return out;
}

/** GET /v1/files/{id} — metadata (the worker's getFileMetadata reads mime_type). */
function handleFileMetadata(id, res) {
  const record = files.get(id);
  if (!record) {
    return sendAnthropicError(res, 404, 'not_found_error', `File ${id} not found`);
  }
  sendJson(res, 200, {
    id: record.id,
    type: 'file',
    filename: record.filename,
    mime_type: record.mime_type,
    size_bytes: record.data.length,
    created_at: record.created_at,
    downloadable: false,
  });
}

/** GET /v1/files — list. */
function handleFileList(res) {
  const data = [...files.values()].map((r) => ({
    id: r.id,
    type: 'file',
    filename: r.filename,
    mime_type: r.mime_type,
    size_bytes: r.data.length,
    created_at: r.created_at,
    downloadable: false,
  }));
  sendJson(res, 200, {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  });
}

/** DELETE /v1/files/{id}. */
function handleFileDelete(id, res) {
  const existed = files.delete(id);
  if (!existed) {
    return sendAnthropicError(res, 404, 'not_found_error', `File ${id} not found`);
  }
  sendJson(res, 200, { id, type: 'file_deleted' });
}

// ── Router ───────────────────────────────────────────────────────────────────

/** The request handler (exported for testing; the server binds it below). */
async function handleHttp(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  // The context-ID for the tool bridge: request header (if the worker ever
  // forwards it) else the dev env default.
  const contextId = req.headers['x-personalizer-context-id']?.toString() || DEV_CONTEXT_ID || '';

  try {
    if (path === '/health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok', fulfiller: 'claude-code' });
    }

    if (path === '/v1/messages' && method === 'POST') {
      const body = await readJson(req);
      debug(
        `/v1/messages model=${body.model || DEFAULT_MODEL} stream=${!!body.stream} tools=${Array.isArray(body.tools) ? body.tools.length : 0}`,
      );
      if (body.stream === true) {
        return handleMessagesStream(body, contextId, res);
      }
      return handleMessagesNonStream(body, contextId, res);
    }

    if (path === '/v1/messages/count_tokens' && method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, { input_tokens: estimateTokens(body) });
    }

    if (path === '/v1/files' && method === 'POST') {
      return handleFileUpload(req, res);
    }
    if (path === '/v1/files' && method === 'GET') {
      return handleFileList(res);
    }
    const fileMatch = /^\/v1\/files\/([^/]+)$/.exec(path);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]);
      if (method === 'GET') return handleFileMetadata(id, res);
      if (method === 'DELETE') return handleFileDelete(id, res);
    }

    sendAnthropicError(res, 404, 'not_found_error', `No route for ${method} ${path}`);
  } catch (err) {
    log('handler error:', err?.stack || err);
    if (!res.headersSent) {
      sendAnthropicError(res, 500, 'api_error', `Shim error: ${err?.message || err}`);
    } else {
      res.end();
    }
  }
}

/**
 * Start the shim. Only invoked when this file is run directly
 * (`node scripts/dev-claude-shim.mjs` / `npm run dev:shim`) — importing the
 * module for unit tests does NOT bind the port.
 */
function startServer() {
  const server = createServer(handleHttp);
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT} — fulfilling via Claude Code (no Anthropic credits)`);
    log(`default model: ${DEFAULT_MODEL}`);
    log(
      DEV_CONTEXT_ID
        ? `tool bridge: enabled (context-ID set, Personalizer=${PERSONALIZER_API_URL})`
        : `tool bridge: disabled (set LS_DEV_CONTEXT_ID to enable /chat tool calls)`,
    );
  });
  return server;
}

// Run only as a direct script, not on import (keeps the test import side-effect
// free — no port bind).
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

// Export internals for unit tests (the translation layer + the guard).
export {
  systemToString,
  rehydrateBlock,
  normalizeContent,
  buildPromptMessages,
  estimateTokens,
  bareToolName,
  isPersonalizerTool,
  clientToolNamesFrom,
  clientToolShape,
  stripCodeFence,
  usageFrom,
  extractFilePart,
  assertDevAiChannel,
  files as _filesStore,
};
