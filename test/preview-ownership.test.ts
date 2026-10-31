/**
 * `scripts/preview-ownership.mjs` against live Cloudflare responses: every run first
 * proves the configured KV namespace is the registry's, a deploy claims only a Preview it creates
 * now or one whose ID and creation time the registry namespace records, a delete removes only a
 * recorded ID, every Cloudflare request is bounded, and every terminal state reaches the workflow
 * as its exit code. No refusal makes a later Cloudflare call.
 */
import { describe, expect, it } from 'vitest';

import {
  claimPreview,
  deleteOwnedPreview,
  main,
  ownerKey,
  readWorkerIdentity,
} from '../scripts/preview-ownership.mjs';
import {
  CREATED_ON_UTC,
  deleteNotFound,
  deleteSuccess,
  failure,
  kvValueNotFound,
  kvValuePresent,
  kvWriteSuccess,
  NAMESPACE_ID,
  namespaceNotFound,
  namespaceSuccess,
  OTHER_PREVIEW_ID,
  PREVIEW_ID,
  previewCreated,
  previewNotFound,
  previewSuccess,
} from './fixtures/cloudflare-previews';
import committedWranglerToml from '../wrangler.toml?raw';

const API = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = '771ea33ba0e0d2d42b93212bd535509d';
const NAMESPACE = NAMESPACE_ID;
const COMMIT = 'a'.repeat(40);
const NOW = '2026-10-31T11:00:00.000Z';
const WRANGLER_TOML = `name = "app-ai"\naccount_id = "${ACCOUNT}"\n\n[vars]\nname = "other"\n`;

const OTHER_NAMESPACE = 'c1d2e3f4a5b6978879605a4b3c2d1e0f';
const GET_NAMESPACE = `GET /storage/kv/namespaces/${NAMESPACE}`;
const PREVIEW = `/workers/workers/app-ai/previews`;
const GET_PREVIEW = `GET ${PREVIEW}/capture-probe`;
const CREATE = `POST ${PREVIEW}`;
const record = (id: string) =>
  `/storage/kv/namespaces/${NAMESPACE}/values/${encodeURIComponent(ownerKey(id))}`;
const READ_RECORD = `GET ${record(PREVIEW_ID)}`;
const WRITE_RECORD = `PUT ${record(PREVIEW_ID)}`;
const DELETE_BY_ID = `DELETE ${PREVIEW}/${PREVIEW_ID}`;
const recordValue = (
  id = PREVIEW_ID,
  name = 'capture-probe',
  createdOnUtc: string | null = CREATED_ON_UTC,
) =>
  JSON.stringify({
    module: 'app-ai',
    name,
    previewId: id,
    previewCreatedOnUtc: createdOnUtc,
    tagName: `preview-${name}`,
  });

type Answer =
  | { readonly status: number; readonly body: unknown }
  | Error
  | 'no-headers'
  | 'no-body-end';
const answer = (status: number, body: unknown): Answer => ({ status, body });

