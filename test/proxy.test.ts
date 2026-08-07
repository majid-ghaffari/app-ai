/**
 * Coverage for the proxy surface — the live smart-image path and its shared
 * modules: the Anthropic client, the /files and /messages handlers, context-ID
 * validation, CORS, the error response shape, and the cache_control 4-block
 * management. fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import worker from '../src/index';
import { getCorsHeaders } from '../src/lib/cors';
import { jsonResponse, errorResponse, errorResponseFrom, WorkerError } from '../src/lib/responses';
import { validateContextId } from '../src/lib/auth';
import { manageCacheControl } from '../src/lib/cache-control';
import type { CacheableBlock, ClientMessagesPayload } from '../src/lib/anthropic';
import * as anthropic from '../src/lib/anthropic';
import { handleFileUpload, handleListFiles, handleDeleteFile } from '../src/handlers/files';
import { handleMessages } from '../src/handlers/messages';
import { handleHealth } from '../src/handlers/health';
import { getSystemPrompt } from '../src/prompt-registry';
import { ENV, CORS, stubFetch, fetchCall, headerOf, sentBody, kvMock } from './helpers';

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function requestWithOrigin(origin: string | null): Request {
  const headers = origin ? { Origin: origin } : {};
  return new Request('https://app-ai.test/messages', { headers });
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
  it('uploadFile posts to /v1/files with the key + files beta header', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: 'file_1' }));

    const fd = new FormData();
    await anthropic.uploadFile(fd, ENV);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/files');
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'x-api-key')).toBe('test-key');
    expect(headerOf(init, 'anthropic-beta')).toBe('files-api-2025-04-14');
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
    await expect(anthropic.listFiles(withoutKey)).rejects.toThrow(
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

  it('is a no-op when the first message content is not an array', () => {
    const payload: ClientMessagesPayload = { messages: [{ role: 'user', content: 'hi' }] };
    expect(() => manageCacheControl(payload, 0)).not.toThrow();
  });
});

describe('handleHealth', () => {
  it('returns ok with a timestamp', async () => {
    const res = handleHealth(CORS);
    const body = (await res.json()) as { status: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns the build revision marker (C0014 item 14) — "dev" under a define-less build', async () => {
    // The FREE-stack preflight asserts `/health` carries a non-"dev" `buildRev` (the exact served
    // revision injected by esbuild `--define __APP_AI_REV__`). Under vitest there is no define, so the
    // `typeof` guard degrades to "dev" — the fail-closed default a live preflight rejects. This pins
    // the field EXISTS as a string (a marker regression) + the graceful no-define fallback.
    const res = handleHealth(CORS);
    const body = (await res.json()) as { buildRev?: unknown };
    expect(typeof body.buildRev).toBe('string');
    expect(body.buildRev).toBe('dev');
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

  it('upload proxies the file and returns Anthropic body on success', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: 'file_99' }));

    const fd = new FormData();
    fd.append('file', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
    const req = new Request('https://app-ai.test/files', { method: 'POST', body: fd });

    const res = await handleFileUpload(req, ENV, CORS);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('file_99');
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/files');
  });

  it('upload routes through dedup: a KV hit reuses the cached id without a POST', async () => {
    // FILES_KV bound + hash already mapped → handler returns the cached id and
    // never POSTs an upload (it does one GET metadata existence check). Response
    // shape stays { id, type } — transparent to the lib client.
    const cachedId = 'file_dedup';
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ id: cachedId, type: 'file' }, 200));
    const { env } = kvMock(JSON.stringify({ fileId: cachedId, createdAt: 1 }));

    const fd = new FormData();
    fd.append('file', new Blob(['screenshot-bytes'], { type: 'image/jpeg' }), 'screenshot.jpg');
    const req = new Request('https://app-ai.test/files', { method: 'POST', body: fd });

    const res = await handleFileUpload(req, env, CORS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: cachedId, type: 'file' });
    // Only the metadata existence check fired — no upload POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe(`https://api.anthropic.com/v1/files/${cachedId}`);
    expect(init.method).toBeUndefined();
  });

  it('upload augments the message with the beta-access hint on a 500', async () => {
    stubFetch().mockResolvedValue(jsonOk({ error: { message: 'server error' } }, 500));

    const fd = new FormData();
    fd.append('file', new Blob(['x']), 'a.txt');
    const req = new Request('https://app-ai.test/files', { method: 'POST', body: fd });

    const res = await handleFileUpload(req, ENV, CORS);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.Message).toMatch(/beta/i);
    expect(body.ExceptionType).toBe('AnthropicApiException');
  });

  it('list proxies and returns the Anthropic body', async () => {
    stubFetch().mockResolvedValue(jsonOk({ data: [{ id: 'f1' }] }));
    const res = await handleListFiles(ENV, CORS);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data[0]?.id).toBe('f1');
  });

  it('delete returns the success envelope on 204', async () => {
    stubFetch().mockResolvedValue(new Response(null, { status: 204 }));
    const res = await handleDeleteFile('file_1', ENV, CORS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: 'File deleted successfully' });
  });

  it('delete maps an Anthropic failure to the Brain shape, keeping the upstream status', async () => {
    stubFetch().mockResolvedValue(jsonOk({ error: { message: 'gone' } }, 404));
    const res = await handleDeleteFile('missing', ENV, CORS);
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
    fetchMock.mockResolvedValue(jsonOk({ content: [{ type: 'text', text: 'hi' }] }));

    const res = await handleMessages(
      messagesRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe('hi');
    // Forwarded to the Messages API (not Files).
    expect(fetchCall(fetchMock, 0).url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('strips the client apiKey field before forwarding', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ content: [] }));

    await handleMessages(
      messagesRequest({ apiKey: 'leak', model: 'm', max_tokens: 1, messages: [] }),
      ENV,
      CORS,
    );
    const sent = sentBody(fetchCall(fetchMock, 0).init);
    expect(sent.apiKey).toBeUndefined();
    expect(sent.model).toBe('m');
  });

  it('injects the selected system prompt as a cached system block', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ content: [] }));

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
});

describe('handleMessages — registry max_tokens EXACT', () => {
  // A `balanced` entry whose registry `maxTokens` is 8192 — the EXACT value the
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
    fetchMock.mockResolvedValue(jsonOk({ content: [] }));
    await handleMessages(floorRequest(body, systemPrompt), ENV, CORS);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
    return sentBody(fetchCall(fetchMock, idx).init).max_tokens;
  }

  it('pins the exact entry to the registry (8192)', () => {
    expect(EXACT).toBe(8192);
  });

  it('a BELOW-registry client max_tokens (4096) is set to exactly the registry value (8192)', async () => {
    expect(
      await forwardedMaxTokens(
        { max_tokens: 4096, messages: [{ role: 'user', content: 'go' }] },
        EXACT_PROMPT,
      ),
    ).toBe(EXACT);
  });

  it('an ABOVE-registry client max_tokens (16000) is OVERRIDDEN down to the registry value (no cap kept, no floor)', async () => {
    // The OLD floor behavior (Math.max) preserved 16000; exact-registry overrides
    // it to the entry value. This is the load-bearing "no floor / no client read" proof.
    expect(
      await forwardedMaxTokens(
        { max_tokens: 16000, messages: [{ role: 'user', content: 'go' }] },
        EXACT_PROMPT,
      ),
    ).toBe(EXACT);
  });

  it('SETS the registry value (8192) when the client omits max_tokens entirely', async () => {
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
