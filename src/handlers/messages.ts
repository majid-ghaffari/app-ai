/**
 * POST /messages — registered prompt completion with the existing response
 * envelope. Registered requests are canonical and provider-routed internally;
 * absent/unknown selectors remain on a bounded Anthropic compatibility path.
 */

import {
  getModelProfile,
  getFilePolicy,
  getSystemPrompt,
  getUnregisteredMessagesRoute,
  isPromptName,
  type PromptAttachment,
  type SystemPromptEntry,
} from '../prompt-registry';
import type {
  InferenceContent,
  InferenceMessage,
  InferenceRequest,
  InferenceResult,
  InferenceUsage,
  SemanticEffort,
} from '../lib/inference-types';
import { getDefaultsBlock } from '../lib/brain-defaults';
import { dedupUpload } from '../lib/file-dedup';
import { jsonResponse, errorResponseFrom, WorkerError, type CorsHeaders } from '../lib/responses';
import { createLoggingRuntime, type Logger, type LoggingRuntime } from '../lib/logger';
import {
  createDevelopmentInferenceTrace,
  redactInferenceTraceValue,
} from '../lib/dev-inference-trace';
import {
  createInferenceDiagnosticsService,
  createInferenceFileService,
  createInferenceService,
  createUnregisteredSelectorPassthrough,
  isRequiredContinuationMissing,
  requiresOrdinaryTurnContinuation,
} from '../inference/factory';
import { allocateSingleTurnCache } from '../inference/cache';
import {
  hasProviderFileSource,
  parseCompatibilityMessages,
  parseCompatibilityToolChoice,
  parseCompatibilityTools,
  parseInferenceMetadata,
  parseSampling,
  parseServiceTier,
  parseStopSequences,
  parseStructuredOutput,
  messagesCompatibilityResponse,
} from '../inference/messages-compatibility';
import { InferenceFailure, inferenceFailureTrace } from '../inference/adapter';
import {
  decodeOpaqueContinuation,
  encodeOpaqueContinuation,
  preflightContinuationSealing,
  type ContinuationRoute,
} from '../inference/continuation';
import {
  GLOBAL_REGISTRY_ATTACHMENT_TENANT_SCOPE,
  fileTenantScope,
  resolveInferenceMessageFileReferences,
} from '../inference/file-references';
import type { Env } from '../config';

/** Advisory threshold; it changes only logging, never request acceptance. */
const LARGE_PAYLOAD_TOKEN_THRESHOLD = 100000;

/** Latency-critical visual calls never wait for advisory token counting. */
const NON_BLOCKING_VISUAL_PROMPTS = new Set([
  'onboarding-batch',
  'onboarding-batch-all',
  'onboarding-review',
  'onboarding-review-all',
  'onboarding-review-gate-all',
  'onboarding-css-review',
  'onboarding-currency-recovery',
  'cartdrawer-batch-all',
  'cartdrawer-review-all',
  'optimize-demand',
  'visual-verify',
]);

