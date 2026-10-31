export const PREVIEW_CONFIG_PATH: string;
export function composeWranglerDeployArgs(rev: string, extraArgs?: readonly string[]): string[];
export function composeWranglerPreviewArgs(extraArgs?: readonly string[]): string[];
export function composePreviewConfig(wranglerToml: string, rev: string): string;
export function resolveDeployInvocation(argv: readonly string[]): {
  preview: boolean;
  extraArgs: readonly string[];
};
export function main(argv?: readonly string[]): void;
