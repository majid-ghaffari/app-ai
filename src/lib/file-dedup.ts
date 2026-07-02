/**
 * Files API checksum dedup — a contentHash → file_id cache in front of uploads.
 *
 * The Anthropic Files API does NOT dedup by content: re-uploading identical
 * bytes returns a brand-new `file_id`. This module computes a SHA-256 of the
 * payload bytes and, when a KV namespace is bound (`env.FILES_KV`), reuses the
 * stored `file_id` on a hash hit instead of re-uploading. This collapses
 * repeated re-uploads of the same artifact (HTML / screenshots) across calls.
 *
 * GRACEFUL NO-OP: when `env.FILES_KV` is absent (KV not yet provisioned), this
 * falls back to a plain upload — the live path keeps working unchanged. This is
 * the one deliberately OPTIONAL binding (src/config.ts): its absence changes
 * behavior explicitly and documentedly, not through a hidden default.
 *
 * STALE-ID ROBUSTNESS: Files persist until explicitly deleted (no Anthropic-side
 * expiry), but a cached file_id can still outlive its file — explicit deletion,
 * an API-key/workspace rotation, or eventual data-retention cleanup. Two guards:
 *   1. The KV record carries a conservative TTL (`KV_RECORD_TTL_SECONDS`) so old
 *      hash→id mappings age out on their own, well inside the file's lifetime.
 *   2. On a KV hit, the cached id is verified against the Files API metadata
 *      endpoint before reuse (`fileExists`). A 404 (file gone) drops the stale
 *      record and falls through to a fresh upload — dedup never returns a dead
 *      file_id, so a later /chat request can't 400 on a missing file we vended.
 *
 * NOTE: file_id reuse still re-tokenizes the file content each request; the
 * token saving comes from pairing the file blocks with a `cache_control`
 * breakpoint (callers do this). Dedup here saves upload bandwidth/latency and
 * keeps the org under the Files API storage cap by avoiding orphan duplicates.
 */

import * as anthropic from './anthropic';
import type { Env } from '../config';
import { createLogger } from './logger';

const log = createLogger('FileDedup');

/**
 * TTL on the hash→file_id KV record, in seconds (30 days). Files themselves
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
  fileId: string;
  deduped: boolean;
}

/**
 * An upload failure carrying the upstream Files API status, so the /files
 * handler can preserve its status-specific UX (e.g. the beta-access hint on a
 * 500) while non-upstream failures stay generic.
 */
export class UploadError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
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
 * Upload a file with content-hash dedup. On a KV hit, returns the cached
 * `file_id` without touching the network. On a miss (or no KV binding), uploads
 * via the Files API and — if KV is bound — stores `hash → { fileId, createdAt }`.
 * Throws `UploadError` if the upload fails (the live caller catches + skips the
 * attachment).
 */
export async function dedupUpload(
  { content, mimeType, filename }: UploadFile,
  env: Env,
): Promise<DedupUploadResult> {
  const hash = await sha256Hex(content);
  const filesKv = env.FILES_KV;

  if (filesKv) {
    const cached = await filesKv.get(hash);
    if (cached) {
      const fileId = parseStoredFileId(cached);
      // Verify the cached file still exists before reusing it — a stale id
      // (deleted file, key/workspace rotation, retention cleanup) would 404 a
      // later /chat request, so we never vend one. On a confirmed-gone id, drop
      // the record and fall through to a fresh upload + refresh.
      if (fileId && (await fileExists(fileId, env))) {
        log.info(`Dedup hit for ${filename} (hash ${hash.slice(0, 12)}…) → ${fileId}`);
        return { fileId, deduped: true };
      }
      if (fileId) {
        log.info(`Stale dedup id for ${filename} (${fileId} gone) — re-uploading`);
        await filesKv.delete(hash).catch(() => {});
      }
    }
  }

  const fileId = await upload({ content, mimeType, filename }, env);

  if (filesKv) {
    await filesKv.put(hash, JSON.stringify({ fileId, createdAt: Date.now() }), {
      expirationTtl: KV_RECORD_TTL_SECONDS,
    });
    log.info(`Stored ${filename} (hash ${hash.slice(0, 12)}…) → ${fileId}`);
  }

  return { fileId, deduped: false };
}

/**
 * Whether `fileId` still resolves on the Files API. Returns true on a 200
 * metadata response, false on a 404. On any other status or a network error we
 * return `true` (assume present) so a transient Files-API blip doesn't force a
 * needless re-upload — the downstream request would surface a real failure.
 */
async function fileExists(fileId: string, env: Env): Promise<boolean> {
  try {
    const response = await anthropic.getFileMetadata(fileId, env);
    return response.status !== 404;
  } catch {
    return true;
  }
}

/** Read the file_id out of a stored KV value (JSON `{fileId,…}` or a bare id). */
function parseStoredFileId(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as { fileId?: unknown } | null;
    return parsed && typeof parsed.fileId === 'string' ? parsed.fileId : null;
  } catch {
    // Tolerate a bare file_id string written by an earlier format.
    return value.startsWith('file_') ? value : null;
  }
}

/** Perform the actual Files API upload; returns the new file_id. */
async function upload({ content, mimeType, filename }: UploadFile, env: Env): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([content], { type: mimeType });
  formData.append('file', blob, filename);

  const response = await anthropic.uploadFile(formData, env);
  if (response.status !== 200) {
    const errorData = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new UploadError(
      errorData.error?.message || `upload failed (${response.status})`,
      response.status,
    );
  }
  const { id } = (await response.json()) as { id: string };
  return id;
}
