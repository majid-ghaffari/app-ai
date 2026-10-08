/**
 * Scoped authorization for extension-driven Studio audits.
 *
 * A website-issued, email-verified activation JWT is exchanged once for an
 * app-ai-signed session that lasts `AUDIT_SESSION_TTL_SECONDS`. The session is
 * origin-bound and can call only the onboarding proposal upload/inference
 * surface, under plan version 2 the Grader chat, and the read-only session
 * status. Strongly consistent reservations and owned file identifiers live in
 * AuditSessionAuthority.
 */

import {
  auditActivationSigningSecret,
  auditStatusOrigins,
  auditStatusSigningSecret,
  auditMaxMessageBytes,
  auditMaxUploadBytes,
  auditSessionSigningSecret,
  auditSessionTtlSeconds,
  graderChatEnabled,
  graderChatMaxInputCharacters,
  graderExtensionBuiltAfter,
  graderRunsValidFrom,
  parseUtcInstant,
  type Env,
} from '../config';
import {
  createAuditAuthoritySession,
  finalizeAuditAuthorityRequest,
  readAuditAuthoritySession,
  reserveAuditAuthorityRequest,
  type AuditAuthorityReservation,
} from './audit-session-authority';
import {
  AUDIT_PLAN_VERSION_HEADER,
  GRADER_CHAT_MESSAGE_CEILING,
  PROPOSAL_PAGE_VOCABULARY,
  declaredAuditPlanVersion,
  graderChatMessageAllowance,
  isSupportedAuditPlanVersion,
  planIncludesGraderChat,
} from './audit-plan';
import { auditCaptureFiles, type AuditCaptureFile } from './audit-capture-files';
import { graderChatRefusal } from './grader-chat-quota';
import type { PromptName } from '../prompt-registry';
import { WorkerError } from './responses';
import { isSameStoreOrigin } from './store-origin';
import { readKeepAliveOptIn, type KeepAlive } from './keep-alive-response';
import { jsonBodyValue, readBodyBytesWithin, type JsonBody } from './request-body';
import {
  isUsableProposal,
  readProposalManifest,
  type ProposalManifestPage,
} from './audit-proposal';

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

/** The registered prompt a scoped audit session's sales chat selects on `POST /messages`. */
export const GRADER_CHAT_PROMPT = 'grader-chat' satisfies PromptName;

/** The header an extension names its build time in, as an ISO-8601 UTC instant. */
export const EXTENSION_BUILT_AT_HEADER = 'X-LimeSpot-Extension-Built-At';

const GRADER_REPORT_PLATFORMS = ['shopify', 'shopline', 'bigcommerce'] as const;
const GRADER_REPORT_PAGE_STATES = [
  'read',
  'nothing-to-add',
  'needs-another-pass',
  'evidence-lost',
  'not-read',
  'not-sampled',
] as const;
const GRADER_REPORT_FINDINGS_PER_PAGE = 12;
const GRADER_REPORT_SUGGESTIONS = 10;
const GRADER_REPORT_LABEL_CHARACTERS = 80;
const GRADER_REPORT_FIX_CHARACTERS = 240;
const GRADER_REPORT_REASON_CHARACTERS = 400;
const GRADER_CHAT_TURNS = 2 * GRADER_CHAT_MESSAGE_CEILING + 1;
const GRADER_CHAT_MESSAGE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

/** Verified, reserved audit upload or proposal inference threaded through the router. */
export interface AuditAuthorization {
  readonly kind: 'proposal-transport';
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  readonly reservation: AuditAuthorityReservation;
  /** Epoch milliseconds the request was admitted at; its inference deadline counts from here. */
  readonly admittedAt: number;
  /** The proposal prompt an inference reservation was admitted for; absent on uploads. */
  readonly prompt?: string;
  /** The pages the inference asked the model to plan, read from its page manifest. */
  readonly proposalManifest?: readonly ProposalManifestPage[];
  /** An inference's JSON body, read once within the size limit and without its keep-alive opt-in. */
  readonly messageBody?: JsonBody;
  /** The keep-alive answer an inference opted in to, read once its body passed the size limit. */
  readonly keepAlive: KeepAlive | null;
}

