export function composeWranglerDeployArgs(rev: string, extraArgs?: readonly string[]): string[];
export function composeWranglerPreviewArgs(rev: string, extraArgs?: readonly string[]): string[];
export function resolveDeployInvocation(argv: readonly string[]): {
  preview: boolean;
  extraArgs: readonly string[];
};
export function main(argv?: readonly string[]): void;
