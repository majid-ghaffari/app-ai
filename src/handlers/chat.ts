/**
 * POST /chat — Studio AI chat agent loop + SSE streaming.
 *
 * (see lib CONTRACTS.md §1). The client sends a system-prompt selector (header),
 * a message history, and optional grounding context — including `context.refs`
 * (entity references, cap 5) rendered as the eager Referenced-Entities system
 * block (lib/references.ts) and threaded into the agent loop for the
 * `get_entity_context` tool's analytics dispatch. We run the resolved model
 * through the provider-neutral tool-use agent loop:
 *
 *   model → (tool_use?) → execute tool (owning toolset) → tool_result → model → …
 *
 * bounded by MAX_ITERATIONS, streaming text out as it arrives. Two response
 * shapes, picked by the client's Accept header:
 *   • Accept: text/event-stream  → our SSE protocol (text/tool_call/tool_result/done/error)
 *   • otherwise                  → a single JSON object identical to the `done` payload
 *
 * Provider credentials never leave their adapter.
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

import {
  getFilePolicy,
  getModelProfile,
  getSystemPrompt,
  isPromptName,
  type SystemPromptEntry,
} from '../prompt-registry';
import { composeToolsets } from '../toolsets/registry';
import type { IntegrationParty } from '../toolsets/integration-party';
import {
  errorPayload,
  errorEnvelopeFrom,
  errorResponseFrom,
  type CorsHeaders,
} from '../lib/responses';
import type {
  AgentRequest,
  AgentResult,
  CacheIntent,
  CanonicalClientToolDefinition,
  InferenceContent,
  InferenceEvent,
  InferenceMessage,
  InferenceToolCall,
  InferenceUsage,
  FilePolicy,
  ModelProfile,
} from '../lib/inference-types';
import { sanitizeRefs, buildReferencedEntitiesBlock } from '../lib/references';
import { createLoggingRuntime, type Logger, type LoggingRuntime } from '../lib/logger';
import {
  createDevelopmentInferenceTrace,
  redactInferenceTraceValue,
} from '../lib/dev-inference-trace';
import {
  createInferenceFileService,
  createInferenceService,
  isRequiredContinuationMissing,
  requiresOrdinaryTurnContinuation,
} from '../inference/factory';
import { InferenceFailure, inferenceFailureTrace } from '../inference/adapter';
import {
  decodeOpaqueContinuation,
  encodeOpaqueContinuation,
  preflightContinuationSealing,
  type ContinuationRoute,
} from '../inference/continuation';
import { reconstructCompatibilityProviderState } from '../inference/messages-compatibility';
import { fileTenantScope, resolveOpaqueFileReference } from '../inference/file-references';
import type { Env } from '../config';

/** Hard cap on model↔tool iterations (CONTRACTS.md §1). */
const MAX_ITERATIONS = 8;

/** The client-supplied /chat request body (validated at each point of use). */
interface ChatRequestBody {
  messages?: unknown;
  context?: ChatContext;
  /**
   * Accepted for backward compatibility but IGNORED: the registry is
   * authoritative for a registered prompt's output budget (the resolved entry's
   * `maxTokens` is used exactly). A client-sent value does not override it.
   */
  max_tokens?: number;
  fileIds?: unknown;
  /** Opaque token returned with a browser-owned tool call and echoed on continuation. */
  continuation?: unknown;
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
  usage: PublicUsage | null;
  /**
   * CLIENT tool-calls the model requested this turn (only for a `clientTools`
   * prompt — e.g. `onboarding-chat`'s `look_at_page`). When present, the worker
   * did NOT execute them: the client runs them in the store iframe, appends the
   * `tool_result` turn (e.g. the captured screenshot), and calls `/chat` again to
   * continue. Absent for server-tool / no-tool prompts.
   */
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  continuation?: string;
}

/** The usage shape the public `/chat` payload carries, projected from canonical accounting. */
interface PublicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [member: string]: unknown;
}

/**
 * Handle POST /chat. The context-ID is already validated by the router, which
 * also threads the subscriber's available IntegrationParty and version-gated
 * AI-tool sets from the same validate-context-id call for dynamic toolset
 * composition. Returns a streaming `Response` (SSE) or a JSON `Response`.
 */
