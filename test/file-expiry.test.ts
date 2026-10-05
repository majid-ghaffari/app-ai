import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { handleFileUpload } from '../src/handlers/files';
import {
  DISCARD_KEY_PREFIX,
  dedupUpload,
  KV_RECORD_TTL_SECONDS,
  sha256Hex,
} from '../src/lib/file-dedup';
import { createInferenceFileService } from '../src/inference/factory';
import type { ModelProfile } from '../src/lib/inference-types';
import {
  fileTenantScope,
  MAX_REFERENCE_TTL_SECONDS,
  openOwnedFileReference,
} from '../src/inference/file-references';
import { getFilePolicy, getModelProfile } from '../src/prompt-registry';
import {
  anthropicFileRecord,
  anthropicMessage,
  AUDIT_STATUS_CALLBACK_URL,
  CORS,
  ENV,
  fetchCall,
  fetchedUrls,
  headerOf,
  kvMock,
  sentBody,
  stubFetch,
} from './helpers';
import {
  USABLE_PROPOSAL,
  durableEnv,
  exchange,
  messageRequest,
  uploadRequest,
} from './audit-harness';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const CONTEXT_ID = 'ctx-file-expiry';

const ANTHROPIC_ROUTE = {
  profile: getModelProfile('placement', ENV),
  policy: getFilePolicy('anthropic-provider-files'),
  accountScope: 'anthropic:test-account',
  tenantScope: 'tenant:test-tenant',
  compatibleGroups: ['image-selection'] as [string, ...string[]],
};

