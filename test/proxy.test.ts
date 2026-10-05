/**
 * Coverage for the proxy surface — the live smart-image path and its shared
 * modules: the Anthropic client, the /files and /messages handlers, context-ID
 * validation, CORS, the error response shape, and the cache_control 4-block
 * management. fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import worker from '../src/index';
import { getCorsHeaders } from '../src/lib/cors';
import {
  SECRET_CONFIGURATION_PUBLIC_MESSAGE,
  jsonResponse,
  errorResponse,
  errorResponseFrom,
  WorkerError,
} from '../src/lib/responses';
import { validateContextId } from '../src/lib/auth';
import { InferenceFailure } from '../src/inference/adapter';
import type { InferenceBackendName } from '../src/lib/inference-types';
import type { Env } from '../src/config';
import { manageCacheControl } from '../src/inference/adapters/anthropic-cache';
import type {
  CacheableBlock,
  ClientMessagesPayload,
} from '../src/inference/adapters/anthropic-wire';
import * as anthropic from '../src/inference/adapters/anthropic-wire';
import { handleFileUpload, handleDeleteFile } from '../src/handlers/files';
import { handleMessages } from '../src/handlers/messages';
import { handleHealth } from '../src/handlers/health';
import { createLoggingRuntime } from '../src/lib/logger';
import { createInferenceService } from '../src/inference/factory';
import {
  GLOBAL_REGISTRY_ATTACHMENT_TENANT_SCOPE,
  fileTenantScope,
  mintOpaqueFileReference,
  openOwnedFileReference,
} from '../src/inference/file-references';
import {
  UNREGISTERED_MESSAGES_MAX_TOKENS,
  getFilePolicy,
  getModelProfile,
  getSystemPrompt,
  ONBOARDING_RULESET_VERSION,
} from '../src/prompt-registry';
import {
  ENV,
  CORS,
  anthropicMessage,
  opaqueFileEnv,
  stubFetch,
  fetchCall,
  fetchedUrls,
  headerOf,
  sentBody,
  kvMock,
  DISTANT_FILE_EXPIRY,
} from './helpers';

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function requestWithOrigin(origin: string | null): Request {
  const headers = origin ? { Origin: origin } : {};
  return new Request('https://app-ai.test/messages', { headers });
}

const TEST_CONTEXT_ID = 'ctx-file-test';

function deleteRequest(fileId: string): Request {
  return new Request(`https://app-ai.test/files/${fileId}`, {
    method: 'DELETE',
    headers: { 'X-Personalizer-Context-ID': TEST_CONTEXT_ID },
  });
}

/** A `/messages` request whose only evidence is one opaque file reference. */
function fileReferenceMessagesRequest(reference: string): Request {
  return new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: {
      'X-Personalizer-System-Prompt': 'image-selection',
      'X-Personalizer-Context-ID': TEST_CONTEXT_ID,
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'file', file_id: reference } }],
        },
      ],
    }),
  });
}

function promptUploadRequest(body: FormData): Request {
  return new Request('https://app-ai.test/files', {
    method: 'POST',
    headers: { 'X-Personalizer-Context-ID': TEST_CONTEXT_ID },
    body,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('cors', () => {
  it('returns base headers and no Allow-Origin when there is no Origin', () => {
    const h = getCorsHeaders(requestWithOrigin(null), ENV);
    expect(h['Access-Control-Allow-Methods']).toContain('POST');
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
    expect(h['Access-Control-Allow-Credentials']).toBeUndefined();
  });

  it('allows the ruleset-version request header', () => {
    const h = getCorsHeaders(requestWithOrigin('https://shop.example.com'), ENV);
    // The lib SENDS this custom request header on the onboarding handshake.
    expect(h['Access-Control-Allow-Headers']).toContain('X-Personalizer-Ruleset-Version');
    expect(h['Access-Control-Allow-Headers']).toContain('X-Personalizer-Visual-Quota-Class');
    expect(h['Access-Control-Allow-Headers']).toContain('X-Personalizer-QC-Attempt');
    expect(h['Access-Control-Allow-Headers']).toContain('X-Personalizer-QC-Capture-Ms');
    expect(h['Access-Control-Expose-Headers']).toBeUndefined();
  });

  it('allows credentials for an origin in the CREDENTIALED_ORIGINS config', () => {
    const h = getCorsHeaders(requestWithOrigin('http://localhost:4200'), ENV);
    expect(h['Access-Control-Allow-Origin']).toBe('http://localhost:4200');
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('echoes an arbitrary merchant origin without credentials (Vary: Origin)', () => {
    const h = getCorsHeaders(requestWithOrigin('https://shop.example.com'), ENV);
    expect(h['Access-Control-Allow-Origin']).toBe('https://shop.example.com');
    expect(h['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(h.Vary).toBe('Origin');
  });
});

describe('responses', () => {
  it('jsonResponse sets status, content-type, and merges CORS', async () => {
    const res = jsonResponse({ a: 1 }, CORS, 201);
    expect(res.status).toBe(201);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('errorResponse uses the Brain wire shape (flat PascalCase), default 500', async () => {
    const res = errorResponse('boom', CORS);
    expect(res.status).toBe(500);
    // Byte-identical to Brain's GlobalExceptionHandlerMiddleware serialization:
    // field order Message → ExceptionType, MessageDetail omitted when absent.
    expect(await res.text()).toBe('{"Message":"boom","ExceptionType":"Exception"}');
  });

  it('errorResponse carries MessageDetail (last field) when provided', async () => {
    const res = errorResponse('boom', CORS, 400, 'ArgumentException', 'detail');
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      '{"Message":"boom","ExceptionType":"ArgumentException","MessageDetail":"detail"}',
    );
  });

  it('errorResponseFrom names the API a normalized provider failure came from', async () => {
    const named: readonly (readonly [InferenceBackendName, string])[] = [
      ['anthropic', 'AnthropicApiException'],
      ['claude-code', 'AnthropicApiException'],
      ['openai', 'OpenAIApiException'],
      ['codex', 'OpenAIApiException'],
      ['moonshot', 'MoonshotApiException'],
      ['kimi', 'MoonshotApiException'],
      ['gemini', 'GeminiApiException'],
    ];
    for (const [backend, exceptionType] of named) {
      const res = errorResponseFrom(
        new InferenceFailure({
          backend,
          status: 429,
          code: 'rate_limit',
          message: 'rate limited',
          retryable: true,
          failureClass: 'http',
        }),
        CORS,
      );
      expect(res.status, backend).toBe(429);
      expect(await res.json(), backend).toMatchObject({ ExceptionType: exceptionType });
    }
  });

  it('errorResponseFrom maps a WorkerError to its own status + ExceptionType', async () => {
    const res = errorResponseFrom(
      new WorkerError('nope', { status: 404, exceptionType: 'RecordNotFoundException' }),
      CORS,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ Message: 'nope', ExceptionType: 'RecordNotFoundException' });
  });

  it('errorResponseFrom relays a Brain passthrough body + status UNCHANGED', async () => {
    const brainBody =
      '{"Message":"Invalid Context ID.","ExceptionType":"InvalidContextIDException"}';
    const res = errorResponseFrom(
      new WorkerError('Context validation failed', {
        status: 401,
        exceptionType: 'InvalidContextIDException',
        passthroughBody: brainBody,
      }),
      CORS,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(brainBody);
  });
});

describe('validateContextId', () => {
  it('throws a 401 MissingContextIDException when the context-ID is missing', async () => {
    const error = await validateContextId(null, ENV).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerError);
    const workerError = error as WorkerError;
    expect(workerError.message).toBe('Missing Context ID.');
    expect(workerError.status).toBe(401);
    expect(workerError.exceptionType).toBe('MissingContextIDException');
  });

  it('calls Brain with the context-ID and returns the payload on success', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ SubscriberID: 7, SubscriberTitle: 'Acme' }));

    const data = await validateContextId('ctx-7', ENV);
    expect(data.SubscriberID).toBe(7);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://brain.test/v2/administrator-authentication/validate-context-id');
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBe('ctx-7');
  });

  it('throws carrying Brain’s status + body for passthrough when Brain rejects the context-ID', async () => {
    const brainBody =
      '{"Message":"Invalid Context ID.","ExceptionType":"InvalidContextIDException"}';
    stubFetch().mockResolvedValue(new Response(brainBody, { status: 401 }));
    const error = await validateContextId('bad', ENV).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerError);
    const workerError = error as WorkerError;
    expect(workerError.message).toMatch(/validation failed/i);
    expect(workerError.status).toBe(401);
    expect(workerError.passthroughBody).toBe(brainBody);
  });

  it('throws a 500 BrainUnreachableException when the Brain fetch fails', async () => {
    stubFetch().mockRejectedValue(new TypeError('network down'));
    const error = await validateContextId('ctx', ENV).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkerError);
    const workerError = error as WorkerError;
    expect(workerError.status).toBe(500);
    expect(workerError.exceptionType).toBe('BrainUnreachableException');
    expect(workerError.message).toMatch(/network down/);
  });
});

describe('router error contract (Brain wire shape per status)', () => {
  const routerRequest = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`https://app-ai.test${path}`, init), ENV);

  it('401 — missing context-ID gate', async () => {
    const res = await routerRequest('/messages', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      Message: 'Missing Context ID.',
      ExceptionType: 'MissingContextIDException',
    });
  });

  it('401 — Brain’s rejection status + body relayed unchanged', async () => {
    const brainBody =
      '{"Message":"Invalid Context ID.","ExceptionType":"InvalidContextIDException"}';
    stubFetch().mockResolvedValue(new Response(brainBody, { status: 401 }));
    const res = await routerRequest('/messages', {
      method: 'POST',
      headers: { 'X-Personalizer-Context-ID': 'bad' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(brainBody);
  });

  it('404 — unknown route mirrors Brain’s RecordNotFoundException mapping', async () => {
    stubFetch().mockResolvedValue(new Response('{"SubscriberID":1}', { status: 200 }));
    const res = await routerRequest('/nope', {
      method: 'GET',
      headers: { 'X-Personalizer-Context-ID': 'ctx' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      Message: 'Resource not found.',
      ExceptionType: 'RecordNotFoundException',
    });
  });

  it('404 — no verb enumerates a provider account, so GET /files is an unknown route', async () => {
    // The provider account holds every tenant's uploads, so a listing could only
    // ever answer with other merchants' files. The path is not a route at all.
    const fetchMock = stubFetch().mockImplementation(() =>
      Promise.resolve(new Response('{"SubscriberID":1}', { status: 200 })),
    );
    for (const path of ['/files', '/files?prompt=image-selection']) {
      const res = await routerRequest(path, {
        method: 'GET',
        headers: { 'X-Personalizer-Context-ID': 'ctx' },
      });
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({
        Message: 'Resource not found.',
        ExceptionType: 'RecordNotFoundException',
      });
    }
    // Only the two context-ID validations reached the network; no provider call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('brain.test');
    }
  });

  it('500 — a handler throw becomes the default Exception envelope', async () => {
    stubFetch().mockResolvedValue(new Response('{"SubscriberID":1}', { status: 200 }));
    const res = await routerRequest('/messages', {
      method: 'POST',
      headers: { 'X-Personalizer-Context-ID': 'ctx' },
      body: 'not-json',
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ExceptionType).toBe('Exception');
    expect(typeof body.Message).toBe('string');
  });

  it('400 — client input validation mirrors Brain’s ArgumentException mapping', async () => {
    stubFetch().mockResolvedValue(new Response('{"SubscriberID":1}', { status: 200 }));
    const fd = new FormData();
    const res = await routerRequest('/files', {
      method: 'POST',
      headers: { 'X-Personalizer-Context-ID': 'ctx' },
      body: fd,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      Message: 'No file provided',
      ExceptionType: 'ArgumentException',
    });
  });

  it('500 — a missing config variable fails fast with the Brain envelope naming the variable', async () => {
    const res = await worker.fetch(
      new Request('https://app-ai.test/health', {
        headers: { Origin: 'https://shop.example.com' },
      }),
      { ENVIRONMENT: 'test' },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ExceptionType).toBe('Exception');
    expect(body.Message).toContain('CREDENTIALED_ORIGINS');
  });
});

describe('anthropic client', () => {
  it('uploadFile posts to /v1/files with the key and no beta header', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: 'file_1' }));

    const fd = new FormData();
    await anthropic.uploadFile(fd, ENV);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/files');
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'x-api-key')).toBe('test-key');
    expect(headerOf(init, 'anthropic-beta')).toBeUndefined();
    expect(init.body).toBe(fd);
  });

  it('deleteFile sends DELETE to the file URL', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await anthropic.deleteFile('file_42', ENV);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/files/file_42');
    expect(init.method).toBe('DELETE');
  });

  it('createMessage posts JSON to /v1/messages with the messages beta header', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: 'msg_1' }));

    await anthropic.createMessage({ model: 'm', messages: [] }, ENV);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(headerOf(init, 'anthropic-beta')).toBe('prompt-caching-2024-07-31,files-api-2025-04-14');
    expect(sentBody(init).model).toBe('m');
  });

  it('streamMessage forces stream:true in the body', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({}));

    await anthropic.streamMessage({ model: 'm', max_tokens: 1, messages: [] }, ENV);
    expect(sentBody(fetchCall(fetchMock, 0).init).stream).toBe(true);
  });

  it('every client call throws the config error when CLAUDE_API_KEY is absent', async () => {
    const { CLAUDE_API_KEY: _omitted, ...withoutKey } = ENV;
    await expect(anthropic.getFileMetadata('file_1', withoutKey)).rejects.toThrow(
      /Missing required configuration variable CLAUDE_API_KEY/,
    );
  });
});

