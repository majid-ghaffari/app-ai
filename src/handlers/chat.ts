/**
 * POST /chat — Studio AI chat agent loop + SSE streaming.
 *
 * (see lib CONTRACTS.md §1). The client sends a system-prompt selector (header),
 * a message history, and optional grounding context — including `context.refs`
 * (entity references, cap 5) rendered as the eager Referenced-Entities system
 * block (lib/references.ts) and threaded into the agent loop for the
 * `get_entity_context` tool's analytics dispatch. We run the Anthropic model
 * with the tool-use agent loop:
 *
 *   model → (tool_use?) → execute tool (owning toolset) → tool_result → model → …
 *
 * bounded by MAX_ITERATIONS, streaming text out as it arrives. Two response
 * shapes, picked by the client's Accept header:
 *   • Accept: text/event-stream  → our SSE protocol (text/tool_call/tool_result/done/error)
 *   • otherwise                  → a single JSON object identical to the `done` payload
 *
 * The Anthropic key never leaves the worker (it lives in the anthropic client).
 * The tool surface comes ONLY from the toolset registry (toolsets/registry.ts):
 * this endpoint composes its tool surface per request from the subscriber's
 * available IntegrationParty set (threaded from the router's validate-context-id
 * call), and the composition owns tool definitions, dispatch, and per-toolset
 * credentials (docs/TOOLSETS.md). The personalizer toolset (always-active) calls
 * Personalizer server→server, forwarding the merchant's context-ID; each
 * party-gated platform toolset joins only when its party is available.
 *
 * Per-prompt model / token / tool choices come from the prompt registry
 * (prompt-registry.ts) — the single source of truth.
 */

import { getSystemPrompt, type SystemPromptEntry } from '../prompt-registry';
import { composeToolsets } from '../toolsets/registry';
import type { ToolsetComposition } from '../toolsets/types';
import type { IntegrationParty } from '../toolsets/integration-party';
import {
  WorkerError,
  errorPayload,
  errorEnvelopeFrom,
  errorResponseFrom,
  type CorsHeaders,
} from '../lib/responses';
import { streamMessage, supportsEffort, getFileMetadata } from '../lib/anthropic';
import type {
  ContentBlock,
  Effort,
  FileBlock,
  MessageParam,
  MessagesPayload,
  TextBlock,
  ToolDefinition,
  ToolUseBlock,
  Usage,
} from '../lib/anthropic';
import { EXTENDED_CACHE_CONTROL } from '../lib/cache-control';
import { applyConversationBreakpoints } from '../lib/agent-cache';
import {
  sanitizeRefs,
  buildReferencedEntitiesBlock,
  type EntityReference,
} from '../lib/references';
import { createLoggingRuntime, type Logger, type LoggingRuntime } from '../lib/logger';
import {
  createDevelopmentInferenceTrace,
  traceableContent,
  traceableMessages,
  traceableSystem,
  type DevelopmentInferenceTrace,
} from '../lib/dev-inference-trace';
import type { Env } from '../config';

/** Hard cap on model↔tool iterations (CONTRACTS.md §1). */
const MAX_ITERATIONS = 8;

/** The client-supplied /chat request body (validated at each point of use). */
interface ChatRequestBody {
  messages?: unknown;
  context?: ChatContext;
  model?: string;
  /**
   * Accepted for backward compatibility but IGNORED: the registry is
   * authoritative for a registered prompt's output budget (the resolved entry's
   * `maxTokens` is used exactly). A client-sent value does not override it.
   */
  max_tokens?: number;
  fileIds?: unknown;
  effort?: Effort;
}

/** The grounding context the client may send (lib CONTRACTS.md §1). */
interface ChatContext {
  hostPage?: string;
  candidates?: unknown[];
  grounding?: unknown;
  refs?: unknown;
}

/** One SSE event of our protocol (`text` / `tool_call` / `tool_result` / `done` / `error`). */
interface SseEvent {
  type: string;
  data: unknown;
}

type Emit = (event: SseEvent) => Promise<void> | void;

/** The terminal `done` payload (also the non-streaming JSON body). */
interface DonePayload {
  text: string;
  stopReason: string | null;
  iterations: number;
  usage: Usage | null;
  /**
   * CLIENT tool-calls the model requested this turn (only for a `clientTools`
   * prompt — e.g. `onboarding-chat`'s `look_at_page`). When present, the worker
   * did NOT execute them: the client runs them in the store iframe, appends the
   * `tool_result` turn (e.g. the captured screenshot), and calls `/chat` again to
   * continue. Absent for server-tool / no-tool prompts.
   */
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
}

