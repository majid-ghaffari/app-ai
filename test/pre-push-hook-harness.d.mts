export interface PrePushRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly npmCalls: string;
  readonly sharedGateInput: string | null;
}

export function runPrePush(
  refLines: readonly string[],
  options?: {
    readonly installed?: boolean;
    readonly sharedGateStatus?: number;
    readonly npmFailsOn?: string;
  },
): PrePushRun;
