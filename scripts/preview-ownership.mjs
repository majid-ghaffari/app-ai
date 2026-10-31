/**
 * Ownership of the Cloudflare Worker Previews the `preview-<name>` tag workflows manage: a Preview
 * is this automation's only when the preview registry's KV namespace records its ID and creation
 * time as `owner:app-ai:<Preview ID>`. The model and its accepted risk: README.md, "Previews".
 *
 *   node scripts/preview-ownership.mjs claim --name <name> --tag preview-<name> --commit <sha>
 *   node scripts/preview-ownership.mjs delete --name <name> --tag preview-<name>
 *
 * `claim` prints the owned Preview's ID, creating and recording it when no Preview has the name;
 * `delete` deletes by the recorded ID only. Every refusal or failure exits 1 before any later
 * Cloudflare call. Reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_BASE_URL` and
 * `PREVIEW_REGISTRY_KV_NAMESPACE_ID` from the environment and the account and Worker from
 * wrangler.toml; Node built-ins only, so the delete job installs nothing.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const WRANGLER_CONFIG_PATH = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
/** Cloudflare's "no such Preview", as Wrangler 4.150.0's `runPreview` reads it. */
const PREVIEW_NOT_FOUND = 10025;
const PREVIEW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const CLOUDFLARE_ID_RE = /^[0-9a-f]{32}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
/** Titles are unique per account, so the title and the ID together name the registry's namespace. */
const REGISTRY_NAMESPACE_TITLE = 'preview-registry';

/** The top-level `account_id` and Worker `name`, read before the first table. */
export function readWorkerIdentity(wranglerToml) {
  const topLevel = wranglerToml.split(/^\[/m)[0] ?? '';
  const accountId = topLevel.match(/^account_id = "([0-9a-f]{32})"$/m)?.[1];
  const worker = topLevel.match(/^name = "([a-z0-9-]+)"$/m)?.[1];
  if (!accountId || !worker) throw new Error('wrangler.toml names no account_id or Worker name.');
  return { accountId, worker };
}

export const ownerKey = (previewId) => `owner:app-ai:${previewId}`;

/** One Cloudflare request, headers and body together bounded by `context.requestTimeoutMilliseconds`. */
async function callCloudflare(context, method, path, { body, contentType } = {}) {
  const signal = AbortSignal.timeout(context.requestTimeoutMilliseconds);
  const deadline = new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () =>
        reject(
          new Error(`no complete answer within ${context.requestTimeoutMilliseconds} milliseconds`),
        ),
      { once: true },
    );
  });
  const exchange = (async () => {
    const response = await context.fetch(
      `${context.apiBaseUrl}/accounts/${context.accountId}${path}`,
      {
        method,
        signal,
        headers: {
          Authorization: `Bearer ${context.token}`,
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        ...(body === undefined ? {} : { body }),
      },
    );
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // A KV value or an error page; callers that need JSON see null.
    }
    return { status: response.status, text, json };
  })();
  try {
    return await Promise.race([exchange, deadline]);
  } catch (error) {
    return { status: 0, text: '', json: null, error: String(error) };
  }
}

const previewPath = (context, identifier) =>
  `/workers/workers/${context.worker}/previews${identifier ? `/${encodeURIComponent(identifier)}` : ''}`;
const namespacePath = (context) => `/storage/kv/namespaces/${context.namespaceId}`;
const recordPath = (context, previewId) =>
  `/storage/kv/namespaces/${context.namespaceId}/values/${encodeURIComponent(ownerKey(previewId))}`;
const succeeded = (answer) => answer.status === 200 && answer.json?.success === true;
const notFound = (answer) =>
  answer.json?.success === false &&
  Array.isArray(answer.json.errors) &&
  answer.json.errors.some((entry) => entry?.code === PREVIEW_NOT_FOUND);
const describe = (answer) =>
  `http=${answer.status} ${answer.error ?? JSON.stringify(answer.json?.errors ?? null)}`;
/** Whether a value is a timestamp Cloudflare could have answered. */
const isTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** `verified` when the configured namespace answers with its own ID and the registry's title, else `misconfigured`. */
async function verifyNamespace(context) {
  const answer = await callCloudflare(context, 'GET', namespacePath(context));
  const result = succeeded(answer) ? answer.json.result : null;
  if (!result) {
    return {
      state: 'misconfigured',
      reason: `KV namespace ${context.namespaceId} could not be read (${describe(answer)})`,
    };
  }
  if (result.id !== context.namespaceId || result.title !== REGISTRY_NAMESPACE_TITLE) {
    return {
      state: 'misconfigured',
      reason: `KV namespace ${context.namespaceId} is not the one titled ${REGISTRY_NAMESPACE_TITLE}`,
    };
  }
  return { state: 'verified' };
}