/**
 * Handle POST /chat. The context-ID is already validated by the router, which
 * also threads the subscriber's available IntegrationParty set
 * (`availableParties`, from the same validate-context-id call) for dynamic
 * toolset composition. Returns a streaming `Response` (SSE) or a JSON `Response`.
 */
export async function handleChat(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
  availableParties: readonly IntegrationParty[] = [],
  logging: LoggingRuntime = createLoggingRuntime(env),
): Promise<Response> {
  const systemPromptName = request.headers.get('X-Personalizer-System-Prompt') || 'chat';
  const wantsStream = (request.headers.get('Accept') || '').includes('text/event-stream');
  const contextId = request.headers.get('X-Personalizer-Context-ID') ?? '';
  const log = logging.logger('Chat', { prompt: systemPromptName });
  const trace = createDevelopmentInferenceTrace(
    logging.logger('InferenceTrace', { prompt: systemPromptName }),
    'chat',
    systemPromptName,
  );

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch (error) {
    trace.record('request.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return badRequest('Invalid JSON body', corsHeaders, wantsStream);
  }

  const { messages, fileBlockCount } = await normalizeMessages(body.messages, body.fileIds, env);
  if (messages.length === 0) {
    return badRequest('messages must be a non-empty array', corsHeaders, wantsStream);
  }

  // The registry is the single source of truth for per-prompt model / token /
  // tool choices. Unknown selectors fall back to the `chat` entry.
  let entry: SystemPromptEntry;
  try {
    entry = getSystemPrompt(systemPromptName, env);
  } catch {
    entry = getSystemPrompt('chat', env);
  }

  // Referencing: `context.refs` (EntityReference[], cap 5 — lib CONTRACTS.md §1)
  // is sanitized, eagerly prefetched (record refs → Personalizer entity-context,
  // analytics refs → their own metadata, no Personalizer call), and rendered as the
  // Referenced-Entities block. `buildReferencedEntitiesBlock` never throws —
  // a failed ref degrades to a "(could not load)" line.
  const refs = sanitizeRefs(body.context?.refs);
  const referencedEntitiesBlock =
    refs.length > 0 ? await buildReferencedEntitiesBlock(refs, contextId, env) : null;

  const system = buildSystem(entry, body.context, referencedEntitiesBlock);
  const model = body.model || entry.model;
  // The registry is authoritative for a registered prompt's output budget — an
  // unknown selector already fell back to the `chat` entry above, so `entry` is
  // always a registered entry. Use its `maxTokens` EXACTLY (no client override):
  // changing the registry literal changes the outgoing request one-for-one.
  const maxTokens = entry.maxTokens;
  // The endpoint's whole tool surface, composed per request from the
  // subscriber's available integration parties (always-active toolsets like
  // personalizer join regardless). Per-toolset credentials (personalizer → the
  // forwarded context-ID) resolve inside the composition — never in the loop.
  const toolsets = composeToolsets(availableParties, { contextId, env });
  // A `clientTools` prompt (onboarding-chat) drives tools that run in the
  // browser, not the worker. Send ITS definitions to the model (in place of the
  // server toolset) and run the loop in CLIENT-tool mode: on a tool_use the loop
  // returns the calls to the client in `done.toolCalls` and stops — it never
  // executes them here. Otherwise the usual server toolset (when `usesTools`).
  const clientTools = entry.clientTools;
  const tools = clientTools ? [...clientTools] : entry.usesTools ? toolsets.definitions : undefined;
  const clientToolMode = !!clientTools;
  // Opt-in output effort: registry entry default, client `effort` override.
  const effort = body.effort || entry.effort;

  const runner = (emit: Emit | null) =>
    runAgentLoop(
      {
        env,
        toolsets,
        model,
        maxTokens,
        system,
        messages,
        tools,
        effort,
        fileBlockCount,
        refs,
        clientToolMode,
        trace,
        logger: log,
      },
      emit,
    )
      .then((done) => {
        trace.record('request.completed', { ...done });
        return done;
      })
      .catch((error: unknown) => {
        trace.record('request.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        log.error('Chat request failed', error, { systemPromptName });
        throw error;
      });

  if (wantsStream) {
    return streamResponse(runner, corsHeaders);
  }
  return jsonRunnerResponse(runner, corsHeaders);
}

/**
 * Build the `system` array: the selected server-side prompt, plus any grounding
 * context the client supplied (current page, validated candidates, best-practice
 * catalog), plus the prebuilt Referenced-Entities block when `context.refs`
 * survived intake. The base prompt is cached; the volatile context and the
 * Referenced-Entities block are separate UNCACHED blocks, so the cached prefix
 * (tools + base prompt) stays byte-stable and its breakpoint stays valid.
 */
export function buildSystem(
  entry: SystemPromptEntry,
  context: ChatContext | undefined,
  referencedEntitiesBlock: string | null = null,
): TextBlock[] {
  // The base prompt is a stable, reused prefix → 1h extended cache. The
  // volatile context block below carries NO cache_control (it changes per call).
  const blocks: TextBlock[] = [
    { type: 'text', text: entry.prompt, cache_control: { ...EXTENDED_CACHE_CONTROL } },
  ];

  if (context && typeof context === 'object') {
    const lines: string[] = [];
    if (context.hostPage) lines.push(`Current page: ${context.hostPage}.`);
    if (Array.isArray(context.candidates) && context.candidates.length > 0) {
      lines.push('Validated placement candidates (pick by index):');
      lines.push(JSON.stringify(context.candidates));
    }
    if (context.grounding) {
      lines.push('LimeSpot best-practice catalog (ground recommendations in this):');
      lines.push(JSON.stringify(context.grounding));
    }
    if (lines.length > 0) {
      blocks.push({ type: 'text', text: lines.join('\n') });
    }
  }

  // Referenced-Entities: always the FINAL system block, always uncached (it
  // changes per call — see lib/references.ts for the frozen block format).
  if (referencedEntitiesBlock) {
    blocks.push({ type: 'text', text: referencedEntitiesBlock });
  }

  return blocks;
}

/**
 * Normalize the client message history into Anthropic message params. Optionally
 * prepend uploaded file blocks (document/image) to the first user turn — used by
 * the placement flow (screenshot + cleaned HTML uploaded via /files).
 *
 * The file blocks are a STABLE per-page prefix: the same screenshot + cleaned
 * HTML bytes are reused across repeated placement calls on one page, and (via
 * the /files content-hash dedup) map to the same file_id. We mark the LAST file
 * block with the 1h extended cache breakpoint so the whole file prefix caches at
 * 0.1× on the second call. This is the big placement token cost — file blocks
 * dwarf the 370-token system prompt. The breakpoint budget stays ≤4: this file
 * prefix takes 1, the system base block 1, leaving 2 for conversation turns (see
 * `applyConversationBreakpoints` opts in `runAgentLoop`). The file prefix consumes
 * exactly ONE breakpoint regardless of how many `fileIds` are passed (only the
 * last block is marked), so the ≤4 budget is independent of the file count.
 * Returns the file-block count so the caller can size the conversation breakpoint cap.
 *
 * Each fileId is resolved to the correct content-block type by its mime type:
 * images (`image/*`) MUST be `image` blocks — Anthropic rejects an image inside
 * a `document` block ("Only PDF and plaintext documents are supported"), which
 * is exactly the screenshot the placement flow uploads. PDFs/plaintext become
 * `document` blocks. The mime type comes from the Files API metadata; a failed
 * lookup falls back to `document`.
 */
async function normalizeMessages(
  raw: unknown,
  fileIds: unknown,
  env: Env,
): Promise<{ messages: MessageParam[]; fileBlockCount: number }> {
  if (!Array.isArray(raw)) return { messages: [], fileBlockCount: 0 };
  const messages: MessageParam[] = (raw as Array<{ role?: unknown; content?: unknown }>)
    .filter(
      (message) =>
        !!message &&
        (message.role === 'user' || message.role === 'assistant') &&
        message.content != null,
    )
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content as string | ContentBlock[],
    }));

  let fileBlockCount = 0;
  const first = messages[0];
  if (Array.isArray(fileIds) && fileIds.length > 0 && first) {
    const fileBlocks = await Promise.all(
      (fileIds as unknown[]).map((id) => buildFileBlock(String(id), env)),
    );
    // Cache the stable file prefix: one breakpoint on the last file block caches
    // all file blocks before it (prefix match). 1h TTL — reused across a page's
    // placement calls, which can be minutes apart.
    const lastFileBlock = fileBlocks[fileBlocks.length - 1];
    if (lastFileBlock) {
      lastFileBlock.cache_control = { ...EXTENDED_CACHE_CONTROL };
    }
    fileBlockCount = fileBlocks.length;

    const existing: ContentBlock[] = Array.isArray(first.content)
      ? first.content
      : [{ type: 'text', text: String(first.content) }];
    first.content = [...fileBlocks, ...existing];
  }

  return { messages, fileBlockCount };
}