export async function handleChat(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
  availableParties: readonly IntegrationParty[] = [],
  availableAiTools: readonly string[] = [],
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

  // The registry is the single source of truth for per-prompt model / token /
  // tool choices. Unknown selectors retain the compatibility fallback to chat,
  // while a known prompt with missing configuration fails closed. Every
  // resolution that can reject the route — an unclaimed model id, a capability
  // the group requires, an override that moves the prompt off its shared file
  // route, an absent binding, a provider no adapter serves — happens inside
  // this one guard, so a rejection reaches the caller in the shape its Accept
  // header asked for (an SSE `error` event or the JSON envelope) rather than
  // escaping to the router's Accept-blind catch.
  let entry: SystemPromptEntry;
  let profile: ModelProfile;
  let filePolicy: FilePolicy;
  let ordinaryTurnContinuationRequired: boolean;
  try {
    entry = getSystemPrompt(isPromptName(systemPromptName) ? systemPromptName : 'chat', env);
    profile = getModelProfile(entry.name, env);
    filePolicy = getFilePolicy(entry.filePolicy);
    ordinaryTurnContinuationRequired = requiresOrdinaryTurnContinuation(profile, env);
  } catch (error) {
    trace.record('request.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return earlyError(error, corsHeaders, wantsStream);
  }

  let tenantScope: string | null;
  try {
    tenantScope = await fileTenantScope(contextId, env);
  } catch (error) {
    return earlyError(error, corsHeaders, wantsStream);
  }
  const continuationRoute =
    tenantScope === null
      ? null
      : ({
          tenantScope,
          promptGroup: entry.group,
          modelProfile: profile.name,
        } satisfies ContinuationRoute);
  if (ordinaryTurnContinuationRequired) {
    if (!continuationRoute) {
      return badRequest(
        'Inference continuation requires a validated tenant',
        corsHeaders,
        wantsStream,
      );
    }
    try {
      await preflightContinuationSealing(env);
    } catch (error) {
      return earlyError(error, corsHeaders, wantsStream);
    }
  }
  let continuation: Awaited<ReturnType<typeof decodeOpaqueContinuation>> | undefined;
  if (body.continuation !== undefined) {
    if (typeof body.continuation !== 'string') {
      return badRequest('continuation must be an opaque string', corsHeaders, wantsStream);
    }
    try {
      await preflightContinuationSealing(env);
    } catch (error) {
      return earlyError(error, corsHeaders, wantsStream);
    }
    try {
      if (!continuationRoute) throw new Error('Continuation requires a validated tenant');
      continuation = await decodeOpaqueContinuation(body.continuation, continuationRoute, env);
    } catch {
      return badRequest('Invalid inference continuation token', corsHeaders, wantsStream);
    }
    if (continuation.backend !== profile.provider) {
      return badRequest(
        'Inference continuation does not belong to the selected prompt route',
        corsHeaders,
        wantsStream,
      );
    }
  }
  if (isRequiredContinuationMissing(profile, env, body.messages, continuation)) {
    return badRequest(
      'Assistant history requires an inference continuation token',
      corsHeaders,
      wantsStream,
    );
  }
  let messages: InferenceMessage[];
  try {
    messages = await normalizeMessages(
      body.messages,
      body.fileIds,
      profile,
      filePolicy,
      entry.group,
      tenantScope,
      env,
      request.signal,
    );
  } catch (error) {
    trace.record('request.failed', inferenceFailureTrace(error));
    log.error('Chat request preparation failed', error, {
      inference: redactInferenceTraceValue(inferenceFailureTrace(error)),
    });
    return earlyError(error, corsHeaders, wantsStream);
  }
  if (messages.length === 0) {
    return badRequest('messages must be a non-empty array', corsHeaders, wantsStream);
  }

  // Referencing: `context.refs` (EntityReference[], cap 5 — lib CONTRACTS.md §1)
  // is sanitized, eagerly prefetched (record refs → Personalizer entity-context,
  // analytics refs → their own metadata, no Personalizer call), and rendered as the
  // Referenced-Entities block. `buildReferencedEntitiesBlock` never throws —
  // a failed ref degrades to a "(could not load)" line.
  const refs = sanitizeRefs(body.context?.refs);
  const referencedEntitiesBlock =
    refs.length > 0 ? await buildReferencedEntitiesBlock(refs, contextId, env) : null;

  const systemMessages = buildSystem(body.context, referencedEntitiesBlock);
  // The registry is authoritative for a registered prompt's output budget — an
  // unknown selector already fell back to the `chat` entry above, so `entry` is
  // always a registered entry. Use its `maxTokens` EXACTLY (no client override):
  // changing the registry literal changes the outgoing request one-for-one.
  // The endpoint's whole tool surface is composed from the subscriber's
  // integration parties and supported-contract AI-tool names. Per-toolset
  // credentials resolve inside the composition — never in the loop.
  const toolsets = composeToolsets(availableParties, { contextId, env }, availableAiTools, log);
  // A `clientTools` prompt (onboarding-chat) drives tools that run in the
  // browser, not the worker. Send ITS definitions to the model (in place of the
  // server toolset) and run the loop in CLIENT-tool mode: on a tool_use the loop
  // returns the calls to the client in `done.toolCalls` and stops — it never
  // executes them here. Otherwise the usual server toolset (when `usesTools`).
  const inference = createInferenceService(env, tenantScope);
  const runner = (emit: Emit | null) => {
    const onEvent = async (event: InferenceEvent): Promise<void> => {
      if (event.type === 'agent-turn-start') {
        trace.record('request.forwarded', {
          iteration: event.iteration,
          group: entry.group,
          modelProfile: entry.modelProfile,
          provider: entry.provider,
          apiFamily: entry.apiFamily,
          maxTokens: entry.maxTokens,
          effort: entry.effort,
          prompt: event.request.prompt,
          messages: canonicalTraceMessages(event.request.messages),
        });
      } else if (event.type === 'text-delta' && emit) {
        await emit({ type: 'text', data: { delta: event.delta } });
      } else if (event.type === 'tool-call' && emit) {
        await emit({
          type: 'tool_call',
          data: { id: event.call.id, name: event.call.name, input: event.call.input },
        });
      } else if (event.type === 'complete') {
        logUsageStats(event.result.usage, log);
        trace.record('response.received', {
          stopReason: event.result.stopReason,
          usage: event.result.usage,
          content: canonicalTraceContent(event.result.content),
        });
      }
    };

    const common = {
      prompt: entry.prompt,
      promptGroup: entry.group,
      modelProfile: profile,
      filePolicy,
      messages: [...systemMessages, ...messages],
      maxOutputTokens: entry.maxTokens,
      maxIterations: MAX_ITERATIONS,
      abortSignal: request.signal,
      ...(continuation ? { continuation } : {}),
      ...(entry.effort ? { effort: entry.effort } : {}),
      onEvent,
    };
    let agentRequest: AgentRequest;
    if (entry.clientTools) {
      agentRequest = {
        ...common,
        mode: 'client',
        tools: requireClientTools(entry.clientTools),
      };
    } else if (entry.usesTools) {
      agentRequest = {
        ...common,
        mode: 'server',
        tools: toolsets.definitions,
        async executeTool(call: InferenceToolCall) {
          const execution = await toolsets.execute(call.name, call.input, { refs });
          if (!execution.ok) {
            log.error('Tool execution failed', redactInferenceTraceValue(execution.result), {
              toolName: call.name,
              toolInput: redactInferenceTraceValue(call.input),
              summary: execution.summary,
            });
          }
          trace.record('tool.executed', {
            name: call.name,
            input: redactInferenceTraceValue(call.input),
            ok: execution.ok,
            summary: execution.summary,
            result: redactInferenceTraceValue(execution.result),
          });
          if (emit) {
            await emit({
              type: 'tool_result',
              data: {
                id: call.id,
                name: call.name,
                ok: execution.ok,
                summary: execution.summary,
                ...(execution.ok ? {} : { error: execution.result.error }),
              },
            });
          }
          return {
            type: 'tool-result',
            toolCallId: call.id,
            content: [
              { type: 'text', text: JSON.stringify(execution.result), cache: 'none' },
              ...(execution.ok && execution.notice
                ? [{ type: 'text' as const, text: execution.notice, cache: 'none' as const }]
                : []),
            ],
            isError: !execution.ok,
            cache: 'none',
          };
        },
      };
    } else {
      agentRequest = { ...common, mode: 'none', tools: [] };
    }

    return inference
      .runAgent(agentRequest)
      .then((result) => toDonePayload(result, continuationRoute, env))
      .then((done) => {
        trace.record('request.completed', {
          ...done,
          ...(done.toolCalls
            ? {
                toolCalls: done.toolCalls.map((call) => ({
                  ...call,
                  input: redactInferenceTraceValue(call.input),
                })),
              }
            : {}),
        });
        return done;
      })
      .catch((error: unknown) => {
        trace.record('request.failed', inferenceFailureTrace(error));
        log.error('Chat request failed', error, {
          inference: redactInferenceTraceValue(inferenceFailureTrace(error)),
        });
        throw error;
      });
  };

  if (wantsStream) {
    return streamResponse(runner, corsHeaders);
  }
  return jsonRunnerResponse(runner, corsHeaders);
}

/**
 * Build canonical volatile system messages from grounding and references. The
 * stable registry prompt remains `InferenceRequest.prompt`; the adapter realizes
 * its provider-specific cache breakpoint.
 */
export function buildSystem(
  context: ChatContext | undefined,
  referencedEntitiesBlock: string | null = null,
): InferenceMessage[] {
  const content: InferenceContent[] = [];
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
      content.push({ type: 'text', text: lines.join('\n'), cache: 'none' });
    }
  }

  // Referenced-Entities: always the FINAL system block, always uncached (it
  // changes per call — see lib/references.ts for the frozen block format).
  if (referencedEntitiesBlock) {
    content.push({ type: 'text', text: referencedEntitiesBlock, cache: 'none' });
  }
  return content.length > 0 ? [{ role: 'system', content }] : [];
}