/** What a session's Grader chat offers, so the extension and lib can show the text box and count. */
export interface GraderChatSessionTerms {
  readonly enabled: boolean;
  /** Messages the audit is answered across all of its runs and sessions; zero when not offered. */
  readonly perAudit: number;
  /** Messages still left, after those earlier sessions of the audit were answered; zero when not offered. */
  readonly remainingInAudit: number;
  /** Characters one message may carry; zero when chat is not offered. */
  readonly maxInputCharacters: number;
  /** Epoch milliseconds the session, and with it the chat, ends. */
  readonly sessionExpiresAt: number;
}

/** Successful activation exchange returned to the extension background worker. */
export interface AuditSessionExchange {
  readonly sessionIdentifier: string;
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly graderChat: GraderChatSessionTerms;
  /**
   * ISO-8601 UTC instant before which a Grader run no longer counts, from `GRADER_RUNS_VALID_FROM`:
   * a client drops a run it cached that completed before it.
   */
  readonly runsValidFrom: string;
  /**
   * ISO-8601 UTC instant an extension build must postdate, from `GRADER_EXTENSION_BUILT_AFTER`, so
   * the extension can warn before a refusal.
   */
  readonly extensionBuiltAfter: string;
}

/** A live Grader session's standing, answered by `GET /audit/session` without spending anything. */
export interface AuditSessionStatus {
  readonly sessionIdentifier: string;
  readonly expiresAt: number;
  readonly graderChat: GraderChatSessionTerms;
  readonly runsValidFrom: string;
  readonly extensionBuiltAfter: string;
}

/** One text turn of a Grader chat conversation, in the shape a transcript store would receive. */
export interface GraderChatTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** One gap the Grader found on a page: lib-written label and fix, and the model's own reason. */
export interface GraderReportFinding {
  readonly label: string;
  readonly fix: string;
  readonly reason?: string;
}

/** One page row of a Grader report. */
export interface GraderReportPage {
  readonly page: (typeof PROPOSAL_PAGE_VOCABULARY)[number];
  readonly state: (typeof GRADER_REPORT_PAGE_STATES)[number];
  readonly desktopCovered: boolean;
  readonly mobileCovered: boolean;
  readonly findings: readonly GraderReportFinding[];
}

/** One store-wide audience or offer the Grader suggested: a model-written title and reason. */
export interface GraderReportSuggestion {
  readonly title: string;
  readonly reason?: string;
}

/** The strictly validated Grader report a chat request carries. */
export interface GraderReport {
  readonly platform: (typeof GRADER_REPORT_PLATFORMS)[number];
  readonly partial: boolean;
  readonly pages: readonly GraderReportPage[];
  readonly audiences: readonly GraderReportSuggestion[];
  readonly offers: readonly GraderReportSuggestion[];
}

/** A validated Grader chat request body. */
export interface GraderChatConversation {
  /** The caller's identifier for this turn, lowercased: a UUID v4, the same on every retry of it. */
  readonly messageId: string;
  readonly turns: readonly GraderChatTurn[];
  readonly report: GraderReport;
}

/** A verified audit session's Grader chat request, admitted for validation but not yet reserved. */
export interface GraderChatAuthorization {
  readonly kind: 'grader-chat';
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  /** Epoch seconds the session was issued. */
  readonly issuedAt: number;
  /** Epoch seconds the session ends. */
  readonly expiresAt: number;
  /** Epoch milliseconds the request was admitted at; its inference deadline counts from here. */
  readonly admittedAt: number;
  readonly conversation: GraderChatConversation;
  /** The transcript fingerprint of every assistant turn, each to be matched to a stored reply. */
  readonly historyFingerprints: readonly string[];
  /** The fingerprint of the whole transcript, which the message identifier is bound to. */
  readonly transcriptFingerprint: string;
  /** The keep-alive answer the message opted in to, read once its body passed the size limit. */
  readonly keepAlive: KeepAlive | null;
}