describe('manageCacheControl', () => {
  it('caches the largest user blocks within remaining slots and strips the rest', () => {
    // 1 system slot used → 3 remaining. Four user blocks (3 image + 1 doc) →
    // the 3 largest (images) keep cache, the doc loses it.
    const payload: ClientMessagesPayload = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', cache_control: { type: 'ephemeral' } },
            { type: 'image', cache_control: { type: 'ephemeral' } },
            { type: 'image', cache_control: { type: 'ephemeral' } },
            { type: 'document', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };
    manageCacheControl(payload, 0);
    const blocks = payload.messages?.[0]?.content as CacheableBlock[];
    const cached = blocks.filter((b) => b.cache_control);
    expect(cached).toHaveLength(3);
    // KEPT user blocks carry the extended 1h TTL (LEVER 1).
    cached.forEach((b) => expect(b.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' }));
    expect(blocks.find((b) => b.type === 'document')?.cache_control).toBeUndefined();
  });

  it('strips all user cache_control when the system prompt + attachments fill all slots', () => {
    // 1 system slot + 4 prepended attachment blocks → over-full (5 > 4). The
    // exact attachment count (4) is passed in by the caller, so the trailing user
    // image is correctly treated as user content and must lose its cache_control.
    const att = (): CacheableBlock => ({ type: 'document', cache_control: { type: 'ephemeral' } });
    const payload: ClientMessagesPayload = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            att(),
            att(),
            att(),
            att(),
            { type: 'text', text: 'q' },
            { type: 'image', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };
    manageCacheControl(payload, 4);
    // The trailing user image (past the 4 attachment blocks) → cache stripped.
    const blocks = payload.messages?.[0]?.content as CacheableBlock[];
    expect(blocks[5]?.cache_control).toBeUndefined();
    const systemBlocks = payload.system as CacheableBlock[];
    expect([...systemBlocks, ...blocks].filter((block) => block.cache_control)).toHaveLength(4);
  });

  it('counts only the caller-supplied attachments, not user-supplied leading cached blocks', () => {
    // With a system prompt but ZERO prepended attachments (count 0), a user
    // document that happens to lead the content is treated as USER content
    // (eligible for the 3 remaining slots), NOT counted as an attachment.
    const payload: ClientMessagesPayload = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', cache_control: { type: 'ephemeral' } },
            { type: 'image', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };
    manageCacheControl(payload, 0);
    // 1 system + 0 attachments → 3 slots remain ≥ 2 user blocks → both kept.
    const blocks = payload.messages?.[0]?.content as CacheableBlock[];
    expect(blocks.filter((b) => b.cache_control)).toHaveLength(2);
  });

  it('prioritizes the explicit stable-prefix breakpoint with one cached system block', () => {
    const payload: ClientMessagesPayload = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'file', file_id: 'file_stable' },
              limespot_stable_cache_prefix: true,
            },
            { type: 'image', source: { type: 'file', file_id: 'file_current_1' } },
            { type: 'image', source: { type: 'file', file_id: 'file_current_2' } },
            { type: 'image', source: { type: 'file', file_id: 'file_current_3' } },
          ],
        },
      ],
    };

    manageCacheControl(payload);

    const blocks = payload.messages?.[0]?.content as CacheableBlock[];
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[0]?.limespot_stable_cache_prefix).toBeUndefined();
    expect(blocks.filter((block) => block.cache_control)).toHaveLength(3);
    expect(blocks[3]?.cache_control).toBeUndefined();
  });

  it('reserves the explicit stable-prefix breakpoint with two cached system blocks', () => {
    const payload: ClientMessagesPayload = {
      system: [
        { type: 'text', text: 'prompt', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'defaults', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'file', file_id: 'file_stable' },
              limespot_stable_cache_prefix: true,
            },
            { type: 'image', source: { type: 'file', file_id: 'file_current_1' } },
            { type: 'image', source: { type: 'file', file_id: 'file_current_2' } },
          ],
        },
      ],
    };

    manageCacheControl(payload);

    const blocks = payload.messages?.[0]?.content as CacheableBlock[];
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[2]?.cache_control).toBeUndefined();
    expect(blocks.filter((block) => block.cache_control)).toHaveLength(2);
  });

  it('keeps an attachment and explicit stable-prefix breakpoint inside the four-slot limit', () => {
    const payload: ClientMessagesPayload = {
      system: [
        { type: 'text', text: 'prompt', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'defaults', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'file', file_id: 'file_attachment' },
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
            {
              type: 'image',
              source: { type: 'file', file_id: 'file_stable' },
              limespot_stable_cache_prefix: true,
            },
            { type: 'image', source: { type: 'file', file_id: 'file_current' } },
          ],
        },
      ],
    };

    manageCacheControl(payload, 1);

    const blocks = payload.messages?.[0]?.content as CacheableBlock[];
    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[2]?.cache_control).toBeUndefined();
    const systemBlocks = payload.system as CacheableBlock[];
    expect([...systemBlocks, ...blocks].filter((block) => block.cache_control)).toHaveLength(4);
  });

  it('strips unmanaged text and later-message breakpoints before allocating the four slots', () => {
    const payload: ClientMessagesPayload = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'unmanaged', cache_control: { type: 'ephemeral' } },
            {
              type: 'image',
              source: { type: 'file', file_id: 'stable' },
              limespot_stable_cache_prefix: true,
            },
            { type: 'image', source: { type: 'file', file_id: 'current' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'old', cache_control: { type: 'ephemeral' } }],
        },
      ],
    };

    manageCacheControl(payload);

    const first = payload.messages?.[0]?.content as CacheableBlock[];
    const second = payload.messages?.[1]?.content as CacheableBlock[];
    expect(first[0]?.cache_control).toBeUndefined();
    expect(first[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(second[0]?.cache_control).toBeUndefined();
    const system = payload.system as CacheableBlock[];
    expect([...system, ...first, ...second].filter((block) => block.cache_control)).toHaveLength(3);
  });

  it('is a no-op when the first message content is not an array', () => {
    const payload: ClientMessagesPayload = { messages: [{ role: 'user', content: 'hi' }] };
    expect(() => manageCacheControl(payload, 0)).not.toThrow();
  });
});

