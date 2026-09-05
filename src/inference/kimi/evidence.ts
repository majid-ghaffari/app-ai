import {
  inlineEvidenceBucket,
  kimiEvidenceMaxTextBytes,
  kimiEvidenceMaxTotalBytes,
  type Env,
} from '../../config';
import type {
  InferenceContent,
  InferenceRequest,
  ProviderFileReference,
} from '../../lib/inference-types';
import { WorkerError } from '../../lib/responses';
import type { ProviderFileMetadata } from '../adapter';
import { deriveSealingKey, openToken, sealToken, type SealingPurpose } from '../token-sealing';

const PREFIX = 'inline-evidence/v1/';
const LIFETIME_MS = (15 * 24 + 1) * 60 * 60 * 1000;
const NONCE_BYTES = 12;
const PURPOSE: SealingPurpose = {
  salt: 'app-ai:inline-evidence:v1',
  info: 'object-encryption',
};
const HOSTED_PURPOSE: SealingPurpose = {
  salt: 'app-ai:kimi-hosted-image:v1',
  info: 'provider-reference',
};
const HOSTED_PREFIX = 'hosted_image_v1_';
const IMAGE_UPLOAD_CONCURRENCY = 2;
const IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function keyFor(id: string): string {
  if (!IDENTIFIER.test(id)) throw new Error('Invalid inline evidence identifier');
  return `${PREFIX}${id}`;
}

function metadata(
  id: string,
  custom: Record<string, string> | undefined,
): ProviderFileMetadata | null {
  const mediaType = custom?.mediaType;
  const sizeBytes = Number(custom?.sizeBytes);
  const expiresAt = custom?.expiresAt;
  if (
    !mediaType ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  )
    return null;
  return { id, mediaType, sizeBytes, expiresAt };
}

export async function uploadInlineEvidence(
  env: Env,
  bytes: Uint8Array,
  mediaType: string,
  abortSignal?: AbortSignal,
): Promise<ProviderFileMetadata> {
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const id = crypto.randomUUID();
  const key = keyFor(id);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(key) },
    await deriveSealingKey(env, PURPOSE, 'AES-GCM', ['encrypt']),
    bytes,
  );
  const sealed = new Uint8Array(NONCE_BYTES + cipher.byteLength);
  sealed.set(nonce);
  sealed.set(new Uint8Array(cipher), NONCE_BYTES);
  const expiresAt = new Date(Date.now() + LIFETIME_MS).toISOString();
  await inlineEvidenceBucket(env).put(key, sealed, {
    customMetadata: { mediaType, sizeBytes: String(bytes.byteLength), expiresAt },
  });
  if (abortSignal?.aborted) {
    await inlineEvidenceBucket(env).delete(key);
    throw new DOMException('Aborted', 'AbortError');
  }
  return { id, mediaType, sizeBytes: bytes.byteLength, expiresAt };
}

export async function getInlineEvidenceMetadata(
  env: Env,
  id: string,
): Promise<ProviderFileMetadata | null> {
  const object = await inlineEvidenceBucket(env).head(keyFor(id));
  return object ? metadata(id, object.customMetadata) : null;
}

export async function deleteInlineEvidence(env: Env, id: string): Promise<void> {
  await Promise.all([
    inlineEvidenceBucket(env).delete(keyFor(id)),
    inlineEvidenceBucket(env).delete(`${keyFor(id)}.hosted`),
  ]);
}