/**
 * Normalize the client message history into canonical messages. Optionally
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
 * the canonical allocator in `DefaultInferenceService.runAgent`). The file prefix consumes
 * exactly ONE breakpoint regardless of how many `fileIds` are passed (only the
 * last block is marked), so the ≤4 budget is independent of the file count.
 * Each fileId is resolved through the routed file service to the correct content type:
 * images (`image/*`) MUST be `image` blocks — Anthropic rejects an image inside
 * a `document` block ("Only PDF and plaintext documents are supported"), which
 * is exactly the screenshot the placement flow uploads. PDFs/plaintext become
 * `document` blocks. The mime type comes from the Files API metadata; a failed
 * lookup falls back to `document`.
 */
async function normalizeMessages(
  raw: unknown,
  fileIds: unknown,
  profile: ModelProfile,
  filePolicy: FilePolicy,
  promptGroup: string,
  tenantScope: string | null,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<InferenceMessage[]> {
  if (!Array.isArray(raw)) return [];
  const messages: InferenceMessage[] = (raw as Array<{ role?: unknown; content?: unknown }>)
    .filter(
      (message) =>
        !!message &&
        (message.role === 'user' || message.role === 'assistant') &&
        message.content != null,
    )
    .map((message) => {
      const role = message.role as 'user' | 'assistant';
      const providerState = reconstructCompatibilityProviderState(
        role,
        message.content,
        profile.provider,
      );
      return {
        role,
        content: normalizeClientContent(message.content),
        ...(providerState ? { providerState } : {}),
      };
    });

  const first = messages[0];
  if (Array.isArray(fileIds) && fileIds.length > 0 && first) {
    const files = createInferenceFileService(env);
    const fileBlocks = await Promise.all(
      (fileIds as unknown[]).map((id) =>
        buildFileContent(
          String(id),
          profile,
          filePolicy,
          promptGroup,
          files,
          tenantScope,
          env,
          abortSignal,
        ),
      ),
    );
    // Cache the stable file prefix: one breakpoint on the last file block caches
    // all file blocks before it (prefix match). 1h TTL — reused across a page's
    // placement calls, which can be minutes apart.
    const lastFileBlock = fileBlocks[fileBlocks.length - 1];
    if (lastFileBlock) {
      setCache(lastFileBlock, 'extended');
    }
    messages[0] = { ...first, content: [...fileBlocks, ...first.content] };
  }
  return messages;
}

/**
 * Build the content block for one uploaded fileId, choosing `image` vs
 * `document` from the file's mime type (Files API metadata). Images must be
 * `image` blocks; everything else is a `document` block. A metadata-lookup
 * failure falls back to `document`.
 */
async function buildFileContent(
  fileId: string,
  profile: ModelProfile,
  filePolicy: FilePolicy,
  promptGroup: string,
  files: ReturnType<typeof createInferenceFileService>,
  tenantScope: string | null,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<InferenceContent> {
  const reference = await resolveOpaqueFileReference(
    { id: fileId, type: 'file' },
    { promptGroup, modelProfile: profile, filePolicy },
    env,
    files,
    tenantScope,
  );
  let mediaType = reference.mediaType;
  try {
    if (mediaType === null) {
      const metadata = await files.getMetadata(profile, reference.upstreamFileId, abortSignal);
      mediaType = metadata?.mediaType ?? null;
    }
  } catch (error) {
    if (error instanceof InferenceFailure && error.inferenceError.failureClass === 'cancelled') {
      throw error;
    }
    // fall back to document
  }
  return {
    type: mediaType?.startsWith('image/') ? 'image' : 'document',
    source: { type: 'provider-file', reference },
    cache: 'none',
  };
}

function normalizeClientContent(raw: unknown): InferenceContent[] {
  if (typeof raw === 'string') return [{ type: 'text', text: raw, cache: 'none' }];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): InferenceContent[] => {
    if (!item || typeof item !== 'object') return [];
    const block = item as Record<string, unknown>;
    const cache: CacheIntent = 'none';
    if (block.type === 'text') {
      return [{ type: 'text', text: typeof block.text === 'string' ? block.text : '', cache }];
    }
    if (block.type === 'image' || block.type === 'document') {
      const media = normalizeClientMedia(block.type, block);
      return media ? [media] : [];
    }
    if (block.type === 'tool_use') {
      return [
        {
          type: 'tool-call',
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          input: block.input,
          cache,
        },
      ];
    }
    if (block.type === 'tool_result') {
      return [
        {
          type: 'tool-result',
          toolCallId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: normalizeToolResultContent(block.content),
          isError: block.is_error === true,
          cache,
        },
      ];
    }
    return [];
  });
}

