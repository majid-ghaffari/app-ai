/** Provider-adapter contract owned by the provider-neutral inference runtime. */

import type {
  FilePolicy,
  InferenceError,
  InferenceEvent,
  InferenceRequest,
  InferenceResult,
  InferenceToolResult,
  ProviderApiFamily,
  ProviderContinuationState,
  ProviderName,
} from '../lib/inference-types';

/** Bytes and metadata sent directly to a provider's file API. */
export interface ProviderUploadRequest {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
  readonly policy: FilePolicy;
  readonly abortSignal?: AbortSignal;
}

/** Provider file metadata used for validation and content-block typing. */
export interface ProviderFileMetadata {
  readonly id: string;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
  readonly expiresAt: string | null;
}

/** Provider file upload result retained only behind an opaque app-ai reference. */
export type ProviderUploadResult = ProviderFileMetadata;

/** One concrete provider/API-family implementation. */
export interface InferenceProviderAdapter {
  readonly provider: ProviderName;
  readonly apiFamily: ProviderApiFamily;
  /** Whether every successful assistant turn must cross the next public HTTP boundary. */
  readonly requiresOrdinaryTurnContinuation?: boolean;
  /** Seal server-executed terminal tool results when the shared loop reaches its cap. */
  finalizeAgentContinuation?(
    state: ProviderContinuationState,
    results: readonly InferenceToolResult[],
  ): ProviderContinuationState;
  complete(request: InferenceRequest): Promise<InferenceResult>;
  stream(request: InferenceRequest): AsyncIterable<InferenceEvent>;
  countTokens?(request: InferenceRequest): Promise<number | null>;
  getFileScope?(policy: FilePolicy): Promise<string>;
  uploadFile?(request: ProviderUploadRequest): Promise<ProviderUploadResult>;
  getFileMetadata?(id: string, abortSignal?: AbortSignal): Promise<ProviderFileMetadata | null>;
  deleteFile?(id: string, abortSignal?: AbortSignal): Promise<void>;
}

/** Error thrown by an adapter after normalizing the provider failure. */
export class InferenceFailure extends Error {
  readonly inferenceError: InferenceError;

  constructor(inferenceError: InferenceError) {
    super(inferenceError.message);
    this.name = 'InferenceFailure';
    this.inferenceError = inferenceError;
  }
}

/** Log-safe normalized failure fields for development inference traces. */
export function inferenceFailureTrace(error: unknown): Record<string, unknown> {
  if (!(error instanceof InferenceFailure)) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const failure = error.inferenceError;
  return {
    error: failure.message,
    backend: failure.backend,
    status: failure.status,
    code: failure.code,
    retryable: failure.retryable,
    failureClass: failure.failureClass,
  };
}