async function hostedImageId(
  env: Env,
  reference: ProviderFileReference,
  uploadImage: (bytes: Uint8Array, mediaType: string, signal?: AbortSignal) => Promise<string>,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const bucket = inlineEvidenceBucket(env);
  const key = `${keyFor(reference.upstreamFileId)}.hosted`;
  const current = await getInlineEvidenceMetadata(env, reference.upstreamFileId);
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (
    !current ||
    current.mediaType !== reference.mediaType ||
    current.sizeBytes !== reference.sizeBytes ||
    current.expiresAt !== reference.expiresAt
  ) {
    throw new WorkerError('File reference was unavailable or expired', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  const stored = await bucket.get(key);
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (stored) {
    try {
      const token = new TextDecoder().decode(await stored.arrayBuffer());
      const raw = await openToken(
        HOSTED_PREFIX,
        await deriveSealingKey(env, HOSTED_PURPOSE, 'AES-GCM', ['decrypt']),
        token,
      );
      const record = JSON.parse(raw) as { id?: unknown; contentHash?: unknown };
      if (typeof record.id === 'string' && record.contentHash === reference.contentHash) {
        return record.id;
      }
    } catch {
      await bucket.delete(key);
    }
  }
  const mediaType = reference.mediaType;
  if (!mediaType) throw new Error('Kimi evidence reference omitted its media type');
  const bytes = await readInlineEvidence(env, reference, abortSignal);
  const id = await uploadImage(bytes, mediaType, abortSignal);
  const sealed = await sealToken(
    HOSTED_PREFIX,
    await deriveSealingKey(env, HOSTED_PURPOSE, 'AES-GCM', ['encrypt']),
    JSON.stringify({ id, contentHash: reference.contentHash }),
  );
  await bucket.put(key, new TextEncoder().encode(sealed), {
    customMetadata: { expiresAt: reference.expiresAt ?? '' },
  });
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return id;
}

export async function readInlineEvidence(
  env: Env,
  reference: ProviderFileReference,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const key = keyFor(reference.upstreamFileId);
  const object = await inlineEvidenceBucket(env).get(key);
  const current = object ? metadata(reference.upstreamFileId, object.customMetadata) : null;
  if (
    !object ||
    !current ||
    current.mediaType !== reference.mediaType ||
    current.sizeBytes !== reference.sizeBytes ||
    current.expiresAt !== reference.expiresAt
  ) {
    throw new WorkerError('File reference was unavailable or expired', {
      status: 400,
      exceptionType: 'ArgumentException',
    });
  }
  const sealed = new Uint8Array(await object.arrayBuffer());
  if (sealed.byteLength <= NONCE_BYTES + 16) {
    throw new Error('Inline evidence object was truncated');
  }
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: sealed.slice(0, NONCE_BYTES),
        additionalData: new TextEncoder().encode(key),
      },
      await deriveSealingKey(env, PURPOSE, 'AES-GCM', ['decrypt']),
      sealed.slice(NONCE_BYTES),
    ),
  );
  if (plaintext.byteLength !== current.sizeBytes) throw new Error('Inline evidence size changed');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== reference.contentHash) throw new Error('Inline evidence content changed');
  return plaintext;
}

async function materializeContent(
  content: InferenceContent,
  hostImage: (reference: ProviderFileReference) => Promise<string>,
  readText: (reference: ProviderFileReference) => Promise<Uint8Array>,
  uploaded: Map<string, Promise<string>>,
): Promise<InferenceContent> {
  if (content.type === 'tool-result') {
    return {
      ...content,
      content: (await Promise.all(
        content.content.map((part) => materializeContent(part, hostImage, readText, uploaded)),
      )) as typeof content.content,
    };
  }
  if (
    content.type === 'document' &&
    content.source.type === 'content' &&
    Array.isArray(content.source.content)
  ) {
    const nested = await Promise.all(
      content.source.content.map((part) => materializeContent(part, hostImage, readText, uploaded)),
    );
    return {
      ...content,
      source: { type: 'content', content: nested as typeof content.source.content },
    };
  }
  if (content.type !== 'image' && content.type !== 'document') return content;
  if (content.source.type !== 'provider-file') return content;
  const reference = content.source.reference;
  if (reference.filePolicy !== 'kimi-stored-evidence') {
    throw new Error('Kimi evidence reference does not match its route');
  }
  const mediaType = reference.mediaType;
  if (!mediaType) throw new Error('Kimi evidence reference omitted its media type');
  if (mediaType.startsWith('image/')) {
    let hosted = uploaded.get(reference.upstreamFileId);
    if (!hosted) {
      hosted = hostImage(reference);
      uploaded.set(reference.upstreamFileId, hosted);
    }
    return {
      ...content,
      source: { type: 'provider-file', reference: { ...reference, upstreamFileId: await hosted } },
    };
  }
  const bytes = await readText(reference);
  if (content.type === 'document' && mediaType === 'text/plain') {
    return {
      ...content,
      source: {
        type: 'text',
        mediaType,
        text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
      },
    };
  }
  throw new Error(`Kimi evidence does not support ${mediaType} as ${content.type}`);
}