function normalizeToolResultContent(
  raw: unknown,
): Array<Extract<InferenceContent, { type: 'text' | 'image' | 'document' }>> {
  if (typeof raw === 'string') return [{ type: 'text', text: raw, cache: 'none' }];
  return normalizeClientContent(raw).filter(
    (content): content is Extract<InferenceContent, { type: 'text' | 'image' | 'document' }> =>
      content.type === 'text' || content.type === 'image' || content.type === 'document',
  );
}

function normalizeClientMedia(
  type: 'image' | 'document',
  raw: unknown,
): Extract<InferenceContent, { type: 'image' | 'document' }> | null {
  const block = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const source =
    block.source && typeof block.source === 'object'
      ? (block.source as Record<string, unknown>)
      : {};
  const documentFields =
    type === 'document'
      ? {
          ...(typeof block.title === 'string' ? { title: block.title } : {}),
          ...(typeof block.context === 'string' ? { context: block.context } : {}),
          ...(block.citations &&
          typeof block.citations === 'object' &&
          (block.citations as Record<string, unknown>).enabled === true
            ? { citations: { enabled: true } }
            : {}),
        }
      : {};
  if (source.type === 'file' && typeof source.file_id === 'string') {
    return {
      type,
      source: { type: 'file', reference: { id: source.file_id, type: 'file' } },
      ...documentFields,
      cache: 'none',
    };
  }
  if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return {
      type,
      source: { type: 'base64', mediaType: source.media_type, data: source.data },
      ...documentFields,
      cache: 'none',
    };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return {
      type,
      source: { type: 'url', url: source.url },
      ...documentFields,
      cache: 'none',
    };
  }
  if (
    type === 'document' &&
    source.type === 'text' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return {
      type,
      source: { type: 'text', mediaType: source.media_type, text: source.data },
      ...documentFields,
      cache: 'none',
    };
  }
  if (type === 'document' && source.type === 'content' && typeof source.content === 'string') {
    return {
      type,
      source: { type: 'content', content: source.content },
      ...documentFields,
      cache: 'none',
    };
  }
  if (type === 'document' && source.type === 'content' && Array.isArray(source.content)) {
    const content = source.content.flatMap(
      (item): Array<Extract<InferenceContent, { type: 'text' | 'image' }>> => {
        if (!item || typeof item !== 'object') return [];
        const nested = item as Record<string, unknown>;
        if (nested.type === 'image') {
          const image = normalizeClientMedia('image', nested);
          return image?.type === 'image' ? [image] : [];
        }
        if (nested.type !== 'text' || typeof nested.text !== 'string') return [];
        return [
          {
            type: 'text' as const,
            text: nested.text,
            ...(Array.isArray(nested.citations)
              ? {
                  citations: nested.citations as readonly Readonly<Record<string, unknown>>[],
                }
              : {}),
            cache: cacheIntentFromWire(nested.cache_control),
          },
        ];
      },
    );
    if (content.length !== source.content.length) return null;
    return {
      type,
      source: { type: 'content', content },
      ...documentFields,
      cache: 'none',
    };
  }
  return null;
}