/** Exchange one verified activation token for a scoped audit session. */
export async function exchangeAuditActivation(
  activationToken: string,
  storeUrl: string,
  planVersion: number,
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
  const requestedOrigin = normalizeStoreOrigin(storeUrl);
  assertActivationEntitlement(activation, requestedOrigin);
  const storeOrigin =
    activation.entitlement.type === 'store-origin'
      ? activation.entitlement.storeOrigin
      : requestedOrigin;
  const statusCallbackUrl = resolveStatusCallbackUrl(activation.statusCallbackUrl, env);
  const sessionSigningSecret = auditSessionSigningSecret(env);
  auditStatusSigningSecret(env);
  const now = epochSeconds();
  const expiresAt = now + auditSessionTtlSeconds(env);
  const cutoffs = graderCutoffs(env);
  assertRunOpensAfterCutoff(env, now * 1000);
  const chatOffer = graderChatOffer(planVersion, env);
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
  const chatMessages = await createAuditAuthoritySession(
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
    graderChat: graderChatSessionTerms(chatOffer, chatMessages, expiresAt * 1000),
    ...cutoffs,
  };
}

/**
 * Read a live Grader session's standing without spending anything: no reservation, attempt,
 * counter or model call. Refuses as an audit request would: an expired or superseded session 401
 * `audit_session_expired`, a revoked run 410 `grader_run_revoked`, an outdated extension build 409
 * `extension_update_required`.
 */
export async function readAuditSessionStatus(
  request: Request,
  env: Env,
): Promise<AuditSessionStatus> {
  const claims = await verifiedAuditClaims(request, env);
  if (!claims) throw unauthorized('A grader session token is required.');
  const cutoffs = graderCutoffs(env);
  const chatOffer = graderChatOffer(
    declaredAuditPlanVersion(request.headers.get(AUDIT_PLAN_VERSION_HEADER)),
    env,
  );
  const chatMessages = await readAuditAuthoritySession(
    {
      auditIdentifier: claims.auditIdentifier,
      sessionIdentifier: claims.sessionIdentifier,
      storeOrigin: claims.storeOrigin,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    },
    env,
  );
  return {
    sessionIdentifier: claims.sessionIdentifier,
    expiresAt: claims.expiresAt * 1000,
    graderChat: graderChatSessionTerms(chatOffer, chatMessages, claims.expiresAt * 1000),
    ...cutoffs,
  };
}

function graderCutoffs(env: Env): {
  readonly runsValidFrom: string;
  readonly extensionBuiltAfter: string;
} {
  return {
    runsValidFrom: new Date(graderRunsValidFrom(env)).toISOString(),
    extensionBuiltAfter: new Date(graderExtensionBuiltAfter(env)).toISOString(),
  };
}

function assertRunOpensAfterCutoff(env: Env, openedAt: number): void {
  if (graderRunsValidFrom(env) > openedAt) throw graderChatRefusal('grader_run_revoked');
}

type GraderChatOffer =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly perAudit: number; readonly maxInputCharacters: number };

function graderChatOffer(planVersion: number, env: Env): GraderChatOffer {
  if (!planIncludesGraderChat(planVersion) || !graderChatEnabled(env)) return { enabled: false };
  return {
    enabled: true,
    perAudit: graderChatMessageAllowance(env),
    maxInputCharacters: graderChatMaxInputCharacters(env),
  };
}

function graderChatSessionTerms(
  offer: GraderChatOffer,
  chatMessages: number,
  sessionExpiresAt: number,
): GraderChatSessionTerms {
  if (!offer.enabled) {
    return {
      enabled: false,
      perAudit: 0,
      remainingInAudit: 0,
      maxInputCharacters: 0,
      sessionExpiresAt,
    };
  }
  return {
    enabled: true,
    perAudit: offer.perAudit,
    remainingInAudit: Math.max(0, offer.perAudit - chatMessages),
    maxInputCharacters: offer.maxInputCharacters,
    sessionExpiresAt,
  };
}

/**
 * Authenticate one audit request. An upload or proposal inference is atomically reserved here; a
 * Grader chat message is validated and returned for its handler to reserve and finalize.
 */
