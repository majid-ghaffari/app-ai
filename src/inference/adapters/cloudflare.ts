import { workersAiBinding, type Env } from '../../config';
import type {
  FilePolicy,
  InferenceContent,
  InferenceEvent,
  InferenceRequest,
  InferenceResult,
} from '../../lib/inference-types';
import { InferenceFailure, type InferenceProviderAdapter } from '../adapter';
import { reserveFreeVisualVerification } from '../../lib/inference-quota-authority';
import { WorkerError } from '../../lib/responses';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const MAX_SYSTEM_PROMPT_BYTES = 6_400;
const MAX_EVIDENCE_TEXT_BYTES = 8_192;
const MAX_IMAGE_BYTES = 4_000_000;
const MAX_ENCODED_IMAGE_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_WIDTH = 1_280;
const MAX_IMAGE_HEIGHT = 900;
const MAX_OUTPUT_TOKENS = 1_024;

export class CloudflareWorkersAiAdapter implements InferenceProviderAdapter {
  readonly provider = 'cloudflare' as const;
  readonly apiFamily = 'cloudflare-workers-ai' as const;

  constructor(private readonly env: Env) {}

  async getFileScope(policy: FilePolicy): Promise<string> {
    if (
      policy.provider !== 'cloudflare' ||
      policy.inputMode !== 'inline' ||
      policy.lifecycle !== 'request-scoped'
    ) {
      throw failure('Workers AI adapter received an incompatible file policy', 'invalid-route');
    }
    return 'cloudflare-workers-ai-binding';
  }

  async complete(request: InferenceRequest): Promise<InferenceResult> {
    await validateRequest(request);
    if (request.abortSignal?.aborted) throw cancelledFailure();
    const response = await runModel(request, this.env);
    if (request.abortSignal?.aborted) throw cancelledFailure();
    const text = responseText(response);
    return {
      content: [{ type: 'text', text, cache: 'none' }],
      toolCalls: [],
      usage: {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        reasoningTokens: null,
      },
      stopReason: 'completed',
      providerStopReason: null,
    };
  }

  async *stream(_request: InferenceRequest): AsyncIterable<InferenceEvent> {
    yield {
      type: 'error',
      error: {
        backend: 'cloudflare',
        status: null,
        code: 'unsupported-stream',
        message: 'Workers AI visual verification does not support streaming',
        retryable: false,
        failureClass: 'invalid-response',
      },
    };
  }
}

async function runModel(request: InferenceRequest, env: Env): Promise<unknown> {
  const input: Record<string, unknown> = {
    messages: [
      { role: 'system', content: request.prompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: requestText(request) },
          { type: 'image_url', image_url: { url: requestImage(request) } },
        ],
      },
    ],
    max_tokens: request.maxOutputTokens,
    temperature: request.sampling?.temperature ?? 0,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: 'json_object' },
  };
  if (request.sampling?.topP !== undefined) input.top_p = request.sampling.topP;
  if (request.sampling?.topK !== undefined) input.top_k = request.sampling.topK;
  const binding = workersAiBinding(env);
  await reserveFreeVisualVerification(env, request.visualQuotaClass ?? 'diagnostic');
  try {
    const response = await binding.run(request.modelProfile.model, input, {
      returnRawResponse: true,
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    });
    const body = await responseBody(response);
    if (!response.ok) throw responseFailure(response.status, body);
    return body;
  } catch (error) {
    if (error instanceof InferenceFailure) throw error;
    if (isAbortError(error) || request.abortSignal?.aborted) throw cancelledFailure();
    throw cloudflareFailure(error);
  }
}

async function validateRequest(request: InferenceRequest): Promise<void> {
  if (
    request.modelProfile.provider !== 'cloudflare' ||
    request.modelProfile.apiFamily !== 'cloudflare-workers-ai'
  ) {
    throw failure('Workers AI adapter received an incompatible route', 'invalid-route');
  }
  if (request.tools.length > 0 || request.toolChoice || request.continuation) {
    throw failure(
      'Workers AI visual verification accepts no tools or continuation',
      'unsupported-request',
    );
  }
  const message = request.messages[0];
  if (request.messages.length !== 1 || message?.role !== 'user') {
    throw argumentFailure('Protected visual verification requires exactly one user message.');
  }
  const content = message.content;
  if (content[0]?.type !== 'image' || content[1]?.type !== 'text' || content.length !== 2) {
    throw argumentFailure(
      'Protected visual verification requires one image followed by one text block.',
    );
  }
  const images = content.filter((item) => item.type === 'image');
  const text = content.filter((item) => item.type === 'text');
  const evidenceText = text[0];
  if (images.length !== 1) {
    throw argumentFailure(
      `Protected visual verification requires exactly one inline image; received ${images.length}.`,
    );
  }
  if (text.length !== 1 || !evidenceText || evidenceText.text.trim().length === 0) {
    throw argumentFailure(
      'Protected visual verification requires exactly one non-empty text block.',
    );
  }
  if (content.length !== 2) {
    throw argumentFailure(
      'Protected visual verification accepts only one image and one text block.',
    );
  }
  const source = images[0]?.source;
  if (
    source?.type !== 'base64' ||
    source.mediaType !== 'image/png' ||
    source.data.length === 0 ||
    source.data.length > MAX_ENCODED_IMAGE_LENGTH ||
    source.data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(source.data)
  ) {
    throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
  }
  if (
    utf8Bytes(request.prompt) > MAX_SYSTEM_PROMPT_BYTES ||
    utf8Bytes(evidenceText.text) > MAX_EVIDENCE_TEXT_BYTES ||
    request.maxOutputTokens > MAX_OUTPUT_TOKENS
  ) {
    throw argumentFailure(
      'Protected visual verification evidence exceeds its free-inference budget.',
    );
  }
  const png = decodeBase64(source.data);
  const parsedPng = parsePng(png);
  if (
    png.byteLength > MAX_IMAGE_BYTES ||
    parsedPng.width > MAX_IMAGE_WIDTH ||
    parsedPng.height > MAX_IMAGE_HEIGHT
  ) {
    throw argumentFailure('Protected visual verification image exceeds its free-inference budget.');
  }
  await validatePngPixels(parsedPng);
}

