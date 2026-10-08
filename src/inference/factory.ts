/** Adapter factory and canonical inference-service composition root. */

import type { Env } from '../config';
import type {
  FilePolicy,
  InferenceRequest,
  InferenceService,
  ModelProfile,
} from '../lib/inference-types';
import type {
  InferenceProviderAdapter,
  ProviderFileMetadata,
  ProviderUploadResult,
} from './adapter';
import type { Logger } from '../lib/logger';
import { AnthropicMessagesAdapter } from './adapters/anthropic';
import { OpenAIResponsesAdapter } from './adapters/openai';
import { GeminiGenerateContentAdapter } from './adapters/gemini';
import { CloudflareWorkersAiAdapter } from './adapters/cloudflare';
import { KimiChatCompletionsAdapter, MoonshotChatCompletionsAdapter } from './adapters/moonshot';
import { DefaultInferenceService } from './service';
import { resolveInferenceFileReferences, type StoredFileLocation } from './file-references';
import { filePolicyNamed } from './model-catalog';
import { completeWithinDeadline } from './deadline';

/** Construct the provider-neutral service for one worker request environment. */
export function createInferenceService(
  env: Env,
  tenantScope: string | null = null,
): InferenceService {
  const adapters = createAdapters(env);
  const files = createInferenceFileService(env);
  return new DefaultInferenceService(
    (request) => resolveAdapter(request, adapters),
    (request) => resolveInferenceFileReferences(request, env, files, tenantScope),
  );
}

/** Read the selected adapter's public continuation requirement without provider logic in handlers. */
export function requiresOrdinaryTurnContinuation(profile: ModelProfile, env: Env): boolean {
  return (
    resolveAdapter({ modelProfile: profile }, createAdapters(env))
      .requiresOrdinaryTurnContinuation === true
  );
}

function servesOneTurn(profile: ModelProfile, env: Env): boolean {
  return (
    resolveAdapter({ modelProfile: profile }, createAdapters(env)).offersContinuation === false
  );
}

/**
 * Why a request may not reach a route whose adapter keeps no conversation state between requests,
 * or `null` when it may. Such a route serves one turn: it takes no continuation, no earlier assistant
 * turn, tool call or tool result, and no caller tools — any `tools` value but an empty array, a
 * malformed one included — since a tool turn there could not be followed up. Checked on the public
 * request, before file resolution, attachments, Brain defaults or provider I/O.
 */
export function statelessRouteRefusal(
  profile: ModelProfile,
  env: Env,
  request: { readonly continuation: unknown; readonly messages: unknown; readonly tools?: unknown },
): string | null {
  if (!servesOneTurn(profile, env)) return null;
  const route = `The ${profile.provider} route keeps no conversation state between requests`;
  if (request.continuation !== undefined) {
    return `${route} and takes no inference continuation`;
  }
  if (holdsEarlierTurn(request.messages)) {
    return `${route}, so it serves one turn and takes no earlier assistant turn, tool call or tool result`;
  }
  if (
    request.tools !== undefined &&
    !(Array.isArray(request.tools) && request.tools.length === 0)
  ) {
    return `${route}, so it takes no caller tools whose calls would need a follow-up request`;
  }
  return null;
}

function holdsEarlierTurn(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (('role' in message && message.role === 'assistant') ||
          ('content' in message &&
            Array.isArray(message.content) &&
            message.content.some(
              (block: unknown) =>
                typeof block === 'object' &&
                block !== null &&
                'type' in block &&
                (block.type === 'tool_use' || block.type === 'tool_result'),
            ))),
    )
  );
}

/** Detect provider-required state loss from a public conversation before file/provider I/O. */
export function isRequiredContinuationMissing(
  profile: ModelProfile,
  env: Env,
  messages: unknown,
  continuation: unknown,
): boolean {
  return (
    continuation === undefined &&
    requiresOrdinaryTurnContinuation(profile, env) &&
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'role' in message &&
        message.role === 'assistant',
    )
  );
}

/** Bounded raw `/messages` passthrough for an absent or unregistered selector. */
export interface UnregisteredSelectorPassthroughService {
  complete(
    payload: Record<string, unknown>,
    abortSignal?: AbortSignal,
    log?: Logger,
  ): Promise<unknown>;
  countTokens(payload: Record<string, unknown>, abortSignal?: AbortSignal): Promise<number | null>;
}

/** Construct the isolated Anthropic passthrough surface. */
export function createUnregisteredSelectorPassthrough(
  env: Env,
): UnregisteredSelectorPassthroughService {
  const adapter = new AnthropicMessagesAdapter(env);
  return {
    complete: (payload, abortSignal, log) =>
      completeWithinDeadline('anthropic', abortSignal, (signal) =>
        adapter.completePassthrough(payload, signal, log),
      ),
    countTokens: (payload, abortSignal) => adapter.countPassthroughTokens(payload, abortSignal),
  };
}

/** Provider-neutral token estimation routed through the selected adapter. */
export interface InferenceDiagnosticsService {
  countTokens(request: InferenceRequest): Promise<number | null>;
}

