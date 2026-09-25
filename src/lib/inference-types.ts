/**
 * Canonical provider-neutral inference contracts.
 *
 * Handlers, the shared inference runtime, provider adapters, and local
 * fulfillers exchange these shapes. Provider wire fields belong only in the
 * adapter that owns them; opaque provider continuation data is carried without
 * interpretation by the shared runtime.
 */

/**
 * Every provider a configured model id can resolve to
 * (`src/inference/model-catalog.ts`). Naming one whose adapter is absent fails
 * at adapter selection, before provider I/O.
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'cloudflare';

/** Production providers and local development fulfillers that can produce results. */
export type InferenceBackendName = ProviderName | 'claude-code' | 'codex';

/** Provider API families a catalogued model family can be served over. */
export type ProviderApiFamily =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'gemini-generate-content'
  | 'cloudflare-workers-ai';

/** Provider-neutral output effort requested by a prompt contract. */
export type SemanticEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Capabilities declared by every concrete model profile. */
export interface ModelCapabilities {
  readonly vision: boolean;
  readonly providerFiles: boolean;
  readonly streaming: boolean;
  readonly structuredOutput: boolean;
  readonly serverTools: boolean;
  readonly clientTools: boolean;
  readonly reasoning: boolean;
  readonly inlineCacheBreakpoints: boolean;
}

/** Capability keys used when validating prompt requirements against a profile. */
export type ModelCapabilityName = keyof ModelCapabilities;

/** A fully resolved model profile consumed by an inference adapter. */
export interface ModelProfile {
  readonly name: string;
  readonly provider: ProviderName;
  readonly apiFamily: ProviderApiFamily;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
}

/** Direct-provider file behavior owned by a prompt group. */
export interface FilePolicy {
  readonly name: string;
  readonly provider: ProviderName;
  readonly compatibleApiFamilies: readonly ProviderApiFamily[];
  /**
   * `provider-file` uploads the bytes to the provider's file API and references
   * the stored object; `inline` embeds the bytes in the completion request
   * itself, which is the only mode a provider without a file API can serve.
   */
  readonly inputMode: 'provider-file' | 'inline';
  /**
   * `provider-managed` objects outlive the request that created them;
   * `request-scoped` bytes exist only inside the request that carries them.
   */
  readonly lifecycle: 'provider-managed' | 'request-scoped';
  readonly purpose: string | null;
}

/** Public file reference whose identifier does not reveal provider routing. */
export interface OpaqueFileReference {
  readonly id: string;
  readonly type: 'file';
}

/**
 * Frozen multipart metadata for `POST /files`.
 *
 * The request carries one `file` part and one or more repeated `prompt` string
 * parts. Each prompt must be registered before provider I/O begins.
 */
export interface PromptAwareFileUploadIntent<RegisteredPrompt extends string = string> {
  readonly prompts: readonly [RegisteredPrompt, ...RegisteredPrompt[]];
}

/**
 * Frozen `POST /files` response: the primary opaque reference plus a
 * `references` map carrying one opaque reference for every declared destination
 * prompt. The top-level reference is the first declared prompt's. Prompts whose
 * destinations share one route share one reference, so an upload resolving to a
 * single route names every declared prompt against the same value — the map is
 * present on every success, and a caller reads the reference for the prompt it
 * is about to run.
 */
export interface PromptAwareFileUploadResponse<
  DestinationPrompt extends string = string,
> extends OpaqueFileReference {
  readonly references: Readonly<Record<DestinationPrompt, OpaqueFileReference>>;
}

/** Internal direct-provider file reference; this shape is never sent to lib. */
export interface ProviderFileReference<
  GroupName extends string = string,
  PolicyName extends string = string,
> {
  readonly provider: ProviderName;
  readonly accountScope: string;
  readonly tenantScope: string;
  readonly filePolicy: PolicyName;
  readonly compatibleGroups: readonly [GroupName, ...GroupName[]];
  readonly upstreamFileId: string;
  readonly contentHash: string;
  readonly mediaType: string | null;
  readonly sizeBytes: number | null;
  readonly expiresAt: string | null;
}

/** Provider-neutral prompt-cache intent. */
export type CacheIntent = 'none' | 'short' | 'extended';

/** Text supplied to or returned by a model. */
export interface InferenceTextContent {
  readonly type: 'text';
  readonly text: string;
  readonly citations?: readonly Readonly<Record<string, unknown>>[];
  readonly cache: CacheIntent;
}