export async function handleMessages(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
  logging: LoggingRuntime = createLoggingRuntime(env),
  options: { readonly demo?: boolean; readonly tenantScope?: string } = {},
): Promise<Response> {
  const requestStartedAt = Date.now();
  const selector = request.headers.get('X-Personalizer-System-Prompt');
  const qcTelemetry = readQcTelemetry(request);
  const log = logging.logger('Messages', {
    prompt: selector,
    ...(qcTelemetry ? { qcAttempt: qcTelemetry.attempt, qcEscalated: qcTelemetry.escalated } : {}),
  });
  const trace = createDevelopmentInferenceTrace(
    logging.logger('InferenceTrace', { prompt: selector }),
    'messages',
    selector,
  );
  try {
    log.info('Request received');
    const body = (await request.json()) as Record<string, unknown>;
    const { apiKey: _apiKey, ...clientBody } = body;
    // Demo sessions carry a narrower server-owned request contract: only the
    // validated evidence messages survive. The registry supplies prompt, model,
    // budget, and effort, and caller-supplied tools or provider knobs never
    // reach the paid upstream API.
    const safeBody: Record<string, unknown> = options.demo
      ? { ...(clientBody.messages === undefined ? {} : { messages: clientBody.messages }) }
      : clientBody;

    if (!selector || !isPromptName(selector)) {
      // An unregistered selector is a bounded Anthropic-wire passthrough. The
      // caller owns its conversation; app-ai owns the model and output budget
      // (the registry's unregistered route replaces whatever the caller sent)
      // and the rule that no provider file id crosses this path: a raw id is
      // not tenant-bound, so a file block here is refused as client input.
      if (hasProviderFileSource(safeBody.messages)) {
        throw new WorkerError(
          'File blocks require a registered X-Personalizer-System-Prompt; upload through /files and reference the returned id under that prompt',
          { status: 400, exceptionType: 'ArgumentException' },
        );
      }
      const route = getUnregisteredMessagesRoute(env);
      const passthroughBody: Record<string, unknown> = {
        ...safeBody,
        model: route.model,
        max_tokens: route.maxTokens,
      };
      const passthrough = createUnregisteredSelectorPassthrough(env);
      await preflightPassthrough(passthroughBody, passthrough.countTokens, request.signal, log);
      trace.record('request.forwarded', {
        compatibility: 'unregistered-selector-passthrough',
        model: route.model,
        maxTokens: route.maxTokens,
        system: traceRawBlocks(passthroughBody.system),
        messages: traceMessages(passthroughBody.messages),
      });
      const data = await passthrough.complete(passthroughBody, request.signal, log);
      trace.record('response.received', { content: traceRawContent(data) });
      return jsonResponse(data, corsHeaders);
    }

    // A registered route resolves before attachment/file/provider I/O. Missing
    // configuration therefore fails closed rather than restoring caller model authority.
    const entry = getSystemPrompt(selector, env);
    validateRulesetVersion(request, entry, log, options.demo === true);
    const tenantScope =
      options.tenantScope ??
      (await fileTenantScope(request.headers.get('X-Personalizer-Context-ID'), env));
    const profile = getModelProfile(entry.name, env);
    if (requiresOrdinaryTurnContinuation(profile, env)) {
      if (!tenantScope) {
        throw new WorkerError('Inference continuation requires a validated tenant', {
          status: 400,
          exceptionType: 'ArgumentException',
        });
      }
      await preflightContinuationSealing(env);
    }
    const continuation = await decodeMessagesContinuation(
      safeBody.continuation,
      tenantScope ? { tenantScope, promptGroup: entry.group, modelProfile: profile.name } : null,
      profile.provider,
      env,
    );
    if (isRequiredContinuationMissing(profile, env, safeBody.messages, continuation)) {
      throw new WorkerError('Assistant history requires an inference continuation token', {
        status: 400,
        exceptionType: 'ArgumentException',
      });
    }
    const effort = resolveRegistryEffort(entry, qcTelemetry?.escalated === true);
    const inferenceRequest = await buildInferenceRequest(
      entry,
      safeBody,
      request,
      env,
      log,
      tenantScope,
      continuation,
      { effort, injectBrainDefaults: options.demo !== true },
    );

    if (!NON_BLOCKING_VISUAL_PROMPTS.has(selector)) {
      await preflightCanonical(inferenceRequest, env, log, tenantScope);
    }
    trace.record('request.forwarded', {
      group: entry.group,
      modelProfile: entry.modelProfile,
      provider: entry.provider,
      apiFamily: entry.apiFamily,
      maxTokens: entry.maxTokens,
      effort,
      prompt: inferenceRequest.prompt,
      messages: traceMessages(inferenceRequest.messages),
    });

    const result = await createInferenceService(env, tenantScope).complete(inferenceRequest);
    logUsageStats(result.usage, log);
    trace.record('response.received', {
      stopReason: result.stopReason,
      usage: result.usage,
      content: traceCanonicalContent(result.content),
    });
    const completion = {
      totalMs: Date.now() - requestStartedAt,
      model: inferenceRequest.modelProfile.model,
      maxTokens: entry.maxTokens,
      effort: effort ?? null,
      stopReason: result.stopReason,
      usage: usageFields(result.usage),
      qc: qcTelemetry,
    };
    if (result.stopReason === 'max-output-tokens') {
      log.warn('QC inference reached max_tokens', completion);
    } else {
      log.info('Inference completed', completion);
    }
    return await registeredMessagesResponse(
      result,
      inferenceRequest,
      corsHeaders,
      env,
      tenantScope,
    );
  } catch (error) {
    trace.record('request.failed', inferenceFailureTrace(error));
    log.error('Exception:', error, {
      inference: redactInferenceTraceValue(inferenceFailureTrace(error)),
      totalMs: Date.now() - requestStartedAt,
      qc: qcTelemetry,
    });
    return errorResponseFrom(error, corsHeaders, 'Internal proxy server error');
  }
}

