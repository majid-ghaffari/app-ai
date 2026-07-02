/**
 * /files endpoints — proxy to the Anthropic Files API.
 *
 *   POST   /files       → upload   (handleFileUpload)
 *   GET    /files       → list     (handleListFiles)
 *   DELETE /files/{id}  → delete   (handleDeleteFile)
 *
 * On success, upload/list return Anthropic's body as-is; delete returns
 * `{ success: true, message: 'File deleted successfully' }`. Failures return the
 * Brain-shaped error envelope (lib/responses.ts): upstream Anthropic failures
 * keep Anthropic's status, carry `ExceptionType: 'AnthropicApiException'`, and
 * put the raw upstream body in `MessageDetail`. On a 500 upload failure the
 * `Message` is augmented with the Files-API-beta-access hint.
 */

import * as anthropic from '../lib/anthropic';
import { dedupUpload, UploadError } from '../lib/file-dedup';
import {
  jsonResponse,
  errorResponse,
  anthropicErrorResponse,
  type CorsHeaders,
} from '../lib/responses';
import { createLogger } from '../lib/logger';
import type { Env } from '../config';

const log = createLogger('Files');

const FILES_API_BETA_HINT =
  '\n\nThe Files API may not be available for your account yet. It is currently in beta and requires special access.';

/** POST /files — upload a file to the Anthropic Files API. */
export async function handleFileUpload(
  request: Request,
  env: Env,
  corsHeaders: CorsHeaders,
): Promise<Response> {
  try {
    log.info('File upload request received');

    const formData = await request.formData();
    // Boundary cast: a malformed multipart field (string instead of a file
    // part) throws at `arrayBuffer()` below and maps to the 500 envelope.
    const file = formData.get('file') as File | null;

    if (!file) {
      return errorResponse('No file provided', corsHeaders, 400, 'ArgumentException');
    }

    log.info(`Uploading file to Anthropic (${file.size} bytes, ${file.type})`);

    // Route through content-hash dedup: identical bytes (same screenshot / same
    // cleaned HTML across repeated placement calls on one page) reuse an existing
    // file_id instead of re-uploading. The Files API does NOT dedup by content,
    // so without this every call mints a fresh id — defeating the cache_control
    // breakpoint the /chat path puts on those file blocks (same bytes must map
    // to the same id to cache). Reuse is transparent: the response shape stays
    // `{ id, … }`. dedupUpload no-ops to a plain upload when FILES_KV is unbound.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { fileId, deduped } = await dedupUpload(
      {
        content: bytes,
        mimeType: file.type || 'application/octet-stream',
        filename: file.name || 'upload',
      },
      env,
    );

    log.info(`File uploaded successfully, file_id: ${fileId}${deduped ? ' (dedup hit)' : ''}`);
    return jsonResponse({ id: fileId, type: 'file' }, corsHeaders);
  } catch (error) {
    log.error('File upload error:', error);
    // Preserve the status-specific UX: a 500 from the Files API gets the
    // beta-access hint appended (dedupUpload throws `UploadError` carrying the
    // upstream status). Other failures fall back to the generic proxy message.
    // An error carrying an upstream status is an Anthropic failure; anything
    // else is a generic worker exception.
    const upload = error instanceof UploadError ? error : undefined;
    let message =
      (error instanceof Error && error.message) || 'Internal proxy server error during file upload';
    if (upload?.status === 500) {
      message += FILES_API_BETA_HINT;
    }
    const exceptionType = upload ? 'AnthropicApiException' : 'Exception';
    return errorResponse(message, corsHeaders, upload?.status ?? 500, exceptionType);
  }
}

/** GET /files — list files. */
export async function handleListFiles(env: Env, corsHeaders: CorsHeaders): Promise<Response> {
  try {
    log.info('List files request received');

    const response = await anthropic.listFiles(env);
    const data: unknown = await response.json();

    if (response.status !== 200) {
      log.error('List files error:', data);
      return anthropicErrorResponse(data, response.status, 'List files failed', corsHeaders);
    }

    return jsonResponse(data, corsHeaders);
  } catch (error) {
    log.error('List files error:', error);
    return errorResponse(
      (error instanceof Error && error.message) || 'Internal proxy server error during list files',
      corsHeaders,
    );
  }
}

/** DELETE /files/{id} — delete a file. */
export async function handleDeleteFile(
  fileId: string,
  env: Env,
  corsHeaders: CorsHeaders,
): Promise<Response> {
  try {
    log.info(`Delete file request received for: ${fileId}`);

    const response = await anthropic.deleteFile(fileId, env);

    if (response.status !== 200 && response.status !== 204) {
      const data: unknown = await response.json();
      log.error('Delete file error:', data);
      return anthropicErrorResponse(data, response.status, 'Delete file failed', corsHeaders);
    }

    return jsonResponse({ success: true, message: 'File deleted successfully' }, corsHeaders);
  } catch (error) {
    log.error('Delete file error:', error);
    return errorResponse(
      (error instanceof Error && error.message) ||
        'Internal proxy server error during file deletion',
      corsHeaders,
    );
  }
}