function setCache(content: InferenceContent, cache: CacheIntent): void {
  (content as { cache: CacheIntent }).cache = cache;
}

function cacheIntentFromWire(raw: unknown): CacheIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'none';
  const control = raw as Record<string, unknown>;
  if (control.type !== 'ephemeral') return 'none';
  return control.ttl === '1h' ? 'extended' : 'short';
}

function requireClientTools(
  tools: NonNullable<SystemPromptEntry['clientTools']>,
): readonly CanonicalClientToolDefinition[] {
  if (tools.some((tool) => tool.execution !== 'client')) {
    throw new Error('Client-tool prompt contains a server tool');
  }
  return tools as readonly CanonicalClientToolDefinition[];
}

/** Serialize the shared agent result into the established public `/chat` terminal payload. */
export async function toDonePayload(
  result: AgentResult,
  route: ContinuationRoute | null,
  env: Env,
): Promise<DonePayload> {
  if (
    result.providerState &&
    route === null &&
    (result.toolCalls.length > 0 || result.providerState.requiredOnNextTurn === true)
  ) {
    throw new Error('Inference continuation requires a validated tenant');
  }
  const toolCalls = result.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    input: call.input,
  }));
  return {
    text: result.text,
    stopReason:
      result.stopReason === 'max-iterations'
        ? 'max_iterations'
        : (result.providerStopReason ?? publicStopReason(result.stopReason)),
    iterations: result.iterations,
    usage: publicUsage(result.usage),
    ...(result.providerState &&
    route &&
    (toolCalls.length > 0 || result.providerState.requiredOnNextTurn === true)
      ? { continuation: await encodeOpaqueContinuation(result.providerState, route, env) }
      : {}),
    ...(toolCalls.length > 0
      ? {
          toolCalls,
        }
      : {}),
  };
}