export async function authorizeAuditRequest(
  request: Request,
  env: Env,
): Promise<AuditAuthorization | GraderChatAuthorization | null> {
  const claims = await verifiedAuditClaims(request, env);
  if (!claims) return null;

  const url = new URL(request.url);
  if (request.method !== 'POST' || (url.pathname !== '/files' && url.pathname !== '/messages')) {
    throw forbidden('Audit sessions can access only proposal uploads and inference.');
  }
  if (
    url.pathname === '/messages' &&
    request.headers.get('X-Personalizer-System-Prompt') === GRADER_CHAT_PROMPT
  ) {
    return authorizeGraderChat(request, claims, env);
  }

  let kind: 'upload' | 'message';
  let proposalPrompt: string | undefined;
  let proposalManifest: readonly ProposalManifestPage[] | undefined;
  let uploadBytes = 0;
  let referencedFileIdentifiers: readonly string[] = [];
  let keepAlive: KeepAlive | null = null;
  let messageBody: JsonBody | undefined;
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
    const selector = request.headers.get('X-Personalizer-System-Prompt');
    if (!selector || !ALLOWED_AUDIT_INFERENCE_PROMPTS.has(selector)) {
      throw forbidden('This system prompt is not available to grader sessions.');
    }
    proposalPrompt = selector;
    const bytes = await readBodyBytesWithin(request, auditMaxMessageBytes(env));
    if (!bytes) {
      throw quotaExceeded('The grader inference request is larger than the allowed size.');
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw invalidArgument('The grader inference request body must be valid JSON.');
    }
    const optIn = readKeepAliveOptIn({ value: body }, env);
    keepAlive = optIn.keepAlive;
    messageBody = optIn.body;
    const message = validateAuditMessage(jsonBodyValue(optIn.body));
    referencedFileIdentifiers = message.fileIdentifiers;
    proposalManifest = readProposalManifest(message.texts);
  }

  const admittedAt = Date.now();
  const reservation = await reserveAuditAuthorityRequest(
    {
      sessionIdentifier: claims.sessionIdentifier,
      auditIdentifier: claims.auditIdentifier,
      storeOrigin: claims.storeOrigin,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      kind,
      uploadBytes,
      referencedFileIdentifiers,
    },
    env,
  );
  return {
    kind: 'proposal-transport',
    sessionIdentifier: claims.sessionIdentifier,
    storeOrigin: claims.storeOrigin,
    reservation,
    admittedAt,
    ...(proposalPrompt === undefined ? {} : { prompt: proposalPrompt }),
    ...(proposalManifest === undefined ? {} : { proposalManifest }),
    ...(messageBody === undefined ? {} : { messageBody }),
    keepAlive,
  };
}

/**
 * The verified claims of a request's `ls_audit_` bearer, or `null` when it carries none: signature,
 * expiry, the store-origin header, the extension build and the plan version are checked here.
 */
async function verifiedAuditClaims(request: Request, env: Env): Promise<AuditSessionClaims | null> {
  const authorizationHeader = request.headers.get('Authorization');
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer (\S+)$/);
  if (!match?.[1]?.startsWith(AUDIT_TOKEN_PREFIX)) return null;

  const claims = await verifyToken(
    match[1].slice(AUDIT_TOKEN_PREFIX.length),
    auditSessionSigningSecret(env),
  );
  if (!isAuditSessionClaims(claims)) throw unauthorized('The grader session token is invalid.');
  if (claims.expiresAt <= epochSeconds()) throw graderChatRefusal('audit_session_expired');
  assertTemporalClaims(claims.issuedAt, claims.expiresAt);
  assertRequestStoreOrigin(request, claims.storeOrigin);
  assertCompatibleAuditClient(request, env);
  return claims;
}

