export interface MoonshotSmokeEnvironment {
  readonly MOONSHOT_LIVE_SMOKE?: string;
  readonly AI_CHANNEL?: string;
  readonly MOONSHOT_API_BASE?: string;
  readonly MOONSHOT_API_KEY?: string;
  readonly MOONSHOT_SMOKE_MODELS?: string;
}

export interface MoonshotSmokeResult {
  readonly model: string;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
  readonly latencyMs: number;
}

export function assertMoonshotLiveOptIn(env: MoonshotSmokeEnvironment): void;
export function runMoonshotSmoke(
  env?: MoonshotSmokeEnvironment,
  fetchImpl?: typeof fetch,
): Promise<MoonshotSmokeResult[]>;
