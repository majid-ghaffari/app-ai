import { readFile } from 'node:fs/promises';

export const ROOT_STANDARDS_VARIABLE = 'LIMESPOT_ROOT_STANDARDS';

export async function readRootAiProviders(directory, whenUnreadable) {
  const path = `${directory}/ai-providers.json`;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read ${path}. ${whenUnreadable}`, { cause });
  }
  const parsed = JSON.parse(text);
  const entries = isRecord(parsed) ? parsed['providers'] : undefined;
  if (!Array.isArray(entries)) throw new Error(`${path} carries no "providers" array`);
  const providers = entries.map((entry, index) => {
    if (
      isRecord(entry) &&
      typeof entry['provider'] === 'string' &&
      typeof entry['dpaName'] === 'string' &&
      typeof entry['apiOrigin'] === 'string'
    ) {
      return {
        provider: entry['provider'],
        dpaName: entry['dpaName'],
        apiOrigin: entry['apiOrigin'],
      };
    }
    throw new Error(`${path} providers[${index}] lacks a string provider, dpaName or apiOrigin`);
  });
  return { path, providers };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
