/** One AI provider as the workspace's `ai-providers.json` lists it. */
export interface RootAiProvider {
  readonly provider: string;
  readonly dpaName: string;
  readonly apiOrigin: string;
}

export const ROOT_STANDARDS_VARIABLE: 'LIMESPOT_ROOT_STANDARDS';

/**
 * Reads and validates `ai-providers.json` from a `_standards` directory, throwing with
 * `whenUnreadable` appended when the file cannot be read.
 */
export function readRootAiProviders(
  directory: string,
  whenUnreadable: string,
): Promise<{ readonly path: string; readonly providers: readonly RootAiProvider[] }>;