/**
 * Build the content block for one uploaded fileId, choosing `image` vs
 * `document` from the file's mime type (Files API metadata). Images must be
 * `image` blocks; everything else is a `document` block. A metadata-lookup
 * failure falls back to `document`.
 */
async function buildFileBlock(fileId: string, env: Env): Promise<FileBlock> {
  let isImage = false;
  try {
    const response = await getFileMetadata(fileId, env);
    if (response.ok) {
      const meta = (await response.json()) as { mime_type?: unknown };
      isImage = typeof meta.mime_type === 'string' && meta.mime_type.startsWith('image/');
    }
  } catch {
    // fall back to document
  }
  return {
    type: isImage ? 'image' : 'document',
    source: { type: 'file', file_id: fileId },
  };
}

interface AgentLoopParams {
  env: Env;
  toolsets: ToolsetComposition;
  model: string;
  maxTokens: number;
  system: TextBlock[];
  messages: MessageParam[];
  tools: ToolDefinition[] | undefined;
  effort: Effort | undefined;
  fileBlockCount?: number;
  refs?: readonly EntityReference[];
  /** CLIENT-tool mode (a `clientTools` prompt): on a tool_use, return the calls
   *  in `done.toolCalls` and stop — the client executes them, never the worker. */
  clientToolMode?: boolean;
  /** Structured trace routed by the deployment's TRACE-level sink configuration. */
  trace: DevelopmentInferenceTrace;
  logger: Logger;
}