function publicStopReason(reason: AgentResult['stopReason']): string | null {
  if (reason === 'completed') return 'end_turn';
  if (reason === 'max-output-tokens') return 'max_tokens';
  if (reason === 'tool-call') return 'tool_use';
  if (reason === 'max-iterations') return 'max_iterations';
  if (reason === 'content-filter') return 'refusal';
  if (reason === 'cancelled') return 'cancelled';
  return reason === 'unknown' ? null : reason;
}

function publicUsage(usage: InferenceUsage): PublicUsage | null {
  if (usage.providerDetails) return { ...usage.providerDetails };
  if (
    usage.inputTokens === null &&
    usage.outputTokens === null &&
    usage.cacheWriteInputTokens === null &&
    usage.cachedInputTokens === null
  ) {
    return null;
  }
  return {
    ...(usage.inputTokens !== null ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== null ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.cacheWriteInputTokens !== null
      ? { cache_creation_input_tokens: usage.cacheWriteInputTokens }
      : {}),
    ...(usage.cachedInputTokens !== null
      ? { cache_read_input_tokens: usage.cachedInputTokens }
      : {}),
  };
}

function canonicalTraceContent(content: readonly InferenceContent[]): unknown {
  return content.map((item) => {
    if (item.type === 'text') return { type: 'text', text: item.text };
    if (item.type === 'tool-call') {
      return {
        type: 'tool-call',
        name: item.name,
        input: redactInferenceTraceValue(item.input),
      };
    }
    if (item.type === 'tool-result') {
      return {
        type: 'tool-result',
        isError: item.isError,
        content: canonicalTraceContent(item.content),
      };
    }
    return { type: item.type, source: item.source.type };
  });
}

function canonicalTraceMessages(messages: readonly InferenceMessage[]): unknown {
  return messages.map((message) => ({
    role: message.role,
    content: canonicalTraceContent(message.content),
  }));
}

function logUsageStats(usage: InferenceUsage, log: Logger): void {
  log.info(
    `Tokens — input: ${usage.inputTokens}, cache_creation: ${usage.cacheWriteInputTokens ?? 0}, cache_read: ${usage.cachedInputTokens ?? 0}, output: ${usage.outputTokens}`,
  );
}

/** Build a streaming SSE Response that drives the canonical agent loop. */

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

/** Early internal failure helper with the same JSON/SSE error-envelope contract. */
function earlyError(error: unknown, corsHeaders: CorsHeaders, wantsStream: boolean): Response {
  const payload = errorEnvelopeFrom(error, 'Internal error');
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
  return errorResponseFrom(error, corsHeaders, 'Internal error');
}
