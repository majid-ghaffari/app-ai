/**
 * Files API checksum dedup — a route-scoped contentHash → file_id cache.
 *
 * The Anthropic Files API does NOT dedup by content: re-uploading identical
 * bytes returns a brand-new `file_id`. This module computes a SHA-256 of the
 * payload bytes and, when a KV namespace is bound (`env.FILES_KV`), scopes the
 * mapping by tenant + provider account + file policy + compatible prompt groups
 * before reusing the stored `file_id`.
 * This collapses
 * repeated re-uploads of the same artifact (HTML / screenshots) across calls.
 *
 * GRACEFUL NO-OP: this internal dedup layer still falls back to a plain upload
 * when `env.FILES_KV` is absent. Public prompt-aware references are sealed,
 * self-contained metadata and do not use this eventually-consistent cache as
 * correctness authority.
 *
 * STALE-ID ROBUSTNESS: a provider deletes an object at its expiry, and a cached
 * file_id can also outlive its file through explicit deletion or an
 * API-key/workspace rotation. Two guards:
 *   1. The KV record carries a cap (`KV_RECORD_TTL_SECONDS`) and the provider's
 *      expiry shortens it, so a mapping never outlives its file.
 *   2. On a KV hit, the cached id is verified against the Files API metadata
 *      endpoint before reuse (`existingFileMetadata`). A 404 drops the stale
 *      record and falls through to a fresh upload — dedup never returns a dead
 *      file_id, so a later /chat request can't 400 on a missing file we vended.
 *
 * NOTE: file_id reuse still re-tokenizes the file content each request; the
 * token saving comes from pairing the file blocks with a `cache_control`
 * breakpoint (callers do this). Dedup here saves upload bandwidth/latency and
 * keeps the org under the Files API storage cap by avoiding orphan duplicates.
 */

import type { Env } from '../config';
import type { FilePolicy, ModelProfile, ProviderFileReference } from './inference-types';
import { InferenceFailure } from '../inference/adapter';
import { createInferenceFileService } from '../inference/factory';
import {
  MAX_REFERENCE_TTL_SECONDS,
  storedFileRoute,
  type StoredFileLocation,
} from '../inference/file-references';
import { silentLogger, type Logger } from './logger';

/**
 * The longest a route+hash→file_id KV record lives, in seconds (30 days). A
 * record's TTL is its file's remaining life when the provider reports an
 * expiry, never more than this cap, so a record never outlives its file and KV
 * growth stays bounded. The live metadata check is the hard guard; this is an
 * internal robustness constant, not a deploy-time tunable.
 */
export const KV_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Prefix of the `FILES_KV` keys, one per provider file id and with no expiry, that keep each upload
 * the provider stored without an expiry a reference can rely on and app-ai could not delete. A key is
 * `discard:<dedup key>:<file id>`, and the next upload of the same bytes on the same route deletes
 * the file and then its key.
 */
export const DISCARD_KEY_PREFIX = 'discard:';
const DISCARD_DELETE_ATTEMPTS = 2;
const DISCARD_WRITE_ATTEMPTS = 2;
const DISCARD_LIST_PAGE_SIZE = 100;

/** How long one stored-object delete may stay unsettled before it is abandoned as failed. */
export const STORED_FILE_DELETE_TIMEOUT_MILLISECONDS = 10_000;

/** The content forms `dedupUpload` accepts for hashing + upload. */
export type UploadContent = string | ArrayBuffer | Uint8Array | Blob;

export interface UploadFile {
  content: UploadContent;
  mimeType: string;
  filename: string;
}

export interface DedupUploadResult {
  reference: ProviderFileReference;
  deduped: boolean;
}

/** Fully resolved direct-provider route selected from a registered prompt group. */
export interface DedupFileRoute {
  readonly profile: ModelProfile;
  readonly policy: FilePolicy;
  readonly accountScope: string;
  readonly tenantScope: string;
  readonly compatibleGroups: readonly [string, ...string[]];
}

/**
 * Normalize arbitrary content to a `Uint8Array` of its bytes.
 * Accepts a string (UTF-8 encoded), ArrayBuffer, ArrayBufferView (Uint8Array),
 * or Blob.
 */
async function toBytes(content: UploadContent): Promise<Uint8Array> {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    return new Uint8Array(await content.arrayBuffer());
  }
  if (ArrayBuffer.isView(content)) {
    const view = content as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error('Unsupported content type for hashing');
}

/**
 * SHA-256 of the content bytes, as a lowercase hex string. Uses Web Crypto
 * (`crypto.subtle`), available in the Workers runtime and Node 18+/vitest.
 */