/** A fetch answering `METHOD path` from the table, recording every call and request body. */
function scriptedFetch(routes: Readonly<Record<string, Answer>>) {
  const calls: string[] = [];
  const bodies: Record<string, string> = {};
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url).replace(`${API}/accounts/${ACCOUNT}`, '')}`;
    calls.push(key);
    if (typeof init?.body === 'string') bodies[key] = init.body;
    const reply = routes[key];
    if (!reply) throw new Error(`unexpected call ${key}`);
    if (reply instanceof Error) throw reply;
    if (reply === 'no-headers') return new Promise<Response>(() => undefined);
    if (reply === 'no-body-end') {
      return new Response(new ReadableStream({ start: () => undefined }), { status: 200 });
    }
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status });
  }) as typeof globalThis.fetch;
  return { fetch, calls, bodies };
}

const context = (fetch: typeof globalThis.fetch) => ({
  fetch,
  requestTimeoutMilliseconds: 50,
  token: 'token',
  apiBaseUrl: API,
  namespaceId: NAMESPACE,
  accountId: ACCOUNT,
  worker: 'app-ai',
});
const claim = {
  name: 'capture-probe',
  tag: 'preview-capture-probe',
  commit: COMMIT,
  nowUtc: () => NOW,
};

const NAMESPACE_OK = { [GET_NAMESPACE]: answer(200, namespaceSuccess(NAMESPACE)) };
const ABSENT = { ...NAMESPACE_OK, [GET_PREVIEW]: answer(404, previewNotFound) };
const FOUND = { ...NAMESPACE_OK, [GET_PREVIEW]: answer(200, previewSuccess()) };
const OWNED = { ...FOUND, [READ_RECORD]: answer(200, recordValue()) };
const CREATED = {
  ...ABSENT,
  [CREATE]: answer(200, previewCreated()),
  [WRITE_RECORD]: answer(200, kvWriteSuccess),
};

describe('readWorkerIdentity', () => {
  it('reads the account and Worker from the committed wrangler.toml', () => {
    expect(readWorkerIdentity(committedWranglerToml)).toEqual({
      accountId: ACCOUNT,
      worker: 'app-ai',
    });
  });

  it('ignores a name inside a table', () => {
    expect(readWorkerIdentity(WRANGLER_TOML).worker).toBe('app-ai');
  });
});

describe('claimPreview — create-time ownership by ID and creation time', () => {
  it('creates an absent Preview through Create Preview and records the ID it answered', async () => {
    const api = scriptedFetch(CREATED);
    await expect(claimPreview(context(api.fetch), claim)).resolves.toEqual({
      state: 'created',
      id: PREVIEW_ID,
    });
    expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW, CREATE, WRITE_RECORD]);
    expect(JSON.parse(api.bodies[CREATE] ?? '')).toEqual({ name: 'capture-probe' });
    expect(JSON.parse(api.bodies[WRITE_RECORD] ?? '')).toEqual({
      module: 'app-ai',
      name: 'capture-probe',
      previewId: PREVIEW_ID,
      previewCreatedOnUtc: CREATED_ON_UTC,
      tagName: 'preview-capture-probe',
      commitSha: COMMIT,
      createdAtUtc: NOW,
    });
  });

  it('claims an existing Preview only when its ID is recorded under its name', async () => {
    const api = scriptedFetch(OWNED);
    await expect(claimPreview(context(api.fetch), claim)).resolves.toEqual({
      state: 'owned',
      id: PREVIEW_ID,
    });
    expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW, READ_RECORD]);
  });

  it('reads a record as Cloudflare returns it, the stored bytes with no envelope', async () => {
    const api = scriptedFetch({ ...FOUND, [READ_RECORD]: answer(200, kvValuePresent) });
    expect((await claimPreview(context(api.fetch), claim)).state).toBe('owned');
  });

  it.each([
    ['no record for its ID', { ...FOUND, [READ_RECORD]: answer(404, kvValueNotFound) }],
    [
      'a record naming another Preview',
      { ...FOUND, [READ_RECORD]: answer(200, recordValue(PREVIEW_ID, 'bar')) },
    ],
    [
      'a record for another ID',
      { ...FOUND, [READ_RECORD]: answer(200, recordValue(OTHER_PREVIEW_ID)) },
    ],
    ['an unreadable record', { ...FOUND, [READ_RECORD]: answer(500, failure(10000)) }],
    ['a record that is not JSON', { ...FOUND, [READ_RECORD]: answer(200, 'not json') }],
    [
      'a record made for an earlier Preview that had its ID',
      {
        ...NAMESPACE_OK,
        [GET_PREVIEW]: answer(
          200,
          previewSuccess(PREVIEW_ID, 'capture-probe', '2026-11-01T00:00:00Z'),
        ),
        [READ_RECORD]: answer(200, recordValue()),
      },
    ],
    [
      'a record whose creation time drops the microseconds',
      {
        ...FOUND,
        [READ_RECORD]: answer(
          200,
          recordValue(PREVIEW_ID, 'capture-probe', `${CREATED_ON_UTC.slice(0, 23)}Z`),
        ),
      },
    ],
    [
      'a record without a creation time',
      { ...FOUND, [READ_RECORD]: answer(200, recordValue(PREVIEW_ID, 'capture-probe', null)) },
    ],
    [
      'an identifier resolved to another name',
      { ...NAMESPACE_OK, [GET_PREVIEW]: answer(200, previewSuccess(PREVIEW_ID, 'bar')) },
    ],
    ['an unreadable Preview', { ...NAMESPACE_OK, [GET_PREVIEW]: answer(500, failure(10000)) }],
    ['a failed read', { ...NAMESPACE_OK, [GET_PREVIEW]: new TypeError('fetch failed') }],
  ])('refuses a same-named Preview with %s, creating nothing', async (_, routes) => {
    const api = scriptedFetch(routes);
    const result = await claimPreview(context(api.fetch), claim);
    expect(result.state).toBe('refused');
    expect(api.calls.filter((call) => !call.startsWith('GET '))).toEqual([]);
  });

  it('refuses a Preview Cloudflare answered without a creation time before reading its record', async () => {
    const api = scriptedFetch({
      ...NAMESPACE_OK,
      [GET_PREVIEW]: answer(200, previewSuccess(PREVIEW_ID, 'capture-probe', null)),
      [READ_RECORD]: answer(200, recordValue()),
    });
    expect((await claimPreview(context(api.fetch), claim)).state).toBe('refused');
    expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW]);
  });

  it('fails without a record when Create Preview refuses or answers another Preview', async () => {
    for (const created of [
      answer(400, failure(10021)),
      answer(200, previewCreated(PREVIEW_ID, 'bar')),
    ]) {
      const api = scriptedFetch({ ...ABSENT, [CREATE]: created });
      expect((await claimPreview(context(api.fetch), claim)).state).toBe('failed');
      expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW, CREATE]);
    }
  });

  it('writes no record for a created Preview Cloudflare answered without a creation time', async () => {
    const api = scriptedFetch({
      ...ABSENT,
      [CREATE]: answer(200, previewCreated(PREVIEW_ID, 'capture-probe', null)),
    });
    await expect(claimPreview(context(api.fetch), claim)).resolves.toMatchObject({
      state: 'unrecorded',
      id: PREVIEW_ID,
    });
    expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW, CREATE]);
  });

  it('reports a created Preview whose record could not be written as unrecorded', async () => {
    const api = scriptedFetch({ ...CREATED, [WRITE_RECORD]: answer(403, failure(10000)) });
    await expect(claimPreview(context(api.fetch), claim)).resolves.toMatchObject({
      state: 'unrecorded',
      id: PREVIEW_ID,
    });
  });
});

describe('deleteOwnedPreview — by recorded ID only', () => {
  it('deletes the recorded ID, never the name', async () => {
    const api = scriptedFetch({ ...OWNED, [DELETE_BY_ID]: answer(200, deleteSuccess) });
    await expect(deleteOwnedPreview(context(api.fetch), 'capture-probe')).resolves.toEqual({
      state: 'deleted',
      id: PREVIEW_ID,
    });
    expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW, READ_RECORD, DELETE_BY_ID]);
  });

  it('never deletes a Preview that replaced the recorded one under the same name', async () => {
    const api = scriptedFetch({
      ...NAMESPACE_OK,
      [GET_PREVIEW]: answer(200, previewSuccess(OTHER_PREVIEW_ID)),
      [`GET ${record(OTHER_PREVIEW_ID)}`]: answer(404, kvValueNotFound),
    });
    expect((await deleteOwnedPreview(context(api.fetch), 'capture-probe')).state).toBe('refused');
    expect(api.calls.some((call) => call.startsWith('DELETE '))).toBe(false);
  });

  it('never deletes a later Preview that carries a recorded ID', async () => {
    const api = scriptedFetch({
      ...NAMESPACE_OK,
      [GET_PREVIEW]: answer(
        200,
        previewSuccess(PREVIEW_ID, 'capture-probe', '2026-11-01T00:00:00Z'),
      ),
      [READ_RECORD]: answer(200, recordValue()),
    });
    expect((await deleteOwnedPreview(context(api.fetch), 'capture-probe')).state).toBe('refused');
    expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW, READ_RECORD]);
  });

  it('counts a recorded Preview deleted since the read as gone', async () => {
    const api = scriptedFetch({ ...OWNED, [DELETE_BY_ID]: answer(404, deleteNotFound) });
    expect((await deleteOwnedPreview(context(api.fetch), 'capture-probe')).state).toBe('gone');
  });
});

describe('the registry namespace is verified before any Preview or record call', () => {
  it('goes on only when the namespace answers with its own ID and the registry title', async () => {
    const deploy = scriptedFetch(CREATED);
    expect((await claimPreview(context(deploy.fetch), claim)).state).toBe('created');
    expect(deploy.calls[0]).toBe(GET_NAMESPACE);
    const teardown = scriptedFetch({ ...OWNED, [DELETE_BY_ID]: answer(200, deleteSuccess) });
    expect((await deleteOwnedPreview(context(teardown.fetch), 'capture-probe')).state).toBe(
      'deleted',
    );
    expect(teardown.calls[0]).toBe(GET_NAMESPACE);
  });

  it.each([
    ['another title', answer(200, namespaceSuccess(NAMESPACE, 'app-ai-FILES_KV_preview'))],
    ['another ID', answer(200, namespaceSuccess(OTHER_NAMESPACE))],
    ['an unknown namespace', answer(404, namespaceNotFound)],
    ['a refused read', answer(403, failure(10000))],
    ['a failed read', new TypeError('fetch failed')],
    ['a read that never completes', 'no-headers'],
  ] as const)('refuses %s as misconfigured with no later call', async (_, reply) => {
    const routes = { ...CREATED, ...OWNED, [GET_NAMESPACE]: reply };
    const deploy = scriptedFetch(routes);
    expect((await claimPreview(context(deploy.fetch), claim)).state).toBe('misconfigured');
    expect(deploy.calls).toEqual([GET_NAMESPACE]);
    const teardown = scriptedFetch(routes);
    expect((await deleteOwnedPreview(context(teardown.fetch), 'capture-probe')).state).toBe(
      'misconfigured',
    );
    expect(teardown.calls).toEqual([GET_NAMESPACE]);
  });
});

describe('every Cloudflare request is bounded', () => {
  it.each(['no-headers', 'no-body-end'] as const)(
    'settles a request whose answer never completes (%s) and calls nothing after it',
    async (stall) => {
      for (const [routes, state] of [
        [{ [GET_NAMESPACE]: stall }, 'misconfigured'],
        [{ ...NAMESPACE_OK, [GET_PREVIEW]: stall }, 'refused'],
        [{ ...FOUND, [READ_RECORD]: stall }, 'refused'],
      ] as const) {
        const deploy = scriptedFetch(routes);
        expect((await claimPreview(context(deploy.fetch), claim)).state).toBe(state);
        expect(deploy.calls.length).toBe(Object.keys(routes).length);
        const teardown = scriptedFetch(routes);
        expect((await deleteOwnedPreview(context(teardown.fetch), 'capture-probe')).state).toBe(
          state,
        );
        expect(teardown.calls.length).toBe(Object.keys(routes).length);
      }
    },
  );

  it('fails a create whose answer never completes, writing no record', async () => {
    const api = scriptedFetch({ ...ABSENT, [CREATE]: 'no-headers' });
    expect((await claimPreview(context(api.fetch), claim)).state).toBe('failed');
    expect(api.calls).toEqual([GET_NAMESPACE, GET_PREVIEW, CREATE]);
  });
});

describe('main — every terminal state as the workflow sees it', () => {
  const env = {
    CLOUDFLARE_API_TOKEN: 'token',
    CLOUDFLARE_API_BASE_URL: `${API}/`,
    PREVIEW_REGISTRY_KV_NAMESPACE_ID: NAMESPACE,
  };
  const CLAIM = [
    'claim',
    '--name',
    'capture-probe',
    '--tag',
    'preview-capture-probe',
    '--commit',
    COMMIT,
  ];
  const DELETE = ['delete', '--name', 'capture-probe', '--tag', 'preview-capture-probe'];

  async function run(
    argv: readonly string[],
    routes: Readonly<Record<string, Answer>>,
    overrides = {},
  ) {
    const api = scriptedFetch(routes);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      fetch: api.fetch,
      env: { ...env, ...overrides },
      readWranglerToml: () => WRANGLER_TOML,
      log: (message) => out.push(message),
      error: (message) => err.push(message),
      nowUtc: () => NOW,
      requestTimeoutMilliseconds: 50,
    });
    return { code, out, err: err.join('\n'), calls: api.calls };
  }

  it.each([
    ['claim created', CLAIM, CREATED, 0, [PREVIEW_ID], /Created Preview 'capture-probe'/],
    ['claim owned', CLAIM, OWNED, 0, [PREVIEW_ID], /is recorded as owner:app-ai:/],
    [
      'claim refused',
      CLAIM,
      { ...FOUND, [READ_RECORD]: answer(404, kvValueNotFound) },
      1,
      [],
      /Refusing to deploy/,
    ],
    [
      'claim failed',
      CLAIM,
      { ...ABSENT, [CREATE]: answer(400, failure(10021)) },
      1,
      [],
      /Creating Preview 'capture-probe' failed/,
    ],
    [
      'claim unrecorded',
      CLAIM,
      { ...CREATED, [WRITE_RECORD]: answer(403, failure(10000)) },
      1,
      [],
      /could not record it/,
    ],
    [
      'delete deleted',
      DELETE,
      { ...OWNED, [DELETE_BY_ID]: answer(200, deleteSuccess) },
      0,
      [],
      /Deleted Preview/,
    ],
    ['delete absent', DELETE, ABSENT, 0, [], /already clean/],
    [
      'claim on another namespace',
      CLAIM,
      { ...CREATED, [GET_NAMESPACE]: answer(200, namespaceSuccess(NAMESPACE, 'other')) },
      1,
      [],
      /Refusing to deploy Preview 'capture-probe': KV namespace .* is not the one titled preview-registry/,
    ],
    [
      'delete on another namespace',
      DELETE,
      { ...OWNED, [GET_NAMESPACE]: answer(200, namespaceSuccess(NAMESPACE, 'other')) },
      1,
      [],
      /Refusing to delete Preview 'capture-probe': KV namespace .* is not the one titled preview-registry/,
    ],
    [
      'delete gone',
      DELETE,
      { ...OWNED, [DELETE_BY_ID]: answer(404, deleteNotFound) },
      0,
      [],
      /nothing deleted/,
    ],
    [
      'delete refused',
      DELETE,
      { ...FOUND, [READ_RECORD]: answer(404, kvValueNotFound) },
      1,
      [],
      /Refusing to delete/,
    ],
    [
      'delete failed',
      DELETE,
      { ...OWNED, [DELETE_BY_ID]: answer(500, failure(10000)) },
      1,
      [],
      /Deleting Preview 'capture-probe' failed/,
    ],
  ] as const)('%s exits %i', async (_, argv, routes, code, out, message) => {
    const result = await run(argv, routes);
    expect(result.code).toBe(code);
    expect(result.out).toEqual(out);
    expect(result.err).toMatch(message);
  });

  it.each([
    [
      'a tag for another name',
      ['claim', '--name', 'capture-probe', '--tag', 'preview-bar', '--commit', COMMIT],
      {},
    ],
    [
      'a claim without a commit',
      ['claim', '--name', 'capture-probe', '--tag', 'preview-capture-probe'],
      {},
    ],
    [
      'an unknown command',
      ['check', '--name', 'capture-probe', '--tag', 'preview-capture-probe'],
      {},
    ],
    ['no token', DELETE, { CLOUDFLARE_API_TOKEN: '' }],
    ['no namespace', DELETE, { PREVIEW_REGISTRY_KV_NAMESPACE_ID: undefined }],
  ] as const)('exits 1 on %s before any Cloudflare call', async (_, argv, overrides) => {
    const result = await run(argv, {}, overrides);
    expect(result.code).toBe(1);
    expect(result.calls).toEqual([]);
  });
});