/**
 * The core agent loop. `emit` is an async callback receiving our SSE events
 * `{ type, data }`. Returns the terminal `done` payload. Runs the Anthropic
 * model with streaming; on a `tool_use` stop it executes the tool(s) through
 * the composed toolsets and loops, up to MAX_ITERATIONS.
 */
async function runAgentLoop(
  {
    env,
    toolsets,
    model,
    maxTokens,
    system,
    messages,
    tools,
    effort,
    fileBlockCount = 0,
    refs = [],
    clientToolMode = false,
    trace,
    logger,
  }: AgentLoopParams,
  emit: Emit | null,
): Promise<DonePayload> {
  const conversation: MessageParam[] = [...messages];
  let fullText = '';
  let usage: Usage | null = null;
  let stopReason: string | null = null;
  let iterations = 0;

  // Breakpoint budget (≤4 total). System base block holds 1. When a placement
  // file prefix is present it holds 1 more (its own 1h breakpoint, set in
  // normalizeMessages and reserved across iterations), leaving 2 for the
  // conversation; otherwise the conversation gets the usual 3.
  const conversationBreakpoints = fileBlockCount > 0 ? 2 : 3;

  for (iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    // Place cache breakpoints on the growing conversation turns (re-stripped +
    // re-applied each iteration so they never accumulate past the 4-block cap).
    // The file prefix's 1h breakpoint is reserved (not stripped, not counted).
    applyConversationBreakpoints(conversation, {
      maxBreakpoints: conversationBreakpoints,
      reservedHeadBlocks: fileBlockCount,
    });

    const payload: MessagesPayload = {
      model,
      max_tokens: maxTokens,
      system,
      messages: conversation,
    };
    if (tools && tools.length > 0) payload.tools = tools;
    // Effort is a real token-saving lever, but only valid on models that
    // support it — attaching it to a model that doesn't (e.g. Haiku 4.5) returns
    // a 400. Gate on the model's capability so unsupported models simply omit it.
    if (effort && supportsEffort(model)) payload.output_config = { effort };

    trace.record('request.forwarded', {
      iteration: iterations,
      model,
      maxTokens,
      outputConfig: payload.output_config,
      system: traceableSystem(system),
      messages: traceableMessages(payload),
      tools: tools?.map((tool) => tool.name),
    });

    const turn = await streamAnthropicTurn(payload, env, emit);
    trace.record('response.received', {
      iteration: iterations,
      stopReason: turn.stopReason,
      usage: turn.usage,
      content: traceableContent(turn.content),
    });
    // Observe cache effectiveness per model turn (docs/CACHING): each streamed
    // turn reports its own usage, so a multi-turn tool loop logs one line per
    // model call — mirrors the /messages `logUsageStats` format.
    logUsageStats(turn.usage, logger);
    usage = turn.usage || usage;
    stopReason = turn.stopReason;
    if (turn.text) fullText += (fullText ? '\n' : '') + turn.text;

    // Append the assistant turn (text + any tool_use blocks) to the conversation.
    conversation.push({ role: 'assistant', content: turn.content });

    if (turn.stopReason !== 'tool_use' || turn.toolUses.length === 0) {
      break; // natural end (or max_tokens / refusal) — done.
    }

    // CLIENT-tool mode: the tools execute in the browser (the iframe is the AI's
    // hands), NOT here. Hand the model's tool-calls to the client in
    // `done.toolCalls` and stop this turn — the client runs them against the live
    // store, appends the tool_result turn, and calls /chat again to continue the
    // loop. The worker never touches the store. (See lib ai/ONBOARDING-CONTRACT.md
    // + the lib look-at-page executor, which drives this iteration client-side.)
    if (clientToolMode) {
      const toolCalls = turn.toolUses.map((toolUse) => ({
        id: toolUse.id as string,
        name: toolUse.name as string,
        input: toolUse.input,
      }));
      if (emit) {
        for (const call of toolCalls) {
          await emit({ type: 'tool_call', data: call });
        }
      }
      trace.record('client_tools.returned', { iteration: iterations, toolCalls });
      return { text: fullText, stopReason: 'tool_use', iterations, usage, toolCalls };
    }

    // Execute every tool the model requested; collect tool_result blocks.
    const toolResults: ContentBlock[] = [];
    for (const toolUse of turn.toolUses) {
      if (emit) {
        await emit({
          type: 'tool_call',
          data: { id: toolUse.id, name: toolUse.name, input: toolUse.input },
        });
      }
      // Anthropic's tool_use blocks always carry a name; the composition
      // degrades an unknown/absent one to the Unknown-tool shape regardless.
      const exec = await toolsets.execute(toolUse.name as string, toolUse.input, { refs });
      if (!exec.ok) {
        logger.error('Tool execution failed', exec.result, {
          iteration: iterations,
          toolName: toolUse.name,
          toolInput: toolUse.input,
          summary: exec.summary,
        });
      }
      trace.record('tool.executed', {
        iteration: iterations,
        name: toolUse.name,
        input: toolUse.input,
        ok: exec.ok,
        summary: exec.summary,
        result: exec.result,
      });
      if (emit) {
        await emit({
          type: 'tool_result',
          data: {
            id: toolUse.id,
            name: toolUse.name,
            ok: exec.ok,
            summary: exec.summary,
            ...(exec.ok ? {} : { error: exec.result.error }),
          },
        });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(exec.result),
        is_error: !exec.ok,
      });
    }
    conversation.push({ role: 'user', content: toolResults });
    // loop continues — model sees the tool results next iteration.
  }

  if (stopReason === 'tool_use') {
    // Hit the iteration cap mid-tool-loop.
    stopReason = 'max_iterations';
  }

  // The `for` increments past the cap on the exit check — report the real count.
  const ranIterations = Math.min(iterations, MAX_ITERATIONS);

  return { text: fullText, stopReason, iterations: ranIterations, usage };
}