describe('handleHealth', () => {
  it('returns ok with a timestamp', async () => {
    const res = handleHealth(CORS, ENV);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns the build revision marker (C0014 item 14) — "dev" under a define-less build', async () => {
    // The FREE-stack preflight asserts `/health` carries a non-"dev" `buildRev` (the exact served
    // revision injected by esbuild `--define __APP_AI_REV__`). Under vitest there is no define, so the
    // `typeof` guard degrades to "dev" — the fail-closed default a live preflight rejects. This pins
    // the field EXISTS as a string (a marker regression) + the graceful no-define fallback.
    const res = handleHealth(CORS, ENV);
    const body = (await res.json()) as { buildRev?: unknown };
    expect(typeof body.buildRev).toBe('string');
    expect(body.buildRev).toBe('dev');
  });

  it('fails health closed when a production deployment has no attributable revision', async () => {
    const res = handleHealth(CORS, { ...ENV, ENVIRONMENT: 'production' }, undefined, 'dev');
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      Message: 'App AI deployment has no attributable source revision.',
      ExceptionType: 'UnattributableBuildException',
      MessageDetail: 'Configure Cloudflare Workers Builds to deploy with `npm run deploy`.',
    });
  });

  it('reports an attributable production revision as healthy', async () => {
    const res = handleHealth(CORS, { ...ENV, ENVIRONMENT: 'production' }, undefined, 'fc00704');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; buildRev: string };
    expect(body.status).toBe('ok');
    expect(body.buildRev).toBe('fc00704');
  });

  it('fails production health closed on a missing required secret, naming nothing', async () => {
    const { CLAUDE_API_KEY: _key, ...withoutKey } = ENV;
    const res = handleHealth(
      CORS,
      { ...withoutKey, ENVIRONMENT: 'production' },
      undefined,
      'fc00704',
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      Message: 'App AI service is not ready.',
      ExceptionType: 'ServiceUnavailableException',
    });
    expect(JSON.stringify(body)).not.toMatch(/CLAUDE_API_KEY|secret|\.dev\.vars/i);
    // A dormant provider's key is not a readiness failure on an Anthropic-only route set.
    const {
      OPENAI_API_KEY: _openai,
      MOONSHOT_API_KEY: _moonshot,
      KIMI_API_KEY: _kimi,
      GEMINI_API_KEY: _gemini,
      ...anthropicOnly
    } = ENV;
    expect(
      handleHealth(CORS, { ...anthropicOnly, ENVIRONMENT: 'production' }, undefined, 'fc00704')
        .status,
    ).toBe(200);
  });

  it('fails production health closed when the model bindings do not route, naming no id', async () => {
    for (const broken of [
      { ...ENV, ENVIRONMENT: 'production', MODEL_FAST: 'mistral-large-3' },
      { ...ENV, ENVIRONMENT: 'production', MODEL_OVERRIDES: 'onboarding-chat=gemini-3-pro' },
      {
        ...ENV,
        ENVIRONMENT: 'production',
        MODEL_OVERRIDES: `${ENV.MODEL_OVERRIDES},onboarding-visual=gpt-4.1,onboarding-qc-gate=gpt-4.1`,
      },
    ]) {
      const res = handleHealth(CORS, broken, undefined, 'fc00704');
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        Message: 'App AI service is not ready.',
        ExceptionType: 'ServiceUnavailableException',
      });
      expect(JSON.stringify(body)).not.toMatch(/mistral|gemini|gpt|MODEL_|onboarding-/);
    }
  });

  it('answers the same status-only 503 through the Worker route for an unrecorded model generation', async () => {
    vi.stubGlobal('__APP_AI_REV__', 'fc00704');
    vi.resetModules();
    try {
      const { default: builtWorker } = await import('../src/index');
      const production: Env = { ...ENV, ENVIRONMENT: 'production' };
      const healthy = await builtWorker.fetch(
        new Request('https://app-ai.test/health'),
        production,
      );
      expect(healthy.status).toBe(200);
      expect(((await healthy.json()) as { buildRev: string }).buildRev).toBe('fc00704');

      const unrecorded = await builtWorker.fetch(new Request('https://app-ai.test/health'), {
        ...production,
        MODEL_OVERRIDES: `${ENV.MODEL_OVERRIDES},onboarding-visual=gpt-4.1,onboarding-qc-gate=gpt-4.1`,
      });
      expect(unrecorded.status).toBe(503);
      const body = (await unrecorded.json()) as Record<string, unknown>;
      expect(body).toEqual({
        Message: 'App AI service is not ready.',
        ExceptionType: 'ServiceUnavailableException',
      });
      expect(JSON.stringify(body)).not.toMatch(/gpt|MODEL_|onboarding-/);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('fails production health closed when a configured Workers AI route has no binding', async () => {
    const { AI: _binding, ...withoutBinding } = ENV;
    const routed = {
      ...withoutBinding,
      ENVIRONMENT: 'production',
      MODEL_OVERRIDES: 'free-render-verification=@cf/qwen/qwen3.8-27b',
    };
    const missing = handleHealth(CORS, routed, undefined, 'fc00704');
    expect(missing.status).toBe(503);
    await expect(missing.json()).resolves.toEqual({
      Message: 'App AI service is not ready.',
      ExceptionType: 'ServiceUnavailableException',
    });

    const configured = handleHealth(
      CORS,
      { ...routed, AI: { run: vi.fn() } },
      undefined,
      'fc00704',
    );
    expect(configured.status).toBe(200);
  });

  it('fails production health closed when the acceptance reserve is missing or invalid', () => {
    const { FREE_VISUAL_VERIFY_ACCEPTANCE_RESERVE: _reserve, ...withoutReserve } = ENV;
    expect(
      handleHealth(CORS, { ...withoutReserve, ENVIRONMENT: 'production' }, undefined, 'fc00704')
        .status,
    ).toBe(503);
    expect(
      handleHealth(
        CORS,
        {
          ...ENV,
          ENVIRONMENT: 'production',
          FREE_VISUAL_VERIFY_ACCEPTANCE_RESERVE: '8',
        },
        undefined,
        'fc00704',
      ).status,
    ).toBe(503);
  });

  it('requires the evidence bucket when a production prompt routes to Kimi', () => {
    const routed = {
      ...ENV,
      ENVIRONMENT: 'production',
      MODEL_OVERRIDES:
        'free-render-verification=@cf/qwen/qwen3.8-27b,render-verification=kimi-for-coding',
    };
    expect(handleHealth(CORS, routed, undefined, 'fc00704').status).toBe(503);
    expect(
      handleHealth(CORS, { ...routed, INLINE_EVIDENCE_R2: {} as R2Bucket }, undefined, 'fc00704')
        .status,
    ).toBe(200);
  });

  it('stays a plain liveness check outside production', async () => {
    const { CLAUDE_API_KEY: _key, ...withoutKey } = ENV;
    const res = handleHealth(CORS, { ...withoutKey, MODEL_FAST: 'mistral-large-3' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });
});

describe('files handlers', () => {
  it('upload returns a 400 ArgumentException when no file is provided', async () => {
    const req = new Request('https://app-ai.test/files', { method: 'POST', body: new FormData() });
    const res = await handleFileUpload(req, ENV, CORS);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.Message).toMatch(/no file/i);
    expect(body.ExceptionType).toBe('ArgumentException');
  });

  it('requires a registered destination prompt before provider I/O', async () => {
    const fetchMock = stubFetch();
    const missing = new FormData();
    missing.append('file', new Blob(['x']), 'a.txt');
    const { env } = kvMock();
    const missingResponse = await handleFileUpload(promptUploadRequest(missing), env, CORS);
    expect(missingResponse.status).toBe(400);
    expect(await missingResponse.json()).toMatchObject({ ExceptionType: 'ArgumentException' });

    const unknown = new FormData();
    unknown.append('file', new Blob(['x']), 'a.txt');
    unknown.append('prompt', 'not-registered');
    const unknownResponse = await handleFileUpload(promptUploadRequest(unknown), env, CORS);
    expect(unknownResponse.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires exactly one runtime file part before provider I/O', async () => {
    const fetchMock = stubFetch();
    const { env } = kvMock();
    const duplicate = new FormData();
    duplicate.append('file', new Blob(['a']), 'a.txt');
    duplicate.append('file', new Blob(['b']), 'b.txt');
    duplicate.append('prompt', 'image-selection');
    const duplicateResponse = await handleFileUpload(promptUploadRequest(duplicate), env, CORS);
    expect(duplicateResponse.status).toBe(400);
    expect(await duplicateResponse.json()).toMatchObject({ ExceptionType: 'ArgumentException' });

    const stringPart = new FormData();
    stringPart.append('file', 'not-a-file');
    stringPart.append('prompt', 'image-selection');
    const stringResponse = await handleFileUpload(promptUploadRequest(stringPart), env, CORS);
    expect(stringResponse.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an immediately usable sealed reference without a KV binding', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(
        jsonOk({
          id: 'file_no_kv',
          type: 'file',
          mime_type: 'text/plain',
          size_bytes: 1,
          expires_at: DISTANT_FILE_EXPIRY,
        }),
      )
      .mockResolvedValueOnce(jsonOk(anthropicMessage([{ type: 'text', text: '{}' }])));
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'a.txt');
    fd.append('prompt', 'visual-verify');
    const response = await handleFileUpload(promptUploadRequest(fd), ENV, CORS);
    expect(response.status).toBe(200);
    const opaque = (await response.json()) as { id: string; type: string };
    expect(opaque).toMatchObject({
      id: expect.stringMatching(/^file_ref_v1_[A-Za-z0-9_-]+$/),
      type: 'file',
    });
    const tenantScope = await fileTenantScope(TEST_CONTEXT_ID, ENV);
    if (!tenantScope) throw new Error('test tenant scope missing');
    const entry = getSystemPrompt('visual-verify', ENV);
    await createInferenceService(ENV, tenantScope).complete({
      prompt: entry.prompt,
      promptGroup: entry.group,
      modelProfile: getModelProfile(entry.name, ENV),
      filePolicy: getFilePolicy(entry.filePolicy),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'file', reference: { id: opaque.id, type: 'file' } },
              cache: 'none',
            },
          ],
        },
      ],
      maxOutputTokens: entry.maxTokens,
      tools: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('validates the sealing key before provider I/O', async () => {
    const fetchMock = stubFetch();
    const form = () => {
      const fd = new FormData();
      fd.append('file', new Blob(['x']), 'a.txt');
      fd.append('prompt', 'visual-verify');
      return fd;
    };
    const { TOKEN_ENCRYPTION_SECRET: _missing, ...missingKeyEnv } = ENV;
    const missing = await handleFileUpload(promptUploadRequest(form()), missingKeyEnv, CORS);
    expect(missing.status).toBe(500);
    // Absent or malformed, the secret is a worker fault answered generically —
    // the upload route carries neither its name nor the secret-store instruction.
    expect(await missing.json()).toEqual({
      Message: SECRET_CONFIGURATION_PUBLIC_MESSAGE,
      ExceptionType: 'Exception',
    });

    const malformed = await handleFileUpload(
      promptUploadRequest(form()),
      { ...ENV, TOKEN_ENCRYPTION_SECRET: 'not-valid-base64!' },
      CORS,
    );
    expect(malformed.status).toBe(500);
    const malformedBody = (await malformed.json()) as Record<string, unknown>;
    expect(malformedBody).toEqual({
      Message: SECRET_CONFIGURATION_PUBLIC_MESSAGE,
      ExceptionType: 'Exception',
    });
    expect(JSON.stringify(malformedBody)).not.toMatch(/TOKEN_ENCRYPTION_SECRET|base64/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails a registered prompt with missing model configuration before provider I/O', async () => {
    const fetchMock = stubFetch();
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'a.txt');
    fd.append('prompt', 'proposals');
    const { MODEL_BALANCED: _missingBalanced, ...missingBalancedEnv } = env;
    const response = await handleFileUpload(promptUploadRequest(fd), missingBalancedEnv, CORS);
    expect(response.status).toBe(500);
    expect(((await response.json()) as { Message: string }).Message).toContain('MODEL_BALANCED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('upload proxies the file and returns Anthropic body on success', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonOk({
        id: 'file_99',
        type: 'file',
        mime_type: 'text/plain',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );

    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
    fd.append('prompt', 'image-selection');
    const req = promptUploadRequest(fd);

    const { env } = kvMock();
    const res = await handleFileUpload(req, env, CORS);
    expect(res.status).toBe(200);
    // One declared prompt is addressed through the map too, so a caller reads the
    // same field whatever it declared.
    const body = (await res.json()) as {
      id: string;
      type: string;
      references: Record<string, { id: string; type: string }>;
    };
    expect(body.id).toMatch(/^file_ref_v1_[A-Za-z0-9_-]+$/);
    expect(body).toEqual({
      id: body.id,
      type: 'file',
      references: { 'image-selection': { id: body.id, type: 'file' } },
    });
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files');
  });

  it('upload routes through dedup: a KV hit reuses the cached id without a POST', async () => {
    // FILES_KV bound + hash already mapped → handler returns the cached id and
    // never POSTs an upload (it does one GET metadata existence check). The
    // response is the usual reference + per-prompt map — transparent to the lib
    // client.
    const cachedId = 'file_dedup';
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonOk(
        {
          id: cachedId,
          type: 'file',
          mime_type: 'image/jpeg',
          size_bytes: 16,
          expires_at: DISTANT_FILE_EXPIRY,
        },
        200,
      ),
    );
    const { env } = kvMock(JSON.stringify({ fileId: cachedId, createdAt: 1 }));

    const fd = new FormData();
    fd.append('file', new Blob(['screenshot-bytes'], { type: 'image/jpeg' }), 'screenshot.jpg');
    fd.append('prompt', 'image-selection');
    const req = promptUploadRequest(fd);

    const res = await handleFileUpload(req, env, CORS);
    expect(res.status).toBe(200);
    const cached = (await res.json()) as {
      id: string;
      type: string;
      references: Record<string, { id: string; type: string }>;
    };
    expect(cached.id).toMatch(/^file_ref_v1_[A-Za-z0-9_-]+$/);
    expect(cached.type).toBe('file');
    expect(cached.references).toEqual({ 'image-selection': { id: cached.id, type: 'file' } });
    // Only the metadata existence check fired — no upload POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe(`https://api.anthropic.com/v1/files/${cachedId}`);
    expect(init.method).toBeUndefined();
  });

  it('collapses same-group destinations to one direct upload and one opaque reference', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonOk({
        id: 'file_same_group',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-batch-all');
    fd.append('prompt', 'onboarding-review-all');
    const response = await handleFileUpload(promptUploadRequest(fd), env, CORS);
    expect(response.status).toBe(200);
    // One route, one upload, one reference — plus a map naming BOTH declared
    // prompts, so the caller reads the same field it reads across routes.
    const body = (await response.json()) as {
      id: string;
      type: string;
      references: Record<string, { id: string; type: string }>;
    };
    expect(body.id).toMatch(/^file_ref_v1_[A-Za-z0-9_-]+$/);
    expect(body).toEqual({
      id: body.id,
      type: 'file',
      references: {
        'onboarding-batch-all': { id: body.id, type: 'file' },
        'onboarding-review-all': { id: body.id, type: 'file' },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('collapses a shared file route across the QC cascade to one upload and reference', async () => {
    const fetchMock = stubFetch().mockResolvedValue(
      jsonOk({
        id: 'file_cascade',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-review-gate-all');
    fd.append('prompt', 'onboarding-review-all');
    const response = await handleFileUpload(promptUploadRequest(fd), env, CORS);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      type: string;
      references: Record<string, { id: string; type: string }>;
    };
    expect(body.id).toMatch(/^file_ref_v1_[A-Za-z0-9_-]+$/);
    // The borrowing group and the group that owns the route share one upload, so
    // both prompts are named against the single minted reference.
    expect(body.references).toEqual({
      'onboarding-review-gate-all': { id: body.id, type: 'file' },
      'onboarding-review-all': { id: body.id, type: 'file' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the map reference for every prompt sharing one file route', async () => {
    const uploadMock = stubFetch().mockResolvedValue(
      jsonOk({
        id: 'file_cascade_shared',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-review-gate-all');
    fd.append('prompt', 'onboarding-review-all');
    fd.append('prompt', 'onboarding-batch-all');
    const uploaded = (await (
      await handleFileUpload(promptUploadRequest(fd), env, CORS)
    ).json()) as {
      id: string;
      references: Record<string, { id: string; type: string }>;
    };
    expect(uploadMock).toHaveBeenCalledTimes(1);

    for (const prompt of [
      'onboarding-review-gate-all',
      'onboarding-review-all',
      'onboarding-batch-all',
    ]) {
      // Address the evidence exactly as a caller does: by the map entry for the
      // prompt about to consume it, not by the top-level reference.
      const named = uploaded.references[prompt];
      if (!named) throw new Error(`upload response named no reference for ${prompt}`);
      expect(named.id).toBe(uploaded.id);
      const fetchMock = stubFetch().mockImplementation(async () => jsonOk(anthropicMessage()));
      const request = new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-System-Prompt': prompt,
          'X-Personalizer-Context-ID': TEST_CONTEXT_ID,
          'X-Personalizer-Ruleset-Version': ONBOARDING_RULESET_VERSION,
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'file', file_id: named.id } }],
            },
          ],
        }),
      });
      const response = await handleMessages(request, env, CORS);
      expect(response.status, prompt).toBe(200);
      const index = fetchedUrls(fetchMock).findIndex((url) => url.endsWith('/v1/messages'));
      const body = sentBody(fetchCall(fetchMock, index).init);
      expect(JSON.stringify(body)).toContain('file_cascade_shared');
    }
  });

  it('uploads different prompt groups in parallel and maps every prompt to its route', async () => {
    const fetchMock = stubFetch();
    const releases: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-review-all');
    fd.append('prompt', 'visual-verify');
    const pending = handleFileUpload(promptUploadRequest(fd), env, CORS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[0]?.(
      jsonOk({
        id: 'file_onboarding',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    releases[1]?.(
      jsonOk({
        id: 'file_verify',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const response = await pending;
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      references: Record<string, { id: string; type: string }>;
    };
    expect(Object.keys(body.references)).toEqual(['onboarding-review-all', 'visual-verify']);
    expect(body.id).toBe(body.references['onboarding-review-all']?.id);
    expect(body.references['visual-verify']?.id).not.toBe(body.id);
    expect(JSON.stringify(body)).not.toContain('anthropic');
    expect(JSON.stringify(body)).not.toContain('file_onboarding');
    expect(JSON.stringify(body)).not.toContain('file_verify');
  });

  it('releases a succeeding route upload when a sibling route fails', async () => {
    const fetchMock = stubFetch();
    const releases: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-review-all');
    fd.append('prompt', 'visual-verify');
    const pending = handleFileUpload(promptUploadRequest(fd), env, CORS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[0]?.(
      jsonOk({
        id: 'file_kept',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    releases[1]?.(jsonOk({ error: { message: 'server error' } }, 500));
    // The caller is answered with the failure and no reference at all, so the
    // object the surviving route created is unreachable — the handler deletes it
    // rather than leaving it on the provider account.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const release = fetchCall(fetchMock, 2);
    expect(release.url).toBe('https://api.anthropic.com/v1/files/file_kept');
    expect(release.init.method).toBe('DELETE');
    releases[2]?.(new Response(null, { status: 204 }));
    const response = await pending;
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ExceptionType: 'AnthropicApiException' });
  });

  it('answers the upload failure even when releasing the sibling upload fails', async () => {
    const fetchMock = stubFetch();
    const releases: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-review-all');
    fd.append('prompt', 'visual-verify');
    const pending = handleFileUpload(promptUploadRequest(fd), env, CORS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    releases[0]?.(
      jsonOk({
        id: 'file_unreleasable',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    releases[1]?.(jsonOk({ error: { message: 'server error' } }, 500));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    releases[2]?.(jsonOk({ error: { message: 'delete unavailable' } }, 503));
    const response = await pending;
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ExceptionType: 'AnthropicApiException' });
  });

  it('keeps a deduped sibling object when another route fails', async () => {
    // A dedup hit reused an object an earlier upload created and still owns, so
    // it is not this request's orphan and is left in place.
    const fetchMock = stubFetch();
    const releases: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const { env } = kvMock(JSON.stringify({ fileId: 'file_shared', createdAt: 1 }));
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-review-all');
    fd.append('prompt', 'visual-verify');
    const pending = handleFileUpload(promptUploadRequest(fd), env, CORS);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Both routes hit the dedup cache, so both calls are metadata existence
    // checks; one resolves and the other fails the whole upload.
    releases[0]?.(
      jsonOk({
        id: 'file_shared',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    releases[1]?.(jsonOk({ error: { message: 'server error' } }, 500));
    const response = await pending;
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchedUrls(fetchMock).some((url) => url.endsWith('/v1/files/file_shared'))).toBe(true);
    for (let index = 0; index < fetchMock.mock.calls.length; index += 1) {
      expect(fetchCall(fetchMock, index).init.method).not.toBe('DELETE');
    }
  });

  it('stores dedup metadata only and seals route metadata without uploaded bytes', async () => {
    const sentinel = 'PRODUCTION_BYTE_SENTINEL_5519';
    stubFetch().mockResolvedValue(
      jsonOk({
        id: 'file_metadata_only',
        type: 'file',
        mime_type: 'text/plain',
        size_bytes: 29,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { env, kv } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob([sentinel], { type: 'text/plain' }), 'evidence.txt');
    fd.append('prompt', 'proposals');
    const response = await handleFileUpload(promptUploadRequest(fd), env, CORS);
    expect(response.status).toBe(200);
    expect(kv.put).toHaveBeenCalledTimes(1);
    for (const [, value] of kv.put.mock.calls) {
      expect(value).not.toContain(sentinel);
      expect(JSON.parse(value)).toBeTypeOf('object');
    }
    const body = (await response.clone().json()) as { id: string };
    expect(body.id).not.toContain(sentinel);
    expect(body.id).not.toContain('file_metadata_only');
  });

  it('reuses an opaque reference inside its group and rejects cross-group use before provider I/O', async () => {
    const fetchMock = stubFetch().mockResolvedValueOnce(
      jsonOk({
        id: 'file_group_bound',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'onboarding-batch-all');
    const uploadResponse = await handleFileUpload(promptUploadRequest(fd), env, CORS);
    const opaque = (await uploadResponse.json()) as { id: string; type: 'file' };

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonOk(anthropicMessage([{ type: 'text', text: '{}' }])));
    const compatible = getSystemPrompt('onboarding-review-all', env);
    const tenantScope = await fileTenantScope(TEST_CONTEXT_ID, env);
    if (!tenantScope) throw new Error('test tenant scope missing');
    await createInferenceService(env, tenantScope).complete({
      prompt: compatible.prompt,
      promptGroup: compatible.group,
      modelProfile: getModelProfile(compatible.name, env),
      filePolicy: getFilePolicy(compatible.filePolicy),
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'file', reference: opaque }, cache: 'none' }],
        },
      ],
      maxOutputTokens: compatible.maxTokens,
      tools: [],
    });
    expect(JSON.stringify(sentBody(fetchCall(fetchMock, 0).init))).toContain('file_group_bound');

    fetchMock.mockClear();
    const incompatible = getSystemPrompt('visual-verify', env);
    await expect(
      createInferenceService(env, tenantScope).complete({
        prompt: incompatible.prompt,
        promptGroup: incompatible.group,
        modelProfile: getModelProfile(incompatible.name, env),
        filePolicy: getFilePolicy(incompatible.filePolicy),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'file', reference: opaque }, cache: 'none' },
            ],
          },
        ],
        maxOutputTokens: incompatible.maxTokens,
        tools: [],
      }),
    ).rejects.toMatchObject({ status: 400, exceptionType: 'ArgumentException' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a tampered opaque reference before prompt attachment upload or token preflight', async () => {
    const fetchMock = stubFetch();
    const env = ENV;
    const accountScope = await anthropic.fileAccountScope(env);
    const tenantScope = await fileTenantScope(TEST_CONTEXT_ID, env);
    if (!tenantScope) throw new Error('test tenant scope missing');
    const valid = await mintOpaqueFileReference(
      {
        provider: 'anthropic',
        accountScope,
        tenantScope,
        filePolicy: 'anthropic-provider-files',
        compatibleGroups: ['image-selection'],
        upstreamFileId: 'file_tamper_target',
        contentHash: 'hash',
        mediaType: 'image/png',
        sizeBytes: 1,
        expiresAt: null,
      },
      env,
    );
    const tamperIndex = 'file_ref_v1_'.length + 5;
    const original = valid.id[tamperIndex];
    const tampered = `${valid.id.slice(0, tamperIndex)}${original === 'A' ? 'B' : 'A'}${valid.id.slice(tamperIndex + 1)}`;
    const request = new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'X-Personalizer-System-Prompt': 'image-selection',
        'X-Personalizer-Context-ID': TEST_CONTEXT_ID,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'file', file_id: tampered },
              },
            ],
          },
        ],
      }),
    });
    const response = await handleMessages(request, env, CORS);
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      Message: expect.stringMatching(/invalid|expired/i),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed new-reference prefixes instead of treating them as provider IDs', async () => {
    const fetchMock = stubFetch();
    const { env } = kvMock();
    const request = new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'X-Personalizer-System-Prompt': 'visual-verify',
        'X-Personalizer-Context-ID': TEST_CONTEXT_ID,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'file', file_id: 'file_ref_v1_bad' } }],
          },
        ],
      }),
    });
    const response = await handleMessages(request, env, CORS);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      Message: expect.stringMatching(
        /opaque file reference.*invalid|invalid.*opaque file reference/i,
      ),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses another tenant's file reference at the /messages seam, before provider I/O", async () => {
    const fetchMock = stubFetch();
    const { ids } = await opaqueFileEnv(
      [{ upstreamFileId: 'file_other_tenant_messages', mediaType: 'image/png' }],
      ['image-selection'],
      'ctx-a-different-store',
    );
    const foreign = ids[0];
    if (!foreign) throw new Error('test reference was not minted');
    const response = await handleMessages(fileReferenceMessagesRequest(foreign), ENV, CORS);
    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toMatchObject({
      Message: 'File reference does not belong to this tenant',
      ExceptionType: 'UnauthorizedAccessException',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an expired file reference at the /messages seam, before provider I/O', async () => {
    const fetchMock = stubFetch();
    const accountScope = await anthropic.fileAccountScope(ENV);
    const tenantScope = await fileTenantScope(TEST_CONTEXT_ID, ENV);
    if (!tenantScope) throw new Error('test tenant scope missing');
    const mintedAt = Date.parse('2026-09-04T00:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(mintedAt);
    const opaque = await mintOpaqueFileReference(
      {
        provider: 'anthropic',
        accountScope,
        tenantScope,
        filePolicy: 'anthropic-provider-files',
        compatibleGroups: ['image-selection'],
        upstreamFileId: 'file_expired_messages',
        contentHash: 'hash',
        mediaType: 'image/png',
        sizeBytes: 1,
        expiresAt: null,
      },
      ENV,
    );
    now.mockReturnValue(mintedAt + 16 * 24 * 60 * 60 * 1000);
    const response = await handleMessages(fileReferenceMessagesRequest(opaque.id), ENV, CORS);
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      Message: expect.stringMatching(/invalid|expired/i),
      ExceptionType: 'ArgumentException',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a file reference sealed under the previous token-encryption secret', async () => {
    // Rotating the secret derives a different sealing key, so an outstanding
    // reference stops opening rather than opening under the new one.
    const fetchMock = stubFetch();
    const { ids } = await opaqueFileEnv(
      [{ upstreamFileId: 'file_before_rotation', mediaType: 'image/png' }],
      ['image-selection'],
      TEST_CONTEXT_ID,
    );
    const beforeRotation = ids[0];
    if (!beforeRotation) throw new Error('test reference was not minted');
    const rotated: Env = {
      ...ENV,
      TOKEN_ENCRYPTION_SECRET: 'cm90YXRlZC1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZjA=',
    };
    const response = await handleMessages(
      fileReferenceMessagesRequest(beforeRotation),
      rotated,
      CORS,
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({
      Message: expect.stringMatching(/invalid|expired/i),
      ExceptionType: 'ArgumentException',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing reference-key configuration as 500, not a caller file error', async () => {
    const fetchMock = stubFetch();
    const accountScope = await anthropic.fileAccountScope(ENV);
    const tenantScope = await fileTenantScope(TEST_CONTEXT_ID, ENV);
    if (!tenantScope) throw new Error('test tenant scope missing');
    const opaque = await mintOpaqueFileReference(
      {
        provider: 'anthropic',
        accountScope,
        tenantScope,
        filePolicy: 'anthropic-provider-files',
        compatibleGroups: ['render-verification'],
        upstreamFileId: 'file_config_test',
        contentHash: 'hash',
        mediaType: 'image/png',
        sizeBytes: 1,
        expiresAt: null,
      },
      ENV,
    );
    const { TOKEN_ENCRYPTION_SECRET: _missing, ...missingKeyEnv } = ENV;
    const response = await handleMessages(
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-System-Prompt': 'visual-verify',
          'X-Personalizer-Context-ID': TEST_CONTEXT_ID,
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'file', file_id: opaque.id } }],
            },
          ],
        }),
      }),
      missingKeyEnv,
      CORS,
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    // A worker-side secret fault, not the caller's file: 500 with the generic
    // configuration message, which names neither the secret nor its store.
    expect(body).toEqual({
      ExceptionType: 'Exception',
      Message: SECRET_CONFIGURATION_PUBLIC_MESSAGE,
    });
    expect(JSON.stringify(body)).not.toMatch(/TOKEN_ENCRYPTION_SECRET|encrypted secret/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an opaque reference from another tenant before provider I/O', async () => {
    const fetchMock = stubFetch().mockResolvedValueOnce(
      jsonOk({
        id: 'file_tenant_bound',
        type: 'file',
        mime_type: 'image/png',
        size_bytes: 1,
        expires_at: DISTANT_FILE_EXPIRY,
      }),
    );
    const { env } = kvMock();
    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    fd.append('prompt', 'visual-verify');
    const upload = await handleFileUpload(promptUploadRequest(fd), env, CORS);
    const opaque = (await upload.json()) as { id: string; type: 'file' };
    const otherTenant = await fileTenantScope('ctx-other-tenant', env);
    if (!otherTenant) throw new Error('test tenant scope missing');
    const entry = getSystemPrompt('visual-verify', env);
    fetchMock.mockClear();
    await expect(
      createInferenceService(env, otherTenant).complete({
        prompt: entry.prompt,
        promptGroup: entry.group,
        modelProfile: getModelProfile(entry.name, env),
        filePolicy: getFilePolicy(entry.filePolicy),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'file', reference: opaque }, cache: 'none' },
            ],
          },
        ],
        maxOutputTokens: entry.maxTokens,
        tools: [],
      }),
    ).rejects.toMatchObject({ status: 403, exceptionType: 'UnauthorizedAccessException' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an expired opaque reference before provider I/O', async () => {
    const accountScope = await anthropic.fileAccountScope(ENV);
    const tenantScope = await fileTenantScope(TEST_CONTEXT_ID, ENV);
    if (!tenantScope) throw new Error('test tenant scope missing');
    const issuedAt = Date.parse('2026-08-11T12:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(issuedAt);
    const opaque = await mintOpaqueFileReference(
      {
        provider: 'anthropic',
        accountScope,
        tenantScope,
        filePolicy: 'anthropic-provider-files',
        compatibleGroups: ['placement-vision'],
        upstreamFileId: 'file_expired',
        contentHash: 'hash',
        mediaType: 'image/png',
        sizeBytes: 1,
        expiresAt: new Date(issuedAt + 3600_000).toISOString(),
      },
      ENV,
    );
    now.mockReturnValue(issuedAt + 7200_000);
    const env = ENV;
    const fetchMock = stubFetch();
    const entry = getSystemPrompt('placement', env);
    await expect(
      createInferenceService(env, tenantScope).complete({
        prompt: entry.prompt,
        promptGroup: entry.group,
        modelProfile: getModelProfile(entry.name, env),
        filePolicy: getFilePolicy(entry.filePolicy),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'file',
                  reference: opaque,
                },
                cache: 'none',
              },
            ],
          },
        ],
        maxOutputTokens: entry.maxTokens,
        tools: [],
      }),
    ).rejects.toMatchObject({ status: 400, exceptionType: 'ArgumentException' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a reference openable through day 14 and refuses it after day 15', async () => {
    // Studio's tile cache forgets a reference after 14 days, so the worker's
    // 15-day cap is the later of the two by design: the client always gives up first.
    const day = 24 * 60 * 60 * 1000;
    const mintedAt = Date.parse('2026-09-04T00:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(mintedAt);
    const accountScope = await anthropic.fileAccountScope(ENV);
    const tenantScope = await fileTenantScope(TEST_CONTEXT_ID, ENV);
    if (!tenantScope) throw new Error('test tenant scope missing');
    const opaque = await mintOpaqueFileReference(
      {
        provider: 'anthropic',
        accountScope,
        tenantScope,
        filePolicy: 'anthropic-provider-files',
        compatibleGroups: ['placement-vision'],
        upstreamFileId: 'file_fifteen_days',
        contentHash: 'hash',
        mediaType: 'image/png',
        sizeBytes: 1,
        expiresAt: null,
      },
      ENV,
    );

    now.mockReturnValue(mintedAt + 14 * day);
    await expect(openOwnedFileReference(opaque.id, ENV, tenantScope)).resolves.toMatchObject({
      upstreamFileId: 'file_fifteen_days',
    });
    now.mockReturnValue(mintedAt + 15 * day + 1000);
    await expect(openOwnedFileReference(opaque.id, ENV, tenantScope)).rejects.toMatchObject({
      status: 400,
      exceptionType: 'ArgumentException',
      message: 'Opaque file reference was invalid or expired',
    });
  });

  it('refuses to mint a public reference for the shared registry-attachment scope', async () => {
    // That scope is exempt from the tenant check, so a public token carrying it
    // would open for every tenant. Registry attachments stay internal sources.
    const accountScope = await anthropic.fileAccountScope(ENV);
    await expect(
      mintOpaqueFileReference(
        {
          provider: 'anthropic',
          accountScope,
          tenantScope: GLOBAL_REGISTRY_ATTACHMENT_TENANT_SCOPE,
          filePolicy: 'anthropic-provider-files',
          compatibleGroups: ['placement-vision'],
          upstreamFileId: 'file_registry_attachment',
          contentHash: 'hash',
          mediaType: 'image/png',
          sizeBytes: 1,
          expiresAt: null,
        },
        ENV,
      ),
    ).rejects.toThrow('A registry-attachment reference is never minted as a public reference');
  });

  it('upload answers a provider 500 with the provider message and no added hint', async () => {
    stubFetch().mockResolvedValue(jsonOk({ error: { message: 'server error' } }, 500));

    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'a.txt');
    fd.append('prompt', 'image-selection');
    const req = promptUploadRequest(fd);

    const { env } = kvMock();
    const res = await handleFileUpload(req, env, CORS);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.Message).toBe('server error');
    expect(body.ExceptionType).toBe('AnthropicApiException');
  });

  it('delete resolves the provider and upstream object out of the sealed reference', async () => {
    const { ids } = await opaqueFileEnv(
      [{ upstreamFileId: 'file_sealed_1', mediaType: 'image/png' }],
      ['image-selection'],
      TEST_CONTEXT_ID,
    );
    const reference = ids[0];
    if (!reference) throw new Error('test reference was not minted');
    const fetchMock = stubFetch().mockResolvedValue(new Response(null, { status: 204 }));
    const res = await handleDeleteFile(reference, deleteRequest(reference), ENV, CORS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: 'File deleted successfully' });
    // The opaque id never reaches the provider; the sealed upstream id does.
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toContain('/v1/files/file_sealed_1');
    expect(url).not.toContain(reference);
    expect(init.method).toBe('DELETE');
  });

  it('delete rejects a malformed reference and one minted for another tenant, before provider I/O', async () => {
    const fetchMock = stubFetch();
    const malformed = await handleDeleteFile('file_1', deleteRequest('file_1'), ENV, CORS);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      Message: 'Invalid opaque file reference',
      ExceptionType: 'ArgumentException',
    });

    const { ids } = await opaqueFileEnv(
      [{ upstreamFileId: 'file_other_tenant', mediaType: null }],
      ['image-selection'],
      'ctx-someone-else',
    );
    const foreign = ids[0];
    if (!foreign) throw new Error('test reference was not minted');
    const res = await handleDeleteFile(foreign, deleteRequest(foreign), ENV, CORS);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      Message: 'File reference does not belong to this tenant',
      ExceptionType: 'UnauthorizedAccessException',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delete refuses a reference whose route has since been configured onto another provider', async () => {
    const { ids } = await opaqueFileEnv(
      [{ upstreamFileId: 'file_moved_route', mediaType: null }],
      ['image-selection'],
      TEST_CONTEXT_ID,
    );
    const reference = ids[0];
    if (!reference) throw new Error('test reference was not minted');
    const fetchMock = stubFetch();
    // The route's tier now resolves to another provider entirely.
    const movedProvider = await handleDeleteFile(
      reference,
      deleteRequest(reference),
      {
        ...ENV,
        MODEL_FAST: 'gpt-5.2',
      },
      CORS,
    );
    expect(movedProvider.status).toBe(409);
    expect(await movedProvider.json()).toMatchObject({
      Message: 'File reference does not belong to the configured provider route',
      ExceptionType: 'ArgumentException',
    });

    // Same provider, different credential: the object lives on an account this
    // worker can no longer address, so deleting would hit an unrelated object.
    const movedAccount = await handleDeleteFile(
      reference,
      deleteRequest(reference),
      { ...ENV, CLAUDE_API_KEY: 'a-different-anthropic-account' },
      CORS,
    );
    expect(movedAccount.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('delete maps an Anthropic failure to the Brain shape, keeping the upstream status', async () => {
    const { ids } = await opaqueFileEnv(
      [{ upstreamFileId: 'file_missing', mediaType: null }],
      ['image-selection'],
      TEST_CONTEXT_ID,
    );
    const reference = ids[0];
    if (!reference) throw new Error('test reference was not minted');
    stubFetch().mockResolvedValue(jsonOk({ error: { message: 'gone' } }, 404));
    const res = await handleDeleteFile(reference, deleteRequest(reference), ENV, CORS);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      Message: string;
      ExceptionType: string;
      MessageDetail: string;
    };
    expect(body.Message).toBe('gone');
    expect(body.ExceptionType).toBe('AnthropicApiException');
    expect(JSON.parse(body.MessageDetail)).toEqual({ error: { message: 'gone' } });
  });
});

