/** Metadata-only opaque file-reference minting, resolution, and route validation. */

import type { Env } from '../config';
import type {
  FilePolicy,
  InferenceContent,
  InferenceMessage,
  InferenceRequest,
  ModelProfile,
  OpaqueFileReference,
  ProviderFileReference,
} from '../lib/inference-types';
import {
  getFileRouteGroup,
  getGroupModelRoute,
  getSystemPrompt,
  isPromptGroupName,
  listFileRouteGroups,
  type PromptGroupName,
  type PromptName,
} from '../prompt-registry';
import { PROVIDER_NAMES } from './model-catalog';
import { WorkerError } from '../lib/responses';
import { deriveSealingKey, openToken, sealToken, type SealingPurpose } from './token-sealing';

const PUBLIC_REFERENCE_PREFIX = 'file_ref_v1_';
const PUBLIC_REFERENCE_PATTERN = /^file_ref_v1_[A-Za-z0-9_-]+$/;
/**
 * The longest a sealed reference stays openable. Studio's client-side tile cache
 * gives up after 14 days, so it always forgets a reference before the worker
 * refuses it; a provider expiry earlier than this bounds the reference first.
 * Dedup reuses an object under a policy with a requested lifetime only while it
 * has this long left, so such a reference always runs its full length.
 */
export const MAX_REFERENCE_TTL_SECONDS = 15 * 24 * 60 * 60;
/** The reference envelope's own key, and the tenant pseudonym's — one salt, two infos, two keys. */
const REFERENCE_SEALING_PURPOSE: SealingPurpose = {
  salt: 'app-ai:file-references:v1',
  info: 'opaque-token-encryption',
};
const TENANT_SCOPE_PURPOSE: SealingPurpose = {
  salt: 'app-ai:file-references:v1',
  info: 'tenant-scope-hmac',
};
const PROVIDERS = new Set<string>(PROVIDER_NAMES);
export const GLOBAL_REGISTRY_ATTACHMENT_TENANT_SCOPE = 'global:registry-attachment';

/** A complete route resolved from one registered prompt before provider I/O. */
export interface ResolvedFileRoute {
  readonly prompt: PromptName;
  readonly group: string;
  readonly profile: ModelProfile;
  readonly policy: FilePolicy;
  readonly accountScope: string;
  readonly tenantScope: string;
  readonly compatibleGroups: readonly [string, ...string[]];
}

interface SealedReferenceEnvelope {
  readonly version: 1;
  readonly expiresAt: string;
  readonly reference: ProviderFileReference;
}

/** Minimal provider-file service needed to resolve route account ownership. */
export interface FileReferenceScopeService {
  scope(profile: ModelProfile, policy: FilePolicy): Promise<string>;
}

/** Validate/import the reference-sealing key before any provider upload begins. */
export async function preflightFileReferenceSealing(env: Env): Promise<void> {
  await importReferenceKey(env);
}

/** Resolve a registered prompt to its direct provider/account/file-policy route. */
export async function resolvePromptFileRoute(
  prompt: PromptName,
  env: Env,
  files: FileReferenceScopeService,
  tenantScope: string,
): Promise<ResolvedFileRoute> {
  const entry = getSystemPrompt(prompt, env);
  const routeGroup = getFileRouteGroup(entry.group);
  // The route belongs to the group that OWNS it, so a cascade whose groups share
  // one file route uploads the evidence once and mints one reference every
  // sharing group accepts.
  const { profile, policy } = getGroupModelRoute(routeGroup, env);
  const accountScope = await files.scope(profile, policy);
  const compatibleGroups = listFileRouteGroups(routeGroup);
  const [first, ...rest] = compatibleGroups;
  if (!first) throw new Error(`File route ${routeGroup} has no compatible group`);
  return {
    prompt,
    group: routeGroup,
    profile,
    policy,
    accountScope,
    tenantScope,
    compatibleGroups: [first, ...rest],
  };
}

/**
 * Seal route metadata into an opaque authenticated token with no exposed authority.
 *
 * The shared registry-attachment scope belongs to no caller and is exempt from
 * the tenant check every other reference passes, so it is refused here: a public
 * token carrying it would be openable by every tenant. Registry attachments stay
 * internal `provider-file` sources and never leave the worker as a reference.
 */
