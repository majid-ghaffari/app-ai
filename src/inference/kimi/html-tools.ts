import { kimiEvidenceMaxTextBytes, type Env } from '../../config';
import type {
  CanonicalServerToolDefinition,
  InferenceContent,
  InferenceRequest,
  InferenceToolCall,
  InferenceToolResult,
  ProviderFileReference,
} from '../../lib/inference-types';
import { readInlineEvidence } from './evidence';
import { WorkerError } from '../../lib/responses';

const HTML_TOOL_THRESHOLD_BYTES = 256 * 1024;
const MAX_READ_CHARACTERS = 100_000;
const MAX_SEARCH_HITS = 12;
const SEARCH_CONTEXT_CHARACTERS = 600;
const MAX_SELECTED_HTML_JSON_BYTES = 750_000;
const MAX_SEARCH_QUERY_CHARACTERS = 200;
const UTF8 = new TextEncoder();

export interface KimiHtmlFragmentSelection {
  readonly fragments: Map<string, string[]>;
  readonly bytesByDocument: Map<string, number>;
}

export const KIMI_HTML_TOOLS: readonly CanonicalServerToolDefinition[] = [
  {
    name: 'kimi_read_html',
    description:
      'Read a bounded section of stored wrapper HTML by character offset. A result with selectionBudgetExhausted: true was not retained; stop inspecting that document or reply READY.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['document', 'offset', 'limit'],
    },
    execution: 'server',
  },
  {
    name: 'kimi_search_html',
    description:
      'Find literal text in stored wrapper HTML and return surrounding HTML with offsets. A result with selectionBudgetExhausted: true was not retained; stop inspecting that document or reply READY.',
    inputSchema: {
      type: 'object',
      properties: {
        document: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['document', 'query'],
    },
    execution: 'server',
  },
];

export interface KimiHtmlToolRequest {
  readonly request: InferenceRequest;
  readonly documents: ReadonlyMap<string, string>;
  readonly locations: ReadonlyMap<string, { message: number; part: number }>;
  readonly cacheKey: string;
}

export async function prepareKimiHtmlToolRequest(
  env: Env,
  request: InferenceRequest,
  documentCache?: Map<string, Promise<string>>,
): Promise<KimiHtmlToolRequest | null> {
  const candidates: { location: string; sizeBytes: number }[] = [];
  const names = new Map<string, string>();
  let totalTextBytes = 0;
  request.messages.forEach((message, messageIndex) =>
    message.content.forEach((part, partIndex) => {
      if (
        part.type !== 'document' ||
        part.source.type !== 'provider-file' ||
        part.source.reference.filePolicy !== 'kimi-stored-evidence' ||
        part.source.reference.mediaType !== 'text/plain'
      )
        return;
      const sizeBytes = part.source.reference.sizeBytes ?? 0;
      totalTextBytes += sizeBytes;
      candidates.push({ location: `${messageIndex}:${partIndex}`, sizeBytes });
    }),
  );
  if (totalTextBytes <= HTML_TOOL_THRESHOLD_BYTES) return null;
  if (totalTextBytes > kimiEvidenceMaxTextBytes(env)) {
    throw new WorkerError('Kimi Code request contains too much stored text evidence', {
      status: 413,
      exceptionType: 'ArgumentException',
    });
  }
  let remainingTextBytes = totalTextBytes;
  const selectedLocations = new Set<string>();
  for (const candidate of [...candidates].sort((left, right) => right.sizeBytes - left.sizeBytes)) {
    if (remainingTextBytes <= HTML_TOOL_THRESHOLD_BYTES) break;
    selectedLocations.add(candidate.location);
    remainingTextBytes -= candidate.sizeBytes;
  }
  for (const candidate of candidates) {
    if (selectedLocations.has(candidate.location)) {
      names.set(candidate.location, `html_${names.size + 1}`);
    }
  }
  const documents = new Map<string, string>();
  const locations = new Map<string, { message: number; part: number }>();
  const identities: string[] = [];
  const messages = [];
  for (const [messageIndex, message] of request.messages.entries()) {
    const content: InferenceContent[] = [];
    for (const [partIndex, part] of message.content.entries()) {
      if (
        part.type !== 'document' ||
        part.source.type !== 'provider-file' ||
        part.source.reference.filePolicy !== 'kimi-stored-evidence' ||
        part.source.reference.mediaType !== 'text/plain'
      ) {
        content.push(part);
        continue;
      }
      const name = names.get(`${messageIndex}:${partIndex}`);
      if (!name) {
        content.push(part);
        continue;
      }
      const text = await readStoredText(
        env,
        part.source.reference,
        request.abortSignal,
        documentCache,
      );
      documents.set(name, text);
      locations.set(name, { message: messageIndex, part: partIndex });
      identities.push(
        `${messageIndex}:${partIndex}:${part.source.reference.contentHash}:${part.source.reference.upstreamFileId}`,
      );
      content.push({
        ...part,
        source: {
          type: 'text',
          mediaType: 'text/plain',
          text:
            `The complete uploaded HTML is stored as ${name} (${text.length} characters). ` +
            'Use kimi_search_html or kimi_read_html to inspect it before answering. ' +
            'Search for relevant images, containers, headings, or CTAs and read nearby HTML as needed.',
        },
      });
    }
    messages.push({ ...message, content });
  }
  if (documents.size === 0) return null;
  return {
    request: { ...request, messages },
    documents,
    locations,
    cacheKey: identities.sort().join('|'),
  };
}

