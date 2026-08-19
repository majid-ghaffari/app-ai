/**
 * POST /messages — single-shot Anthropic Messages proxy (the LIVE smart-image
 * surface). Optionally injects a server-side system prompt (selected by the
 * `X-Personalizer-System-Prompt` header), uploads any prompt attachments to the
 * Files API and prepends them to the first user message, manages the 4-block
 * `cache_control` limit, then proxies to Anthropic and returns the body as-is.
 *
 * Success responses flow through unchanged. Failures return the Brain-shaped
 * error envelope (lib/responses.ts): a non-ok Anthropic response keeps
 * Anthropic's status, carries `ExceptionType: 'AnthropicApiException'`, and puts
 * the raw upstream body in `MessageDetail`.
 */

import { getSystemPrompt } from '../prompt-registry';
import * as anthropic from '../lib/anthropic';
import type { CacheableBlock, ClientMessagesPayload, Usage } from '../lib/anthropic';
import { manageCacheControl, EXTENDED_CACHE_CONTROL } from '../lib/cache-control';
import { getDefaultsBlock } from '../lib/brain-defaults';
import { dedupUpload } from '../lib/file-dedup';
import {
  jsonResponse,
  errorResponseFrom,
  anthropicErrorResponse,
  WorkerError,
  type CorsHeaders,
} from '../lib/responses';
import { createLoggingRuntime, type Logger, type LoggingRuntime } from '../lib/logger';
import {
  createDevelopmentInferenceTrace,
  traceableContent,
  traceableMessages,
  traceableSystem,
} from '../lib/dev-inference-trace';
import type { Env } from '../config';

/**
 * Soft input-token threshold above which we log a count_tokens estimate (and a
 * warning). Purely advisory — NEVER gates/rejects the live request. An internal
 * observability constant, not a deploy-time tunable: changing it changes only
 * when a log line warns, never any wire behavior.
 */
const LARGE_PAYLOAD_TOKEN_THRESHOLD = 100000;