/** Image bytes or an opaque provider-uploaded image reference. */
export interface InferenceImageContent {
  readonly type: 'image';
  readonly source:
    | { readonly type: 'base64'; readonly mediaType: string; readonly data: string }
    | { readonly type: 'url'; readonly url: string }
    | { readonly type: 'file'; readonly reference: OpaqueFileReference }
    | { readonly type: 'provider-file'; readonly reference: ProviderFileReference };
  readonly cache: CacheIntent;
}

/** Document bytes, text, or an opaque provider-uploaded document reference. */
export interface InferenceDocumentContent {
  readonly type: 'document';
  readonly source:
    | { readonly type: 'text'; readonly mediaType: string; readonly text: string }
    | { readonly type: 'base64'; readonly mediaType: string; readonly data: string }
    | { readonly type: 'url'; readonly url: string }
    | {
        readonly type: 'content';
        readonly content: string | readonly (InferenceTextContent | InferenceImageContent)[];
      }
    | { readonly type: 'file'; readonly reference: OpaqueFileReference }
    | { readonly type: 'provider-file'; readonly reference: ProviderFileReference };
  readonly title?: string;
  readonly context?: string;
  readonly citations?: { readonly enabled: boolean };
  readonly cache: CacheIntent;
}

/** A model-requested tool invocation. */
export interface InferenceToolCall {
  readonly type: 'tool-call';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly cache: CacheIntent;
  readonly providerState?: ProviderContinuationState;
}

/** The result of a server- or browser-executed tool invocation. */
export interface InferenceToolResult {
  readonly type: 'tool-result';
  readonly toolCallId: string;
  readonly content: readonly (
    | InferenceTextContent
    | InferenceImageContent
    | InferenceDocumentContent
  )[];
  readonly isError: boolean;
  readonly cache: CacheIntent;
}

/** Provider-neutral content accepted by the shared runtime. */
export type InferenceContent =
  | InferenceTextContent
  | InferenceImageContent
  | InferenceDocumentContent
  | InferenceToolCall
  | InferenceToolResult;

/** One provider-neutral conversation message. */
export interface InferenceMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: readonly InferenceContent[];
  readonly providerState?: ProviderContinuationState;
}

/** JSON-schema object accepted by a canonical tool. */
export interface CanonicalToolInputSchema extends Readonly<Record<string, unknown>> {
  readonly type: 'object';
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

/** Provider-neutral controls shared by custom function tools. */
interface CanonicalCustomToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: CanonicalToolInputSchema;
  readonly strict?: boolean;
  readonly kind?: string;
  readonly allowedCallers?: readonly string[];
  readonly deferLoading?: boolean;
  readonly inputExamples?: readonly Readonly<Record<string, unknown>>[];
  readonly eagerInputStreaming?: boolean;
  readonly execution: 'server' | 'client';
}

/** A tool whose calls are executed by app-ai's server-side tool dispatcher. */
export interface CanonicalServerToolDefinition extends CanonicalCustomToolDefinition {
  readonly execution: 'server';
}

/** A tool whose calls are returned to the browser for execution. */
export interface CanonicalClientToolDefinition extends CanonicalCustomToolDefinition {
  readonly execution: 'client';
}

/** Provider-hosted tool configuration carried opaquely to its owning adapter. */
export interface CanonicalHostedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly execution: 'provider';
  readonly providerState: ProviderContinuationState;
}

/** Tool definition accepted by a routed canonical completion. */
export type CanonicalToolDefinition =
  | CanonicalServerToolDefinition
  | CanonicalClientToolDefinition
  | CanonicalHostedToolDefinition;

/** Provider-neutral tool selection semantics. */
export type CanonicalToolChoice =
  | { readonly mode: 'auto' | 'none' | 'required'; readonly disableParallel?: boolean }
  | { readonly mode: 'specific'; readonly name: string; readonly disableParallel?: boolean };

/** Structured-output contract requested by a prompt. */
export interface StructuredOutputRequirement {
  readonly name: string;
  readonly description?: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly strict: boolean;
}

/** Provider-neutral sampling controls retained by compatibility handlers. */
export interface InferenceSampling {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
}

/** Opaque state that a provider requires on a continuation turn. */
export interface ProviderContinuationState {
  readonly backend: InferenceBackendName;
  readonly value: unknown;
  /** True when this provider requires opaque state on the next ordinary user turn. */
  readonly requiredOnNextTurn?: boolean;
}