export function preflightInlineEvidence(env: Env, request: InferenceRequest): void {
  if (request.filePolicy.inputMode !== 'worker-file') return;
  const references = new Map<string, ProviderFileReference>();
  const collect = (content: InferenceContent): void => {
    if (content.type === 'tool-result') {
      content.content.forEach(collect);
      return;
    }
    if (
      content.type === 'document' &&
      content.source.type === 'content' &&
      Array.isArray(content.source.content)
    ) {
      content.source.content.forEach(collect);
      return;
    }
    if (
      (content.type === 'image' || content.type === 'document') &&
      content.source.type === 'provider-file' &&
      content.source.reference.filePolicy === 'kimi-stored-evidence'
    ) {
      references.set(content.source.reference.upstreamFileId, content.source.reference);
    }
  };
  request.messages.forEach((message) => message.content.forEach(collect));
  const total = [...references.values()].reduce(
    (sum, reference) => sum + (reference.sizeBytes ?? 0),
    0,
  );
  if (total > kimiEvidenceMaxTotalBytes(env)) {
    throw new WorkerError('Kimi Code request contains too much stored evidence', {
      status: 413,
      exceptionType: 'ArgumentException',
    });
  }
  const textTotal = [...references.values()].reduce(
    (sum, reference) =>
      sum + (reference.mediaType === 'text/plain' ? (reference.sizeBytes ?? 0) : 0),
    0,
  );
  if (textTotal > kimiEvidenceMaxTextBytes(env)) {
    throw new WorkerError('Kimi Code request contains too much stored text evidence', {
      status: 413,
      exceptionType: 'ArgumentException',
    });
  }
}

export async function materializeInlineEvidence(
  env: Env,
  request: InferenceRequest,
  uploadImage: (bytes: Uint8Array, mediaType: string, signal?: AbortSignal) => Promise<string>,
): Promise<InferenceRequest> {
  if (request.filePolicy.inputMode !== 'worker-file') return request;
  preflightInlineEvidence(env, request);
  const uploaded = new Map<string, Promise<string>>();
  let available = IMAGE_UPLOAD_CONCURRENCY;
  const waiting: Array<() => void> = [];
  const limitedHost = async (reference: ProviderFileReference) => {
    if (available > 0) available -= 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      if (request.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return await hostedImageId(env, reference, uploadImage, request.abortSignal);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else available += 1;
    }
  };
  let textAvailable = true;
  const textWaiting: Array<() => void> = [];
  const limitedRead = async (reference: ProviderFileReference) => {
    if (textAvailable) textAvailable = false;
    else await new Promise<void>((resolve) => textWaiting.push(resolve));
    try {
      if (request.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return await readInlineEvidence(env, reference, request.abortSignal);
    } finally {
      const next = textWaiting.shift();
      if (next) next();
      else textAvailable = true;
    }
  };
  return {
    ...request,
    messages: await Promise.all(
      request.messages.map(async (message) => ({
        ...message,
        content: await Promise.all(
          message.content.map((part) =>
            materializeContent(part, limitedHost, limitedRead, uploaded),
          ),
        ),
      })),
    ),
  };
}

export async function invalidateHostedImages(
  env: Env,
  request: InferenceRequest,
): Promise<boolean> {
  const ids = new Set<string>();
  const collect = (content: InferenceContent): void => {
    if (content.type === 'tool-result') {
      content.content.forEach(collect);
      return;
    }
    if (content.type !== 'image' && content.type !== 'document') return;
    if (content.source.type === 'provider-file') {
      const reference = content.source.reference;
      if (
        reference.filePolicy === 'kimi-stored-evidence' &&
        reference.mediaType?.startsWith('image/')
      )
        ids.add(reference.upstreamFileId);
      return;
    }
    if (
      content.type === 'document' &&
      content.source.type === 'content' &&
      Array.isArray(content.source.content)
    ) {
      content.source.content.forEach(collect);
    }
  };
  request.messages.forEach((message) => message.content.forEach(collect));
  await Promise.all([...ids].map((id) => inlineEvidenceBucket(env).delete(`${keyFor(id)}.hosted`)));
  return ids.size > 0;
}
