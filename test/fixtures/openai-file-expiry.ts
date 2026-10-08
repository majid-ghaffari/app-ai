/**
 * One genuine OpenAI Files round with app-ai's upload shape: the upload answer, the metadata read
 * back and the delete answer. The file id is replaced by a placeholder; the file held only the
 * smoke text, and no answer carried an account identifier.
 */
export const OPENAI_FILE_EXPIRY_CAPTURE = {
  recordedAt: '2026-10-11T14:33:17Z',
  endpoints: [
    'POST https://api.openai.com/v1/files',
    'GET https://api.openai.com/v1/files/{id}',
    'DELETE https://api.openai.com/v1/files/{id}',
  ],
  uploadForm: {
    file: '<file expiry-smoke.txt text/plain 26 bytes>',
    purpose: 'user_data',
    'expires_after[anchor]': 'created_at',
    'expires_after[seconds]': '2592000',
  },
  upload: {
    object: 'file',
    id: 'file-redacted1',
    purpose: 'user_data',
    filename: 'expiry-smoke.txt',
    bytes: 26,
    created_at: 1791729196,
    expires_at: 1794321196,
    status: 'processed',
    status_details: null,
  },
  metadata: {
    object: 'file',
    id: 'file-redacted1',
    purpose: 'user_data',
    filename: 'expiry-smoke.txt',
    bytes: 26,
    created_at: 1791729196,
    expires_at: 1794321196,
    status: 'processed',
    status_details: null,
  },
  deleted: {
    object: 'file',
    deleted: true,
    id: 'file-redacted1',
  },
} as const;