const OPENAI_PROFILE: ModelProfile = {
  name: 'openai-responses-test',
  provider: 'openai',
  apiFamily: 'openai-responses',
  model: 'gpt-test',
  capabilities: {
    vision: true,
    reusableFiles: true,
    providerFiles: true,
    streaming: true,
    structuredOutput: true,
    serverTools: true,
    clientTools: true,
    reasoning: true,
    inlineCacheBreakpoints: true,
    textConversation: true,
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isoAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function cachedRecord(fileId: string): string {
  return JSON.stringify({ fileId, mediaType: 'text/plain', createdAt: NOW - 20 * DAY });
}

function upload(content = 'tile-bytes') {
  return { content, mimeType: 'text/plain', filename: 'tile.txt' };
}

function freshFile(id: string): Record<string, unknown> {
  return anthropicFileRecord(id, { mime_type: 'text/plain', expires_at: isoAt(NOW + 30 * DAY) });
}

async function discardPrefix(): Promise<string> {
  const route = ANTHROPIC_ROUTE;
  return `${DISCARD_KEY_PREFIX}${route.tenantScope}:${route.accountScope}:${route.policy.name}:${route.compatibleGroups.join(',')}:${encodeURIComponent('text/plain')}:${await sha256Hex('tile-bytes')}:`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Anthropic uploads expire in 30 days', () => {
  it('sends the expiry on every upload and seals the expiry Anthropic answers into the reference and the dedup record', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const expiresAt = isoAt(NOW + 30 * DAY - 120_000);
    const fetchMock = stubFetch().mockResolvedValue(
      json(anthropicFileRecord('file_expiring', { expires_at: expiresAt })),
    );
    const { kv, env } = kvMock();
    const form = new FormData();
    form.append('file', new Blob(['tile-bytes'], { type: 'image/webp' }), 'tile.webp');
    form.append('prompt', 'image-selection');

    const response = await handleFileUpload(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': CONTEXT_ID },
        body: form,
      }),
      env,
      CORS,
    );

    expect(response.status).toBe(200);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://api.anthropic.com/v1/files');
    expect(headerOf(init, 'anthropic-beta')).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('expires_in_seconds')).toBe(String(THIRTY_DAYS_SECONDS));
    expect(getFilePolicy('anthropic-provider-files').requestedLifetimeSeconds).toBe(
      THIRTY_DAYS_SECONDS,
    );

    const tenantScope = await fileTenantScope(CONTEXT_ID, env);
    if (!tenantScope) throw new Error('test tenant scope missing');
    const { id } = (await response.json()) as { id: string };
    expect(await openOwnedFileReference(id, env, tenantScope)).toMatchObject({
      upstreamFileId: 'file_expiring',
      expiresAt,
    });
    const stored = kv.put.mock.calls.at(0);
    if (!stored) throw new Error('KV put was not called');
    expect(JSON.parse(stored[1])).toMatchObject({ fileId: 'file_expiring' });
    expect(stored[2]?.expirationTtl).toBe(THIRTY_DAYS_SECONDS - 120);
    expect(stored[2]?.expirationTtl).toBeLessThan(KV_RECORD_TTL_SECONDS);
  });

  it('reports a missing or unreadable expires_at as no expiry rather than trusting it', async () => {
    const withoutExpiry = anthropicFileRecord('file_unknown');
    delete withoutExpiry.expires_at;
    const files = createInferenceFileService(ENV);
    for (const record of [
      withoutExpiry,
      anthropicFileRecord('file_unknown', { expires_at: 'soon' }),
    ]) {
      stubFetch().mockImplementation(async () => json(record));
      await expect(
        files.upload(
          ANTHROPIC_ROUTE.profile,
          ANTHROPIC_ROUTE.policy,
          new Uint8Array([1]),
          'a.txt',
          'text/plain',
        ),
      ).resolves.toMatchObject({ id: 'file_unknown', expiresAt: null });
      await expect(
        files.getMetadata(ANTHROPIC_ROUTE.profile, 'file_unknown'),
      ).resolves.toMatchObject({ id: 'file_unknown', expiresAt: null });
    }
  });

  it.each([
    ['no expires_at member', undefined],
    ['an unreadable expires_at', 'not-a-date'],
    ['a null expires_at', null],
    ['an expiry shorter than a full reference', NOW + MAX_REFERENCE_TTL_SECONDS * 1000 - 60_000],
  ])(
    'deletes and refuses an upload Anthropic answered with %s, recording nothing',
    async (_case, expiry) => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const record = anthropicFileRecord('file_unusable', {
        expires_at: typeof expiry === 'number' ? isoAt(expiry) : expiry,
      });
      if (expiry === undefined) delete record.expires_at;
      const fetchMock = stubFetch()
        .mockResolvedValueOnce(json(record))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const { kv, env } = kvMock();

      await expect(dedupUpload(upload(), ANTHROPIC_ROUTE, env)).rejects.toMatchObject({
        inferenceError: { backend: 'anthropic', failureClass: 'invalid-response' },
      });
      expect(fetchCall(fetchMock, 1)).toMatchObject({
        url: 'https://api.anthropic.com/v1/files/file_unusable',
        init: { method: 'DELETE' },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(kv.put).not.toHaveBeenCalled();
    },
  );

  it('retries a delete that fails once and keeps nothing once it succeeds', async () => {
    const fetchMock = stubFetch()
      .mockResolvedValueOnce(json(anthropicFileRecord('file_forever', { expires_at: null })))
      .mockResolvedValueOnce(json({ error: { message: 'busy' } }, 500))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { kv, env } = kvMock();

    await expect(dedupUpload(upload(), ANTHROPIC_ROUTE, env)).rejects.toMatchObject({
      inferenceError: { failureClass: 'invalid-response' },
    });
    expect(fetchedUrls(fetchMock)).toEqual([
      'https://api.anthropic.com/v1/files',
      'https://api.anthropic.com/v1/files/file_forever',
      'https://api.anthropic.com/v1/files/file_forever',
    ]);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('keeps an upload that will not delete under its own discard key, which the next upload of those bytes clears', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const prefix = await discardPrefix();
    const failing = stubFetch()
      .mockResolvedValueOnce(json(anthropicFileRecord('file_forever', { expires_at: null })))
      .mockResolvedValue(json({ error: { message: 'busy' } }, 500));
    const { kv, env } = kvMock();

    await expect(dedupUpload(upload(), ANTHROPIC_ROUTE, env)).rejects.toMatchObject({
      inferenceError: { failureClass: 'invalid-response' },
    });
    expect(fetchedUrls(failing)).toHaveLength(3);
    expect(kv.put).toHaveBeenCalledTimes(1);
    const [key, value, options] = kv.put.mock.calls[0] ?? [];
    expect(key).toBe(`${prefix}file_forever`);
    expect(JSON.parse(value ?? '{}')).toEqual({ fileId: 'file_forever', recordedAt: NOW });
    expect(options).toBeUndefined();

    kv.put.mockClear();
    const recovering = stubFetch()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(freshFile('file_fresh')));
    await expect(dedupUpload(upload(), ANTHROPIC_ROUTE, env)).resolves.toMatchObject({
      deduped: false,
      reference: { upstreamFileId: 'file_fresh' },
    });
    expect(fetchCall(recovering, 0)).toMatchObject({
      url: 'https://api.anthropic.com/v1/files/file_forever',
      init: { method: 'DELETE' },
    });
    expect(kv.delete).toHaveBeenCalledWith(`${prefix}file_forever`);
    expect((await kv.list({ prefix })).keys).toEqual([]);
  });

  it('keeps every id when two uploads of the same bytes fail their cleanup at once, and retries each', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const prefix = await discardPrefix();
    let uploads = 0;
    stubFetch().mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        uploads += 1;
        return json(anthropicFileRecord(`file_lost_${uploads}`, { expires_at: null }));
      }
      return json({ error: { message: 'busy' } }, 500);
    });
    const { kv, env } = kvMock();

    const results = await Promise.allSettled([
      dedupUpload(upload(), ANTHROPIC_ROUTE, env),
      dedupUpload(upload(), ANTHROPIC_ROUTE, env),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect((await kv.list({ prefix })).keys.map(({ name }) => name).sort()).toEqual([
      `${prefix}file_lost_1`,
      `${prefix}file_lost_2`,
    ]);

    const deleted: string[] = [];
    stubFetch().mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') {
        deleted.push(String(input).split('/').at(-1) ?? '');
        return new Response(null, { status: 204 });
      }
      return json(freshFile('file_fresh'));
    });
    await expect(dedupUpload(upload(), ANTHROPIC_ROUTE, env)).resolves.toMatchObject({
      reference: { upstreamFileId: 'file_fresh' },
    });
    expect(deleted.sort()).toEqual(['file_lost_1', 'file_lost_2']);
    expect((await kv.list({ prefix })).keys).toEqual([]);
  });

  it('drains every page of discard keys before uploading again, stranding none', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const prefix = await discardPrefix();
    const { kv, env } = kvMock();
    const recorded = Array.from({ length: 150 }, (_, index) => `file_stranded_${index}`);
    for (const fileId of recorded) {
      await kv.put(`${prefix}${fileId}`, JSON.stringify({ fileId, recordedAt: NOW }));
    }
    const deleted: string[] = [];
    stubFetch().mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') {
        deleted.push(String(input).split('/').at(-1) ?? '');
        return new Response(null, { status: 204 });
      }
      return json(freshFile('file_fresh'));
    });

    await expect(dedupUpload(upload(), ANTHROPIC_ROUTE, env)).resolves.toMatchObject({
      reference: { upstreamFileId: 'file_fresh' },
    });
    expect(kv.list.mock.calls.length).toBeGreaterThan(1);
    expect(deleted.sort()).toEqual([...recorded].sort());
    expect((await kv.list({ prefix })).keys).toEqual([]);
  });

  it('loses no id when a KV read or a first KV write fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const prefix = await discardPrefix();
    const { kv, env } = kvMock();
    await kv.put(
      `${prefix}file_recorded_earlier`,
      JSON.stringify({ fileId: 'file_recorded_earlier' }),
    );
    kv.put.mockClear();
    kv.list.mockRejectedValueOnce(new Error('KV unavailable'));
    kv.put.mockRejectedValueOnce(new Error('KV unavailable'));
    const fetchMock = stubFetch().mockImplementation(async (_input, init) =>
      init?.method === 'POST'
        ? json(anthropicFileRecord('file_lost_now', { expires_at: null }))
        : json({ error: { message: 'busy' } }, 500),
    );

    await expect(dedupUpload(upload(), ANTHROPIC_ROUTE, env)).rejects.toMatchObject({
      inferenceError: { failureClass: 'invalid-response' },
    });
    expect(fetchedUrls(fetchMock)).not.toContain(
      'https://api.anthropic.com/v1/files/file_recorded_earlier',
    );
    expect(kv.put).toHaveBeenCalledTimes(2);
    expect((await kv.list({ prefix })).keys.map(({ name }) => name).sort()).toEqual([
      `${prefix}file_lost_now`,
      `${prefix}file_recorded_earlier`,
    ]);
  });
});

