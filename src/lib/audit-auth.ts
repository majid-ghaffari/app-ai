/**
 * Scoped authorization for extension-driven Studio audits.
 *
 * A website-issued, email-verified activation JWT is exchanged once for a
 * short-lived app-ai-signed session. The session is origin-bound and can call
 * only the onboarding proposal upload/inference surface. Strongly consistent
 * reservations and owned file identifiers live in AuditSessionAuthority.
 */

import {
  auditActivationSigningSecret,
  auditStatusOrigins,
  auditStatusSigningSecret,
  auditMaxMessageBytes,
  auditMaxUploadBytes,
  auditSessionSigningSecret,
  auditSessionTtlSeconds,
  type Env,
} from '../config';
import {
  createAuditAuthoritySession,
  finalizeAuditAuthorityRequest,
  reserveAuditAuthorityRequest,
  type AuditAuthorityReservation,
} from './audit-session-authority';
import { WorkerError } from './responses';

const TOKEN_HEADER = { alg: 'HS256', typ: 'JWT' } as const;
const TOKEN_VERSION = 1;
const ACTIVATION_ISSUER = 'limespot-website';
const AUDIT_ISSUER = 'app-ai';
const ACTIVATION_AUDIENCE = 'app-ai';
const AUDIT_AUDIENCE = 'studio-extension';
const AUDIT_TOKEN_PREFIX = 'ls_audit_';
const MAX_TOKEN_LENGTH = 8192;
const MAX_IDENTIFIER_LENGTH = 256;
/** A sealed public file reference is authenticated ciphertext, so it is far longer than an id. */
const MAX_FILE_REFERENCE_LENGTH = 4096;
const MAX_ACTIVATION_LIFETIME_SECONDS = 900;
const MAX_STATUS_CALLBACK_URL_LENGTH = 2048;
const ALLOWED_AUDIT_UPLOAD_PROMPTS = new Set([
  'onboarding-batch-all',
  'onboarding-batch',
  'onboarding-review-all',
  'onboarding-review-gate-all',
  'onboarding-currency-recovery',
]);
const ALLOWED_AUDIT_INFERENCE_PROMPTS = new Set(['onboarding-batch-all', 'onboarding-batch']);

