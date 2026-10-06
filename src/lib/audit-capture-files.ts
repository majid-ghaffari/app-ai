import type { Env } from '../config';
import {
  auditFileTenantScope,
  openOwnedFileReference,
  type StoredFileLocation,
} from '../inference/file-references';
import { providerDeletesAtExpiry } from '../inference/model-catalog';
import { base64UrlEncode } from '../inference/token-sealing';
import { deleteStoredFile, releaseTenantFiles, type TenantFileRelease } from './file-dedup';

/** One provider object a Grader upload created, as its session records it for deletion. */
export interface AuditCaptureFile extends StoredFileLocation {
  readonly upstreamFileId: string;
  /** When the provider deletes the object itself, or `null` when it keeps it until deleted. */
  readonly expiresAt: string | null;
}

/**
 * The provider objects behind one upload's public references, each opened under the tenant of the
 * session that uploaded it, so a reference minted for any other tenant is refused.
 */
export async function auditCaptureFiles(
  references: readonly string[],
  sessionIdentifier: string,
  env: Env,
): Promise<AuditCaptureFile[]> {
  const tenantScope = await auditFileTenantScope(sessionIdentifier, env);
  const captures = new Map<string, AuditCaptureFile>();
  for (const reference of new Set(references)) {
    const opened = await openOwnedFileReference(reference, env, tenantScope);
    const capture: AuditCaptureFile = {
      accountScope: opened.accountScope,
      filePolicy: opened.filePolicy,
      compatibleGroups: opened.compatibleGroups,
      upstreamFileId: opened.upstreamFileId,
      expiresAt: opened.expiresAt,
    };
    captures.set(await auditCaptureFileName(capture), capture);
  }
  return [...captures.values()];
}

/** A short name for one capture file that is the same however many uploads reused its object. */
export async function auditCaptureFileName(file: AuditCaptureFile): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([file.accountScope, file.filePolicy, file.upstreamFileId]),
    ),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Whether a capture file is gone: past the expiry at which its provider deleted it, or deleted
 * now, or reported missing by its provider. Worker-managed evidence is always deleted explicitly,
 * because its expiry ends its reference and not the stored object. `false` keeps the file for
 * another attempt.
 */
export async function releaseAuditCaptureFile(file: AuditCaptureFile, env: Env): Promise<boolean> {
  const expired = file.expiresAt !== null && !(Date.parse(file.expiresAt) > Date.now());
  if (expired && providerDeletesAtExpiry(file.filePolicy)) return true;
  return deleteStoredFile(file, file.upstreamFileId, env);
}

/**
 * Release the `FILES_KV` dedup records and `discard:` keys a Grader session's uploads left, and
 * the provider object each names, at most `limit` keys of each kind a call and starting no delete
 * once the clock reaches `deadline`, in epoch milliseconds. A failure to reach `FILES_KV` keeps
 * them for another attempt.
 */
export async function releaseAuditSessionDedupRecords(
  sessionIdentifier: string,
  env: Env,
  limit: number,
  deadline: number,
): Promise<TenantFileRelease> {
  try {
    return await releaseTenantFiles(
      await auditFileTenantScope(sessionIdentifier, env),
      env,
      limit,
      deadline,
    );
  } catch {
    return 'kept';
  }
}
