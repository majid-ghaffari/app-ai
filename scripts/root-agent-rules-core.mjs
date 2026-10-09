import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT_AGENT_RULES_CORE_FILE = 'agent-rules-core.md';
const APP_AI_AGENT_RULES_CORE_PATH = 'src/prompts/assistant-shared/_shared-agents-core.md';

const NEWLINE = 0x0a;

export async function readRootAgentRulesCore(directory, whenUnreadable) {
  const path = `${directory}/${ROOT_AGENT_RULES_CORE_FILE}`;
  try {
    return { path, bytes: await readFile(path) };
  } catch (cause) {
    throw new Error(`Cannot read ${path}. ${whenUnreadable}`, { cause });
  }
}

export async function readAppAiAgentRulesCore() {
  const path = fileURLToPath(new URL(`../${APP_AI_AGENT_RULES_CORE_PATH}`, import.meta.url));
  return { path, bytes: await readFile(path) };
}

export function agentRulesCoreMismatch(copy, root) {
  const shared = Math.min(copy.bytes.length, root.bytes.length);
  let offset = 0;
  while (offset < shared && copy.bytes[offset] === root.bytes[offset]) offset += 1;
  if (offset === copy.bytes.length && offset === root.bytes.length) return null;
  const lineStart = offset === 0 ? 0 : copy.bytes.lastIndexOf(NEWLINE, offset - 1) + 1;
  const line = copy.bytes.subarray(0, lineStart).filter((byte) => byte === NEWLINE).length + 1;
  return {
    line,
    message: [
      `${copy.path} must be byte for byte ${root.path}, and they differ from byte ${offset}, line ${line} (${copy.bytes.length} bytes here, ${root.bytes.length} in root).`,
      `  here: ${JSON.stringify(lineFrom(copy.bytes, lineStart))}`,
      `  root: ${JSON.stringify(lineFrom(root.bytes, lineStart))}`,
      `The shared core changes in limespot/root first; copy ${root.path} here unchanged.`,
    ].join('\n'),
  };
}

function lineFrom(bytes, start) {
  const end = bytes.indexOf(NEWLINE, start);
  return new TextDecoder().decode(bytes.subarray(start, end === -1 ? bytes.length : end));
}
