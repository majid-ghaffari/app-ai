/**
 * Live Cloudflare API responses for the calls `scripts/preview-ownership.mjs` makes, captured
 * 2026-10-31 at 15:49:50 to 15:49:51 UTC against https://api.cloudflare.com/client/v4 in app-ai's
 * account, at the operator's request, one file per call in `cloudflare/` with its request, status,
 * Content-Type and body text. Redacted: the namespace and Preview IDs are visibly fake hex
 * (`feedface…`, `c0ffee…`), the commit is zeros and the workers.dev subdomain is
 * `example-subdomain`. The throwaway Preview `capture-probe` and its record were deleted after the
 * capture. A request body is the capture recipe's, so `kv-value-put.json`'s is not byte for byte
 * what `claim` sends. A second Create Preview for a taken name was not captured; `failure` stands
 * in for its answer.
 *
 * Every export with default arguments is a captured body byte for byte. A variant a test needs,
 * another ID, name, title or creation time, is that captured body with only those fields changed;
 * `failure` puts another error code in the captured Preview failure envelope, for statuses the
 * capture did not produce.
 */
import kvNamespaceGet from './cloudflare/kv-namespace-get.json?raw';
import kvNamespaceGetAbsent from './cloudflare/kv-namespace-get-absent.json?raw';
import kvValueGetAbsent from './cloudflare/kv-value-get-absent.json?raw';
import kvValueGetPresent from './cloudflare/kv-value-get-present.json?raw';
import kvValuePut from './cloudflare/kv-value-put.json?raw';
import previewCreate from './cloudflare/preview-create.json?raw';
import previewDelete from './cloudflare/preview-delete.json?raw';
import previewDeleteAgain from './cloudflare/preview-delete-again.json?raw';
import previewGetAbsent from './cloudflare/preview-get-absent.json?raw';
import previewGetByName from './cloudflare/preview-get-by-name.json?raw';

interface Capture {
  readonly status: number;
  readonly body: string;
}

/** The captured body text; the capture's status is asserted so a fixture cannot drift from it. */
function captured(file: string, status: number): string {
  const capture = JSON.parse(file) as Capture;
  if (capture.status !== status) {
    throw new Error(`capture answered ${capture.status}, not ${status}`);
  }
  return capture.body;
}

const NAMESPACE_GET = captured(kvNamespaceGet, 200);
const PREVIEW_GET = captured(previewGetByName, 200);
const PREVIEW_CREATE = captured(previewCreate, 200);

interface PreviewEnvelope {
  result: { id: string; slug: string; name: string; created_on: string | null };
}
interface NamespaceEnvelope {
  result: { id: string; title: string };
}

const capturedPreview = (JSON.parse(PREVIEW_GET) as PreviewEnvelope).result;
export const PREVIEW_ID = capturedPreview.id;
export const PREVIEW_NAME = capturedPreview.name;
export const CREATED_ON_UTC = capturedPreview.created_on as string;
export const NAMESPACE_ID = (JSON.parse(NAMESPACE_GET) as NamespaceEnvelope).result.id;
export const OTHER_PREVIEW_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** A captured Preview body with its identity changed only where the arguments differ. */
function withPreview(body: string, id: string, name: string, createdOnUtc: string | null): string {
  if (id === PREVIEW_ID && name === PREVIEW_NAME && createdOnUtc === CREATED_ON_UTC) return body;
  const envelope = JSON.parse(body) as PreviewEnvelope;
  Object.assign(envelope.result, { id, slug: name, name, created_on: createdOnUtc });
  return JSON.stringify(envelope);
}

/** Get a Namespace, 200. */
export function namespaceSuccess(id = NAMESPACE_ID, title = 'preview-registry'): string {
  if (id === NAMESPACE_ID && title === 'preview-registry') return NAMESPACE_GET;
  const envelope = JSON.parse(NAMESPACE_GET) as NamespaceEnvelope;
  Object.assign(envelope.result, { id, title });
  return JSON.stringify(envelope);
}

/** Get a Namespace for an ID no namespace has, 404, error 10013. */
export const namespaceNotFound = captured(kvNamespaceGetAbsent, 404);

/** Get Preview by name, 200. */
export const previewSuccess = (
  id = PREVIEW_ID,
  name = PREVIEW_NAME,
  createdOnUtc: string | null = CREATED_ON_UTC,
) => withPreview(PREVIEW_GET, id, name, createdOnUtc);

/** Create Preview, 200. */
export const previewCreated = (
  id = PREVIEW_ID,
  name = PREVIEW_NAME,
  createdOnUtc: string | null = CREATED_ON_UTC,
) => withPreview(PREVIEW_CREATE, id, name, createdOnUtc);

/** Get Preview for a name no Preview has, 404, error 10025. */
export const previewNotFound = captured(previewGetAbsent, 404);

/** Delete Preview, 200, and the same delete again, 404, error 10025. */
export const deleteSuccess = captured(previewDelete, 200);
export const deleteNotFound = captured(previewDeleteAgain, 404);

/** Write key-value pair, 200; its `result` is null. */
export const kvWriteSuccess = captured(kvValuePut, 200);

/** Read key-value pair: the stored bytes with no envelope, 200, and a missing key, 404, 10009. */
export const kvValuePresent = captured(kvValueGetPresent, 200);
export const kvValueNotFound = captured(kvValueGetAbsent, 404);

/** The captured Preview failure envelope carrying another error code. */
export function failure(code: number, message = 'redacted'): string {
  const envelope = JSON.parse(previewNotFound) as { errors: { code: number; message: string }[] };
  envelope.errors = [{ code, message }];
  return JSON.stringify(envelope);
}
