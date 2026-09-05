export interface KimiSmokeEnvironment {
  readonly KIMI_LIVE_SMOKE?: string;
  readonly AI_CHANNEL?: string;
  readonly KIMI_API_BASE?: string;
  readonly KIMI_API_KEY?: string;
  readonly KIMI_SMOKE_MODEL?: string;
}

export interface KimiProbeResult {
  readonly probe: string;
  readonly required: boolean;
  readonly outcome: 'accepted' | 'rejected' | 'errored';
  readonly detail: Record<string, unknown> | null;
  readonly latencyMs: number;
}

export function assertKimiLiveOptIn(env: KimiSmokeEnvironment): void;
export function runKimiSmoke(
  env?: KimiSmokeEnvironment,
  fetchImpl?: typeof fetch,
): Promise<KimiProbeResult[]>;