async function authorizeGraderChat(
  request: Request,
  claims: AuditSessionClaims,
  env: Env,
): Promise<GraderChatAuthorization> {
  if (!graderChatEnabled(env)) throw graderChatRefusal('grader_chat_disabled');
  const planVersion = declaredAuditPlanVersion(request.headers.get(AUDIT_PLAN_VERSION_HEADER));
  if (!planIncludesGraderChat(planVersion)) throw graderChatRefusal('grader_chat_not_in_plan');
  const bytes = await readBodyBytesWithin(request, auditMaxMessageBytes(env));
  if (!bytes) {
    throw graderChatRefusal('grader_chat_input_too_long');
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw invalidArgument('The grader chat request body must be valid JSON.');
  }
  const { body: chatBody, keepAlive } = readKeepAliveOptIn({ value: body }, env);
  const conversation = validateGraderChatBody(
    jsonBodyValue(chatBody),
    graderChatMaxInputCharacters(env),
  );
  return {
    kind: 'grader-chat',
    auditIdentifier: claims.auditIdentifier,
    sessionIdentifier: claims.sessionIdentifier,
    storeOrigin: claims.storeOrigin,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    admittedAt: Date.now(),
    conversation,
    historyFingerprints: await graderChatHistoryFingerprints(conversation.turns),
    transcriptFingerprint: await transcriptFingerprint(conversation.turns),
    keepAlive,
  };
}

/**
 * Validate a Grader chat request body: exactly `messageId`, `messages` and `graderReport`. The
 * message identifier is a UUID v4 the caller mints per visitor turn and keeps across retries of it.
 * The messages are text-only turns that alternate from the visitor's first message to their newest
 * one, each of the visitor's within `maxInputCharacters`; the report is the strict, capped Grader
 * report shape.
 */
export function validateGraderChatBody(
  value: unknown,
  maxInputCharacters: number,
): GraderChatConversation {
  const body = asRecord(value);
  if (!body || !hasExactKeys(body, ['messageId', 'messages', 'graderReport'])) {
    throw invalidArgument(
      'A grader chat request carries exactly messageId, messages and graderReport.',
    );
  }
  if (typeof body.messageId !== 'string' || !GRADER_CHAT_MESSAGE_ID.test(body.messageId)) {
    throw invalidArgument('A grader chat messageId is a UUID v4.');
  }
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > GRADER_CHAT_TURNS ||
    body.messages.length % 2 === 0
  ) {
    throw invalidArgument(
      'Grader chat messages alternate from the visitor and end with the visitor.',
    );
  }
  const turns = body.messages.map((raw: unknown, index): GraderChatTurn => {
    const turn = asRecord(raw);
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (
      !turn ||
      !hasExactKeys(turn, ['role', 'content']) ||
      turn.role !== role ||
      typeof turn.content !== 'string' ||
      turn.content.trim().length === 0
    ) {
      throw invalidArgument(
        'Grader chat messages alternate from the visitor and end with the visitor, each one non-empty text.',
      );
    }
    if (role === 'user' && characterCount(turn.content) > maxInputCharacters) {
      throw graderChatRefusal('grader_chat_input_too_long');
    }
    return { role, content: turn.content };
  });
  return {
    messageId: body.messageId.toLowerCase(),
    turns,
    report: validateGraderReport(body.graderReport),
  };
}

function validateGraderReport(value: unknown): GraderReport {
  const report = asRecord(value);
  if (
    !report ||
    !hasExactKeys(report, ['platform', 'partial', 'pages', 'audiences', 'offers']) ||
    !isOneOf(report.platform, GRADER_REPORT_PLATFORMS) ||
    typeof report.partial !== 'boolean' ||
    !Array.isArray(report.pages) ||
    report.pages.length > PROPOSAL_PAGE_VOCABULARY.length
  ) {
    throw invalidReport();
  }
  const pages = report.pages.map(validateReportPage);
  if (new Set(pages.map((page) => page.page)).size !== pages.length) throw invalidReport();
  return {
    platform: report.platform,
    partial: report.partial,
    pages,
    audiences: validateSuggestions(report.audiences),
    offers: validateSuggestions(report.offers),
  };
}

