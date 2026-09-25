import type { InferenceEvent, ProviderName } from '../lib/inference-types';
import { InferenceFailure } from './adapter';

/**
 * How long one upstream model call may run before app-ai answers the caller with a timeout.
 * Every inference call the worker makes is held to this one value; no caller, prompt, or
 * provider adapter sets another.
 */
export const UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS = 600_000;

/** The `code` and `MessageDetail` of the failure returned when the deadline passes. */
export const INFERENCE_TIMEOUT_CODE = 'inference_timeout';

interface RunningDeadline {
  readonly signal: AbortSignal;
  readonly expired: () => boolean;
  readonly release: () => void;
}

export async function completeWithinDeadline<T>(
  provider: ProviderName,
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = startDeadline(callerSignal);
  try {
    return await run(deadline.signal);
  } catch (error) {
    throw deadline.expired() && callerSignal?.aborted !== true ? inferenceTimeout(provider) : error;
  } finally {
    deadline.release();
  }
}

export async function* streamWithinDeadline(
  provider: ProviderName,
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => AsyncIterable<InferenceEvent>,
): AsyncIterable<InferenceEvent> {
  const deadline = startDeadline(callerSignal);
  try {
    yield* run(deadline.signal);
  } catch (error) {
    throw deadline.expired() && callerSignal?.aborted !== true ? inferenceTimeout(provider) : error;
  } finally {
    deadline.release();
  }
}

function startDeadline(callerSignal: AbortSignal | undefined): RunningDeadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DOMException('Upstream inference deadline passed', 'TimeoutError'));
  }, UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS);
  const forwardCancellation = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardCancellation();
  else callerSignal?.addEventListener('abort', forwardCancellation, { once: true });
  return {
    signal: controller.signal,
    expired: () => expired,
    release: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forwardCancellation);
    },
  };
}

function inferenceTimeout(provider: ProviderName): InferenceFailure {
  return new InferenceFailure({
    backend: provider,
    status: 504,
    code: INFERENCE_TIMEOUT_CODE,
    message: `The AI model did not answer within the ${UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS / 1000}-second inference deadline.`,
    detail: INFERENCE_TIMEOUT_CODE,
    retryable: true,
    failureClass: 'timeout',
  });
}