/** Latency-critical visual calls must never wait for an advisory count_tokens round-trip. */
const NON_BLOCKING_VISUAL_PROMPTS = new Set([
  'onboarding-batch',
  'onboarding-batch-all',
  'onboarding-review',
  'onboarding-review-all',
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
): Promise<Response> {
  const systemPromptName = request.headers.get('X-Personalizer-System-Prompt');
  const log = logging.logger('Messages', { prompt: systemPromptName });
  const trace = createDevelopmentInferenceTrace(
    logging.logger('InferenceTrace', { prompt: systemPromptName }),
    'messages',
    systemPromptName,
  );
  try {
    log.info('Request received');

    const body = (await request.json()) as Record<string, unknown>;
    const { apiKey: _apiKey, ...claudePayload } = body as {
      apiKey?: unknown;
    } & ClientMessagesPayload;

    // Cross-repo ruleset handshake — reject a lib built against a stale onboarding
    // playbook before any inference (throws a 409 the outer catch maps to the
    // Brain envelope). No-op for non-onboarding prompts and (during rollout) for
    // a caller that sends no version header.
    validateRulesetVersion(request, systemPromptName, env, log);

    let attachmentFileCount = 0;
    if (systemPromptName) {
      try {
        attachmentFileCount = await injectSystemPrompt(systemPromptName, claudePayload, env, log);
      } catch (error) {
        log.error('Failed to load system prompt', error, { systemPromptName });
      }
    }

    // The registry is authoritative for the inference model: when the caller
    // omits `model`, fall back to the resolved system-prompt entry's model
    // (a deploy-time choice — the entry's capability tier resolved via
    // `resolveModel`). Additive + safe —
    // a caller that sends its own `model` (e.g. image-selection sends Haiku) is
    // untouched; only a body without `model` (the Website-Analysis probe) is
    // defaulted, so a probe runs on its registry model per docs/prompts.
    applyRegistryModel(claudePayload, systemPromptName, env, log);

    // Set `max_tokens` EXACTLY to the resolved entry's registry value — the
    // registry is authoritative for a registered prompt's output budget. Any
    // client-sent `max_tokens` is overridden (there is no floor, no cap, no
    // client read): changing a registry `maxTokens` literal changes the outgoing
    // Anthropic request one-for-one. Between the model default and cache
    // management so the budget rides the same forwarded payload.
    applyRegistryMaxTokens(claudePayload, systemPromptName, env, log);

    // PROPOSE prompts: fetch + project the global Brain default box settings
    // and inject them as a SECOND cacheable system block (after the stable prompt,
    // before the store screenshots that ride in the user message). Best-effort —
    // a fetch failure degrades to no injection and never fails the request. The
    // The context-ID authenticates the Brain fetch and is correlated by the request logger only.
    const contextId = request.headers.get('X-Personalizer-Context-ID') ?? '';
    await injectBrainDefaults(systemPromptName, claudePayload, contextId, env, log);

    manageCacheControl(claudePayload, attachmentFileCount, logging.logger('CacheControl'));

    // Apply opt-in output effort from the registry entry, if the client didn't
    // already set output_config (additive + safe — see prompt-registry.ts entry shape).
    applyRegistryEffort(claudePayload, systemPromptName, env, log);

    // Best-effort pre-flight token estimate for large payloads — log/warn only,
    // never gate the live path.
    if (!systemPromptName || !NON_BLOCKING_VISUAL_PROMPTS.has(systemPromptName)) {
      await preflightTokenEstimate(claudePayload, env, log);
    }

    trace.record('request.forwarded', {
      model: claudePayload.model,
      maxTokens: claudePayload.max_tokens,
      outputConfig: claudePayload.output_config,
      system: traceableSystem(claudePayload.system),
      messages: traceableMessages(claudePayload),
    });

    const response = await anthropic.createMessage(claudePayload, env);
    const data = (await response.json()) as {
      error?: { type?: string; message?: string };
      usage?: Usage;
      stop_reason?: unknown;
      content?: unknown;
    };

    trace.record('response.received', {
      status: response.status,
      stopReason: data.stop_reason,
      usage: data.usage,
      content: traceableContent(data.content),
    });

    if (!response.ok) {
      log.error('Anthropic request failed', data.error, {
        status: response.status,
        response: data,
      });
      return anthropicErrorResponse(data, response.status, 'Anthropic request failed', corsHeaders);
    }

    // A `max_tokens` stop means the model was CUT OFF mid-answer. For a JSON-only prompt that is a
    // silent corruption: the body still returns 200, the client parses a truncated object, and the
    // work simply goes missing — for the onboarding review that meant pages the model never reached
    // being recorded as unverified, degrading the run for no visible reason. It cost a live debugging
    // session to find, so it is now LOUD. Not an error: the partial body is still returned unchanged
    // (the caller's own repair/fallback path decides what to do with it) — this only makes the cause
    // findable in one grep instead of a token-arithmetic exercise.
    if (data.stop_reason === 'max_tokens') {
      log.warn('Completion hit max_tokens — the answer was truncated', {
        systemPromptName,
        maxTokens: claudePayload.max_tokens,
        outputTokens: data.usage?.output_tokens,
      });
    }

    logUsageStats(data.usage, log);
    return jsonResponse(data, corsHeaders);
  } catch (error) {
    trace.record('request.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    log.error('Messages request failed', error, { systemPromptName });
    return errorResponseFrom(error, corsHeaders, 'Internal proxy server error');
  }
}

/**
 * Inject a server-side system prompt into the payload, uploading any attachment
 * files and prepending them (as document/image content blocks) to the first
 * user message. Mutates `claudePayload`. Returns the number of attachment
 * blocks prepended to the first user message.
 */
async function injectSystemPrompt(
  systemPromptName: string,
  claudePayload: ClientMessagesPayload,
  env: Env,
  log: Logger,
): Promise<number> {
  const prompt = getSystemPrompt(systemPromptName, env);

  // CACHE-FIRST STRUCTURE (see prompt-registry.ts → CACHING). `prompt.prompt` is the
  // STABLE, shop-independent system text — for the composed onboarding prompts it
  // is `composePrompt(...blocks)` in a deterministic order, byte-identical across
  // every shop. We put ALL of it in the single cacheable system block with a 1h
  // `cache_control` breakpoint, so repeated per-shop calls HIT the cached prefix
  // after the first. The LIB-SIDE EXPECTATION that makes this work: per-shop
  // VARIABLE data (the page screenshots + the per-page manifest) rides AFTER this
  // breakpoint, in the first user MESSAGE — never in the system prompt — so it
  // never invalidates the cached prefix. `manageCacheControl` (below) then
  // distributes the remaining breakpoints across those user blocks.
  claudePayload.system = [
    { type: 'text', text: prompt.prompt, cache_control: { ...EXTENDED_CACHE_CONTROL } },
  ];
  log.info(`Loaded system prompt: ${systemPromptName} (${prompt.prompt.length} chars)`);

  if (!prompt.attachments || prompt.attachments.length === 0) {
    return 0;
  }

  log.info(`Processing ${prompt.attachments.length} prompt attachment(s)`);
  const attachmentBlocks: CacheableBlock[] = [];

  for (const attachment of prompt.attachments) {
    let fileId: string | null = null;
    try {
      const result = await dedupUpload(
        {
          content: attachment.content,
          mimeType: attachment.mimeType,
          filename: attachment.filename,
        },
        env,
        log.child({ attachment: attachment.filename }),
      );
      fileId = result.fileId;
      log.info(
        `Attachment ${attachment.filename}: file_id ${fileId}${result.deduped ? ' (dedup hit)' : ''}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error(`Failed to upload ${attachment.filename}: ${reason}`);
      continue;
    }

    if (!fileId) {
      log.error(`No file_id for ${attachment.filename}; skipping attachment`);
      continue;
    }

    attachmentBlocks.push({
      type: attachment.mimeType.startsWith('image/') ? 'image' : 'document',
      source: { type: 'file', file_id: fileId },
      // Reused across calls → stable prefix → extended 1h cache.
      cache_control: { ...EXTENDED_CACHE_CONTROL },
    });
  }

  const firstMessage = claudePayload.messages?.[0];
  if (attachmentBlocks.length > 0 && firstMessage) {
    const existing: CacheableBlock[] = Array.isArray(firstMessage.content)
      ? firstMessage.content
      : [{ type: 'text', text: firstMessage.content }];
    firstMessage.content = [...attachmentBlocks, ...existing];
    log.info(`Prepended ${attachmentBlocks.length} prompt attachment(s) to first message`);
    return attachmentBlocks.length;
  }
  return 0;
}

/**
 * PROPOSE-path Brain-defaults injection. When the resolved entry declares
 * `injectsBrainDefaults` (the onboarding / cart-drawer / optimize propose
 * prompts), fetch + project the canonical global Brain default box settings
 * (lib/brain-defaults.ts) and append them as a SECOND cacheable system block —
 * AFTER the stable system prompt, and BEFORE the per-store screenshots that ride
 * in the first user message (so the defaults block sits inside the cacheable
 * prefix while the volatile evidence stays after it). Byte-stable across stores
 * for the same global defaults → the block's own cache_control breakpoint HITS
 * Anthropic's prompt cache cross-tenant.
 *
 * Best-effort and non-fatal: no system block yet, no defaults resolved (a
 * cold-cache fetch failure), or an unknown prompt → the payload is left as-is
 * (no injection). `contextId` authenticates the Brain fetch and remains request-scoped.
 *
 */
async function injectBrainDefaults(
  systemPromptName: string | null,
  claudePayload: ClientMessagesPayload,
  contextId: string,
  env: Env,
  log: Logger,
): Promise<void> {
  if (!systemPromptName || !contextId) {
    return;
  }
  let entry;
  try {
    entry = getSystemPrompt(systemPromptName, env);
  } catch {
    return;
  }
  if (!entry.injectsBrainDefaults) {
    return;
  }
  // The stable system prompt must already be present (injectSystemPrompt ran);
  // the defaults ride as the block AFTER it.
  const system = claudePayload.system;
  if (!Array.isArray(system) || system.length === 0) {
    return;
  }
  const defaultsBlock = await getDefaultsBlock(
    contextId,
    env,
    log.child({ component: 'defaults' }),
  );
  if (!defaultsBlock) {
    return;
  }
  (system as CacheableBlock[]).push({
    type: 'text',
    text: defaultsBlock,
    cache_control: { ...EXTENDED_CACHE_CONTROL },
  });
  log.info('Injected Brain defaults block');
}

/**
 * Set `claudePayload.model` from the resolved registry entry's model WHEN the
 * caller omitted it. The registry entry pairs each prompt with a capability tier
 * that resolves to a deploy-time model (via `resolveModel`); a caller that
 * already sent `model` owns it and is left untouched. No system prompt / unknown
 * name / already-set model → the payload is unchanged.
 */
function applyRegistryModel(
  claudePayload: ClientMessagesPayload,
  systemPromptName: string | null,
  env: Env,
  log: Logger,
): void {
  if (!systemPromptName || claudePayload.model) {
    return;
  }
  try {
    const entry = getSystemPrompt(systemPromptName, env);
    claudePayload.model = entry.model;
    log.info(`Applied registry model '${entry.model}' for prompt ${systemPromptName}`);
  } catch {
    // Unknown prompt / missing model var — leave the payload as-is; the
    // downstream Anthropic call surfaces a clear error.
  }
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
  systemPromptName: string | null,
  env: Env,
  log: Logger,
): void {
  if (!systemPromptName) {
    return;
  }
  let entry;
  try {
    entry = getSystemPrompt(systemPromptName, env);
  } catch {
    return;
  }
  if (!entry.rulesetVersion) {
    return;
  }
  const header = request.headers.get('X-Personalizer-Ruleset-Version');
  if (header == null) {
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
  log.info(`Ruleset version handshake OK (${entry.rulesetVersion}) for prompt ${systemPromptName}`);
}

/**
 * Set `claudePayload.max_tokens` EXACTLY to the resolved registry entry's
 * `maxTokens`. The registry is authoritative: a registered prompt's output
 * budget is a deploy-time choice that owns the wire value outright — there is no
 * floor, no cap, and no client `max_tokens` read, so a client-sent budget is
 * OVERRIDDEN and changing a registry `maxTokens` literal changes the outgoing
 * Anthropic request one-for-one. Without this, an omitted `max_tokens` reaches
 * Anthropic as a 400 (the field is required). No system prompt / unknown name →
 * the payload is unchanged (the caller owns its own token budget, as it does its
 * own model).
 */
function applyRegistryMaxTokens(
  claudePayload: ClientMessagesPayload,
  systemPromptName: string | null,
  env: Env,
  log: Logger,
): void {
  if (!systemPromptName) {
    return;
  }
  let entry;
  try {
    entry = getSystemPrompt(systemPromptName, env);
  } catch {
    // Unknown prompt — leave the caller's budget as-is (the downstream Anthropic
    // call surfaces a clear error if it is missing / invalid).
    return;
  }
  if (claudePayload.max_tokens !== entry.maxTokens) {
    claudePayload.max_tokens = entry.maxTokens;
    log.info(
      `Applied registry max_tokens ${entry.maxTokens} (exact) for prompt ${systemPromptName}`,
    );
  }
}

/**
 * Add `output_config: { effort }` from the registry entry IF the entry carries
 * an `effort` field, the resolved model supports effort, AND the client hasn't
 * already set `output_config`. The effort lever is only valid on supporting
 * models — sending it to one that doesn't (e.g. Haiku 4.5) returns a 400 — so
 * it is gated on `supportsEffort`. Additive and safe otherwise: no entry / no
 * effort / unsupported model leaves the payload untouched.
 */
function applyRegistryEffort(
  claudePayload: ClientMessagesPayload,
  systemPromptName: string | null,
  env: Env,
  log: Logger,
): void {
  if (!systemPromptName || claudePayload.output_config) {
    return;
  }
  let entry;
  try {
    entry = getSystemPrompt(systemPromptName, env);
  } catch {
    return;
  }
  const model = claudePayload.model || entry.model;
  if (entry.effort && anthropic.supportsEffort(model)) {
    claudePayload.output_config = { effort: entry.effort };
    log.info(`Applied output effort '${entry.effort}' from registry`);
  }
}

/**
 * Best-effort pre-flight token estimate. For large payloads, calls the free
 * count_tokens endpoint and logs the estimate (warns past a soft threshold).
 * NEVER throws into the live path and NEVER rejects the request.
 */
async function preflightTokenEstimate(
  claudePayload: ClientMessagesPayload,
  env: Env,
  log: Logger,
): Promise<void> {
  // Cheap gate: only bother for payloads likely to be large (attachments or a
  // long message history). Avoids a network round-trip on every small request.
  const messages = Array.isArray(claudePayload.messages) ? claudePayload.messages : [];
  const hasAttachments = messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'image' || block.type === 'document'),
  );
  if (messages.length < 4 && !hasAttachments) {
    return;
  }

  try {
    const response = await anthropic.countTokens(claudePayload, env);
    if (!response.ok) {
      return;
    }
    const data = (await response.json()) as { input_tokens?: number };
    const inputTokens = data.input_tokens || 0;
    log.info(`Pre-flight count_tokens estimate: ${inputTokens} input tokens`);
    if (inputTokens > LARGE_PAYLOAD_TOKEN_THRESHOLD) {
      log.warn(
        `Large payload: ~${inputTokens} input tokens (>${LARGE_PAYLOAD_TOKEN_THRESHOLD}) — consider chunking or a larger-context model`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.info(`count_tokens pre-flight skipped: ${reason}`);
  }
}

/** Log token-usage stats with cache-hit/creation markers. */
function logUsageStats(usage: Usage | undefined, log: Logger): void {
  if (!usage) {
    return;
  }
  log.info(
    `Tokens — input: ${usage.input_tokens}, cache_creation: ${usage.cache_creation_input_tokens || 0}, cache_read: ${usage.cache_read_input_tokens || 0}, output: ${usage.output_tokens}`,
  );
}
