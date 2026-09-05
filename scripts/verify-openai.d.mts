export interface OpenAISmokeEnvironment {
  readonly OPENAI_LIVE_SMOKE?: string;
  readonly AI_CHANNEL?: string;
  readonly OPENAI_API_BASE?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_SMOKE_MODELS?: string;
}

export interface OpenAISmokeResult {
  readonly model: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly latencyMs: number;
}

export function assertOpenAILiveOptIn(env: OpenAISmokeEnvironment): void;
export function runOpenAISmoke(
  env?: OpenAISmokeEnvironment,
  fetchImpl?: typeof fetch,
): Promise<OpenAISmokeResult[]>;