export async function mintOpaqueFileReference(
  reference: ProviderFileReference,
  env: Env,
): Promise<OpaqueFileReference> {
  if (reference.tenantScope === GLOBAL_REGISTRY_ATTACHMENT_TENANT_SCOPE) {
    throw new Error('A registry-attachment reference is never minted as a public reference');
  }
  const ttl = referenceTtlSeconds(reference.expiresAt);
  const envelope: SealedReferenceEnvelope = {
    version: 1,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    reference,
  };
  const id = await sealToken(
    PUBLIC_REFERENCE_PREFIX,
    await importReferenceKey(env),
    JSON.stringify(envelope),
  );
  return { id, type: 'file' };
}

/**
 * Open a sealed reference for a file operation that carries NO destination
 * prompt, binding it to the caller's own tenant.
 *
 * The route the bytes travelled is sealed inside the token, so the operation
 * reads its provider from there rather than assuming one. A reference minted
 * for another tenant — or the shared registry-attachment scope, which belongs to
 * no caller — is refused, so holding a token is not by itself authority over
 * the object behind it.
 */
export async function openOwnedFileReference(
  opaqueId: string,
  env: Env,
  tenantScope: string,
): Promise<ProviderFileReference> {
  if (!PUBLIC_REFERENCE_PATTERN.test(opaqueId)) {
    throw new WorkerError('Invalid opaque file reference', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  let envelope: SealedReferenceEnvelope;
  try {
    envelope = await openReferenceEnvelope(opaqueId, await importReferenceKey(env));
  } catch {
    throw new WorkerError('Opaque file reference was invalid or expired', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  const expiresAt = envelope.reference.expiresAt;
  if (
    Date.parse(envelope.expiresAt) <= Date.now() ||
    (expiresAt !== null && !(Date.parse(expiresAt) > Date.now()))
  ) {
    throw new WorkerError('Opaque file reference was invalid or expired', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  if (envelope.reference.tenantScope !== tenantScope) {
    throw new WorkerError('File reference does not belong to this tenant', {
      status: 403,
      exceptionType: 'UnauthorizedAccessException',
    });
  }
  return envelope.reference;
}

/**
 * The prompt group that OWNS a sealed reference's provider file route — the one
 * group in its compatible set that borrows no other group's route. That group's
 * configured route is where the object actually lives.
 */
export function fileReferenceRouteGroup(reference: ProviderFileReference): PromptGroupName {
  for (const group of reference.compatibleGroups) {
    if (isPromptGroupName(group) && getFileRouteGroup(group) === group) return group;
  }
  throw new WorkerError('File reference names no registered provider file route', {
    status: 400,
    exceptionType: 'ArgumentException',
  });
}

/** Where a stored provider object lives, as a sealed reference or a dedup record names it. */
export interface StoredFileLocation {
  readonly accountScope: string;
  readonly filePolicy: string;
  readonly compatibleGroups: readonly string[];
}

/** Resolve one public reference and reject route mismatches before adapter/provider I/O. */
export async function resolveOpaqueFileReference(
  opaque: OpaqueFileReference,
  request: Pick<InferenceRequest, 'promptGroup' | 'modelProfile' | 'filePolicy'>,
  env: Env,
  files: FileReferenceScopeService,
  tenantScope: string | null = null,
): Promise<ProviderFileReference> {
  if (!PUBLIC_REFERENCE_PATTERN.test(opaque.id)) {
    throw invalidReference('Invalid opaque file reference');
  }
  const key = await importReferenceKey(env);
  let envelope: SealedReferenceEnvelope;
  try {
    envelope = await openReferenceEnvelope(opaque.id, key);
  } catch {
    throw invalidReference('Opaque file reference was invalid or expired');
  }
  if (Date.parse(envelope.expiresAt) <= Date.now()) {
    throw invalidReference('Opaque file reference was invalid or expired');
  }
  const accountScope = await files.scope(request.modelProfile, request.filePolicy);
  validateReferenceRoute(envelope.reference, request, accountScope, tenantScope);
  return envelope.reference;
}

/** Resolve every public file input in a canonical request before selecting an adapter. */
export async function resolveInferenceFileReferences(
  request: InferenceRequest,
  env: Env,
  files: FileReferenceScopeService,
  tenantScope: string | null = null,
): Promise<InferenceRequest> {
  return {
    ...request,
    messages: await resolveInferenceMessageFileReferences(
      request.messages,
      request,
      env,
      files,
      tenantScope,
    ),
  };
}

/** Resolve message file inputs against a frozen route before other provider work begins. */
export async function resolveInferenceMessageFileReferences(
  messages: readonly InferenceMessage[],
  request: Pick<InferenceRequest, 'promptGroup' | 'modelProfile' | 'filePolicy'>,
  env: Env,
  files: FileReferenceScopeService,
  tenantScope: string | null = null,
): Promise<InferenceMessage[]> {
  const accountScope = await files.scope(request.modelProfile, request.filePolicy);
  return Promise.all(
    messages.map(
      async (message): Promise<InferenceMessage> => ({
        ...message,
        content: await Promise.all(
          message.content.map((content) =>
            resolveContent(content, request, env, files, accountScope, tenantScope),
          ),
        ),
      }),
    ),
  );
}

async function resolveContent(
  content: InferenceContent,
  request: Pick<InferenceRequest, 'promptGroup' | 'modelProfile' | 'filePolicy'>,
  env: Env,
  files: FileReferenceScopeService,
  accountScope: string,
  tenantScope: string | null,
): Promise<InferenceContent> {
  if (content.type === 'image' || content.type === 'document') {
    if (content.source.type === 'file') {
      return {
        ...content,
        source: {
          type: 'provider-file',
          reference: await resolveOpaqueFileReference(
            content.source.reference,
            request,
            env,
            files,
            tenantScope,
          ),
        },
      };
    }
    if (content.source.type === 'provider-file') {
      validateReferenceRoute(content.source.reference, request, accountScope, tenantScope);
      return content;
    }
    if (content.type === 'document' && content.source.type === 'content') {
      if (typeof content.source.content === 'string') return content;
      return {
        ...content,
        source: {
          ...content.source,
          content: await Promise.all(
            content.source.content.map(async (nested) => {
              const resolved = await resolveContent(
                nested,
                request,
                env,
                files,
                accountScope,
                tenantScope,
              );
              if (resolved.type !== 'text' && resolved.type !== 'image') {
                throw invalidReference('Document content resolved to an invalid block');
              }
              return resolved;
            }),
          ),
        },
      };
    }
    return content;
  }
  if (content.type === 'tool-result') {
    return {
      ...content,
      content: await Promise.all(
        content.content.map(async (nested) => {
          const resolved = await resolveContent(
            nested,
            request,
            env,
            files,
            accountScope,
            tenantScope,
          );
          if (
            resolved.type !== 'text' &&
            resolved.type !== 'image' &&
            resolved.type !== 'document'
          ) {
            throw invalidReference('Tool result resolved to an invalid block');
          }
          return resolved;
        }),
      ),
    };
  }
  return content;
}

function validateReferenceRoute(
  reference: ProviderFileReference,
  request: Pick<InferenceRequest, 'promptGroup' | 'modelProfile' | 'filePolicy'>,
  accountScope: string,
  tenantScope: string | null,
): void {
  const profile = request.modelProfile;
  const policy = request.filePolicy;
  if (
    reference.tenantScope !== GLOBAL_REGISTRY_ATTACHMENT_TENANT_SCOPE &&
    (tenantScope === null || reference.tenantScope !== tenantScope)
  ) {
    throw foreignTenantReference();
  }
  if (
    reference.provider !== profile.provider ||
    reference.accountScope !== accountScope ||
    reference.filePolicy !== policy.name ||
    policy.provider !== profile.provider ||
    !policy.compatibleApiFamilies.includes(profile.apiFamily) ||
    !reference.compatibleGroups.includes(request.promptGroup)
  ) {
    throw invalidReference('File reference does not belong to the selected prompt route');
  }
  if (reference.expiresAt !== null) {
    const expiresAt = Date.parse(reference.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw invalidReference('File reference was missing or expired');
    }
  }
}

async function openReferenceEnvelope(id: string, key: CryptoKey): Promise<SealedReferenceEnvelope> {
  const envelope = JSON.parse(await openToken(PUBLIC_REFERENCE_PREFIX, key, id)) as unknown;
  if (!isSealedReferenceEnvelope(envelope)) throw new Error('invalid envelope');
  return envelope;
}

function isSealedReferenceEnvelope(value: unknown): value is SealedReferenceEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    typeof envelope.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(envelope.expiresAt)) ||
    !envelope.reference ||
    typeof envelope.reference !== 'object'
  ) {
    return false;
  }
  const reference = envelope.reference as Record<string, unknown>;
  return (
    PROVIDERS.has(reference.provider as string) &&
    typeof reference.accountScope === 'string' &&
    reference.accountScope.length > 0 &&
    typeof reference.tenantScope === 'string' &&
    reference.tenantScope.length > 0 &&
    typeof reference.filePolicy === 'string' &&
    reference.filePolicy.length > 0 &&
    Array.isArray(reference.compatibleGroups) &&
    reference.compatibleGroups.length > 0 &&
    reference.compatibleGroups.every((group) => typeof group === 'string' && group.length > 0) &&
    typeof reference.upstreamFileId === 'string' &&
    reference.upstreamFileId.length > 0 &&
    typeof reference.contentHash === 'string' &&
    reference.contentHash.length > 0 &&
    (reference.mediaType === null || typeof reference.mediaType === 'string') &&
    (reference.sizeBytes === null ||
      (typeof reference.sizeBytes === 'number' &&
        Number.isSafeInteger(reference.sizeBytes) &&
        reference.sizeBytes >= 0)) &&
    (reference.expiresAt === null || typeof reference.expiresAt === 'string')
  );
}

async function importReferenceKey(env: Env): Promise<CryptoKey> {
  return deriveSealingKey(env, REFERENCE_SEALING_PURPOSE, 'AES-GCM', ['encrypt', 'decrypt']);
}

/** Key a validated context credential into a non-dictionary-testable tenant pseudonym. */
export async function fileTenantScope(contextId: string | null, env: Env): Promise<string | null> {
  if (!contextId) return null;
  return await tenantPseudonym(`context-id:${contextId}`, env);
}

/**
 * Key a validated scoped audit session into its own tenant pseudonym. An audit
 * session authenticates by bearer token and carries no merchant context-ID, so
 * its uploads live in a namespace of their own: a reference minted for an audit
 * session can never be replayed by a merchant tenant, nor the reverse.
 */
export async function auditFileTenantScope(sessionIdentifier: string, env: Env): Promise<string> {
  return await tenantPseudonym(`audit-session:${sessionIdentifier}`, env);
}

async function tenantPseudonym(identity: string, env: Env): Promise<string> {
  const digest = await crypto.subtle.sign(
    'HMAC',
    await deriveSealingKey(env, TENANT_SCOPE_PURPOSE, 'HMAC', ['sign']),
    new TextEncoder().encode(identity),
  );
  return `tenant:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function referenceTtlSeconds(expiresAt: string | null): number {
  if (expiresAt === null) return MAX_REFERENCE_TTL_SECONDS;
  const remaining = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new Error('Provider file expiry was invalid or elapsed');
  }
  return Math.min(MAX_REFERENCE_TTL_SECONDS, remaining);
}

/**
 * A reference the caller supplied that cannot open: client input, answered as
 * Brain's `ArgumentException`, never as a provider exception — no provider was
 * consulted, and a client that classifies `*ApiException` as terminal must not
 * give up on a request it can correct.
 */
function invalidReference(message: string): WorkerError {
  return new WorkerError(message, { status: 400, exceptionType: 'ArgumentException' });
}

/** A reference sealed for another tenant, answered as the same 403 `DELETE /files/{id}` gives. */
function foreignTenantReference(): WorkerError {
  return new WorkerError('File reference does not belong to this tenant', {
    status: 403,
    exceptionType: 'UnauthorizedAccessException',
  });
}