export async function sha256Hex(content: UploadContent): Promise<string> {
  const bytes = await toBytes(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Upload a file with content-hash dedup. On a KV hit, returns a complete internal
 * provider reference for the cached object. On a miss (or no KV binding), uploads
 * via the Files API and — if KV is bound — stores
 * `tenantScope:accountScope:policy:compatibleGroups:mimeType:hash →
 * { fileId, mediaType, createdAt }`.
 * Provider failures retain their normalized `InferenceFailure` identity so
 * callers never have to guess which backend rejected an upload.
 */
export async function dedupUpload(
  { content, mimeType, filename }: UploadFile,
  route: DedupFileRoute,
  env: Env,
  abortSignal?: AbortSignal,
  log: Logger = silentLogger,
): Promise<DedupUploadResult> {
  const hash = await sha256Hex(content);
  const storageKey = dedupStorageKey(route, mimeType, hash);
  const discardPrefix = `${DISCARD_KEY_PREFIX}${storageKey}:`;
  const filesKv = env.FILES_KV;

  if (filesKv) {
    const [cachedRead, discardsRead] = await Promise.allSettled([
      filesKv.get(storageKey),
      listDiscardKeys(filesKv, discardPrefix),
    ]);
    for (const read of [cachedRead, discardsRead]) {
      if (read.status === 'rejected') {
        log.warn('File dedup KV read failed; uploading directly', {
          error: read.reason instanceof Error ? read.reason.name : 'UnknownError',
        });
      }
    }
    if (discardsRead.status === 'fulfilled') {
      await retryDiscards(discardsRead.value, discardPrefix, route, env);
    }
    const cached = cachedRead.status === 'fulfilled' ? cachedRead.value : null;
    if (cached) {
      const stored = parseStoredFileMetadata(cached);
      // Verify the cached file still exists before reusing it — a stale id
      // (deleted file, key/workspace rotation, retention cleanup) would 404 a
      // later /chat request, so we never vend one. On a confirmed-gone id, drop
      // the record and fall through to a fresh upload + refresh.
      const metadata = stored
        ? await existingFileMetadata(stored.fileId, route, env, abortSignal)
        : null;
      if (stored && metadata && canBackNewReference(metadata, route.policy)) {
        log.info(`Dedup hit for ${filename} (hash ${hash.slice(0, 12)}…)`);
        return {
          reference: providerReference(
            stored.fileId,
            hash,
            { ...metadata, mediaType: stored.mediaType ?? metadata.mediaType },
            route,
          ),
          deduped: true,
        };
      }
      if (stored && metadata) {
        log.info(`Dedup entry for ${filename} expires too soon to reuse — re-uploading`);
      } else if (stored) {
        log.info(`Stale dedup entry for ${filename} — re-uploading`);
        await filesKv.delete(storageKey).catch(() => {});
      }
    }
  }

  const metadata = await upload({ content, mimeType, filename }, route, env, abortSignal);
  if (!canBackNewReference(metadata, route.policy)) {
    if (!(await deleteUpload(metadata.id, route, env))) {
      await recordDiscard(metadata.id, discardPrefix, env, log);
    }
    throw new InferenceFailure({
      backend: route.profile.provider,
      status: null,
      code: 'invalid_response',
      message: 'The provider stored the upload without an expiry a reference can rely on',
      retryable: true,
      failureClass: 'invalid-response',
    });
  }

  if (filesKv) {
    try {
      await filesKv.put(
        storageKey,
        JSON.stringify({
          fileId: metadata.id,
          mediaType: metadata.mediaType ?? mimeType,
          createdAt: Date.now(),
        }),
        {
          expirationTtl: fileMetadataTtlSeconds(metadata.expiresAt),
        },
      );
      log.info(`Stored ${filename} (hash ${hash.slice(0, 12)}…)`);
    } catch (error) {
      log.warn('File dedup KV write failed; returning the direct upload', {
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  return {
    reference: providerReference(metadata.id, hash, metadata, route),
    deduped: false,
  };
}

/** What one pass over a tenant's `FILES_KV` records left behind. */
export type TenantFileRelease = 'released' | 'more' | 'kept';

/**
 * Release the `FILES_KV` records one tenant owns — its dedup records and its `discard:` keys — and
 * the provider object each names, reading at most `limit` keys of each kind a call and starting no
 * delete once the clock reaches `deadline`, in epoch milliseconds. A record is removed once its
 * object is deleted or the provider reports it gone, and kept for the next call when that delete
 * fails. Answers `released` once the tenant has none left, `more` when the page limit or the
 * deadline left some unread, and `kept` when a delete failed. Only a tenant none of whose
 * references can be read again is released this way, because each object may still back one.
 */
export async function releaseTenantFiles(
  tenantScope: string,
  env: Env,
  limit: number,
  deadline: number,
): Promise<TenantFileRelease> {
  const filesKv = env.FILES_KV;
  if (!filesKv) return 'released';
  const recordPrefix = `${tenantScope}:`;
  const discardPrefix = `${DISCARD_KEY_PREFIX}${tenantScope}:`;
  const [records, discards] = await Promise.all([
    filesKv.list({ prefix: recordPrefix, limit }),
    filesKv.list({ prefix: discardPrefix, limit }),
  ]);
  let kept = false;
  for (const { name } of records.keys) {
    if (Date.now() >= deadline) return kept ? 'kept' : 'more';
    const stored = parseStoredFileMetadata((await filesKv.get(name)) ?? '');
    const location = parseDedupStorageKey(name.slice(recordPrefix.length));
    if (stored && location && !(await deleteStoredFile(location, stored.fileId, env))) {
      kept = true;
      continue;
    }
    await filesKv.delete(name);
  }
  for (const { name } of discards.keys) {
    if (Date.now() >= deadline) return kept ? 'kept' : 'more';
    const discarded = parseDiscardKey(name.slice(discardPrefix.length));
    if (discarded && !(await deleteStoredFile(discarded.location, discarded.fileId, env))) {
      kept = true;
      continue;
    }
    await filesKv.delete(name);
  }
  if (kept) return 'kept';
  return records.list_complete && discards.list_complete ? 'released' : 'more';
}

/**
 * Delete one stored provider object through the configured route that still reaches it. Answers
 * whether the object is gone, deleted now or reported missing; a route that no longer reaches it
 * or a failed delete answers `false`, so the caller keeps it for another attempt. A delete still
 * unsettled after `STORED_FILE_DELETE_TIMEOUT_MILLISECONDS` is aborted and answers `false` as
 * well, whether or not its transport honours the abort, so no caller waits on one indefinitely.
 */
export async function deleteStoredFile(
  location: StoredFileLocation,
  fileId: string,
  env: Env,
): Promise<boolean> {
  const controller = new AbortController();
  const timedOut = new Promise<false>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(false), { once: true });
  });
  const timeout = setTimeout(() => controller.abort(), STORED_FILE_DELETE_TIMEOUT_MILLISECONDS);
  try {
    return await Promise.race([
      deleteThroughRoute(location, fileId, env, controller.signal),
      timedOut,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteThroughRoute(
  location: StoredFileLocation,
  fileId: string,
  env: Env,
  abortSignal: AbortSignal,
): Promise<boolean> {
  try {
    const files = createInferenceFileService(env);
    const route = await storedFileRoute(location, env, files);
    if (!route) return false;
    await files.delete(route.profile, fileId, abortSignal);
    return true;
  } catch (error) {
    return error instanceof InferenceFailure && error.inferenceError.status === 404;
  }
}

function dedupStorageKey(route: DedupFileRoute, mimeType: string, hash: string): string {
  return [
    route.tenantScope,
    route.accountScope,
    route.policy.name,
    route.compatibleGroups.join(','),
    encodeURIComponent(mimeType),
    hash,
  ].join(':');
}

function parseDedupStorageKey(key: string): StoredFileLocation | null {
  const parts = key.split(':');
  const hash = parts.pop();
  const mediaType = parts.pop();
  const groups = parts.pop();
  const filePolicy = parts.pop();
  const accountScope = parts.join(':');
  if (!hash || !mediaType || !groups || !filePolicy || !accountScope) return null;
  return { accountScope, filePolicy, compatibleGroups: groups.split(',') };
}

function parseDiscardKey(
  key: string,
): { readonly location: StoredFileLocation; readonly fileId: string } | null {
  const separator = key.lastIndexOf(':');
  const fileId = key.slice(separator + 1);
  const location = separator > 0 ? parseDedupStorageKey(key.slice(0, separator)) : null;
  return location && fileId ? { location, fileId } : null;
}

/**
 * Whether `fileId` still resolves on the Files API. Returns true on a 200
 * metadata response, false on a 404 or malformed success. Transient failures
 * propagate: without fresh metadata the neutral layer cannot safely claim that
 * an expiring provider object is still present or mint a longer-lived reference.
 */
async function existingFileMetadata(
  fileId: string,
  route: DedupFileRoute,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<import('../inference/adapter').ProviderFileMetadata | null> {
  try {
    return await createInferenceFileService(env).getMetadata(route.profile, fileId, abortSignal);
  } catch (error) {
    if (error instanceof InferenceFailure) {
      if (error.inferenceError.failureClass === 'invalid-response') return null;
    }
    throw error;
  }
}

function canBackNewReference(
  metadata: import('../inference/adapter').ProviderFileMetadata,
  policy: FilePolicy,
): boolean {
  if (metadata.expiresAt === null) return policy.requestedLifetimeSeconds === null;
  const remaining = Math.floor((Date.parse(metadata.expiresAt) - Date.now()) / 1000);
  if (!Number.isFinite(remaining)) return false;
  return policy.requestedLifetimeSeconds === null
    ? remaining > 0
    : remaining >= MAX_REFERENCE_TTL_SECONDS;
}

async function deleteUpload(fileId: string, route: DedupFileRoute, env: Env): Promise<boolean> {
  const files = createInferenceFileService(env);
  for (let attempt = 0; attempt < DISCARD_DELETE_ATTEMPTS; attempt += 1) {
    try {
      await files.delete(route.profile, fileId);
      return true;
    } catch (error) {
      if (error instanceof InferenceFailure && error.inferenceError.status === 404) return true;
    }
  }
  return false;
}

async function listDiscardKeys(filesKv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await filesKv.list({
      prefix,
      limit: DISCARD_LIST_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    names.push(...page.keys.map((key) => key.name));
    if (page.list_complete) return names;
    cursor = page.cursor;
  }
}

async function retryDiscards(
  keys: readonly string[],
  discardPrefix: string,
  route: DedupFileRoute,
  env: Env,
): Promise<void> {
  for (const key of keys) {
    const fileId = key.slice(discardPrefix.length);
    if (!key.startsWith(discardPrefix) || fileId === '') continue;
    if (await deleteUpload(fileId, route, env)) {
      await env.FILES_KV?.delete(key).catch(() => undefined);
    }
  }
}

async function recordDiscard(
  fileId: string,
  discardPrefix: string,
  env: Env,
  log: Logger,
): Promise<void> {
  const filesKv = env.FILES_KV;
  for (let attempt = 0; filesKv && attempt < DISCARD_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await filesKv.put(
        `${discardPrefix}${fileId}`,
        JSON.stringify({ fileId, recordedAt: Date.now() }),
      );
      log.warn('An upload without a usable expiry could not be deleted; it is kept for retry');
      return;
    } catch (error) {
      log.warn('File discard KV write failed', {
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
  log.error('An upload without a usable expiry could neither be deleted nor kept for retry');
}

interface StoredFileMetadata {
  readonly fileId: string;
  readonly mediaType: string | null;
}

/**
 * Read the route metadata out of a stored KV value. Only the JSON record shape
 * is a hit; anything else is a miss that re-uploads, so a raw provider id is
 * never read out of storage as if it were a validated record.
 */
function parseStoredFileMetadata(value: string): StoredFileMetadata | null {
  let parsed: { fileId?: unknown; mediaType?: unknown } | null;
  try {
    parsed = JSON.parse(value) as { fileId?: unknown; mediaType?: unknown } | null;
  } catch {
    return null;
  }
  return parsed && typeof parsed.fileId === 'string'
    ? {
        fileId: parsed.fileId,
        mediaType: typeof parsed.mediaType === 'string' ? parsed.mediaType : null,
      }
    : null;
}

/** Perform the actual Files API upload; returns the new file_id. */
async function upload(
  { content, mimeType, filename }: UploadFile,
  route: DedupFileRoute,
  env: Env,
  abortSignal?: AbortSignal,
): Promise<import('../inference/adapter').ProviderUploadResult> {
  return createInferenceFileService(env).upload(
    route.profile,
    route.policy,
    await toBytes(content),
    filename,
    mimeType,
    abortSignal,
  );
}

/** Bound metadata retention to both the local cap and the provider's expiry. */
export function fileMetadataTtlSeconds(expiresAt: string | null): number {
  if (expiresAt === null) return KV_RECORD_TTL_SECONDS;
  const remaining = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
  // Cloudflare KV requires expiration TTLs greater than 60 seconds. Refuse an
  // upload too close to expiry instead of retaining metadata past the object.
  if (!Number.isFinite(remaining) || remaining <= 60) {
    throw new Error('Provider file expiry was invalid or too near');
  }
  return Math.min(KV_RECORD_TTL_SECONDS, remaining);
}

/** Build the internal route-bound reference retained behind a public opaque token. */
function providerReference(
  fileId: string,
  contentHash: string,
  metadata: import('../inference/adapter').ProviderFileMetadata,
  route: DedupFileRoute,
): ProviderFileReference {
  return {
    provider: route.profile.provider,
    accountScope: route.accountScope,
    tenantScope: route.tenantScope,
    filePolicy: route.policy.name,
    compatibleGroups: route.compatibleGroups,
    upstreamFileId: fileId,
    contentHash,
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    expiresAt: metadata.expiresAt,
  };
}