/**
 * Log token-usage stats with cache-hit/creation markers for one model turn.
 * Same format + logger convention as /messages (`logUsageStats` in
 * messages.ts) so a single tail grep spans both surfaces. Token counts only —
 * no PII, no prompt bodies (docs/TOOLSETS.md → security standards).
 */
function logUsageStats(usage: Usage | null | undefined, log: Logger): void {
  if (!usage) {
    return;
  }
  log.info(
    `Tokens — input: ${usage.input_tokens}, cache_creation: ${usage.cache_creation_input_tokens || 0}, cache_read: ${usage.cache_read_input_tokens || 0}, output: ${usage.output_tokens}`,
  );
}

/** One accumulated Anthropic turn (finalized content + extracted tool uses). */
interface AnthropicTurn {
  content: ContentBlock[];
  text: string;
  toolUses: ToolUseBlock[];
  stopReason: string | null;
  usage: Usage | null;
}

/** The Anthropic streaming events this worker consumes (narrow parse view). */
interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: Usage;
  message?: { usage?: Usage };
  error?: { message?: string };
}

/** Per-index accumulator for one streamed content block. */
interface PendingBlock {
  type: string;
  text?: string;
  id?: string | undefined;
  name?: string | undefined;
  inputJson?: string;
}

/**
 * Stream a single Anthropic turn. Parses Anthropic's SSE, re-emits text deltas
 * as our `text` events, and accumulates the assistant content blocks (text +
 * tool_use).
 */
