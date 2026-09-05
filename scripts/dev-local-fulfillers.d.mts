export function localFulfillerName(
  env?: Readonly<Record<string, string | undefined>>,
): 'claude-code' | 'codex';
export function assertLocalInferenceChannel(
  env?: Readonly<Record<string, string | undefined>>,
): void;
export function codexChildEnvironment(
  env?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>>;
export function composeCodexExecArgs(input: {
  model: string;
  effort?: string;
  cwd: string;
  images?: readonly string[];
  outputSchemaPath?: string | null;
  outputPath: string;
  authMethod?: 'chatgpt' | 'api';
}): string[];
export function codexPromptFrom(body: unknown): string;
export function codexUsageFromJsonl(value: string): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};
interface LocalUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}
interface LocalTextBlock {
  readonly type: 'text';
  readonly text: string;
}
interface LocalToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}
type LocalContentBlock = LocalTextBlock | LocalToolUseBlock;
type LocalStopReason =
  | 'end_turn'
  | 'stop_sequence'
  | 'max_tokens'
  | 'tool_use'
  | 'refusal'
  | 'pause_turn'
  | 'model_context_window_exceeded';
interface LocalFulfillmentPayload {
  readonly model: string;
  readonly content: readonly LocalContentBlock[];
  readonly stopReason: LocalStopReason;
  readonly usage: LocalUsage;
}
interface LocalFulfillmentResult extends LocalFulfillmentPayload {
  readonly fulfiller: 'claude-code' | 'codex';
}
type LocalEnvironment = Readonly<Record<string, string | undefined>>;
type CodexExecutionResult = {
  readonly text?: string;
  readonly stdout: string;
  readonly stderr: string;
};
type CodexRunner = (
  args: readonly string[],
  prompt: string,
  abortSignal: AbortSignal | undefined,
  options: { readonly environment: Readonly<Record<string, string>> },
) => Promise<CodexExecutionResult>;
interface LocalFulfillmentOptions {
  readonly env?: LocalEnvironment;
  readonly abortSignal?: AbortSignal;
  readonly run?: CodexRunner;
  readonly claudeCode?: (
    body: unknown,
    abortSignal?: AbortSignal,
  ) => Promise<LocalFulfillmentPayload>;
}
export function fulfillLocalOneShot(
  body: unknown,
  options?: LocalFulfillmentOptions,
): Promise<LocalFulfillmentResult>;
export function anthropicMessageFromLocalResult(
  result: LocalFulfillmentResult,
  id: string,
): {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly model: string;
  readonly content: readonly LocalContentBlock[];
  readonly stop_reason: LocalStopReason;
  readonly stop_sequence: null;
  readonly usage: LocalUsage;
};
export function fulfillWithCodex(
  body: unknown,
  options?: Pick<LocalFulfillmentOptions, 'env' | 'abortSignal' | 'run'>,
): Promise<{ text: string; usage: LocalUsage }>;
interface CodexSpawnOptions {
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly env: Readonly<Record<string, string>>;
}
interface CodexChildProcess {
  readonly stdin: {
    end(value: string): void;
    on(event: 'error', listener: (error: Error) => void): void;
  };
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): void };
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): void };
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
}
export function runCodexProcess(
  args: readonly string[],
  prompt: string,
  abortSignal?: AbortSignal,
  options?: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly killGraceMs?: number;
    readonly spawnProcess?: (
      executable: string,
      args: readonly string[],
      options: CodexSpawnOptions,
    ) => CodexChildProcess;
  },
): Promise<{ stdout: string; stderr: string }>;
