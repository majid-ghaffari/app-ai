/** A copy of the agents' shared core and where it was read from. */
export interface AgentRulesCoreFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Reads `agent-rules-core.md` from a `_standards` directory, throwing with `whenUnreadable`
 * appended when the file cannot be read.
 */
export function readRootAgentRulesCore(
  directory: string,
  whenUnreadable: string,
): Promise<AgentRulesCoreFile>;

/** Reads this repository's copy, `src/prompts/assistant-shared/_shared-agents-core.md`. */
export function readAppAiAgentRulesCore(): Promise<AgentRulesCoreFile>;

/**
 * Null when the two files are identical byte for byte; otherwise the line of the first byte that
 * differs and a message naming both files, that byte, and that line in each.
 */
export function agentRulesCoreMismatch(
  copy: AgentRulesCoreFile,
  root: AgentRulesCoreFile,
): { readonly line: number; readonly message: string } | null;
