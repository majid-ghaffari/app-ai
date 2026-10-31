export interface PreviewApiContext {
  readonly fetch: typeof globalThis.fetch;
  readonly requestTimeoutMilliseconds: number;
  readonly token: string;
  readonly apiBaseUrl: string;
  readonly namespaceId: string;
  readonly accountId: string;
  readonly worker: string;
}
export type PreviewClaim =
  | { readonly state: 'created' | 'owned'; readonly id: string }
  | { readonly state: 'unrecorded'; readonly id: string; readonly reason: string }
  | { readonly state: 'misconfigured' | 'refused' | 'failed'; readonly reason: string };
export type PreviewDeletion =
  | { readonly state: 'absent' }
  | { readonly state: 'deleted' | 'gone'; readonly id: string }
  | { readonly state: 'misconfigured' | 'refused' | 'failed'; readonly reason: string };
export function readWorkerIdentity(wranglerToml: string): { accountId: string; worker: string };
export function ownerKey(previewId: string): string;
export function claimPreview(
  context: PreviewApiContext,
  claim: { name: string; tag: string; commit: string; nowUtc: () => string },
): Promise<PreviewClaim>;
export function deleteOwnedPreview(
  context: PreviewApiContext,
  name: string,
): Promise<PreviewDeletion>;
export function main(
  argv?: readonly string[],
  options?: {
    fetch?: typeof globalThis.fetch;
    env?: Readonly<Record<string, string | undefined>>;
    readWranglerToml?: () => string;
    log?: (message: string) => void;
    error?: (message: string) => void;
    nowUtc?: () => string;
    requestTimeoutMilliseconds?: number;
  },
): Promise<number>;
