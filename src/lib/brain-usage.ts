import { personalizerApiUrl, type Env } from '../config';
import type { InferenceUsage, ProviderName } from './inference-types';
import type { LoggingRuntime } from './logger';

const REPORT_CHAT_USAGE_PATH = 'v2/agents/report-chat-usage';

/** The prompt name a usage report carries for the unregistered `/messages` passthrough. */
export const UNREGISTERED_MESSAGES_USAGE_PROMPT = 'unregistered-messages';

/** Brain's `v2/agents/report-chat-usage` request body: one completed provider response under a merchant Context-ID. */
export interface ChatUsageReport {
  readonly RequestGuid: string;
  readonly PromptName: string;
  readonly Model: string;
  readonly InputTokens: number;
  readonly OutputTokens: number;
  readonly CacheReadTokens: number;
  readonly CacheWriteTokens: number;
  readonly WebSearchRequests: number;
}

/** One completed provider response, as the handler that ran it saw it. */
export interface CompletedResponseUsage {
  readonly promptName: string;
  readonly model: string;
  readonly provider: ProviderName;
  readonly usage: InferenceUsage;
}

/**
 * The report for one completed response, or null when the provider reported no token counts.
 * Gemini is reported as Brain prices it: its whole prompt, cache hits included, as input, its
 * thinking added to its output, and no cache tokens, which Brain's Gemini rates carry no price
 * for. Every other provider's cache reads are reported apart from its input: Anthropic counts
 * them apart, and the others count them inside their input total.
 */
export function chatUsageReport(completed: CompletedResponseUsage): ChatUsageReport | null {
  const { usage } = completed;
  if (usage.inputTokens === null && usage.outputTokens === null) return null;
  return {
    RequestGuid: crypto.randomUUID(),
    PromptName: completed.promptName,
    Model: completed.model,
    ...reportedTokens(completed.provider, usage),
    WebSearchRequests: 0,
  };
}

function reportedTokens(
  provider: ProviderName,
  usage: InferenceUsage,
): Pick<ChatUsageReport, 'InputTokens' | 'OutputTokens' | 'CacheReadTokens' | 'CacheWriteTokens'> {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (provider === 'gemini') {
    return {
      InputTokens: inputTokens,
      OutputTokens: outputTokens + (usage.reasoningTokens ?? 0),
      CacheReadTokens: 0,
      CacheWriteTokens: 0,
    };
  }
  const cacheReadTokens = usage.cachedInputTokens ?? 0;
  return {
    InputTokens:
      provider === 'anthropic' ? inputTokens : Math.max(0, inputTokens - cacheReadTokens),
    OutputTokens: outputTokens,
    CacheReadTokens: cacheReadTokens,
    CacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
  };
}

/**
 * Send each completed response's usage to Brain after the reply, through the request's
 * background scheduler. A report Brain refuses or cannot receive is logged and never retried,
 * and no report changes the answer the caller already has.
 */
export function reportChatUsage(
  contextId: string | null,
  completed: readonly CompletedResponseUsage[],
  env: Env,
  logging: LoggingRuntime,
): void {
  if (!contextId) return;
  for (const response of completed) {
    const report = chatUsageReport(response);
    if (!report) continue;
    logging.runBackground(
      'BrainUsage',
      'report-chat-usage',
      sendChatUsageReport(contextId, report, env),
    );
  }
}

async function sendChatUsageReport(
  contextId: string,
  report: ChatUsageReport,
  env: Env,
): Promise<void> {
  const response = await fetch(`${personalizerApiUrl(env)}/${REPORT_CHAT_USAGE_PATH}`, {
    method: 'POST',
    headers: {
      'X-Personalizer-Context-ID': contextId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(report),
  });
  if (!response.ok) {
    throw new Error(
      `Brain refused the chat usage report for prompt ${report.PromptName} with status ${response.status}`,
    );
  }
}