describe('handleMessages', () => {
  function messagesRequest(body: unknown, systemPrompt?: string): Request {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx',
    };
    if (systemPrompt) headers['X-Personalizer-System-Prompt'] = systemPrompt;
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('proxies a plain request and returns the Anthropic body', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk(anthropicMessage([{ type: 'text', text: 'hi' }])));

    const res = await handleMessages(
      messagesRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe('hi');
    // Forwarded to the Messages API (not Files), on the worker's own route:
    // the caller's model and max_tokens are replaced, never honoured.
    const call = fetchCall(fetchMock, 0);
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.signal).toBeDefined();
    const sent = sentBody(call.init);
    expect(sent.model).toBe(ENV.MODEL_FAST);
    expect(sent.max_tokens).toBe(UNREGISTERED_MESSAGES_MAX_TOKENS);
  });

  it('refuses a provider file block on the unregistered-selector path before any provider call', async () => {
    const fetchMock = stubFetch();
    const bodies = [
      // A top-level media block naming a raw provider id.
      [{ type: 'image', source: { type: 'file', file_id: 'file_cache_diagnostic' } }],
      // The same id nested inside a tool result.
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'document', source: { type: 'file', file_id: 'file_nested' } }],
        },
      ],
    ];
    for (const content of bodies) {
      const res = await handleMessages(
        messagesRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content }] }),
        ENV,
        CORS,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        Message: expect.stringContaining('registered X-Personalizer-System-Prompt'),
        ExceptionType: 'ArgumentException',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a missing required secret with a generic 500, never the secret-store instruction', async () => {
    const fetchMock = stubFetch();
    const { CLAUDE_API_KEY: _key, ...withoutKey } = ENV;
    const res = await handleMessages(
      messagesRequest({ messages: [{ role: 'user', content: 'go' }] }, 'placement'),
      withoutKey,
      CORS,
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      Message: SECRET_CONFIGURATION_PUBLIC_MESSAGE,
      ExceptionType: 'Exception',
    });
    expect(JSON.stringify(body)).not.toMatch(/CLAUDE_API_KEY|encrypted secret|\.dev\.vars/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a registered prompt with a garbage file_id as a 400 ArgumentException, no provider call', async () => {
    const fetchMock = stubFetch();
    const res = await handleMessages(
      messagesRequest(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', source: { type: 'file', file_id: 'file_garbage' } }],
            },
          ],
        },
        'placement',
      ),
      ENV,
      CORS,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      Message: 'Invalid opaque file reference',
      ExceptionType: 'ArgumentException',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes legacy cache-allocation diagnostics through the request logger', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    stubFetch().mockResolvedValue(jsonOk(anthropicMessage([{ type: 'text', text: 'hi' }])));

    await handleMessages(
      messagesRequest({
        model: 'm',
        max_tokens: 10,
        system: 'stable',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
            ],
          },
        ],
      }),
      ENV,
      CORS,
      createLoggingRuntime({ ...ENV, LOG_TARGETS_INFO: 'console' }),
    );

    expect(info.mock.calls.some((call) => String(call[1]).includes('/4 slots used'))).toBe(true);
  });

  it('strips the client apiKey field before forwarding', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk(anthropicMessage()));

    await handleMessages(
      messagesRequest({ apiKey: 'leak', model: 'm', max_tokens: 1, messages: [] }),
      ENV,
      CORS,
    );
    const sent = sentBody(fetchCall(fetchMock, 0).init);
    expect(sent.apiKey).toBeUndefined();
    expect(sent.model).toBe(ENV.MODEL_FAST);
  });

  it('forwards the stable-prefix breakpoint without the internal marker or reordering image blocks', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(jsonOk({ input_tokens: 12 }))
      .mockResolvedValueOnce(jsonOk(anthropicMessage()));
    const inlineImage = (data: string) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data },
    });

    await handleMessages(
      messagesRequest({
        model: 'm',
        max_tokens: 1,
        messages: [
          {
            role: 'user',
            content: [
              inlineImage('original'),
              { ...inlineImage('round-0'), limespot_stable_cache_prefix: true },
              inlineImage('current-round'),
            ],
          },
        ],
      }),
      ENV,
      CORS,
    );

    const messagesCallIndex = fetchMock.mock.calls.findIndex(([url]) =>
      String(url).endsWith('/v1/messages'),
    );
    const sent = sentBody(fetchCall(fetchMock, messagesCallIndex).init);
    const blocks = sent.messages?.[0]?.content as CacheableBlock[];
    expect(blocks.map((block) => (block.source as { data: string }).data)).toEqual([
      'original',
      'round-0',
      'current-round',
    ]);
    expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks.every((block) => block.limespot_stable_cache_prefix === undefined)).toBe(true);
  });

  it('injects the selected system prompt as a cached system block', async () => {
    const fetchMock = stubFetch();
    fetchMock
      .mockResolvedValueOnce(
        jsonOk({
          id: 'file_attachment',
          type: 'file',
          mime_type: 'text/markdown',
          size_bytes: 1,
          expires_at: DISTANT_FILE_EXPIRY,
        }),
      )
      .mockResolvedValueOnce(jsonOk({ input_tokens: 10 }))
      .mockResolvedValueOnce(jsonOk(anthropicMessage()));

    await handleMessages(
      messagesRequest(
        { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'image-selection',
      ),
      ENV,
      CORS,
    );
    // image-selection is a multi-file prompt: it first uploads its sample.md
    // attachment (FormData body) and then POSTs /messages (JSON body). Grab the
    // messages call — the one whose body is a JSON string — not the upload.
    const messagesCallIndex = fetchMock.mock.calls.findIndex(
      ([, init]) => typeof init?.body === 'string',
    );
    const sent = sentBody(fetchCall(fetchMock, messagesCallIndex).init);
    expect(sent.system?.[0]?.type).toBe('text');
    // System prefix is a stable, reused prefix → extended 1h cache (LEVER 1).
    expect(sent.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(sent.system?.[0]?.text).toMatch(/CSS selectors/i);
    expect(sent.model).toBe(ENV.MODEL_FAST);
    expect(sent.messages?.[0]?.content?.[0]).toMatchObject({
      type: 'document',
      source: { type: 'file', file_id: 'file_attachment' },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  });

  it('fails closed when a registered prompt model binding is missing', async () => {
    const fetchMock = stubFetch();
    const { MODEL_FAST: _modelFast, ...missingFastModelEnv } = ENV;
    const res = await handleMessages(
      messagesRequest(
        { model: 'caller-model', max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'image-selection',
      ),
      missingFastModelEnv,
      CORS,
    );
    expect(res.status).toBe(500);
    expect((await res.json()) as unknown).toMatchObject({
      Message: expect.stringContaining('MODEL_FAST'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves structured output config while replacing caller effort from the registry', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk(anthropicMessage()));

    await handleMessages(
      messagesRequest(
        {
          model: 'caller-model',
          max_tokens: 1,
          output_config: {
            effort: 'high',
            format: { type: 'json_schema', schema: { type: 'object' } },
          },
          messages: [{ role: 'user', content: 'go' }],
        },
        'onboarding-review',
      ),
      ENV,
      CORS,
    );

    const sent = sentBody(fetchCall(fetchMock, 0).init);
    expect(sent.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
  });

  it('preserves registered-request sampling, stops, metadata, media, and abort signal', async () => {
    const caller = new AbortController();
    let upstreamCancelledWithCaller = false;
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async (_input, init) => {
      caller.abort();
      upstreamCancelledWithCaller = init?.signal?.aborted === true;
      return jsonOk(anthropicMessage());
    });
    const unsignalled = messagesRequest(
      {
        model: 'caller-model',
        max_tokens: 1,
        temperature: 0.25,
        top_p: 0.8,
        top_k: 40,
        stop_sequences: ['END'],
        metadata: { user_id: 'merchant-7' },
        service_tier: 'standard_only',
        tools: [
          {
            type: 'custom',
            name: 'browser_lookup',
            description: 'Look up browser state',
            input_schema: {
              type: 'object',
              additionalProperties: false,
            },
            strict: true,
            allowed_callers: ['direct'],
            defer_loading: true,
            input_examples: [{ page: 'Home' }],
            eager_input_streaming: false,
          },
          {
            type: 'code_execution_20260120',
            name: 'code_execution',
            allowed_callers: ['direct'],
            defer_loading: false,
          },
        ],
        tool_choice: {
          type: 'tool',
          name: 'browser_lookup',
          disable_parallel_tool_use: true,
        },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
              },
              { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
              {
                type: 'document',
                source: {
                  type: 'content',
                  content: [
                    {
                      type: 'text',
                      text: 'document body',
                      citations: [
                        {
                          type: 'content_block_location',
                          cited_text: 'document body',
                          document_index: 0,
                          document_title: 'Evidence',
                          start_block_index: 0,
                          end_block_index: 1,
                        },
                      ],
                      cache_control: { type: 'ephemeral', ttl: '1h' },
                    },
                    {
                      type: 'image',
                      source: { type: 'url', url: 'https://example.test/document-image.png' },
                      cache_control: { type: 'ephemeral' },
                    },
                  ],
                },
                title: 'Evidence',
                context: 'Merchant page',
                citations: { enabled: true },
              },
              {
                type: 'document',
                source: { type: 'content', content: 'string document' },
              },
              {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: 'evidence' },
              },
              {
                type: 'tool_result',
                tool_use_id: 'tool_1',
                content: [
                  { type: 'image', source: { type: 'url', url: 'https://example.test/tool.png' } },
                ],
              },
            ],
          },
          { role: 'assistant', content: [{ type: 'text', text: 'intermediate' }] },
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'content',
                  content: [
                    {
                      type: 'text',
                      text: 'later evidence',
                      cache_control: { type: 'ephemeral', ttl: '1h' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      'onboarding-review',
    );
    const request = new Request(unsignalled, { signal: caller.signal });

    await handleMessages(request, ENV, CORS);

    const call = fetchCall(fetchMock, 0);
    const sent = sentBody(call.init);
    expect(upstreamCancelledWithCaller).toBe(true);
    expect(sent).toMatchObject({
      temperature: 0.25,
      top_p: 0.8,
      top_k: 40,
      stop_sequences: ['END'],
      metadata: { user_id: 'merchant-7' },
      service_tier: 'standard_only',
      tool_choice: {
        type: 'tool',
        name: 'browser_lookup',
        disable_parallel_tool_use: true,
      },
      tools: [
        {
          type: 'custom',
          name: 'browser_lookup',
          description: 'Look up browser state',
          input_schema: {
            type: 'object',
            additionalProperties: false,
          },
          strict: true,
          allowed_callers: ['direct'],
          defer_loading: true,
          input_examples: [{ page: 'Home' }],
          eager_input_streaming: false,
        },
        {
          type: 'code_execution_20260120',
          name: 'code_execution',
          allowed_callers: ['direct'],
          defer_loading: false,
        },
      ],
    });
    expect(sent.messages?.[0]?.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.test/image.png' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'document',
        source: {
          type: 'content',
          content: [
            {
              type: 'text',
              text: 'document body',
              citations: [
                {
                  type: 'content_block_location',
                  cited_text: 'document body',
                  document_index: 0,
                  document_title: 'Evidence',
                  start_block_index: 0,
                  end_block_index: 1,
                },
              ],
            },
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.test/document-image.png' },
            },
          ],
        },
        title: 'Evidence',
        context: 'Merchant page',
        citations: { enabled: true },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      {
        type: 'document',
        source: { type: 'content', content: 'string document' },
      },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'evidence' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        is_error: false,
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/tool.png' } }],
      },
    ]);
    expect(sent.messages?.[2]?.content).toEqual([
      {
        type: 'document',
        source: {
          type: 'content',
          content: [{ type: 'text', text: 'later evidence' }],
        },
      },
    ]);
  });

  it('keeps protected quota headers out of ordinary prompt routing and metadata', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk(anthropicMessage()));
    const request = messagesRequest(
      {
        metadata: { protectedVisualQuotaClass: 'acceptance', user_id: 'merchant-7' },
        messages: [{ role: 'user', content: 'inspect this' }],
      },
      'onboarding-review',
    );
    request.headers.set('X-Personalizer-Visual-Quota-Class', 'acceptance');

    const response = await handleMessages(request, ENV, CORS);

    expect(response.status).toBe(200);
    expect(sentBody(fetchCall(fetchMock, 0).init).metadata).toEqual({
      protectedVisualQuotaClass: 'acceptance',
      user_id: 'merchant-7',
    });
  });

  it('replays Anthropic thinking and redacted-thinking blocks from assistant history', async () => {
    const fetchMock = stubFetch().mockResolvedValue(jsonOk(anthropicMessage()));
    await handleMessages(
      messagesRequest(
        {
          messages: [
            { role: 'user', content: 'first' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'private',
                  signature: 'signed',
                  cache_control: { type: 'ephemeral', ttl: '1h' },
                },
                {
                  type: 'redacted_thinking',
                  data: 'opaque-redacted',
                  cache_control: { type: 'ephemeral' },
                },
                { type: 'text', text: 'visible' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
        },
        'onboarding-review',
      ),
      ENV,
      CORS,
    );
    const sent = sentBody(fetchCall(fetchMock, 0).init);
    expect(sent.messages?.[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private', signature: 'signed' },
        { type: 'redacted_thinking', data: 'opaque-redacted' },
        { type: 'text', text: 'visible' },
      ],
    });
  });

  it('keeps advisory token-count and prompt-attachment timeouts best-effort', async () => {
    const preflightFetch = stubFetch()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(jsonOk(anthropicMessage()));
    const preflight = await handleMessages(
      messagesRequest(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
              ],
            },
          ],
        },
        'onboarding',
      ),
      ENV,
      CORS,
    );
    expect(preflight.status).toBe(200);
    expect(preflightFetch).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
    const attachmentFetch = stubFetch()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(jsonOk(anthropicMessage()));
    const attachment = await handleMessages(
      messagesRequest({ messages: [{ role: 'user', content: 'go' }] }, 'image-selection'),
      ENV,
      CORS,
    );
    expect(attachment.status).toBe(200);
    expect(attachmentFetch).toHaveBeenCalledTimes(2);
  });

  it('maps an Anthropic failure to the Brain shape, keeping the upstream status', async () => {
    stubFetch().mockResolvedValue(
      jsonOk({ error: { type: 'invalid_request_error', message: 'bad' } }, 400),
    );
    const res = await handleMessages(
      messagesRequest({ model: 'm', max_tokens: 1, messages: [] }),
      ENV,
      CORS,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.Message).toBe('bad');
    expect(body.ExceptionType).toBe('AnthropicApiException');
    expect(JSON.parse(String(body.MessageDetail))).toEqual({
      error: { type: 'invalid_request_error', message: 'bad' },
    });
    expect(body.error).toBeUndefined();
  });

  it('preserves an exhausted-credit failure as a non-success AnthropicApiException', async () => {
    const upstream = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.',
      },
      request_id: 'req_quota',
    };
    stubFetch().mockResolvedValue(jsonOk(upstream, 400));

    const res = await handleMessages(
      messagesRequest({ model: 'm', max_tokens: 1, messages: [] }),
      ENV,
      CORS,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.Message).toBe(upstream.error.message);
    expect(body.ExceptionType).toBe('AnthropicApiException');
    expect(JSON.parse(String(body.MessageDetail))).toEqual(upstream);
  });
});