function argumentFailure(message: string): WorkerError {
  return new WorkerError(message, { status: 400, exceptionType: 'ArgumentException' });
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
  }
}

interface ParsedPng {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly imageData: Uint8Array;
}

function parsePng(bytes: Uint8Array): ParsedPng {
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let channels = 0;
  let colorType = -1;
  const imageDataChunks: Uint8Array[] = [];
  let sawEnd = false;
  let sawHeader = false;
  let sawPalette = false;
  let imageDataEnded = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const crcOffset = dataStart + length;
    if (crcOffset + 4 > bytes.byteLength) break;
    const type = String.fromCharCode(...bytes.subarray(typeStart, dataStart));
    if (!/^[A-Za-z]{4}$/.test(type)) break;
    if (view.getUint32(crcOffset) !== pngCrc32(bytes.subarray(typeStart, crcOffset))) break;
    const knownCritical = type === 'IHDR' || type === 'PLTE' || type === 'IDAT' || type === 'IEND';
    if ((type.charCodeAt(0) & 32) === 0 && !knownCritical) break;
    if (type === 'IHDR') {
      if (sawHeader || offset !== PNG_SIGNATURE.length || length !== 13) break;
      sawHeader = true;
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9] ?? -1;
      const compression = bytes[dataStart + 10];
      const filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (
        bitDepth !== 8 ||
        (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        break;
      }
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
    }
    if (!sawHeader) break;
    if (type === 'PLTE') {
      if (
        sawPalette ||
        imageDataChunks.length > 0 ||
        colorType === 0 ||
        colorType === 4 ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0
      ) {
        break;
      }
      sawPalette = true;
    }
    if (type === 'IDAT') {
      if (imageDataEnded || length === 0) break;
      imageDataChunks.push(bytes.slice(dataStart, crcOffset));
    } else if (imageDataChunks.length > 0 && type !== 'IEND') {
      imageDataEnded = true;
    }
    offset = crcOffset + 4;
    if (type === 'IEND') {
      sawEnd = length === 0 && offset === bytes.byteLength;
      break;
    }
  }
  if (width === 0 || height === 0 || channels === 0 || imageDataChunks.length === 0 || !sawEnd) {
    throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
  }
  const imageDataLength = imageDataChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const imageData = new Uint8Array(imageDataLength);
  let imageDataOffset = 0;
  for (const chunk of imageDataChunks) {
    imageData.set(chunk, imageDataOffset);
    imageDataOffset += chunk.byteLength;
  }
  return { width, height, channels, imageData };
}

async function validatePngPixels(png: ParsedPng): Promise<void> {
  const rowBytes = png.width * png.channels;
  const expectedBytes = png.height * (rowBytes + 1);
  const pixels = new Uint8Array(expectedBytes);
  let receivedBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = new Blob([png.imageData])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    reader = stream.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (receivedBytes + result.value.byteLength > expectedBytes) {
        await reader.cancel();
        throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
      }
      pixels.set(result.value, receivedBytes);
      receivedBytes += result.value.byteLength;
    }
  } catch {
    await reader?.cancel().catch(() => undefined);
    throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
  }
  if (receivedBytes !== expectedBytes) {
    throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
  }
  for (let row = 0; row < png.height; row += 1) {
    if ((pixels[row * (rowBytes + 1)] ?? 5) > 4) {
      throw argumentFailure('Protected visual verification requires a valid inline PNG image.');
    }
  }
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function requestText(request: InferenceRequest): string {
  const parts: string[] = [];
  for (const message of request.messages) {
    for (const content of message.content) {
      if (content.type === 'text') parts.push(content.text);
      if (content.type === 'document' && content.source.type === 'text') {
        parts.push(content.source.text);
      }
    }
  }
  return parts.join('\n\n');
}

