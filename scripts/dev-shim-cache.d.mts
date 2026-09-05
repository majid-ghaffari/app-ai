/** One recorded fulfilment, as written to and read back from the cache directory. */
interface ShimCacheEntry {
  readonly cacheFormat?: unknown;
  readonly key?: unknown;
  readonly transport?: unknown;
  readonly model?: unknown;
  readonly contextId?: unknown;
  readonly attachmentIdentity?: unknown;
  readonly recordedAt?: unknown;
  readonly label?: unknown;
  readonly response?: unknown;
  readonly frames?: unknown;
}

/** What `deriveCacheKey` hashes: the request plus everything that changes its answer. */
interface ShimCacheKeyRequest {
  readonly body: unknown;
  readonly model: string;
  readonly contextId: string;
  readonly transport: string;
  readonly attachmentIdentity?: string;
  readonly attachmentBytes?: ((fileId: string) => unknown) | undefined;
}

interface ShimNormalizeOptions {
  readonly attachmentIdentity?: string;
  readonly attachmentBytes?: ((fileId: string) => unknown) | undefined;
}

export const CACHE_FORMAT_VERSION: number;
export function cacheEnabled(env?: Readonly<Record<string, string | undefined>>): boolean;
export function cacheDirectory(env?: Readonly<Record<string, string | undefined>>): string;
export function attachmentIdentityMode(env?: Readonly<Record<string, string | undefined>>): string;
export function cacheResetRequested(env?: Readonly<Record<string, string | undefined>>): boolean;
export function clearCacheDirectory(directory: string): void;
export function normalizeRequestBody(body: unknown, options?: ShimNormalizeOptions): unknown;
export function canonicalJson(value: unknown): string;
export function deriveCacheKey(request: ShimCacheKeyRequest): string;
export function cacheLabel(body: unknown, limit?: number): string;
export function cacheEntryPath(directory: string, key: string): string;
export function readCacheEntry(
  directory: string,
  key: string,
  transport: string,
  onUnusable?: (reason: string) => void,
): ShimCacheEntry | null;
export function writeCacheEntry(directory: string, key: string, entry: unknown): string;