function validateReportPage(value: unknown): GraderReportPage {
  const page = asRecord(value);
  if (
    !page ||
    !hasExactKeys(page, ['page', 'state', 'desktopCovered', 'mobileCovered', 'findings']) ||
    !isOneOf(page.page, PROPOSAL_PAGE_VOCABULARY) ||
    !isOneOf(page.state, GRADER_REPORT_PAGE_STATES) ||
    typeof page.desktopCovered !== 'boolean' ||
    typeof page.mobileCovered !== 'boolean' ||
    !Array.isArray(page.findings) ||
    page.findings.length > GRADER_REPORT_FINDINGS_PER_PAGE
  ) {
    throw invalidReport();
  }
  return {
    page: page.page,
    state: page.state,
    desktopCovered: page.desktopCovered,
    mobileCovered: page.mobileCovered,
    findings: page.findings.map((raw: unknown): GraderReportFinding => {
      const finding = asRecord(raw);
      if (
        !finding ||
        !hasAllowedKeys(finding, ['label', 'fix'], ['reason']) ||
        !isReportText(finding.label, GRADER_REPORT_LABEL_CHARACTERS) ||
        !isReportText(finding.fix, GRADER_REPORT_FIX_CHARACTERS) ||
        (finding.reason !== undefined &&
          !isReportText(finding.reason, GRADER_REPORT_REASON_CHARACTERS))
      ) {
        throw invalidReport();
      }
      return {
        label: finding.label,
        fix: finding.fix,
        ...(finding.reason === undefined ? {} : { reason: finding.reason }),
      };
    }),
  };
}

function validateSuggestions(value: unknown): readonly GraderReportSuggestion[] {
  if (!Array.isArray(value) || value.length > GRADER_REPORT_SUGGESTIONS) throw invalidReport();
  return value.map((raw: unknown): GraderReportSuggestion => {
    const suggestion = asRecord(raw);
    if (
      !suggestion ||
      !hasAllowedKeys(suggestion, ['title'], ['reason']) ||
      !isReportText(suggestion.title, GRADER_REPORT_LABEL_CHARACTERS) ||
      (suggestion.reason !== undefined &&
        !isReportText(suggestion.reason, GRADER_REPORT_REASON_CHARACTERS))
    ) {
      throw invalidReport();
    }
    return {
      title: suggestion.title,
      ...(suggestion.reason === undefined ? {} : { reason: suggestion.reason }),
    };
  });
}

/** The transcript fingerprint of each assistant turn: a digest of the conversation through it. */
export async function graderChatHistoryFingerprints(
  turns: readonly GraderChatTurn[],
): Promise<string[]> {
  const fingerprints: string[] = [];
  for (let index = 1; index < turns.length; index += 2) {
    fingerprints.push(await transcriptFingerprint(turns.slice(0, index + 1)));
  }
  return fingerprints;
}

/** The transcript fingerprint a reply app-ai produced is stored under. */
export async function graderChatReplyFingerprint(
  turns: readonly GraderChatTurn[],
  reply: string,
): Promise<string> {
  return transcriptFingerprint([...turns, { role: 'assistant', content: reply }]);
}

async function transcriptFingerprint(turns: readonly GraderChatTurn[]): Promise<string> {
  const transcript = JSON.stringify(turns.map((turn) => [turn.role, turn.content]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transcript));
  return base64UrlEncode(new Uint8Array(digest));
}

function isReportText(value: unknown, maxCharacters: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    characterCount(value) <= maxCharacters &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined) continue;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

function characterCount(value: string): number {
  return [...value].length;
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === 'string' && values.includes(value);
}

function hasAllowedKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return (
    required.every((key) => key in record) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function invalidReport(): WorkerError {
  return invalidArgument('The grader chat report does not match the grader report contract.');
}

/** Commit successful audit usage or release its atomic reservation after failure. */
export async function finalizeAuditUsage(
  authorization: AuditAuthorization,
  response: Response,
  env: Env,
): Promise<void> {
  let fileIdentifier: string | undefined;
  let captures: readonly AuditCaptureFile[] = [];
  if (response.ok && authorization.reservation.kind === 'upload') {
    const result = (await response.clone().json()) as { id?: unknown; references?: unknown };
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
    try {
      captures = await auditCaptureFiles(
        [result.id, ...referenceIdentifiers(result.references)],
        authorization.sessionIdentifier,
        env,
      );
    } catch (error) {
      await releaseAuditUsage(authorization, env);
      throw error;
    }
  }
  const completed =
    response.ok &&
    authorization.reservation.kind === 'message' &&
    authorization.prompt !== undefined &&
    isUsableProposal(
      authorization.prompt,
      await readJsonBody(response),
      authorization.proposalManifest ?? [],
    );
  await finalizeAuditAuthorityRequest(
    authorization.reservation,
    authorization.storeOrigin,
    response.ok,
    fileIdentifier,
    env,
    { completed, captures },
  );
}

function referenceIdentifiers(references: unknown): string[] {
  if (!references || typeof references !== 'object') return [];
  return Object.values(references).flatMap((reference: unknown) =>
    reference &&
    typeof reference === 'object' &&
    'id' in reference &&
    typeof reference.id === 'string'
      ? [reference.id]
      : [],
  );
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return (await response.clone().json()) as unknown;
  } catch {
    return undefined;
  }
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
  if (
    entitledOrigin !== claims.entitlement.storeOrigin ||
    !isSameStoreOrigin(entitledOrigin, requestedOrigin)
  ) {
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

function validateAuditMessage(value: unknown): {
  fileIdentifiers: string[];
  texts: string[];
} {
  const body = asRecord(value);
  if (!body || !Array.isArray(body.messages) || body.messages.length !== 1) {
    throw invalidArgument('A grader inference must contain exactly one user message.');
  }
  const message = asRecord(body.messages[0]);
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) {
    throw invalidArgument('A grader inference must contain exactly one structured user message.');
  }
  const fileIdentifiers: string[] = [];
  const texts: string[] = [];
  for (const rawBlock of message.content) {
    const block = asRecord(rawBlock);
    if (!block || (block.type !== 'text' && block.type !== 'image' && block.type !== 'document')) {
      throw forbidden('Audit inference content may contain only text and owned file blocks.');
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw invalidArgument('A text block must contain text.');
      texts.push(block.text);
      continue;
    }
    const source = asRecord(block.source);
    if (source?.type !== 'file' || !isBoundedFileReference(source.file_id)) {
      throw forbidden('Audit image and document blocks must reference an uploaded file.');
    }
    fileIdentifiers.push(source.file_id);
  }
  return { fileIdentifiers: [...new Set(fileIdentifiers)], texts };
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

/**
 * Refuse a grader request its client cannot be served under. A build naming its build time is
 * refused 409 `extension_update_required` when made before `GRADER_EXTENSION_BUILT_AFTER`, and 400
 * when the time is malformed. A build naming none is not measured against that cutoff: it is held
 * to the plan version it declares, so one declaring none is refused 409
 * `audit_plan_version_unsupported` like one declaring a version this worker holds no allowance for.
 */
export function assertCompatibleAuditClient(request: Request, env: Env): void {
  const declaredBuild = request.headers.get(EXTENSION_BUILT_AT_HEADER);
  const declaredPlan = request.headers.get(AUDIT_PLAN_VERSION_HEADER);
  if (declaredBuild !== null) assertBuiltAfterCutoff(declaredBuild, env);
  if (declaredBuild === null && declaredPlan === null) throw unsupportedAuditPlan();
  if (!isSupportedAuditPlanVersion(declaredPlan)) throw unsupportedAuditPlan();
}

function assertBuiltAfterCutoff(declaredBuild: string, env: Env): void {
  const builtAt = parseUtcInstant(declaredBuild);
  if (builtAt === null) {
    throw invalidArgument(`${EXTENSION_BUILT_AT_HEADER} must be an ISO-8601 UTC timestamp.`);
  }
  if (builtAt >= graderExtensionBuiltAfter(env)) return;
  throw new WorkerError(
    'This version of the LimeSpot extension needs an update. Update it and try again.',
    {
      status: 409,
      exceptionType: 'ExtensionUpdateRequiredException',
      messageDetail: 'extension_update_required',
    },
  );
}

function unsupportedAuditPlan(): WorkerError {
  return new WorkerError(
    'This grader version is not supported. Update the LimeSpot extension and try again.',
    {
      status: 409,
      exceptionType: 'AuditPlanVersionException',
      messageDetail: 'audit_plan_version_unsupported',
    },
  );
}

function assertRequestStoreOrigin(request: Request, storeOrigin: string): void {
  const claimedOrigin = request.headers.get('X-LimeSpot-Audit-Store-Origin');
  if (claimedOrigin === null || !isSameStoreOrigin(claimedOrigin, storeOrigin)) {
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