/** `absent`, `found` with the exact-named Preview's ID and creation time, or `refused`. */
async function findPreview(context, name) {
  const answer = await callCloudflare(context, 'GET', previewPath(context, name));
  if (notFound(answer)) return { state: 'absent' };
  const result = succeeded(answer) ? answer.json.result : null;
  if (typeof result?.id !== 'string' || !CLOUDFLARE_ID_RE.test(result.id)) {
    return { state: 'refused', reason: `it could not be read (${describe(answer)})` };
  }
  // The identifier also matches an ID or slug, so only the exact name is this tag's Preview.
  if (result.name !== name) {
    return {
      state: 'refused',
      reason: `Cloudflare resolved it to the Preview named '${result.name}'`,
    };
  }
  if (!isTimestamp(result.created_on)) {
    return {
      state: 'refused',
      reason: `Cloudflare answered no created_on for it (${describe(answer)})`,
    };
  }
  return { state: 'found', id: result.id, createdOnUtc: result.created_on };
}

/**
 * `owned` when the registry namespace records the found Preview's ID under `name` with the same
 * `created_on` text, otherwise `refused`.
 */
async function readOwnership(context, name, preview) {
  const previewId = preview.id;
  const answer = await callCloudflare(context, 'GET', recordPath(context, previewId));
  if (answer.status !== 200) {
    return {
      state: 'refused',
      reason: `no ownership record for its ID ${previewId} could be read (${describe(answer)})`,
    };
  }
  if (answer.json?.previewId !== previewId || answer.json?.name !== name) {
    return { state: 'refused', reason: `the record for its ID ${previewId} names another Preview` };
  }
  const recorded = answer.json?.previewCreatedOnUtc;
  // Compared as text: Cloudflare answers created_on to the microsecond and Date.parse keeps
  // milliseconds. A re-serialized created_on refuses every recorded Preview until deleted by hand.
  if (!isTimestamp(recorded) || recorded !== preview.createdOnUtc) {
    return {
      state: 'refused',
      reason: `the record for its ID ${previewId} was made for a Preview created at ${String(answer.json?.previewCreatedOnUtc)}, not ${preview.createdOnUtc}`,
    };
  }
  return { state: 'owned', id: previewId };
}

/**
 * The ID of the Preview `name` this automation owns: `owned` when its ID is recorded, `created`
 * when no Preview had the name and Create Preview made one now and its record was written,
 * `unrecorded` when the record write failed after the create, `misconfigured` when the namespace
 * is not the registry's, `refused` or `failed`.
 */
export async function claimPreview(context, { name, tag, commit, nowUtc }) {
  const namespace = await verifyNamespace(context);
  if (namespace.state !== 'verified') return namespace;
  const found = await findPreview(context, name);
  if (found.state === 'refused') return found;
  if (found.state === 'found') return readOwnership(context, name, found);
  // Create Preview, not Wrangler's find-or-create, so the ID answered is one this run created.
  const created = await callCloudflare(context, 'POST', previewPath(context), {
    body: JSON.stringify({ name }),
    contentType: 'application/json',
  });
  const result = succeeded(created) ? created.json.result : null;
  if (typeof result?.id !== 'string' || !CLOUDFLARE_ID_RE.test(result.id) || result.name !== name) {
    return { state: 'failed', reason: `Create Preview answered ${describe(created)}` };
  }
  if (!isTimestamp(result.created_on)) {
    return { state: 'unrecorded', id: result.id, reason: 'Create Preview answered no created_on' };
  }
  const record = {
    module: 'app-ai',
    name,
    previewId: result.id,
    previewCreatedOnUtc: result.created_on,
    tagName: tag,
    commitSha: commit,
    createdAtUtc: nowUtc(),
  };
  const stored = await callCloudflare(context, 'PUT', recordPath(context, result.id), {
    body: JSON.stringify(record),
    contentType: 'application/octet-stream',
  });
  if (!succeeded(stored)) return { state: 'unrecorded', id: result.id, reason: describe(stored) };
  return { state: 'created', id: result.id };
}

/**
 * Deletes the Preview `name` only by its recorded ID: `deleted`, `absent` (no Preview has the
 * name), `gone` (deleted since the read; nothing deleted), `misconfigured` (the namespace is not
 * the registry's), `refused`, or `failed`.
 */