function profileModel(request: InferenceRequest): string {
  return request.modelProfile.model;
}

/** Serialize a canonical registered result through the existing public `/messages` envelope. */
export async function registeredMessagesResponse(
  result: InferenceResult,
  request: InferenceRequest,
  corsHeaders: Record<string, string>,
  env?: Env,
  tenantScope?: string | null,
): Promise<Response> {
  const needsContinuation =
    result.providerState &&
    !hasRawCompatibilityResponse(result) &&
    (result.toolCalls.length > 0 || result.providerState.requiredOnNextTurn === true);
  if (needsContinuation && (!env || !tenantScope)) {
    throw new Error('Inference continuation requires a validated tenant');
  }
  let continuation: string | undefined;
  if (needsContinuation && result.providerState && env && tenantScope) {
    continuation = await encodeOpaqueContinuation(
      result.providerState,
      continuationRoute(request, tenantScope),
      env,
    );
  }
  return jsonResponse(
    messagesCompatibilityResponse(result, profileModel(request), continuation),
    corsHeaders,
  );
}

function hasRawCompatibilityResponse(result: InferenceResult): boolean {
  const value = result.providerState?.value;
  return !!value && typeof value === 'object' && 'rawResponse' in value;
}

async function buildInferenceRequest(
  entry: SystemPromptEntry,
  body: Record<string, unknown>,
  request: Request,
  env: Env,
  log: Logger,
  tenantScope: string | null,
  continuation: InferenceRequest['continuation'],
  requestPolicy: { effort: SemanticEffort | undefined; injectBrainDefaults: boolean },
): Promise<InferenceRequest> {
  const profile = getModelProfile(entry.name, env);
  const policy = getFilePolicy(entry.filePolicy);
  const files = createInferenceFileService(env);
  const messages = await resolveInferenceMessageFileReferences(
    parseCompatibilityMessages(body.messages, entry.provider),
    { promptGroup: entry.group, modelProfile: profile, filePolicy: policy },
    env,
    files,
    tenantScope,
  );
  const attachmentCount = await prependPromptAttachments(
    messages,
    entry,
    env,
    request.signal,
    log,
    tenantScope,
  );
  const systemMessages: InferenceMessage[] = [];
  if (entry.injectsBrainDefaults && requestPolicy.injectBrainDefaults) {
    const contextId = request.headers.get('X-Personalizer-Context-ID') ?? '';
    const defaults = contextId
      ? await getDefaultsBlock(contextId, env, log.child({ component: 'defaults' }))
      : null;
    if (defaults) {
      systemMessages.push({
        role: 'system',
        content: [{ type: 'text', text: defaults, cache: 'extended' }],
      });
      log.info('Injected Brain defaults block');
    }
  }

  // The adapter owns the stable base-prompt breakpoint. Canonical allocation
  // reserves the remaining slots for defaults, attachments, an explicit stable
  // prefix, then the largest image/document inputs.
  allocateSingleTurnCache(messages, 1 + systemMessages.length, attachmentCount);
  const structuredOutput = parseStructuredOutput(body.output_config);
  const sampling = parseSampling(body);
  const stopSequences = parseStopSequences(body.stop_sequences);
  const metadata = parseInferenceMetadata(body.metadata);
  const serviceTier = parseServiceTier(body.service_tier);
  const tools = parseCompatibilityTools(body.tools, entry.provider);
  const toolChoice = parseCompatibilityToolChoice(body.tool_choice);
  return {
    prompt: entry.prompt,
    promptGroup: entry.group,
    modelProfile: profile,
    filePolicy: policy,
    messages: [...systemMessages, ...messages],
    maxOutputTokens: entry.maxTokens,
    tools,
    abortSignal: request.signal,
    ...(requestPolicy.effort ? { effort: requestPolicy.effort } : {}),
    ...(structuredOutput ? { structuredOutput } : {}),
    ...(sampling ? { sampling } : {}),
    ...(stopSequences ? { stopSequences } : {}),
    ...(metadata ? { metadata } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(continuation ? { continuation } : {}),
  };
}

function continuationRoute(
  request: Pick<InferenceRequest, 'promptGroup' | 'modelProfile'>,
  tenantScope: string,
): ContinuationRoute {
  return {
    tenantScope,
    promptGroup: request.promptGroup,
    modelProfile: request.modelProfile.name,
  };
}

/** Authenticate a registered `/messages` continuation before attachment or provider I/O. */
export async function decodeMessagesContinuation(
  raw: unknown,
  route: ContinuationRoute | null,
  provider: InferenceRequest['modelProfile']['provider'],
  env: Env,
): Promise<InferenceRequest['continuation']> {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !route) {
    throw new WorkerError('Invalid inference continuation token', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  await preflightContinuationSealing(env);
  try {
    const state = await decodeOpaqueContinuation(raw, route, env);
    if (state.backend !== provider) throw new Error('wrong provider');
    return state;
  } catch {
    throw new WorkerError('Invalid inference continuation token', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
}

async function prependPromptAttachments(
  messages: InferenceMessage[],
  entry: SystemPromptEntry,
  env: Env,
  abortSignal: AbortSignal | undefined,
  log: Logger,
  tenantScope: string | null,
): Promise<number> {
  const attachments: readonly PromptAttachment[] = entry.attachments;
  const first = messages[0];
  if (!first || attachments.length === 0) return 0;
  const content: InferenceContent[] = [];
  const files = createInferenceFileService(env);
  const profile = getModelProfile(entry.name, env);
  const policy = getFilePolicy(entry.filePolicy);
  const accountScope = await files.scope(profile, policy);
  for (const attachment of attachments) {
    try {
      const result = await dedupUpload(
        {
          content: attachment.content,
          mimeType: attachment.mimeType,
          filename: attachment.filename,
        },
        {
          profile,
          policy,
          accountScope,
          tenantScope: tenantScope ?? GLOBAL_REGISTRY_ATTACHMENT_TENANT_SCOPE,
          compatibleGroups: [entry.group],
        },
        env,
        abortSignal,
        log.child({ attachment: attachment.filename }),
      );
      content.push({
        type: attachment.mimeType.startsWith('image/') ? 'image' : 'document',
        source: { type: 'provider-file', reference: result.reference },
        cache: 'extended',
      });
      log.info(
        `Attachment ${attachment.filename}: uploaded${result.deduped ? ' (dedup hit)' : ''}`,
      );
    } catch (error) {
      if (isCallerCancellation(error)) throw error;
      log.error(
        `Failed to upload ${attachment.filename}`,
        redactInferenceTraceValue(inferenceFailureTrace(error)),
      );
    }
  }
  if (content.length > 0) {
    messages[0] = { ...first, content: [...content, ...first.content] };
  }
  return content.length;
}

/**
 * Enforce the onboarding ruleset-version handshake (cross-repo contract). When
 * the resolved entry declares a `rulesetVersion` (the four onboarding
 * propose/review prompts PLUS the three sibling playbook conductors —
 * `cartdrawer-batch-all` / `cartdrawer-review-all` / `optimize-demand` — that
 * reuse the same shared onboarding playbook blocks) AND the caller sent the
 * `X-Personalizer-Ruleset-Version` header, the two MUST match; a mismatch throws
 * a 409 `RulesetVersionMismatchException` (Brain envelope) naming BOTH versions,
 * so a lib built against a stale playbook is rejected before inference rather
 * than silently proposing against the wrong enforced rules.
 *
 * ROLLOUT — fail-OPEN interim default (Risk R1): when the header is ABSENT the
 * check is SKIPPED (the request proceeds), so app-ai can deploy the handshake
 * before every lib caller sends the header. Once the lib ships the header
 * everywhere, this can tighten to fail-closed (reject a missing header). Entries
 * without a `rulesetVersion` (probes / chat / image-selection) always skip.
 */
function validateRulesetVersion(
  request: Request,
  entry: SystemPromptEntry,
  log: Logger,
  requireHeader: boolean,
): void {
  if (!entry.rulesetVersion) return;
  const header = request.headers.get('X-Personalizer-Ruleset-Version');
  if (header == null) {
    if (requireHeader) {
      throw new WorkerError('The demo request is missing its onboarding ruleset version.', {
        status: 409,
        exceptionType: 'RulesetVersionMismatchException',
        messageDetail: `X-Personalizer-Ruleset-Version is required; server expects '${entry.rulesetVersion}'`,
      });
    }
    // Fail-OPEN during rollout — see the ROLLOUT note above (Risk R1).
    return;
  }
  if (header !== entry.rulesetVersion) {
    throw new WorkerError(
      `Onboarding ruleset version mismatch: caller sent '${header}', server expects '${entry.rulesetVersion}'.`,
      {
        status: 409,
        exceptionType: 'RulesetVersionMismatchException',
        messageDetail: `X-Personalizer-Ruleset-Version '${header}' does not match server '${entry.rulesetVersion}'`,
      },
    );
  }
  log.info(`Ruleset version handshake OK (${entry.rulesetVersion})`);
}

/**
 * Resolve the registered prompt's effort. An `adaptiveEffort` entry maps the
 * content-free escalation signal onto its two registry-owned values; a fixed
 * `effort` entry ignores the signal. The registry stays the effort authority —
 * the caller only describes whether the request is a recovery attempt.
 */
function resolveRegistryEffort(
  entry: SystemPromptEntry,
  escalated: boolean,
): SemanticEffort | undefined {
  if (entry.adaptiveEffort) {
    return escalated ? entry.adaptiveEffort.escalated : entry.adaptiveEffort.default;
  }
  return entry.effort;
}

type QcAttempt = 'full' | 'lean' | 'chunk' | 'specialist';

interface QcTelemetry {
  attempt: QcAttempt;
  escalated: boolean;
  revision: number | null;
  pass: number | null;
  pageCount: number | null;
  imageCount: number | null;
  tileCount: number | null;
  captureMs: number | null;
  uploadMs: number | null;
}

/** Read the bounded, content-free QC metadata supplied by lib for durable inference telemetry. */
function readQcTelemetry(request: Request): QcTelemetry | null {
  const rawAttempt = request.headers.get('X-Personalizer-QC-Attempt');
  if (!rawAttempt) return null;
  const attempts: readonly QcAttempt[] = ['full', 'lean', 'chunk', 'specialist'];
  if (!attempts.includes(rawAttempt as QcAttempt)) return null;
  const readCount = (name: string): number | null => {
    const raw = request.headers.get(name);
    if (raw == null || !/^\d{1,9}$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  };
  return {
    attempt: rawAttempt as QcAttempt,
    escalated: request.headers.get('X-Personalizer-QC-Escalated') === '1',
    revision: readCount('X-Personalizer-QC-Revision'),
    pass: readCount('X-Personalizer-QC-Pass'),
    pageCount: readCount('X-Personalizer-QC-Page-Count'),
    imageCount: readCount('X-Personalizer-QC-Image-Count'),
    tileCount: readCount('X-Personalizer-QC-Tile-Count'),
    captureMs: readCount('X-Personalizer-QC-Capture-Ms'),
    uploadMs: readCount('X-Personalizer-QC-Upload-Ms'),
  };
}

/** Normalize canonical usage into stable numeric telemetry keys. */
function usageFields(usage: InferenceUsage): Record<string, number> {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheWriteInputTokens ?? 0,
    cacheReadInputTokens: usage.cachedInputTokens ?? 0,
  };
}

async function preflightCanonical(
  request: InferenceRequest,
  env: Env,
  log: Logger,
  tenantScope: string | null,
): Promise<void> {
  if (!isLargeCandidate(request.messages)) return;
  try {
    const inputTokens = await createInferenceDiagnosticsService(env, tenantScope).countTokens(
      request,
    );
    if (inputTokens === null) return;
    log.info(`Pre-flight count_tokens estimate: ${inputTokens} input tokens`);
    if (inputTokens > LARGE_PAYLOAD_TOKEN_THRESHOLD) {
      log.warn(
        `Large payload: ~${inputTokens} input tokens (>${LARGE_PAYLOAD_TOKEN_THRESHOLD}) — consider chunking or a larger-context model`,
      );
    }
  } catch (error) {
    if (isCallerCancellation(error)) throw error;
    log.info(
      `count_tokens pre-flight skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function preflightPassthrough(
  payload: Record<string, unknown>,
  countTokens: (
    payload: Record<string, unknown>,
    abortSignal?: AbortSignal,
  ) => Promise<number | null>,
  abortSignal: AbortSignal | undefined,
  log: Logger,
): Promise<void> {
  const messages = parseCompatibilityMessages(payload.messages, 'anthropic');
  if (!isLargeCandidate(messages)) return;
  try {
    const inputTokens = await countTokens(payload, abortSignal);
    if (inputTokens !== null)
      log.info(`Pre-flight count_tokens estimate: ${inputTokens} input tokens`);
  } catch (error) {
    if (isCallerCancellation(error)) throw error;
    log.info(
      `count_tokens pre-flight skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isCallerCancellation(error: unknown): boolean {
  return error instanceof InferenceFailure && error.inferenceError.failureClass === 'cancelled';
}

function isLargeCandidate(messages: readonly InferenceMessage[]): boolean {
  return (
    messages.length >= 4 ||
    messages.some((message) =>
      message.content.some((content) => content.type === 'image' || content.type === 'document'),
    )
  );
}

function logUsageStats(usage: InferenceUsage, log: Logger): void {
  if (usage.inputTokens === null && usage.outputTokens === null) return;
  log.info(
    `Tokens — input: ${usage.inputTokens}, cache_creation: ${usage.cacheWriteInputTokens ?? 0}, cache_read: ${usage.cachedInputTokens ?? 0}, output: ${usage.outputTokens}`,
  );
}

function traceMessages(raw: unknown): unknown {
  const messages = Array.isArray(raw) ? raw : [];
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return { role: 'invalid' };
    const record = message as Record<string, unknown>;
    return { role: record.role, content: traceRawBlocks(record.content) };
  });
}

function traceRawBlocks(raw: unknown): unknown {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    if (!item || typeof item !== 'object') return { type: 'invalid' };
    const block = item as Record<string, unknown>;
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'tool_use')
      return {
        type: 'tool_use',
        name: block.name,
        input: redactInferenceTraceValue(block.input),
      };
    if (block.type === 'tool_result') {
      return {
        type: 'tool_result',
        content: traceRawBlocks(block.content),
        isError: block.is_error === true,
      };
    }
    return { type: block.type, source: 'file' };
  });
}

function traceCanonicalContent(content: readonly InferenceContent[]): unknown {
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
        content: traceCanonicalContent(item.content),
      };
    }
    return { type: item.type, source: item.source.type };
  });
}

function traceRawContent(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  return traceRawBlocks((raw as Record<string, unknown>).content);
}
