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
 * STALE-ID ROBUSTNESS: Files persist until explicitly deleted (no Anthropic-side
 * expiry), but a cached file_id can still outlive its file — explicit deletion,
 * an API-key/workspace rotation, or eventual data-retention cleanup. Two guards:
 *   1. The KV record carries a conservative cap (`KV_RECORD_TTL_SECONDS`) and an
 *      earlier provider expiry shortens it, so mappings never outlive the file.
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
import { silentLogger, type Logger } from './logger';

/**
 * TTL on the route+hash→file_id KV record, in seconds (30 days). Files themselves
 * persist until explicitly deleted, so this is conservatively SHORTER than the
 * file's effective lifetime: a record that survives past common churn (key
 * rotation, manual cleanup) ages out rather than risking a stale-id hit, while
 * still covering the real reuse window (a placement session's repeated calls on
 * the same page — seconds to hours). The `fileExists` check is the hard guard;
 * the TTL is belt-and-suspenders that also bounds KV growth. An internal
 * robustness constant paired with that guard — not a deploy-time tunable.
 */
export const KV_RECORD_TTL_SECONDS = 30 * 24 * 60 * 60;

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
 * An upload failure carrying the upstream Files API status, so the /files
 * handler can preserve its status-specific UX (e.g. the beta-access hint on a
 * 500) while non-upstream failures stay generic.
 */
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
  const compatibleGroupKey = route.compatibleGroups.join(',');
  const storageKey = `${route.tenantScope}:${route.accountScope}:${route.policy.name}:${compatibleGroupKey}:${encodeURIComponent(mimeType)}:${hash}`;
  const filesKv = env.FILES_KV;

  if (filesKv) {
    let cached: string | null = null;
    try {
      cached = await filesKv.get(storageKey);
    } catch (error) {
      log.warn('File dedup KV read failed; uploading directly', {
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    if (cached) {
      const stored = parseStoredFileMetadata(cached);
      // Verify the cached file still exists before reusing it — a stale id
      // (deleted file, key/workspace rotation, retention cleanup) would 404 a
      // later /chat request, so we never vend one. On a confirmed-gone id, drop
      // the record and fall through to a fresh upload + refresh.
      const metadata = stored
        ? await existingFileMetadata(stored.fileId, route, env, abortSignal)
        : null;
      if (stored && metadata) {
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
      if (stored) {
        log.info(`Stale dedup entry for ${filename} — re-uploading`);
        await filesKv.delete(storageKey).catch(() => {});
      }
    }
  }

  const metadata = await upload({ content, mimeType, filename }, route, env, abortSignal);

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