interface ActivationClaims {
  readonly version: typeof TOKEN_VERSION;
  readonly kind: 'activation';
  readonly issuer: typeof ACTIVATION_ISSUER;
  readonly audience: typeof ACTIVATION_AUDIENCE;
  readonly tokenIdentifier: string;
  readonly auditIdentifier: string;
  readonly attemptLimit: 2 | null;
  readonly email: string;
  readonly emailVerified: true;
  readonly entitlement:
    | { readonly type: 'store-origin'; readonly storeOrigin: string }
    | { readonly type: 'limespot-staff-multi-store' };
  readonly statusCallbackUrl: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface AuditSessionClaims {
  readonly version: typeof TOKEN_VERSION;
  readonly kind: 'audit-session';
  readonly issuer: typeof AUDIT_ISSUER;
  readonly audience: typeof AUDIT_AUDIENCE;
  readonly sessionIdentifier: string;
  readonly auditIdentifier: string;
  readonly attemptLimit: 2 | null;
  readonly storeOrigin: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Verified audit authorization threaded through the router. */
export interface AuditAuthorization {
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  readonly reservation: AuditAuthorityReservation;
  /** Epoch milliseconds the request was admitted at; its inference deadline counts from here. */
  readonly admittedAt: number;
}

/** Successful activation exchange returned to the extension background worker. */
export interface AuditSessionExchange {
  readonly sessionIdentifier: string;
  readonly accessToken: string;
  readonly expiresAt: number;
}

/** Exchange one verified activation token for a scoped audit session. */
export async function exchangeAuditActivation(
  activationToken: string,
  storeUrl: string,
  env: Env,
): Promise<AuditSessionExchange> {
  const activation = await verifyToken(activationToken, auditActivationSigningSecret(env));
  if (!isActivationClaims(activation)) {
    throw unauthorized('The activation token is not valid for a grader exchange.');
  }
  assertTemporalClaims(activation.issuedAt, activation.expiresAt);
  if (activation.expiresAt - activation.issuedAt > MAX_ACTIVATION_LIFETIME_SECONDS) {
    throw unauthorized('The activation token lifetime is too long.');
  }
  const storeOrigin = normalizeStoreOrigin(storeUrl);
  assertActivationEntitlement(activation, storeOrigin);
  const statusCallbackUrl = resolveStatusCallbackUrl(activation.statusCallbackUrl, env);
  const sessionSigningSecret = auditSessionSigningSecret(env);
  auditStatusSigningSecret(env);
  const now = epochSeconds();
  const expiresAt = now + auditSessionTtlSeconds(env);
  const sessionIdentifier = await opaqueSessionIdentifier(activation.tokenIdentifier);
  const claims: AuditSessionClaims = {
    version: TOKEN_VERSION,
    kind: 'audit-session',
    issuer: AUDIT_ISSUER,
    audience: AUDIT_AUDIENCE,
    sessionIdentifier,
    auditIdentifier: activation.auditIdentifier,
    attemptLimit: activation.attemptLimit,
    storeOrigin,
    issuedAt: now,
    expiresAt,
  };
  await createAuditAuthoritySession(
    {
      sessionIdentifier,
      auditIdentifier: activation.auditIdentifier,
      activationIdentifier: activation.tokenIdentifier,
      attemptLimit: activation.attemptLimit,
      storeOrigin,
      statusCallbackUrl,
      expiresAt,
    },
    env,
  );
  return {
    sessionIdentifier,
    accessToken: `${AUDIT_TOKEN_PREFIX}${await signToken(claims, sessionSigningSecret)}`,
    expiresAt: expiresAt * 1000,
  };
}

/** Authenticate and atomically reserve one audit upload or inference request. */
export async function authorizeAuditRequest(
  request: Request,
  env: Env,
): Promise<AuditAuthorization | null> {
  const authorizationHeader = request.headers.get('Authorization');
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer (\S+)$/);
  if (!match?.[1]?.startsWith(AUDIT_TOKEN_PREFIX)) return null;

  const claims = await verifyToken(
    match[1].slice(AUDIT_TOKEN_PREFIX.length),
    auditSessionSigningSecret(env),
  );
  if (!isAuditSessionClaims(claims)) throw unauthorized('The grader session token is invalid.');
  assertTemporalClaims(claims.issuedAt, claims.expiresAt);
  assertRequestStoreOrigin(request, claims.storeOrigin);

  const url = new URL(request.url);
  if (request.method !== 'POST' || (url.pathname !== '/files' && url.pathname !== '/messages')) {
    throw forbidden('Audit sessions can access only proposal uploads and inference.');
  }

  let kind: 'upload' | 'message';
  let uploadBytes = 0;
  let referencedFileIdentifiers: readonly string[] = [];
  if (url.pathname === '/files') {
    kind = 'upload';
    // Upload destinations are multipart metadata, not the inference selector header. A single
    // screenshot is uploaded once and registered for every prompt that may consume it, so the
    // extension intentionally sends repeated `prompt` fields. Parse a clone: the upload handler
    // must retain the untouched original body stream for its own `request.formData()` call.
    const formData = await request.clone().formData();
    const prompts = formData.getAll('prompt');
    const files = formData.getAll('file');
    if (
      prompts.length === 0 ||
      prompts.length > ALLOWED_AUDIT_UPLOAD_PROMPTS.size ||
      new Set(prompts).size !== prompts.length ||
      prompts.some(
        (prompt) => typeof prompt !== 'string' || !ALLOWED_AUDIT_UPLOAD_PROMPTS.has(prompt),
      )
    ) {
      throw forbidden('This upload destination is not available to grader sessions.');
    }
    const file = files[0] as File | string | undefined;
    if (files.length !== 1 || !file || typeof file === 'string') {
      throw invalidArgument('A grader upload must contain one file.');
    }
    if (file.size > auditMaxUploadBytes(env)) {
      throw quotaExceeded('The grader file is larger than the allowed upload size.');
    }
    uploadBytes = file.size;
  } else {
    kind = 'message';
    const prompt = request.headers.get('X-Personalizer-System-Prompt');
    if (!prompt || !ALLOWED_AUDIT_INFERENCE_PROMPTS.has(prompt)) {
      throw forbidden('This system prompt is not available to grader sessions.');
    }
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    if (bytes.byteLength > auditMaxMessageBytes(env)) {
      throw quotaExceeded('The grader inference request is larger than the allowed size.');
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw invalidArgument('The grader inference request body must be valid JSON.');
    }
    referencedFileIdentifiers = validateAuditMessage(body);
  }

  const admittedAt = Date.now();
  const reservation = await reserveAuditAuthorityRequest(
    {
      sessionIdentifier: claims.sessionIdentifier,
      auditIdentifier: claims.auditIdentifier,
      storeOrigin: claims.storeOrigin,
      expiresAt: claims.expiresAt,
      kind,
      uploadBytes,
      referencedFileIdentifiers,
    },
    env,
  );
  return {
    sessionIdentifier: claims.sessionIdentifier,
    storeOrigin: claims.storeOrigin,
    reservation,
    admittedAt,
  };
}

/** Commit successful audit usage or release its atomic reservation after failure. */
export async function finalizeAuditUsage(
  authorization: AuditAuthorization,
  response: Response,
  env: Env,
): Promise<void> {
  let fileIdentifier: string | undefined;
  if (response.ok && authorization.reservation.kind === 'upload') {
    const result = (await response.clone().json()) as { id?: unknown };
    if (typeof result.id !== 'string' || result.id.length === 0) {
      await finalizeAuditAuthorityRequest(
        authorization.reservation,
        authorization.storeOrigin,
        false,
        undefined,
        env,
      );
      throw new WorkerError('A successful grader upload returned no file identifier.', {
        status: 502,
        exceptionType: 'InvalidUpstreamResponseException',
      });
    }
    fileIdentifier = result.id;
  }
  await finalizeAuditAuthorityRequest(
    authorization.reservation,
    authorization.storeOrigin,
    response.ok,
    fileIdentifier,
    env,
  );
}

/** Release a reservation when audit dispatch throws before it can return a response. */
export async function releaseAuditUsage(
  authorization: AuditAuthorization,
  env: Env,
): Promise<void> {
  await finalizeAuditAuthorityRequest(
    authorization.reservation,
    authorization.storeOrigin,
    false,
    undefined,
    env,
  );
}

async function signToken(claims: object, secret: string): Promise<string> {
  const header = encodeJson(TOKEN_HEADER);
  const payload = encodeJson(claims);
  const unsigned = `${header}.${payload}`;
  const signature = await hmac(unsigned, secret);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function verifyToken(token: string, secret: string): Promise<unknown> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw unauthorized('The grader token is malformed.');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw unauthorized('The grader token is malformed.');
  }
  let headerBytes: Uint8Array;
  let payloadBytes: Uint8Array;
  let actual: Uint8Array;
  try {
    headerBytes = base64UrlDecode(parts[0]);
    payloadBytes = base64UrlDecode(parts[1]);
    actual = base64UrlDecode(parts[2]);
  } catch {
    throw unauthorized('The grader token encoding is invalid.');
  }
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = await hmac(unsigned, secret);
  if (!constantTimeEqual(expected, actual)) {
    throw unauthorized('The grader token signature is invalid.');
  }
  try {
    const header = JSON.parse(new TextDecoder().decode(headerBytes)) as unknown;
    if (!matchesTokenHeader(header)) throw unauthorized('The grader token header is invalid.');
    return JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown;
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw unauthorized('The grader token payload is invalid.');
  }
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function matchesTokenHeader(value: unknown): boolean {
  const header = asRecord(value);
  return (
    header?.alg === TOKEN_HEADER.alg &&
    header.typ === TOKEN_HEADER.typ &&
    hasExactKeys(header, ['alg', 'typ'])
  );
}

function isActivationClaims(value: unknown): value is ActivationClaims {
  const claims = asRecord(value);
  return (
    claims?.version === TOKEN_VERSION &&
    claims.kind === 'activation' &&
    claims.issuer === ACTIVATION_ISSUER &&
    claims.audience === ACTIVATION_AUDIENCE &&
    isBoundedIdentifier(claims.tokenIdentifier) &&
    isAuditIdentifier(claims.auditIdentifier) &&
    isAttemptLimit(claims.attemptLimit) &&
    isEmail(claims.email) &&
    claims.emailVerified === true &&
    isActivationEntitlement(claims.entitlement) &&
    isBoundedStatusCallbackUrl(claims.statusCallbackUrl) &&
    Number.isSafeInteger(claims.issuedAt) &&
    Number.isSafeInteger(claims.expiresAt) &&
    hasExactKeys(claims, [
      'version',
      'kind',
      'issuer',
      'audience',
      'tokenIdentifier',
      'auditIdentifier',
      'attemptLimit',
      'email',
      'emailVerified',
      'entitlement',
      'statusCallbackUrl',
      'issuedAt',
      'expiresAt',
    ])
  );
}

function isActivationEntitlement(value: unknown): boolean {
  const entitlement = asRecord(value);
  return (
    (entitlement?.type === 'limespot-staff-multi-store' && hasExactKeys(entitlement, ['type'])) ||
    (entitlement?.type === 'store-origin' &&
      typeof entitlement.storeOrigin === 'string' &&
      hasExactKeys(entitlement, ['type', 'storeOrigin']))
  );
}

function assertActivationEntitlement(claims: ActivationClaims, requestedOrigin: string): void {
  if (claims.entitlement.type === 'limespot-staff-multi-store') {
    if (!isLimeSpotStaffEmail(claims.email) || claims.attemptLimit !== null) {
      throw unauthorized('The activation token staff entitlement is invalid.');
    }
    return;
  }
  if (claims.attemptLimit !== 2) {
    throw unauthorized('The activation token public attempt limit is invalid.');
  }
  let entitledOrigin: string;
  try {
    entitledOrigin = new URL(claims.entitlement.storeOrigin).origin;
  } catch {
    throw unauthorized('The activation token store entitlement is invalid.');
  }
  if (entitledOrigin !== claims.entitlement.storeOrigin || entitledOrigin !== requestedOrigin) {
    throw forbidden('The activation token is not entitled for this storefront origin.');
  }
}

function isEmail(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 3 && value.length <= 320 && value.includes('@')
  );
}

function isLimeSpotStaffEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    normalized === email &&
    normalized.length > '@limespot.com'.length &&
    normalized.endsWith('@limespot.com')
  );
}

function isAuditSessionClaims(value: unknown): value is AuditSessionClaims {
  const claims = asRecord(value);
  return (
    claims?.version === TOKEN_VERSION &&
    claims.kind === 'audit-session' &&
    claims.issuer === AUDIT_ISSUER &&
    claims.audience === AUDIT_AUDIENCE &&
    isBoundedIdentifier(claims.sessionIdentifier) &&
    isAuditIdentifier(claims.auditIdentifier) &&
    isAttemptLimit(claims.attemptLimit) &&
    typeof claims.storeOrigin === 'string' &&
    Number.isSafeInteger(claims.issuedAt) &&
    Number.isSafeInteger(claims.expiresAt) &&
    hasExactKeys(claims, [
      'version',
      'kind',
      'issuer',
      'audience',
      'sessionIdentifier',
      'auditIdentifier',
      'attemptLimit',
      'storeOrigin',
      'issuedAt',
      'expiresAt',
    ])
  );
}

function isAuditIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isAttemptLimit(value: unknown): value is 2 | null {
  return value === 2 || value === null;
}

function validateAuditMessage(value: unknown): string[] {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.messages) || body.messages.length !== 1) {
    throw invalidArgument('A grader inference must contain exactly one user message.');
  }
  const message = asRecord(body.messages[0]);
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) {
    throw invalidArgument('A grader inference must contain exactly one structured user message.');
  }
  const fileIdentifiers: string[] = [];
  for (const rawBlock of message.content) {
    const block = asRecord(rawBlock);
    if (!block || (block.type !== 'text' && block.type !== 'image' && block.type !== 'document')) {
      throw forbidden('Audit inference content may contain only text and owned file blocks.');
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalidArgument('A text block must contain text.');
      continue;
    }
    const source = asRecord(block.source);
    if (source?.type !== 'file' || !isBoundedFileReference(source.file_id)) {
      throw forbidden('Audit image and document blocks must reference an uploaded file.');
    }
    fileIdentifiers.push(source.file_id);
  }
  return [...new Set(fileIdentifiers)];
}