async function streamAnthropicTurn(
  payload: MessagesPayload,
  env: Env,
  emit: Emit | null,
): Promise<AnthropicTurn> {
  const response = await streamMessage(payload, env);

  if (!response.ok || !response.body) {
    const errBody = await response.text().catch(() => '');
    throw new WorkerError(`Anthropic request failed (${response.status})`, {
      status: response.status,
      exceptionType: 'AnthropicApiException',
      ...(errBody ? { messageDetail: errBody } : {}),
    });
  }

  const blocks: PendingBlock[] = [];
  let stopReason: string | null = null;
  let usage: Usage | null = null;
  let text = '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Anthropic SSE: lines of `event: <type>` then `data: <json>`, blank-separated.
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json) continue;

      let evt: AnthropicStreamEvent;
      try {
        evt = JSON.parse(json) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      switch (evt.type) {
        case 'content_block_start': {
          if (evt.index === undefined) break;
          const cb = evt.content_block || {};
          if (cb.type === 'text') {
            blocks[evt.index] = { type: 'text', text: '' };
          } else if (cb.type === 'tool_use') {
            blocks[evt.index] = { type: 'tool_use', id: cb.id, name: cb.name, inputJson: '' };
          } else {
            blocks[evt.index] = { type: cb.type || 'unknown' };
          }
          break;
        }
        case 'content_block_delta': {
          if (evt.index === undefined) break;
          const delta = evt.delta || {};
          const block = blocks[evt.index];
          if (!block) break;
          if (delta.type === 'text_delta') {
            block.text = (block.text || '') + (delta.text ?? '');
            text += delta.text ?? '';
            if (emit) await emit({ type: 'text', data: { delta: delta.text } });
          } else if (delta.type === 'input_json_delta') {
            block.inputJson = (block.inputJson || '') + (delta.partial_json || '');
          }
          break;
        }
        case 'message_delta': {
          if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;
          if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
          break;
        }
        case 'message_start': {
          if (evt.message && evt.message.usage) usage = { ...evt.message.usage };
          break;
        }
        case 'error': {
          throw new WorkerError(`Anthropic stream error: ${evt.error?.message || 'unknown'}`, {
            exceptionType: 'AnthropicApiException',
          });
        }
        default:
          break;
      }
    }
  }

  // Finalize blocks into Anthropic content + extract tool_use blocks.
  const content: ContentBlock[] = [];
  const toolUses: ToolUseBlock[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'tool_use') {
      let input: unknown = {};
      try {
        input = block.inputJson ? (JSON.parse(block.inputJson) as unknown) : {};
      } catch {
        input = {};
      }
      content.push({ type: 'tool_use', id: block.id, name: block.name, input });
      toolUses.push({ type: 'tool_use', id: block.id, name: block.name, input });
    }
  }

  return { content, text, toolUses, stopReason, usage };
}

/** Build a streaming SSE Response that drives the agent loop. */
function streamResponse(
  runner: (emit: Emit) => Promise<DonePayload>,
  corsHeaders: CorsHeaders,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = ({ type, data }) => {
        controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        const done = await runner(emit);
        await emit({ type: 'done', data: done });
      } catch (error) {
        // SSE error events carry the same Brain-shaped payload as HTTP error
        // bodies, so clients keep one parser.
        await emit({ type: 'error', data: errorEnvelopeFrom(error, 'Internal error') });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

/** Build a non-streaming JSON Response (same final payload as the `done` event). */
async function jsonRunnerResponse(
  runner: (emit: null) => Promise<DonePayload>,
  corsHeaders: CorsHeaders,
): Promise<Response> {
  try {
    const done = await runner(null);
    return new Response(JSON.stringify(done), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return errorResponseFrom(error, corsHeaders, 'Internal error');
  }
}

/** Early bad-request helper — SSE error event or JSON, matching the request's Accept. */
function badRequest(message: string, corsHeaders: CorsHeaders, wantsStream: boolean): Response {
  const payload = errorPayload(message, 'ArgumentException');
  if (wantsStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream; charset=utf-8' },
    });
  }
  return new Response(JSON.stringify(payload), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
