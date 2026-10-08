import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMessages } from '../src/handlers/messages';
import worker from '../src/index';
import { CloudflareWorkersAiAdapter } from '../src/inference/adapters/cloudflare';
import { InferenceFailure } from '../src/inference/adapter';
import { AuditSessionAuthority } from '../src/lib/audit-session-authority';
import type { InferenceRequest } from '../src/lib/inference-types';
import { getFilePolicy, getModelProfile, getSystemPrompt } from '../src/prompt-registry';
import { CORS, ENV, kvMock, stubFetch } from './helpers';

const MODEL = '@cf/qwen/qwen3.8-27b';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function pngHeader(width: number, height: number): string {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return btoa(String.fromCharCode(...bytes));
}

function pngWithDimensions(width: number, height: number): string {
  const bytes = Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(bytes.subarray(12, 29)));
  return btoa(String.fromCharCode(...bytes));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function undecodablePng(): string {
  const bytes = Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0));
  bytes.fill(0, 41, 52);
  new DataView(bytes.buffer).setUint32(52, crc32(bytes.subarray(37, 52)));
  return btoa(String.fromCharCode(...bytes));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(data.byteLength + 8, crc32(chunk.subarray(4, data.byteLength + 8)));
  return chunk;
}

function pngParts(): {
  readonly header: Uint8Array;
  readonly imageData: Uint8Array;
  readonly end: Uint8Array;
} {
  const png = Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0));
  const imageDataLength = new DataView(png.buffer).getUint32(33);
  return {
    header: png.subarray(8, 33),
    imageData: png.subarray(41, 41 + imageDataLength),
    end: png.subarray(41 + imageDataLength + 4),
  };
}