export async function deleteOwnedPreview(context, name) {
  const namespace = await verifyNamespace(context);
  if (namespace.state !== 'verified') return namespace;
  const found = await findPreview(context, name);
  if (found.state !== 'found') return found;
  const ownership = await readOwnership(context, name, found);
  if (ownership.state !== 'owned') return ownership;
  const deleted = await callCloudflare(context, 'DELETE', previewPath(context, ownership.id));
  if (succeeded(deleted)) return { state: 'deleted', id: ownership.id };
  if (notFound(deleted)) return { state: 'gone', id: ownership.id };
  return { state: 'failed', reason: describe(deleted) };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag !== '--name' && flag !== '--tag' && flag !== '--commit') {
      throw new Error(`Unknown argument '${flag}'.`);
    }
    options[flag.slice(2)] = rest[index + 1] ?? '';
  }
  if (command !== 'claim' && command !== 'delete') {
    throw new Error('Usage: preview-ownership.mjs claim|delete --name <name> --tag preview-<name>');
  }
  const { name = '', tag = '', commit = '' } = options;
  if (!PREVIEW_NAME_RE.test(name) || tag !== `preview-${name}`) {
    throw new Error(`Refusing name '${name}' with tag '${tag}'.`);
  }
  if (command === 'claim' && !COMMIT_RE.test(commit)) {
    throw new Error(`Refusing commit '${commit}'.`);
  }
  return { command, name, tag, commit };
}

/** Runs one command and resolves to the process exit code; `claim` prints only the ID on stdout. */
export async function main(
  argv = process.argv.slice(2),
  {
    fetch = globalThis.fetch,
    env = process.env,
    readWranglerToml = () => readFileSync(WRANGLER_CONFIG_PATH, 'utf8'),
    log = console.log,
    error = console.error,
    nowUtc = () => new Date().toISOString(),
    requestTimeoutMilliseconds = REQUEST_TIMEOUT_MILLISECONDS,
  } = {},
) {
  let command, name, tag, commit, context;
  try {
    ({ command, name, tag, commit } = parseArguments(argv));
    if (!env.CLOUDFLARE_API_TOKEN) throw new Error('Repo secret CLOUDFLARE_API_TOKEN is not set.');
    if (!env.CLOUDFLARE_API_BASE_URL) throw new Error('CLOUDFLARE_API_BASE_URL is not set.');
    const namespaceId = env.PREVIEW_REGISTRY_KV_NAMESPACE_ID;
    if (typeof namespaceId !== 'string' || !CLOUDFLARE_ID_RE.test(namespaceId)) {
      throw new Error(
        `Repo variable PREVIEW_REGISTRY_KV_NAMESPACE_ID must be the ID of the KV namespace titled ${REGISTRY_NAMESPACE_TITLE}.`,
      );
    }
    context = {
      fetch,
      requestTimeoutMilliseconds,
      token: env.CLOUDFLARE_API_TOKEN,
      apiBaseUrl: env.CLOUDFLARE_API_BASE_URL.replace(/\/+$/, ''),
      namespaceId,
      ...readWorkerIdentity(readWranglerToml()),
    };
  } catch (failure) {
    error(failure instanceof Error ? failure.message : String(failure));
    return 1;
  }
  const byHand = `Check what it is, then delete it by hand: npx wrangler preview delete --name ${name}`;
  const namespaceHint = `PREVIEW_REGISTRY_KV_NAMESPACE_ID must be the ID of the KV namespace titled ${REGISTRY_NAMESPACE_TITLE}, readable with CLOUDFLARE_API_TOKEN`;

  if (command === 'claim') {
    const claim = await claimPreview(context, { name, tag, commit, nowUtc });
    switch (claim.state) {
      case 'created':
        error(`Created Preview '${name}' (${claim.id}) and recorded it as ${ownerKey(claim.id)}.`);
        log(claim.id);
        return 0;
      case 'owned':
        error(`Preview '${name}' (${claim.id}) is recorded as ${ownerKey(claim.id)}.`);
        log(claim.id);
        return 0;
      case 'misconfigured':
        error(`Refusing to deploy Preview '${name}': ${claim.reason}. ${namespaceHint}.`);
        return 1;
      case 'refused':
        error(`Refusing to deploy over Preview '${name}': ${claim.reason}. ${byHand}`);
        return 1;
      case 'unrecorded':
        error(
          `Created Preview '${name}' (${claim.id}) but could not record it (${claim.reason}), so no automation will deploy over or delete it. ${byHand}`,
        );
        return 1;
      default:
        error(`Creating Preview '${name}' failed: ${claim.reason}`);
        return 1;
    }
  }

  const deletion = await deleteOwnedPreview(context, name);
  switch (deletion.state) {
    case 'deleted':
      error(`Deleted Preview '${name}' (${deletion.id}).`);
      return 0;
    case 'absent':
      error(`Preview '${name}' not found (already clean).`);
      return 0;
    case 'gone':
      error(`Preview '${name}' (${deletion.id}) was deleted since it was read; nothing deleted.`);
      return 0;
    case 'misconfigured':
      error(`Refusing to delete Preview '${name}': ${deletion.reason}. ${namespaceHint}.`);
      return 1;
    case 'refused':
      error(`Refusing to delete Preview '${name}': ${deletion.reason}. ${byHand}`);
      return 1;
    default:
      error(`Deleting Preview '${name}' failed: ${deletion.reason}`);
      return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