describe('canonical tool serialization', () => {
  it('preserves full provider-neutral JSON Schema keywords', () => {
    expect(
      anthropic.serializeToolDefinitions([
        {
          name: 'strict_tool',
          description: 'Strict schema fixture',
          execution: 'server',
          inputSchema: {
            type: 'object',
            properties: { value: { $ref: '#/$defs/value' } },
            required: ['value'],
            additionalProperties: false,
            $defs: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
          },
        },
      ])[0]?.input_schema,
    ).toEqual({
      type: 'object',
      properties: { value: { $ref: '#/$defs/value' } },
      required: ['value'],
      additionalProperties: false,
      $defs: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    });
  });
});

describe('handleMessages — registry max_tokens EXACT', () => {
  // A `balanced` entry whose registry `maxTokens` is 128000 — the EXACT value the
  // registry forces onto the wire regardless of the client's ask. Pinned to the
  // registry so a future entry-token change flows into this expectation.
  const EXACT_PROMPT = 'onboarding-batch-all';
  const EXACT = getSystemPrompt(EXACT_PROMPT, ENV).maxTokens;

  function floorRequest(body: unknown, systemPrompt?: string): Request {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx',
    };
    if (systemPrompt) headers['X-Personalizer-System-Prompt'] = systemPrompt;
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  /** The `max_tokens` the handler forwarded to the Messages API. */
  async function forwardedMaxTokens(body: unknown, systemPrompt?: string): Promise<unknown> {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk(anthropicMessage()));
    await handleMessages(floorRequest(body, systemPrompt), ENV, CORS);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
    return sentBody(fetchCall(fetchMock, idx).init).max_tokens;
  }

  it('pins the exact entry to the registry (128000)', () => {
    expect(EXACT).toBe(128000);
  });

  it('a BELOW-registry client max_tokens (4096) is set to exactly the registry value (128000)', async () => {
    expect(
      await forwardedMaxTokens(
        { max_tokens: 4096, messages: [{ role: 'user', content: 'go' }] },
        EXACT_PROMPT,
      ),
    ).toBe(EXACT);
  });

  it('an ABOVE-registry client max_tokens (200000) is OVERRIDDEN down to the registry value (no cap kept, no floor)', async () => {
    // The OLD floor behavior (Math.max) preserved 200000; exact-registry overrides
    // it to the entry value. This is the load-bearing "no floor / no client read" proof.
    expect(
      await forwardedMaxTokens(
        { max_tokens: 200000, messages: [{ role: 'user', content: 'go' }] },
        EXACT_PROMPT,
      ),
    ).toBe(EXACT);
  });

  it('SETS the registry value (128000) when the client omits max_tokens entirely', async () => {
    const sent = await forwardedMaxTokens(
      { messages: [{ role: 'user', content: 'go' }] },
      EXACT_PROMPT,
    );
    expect(sent).toBe(EXACT);
  });

  it('leaves max_tokens UNTOUCHED for a non-registered prompt name', async () => {
    // No registry entry resolves for this name → the caller owns its own budget.
    expect(
      await forwardedMaxTokens(
        { max_tokens: 4096, messages: [{ role: 'user', content: 'go' }] },
        'not-a-registered-prompt',
      ),
    ).toBe(4096);
  });

  it('leaves max_tokens UNTOUCHED when no system prompt is selected (plain proxy)', async () => {
    expect(await forwardedMaxTokens({ model: 'm', max_tokens: 4096, messages: [] })).toBe(4096);
  });
});