function requestImage(request: InferenceRequest): string {
  const images: string[] = [];
  for (const message of request.messages) {
    for (const content of message.content) {
      collectImage(content, images);
    }
  }
  if (images.length !== 1) {
    throw failure(
      `Workers AI visual verification requires exactly one inline image; received ${images.length}`,
      'invalid-image-count',
    );
  }
  return images[0] as string;
}

function collectImage(content: InferenceContent, images: string[]): void {
  if (content.type !== 'image') return;
  if (content.source.type !== 'base64') {
    throw failure(
      'Workers AI visual verification requires an inline base64 image',
      'invalid-image',
    );
  }
  images.push(`data:${content.source.mediaType};base64,${content.source.data}`);
}

function responseText(value: unknown): string {
  const result = value && typeof value === 'object' && 'result' in value ? value.result : value;
  if (!result || typeof result !== 'object') {
    throw failure('Workers AI returned no completion', 'invalid-response');
  }
  const response = 'response' in result ? result.response : undefined;
  if (typeof response === 'string' && response.trim().length > 0) return verdictText(response);
  if (response && typeof response === 'object') return verdictText(JSON.stringify(response));
  const choices = 'choices' in result && Array.isArray(result.choices) ? result.choices : [];
  const choice = choices[0];
  if (choice && typeof choice === 'object') {
    const message = 'message' in choice ? choice.message : undefined;
    if (message && typeof message === 'object' && 'content' in message) {
      const content = message.content;
      if (typeof content === 'string' && content.trim().length > 0) return verdictText(content);
    }
    if ('text' in choice && typeof choice.text === 'string' && choice.text.trim().length > 0) {
      return verdictText(choice.text);
    }
  }
  throw failure('Workers AI returned an empty completion', 'invalid-response');
}

function verdictText(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure('Workers AI returned a malformed visual verdict', 'invalid-response');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('Workers AI returned a malformed visual verdict', 'invalid-response');
  }
  const verdict = value as Record<string, unknown>;
  const keys = Object.keys(verdict).sort();
  const fix = verdict.fix;
  const validFix =
    fix === null ||
    (typeof fix === 'object' &&
      !Array.isArray(fix) &&
      typeof (fix as Record<string, unknown>).action === 'string' &&
      ((fix as Record<string, unknown>).action as string).trim().length > 0 &&
      typeof (fix as Record<string, unknown>).args === 'object' &&
      (fix as Record<string, unknown>).args !== null &&
      !Array.isArray((fix as Record<string, unknown>).args) &&
      Object.keys(fix as Record<string, unknown>)
        .sort()
        .join(',') === 'action,args');
  if (
    keys.join(',') !== 'fix,pass,reason' ||
    typeof verdict.pass !== 'boolean' ||
    typeof verdict.reason !== 'string' ||
    verdict.reason.trim().length === 0 ||
    !validFix
  ) {
    throw failure('Workers AI returned a malformed visual verdict', 'invalid-response');
  }
  return text;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseFailure(status: number, body: unknown): InferenceFailure {
  const detail = providerError(body);
  return new InferenceFailure({
    backend: 'cloudflare',
    status,
    code: detail.code,
    message: detail.message,
    retryable: status === 408 || status === 429,
    failureClass: status === 408 ? 'timeout' : 'http',
  });
}

function providerError(body: unknown): { readonly code: string; readonly message: string } {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const candidate = errors[0];
  const error =
    candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : record;
  const code =
    typeof error.code === 'string' || typeof error.code === 'number'
      ? String(error.code)
      : 'workers-ai-error';
  const message =
    typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : typeof body === 'string' && body.length > 0
        ? body
        : 'Workers AI failed';
  return { code, message };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function cancelledFailure(): InferenceFailure {
  return new InferenceFailure({
    backend: 'cloudflare',
    status: null,
    code: 'cancelled',
    message: 'Workers AI visual verification was cancelled',
    retryable: false,
    failureClass: 'cancelled',
  });
}

function failure(message: string, code: string, detail?: string): InferenceFailure {
  return new InferenceFailure({
    backend: 'cloudflare',
    status: null,
    code,
    message,
    ...(detail ? { detail } : {}),
    retryable: code === 'workers-ai-error',
    failureClass: code === 'workers-ai-error' ? 'network' : 'invalid-response',
  });
}

function cloudflareFailure(error: unknown): InferenceFailure {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const cause =
    record.cause && typeof record.cause === 'object'
      ? (record.cause as Record<string, unknown>)
      : {};
  const status = numericMember(record, 'status') ?? numericMember(cause, 'status');
  const providerCode = record.code ?? cause.code;
  const code =
    typeof providerCode === 'string' || typeof providerCode === 'number'
      ? String(providerCode)
      : 'workers-ai-error';
  const message = error instanceof Error && error.message ? error.message : 'Workers AI failed';
  const retryable = status === 408 || status === 429 || status === null;
  const failureClass = status === 408 ? 'timeout' : status === null ? 'network' : ('http' as const);
  return new InferenceFailure({
    backend: 'cloudflare',
    status,
    code,
    message,
    retryable,
    failureClass,
  });
}

function numericMember(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