function resolveStatusCallbackUrl(claimed: string, env: Env): string {
  let url: URL;
  try {
    url = new URL(claimed);
  } catch {
    throw unauthorized('The activation token status callback URL is invalid.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw unauthorized('The activation token status callback URL is invalid.');
  }
  if (!auditStatusOrigins(env).includes(url.origin)) {
    throw unauthorized('The activation token status callback origin is not permitted.');
  }
  return url.toString();
}

function normalizeStoreOrigin(storeUrl: string): string {
  let url: URL;
  try {
    url = new URL(storeUrl);
  } catch {
    throw invalidArgument('The store URL is invalid.');
  }
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
    url.username ||
    url.password
  ) {
    throw invalidArgument('The store URL must be an HTTPS storefront origin.');
  }
  return url.origin;
}

function assertRequestStoreOrigin(request: Request, storeOrigin: string): void {
  const claimedOrigin = request.headers.get('X-LimeSpot-Audit-Store-Origin');
  if (claimedOrigin !== storeOrigin) {
    throw forbidden('The grader request does not match its activated storefront origin.');
  }
}

function assertTemporalClaims(issuedAt: number, expiresAt: number): void {
  const now = epochSeconds();
  if (issuedAt > now || expiresAt <= issuedAt || expiresAt <= now) {
    throw unauthorized('The grader token or session timing is invalid.');
  }
}

async function opaqueSessionIdentifier(tokenIdentifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenIdentifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

function isBoundedStatusCallbackUrl(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_STATUS_CALLBACK_URL_LENGTH
  );
}

function isBoundedFileReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FILE_REFERENCE_LENGTH;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function encodeJson(value: object): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid base64url.');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function unauthorized(message: string): WorkerError {
  return new WorkerError(message, { status: 401, exceptionType: 'AuditAuthorizationException' });
}

function forbidden(message: string): WorkerError {
  return new WorkerError(message, { status: 403, exceptionType: 'AuditScopeException' });
}

function invalidArgument(message: string): WorkerError {
  return new WorkerError(message, { status: 400, exceptionType: 'ArgumentException' });
}

function quotaExceeded(message: string): WorkerError {
  return new WorkerError(message, { status: 429, exceptionType: 'AuditQuotaException' });
}