function assembledPng(chunks: readonly Uint8Array[]): string {
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = new Uint8Array(
    signature.byteLength + chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  png.set(signature);
  let offset = signature.byteLength;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return btoa(String.fromCharCode(...png));
}

function duplicateHeaderPng(): string {
  const parts = pngParts();
  return assembledPng([parts.header, parts.header, pngChunk('IDAT', parts.imageData), parts.end]);
}

function unknownCriticalChunkPng(): string {
  const parts = pngParts();
  return assembledPng([
    parts.header,
    pngChunk('ABCD', new Uint8Array()),
    pngChunk('IDAT', parts.imageData),
    parts.end,
  ]);
}

function nonConsecutiveImageDataPng(): string {
  const parts = pngParts();
  const split = Math.ceil(parts.imageData.byteLength / 2);
  return assembledPng([
    parts.header,
    pngChunk('IDAT', parts.imageData.subarray(0, split)),
    pngChunk('tEXt', new TextEncoder().encode('key\0value')),
    pngChunk('IDAT', parts.imageData.subarray(split)),
    parts.end,
  ]);
}

async function highExpansionPng(): Promise<string> {
  const parts = pngParts();
  const stream = new Blob([new Uint8Array(5_000_000)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  const imageData = new Uint8Array(await new Response(stream).arrayBuffer());
  return assembledPng([parts.header, pngChunk('IDAT', imageData), parts.end]);
}

function workersAiSuccess(content: string): Response {
  return new Response(JSON.stringify({ result: { choices: [{ message: { content } }] } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function quotaNamespace(reserve = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))) {
  return {
    reserve,
    namespace: {
      idFromName: vi.fn().mockReturnValue({}),
      get: vi.fn().mockReturnValue({ fetch: reserve }),
    } as unknown as DurableObjectNamespace,
  };
}

const VALID_CONTENT = [
  {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG },
  },
  { type: 'text', text: 'INTENT: the settings card is fully painted' },
] as const;

function request(content: readonly unknown[] = VALID_CONTENT): Request {
  return requestWithMessages([{ role: 'user', content }]);
}

function requestWithQuotaClass(quotaClass: string): Request {
  const value = request();
  value.headers.set('X-Personalizer-Visual-Quota-Class', quotaClass);
  return value;
}

function requestWithMessages(messages: readonly unknown[]): Request {
  return requestWithBody({ messages });
}

function requestWithBody(body: unknown): Request {
  return requestWithRawBody(JSON.stringify(body));
}

function requestWithRawBody(body: string): Request {
  return new Request('https://app-ai.test/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx',
      'X-Personalizer-System-Prompt': 'visual-verify-free',
    },
    body,
  });
}

function canonicalRequest(env: typeof ENV): InferenceRequest {
  const entry = getSystemPrompt('visual-verify-free', env);
  return {
    prompt: entry.prompt,
    promptGroup: entry.group,
    modelProfile: getModelProfile('visual-verify-free', env),
    filePolicy: getFilePolicy(entry.filePolicy),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', mediaType: 'image/png', data: PNG },
            cache: 'none',
          },
          { type: 'text', text: 'INTENT: painted', cache: 'none' },
        ],
      },
    ],
    maxOutputTokens: 1024,
    tools: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('free visual verification', () => {
  it('resolves only the protected visual judge onto Workers AI', () => {
    const env = { ...ENV, MODEL_OVERRIDES: `free-render-verification=${MODEL}` };

    const free = getSystemPrompt('visual-verify-free', env);
    const production = getSystemPrompt('visual-verify', env);

    expect(free.provider).toBe('cloudflare');
    expect(free.apiFamily).toBe('cloudflare-workers-ai');
    expect(free.model).toBe(MODEL);
    expect(free.prompt).toBe(production.prompt);
    expect(production.provider).toBe('anthropic');
    expect(production.model).toBe(ENV.MODEL_BALANCED);
  });

  it('returns the real Workers AI verdict in the established messages envelope', async () => {
    const verdict = JSON.stringify({ pass: true, reason: 'fully painted', fix: null });
    const run = vi.fn().mockResolvedValue(workersAiSuccess(verdict));
    const quota = quotaNamespace();
    const env = {
      ...ENV,
      MODEL_OVERRIDES: `free-render-verification=${MODEL}`,
      AI: { run },
      AUDIT_SESSIONS: quota.namespace,
    };

    const response = await handleMessages(
      requestWithQuotaClass('acceptance'),
      env,
      CORS,
      undefined,
      {
        tenantScope: 'tenant',
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(body.content).toEqual([{ type: 'text', text: verdict }]);
    expect(run).toHaveBeenCalledOnce();
    const reservation = quota.reserve.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(reservation.body))).toEqual({
      limit: 8,
      dailyLimit: 8,
      acceptanceReserve: 4,
      quotaClass: 'acceptance',
    });
    expect(run).toHaveBeenCalledWith(
      MODEL,
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: 'system' }),
          {
            role: 'user',
            content: [
              expect.objectContaining({
                type: 'text',
                text: expect.stringContaining('the settings card is fully painted'),
              }),
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${PNG}` },
              },
            ],
          },
        ],
        max_tokens: expect.any(Number),
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_object' },
      }),
      expect.objectContaining({ returnRawResponse: true }),
    );
  });

  it('rejects an unknown quota class before reservation or inference', async () => {
    const run = vi.fn();
    const quota = quotaNamespace();

    const response = await handleMessages(
      requestWithQuotaClass('priority'),
      { ...ENV, AI: { run }, AUDIT_SESSIONS: quota.namespace },
      CORS,
      undefined,
      { tenantScope: 'tenant' },
    );

    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it('sends the reduced effective ceiling for explicit diagnostic reservations', async () => {
    const verdict = JSON.stringify({ pass: true, reason: 'diagnostic verdict', fix: null });
    const quota = quotaNamespace();
    const response = await handleMessages(
      requestWithQuotaClass('diagnostic'),
      {
        ...ENV,
        AI: { run: vi.fn().mockResolvedValue(workersAiSuccess(verdict)) },
        AUDIT_SESSIONS: quota.namespace,
      },
      CORS,
      undefined,
      { tenantScope: 'tenant' },
    );

    expect(response.status).toBe(200);
    const reservation = quota.reserve.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(reservation.body))).toEqual({
      limit: 4,
      dailyLimit: 8,
      acceptanceReserve: 4,
      quotaClass: 'diagnostic',
    });
  });

  it('stores nothing beyond the request: no R2, KV or provider write, and only a count reaches the quota authority', async () => {
    const verdict = JSON.stringify({ pass: true, reason: 'stored nothing', fix: null });
    const quota = quotaNamespace();
    const { kv } = kvMock();
    const put = vi.fn();
    const fetchMock = stubFetch();
    const response = await handleMessages(
      request(),
      {
        ...ENV,
        AI: { run: vi.fn().mockResolvedValue(workersAiSuccess(verdict)) },
        AUDIT_SESSIONS: quota.namespace,
        FILES_KV: kv as unknown as KVNamespace,
        INLINE_EVIDENCE_R2: { put } as unknown as R2Bucket,
      },
      CORS,
      undefined,
      { tenantScope: 'tenant' },
    );

    expect(response.status).toBe(200);
    expect(kv.put).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quota.reserve).toHaveBeenCalledTimes(1);
    for (const [, init] of quota.reserve.mock.calls) {
      expect(Object.keys(JSON.parse(String((init as RequestInit).body))).sort()).toEqual([
        'acceptanceReserve',
        'dailyLimit',
        'limit',
        'quotaClass',
      ]);
    }
  });

  it('does not derive quota authority from caller metadata', async () => {
    const verdict = JSON.stringify({ pass: true, reason: 'diagnostic verdict', fix: null });
    const quota = quotaNamespace();
    const adapter = new CloudflareWorkersAiAdapter({
      ...ENV,
      AI: { run: vi.fn().mockResolvedValue(workersAiSuccess(verdict)) },
      AUDIT_SESSIONS: quota.namespace,
    });

    await adapter.complete({
      ...canonicalRequest(ENV),
      metadata: { protectedVisualQuotaClass: 'acceptance' },
    });

    const reservation = quota.reserve.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(reservation.body))).toEqual({
      limit: 4,
      dailyLimit: 8,
      acceptanceReserve: 4,
      quotaClass: 'diagnostic',
    });
  });

  it.each([
    'not json',
    JSON.stringify({ pass: true, reason: 'missing fix' }),
    JSON.stringify({ pass: true, reason: 'extra key', fix: null, extra: true }),
    JSON.stringify({ pass: false, reason: 'bad fix', fix: { action: '', args: {} } }),
  ])('rejects malformed Workers AI verdicts', async (verdict) => {
    const run = vi.fn().mockResolvedValue(workersAiSuccess(verdict));

    const response = await handleMessages(request(), { ...ENV, AI: { run } }, CORS, undefined, {
      tenantScope: 'tenant',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ExceptionType: 'CloudflareWorkersAiException',
      Message: 'Workers AI returned a malformed visual verdict',
    });
  });

  it('hides the protected prompt from a non-master merchant before inference', async () => {
    const run = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const response = await worker.fetch(request(), { ...ENV, AI: { run } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      Message: 'Resource not found.',
      ExceptionType: 'RecordNotFoundException',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('admits a master identity through the router and returns the binding verdict', async () => {
    const verdict = JSON.stringify({ pass: true, reason: 'master verdict', fix: null });
    const run = vi.fn().mockResolvedValue(workersAiSuccess(verdict));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const response = await worker.fetch(request(), { ...ENV, AI: { run } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      content: [{ type: 'text', text: verdict }],
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    'free-render-verification=claude-sonnet-5',
    'free-render-verification=@cf/qwen/qwen3.8-99b',
  ])(
    'fails closed before quota or provider I/O when the protected route drifts',
    async (override) => {
      const run = vi.fn();
      const quota = quotaNamespace();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      const { MODEL_OVERRIDES: _modelOverrides, ...withoutOverrides } = ENV;
      const routing =
        override === undefined
          ? withoutOverrides
          : { ...withoutOverrides, MODEL_OVERRIDES: override };
      const env = {
        ...routing,
        AI: { run },
        AUDIT_SESSIONS: quota.namespace,
      };

      const response = await worker.fetch(request(), env);

      expect(response.status).toBe(500);
      expect(run).not.toHaveBeenCalled();
      expect(quota.reserve).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing image', [{ type: 'text', text: 'intent' }]],
    [
      'missing text',
      [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }],
    ],
    [
      'unsupported media',
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: PNG } },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'empty image',
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'invalid base64',
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-base64' } },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'non-PNG bytes',
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'truncated PNG',
      [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: pngHeader(1, 1) },
        },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'undecodable PNG',
      [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: undecodablePng() },
        },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'duplicate PNG header',
      [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: duplicateHeaderPng() },
        },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'unknown critical PNG chunk',
      [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: unknownCriticalChunkPng() },
        },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'non-consecutive PNG image data',
      [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: nonConsecutiveImageDataPng() },
        },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'oversized dimensions',
      [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: pngWithDimensions(1_281, 900) },
        },
        { type: 'text', text: 'intent' },
      ],
    ],
    [
      'oversized text',
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        { type: 'text', text: 'x'.repeat(8_193) },
      ],
    ],
  ])('does not reserve quota for %s', async (_label, content) => {
    const run = vi.fn();
    const quota = quotaNamespace();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const response = await worker.fetch(request(content), {
      ...ENV,
      AI: { run },
      AUDIT_SESSIONS: quota.namespace,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(run).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it('does not reserve quota for a high-expansion PNG', async () => {
    const run = vi.fn();
    const quota = quotaNamespace();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    const content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: await highExpansionPng() },
      },
      { type: 'text', text: 'intent' },
    ];

    const response = await worker.fetch(request(content), {
      ...ENV,
      AI: { run },
      AUDIT_SESSIONS: quota.namespace,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(run).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['assistant evidence', [{ role: 'assistant', content: VALID_CONTENT }]],
    [
      'split evidence',
      [
        { role: 'user', content: [VALID_CONTENT[0]] },
        { role: 'assistant', content: [VALID_CONTENT[1]] },
      ],
    ],
    [
      'extra unknown block',
      [{ role: 'user', content: [...VALID_CONTENT, { type: 'unknown', value: true }] }],
    ],
    [
      'extra invalid role',
      [
        { role: 'user', content: VALID_CONTENT },
        { role: 'invalid', content: [] },
      ],
    ],
  ])('does not reserve quota for %s', async (_label, messages) => {
    const run = vi.fn();
    const quota = quotaNamespace();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const response = await worker.fetch(requestWithMessages(messages), {
      ...ENV,
      AI: { run },
      AUDIT_SESSIONS: quota.namespace,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(run).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['temperature', { temperature: -1 }],
    ['top_p', { top_p: 2 }],
    ['top_k', { top_k: 5 }],
  ])('does not reserve quota for caller %s', async (_label, sampling) => {
    const run = vi.fn();
    const quota = quotaNamespace();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const response = await worker.fetch(
      requestWithBody({ messages: [{ role: 'user', content: VALID_CONTENT }], ...sampling }),
      { ...ENV, AI: { run }, AUDIT_SESSIONS: quota.namespace },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(run).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it.each([null, 42, 'invalid', []])('returns 400 without quota for body %j', async (body) => {
    const run = vi.fn();
    const quota = quotaNamespace();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const response = await worker.fetch(requestWithBody(body), {
      ...ENV,
      AI: { run },
      AUDIT_SESSIONS: quota.namespace,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(run).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it('returns 400 without quota for invalid JSON', async () => {
    const run = vi.fn();
    const quota = quotaNamespace();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ SubscriberID: 17, CanAdministerAllSubscribers: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const response = await worker.fetch(requestWithRawBody('{'), {
      ...ENV,
      AI: { run },
      AUDIT_SESSIONS: quota.namespace,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ExceptionType: 'ArgumentException' });
    expect(run).not.toHaveBeenCalled();
    expect(quota.reserve).not.toHaveBeenCalled();
  });

  it('passes cancellation to Workers AI and normalizes the abort', async () => {
    const controller = new AbortController();
    const quota = quotaNamespace();
    const run = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const adapter = new CloudflareWorkersAiAdapter({
      ...ENV,
      AI: { run },
      AUDIT_SESSIONS: quota.namespace,
    });
    const inferenceRequest = { ...canonicalRequest(ENV), abortSignal: controller.signal };

    const adapterError = await adapter
      .complete(inferenceRequest)
      .then(() => null)
      .catch((error: unknown) => error);

    expect(run).toHaveBeenCalledWith(
      MODEL,
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal, returnRawResponse: true }),
    );
    expect((adapterError as InferenceFailure).inferenceError).toMatchObject({
      code: 'cancelled',
      failureClass: 'cancelled',
      retryable: false,
    });
  });

  it('enforces the UTC daily limit atomically', async () => {
    const values = new Map<string, unknown>();
    interface TestStorage {
      get(key: string): Promise<unknown>;
      put(key: string, value: unknown): Promise<void>;
      transaction<T>(callback: (transaction: TestStorage) => Promise<T>): Promise<T>;
    }
    const storage: TestStorage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      transaction: async <T>(callback: (transaction: typeof storage) => Promise<T>) =>
        callback(storage),
    };
    const authority = new AuditSessionAuthority({ storage } as unknown as DurableObjectState, ENV);
    const reserve = () =>
      authority.fetch(
        new Request('https://inference-quota.internal/reserve-free-visual-verification', {
          method: 'POST',
          body: JSON.stringify({
            limit: 2,
            dailyLimit: 2,
            acceptanceReserve: 1,
            quotaClass: 'acceptance',
          }),
        }),
      );

    vi.useFakeTimers();
    vi.setSystemTime('2026-09-19T23:59:59.000Z');
    expect((await reserve()).status).toBe(201);
    expect((await reserve()).status).toBe(201);
    expect((await reserve()).status).toBe(429);
    vi.setSystemTime('2026-09-20T00:00:01.000Z');
    expect((await reserve()).status).toBe(201);
    vi.useRealTimers();
  });

  it('accepts the legacy authority request through a mixed-version rollout', async () => {
    const values = new Map<string, unknown>();
    interface TestStorage {
      get(key: string): Promise<unknown>;
      put(key: string, value: unknown): Promise<void>;
      transaction<T>(callback: (transaction: TestStorage) => Promise<T>): Promise<T>;
    }
    const storage: TestStorage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      transaction: async <T>(callback: (transaction: typeof storage) => Promise<T>) =>
        callback(storage),
    };
    const authority = new AuditSessionAuthority({ storage } as unknown as DurableObjectState, ENV);
    const reserve = () =>
      authority.fetch(
        new Request('https://inference-quota.internal/reserve-free-visual-verification', {
          method: 'POST',
          body: JSON.stringify({ limit: 2 }),
        }),
      );

    expect((await reserve()).status).toBe(201);
    expect((await reserve()).status).toBe(201);
    expect((await reserve()).status).toBe(429);
  });

  it('rejects an inconsistent effective ceiling before storage', async () => {
    const storage = {
      transaction: vi.fn(),
    } as unknown as DurableObjectStorage;
    const authority = new AuditSessionAuthority({ storage } as unknown as DurableObjectState, ENV);

    const response = await authority.fetch(
      new Request('https://inference-quota.internal/reserve-free-visual-verification', {
        method: 'POST',
        body: JSON.stringify({
          limit: 8,
          dailyLimit: 8,
          acceptanceReserve: 4,
          quotaClass: 'diagnostic',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(storage.transaction).not.toHaveBeenCalled();
  });

  it('reserves the final daily slots for complete acceptance runs', async () => {
    const values = new Map<string, unknown>();
    interface TestStorage {
      get(key: string): Promise<unknown>;
      put(key: string, value: unknown): Promise<void>;
      transaction<T>(callback: (transaction: TestStorage) => Promise<T>): Promise<T>;
    }
    const storage: TestStorage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      transaction: async <T>(callback: (transaction: typeof storage) => Promise<T>) =>
        callback(storage),
    };
    const authority = new AuditSessionAuthority({ storage } as unknown as DurableObjectState, ENV);
    const reserve = (quotaClass: 'diagnostic' | 'acceptance') =>
      authority.fetch(
        new Request('https://inference-quota.internal/reserve-free-visual-verification', {
          method: 'POST',
          body: JSON.stringify({
            limit: quotaClass === 'diagnostic' ? 4 : 8,
            dailyLimit: 8,
            acceptanceReserve: 4,
            quotaClass,
          }),
        }),
      );

    for (let requestNumber = 0; requestNumber < 4; requestNumber += 1) {
      expect((await reserve('diagnostic')).status).toBe(201);
    }
    expect((await reserve('diagnostic')).status).toBe(429);
    for (let requestNumber = 0; requestNumber < 4; requestNumber += 1) {
      expect((await reserve('acceptance')).status).toBe(201);
    }
    expect((await reserve('acceptance')).status).toBe(429);
  });

  it.each([
    { status: 400, code: 5004, retryable: false },
    { status: 403, code: 5016, retryable: false },
    { status: 408, code: 3007, retryable: true },
    { status: 413, code: 3006, retryable: false },
    { status: 429, code: 3036, retryable: true },
    { status: 500, code: 5000, retryable: false },
  ])('preserves Workers AI $status failures', async ({ status, code, retryable }) => {
    const failure = () =>
      new Response(JSON.stringify({ errors: [{ code, message: `Workers AI ${code}` }] }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    const response = await handleMessages(
      request(),
      {
        ...ENV,
        AI: { run: vi.fn().mockImplementation(async () => failure()) },
      },
      CORS,
      undefined,
      { tenantScope: 'tenant' },
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      Message: `Workers AI ${code}`,
      ExceptionType: 'CloudflareWorkersAiException',
    });

    const adapter = new CloudflareWorkersAiAdapter({
      ...ENV,
      AI: { run: vi.fn().mockImplementation(async () => failure()) },
    });
    const adapterError = await adapter
      .complete(canonicalRequest(ENV))
      .then(() => null)
      .catch((error: unknown) => error);
    expect(adapterError).toBeInstanceOf(InferenceFailure);
    expect((adapterError as InferenceFailure).inferenceError).toMatchObject({
      status,
      code: String(code),
      retryable,
      failureClass: status === 408 ? 'timeout' : 'http',
    });
  });
});