async function readStoredText(
  env: Env,
  reference: ProviderFileReference,
  abortSignal?: AbortSignal,
  cache?: Map<string, Promise<string>>,
): Promise<string> {
  const key = [
    reference.upstreamFileId,
    reference.contentHash,
    reference.sizeBytes,
    reference.expiresAt,
  ].join('\0');
  let pending = cache?.get(key);
  if (!pending) {
    pending = readInlineEvidence(env, reference, abortSignal).then((bytes) =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    cache?.set(key, pending);
    void pending.catch(() => {
      if (cache && cache.get(key) === pending) cache.delete(key);
    });
  }
  return pending;
}

export function replaceKimiHtmlEvidence(
  source: KimiHtmlToolRequest,
  prepared: InferenceRequest,
  fragments: ReadonlyMap<string, readonly string[]>,
): InferenceRequest {
  const byLocation = new Map(
    [...source.locations].map(([name, location]) => [`${location.message}:${location.part}`, name]),
  );
  return {
    ...prepared,
    messages: prepared.messages.map((message, messageIndex) => ({
      ...message,
      content: message.content.map((part, partIndex): InferenceContent => {
        const name = byLocation.get(`${messageIndex}:${partIndex}`);
        if (!name) return part;
        if (part.type !== 'document' || part.source.type !== 'text') {
          throw new Error('Kimi HTML evidence changed while selecting fragments');
        }
        const selected = fragments.get(name) ?? [];
        if (selected.length === 0) throw new Error(`Kimi did not inspect ${name}`);
        return {
          ...part,
          source: {
            ...part.source,
            text: `Exact selected fragments from uploaded HTML ${name}:\n${selected.join('\n')}`,
          },
        };
      }),
    })),
  };
}

export function createKimiHtmlFragmentSelection(
  documents: Iterable<string>,
): KimiHtmlFragmentSelection {
  const names = [...documents];
  return {
    fragments: new Map(names.map((name) => [name, []])),
    bytesByDocument: new Map(names.map((name) => [name, 0])),
  };
}

export function collectKimiHtmlFragments(
  result: InferenceToolResult,
  selection: KimiHtmlFragmentSelection,
): InferenceToolResult {
  if (result.isError) return result;
  const raw = result.content.find((part) => part.type === 'text');
  if (!raw || raw.type !== 'text') return result;
  const value: unknown = JSON.parse(raw.text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const record = value as Record<string, unknown>;
  const name = record.document;
  if (typeof name !== 'string' || !selection.fragments.has(name)) return result;
  const selected = selection.fragments.get(name);
  if (!selected) return result;
  const documentBudget = Math.floor(
    MAX_SELECTED_HTML_JSON_BYTES / Math.max(1, selection.fragments.size),
  );
  let budgetExhausted = false;
  const add = (html: unknown, offset: unknown) => {
    if (typeof html !== 'string' || html.length === 0) return;
    const prefix = `[offset ${typeof offset === 'number' ? offset : 'unknown'}]\n`;
    const fragment = `${prefix}${html}`;
    if (!selected.includes(fragment)) selected.push(fragment);
    else return;
    const used = selection.bytesByDocument.get(name) ?? 0;
    const available = documentBudget - used;
    let retained = fragment;
    let retainedBytes = jsonBytes(fragment);
    if (retainedBytes > available) {
      selected.pop();
      budgetExhausted = true;
      if (selected.length > 0) return;
      const fitted = fitFragment(prefix, html, available);
      if (!fitted) return;
      retained = fitted.fragment;
      retainedBytes = fitted.bytes;
      selected.push(retained);
    }
    selection.bytesByDocument.set(name, used + retainedBytes);
  };
  add(record.html, record.offset);
  if (Array.isArray(record.hits)) {
    for (const hit of record.hits) {
      if (hit && typeof hit === 'object' && !Array.isArray(hit)) {
        const found = hit as Record<string, unknown>;
        add(found.html, found.offset);
      }
    }
  }
  if (!budgetExhausted) return result;
  const retainedRecord = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'html' && key !== 'hits'),
  );
  return {
    ...result,
    content: result.content.map((part) =>
      part === raw
        ? {
            ...raw,
            text: JSON.stringify({
              ...retainedRecord,
              selectionBudgetExhausted: true,
              selectionBudgetBytes: documentBudget,
            }),
          }
        : part,
    ),
  };
}

