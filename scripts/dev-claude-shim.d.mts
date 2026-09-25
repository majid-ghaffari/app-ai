interface ShimBlock {
  readonly type: string;
  readonly text?: string;
  readonly source: Readonly<Record<string, unknown>>;
}

interface ShimSdkMessage {
  readonly type: string;
  readonly message: {
    readonly role: string;
    readonly content: Array<{ readonly type: string; readonly text?: string }>;
  };
  readonly parent_tool_use_id: null;
}

interface ShimFilePart {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: { toString(encoding?: string): string };
}

interface ShimStoredFile {
  readonly id: string;
  readonly mime_type: string;
  readonly filename: string;
  readonly data: { toString(encoding?: string): string };
  readonly created_at: string;
}
/** What the message handlers write a fulfilment onto. */
interface ShimWritableResponse {
  readonly writableEnded?: boolean;
  writeHead(status: number, headers: Readonly<Record<string, string | number>>): void;
  write(value: string): boolean | void;
  end(value?: string): void;
}

/** The `http.IncomingMessage` surface the shim's router touches. */
interface ShimRequest {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly aborted?: boolean;
  once(event: string, listener: () => void): unknown;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

/** The `http.ServerResponse` surface the shim's router touches: writing plus cache marking. */
interface ShimResponse extends ShimWritableResponse {
  readonly headersSent: boolean;
  once(event: string, listener: () => void): unknown;
  setHeader(name: string, value: string): void;
}

/** The resolved record/replay cache context for one fulfilment, or null when disabled. */
interface ShimCacheContext {
  readonly key: string;
  readonly transport: string;
  readonly contextId: string;
  readonly attachmentIdentity: string;
  readonly directory: string;
}

export const CACHE_HEADER: string;
export function handleHttp(request: ShimRequest, response: ShimResponse): Promise<void>;
export function cacheContextFor(
  body: Readonly<Record<string, unknown>>,
  contextId: string,
  transport: string,
): ShimCacheContext | null;
export function isPersonalizerTool(value: string): boolean;
export function systemToString(value: unknown): string | undefined;
export function rehydrateBlock(value: unknown): ShimBlock;
export function normalizeContent(value: unknown): ShimBlock[];
export function buildPromptMessages(value: unknown): AsyncGenerator<ShimSdkMessage>;
export function estimateTokens(value: unknown): number;
export function bareToolName(value: string): string;
export function clientToolNamesFrom(value: unknown): string[];
export function clientToolShape(value: unknown): Record<string, { isOptional(): boolean }>;
export function buildQueryOptions(
  body: unknown,
  contextId: string,
  abortController?: AbortController,
): { options: Readonly<Record<string, unknown>>; clientToolNames: string[] };
export function stripCodeFence(value: string): string;
export function usageFrom(value: unknown): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};
export function extractFilePart(value: unknown, boundary: string): ShimFilePart;
export function assertDevAiChannel(env: Readonly<Record<string, string | undefined>>): void;
export function handleMessagesNonStream(
  body: unknown,
  contextId: string,
  response: ShimWritableResponse,
  abortController: AbortController,
  dependencies?: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fulfill?: (
      body: unknown,
      options: Readonly<Record<string, unknown>>,
    ) => Promise<unknown>;
    readonly cache?: ShimCacheContext | null;
    readonly asStream?: boolean;
  },
): Promise<void>;
export function handleMessagesStream(
  body: unknown,
  contextId: string,
  response: ShimWritableResponse,
  abortController: AbortController,
  selectedFulfiller?: 'claude-code' | 'codex',
  cache?: ShimCacheContext | null,
): Promise<void>;
export const _filesStore: Map<string, ShimStoredFile>;
