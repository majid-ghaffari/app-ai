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
import { dedupUpload } from '../lib/file-dedup';
import {
  jsonResponse,
  errorResponseFrom,
  anthropicErrorResponse,
  type CorsHeaders,
} from '../lib/responses';
import { createLogger } from '../lib/logger';
import type { Env } from '../config';

/**
 * Soft input-token threshold above which we log a count_tokens estimate (and a
 * warning). Purely advisory — NEVER gates/rejects the live request. An internal
 * observability constant, not a deploy-time tunable: changing it changes only
 * when a log line warns, never any wire behavior.
 */
const LARGE_PAYLOAD_TOKEN_THRESHOLD = 100000;

const log = createLogger('Messages');

export async function handleMessages(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
): Promise<Response> {
  try {
    const systemPromptName = request.headers.get('X-Personalizer-System-Prompt');

    // The context-ID is already router-validated; it is a credential and is
    // deliberately NOT logged (docs/TOOLSETS.md → security standards).
    log.info(`Request${systemPromptName ? ` (prompt ${systemPromptName})` : ''}`);

    const body = (await request.json()) as Record<string, unknown>;
    const { apiKey: _apiKey, ...claudePayload } = body as {
      apiKey?: unknown;
    } & ClientMessagesPayload;

    let attachmentFileCount = 0;
    if (systemPromptName) {
      try {
        attachmentFileCount = await injectSystemPrompt(systemPromptName, claudePayload, env);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log.error(`Failed to load system prompt: ${reason}`);
      }
    }

    // The registry is authoritative for the inference model: when the caller
    // omits `model`, fall back to the resolved system-prompt entry's model
    // (a deploy-time choice — the entry's capability tier resolved via
    // `resolveModel`). Additive + safe —
    // a caller that sends its own `model` (e.g. image-selection sends Haiku) is
    // untouched; only a body without `model` (the Website-Analysis probe) is
    // defaulted, so a probe runs on its registry model per docs/prompts.
    applyRegistryModel(claudePayload, systemPromptName, env);

    manageCacheControl(claudePayload, attachmentFileCount);

    // Apply opt-in output effort from the registry entry, if the client didn't
    // already set output_config (additive + safe — see prompt-registry.ts entry shape).
    applyRegistryEffort(claudePayload, systemPromptName, env);

    // Best-effort pre-flight token estimate for large payloads — log/warn only,
    // never gate the live path.
    await preflightTokenEstimate(claudePayload, env);

    const response = await anthropic.createMessage(claudePayload, env);
    const data = (await response.json()) as {
      error?: { type?: string; message?: string };
      usage?: Usage;
    };

    if (!response.ok) {
      log.error(`Anthropic error: ${data.error?.type} — ${data.error?.message}`);
      return anthropicErrorResponse(data, response.status, 'Anthropic request failed', corsHeaders);
    }

    logUsageStats(data.usage);
    return jsonResponse(data, corsHeaders);
  } catch (error) {
    log.error('Exception:', error instanceof Error ? error.message : error);
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
function logUsageStats(usage: Usage | undefined): void {
  if (!usage) {
    return;
  }
  log.info(
    `Tokens — input: ${usage.input_tokens}, cache_creation: ${usage.cache_creation_input_tokens || 0}, cache_read: ${usage.cache_read_input_tokens || 0}, output: ${usage.output_tokens}`,
  );
}