/** A fully routed provider-neutral completion request. */
export interface InferenceRequest {
  readonly prompt: string;
  readonly promptGroup: string;
  readonly modelProfile: ModelProfile;
  readonly filePolicy: FilePolicy;
  readonly messages: readonly InferenceMessage[];
  readonly maxOutputTokens: number;
  readonly effort?: SemanticEffort;
  readonly structuredOutput?: StructuredOutputRequirement;
  readonly sampling?: InferenceSampling;
  readonly stopSequences?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Provider-neutral pass-through for an explicitly requested service class. */
  readonly serviceTier?: string;
  readonly tools: readonly CanonicalToolDefinition[];
  readonly toolChoice?: CanonicalToolChoice;
  readonly continuation?: ProviderContinuationState;
  readonly abortSignal?: AbortSignal;
  /**
   * Epoch milliseconds the upstream inference deadline counts from, when the work was admitted
   * before the request reached the model; absent, the deadline counts from the model call.
   */
  readonly deadlineStartedAt?: number;
}

/** Normalized token and cache accounting from an inference provider. */
export interface InferenceUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly reasoningTokens: number | null;
  /** Complete provider usage object retained for byte-compatible public envelopes. */
  readonly providerDetails?: Readonly<Record<string, unknown>>;
}

/** Normalized terminal reason for a completion or agent turn. */
export type InferenceStopReason =
  | 'completed'
  | 'max-output-tokens'
  | 'tool-call'
  | 'content-filter'
  | 'cancelled'
  | 'paused'
  | 'context-window'
  | 'max-iterations'
  | 'error'
  | 'unknown';

/** Normalized provider failure consumed by handlers and traces. */
export interface InferenceError {
  readonly backend: InferenceBackendName;
  readonly status: number | null;
  readonly code: string;
  readonly message: string;
  readonly detail?: string;
  readonly retryable: boolean;
  readonly failureClass: 'http' | 'network' | 'timeout' | 'cancelled' | 'invalid-response';
}

/** Successful normalized completion result. */
export interface InferenceResult {
  readonly content: readonly InferenceContent[];
  readonly toolCalls: readonly InferenceToolCall[];
  readonly usage: InferenceUsage;
  readonly stopReason: InferenceStopReason;
  readonly providerStopReason?: string | null;
  readonly providerState?: ProviderContinuationState;
}

/** Provider-neutral streaming events emitted by every adapter. */
export type InferenceEvent =
  | {
      readonly type: 'agent-turn-start';
      readonly iteration: number;
      readonly request: InferenceRequest;
    }
  | { readonly type: 'message-start' }
  | { readonly type: 'text-delta'; readonly delta: string }
  | { readonly type: 'tool-call'; readonly call: InferenceToolCall }
  | { readonly type: 'tool-result'; readonly result: InferenceToolResult }
  | { readonly type: 'usage'; readonly usage: InferenceUsage }
  | { readonly type: 'complete'; readonly result: InferenceResult }
  | { readonly type: 'error'; readonly error: InferenceError };

interface AgentRequestBase extends InferenceRequest {
  readonly maxIterations: number;
  readonly onEvent?: (event: InferenceEvent) => Promise<void> | void;
}

/** A canonical agent request whose tools execute inside app-ai. */
export interface ServerAgentRequest extends AgentRequestBase {
  readonly mode: 'server';
  readonly tools: readonly CanonicalServerToolDefinition[];
  readonly executeTool: (call: InferenceToolCall) => Promise<InferenceToolResult>;
}

/** A canonical agent request whose tool calls are returned to the browser. */
export interface ClientAgentRequest extends AgentRequestBase {
  readonly mode: 'client';
  readonly tools: readonly CanonicalClientToolDefinition[];
  readonly executeTool?: never;
}

/** A canonical agent-shaped request with no callable tools. */
export interface ToolFreeAgentRequest extends AgentRequestBase {
  readonly mode: 'none';
  readonly tools: readonly [];
  readonly executeTool?: never;
}

/** Tool execution authority is selected once by this discriminated union. */
export type AgentRequest = ServerAgentRequest | ClientAgentRequest | ToolFreeAgentRequest;

/** Terminal normalized result of the shared provider-neutral agent loop. */
export interface AgentResult extends InferenceResult {
  readonly iterations: number;
  /** The public text accumulation: concatenate blocks, newline-separate turns. */
  readonly text: string;
}

/** Canonical service consumed by `/messages` and `/chat`. */
export interface InferenceService {
  complete(request: InferenceRequest): Promise<InferenceResult>;
  stream(request: InferenceRequest): AsyncIterable<InferenceEvent>;
  runAgent(request: AgentRequest): Promise<AgentResult>;
}
