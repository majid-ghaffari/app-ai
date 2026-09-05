export interface GeminiSmokeEnvironment {
  readonly GEMINI_LIVE_SMOKE?: string;
  readonly AI_CHANNEL?: string;
  readonly GEMINI_API_BASE?: string;
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_SMOKE_MODEL?: string;
}

export interface GeminiProbeResult {
  readonly probe: string;
  readonly required: boolean;
  readonly outcome: 'accepted' | 'rejected' | 'errored';
  readonly detail: Record<string, unknown> | null;
  readonly latencyMs: number;
}

export const PROBE_ANSWER_TOKENS: number;
export function assertGeminiLiveOptIn(env: GeminiSmokeEnvironment): void;
export function runGeminiSmoke(
  env?: GeminiSmokeEnvironment,
  fetchImpl?: typeof fetch,
): Promise<GeminiProbeResult[]>;
