import { graderChatAlertSlackWebhookUrl, type Env } from '../config';
import type { GraderChatVolumeAlert } from './grader-chat-quota';
import type { Logger } from './logger';

const ALERT_TIMEOUT_MILLISECONDS = 5_000;
const COUNT_FORMAT = new Intl.NumberFormat('en-US');

/** The text a chat-volume alert carries. */
export function graderChatVolumeAlertText(alert: GraderChatVolumeAlert): string {
  return `Grader chat: ${COUNT_FORMAT.format(alert.count)} messages today, limit ${COUNT_FORMAT.format(alert.limit)}`;
}

/**
 * What became of one alert: delivered (or logged, with no webhook configured), refused for good,
 * or failed in a way a later attempt may get past.
 */
export type GraderChatAlertDelivery = 'delivered' | 'refused' | 'retry';

/**
 * Deliver one chat-volume alert to the configured Slack incoming webhook, logging the outcome. It
 * never throws. Without a webhook the logged warning is the alert. A network failure, a timeout, or
 * a 408, 429 or 5xx answer may succeed later; an unusable destination or any other refusal will not.
 */
export async function notifyGraderChatVolume(
  alert: GraderChatVolumeAlert,
  env: Env,
  log: Logger,
): Promise<GraderChatAlertDelivery> {
  const details = { count: alert.count, limit: alert.limit };
  let destination: string | null;
  try {
    destination = graderChatAlertSlackWebhookUrl(env);
  } catch {
    log.error('Grader chat volume alert has an unusable destination; it was not sent', details);
    return 'refused';
  }
  if (destination === null) {
    log.warn(`${graderChatVolumeAlertText(alert)} (no alert destination is configured)`, details);
    return 'delivered';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MILLISECONDS);
  try {
    const response = await fetch(destination, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: graderChatVolumeAlertText(alert) }),
      signal: controller.signal,
    });
    if (response.ok) {
      log.info('Grader chat volume alert delivered', details);
      return 'delivered';
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      log.warn('Grader chat volume alert failed; it is retried', {
        ...details,
        status: response.status,
      });
      return 'retry';
    }
    log.error('Grader chat volume alert was refused', { ...details, status: response.status });
    return 'refused';
  } catch (error) {
    log.warn('Grader chat volume alert could not be delivered; it is retried', {
      ...details,
      failure: error instanceof Error ? error.name : 'unknown',
    });
    return 'retry';
  } finally {
    clearTimeout(timeout);
  }
}