/** Construct inference diagnostics through the adapter factory. */
export function createInferenceDiagnosticsService(
  env: Env,
  tenantScope: string | null = null,
): InferenceDiagnosticsService {
  const adapters = createAdapters(env);
  const files = createInferenceFileService(env);
  return {
    async countTokens(request) {
      const prepared = await resolveInferenceFileReferences(request, env, files, tenantScope);
      const adapter = resolveAdapter(prepared, adapters);
      return adapter.countTokens ? adapter.countTokens(prepared) : null;
    },
  };
}

/** Provider-neutral direct file operations used by inference preparation. */
export interface InferenceFileService {
  validateUpload(
    profile: ModelProfile,
    policy: FilePolicy,
    sizeBytes: number,
    filename: string,
    mediaType: string,
  ): void;
  scope(profile: ModelProfile, policy: FilePolicy): Promise<string>;
  getMetadata(
    profile: ModelProfile,
    id: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderFileMetadata | null>;
  upload(
    profile: ModelProfile,
    policy: FilePolicy,
    bytes: Uint8Array,
    filename: string,
    mediaType: string,
    abortSignal?: AbortSignal,
  ): Promise<ProviderUploadResult>;
  delete(profile: ModelProfile, id: string, abortSignal?: AbortSignal): Promise<void>;
  /**
   * Delete a stored object through the provider that holds it, whatever the current routing. An
   * object under a worker-managed policy is in app-ai's own storage and is deleted there, sending no
   * request and reading no provider key; any other is deleted only through the provider account
   * that stored it. Answers `false` when no configured account reaches it.
   */
  deleteStored(
    location: StoredFileLocation,
    id: string,
    abortSignal?: AbortSignal,
  ): Promise<boolean>;
}

/** Construct file operations through the same provider-adapter factory. */
export function createInferenceFileService(env: Env): InferenceFileService {
  const adapters = createAdapters(env);
  const adapterFor = (profile: ModelProfile) => resolveAdapter({ modelProfile: profile }, adapters);
  return {
    validateUpload(profile, policy, sizeBytes, filename, mediaType) {
      const adapter = adapterFor(profile);
      adapter.validateUpload?.({ policy, sizeBytes, filename, mediaType });
    },
    async scope(profile, policy) {
      const adapter = adapterFor(profile);
      if (!adapter.getFileScope) throw new Error(`${profile.name} does not support files`);
      return adapter.getFileScope(policy);
    },
    async getMetadata(profile, id, abortSignal) {
      const adapter = adapterFor(profile);
      if (!adapter.getFileMetadata) throw new Error(`${profile.name} does not support files`);
      return adapter.getFileMetadata(id, abortSignal);
    },
    async upload(profile, policy, bytes, filename, mediaType, abortSignal) {
      const adapter = adapterFor(profile);
      if (!adapter.uploadFile) throw new Error(`${profile.name} does not support file uploads`);
      return adapter.uploadFile({
        bytes,
        filename,
        mediaType,
        policy,
        ...(abortSignal ? { abortSignal } : {}),
      });
    },
    async delete(profile, id, abortSignal) {
      const adapter = adapterFor(profile);
      if (!adapter.deleteFile) throw new Error(`${profile.name} does not support file deletion`);
      await adapter.deleteFile(id, abortSignal);
    },
    async deleteStored(location, id, abortSignal) {
      const policy = filePolicyNamed(location.filePolicy);
      const adapter =
        policy === null
          ? undefined
          : adapters.find(
              (candidate) =>
                candidate.provider === policy.provider &&
                policy.compatibleApiFamilies.includes(candidate.apiFamily),
            );
      if (policy === null || !adapter?.deleteFile) return false;
      if (policy.lifecycle !== 'worker-managed') {
        if (!adapter.getFileScope) return false;
        if ((await adapter.getFileScope(policy)) !== location.accountScope) return false;
      }
      await adapter.deleteFile(id, abortSignal);
      return true;
    },
  };
}

/** Every constructed adapter, in the one place a provider is selected. */
function createAdapters(env: Env): readonly InferenceProviderAdapter[] {
  return [
    new AnthropicMessagesAdapter(env),
    new OpenAIResponsesAdapter(env),
    new MoonshotChatCompletionsAdapter(env),
    new KimiChatCompletionsAdapter(env),
    new GeminiGenerateContentAdapter(env),
    new CloudflareWorkersAiAdapter(env),
  ];
}

function resolveAdapter(
  request: Pick<InferenceRequest, 'modelProfile'>,
  adapters: readonly InferenceProviderAdapter[],
): InferenceProviderAdapter {
  const profile = request.modelProfile;
  const adapter = adapters.find(
    (candidate) =>
      candidate.provider === profile.provider && candidate.apiFamily === profile.apiFamily,
  );
  if (!adapter) {
    throw new Error(
      `No inference adapter for ${profile.provider}/${profile.apiFamily} (${profile.name})`,
    );
  }
  return adapter;
}