describe('dedup reuses an Anthropic file only while it outlives a full-length reference', () => {
  it('reuses a cached file with at least 15 days left, minting a reference that ends before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const expiresAt = isoAt(NOW + MAX_REFERENCE_TTL_SECONDS * 1000 + 60_000);
    const fetchMock = stubFetch().mockResolvedValue(
      json(anthropicFileRecord('file_cached', { mime_type: 'text/plain', expires_at: expiresAt })),
    );
    const { kv, env } = kvMock(cachedRecord('file_cached'));

    const result = await dedupUpload(upload(), ANTHROPIC_ROUTE, env);

    expect(result).toMatchObject({
      deduped: true,
      reference: { upstreamFileId: 'file_cached', expiresAt },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchCall(fetchMock, 0).init.method).toBeUndefined();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it.each([
    ['less than 15 days left', NOW + MAX_REFERENCE_TTL_SECONDS * 1000 - 60_000],
    ['already expired', NOW - 60 * 60 * 1000],
    ['no expiry, uploaded before uploads expired', null],
  ])(
    'uploads a fresh copy over a cached file with %s, leaving the cached file to expire',
    async (_case, cachedExpiry) => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW });
      const freshExpiry = isoAt(NOW + 30 * DAY);
      const fetchMock = stubFetch()
        .mockResolvedValueOnce(
          json(
            anthropicFileRecord('file_cached', {
              mime_type: 'text/plain',
              expires_at: cachedExpiry === null ? null : isoAt(cachedExpiry),
            }),
          ),
        )
        .mockResolvedValueOnce(
          json(
            anthropicFileRecord('file_fresh', { mime_type: 'text/plain', expires_at: freshExpiry }),
          ),
        );
      const { kv, env } = kvMock(cachedRecord('file_cached'));

      const result = await dedupUpload(upload(), ANTHROPIC_ROUTE, env);

      expect(result).toMatchObject({
        deduped: false,
        reference: { upstreamFileId: 'file_fresh', expiresAt: freshExpiry },
      });
      expect(fetchedUrls(fetchMock)).toEqual([
        'https://api.anthropic.com/v1/files/file_cached',
        'https://api.anthropic.com/v1/files',
      ]);
      expect(fetchCall(fetchMock, 1).init.method).toBe('POST');
      expect(kv.delete).not.toHaveBeenCalled();
      expect(JSON.parse(kv.put.mock.calls.at(0)?.[1] ?? '{}')).toMatchObject({
        fileId: 'file_fresh',
      });
    },
  );

  it('keeps reusing until expiry on a policy that leaves retention to its provider', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const openAIFile = {
      id: 'file_openai',
      object: 'file',
      bytes: 3,
      created_at: Math.floor((NOW - 28 * DAY) / 1000),
      expires_at: Math.floor((NOW + 2 * DAY) / 1000),
      filename: 'tile.png',
      purpose: 'user_data',
    };
    const fetchMock = stubFetch().mockResolvedValue(json(openAIFile));
    const { env } = kvMock(cachedRecord('file_openai'));

    const result = await dedupUpload(
      upload(),
      {
        ...ANTHROPIC_ROUTE,
        profile: OPENAI_PROFILE,
        policy: getFilePolicy('openai-user-data-files'),
        accountScope: 'openai:test-account',
      },
      env,
    );

    expect(result).toMatchObject({ deduped: true, reference: { upstreamFileId: 'file_openai' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a Grader run keeps reusing its uploads', () => {
  it('reuses a re-uploaded tile and resumes a failed proposal on the same uploaded file', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const { kv } = kvMock();
    const env = durableEnv({ FILES_KV: kv as unknown as KVNamespace });
    const session = await exchange(env);
    const tile = anthropicFileRecord('file-grader-tile', { expires_at: isoAt(NOW + 30 * DAY) });
    let inference = 0;
    const fetchMock = stubFetch().mockImplementation(async (input) => {
      const url = String(input);
      if (url === AUDIT_STATUS_CALLBACK_URL) return new Response(null, { status: 204 });
      if (url.endsWith('/v1/files') || url.endsWith('/v1/files/file-grader-tile')) {
        return json(tile);
      }
      inference += 1;
      return inference === 1
        ? json({ error: { message: 'temporary' } }, 503)
        : json(anthropicMessage([{ type: 'text', text: USABLE_PROPOSAL }]));
    });

    const first = await worker.fetch(uploadRequest(session.accessToken, 'home.webp'), env);
    expect(first.status).toBe(200);
    const firstReference = ((await first.json()) as { id: string }).id;

    vi.setSystemTime(NOW + 60 * 60 * 1000);
    const again = await worker.fetch(uploadRequest(session.accessToken, 'home.webp'), env);
    expect(again.status).toBe(200);
    const againReference = ((await again.json()) as { id: string }).id;
    const references = [firstReference, againReference];
    expect((await worker.fetch(messageRequest(session.accessToken, references), env)).status).toBe(
      503,
    );

    vi.setSystemTime(NOW + 2 * 60 * 60 * 1000);
    const resumed = await worker.fetch(messageRequest(session.accessToken, references), env);

    expect(resumed.status).toBe(200);
    const urls = fetchedUrls(fetchMock);
    expect(urls.filter((url) => url.endsWith('/v1/files'))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith('/v1/files/file-grader-tile'))).toHaveLength(1);
    const messageCalls = urls.flatMap((url, index) =>
      url.endsWith('/v1/messages') ? [index] : [],
    );
    expect(messageCalls).toHaveLength(2);
    for (const call of messageCalls) {
      const body = JSON.stringify(sentBody(fetchCall(fetchMock, call).init));
      expect(body.match(/"file_id":"file-grader-tile"/g)).toHaveLength(2);
    }
  });
});