function jsonBytes(value: string): number {
  return UTF8.encode(JSON.stringify(value)).byteLength;
}

function fitFragment(
  prefix: string,
  html: string,
  maxBytes: number,
): { fragment: string; bytes: number } | null {
  let low = 1;
  let high = html.length;
  let best: { fragment: string; bytes: number } | null = null;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const fragment = `${prefix}${unicodeSafeSlice(html, 0, length)}`;
    const bytes = jsonBytes(fragment);
    if (bytes <= maxBytes) {
      best = { fragment, bytes };
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

export function executeKimiHtmlTool(
  call: InferenceToolCall,
  documents: ReadonlyMap<string, string>,
): InferenceToolResult {
  const input = call.input;
  const fields =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const document = typeof fields.document === 'string' ? documents.get(fields.document) : undefined;
  let output: unknown;
  let isError = false;
  if (!document) {
    output = { error: 'Unknown HTML document' };
    isError = true;
  } else if (call.name === 'kimi_read_html') {
    const offset = fields.offset;
    const limit = fields.limit;
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > document.length ||
      typeof limit !== 'number' ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    ) {
      output = { error: 'Read requires a valid offset and positive limit' };
      isError = true;
    } else {
      const end = Math.min(document.length, offset + Math.min(limit, MAX_READ_CHARACTERS));
      const html = unicodeSafeSlice(document, offset, end);
      const start =
        offset < document.length && isLowSurrogate(document.charCodeAt(offset))
          ? offset + 1
          : offset;
      output = {
        document: fields.document,
        offset: start,
        end: start + html.length,
        totalCharacters: document.length,
        html,
      };
    }
  } else if (call.name === 'kimi_search_html') {
    const query = fields.query;
    if (
      typeof query !== 'string' ||
      query.length < 1 ||
      query.length > MAX_SEARCH_QUERY_CHARACTERS
    ) {
      output = { error: 'Search requires a query of 1 to 200 characters' };
      isError = true;
    } else {
      const hits: { offset: number; html: string }[] = [];
      const expression = new RegExp(escapeRegularExpression(query), 'giu');
      for (const match of document.matchAll(expression)) {
        if (hits.length >= MAX_SEARCH_HITS) break;
        const found = match.index;
        hits.push({
          offset: found,
          html: unicodeSafeSlice(
            document,
            Math.max(0, found - SEARCH_CONTEXT_CHARACTERS),
            Math.min(document.length, found + query.length + SEARCH_CONTEXT_CHARACTERS),
          ),
        });
      }
      output = { document: fields.document, query, totalCharacters: document.length, hits };
    }
  } else {
    output = { error: 'Unknown HTML tool' };
    isError = true;
  }
  return {
    type: 'tool-result',
    toolCallId: call.id,
    content: [{ type: 'text', text: JSON.stringify(output), cache: 'none' }],
    isError,
    cache: 'none',
  };
}

export function unicodeSafeSlice(value: string, start: number, end: number): string {
  let safeStart = start;
  let safeEnd = end;
  if (
    safeStart > 0 &&
    safeStart < value.length &&
    isLowSurrogate(value.charCodeAt(safeStart)) &&
    isHighSurrogate(value.charCodeAt(safeStart - 1))
  ) {
    safeStart += 1;
  }
  if (
    safeEnd > safeStart &&
    safeEnd < value.length &&
    isHighSurrogate(value.charCodeAt(safeEnd - 1)) &&
    isLowSurrogate(value.charCodeAt(safeEnd))
  ) {
    safeEnd -= 1;
  }
  return value.slice(safeStart, safeEnd);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
