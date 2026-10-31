export function resolveShortRev(run?: () => string): string;
export function composeWranglerArgs(rev: string, extraArgs?: readonly string[]): string[];
export function composeRevisionedWranglerArgs(
  command: string,
  rev: string,
  extraArgs?: readonly string[],
): string[];
export function composeRevisionedPreviewsDefine(rev: string): string;
export function resolveDevLogPath(env?: Readonly<Record<string, string | undefined>>): string;
export function main(argv?: readonly string[]): void;
