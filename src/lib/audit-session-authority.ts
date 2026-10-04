/**
 * Strongly consistent authority for extension-driven Studio audits.
 *
 * One Durable Object is addressed by the website-signed audit identifier. It
 * consumes activation identifiers once, keeps one active browser session that a newer activation
 * supersedes,
 * preserves the public completion count across reissued links, divides the
 * session into grader runs held to one plan-derived inference ceiling each,
 * lets the uploads of every attempt draw on one session allowance of that many
 * runs' planned uploads, owns each run's provider file identifiers, and durably retries ordered website status
 * callbacks to the destination the activation signed. It admits the audit's Grader chat messages
 * apart from all of that, and separately addressed instances host the chat's daily counters.
 */

import {
  auditMaxRuns,
  auditSessionAuthority,
  auditSessionTtlSeconds,
  graderRunsValidFrom,
  type Env,
} from '../config';
import {
  GRADER_CHAT_MESSAGE_CEILING,
  auditRunCeiling,
  graderChatAttemptAllowance,
  graderChatMessageAllowance,
} from './audit-plan';
import {
  INFERENCE_TIMEOUT_CODE,
  UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS,
} from '../inference/deadline';
import { base64UrlEncode } from '../inference/token-sealing';
import { deliverAuditStatusEvent, type AuditStatus, type AuditStatusEvent } from './audit-status';
import { createLoggingRuntime, type Logger } from './logger';
import { WorkerError } from './responses';
import { isSameStoreOrigin } from './store-origin';
import {
  reserveFreeVisualVerificationSlot,
  type FreeVisualVerificationQuotaClass,
} from './inference-quota-authority';
import {
  GRADER_CHAT_QUOTA_FINALIZE_PATH,
  GRADER_CHAT_QUOTA_RESERVE_PATH,
  dailyChatCounterAlarmAt,
  drainDailyChatAlerts,
  expireDailyChatCounter,
  finalizeDailyChatSlot,
  finalizeGraderChatQuota,
  graderChatRefusal,
  type GraderChatSettlementOutcome,
  isDailyChatFinalizeInput,
  isDailyChatReserveInput,
  reserveDailyChatSlot,
} from './grader-chat-quota';

const SESSION_STORAGE_KEY = 'session';
const CALLBACK_RETRY_MILLISECONDS = 60_000;
const SESSION_RECORD_BUDGET_BYTES = 1_000_000;
const RETAINED_ACTIVATION_IDENTIFIERS = 1_024;
const CHAT_COMMIT_ATTEMPTS = 3;
const CHAT_SETTLEMENT_HORIZON_MILLISECONDS = 86_400_000;
const CHAT_OUTCOME_KEY_PREFIX = 'chat-outcome:';

/**
 * How long past its inference deadline a reservation stays open, so a result the model returned
 * just before the deadline is finalized and counted before the alarm releases the reservation.
 */
export const RESERVATION_FINALIZE_GRACE_MILLISECONDS = 60_000;

const RESERVATION_LEASE_MILLISECONDS =
  UPSTREAM_INFERENCE_DEADLINE_MILLISECONDS + RESERVATION_FINALIZE_GRACE_MILLISECONDS;

type ReservationKind = 'upload' | 'message';

interface PendingReservation {
  readonly kind: ReservationKind;
  /**
   * The run this reservation was admitted to. Absent when it was admitted before the session was
   * divided into runs; it then counts toward, and lands in, whichever run is current.
   */
  readonly run?: number;
  readonly uploadBytes: number;
  readonly attemptNumber?: number;
  /**
   * The session that admitted this reservation, and when. A reservation stays open until the
   * upstream inference deadline plus the finalization grace has passed since admission, whatever
   * happens to the session that admitted it, so the paid work it guards is finalized and delivered.
   * Absent on reservations admitted before either was recorded; those are released when their
   * session expires.
   */
  readonly sessionIdentifier?: string;
  readonly admittedAt?: number;
  /**
   * The store origin of the session that admitted this reservation, which its status events name
   * even after a session for the store's other form replaces that one. A reservation an earlier
   * worker admitted without it takes the origin of the session it is carried out of.
   */
  readonly storeOrigin?: string;
}

/** When one run of one session opened and, once it did, completed, in epoch milliseconds. */
interface RunTimes {
  readonly sessionIdentifier: string;
  readonly run: number;
  readonly startedAt: number;
  readonly completedAt?: number;
}

/** The one Grader chat message an audit has in flight. */
interface ChatReservation {
  readonly reservationIdentifier: string;
  readonly messageId: string;
  readonly transcriptFingerprint: string;
  /** The visitor's daily counter the message is held on, beside the deployment's. */
  readonly visitorAuthority: string;
  /** The UTC day both daily holds were taken on. */
  readonly day: string;
  readonly admittedAt: number;
}

/** One answered chat message, keyed by the caller's message identifier. */
interface ChatAnsweredMessage {
  readonly messageId: string;
  readonly transcriptFingerprint: string;
  readonly reservationIdentifier: string;
  readonly answeredAt: number;
  /** When its stored outcome is deleted; absent once it has been. */
  readonly outcomeExpiresAt?: number;
}

/** A chat message whose visitor and deployment daily counters are still to be committed or released. */
interface ChatSettlement {
  readonly reservationIdentifier: string;
  readonly visitorAuthority: string;
  /** The UTC day its daily holds were taken on, whose entries it settles. */
  readonly day: string;
  /** Whether the message was answered, failed after the model was called, or released before it. */
  readonly outcome: GraderChatSettlementOutcome;
  readonly recordedAt: number;
  /** When the alarm next settles it; the request that recorded it settles it first. */
  readonly retryAt: number;
}

interface SessionRecord {
  readonly auditIdentifier: string;
  readonly attemptLimit: 2 | null;
  readonly storeOrigin: string;
  /** The website-signed, origin-allowlisted destination this audit's events are mirrored to. */
  readonly statusCallbackUrl: string;
  readonly completedAttempts: number;
  readonly consumedActivationIdentifiers: readonly string[];
  readonly sessionIdentifier: string;
  readonly expiresAt: number;
  /**
   * Whole-session totals of successful uploads, their bytes, and successful inference requests.
   * The upload total holds the session's upload allowance; worker versions without runs enforce
   * their limits from all three.
   */
  readonly uploadCount: number;
  readonly totalUploadBytes: number;
  readonly messageCount: number;
  /** The current grader run of this session, counted from 1. */
  readonly run: number;
  readonly runUploads: number;
  readonly runInferences: number;
  readonly runInferenceStarted: boolean;
  readonly runCompleted: boolean;
  /**
   * When a run opened and completed, named by its session and run number so times a worker that
   * keeps none carried onto another run are recognized as stale. Absent on a record such a worker
   * wrote.
   */
  readonly runTimes?: RunTimes;
  readonly fileIdentifiers: readonly string[];
  readonly pending: Readonly<Record<string, PendingReservation>>;
  readonly completedReservations: readonly string[];
  readonly abandonedReservations: readonly string[];
  readonly statusOutbox: readonly AuditStatusEvent[];
  /**
   * When the alarm next attempts the outbox head after a delivery that may succeed later. Absent
   * while the head has not failed, so a new event is delivered on the next alarm immediately.
   */
  readonly statusRetryAt?: number;
  /**
   * Grader chat messages this audit has been answered, across all of its runs and sessions: neither
   * a retry, an expiry, nor a reissued link restores one. Absent on a record written before the chat
   * existed, which has answered none.
   */
  readonly chatMessages?: number;
  /** The transcript fingerprint of every reply this audit's chat was given, in order. */
  readonly chatReplies?: readonly string[];
  /**
   * Chat messages this audit admitted, answered or not, less those released before any model call;
   * held to `graderChatAttemptAllowance`. Absent on a record written before it was kept.
   */
  readonly chatAttempts?: number;
  /** The chat message being answered now; chat traffic never enters `pending`. */
  readonly chatInFlight?: ChatReservation;
  /** Every answered chat message, so a replay is answered from its outcome and counted once. */
  readonly chatAnswered?: readonly ChatAnsweredMessage[];
  /** Chat messages whose daily counters the alarm settles until each succeeds. */
  readonly chatSettlements?: readonly ChatSettlement[];
}

const FRESH_RUN = {
  runUploads: 0,
  runInferences: 0,
  runInferenceStarted: false,
  runCompleted: false,
  fileIdentifiers: [],
} as const;

const NO_SESSION_TOTALS = {
  uploadCount: 0,
  totalUploadBytes: 0,
  messageCount: 0,
} as const;

interface ExchangeInput {
  readonly auditIdentifier: string;
  readonly activationIdentifier: string;
  readonly attemptLimit: 2 | null;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  readonly statusCallbackUrl: string;
  readonly expiresAt: number;
}

interface ReserveInput {
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  /** Epoch seconds the bearer was issued, the earliest any run of its session can have opened. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly reservationIdentifier: string;
  readonly kind: ReservationKind;
  readonly uploadBytes: number;
  readonly referencedFileIdentifiers: readonly string[];
}

interface FinalizeInput {
  readonly reservationIdentifier: string;
  readonly succeeded: boolean;
  readonly fileIdentifier?: string;
  readonly completed?: boolean;
}

interface ChatReserveInput {
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly reservationIdentifier: string;
  readonly messageId: string;
  readonly transcriptFingerprint: string;
  readonly visitorAuthority: string;
  readonly day: string;
  /** The transcript fingerprint of every assistant turn the request carries. */
  readonly historyFingerprints: readonly string[];
}

interface ChatCommitInput {
  readonly reservationIdentifier: string;
  readonly replyFingerprint?: string;
  readonly outcome: GraderChatOutcome;
}

interface ChatReservationInput {
  readonly reservationIdentifier: string;
}

interface ChatReleaseInput extends ChatReservationInput {
  readonly outcome: Exclude<GraderChatSettlementOutcome, 'answered'>;
}

interface FreeVisualVerificationReserveInput {
  readonly limit: number;
  readonly dailyLimit?: number;
  readonly acceptanceReserve?: number;
  readonly quotaClass?: FreeVisualVerificationQuotaClass;
}

/** The session a status read names, checked against the audit's record. */
export interface AuditAuthoritySessionReference {
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  /** Epoch seconds the bearer was issued. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Data required to create one atomic audit-session record. */
export interface AuditAuthorityExchange {
  readonly auditIdentifier: string;
  readonly activationIdentifier: string;
  readonly attemptLimit: 2 | null;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  /** The allowlisted destination every status event of this session is delivered to. */
  readonly statusCallbackUrl: string;
  readonly expiresAt: number;
}

/** Reservation returned before app-ai performs an upload or inference call. */
export interface AuditAuthorityReservation {
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly reservationIdentifier: string;
  readonly kind: ReservationKind;
}

/**
 * Atomically consume an activation and make its session the audit's one active session, superseding
 * any earlier one. Returns the Grader chat messages the audit has already been answered.
 */
export async function createAuditAuthoritySession(
  input: AuditAuthorityExchange,
  env: Env,
): Promise<number> {
  const response = await authorityStub(input.auditIdentifier, env).fetch(
    internalRequest(input.storeOrigin, '/exchange', input),
  );
  if (response.status === 409) {
    throw new WorkerError('The activation token has already been used.', {
      status: 409,
      exceptionType: 'AuditActivationConsumedException',
    });
  }
  if (response.status === 429) throw quotaError('This public grader has no attempts remaining.');
  if (response.status === 403) {
    throw new WorkerError('The grader identity does not match its existing authority.', {
      status: 403,
      exceptionType: 'AuditScopeException',
    });
  }
  assertAuthoritySuccess(response);
  const body = (await response.json()) as { chatMessages?: unknown };
  return typeof body.chatMessages === 'number' ? body.chatMessages : 0;
}

/**
 * Read the audit's record for a live session without writing anything, answering the chat messages
 * the audit has been answered. An expired or superseded session is refused `audit_session_expired`
 * and a revoked run `grader_run_revoked`.
 */
export async function readAuditAuthoritySession(
  input: AuditAuthoritySessionReference,
  env: Env,
): Promise<number> {
  const response = await authorityStub(input.auditIdentifier, env).fetch(
    internalRequest(input.storeOrigin, '/status', input),
  );
  if (response.status === 401) throw graderChatRefusal('audit_session_expired');
  if (response.status === 412) throw graderChatRefusal('grader_run_revoked');
  assertAuthoritySuccess(response);
  const body = (await response.json()) as { chatMessages?: unknown };
  return typeof body.chatMessages === 'number' ? body.chatMessages : 0;
}

/** Atomically reserve quota and validate file ownership before paid upstream work. */
export async function reserveAuditAuthorityRequest(
  input: Omit<ReserveInput, 'reservationIdentifier'>,
  env: Env,
): Promise<AuditAuthorityReservation> {
  const reservationIdentifier = crypto.randomUUID();
  const response = await authorityStub(input.auditIdentifier, env).fetch(
    internalRequest(input.storeOrigin, '/reserve', { ...input, reservationIdentifier }),
  );
  if (response.status === 401) throw graderChatRefusal('audit_session_expired');
  if (response.status === 412) throw graderChatRefusal('grader_run_revoked');
  if (response.status === 403) {
    throw new WorkerError('The inference request references a file outside this grader session.', {
      status: 403,
      exceptionType: 'AuditScopeException',
    });
  }
  if (response.status === 402) throw quotaError('This public grader has no attempts remaining.');
  if (response.status === 410) throw quotaError('This grader session has no retries remaining.');
  if (response.status === 429) throw quotaError('The grader run limit has been reached.');
  if (response.status === 503) {
    throw new WorkerError(
      'The grader is still delivering earlier status updates. Try again in a few minutes.',
      { status: 503, exceptionType: 'AuditSessionBacklogException' },
    );
  }
  assertAuthoritySuccess(response);
  return {
    auditIdentifier: input.auditIdentifier,
    sessionIdentifier: input.sessionIdentifier,
    reservationIdentifier,
    kind: input.kind,
  };
}

/**
 * Commit a successful paid operation or release its reservation after failure. `completed` says
 * whether an inference returned a usable proposal; only such an inference completes a public run.
 */
export async function finalizeAuditAuthorityRequest(
  authorization: AuditAuthorityReservation,
  storeOrigin: string,
  succeeded: boolean,
  fileIdentifier: string | undefined,
  env: Env,
  completed = false,
): Promise<void> {
  const input: FinalizeInput = {
    reservationIdentifier: authorization.reservationIdentifier,
    succeeded,
    ...(fileIdentifier === undefined ? {} : { fileIdentifier }),
    ...(completed ? { completed } : {}),
  };
  const response = await authorityStub(authorization.auditIdentifier, env).fetch(
    internalRequest(storeOrigin, '/finalize', input),
  );
  assertAuthoritySuccess(response);
}

/** A chat message the session authority admitted, held until it is finalized. */
export interface GraderChatReservation {
  readonly auditIdentifier: string;
  readonly storeOrigin: string;
  readonly reservationIdentifier: string;
}

/** The completed outcome of one chat message, stored so a replay of it returns the same reply. */
export interface GraderChatOutcome {
  /** The `/messages` envelope the visitor receives; its content is empty when the reply was withheld. */
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly bookletVersion: number;
  readonly withheld: boolean;
}

/** The message to admit: its session, its caller-stable identity, and where it is held. */
export interface GraderChatMessageInput {
  readonly auditIdentifier: string;
  readonly sessionIdentifier: string;
  readonly storeOrigin: string;
  /** Epoch seconds the bearer was issued. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** The caller's identifier for this turn, the same on every retry of it. */
  readonly messageId: string;
  /** A digest of the request's whole transcript, which the message identifier is bound to. */
  readonly transcriptFingerprint: string;
  readonly visitorAuthority: string;
  /** The UTC day the request captured, which named the visitor's counter and dates both holds. */
  readonly day: string;
  /** The transcript fingerprint of every assistant turn the request carries. */
  readonly historyFingerprints: readonly string[];
}

/**
 * How the session authority took a chat message: admitted and held for a new answer, or a replay of
 * a message the audit already answered, with its stored outcome and the audit's count now.
 */
export type GraderChatAdmission =
  | { readonly kind: 'admitted'; readonly reservation: GraderChatReservation }
  | {
      readonly kind: 'replayed';
      readonly outcome: GraderChatOutcome;
      readonly chatMessages: number;
    };

/**
 * Admit one Grader chat message. A message identifier the audit already answered, with the same
 * transcript, is a replay: its stored outcome comes back, with no reservation and no charge. Any
 * other message is admitted when the session is live, its current run completed, no other message
 * of the audit is in flight, the audit's allowance is not spent, and every assistant turn it
 * carries is a reply this audit was given. Chat holds no audit reservation, attempt, run
 * inference, or status event.
 */
export async function reserveGraderChatMessage(
  input: GraderChatMessageInput,
  env: Env,
): Promise<GraderChatAdmission> {
  const reservationIdentifier = crypto.randomUUID();
  const body: ChatReserveInput = { ...input, reservationIdentifier };
  const response = await authorityStub(input.auditIdentifier, env).fetch(
    internalRequest(input.storeOrigin, '/reserve-chat', body),
  );
  if (response.status === 400) throw graderChatRefusal('grader_chat_message_reused');
  if (response.status === 401) throw graderChatRefusal('audit_session_expired');
  if (response.status === 412) throw graderChatRefusal('grader_run_revoked');
  if (response.status === 403) throw graderChatRefusal('grader_chat_history_unverified');
  if (response.status === 402) throw graderChatRefusal('grader_chat_attempt_limit');
  if (response.status === 409) throw graderChatRefusal('grader_chat_busy');
  if (response.status === 423) throw graderChatRefusal('grader_chat_not_open');
  if (response.status === 424) throw graderChatRefusal('grader_chat_run_failed');
  if (response.status === 429) throw graderChatRefusal('grader_chat_audit_limit');
  if (response.status === 503) {
    throw new WorkerError(
      'The grader is still delivering earlier status updates. Try again in a few minutes.',
      { status: 503, exceptionType: 'AuditSessionBacklogException' },
    );
  }
  assertAuthoritySuccess(response);
  if (response.status === 200) {
    const replay = (await response.json()) as {
      outcome: GraderChatOutcome;
      chatMessages: number;
    };
    return { kind: 'replayed', outcome: replay.outcome, chatMessages: replay.chatMessages };
  }
  return {
    kind: 'admitted',
    reservation: {
      auditIdentifier: input.auditIdentifier,
      storeOrigin: input.storeOrigin,
      reservationIdentifier,
    },
  };
}

/** What app-ai records when a chat message was answered. */
export interface GraderChatAnswer {
  /** The transcript fingerprint of the reply the visitor receives; absent when it was withheld. */
  readonly replyFingerprint?: string;
  readonly outcome: GraderChatOutcome;
}

/**
 * Count an answered chat message, remember its reply, store its outcome under its message
 * identifier, and record its daily counters for settlement, in one transaction of the audit's
 * authority, whichever session of the audit is current now. It is keyed by the message's
 * reservation, so a retry after a lost answer counts it once, and it is retried before giving up.
 * A reservation whose lease lapsed has been released and is refused, without retrying, as a 504
 * `InferenceTimeoutException`. Returns the messages the audit has been answered, or `null` when
 * the audit holds no session record.
 */
export async function commitGraderChatMessage(
  reservation: GraderChatReservation,
  answer: GraderChatAnswer,
  env: Env,
): Promise<number | null> {
  const input: ChatCommitInput = {
    reservationIdentifier: reservation.reservationIdentifier,
    outcome: answer.outcome,
    ...(answer.replyFingerprint === undefined ? {} : { replyFingerprint: answer.replyFingerprint }),
  };
  let failure: unknown;
  for (let attempt = 0; attempt < CHAT_COMMIT_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await authorityStub(reservation.auditIdentifier, env).fetch(
        internalRequest(reservation.storeOrigin, '/commit-chat', input),
      );
    } catch (error) {
      failure = error;
      continue;
    }
    if (response.status === 410) {
      throw new WorkerError('The grader chat reply arrived after its time limit.', {
        status: 504,
        exceptionType: 'InferenceTimeoutException',
        messageDetail: INFERENCE_TIMEOUT_CODE,
      });
    }
    if (!response.ok) {
      failure = authorityFailure(response.status);
      continue;
    }
    if (response.status === 204) return null;
    const body = (await response.json()) as { chatMessages?: unknown };
    return typeof body.chatMessages === 'number' ? body.chatMessages : null;
  }
  throw failure;
}

/**
 * Release a chat message no reply was produced for, so the audit can send another, and record its
 * daily holds for settlement. `failed` means the model was called, so the message keeps its attempt;
 * `released` means it never was, so its attempt is refunded.
 */
export async function releaseGraderChatMessage(
  reservation: GraderChatReservation,
  outcome: ChatReleaseInput['outcome'],
  env: Env,
): Promise<void> {
  const input: ChatReleaseInput = {
    reservationIdentifier: reservation.reservationIdentifier,
    outcome,
  };
  const response = await authorityStub(reservation.auditIdentifier, env).fetch(
    internalRequest(reservation.storeOrigin, '/release-chat', input),
  );
  assertAuthoritySuccess(response);
}

/** Tell the audit's authority a chat message's daily counters are settled. */
export async function acknowledgeGraderChatSettlement(
  reservation: GraderChatReservation,
  env: Env,
): Promise<void> {
  await chatReservationRequest(reservation, '/settle-chat', env);
}

async function chatReservationRequest(
  reservation: GraderChatReservation,
  path: '/settle-chat',
  env: Env,
): Promise<void> {
  const input: ChatReservationInput = { reservationIdentifier: reservation.reservationIdentifier };
  const response = await authorityStub(reservation.auditIdentifier, env).fetch(
    internalRequest(reservation.storeOrigin, path, input),
  );
  assertAuthoritySuccess(response);
}

/** Durable Object implementation exported by the Worker entry module. */
export class AuditSessionAuthority implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return internalResponse(404);
    if (path === '/exchange') return this.exchange(await readInput<ExchangeInput>(request));
    if (path === '/reserve') return this.reserve(await readInput<ReserveInput>(request));
    if (path === '/finalize') return this.finalize(await readInput<FinalizeInput>(request));
    if (path === '/status') {
      return this.status(await readInput<AuditAuthoritySessionReference>(request));
    }
    if (path === '/reserve-chat') {
      return this.reserveChat(await readInput<ChatReserveInput>(request));
    }
    if (path === '/commit-chat') return this.commitChat(await readInput<ChatCommitInput>(request));
    if (path === '/release-chat') {
      return this.releaseChat(await readInput<ChatReleaseInput>(request));
    }
    if (path === '/settle-chat') {
      return this.settleChat(await readInput<ChatReservationInput>(request));
    }
    if (path === GRADER_CHAT_QUOTA_RESERVE_PATH) {
      return this.reserveGraderChatQuota(await readInput<unknown>(request));
    }
    if (path === GRADER_CHAT_QUOTA_FINALIZE_PATH) {
      return this.finalizeGraderChatQuota(await readInput<unknown>(request));
    }
    if (path === '/reserve-free-visual-verification') {
      return this.reserveFreeVisualVerification(
        await readInput<FreeVisualVerificationReserveInput>(request),
      );
    }
    return internalResponse(404);
  }

  async alarm(): Promise<void> {
    try {
      await drainDailyChatAlerts(this.state.storage, this.env, this.logger());
      await expireDailyChatCounter(this.state.storage);
      await this.expirePendingSession();
      await this.drainChatSettlements();
      await this.deleteExpiredChatOutcomes();
      await this.flushStatusOutbox();
    } finally {
      await this.scheduleAlarm();
    }
  }

  private async status(input: AuditAuthoritySessionReference): Promise<Response> {
    const session = await readSession(this.state.storage);
    if (!session || !matchesSession(session, input)) return internalResponse(401);
    if (runRevoked(session, graderRunsValidFrom(this.env), input.issuedAt)) {
      return internalResponse(412);
    }
    return new Response(JSON.stringify({ chatMessages: session.chatMessages ?? 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async exchange(input: ExchangeInput): Promise<Response> {
    const outcome = await this.state.storage.transaction(async (storage) => {
      const existing = await readSession(storage);
      if (existing?.consumedActivationIdentifiers.includes(input.activationIdentifier)) {
        return { status: 409 } as const;
      }
      if (
        existing &&
        (existing.auditIdentifier !== input.auditIdentifier ||
          !isSameStoreOrigin(existing.storeOrigin, input.storeOrigin) ||
          existing.attemptLimit !== input.attemptLimit)
      ) {
        return { status: 403 } as const;
      }
      if (existing && publicAttemptsExhausted(existing)) return { status: 429 } as const;

      const superseded = existing ? releaseSession(existing) : undefined;
      const session: SessionRecord = {
        auditIdentifier: input.auditIdentifier,
        attemptLimit: input.attemptLimit,
        storeOrigin: input.storeOrigin,
        statusCallbackUrl: input.statusCallbackUrl,
        completedAttempts: superseded?.completedAttempts ?? 0,
        consumedActivationIdentifiers: [
          ...(superseded?.consumedActivationIdentifiers ?? []),
          input.activationIdentifier,
        ],
        sessionIdentifier: input.sessionIdentifier,
        expiresAt: input.expiresAt,
        ...NO_SESSION_TOTALS,
        chatMessages: superseded?.chatMessages ?? 0,
        chatAttempts: superseded?.chatAttempts ?? 0,
        chatReplies: superseded?.chatReplies ?? [],
        ...(superseded?.chatInFlight ? { chatInFlight: superseded.chatInFlight } : {}),
        ...(superseded?.chatAnswered ? { chatAnswered: superseded.chatAnswered } : {}),
        ...(superseded?.chatSettlements ? { chatSettlements: superseded.chatSettlements } : {}),
        run: 1,
        ...FRESH_RUN,
        runTimes: { sessionIdentifier: input.sessionIdentifier, run: 1, startedAt: Date.now() },
        pending: superseded ? withAdmittingOrigin(superseded.pending, superseded.storeOrigin) : {},
        completedReservations: [],
        abandonedReservations: superseded?.abandonedReservations ?? [],
        statusOutbox: superseded?.statusOutbox ?? [],
      };
      await this.writeSession(storage, session);
      return { status: 201, chatMessages: session.chatMessages ?? 0 } as const;
    });
    if (outcome.status !== 201) return internalResponse(outcome.status);
    await this.scheduleAlarm();
    return new Response(JSON.stringify({ chatMessages: outcome.chatMessages }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async reserve(input: ReserveInput): Promise<Response> {
    const referencedFiles = await Promise.all(
      input.referencedFileIdentifiers.map(async (reference) => ({
        reference,
        digest: await fileReferenceDigest(reference),
      })),
    );
    const status = await this.state.storage.transaction(async (storage) => {
      const stored = await readSession(storage);
      if (!stored || !matchesSession(stored, input)) return 401;
      if (stored.pending[input.reservationIdentifier]) return 200;
      if (serializedBytes(stored) > SESSION_RECORD_BUDGET_BYTES) return 503;
      const ceiling = auditRunCeiling(this.env);
      const validFrom = graderRunsValidFrom(this.env);

      if (input.kind === 'upload') {
        if (publicAttemptsExhausted(stored)) return 402;
        let session = stored;
        if (session.runInferenceStarted) {
          if (session.run >= auditMaxRuns(this.env)) return 410;
          session = startNextRun(session);
        } else {
          session = withAdoptedRunTimes(session, Date.now());
        }
        if (runRevoked(session, validFrom, input.issuedAt)) return 412;
        const pendingUploads = Object.values(session.pending).filter(
          (item) => item.kind === 'upload' && admittedBySession(item, session),
        );
        const sessionUploads = ceiling.uploads * auditMaxRuns(this.env);
        if (session.uploadCount + pendingUploads.length >= sessionUploads) return 429;
        await this.writeSession(storage, {
          ...session,
          pending: {
            ...session.pending,
            [input.reservationIdentifier]: {
              kind: input.kind,
              run: session.run,
              uploadBytes: input.uploadBytes,
              sessionIdentifier: session.sessionIdentifier,
              storeOrigin: session.storeOrigin,
              admittedAt: Date.now(),
            },
          },
        } satisfies SessionRecord);
        return 200;
      }

      const current = withAdoptedRunTimes(stored, Date.now());
      if (runRevoked(current, validFrom, input.issuedAt)) return 412;
      if (current.runInferences >= ceiling.inferences) return 429;
      if (!current.runCompleted && publicAttemptsExhausted(current)) return 402;
      const attemptNumber = current.completedAttempts + 1;
      const owned = new Set(current.fileIdentifiers);
      if (
        referencedFiles.some(({ reference, digest }) => !owned.has(digest) && !owned.has(reference))
      ) {
        return 403;
      }
      const session = abandonPendingInferences(current);
      await this.writeSession(storage, {
        ...session,
        runInferences: session.runInferences + 1,
        runInferenceStarted: true,
        pending: {
          ...session.pending,
          [input.reservationIdentifier]: {
            kind: input.kind,
            run: session.run,
            uploadBytes: 0,
            ...(session.runCompleted ? {} : { attemptNumber }),
            sessionIdentifier: session.sessionIdentifier,
            storeOrigin: session.storeOrigin,
            admittedAt: Date.now(),
          },
        },
        statusOutbox: session.runCompleted
          ? session.statusOutbox
          : [...session.statusOutbox, statusEvent(session, attemptNumber, 'started')],
      } satisfies SessionRecord);
      return 200;
    });
    if (status === 200) await this.scheduleAlarm();
    return internalResponse(status);
  }

  private async reserveChat(input: ChatReserveInput): Promise<Response> {
    const outcome = await this.state.storage.transaction(async (storage) => {
      const stored = await readSession(storage);
      if (!stored || !matchesSession(stored, input)) return { status: 401 } as const;
      if (runRevoked(stored, graderRunsValidFrom(this.env), input.issuedAt)) {
        return { status: 412 } as const;
      }
      const answered = stored.chatAnswered?.find(
        (message) => message.messageId === input.messageId,
      );
      if (answered) {
        if (answered.transcriptFingerprint !== input.transcriptFingerprint) {
          return { status: 400 } as const;
        }
        const replay = await storage.get<GraderChatOutcome>(chatOutcomeKey(input.messageId));
        if (!replay) return { status: 400 } as const;
        return { status: 200, replay, chatMessages: stored.chatMessages ?? 0 } as const;
      }
      const now = Date.now();
      const inFlight = stored.chatInFlight;
      if (inFlight?.reservationIdentifier === input.reservationIdentifier) {
        return { status: 201 } as const;
      }
      if (inFlight && leaseEnd(inFlight.admittedAt) > now) {
        return inFlight.messageId === input.messageId &&
          inFlight.transcriptFingerprint !== input.transcriptFingerprint
          ? ({ status: 400 } as const)
          : ({ status: 409 } as const);
      }
      if (serializedBytes(stored) > SESSION_RECORD_BUDGET_BYTES) return { status: 503 } as const;
      if (!stored.runCompleted) {
        return { status: runAnalysisPending(stored) ? 423 : 424 } as const;
      }
      if ((stored.chatMessages ?? 0) >= graderChatMessageAllowance(this.env)) {
        return { status: 429 } as const;
      }
      if ((stored.chatAttempts ?? 0) >= graderChatAttemptAllowance(this.env)) {
        return { status: 402 } as const;
      }
      const replies = new Set(stored.chatReplies ?? []);
      if (input.historyFingerprints.some((fingerprint) => !replies.has(fingerprint))) {
        return { status: 403 } as const;
      }
      const released = releaseLapsedChat(stored, now);
      await this.writeSession(storage, {
        ...released,
        chatAttempts: (released.chatAttempts ?? 0) + 1,
        chatInFlight: {
          reservationIdentifier: input.reservationIdentifier,
          messageId: input.messageId,
          transcriptFingerprint: input.transcriptFingerprint,
          visitorAuthority: input.visitorAuthority,
          day: input.day,
          admittedAt: now,
        },
      } satisfies SessionRecord);
      return { status: 201 } as const;
    });
    if (outcome.status === 200) {
      return new Response(
        JSON.stringify({ outcome: outcome.replay, chatMessages: outcome.chatMessages }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (outcome.status === 201) await this.scheduleAlarm();
    return internalResponse(outcome.status);
  }

  private async commitChat(input: ChatCommitInput): Promise<Response> {
    const committed = await this.state.storage.transaction(async (storage) => {
      const session = await readSession(storage);
      if (!session) return { status: 204 } as const;
      const answered = session.chatAnswered ?? [];
      if (
        answered.some((message) => message.reservationIdentifier === input.reservationIdentifier)
      ) {
        return { status: 200, chatMessages: session.chatMessages ?? 0 } as const;
      }
      const inFlight = session.chatInFlight;
      if (inFlight?.reservationIdentifier !== input.reservationIdentifier) {
        return { status: 410 } as const;
      }
      const now = Date.now();
      const count = (session.chatMessages ?? 0) + 1;
      await storage.put(chatOutcomeKey(inFlight.messageId), input.outcome);
      await this.writeSession(storage, {
        ...withoutChatInFlight(session),
        chatMessages: count,
        chatReplies:
          input.replyFingerprint === undefined
            ? (session.chatReplies ?? [])
            : [...(session.chatReplies ?? []), input.replyFingerprint],
        chatAnswered: [
          ...answered,
          {
            messageId: inFlight.messageId,
            transcriptFingerprint: inFlight.transcriptFingerprint,
            reservationIdentifier: inFlight.reservationIdentifier,
            answeredAt: now,
            outcomeExpiresAt: now + auditSessionTtlSeconds(this.env) * 1000,
          },
        ].slice(-GRADER_CHAT_MESSAGE_CEILING),
        chatSettlements: [
          ...(session.chatSettlements ?? []),
          chatSettlement(inFlight, 'answered', now, now + CALLBACK_RETRY_MILLISECONDS),
        ],
      } satisfies SessionRecord);
      return { status: 200, chatMessages: count } as const;
    });
    if (committed.status !== 200) return internalResponse(committed.status);
    await this.scheduleAlarm();
    return new Response(JSON.stringify({ chatMessages: committed.chatMessages }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async releaseChat(input: ChatReleaseInput): Promise<Response> {
    if (input.outcome !== 'failed' && input.outcome !== 'released') return internalResponse(400);
    await this.state.storage.transaction(async (storage) => {
      const session = await readSession(storage);
      const inFlight = session?.chatInFlight;
      if (!session || inFlight?.reservationIdentifier !== input.reservationIdentifier) return;
      const now = Date.now();
      await this.writeSession(
        storage,
        releaseChatInFlight(
          session,
          inFlight,
          input.outcome,
          now,
          now + CALLBACK_RETRY_MILLISECONDS,
        ),
      );
    });
    await this.scheduleAlarm();
    return internalResponse(204);
  }

  private async settleChat(input: ChatReservationInput): Promise<Response> {
    await this.state.storage.transaction(async (storage) => {
      const session = await readSession(storage);
      const settlements = session?.chatSettlements ?? [];
      if (!session || !settlements.some(isSettlementOf(input.reservationIdentifier))) return;
      await this.writeSession(storage, {
        ...session,
        chatSettlements: withoutSettlement(settlements, input.reservationIdentifier),
      } satisfies SessionRecord);
    });
    return internalResponse(204);
  }

  private async drainChatSettlements(): Promise<void> {
    const session = await readSession(this.state.storage);
    const now = Date.now();
    const due = (session?.chatSettlements ?? []).filter((settlement) => settlement.retryAt <= now);
    const log = this.logger();
    for (const settlement of due) {
      let settled = true;
      if (now - settlement.recordedAt > CHAT_SETTLEMENT_HORIZON_MILLISECONDS) {
        log.warn('A grader chat settlement outlived its daily counters; it was dropped', {
          auditIdentifier: session?.auditIdentifier,
        });
      } else {
        try {
          await finalizeGraderChatQuota(
            {
              reservationIdentifier: settlement.reservationIdentifier,
              visitorAuthority: settlement.visitorAuthority,
              day: settlement.day,
            },
            settlement.outcome,
            this.env,
          );
        } catch (error) {
          settled = false;
          log.warn('A grader chat settlement could not reach its daily counters; it is retried', {
            auditIdentifier: session?.auditIdentifier,
            failure: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
      await this.state.storage.transaction(async (storage) => {
        const current = await readSession(storage);
        const settlements = current?.chatSettlements ?? [];
        if (!current || !settlements.some(isSettlementOf(settlement.reservationIdentifier))) return;
        await this.writeSession(storage, {
          ...current,
          chatSettlements: settled
            ? withoutSettlement(settlements, settlement.reservationIdentifier)
            : settlements.map((entry) =>
                isSettlementOf(settlement.reservationIdentifier)(entry)
                  ? { ...entry, retryAt: Date.now() + CALLBACK_RETRY_MILLISECONDS }
                  : entry,
              ),
        } satisfies SessionRecord);
      });
    }
  }

  private async deleteExpiredChatOutcomes(): Promise<void> {
    await this.state.storage.transaction(async (storage) => {
      const session = await readSession(storage);
      const now = Date.now();
      const expired = (session?.chatAnswered ?? []).filter(
        (message) => message.outcomeExpiresAt !== undefined && message.outcomeExpiresAt <= now,
      );
      if (!session || expired.length === 0) return;
      for (const message of expired) await storage.delete(chatOutcomeKey(message.messageId));
      await this.writeSession(storage, {
        ...session,
        chatAnswered: (session.chatAnswered ?? []).map((message) => {
          if (!expired.includes(message)) return message;
          const { outcomeExpiresAt: _deleted, ...kept } = message;
          return kept;
        }),
      } satisfies SessionRecord);
    });
  }

  private async reserveGraderChatQuota(input: unknown): Promise<Response> {
    if (!isDailyChatReserveInput(input)) return internalResponse(400);
    const reservation = await reserveDailyChatSlot(this.state.storage, input);
    if (reservation === 'misdirected') return internalResponse(421);
    if (reservation === 'attempts-exhausted') return internalResponse(402);
    if (reservation === 'refused') return internalResponse(429);
    await this.scheduleAlarm();
    return internalResponse(201);
  }

  private async finalizeGraderChatQuota(input: unknown): Promise<Response> {
    if (!isDailyChatFinalizeInput(input)) return internalResponse(400);
    if (await finalizeDailyChatSlot(this.state.storage, input)) await this.scheduleAlarm();
    return internalResponse(204);
  }

  private async reserveFreeVisualVerification(
    input: FreeVisualVerificationReserveInput,
  ): Promise<Response> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) return internalResponse(400);
    const legacy =
      input.dailyLimit === undefined &&
      input.acceptanceReserve === undefined &&
      input.quotaClass === undefined;
    let policy: Parameters<typeof reserveFreeVisualVerificationSlot>[1];
    if (legacy) {
      policy = { dailyLimit: input.limit, acceptanceReserve: 0, quotaClass: 'acceptance' };
    } else {
      const { dailyLimit, acceptanceReserve, quotaClass } = input;
      if (
        !Number.isSafeInteger(dailyLimit) ||
        typeof dailyLimit !== 'number' ||
        dailyLimit <= 0 ||
        !Number.isSafeInteger(acceptanceReserve) ||
        typeof acceptanceReserve !== 'number' ||
        acceptanceReserve <= 0 ||
        acceptanceReserve >= dailyLimit ||
        (quotaClass !== 'diagnostic' && quotaClass !== 'acceptance') ||
        input.limit !== (quotaClass === 'acceptance' ? dailyLimit : dailyLimit - acceptanceReserve)
      )
        return internalResponse(400);
      policy = { dailyLimit, acceptanceReserve, quotaClass };
    }
    const accepted = await reserveFreeVisualVerificationSlot(this.state.storage, policy);
    return internalResponse(accepted ? 201 : 429);
  }

  private async finalize(input: FinalizeInput): Promise<Response> {
    const ownedFile =
      typeof input.fileIdentifier === 'string' && input.fileIdentifier.length > 0
        ? await fileReferenceDigest(input.fileIdentifier)
        : undefined;
    const status = await this.state.storage.transaction(async (storage) => {
      const session = await readSession(storage);
      if (!session) return 401;
      if (session.completedReservations.includes(input.reservationIdentifier)) return 204;
      if (session.abandonedReservations.includes(input.reservationIdentifier)) return 204;
      const reservation = session.pending[input.reservationIdentifier];
      if (!reservation) return input.succeeded ? 409 : 204;
      if (
        input.succeeded &&
        reservation.kind === 'upload' &&
        (typeof input.fileIdentifier !== 'string' || input.fileIdentifier.length === 0)
      ) {
        return 400;
      }

      const { [input.reservationIdentifier]: _completed, ...pending } = session.pending;
      const currentRun = inCurrentRun(reservation, session);
      const ownSession = admittedBySession(reservation, session);
      const uploaded = input.succeeded && reservation.kind === 'upload' && ownSession;
      const uploadSucceeded = uploaded && currentRun;
      const fileIdentifiers =
        uploadSucceeded && ownedFile
          ? [...new Set([...session.fileIdentifiers, ownedFile])]
          : session.fileIdentifiers;
      const completesRun =
        input.succeeded &&
        input.completed === true &&
        reservation.kind === 'message' &&
        currentRun &&
        !session.runCompleted &&
        reservation.attemptNumber !== undefined;
      const completesEarlierSession =
        input.succeeded &&
        input.completed === true &&
        reservation.kind === 'message' &&
        reservation.attemptNumber !== undefined &&
        !admittedBySession(reservation, session);
      const completesAttempt = completesRun || completesEarlierSession;
      const statusOutbox = [...session.statusOutbox];
      if (reservation.kind === 'message' && reservation.attemptNumber !== undefined) {
        statusOutbox.push(
          reservationStatusEvent(
            session,
            reservation,
            reservation.attemptNumber,
            completesAttempt ? 'completed' : 'failed',
          ),
        );
      }
      await this.writeSession(storage, {
        ...session,
        completedAttempts: session.completedAttempts + (completesAttempt ? 1 : 0),
        uploadCount: session.uploadCount + (uploaded ? 1 : 0),
        totalUploadBytes: session.totalUploadBytes + (uploaded ? reservation.uploadBytes : 0),
        messageCount:
          session.messageCount +
          (input.succeeded && reservation.kind === 'message' && ownSession ? 1 : 0),
        runCompleted: session.runCompleted || completesRun,
        ...(completesRun ? { runTimes: completedRunTimes(session, Date.now()) } : {}),
        runUploads: session.runUploads + (uploadSucceeded ? 1 : 0),
        fileIdentifiers,
        pending,
        completedReservations: input.succeeded
          ? [...session.completedReservations, input.reservationIdentifier]
          : session.completedReservations,
        statusOutbox,
      } satisfies SessionRecord);
      return 204;
    });
    if (status === 204) await this.scheduleAlarm();
    return internalResponse(status);
  }

  private async expirePendingSession(): Promise<void> {
    const now = epochSeconds();
    await this.state.storage.transaction(async (storage) => {
      const session = await readSession(storage);
      if (!session) return;
      const released = releaseLapsedChat(
        releaseLapsedReservations(releaseExpiredSession(session, now), Date.now()),
        Date.now(),
      );
      if (released !== session) await this.writeSession(storage, released);
    });
  }

  private async flushStatusOutbox(): Promise<void> {
    while (true) {
      const session = await readSession(this.state.storage);
      const event = session?.statusOutbox[0];
      if (!session || !event) return;
      if (session.statusRetryAt !== undefined && session.statusRetryAt > Date.now()) return;
      const delivery = await deliverAuditStatusEvent(event, session.statusCallbackUrl, this.env);
      if (delivery === 'rejected') {
        this.logger().warn(
          'The website permanently rejected an audit status event; it was dropped',
          {
            auditIdentifier: event.auditIdentifier,
            eventIdentifier: event.eventIdentifier,
            attemptNumber: event.attemptNumber,
            status: event.status,
          },
        );
      }
      await this.state.storage.transaction(async (storage) => {
        const current = await readSession(storage);
        if (!current || current.statusOutbox[0]?.eventIdentifier !== event.eventIdentifier) return;
        const { statusRetryAt: _previous, ...settled } = current;
        await storage.put(
          SESSION_STORAGE_KEY,
          delivery === 'retry'
            ? ({
                ...current,
                statusRetryAt: Date.now() + CALLBACK_RETRY_MILLISECONDS,
              } satisfies SessionRecord)
            : ({ ...settled, statusOutbox: current.statusOutbox.slice(1) } satisfies SessionRecord),
        );
      });
      if (delivery === 'retry') return;
    }
  }

  private async writeSession(
    storage: DurableObjectStorage | DurableObjectTransaction,
    session: SessionRecord,
  ): Promise<void> {
    const ceiling = auditRunCeiling(this.env);
    const reservationsPerSession = auditMaxRuns(this.env) * (ceiling.uploads + ceiling.inferences);
    await storage.put(SESSION_STORAGE_KEY, {
      ...session,
      consumedActivationIdentifiers: latest(
        session.consumedActivationIdentifiers,
        RETAINED_ACTIVATION_IDENTIFIERS,
      ),
      abandonedReservations: latest(session.abandonedReservations, 2 * reservationsPerSession),
    } satisfies SessionRecord);
  }

  private logger(): Logger {
    return createLoggingRuntime(this.env, (task) => this.state.waitUntil(task)).logger(
      'AuditSessionAuthority',
    );
  }

  private async scheduleAlarm(): Promise<void> {
    const candidates: number[] = [];
    const counterAlarmAt = await dailyChatCounterAlarmAt(this.state.storage);
    if (counterAlarmAt !== null) candidates.push(counterAlarmAt);
    const session = await readSession(this.state.storage);
    if (session) candidates.push(...sessionAlarmCandidates(session));
    if (candidates.length > 0) await this.state.storage.setAlarm(Math.min(...candidates));
  }
}

function sessionAlarmCandidates(session: SessionRecord): number[] {
  const now = Date.now();
  const candidates: number[] = [];
  if (session.statusOutbox.length > 0) {
    candidates.push(Math.max(now, session.statusRetryAt ?? now));
  }
  const sessionExpiry = session.expiresAt * 1000;
  if (sessionExpiry > now) candidates.push(sessionExpiry);
  const leaseEnds = Object.values(session.pending).flatMap((reservation) =>
    reservation.admittedAt === undefined ? [] : [leaseEnd(reservation.admittedAt)],
  );
  if (leaseEnds.length > 0) candidates.push(Math.max(now, Math.min(...leaseEnds)));
  const settlementRetries = (session.chatSettlements ?? []).map((settlement) => settlement.retryAt);
  if (settlementRetries.length > 0) {
    candidates.push(Math.max(now, Math.min(...settlementRetries)));
  }
  if (session.chatInFlight) {
    candidates.push(Math.max(now, leaseEnd(session.chatInFlight.admittedAt)));
  }
  const outcomeExpiries = (session.chatAnswered ?? []).flatMap((message) =>
    message.outcomeExpiresAt === undefined ? [] : [message.outcomeExpiresAt],
  );
  if (outcomeExpiries.length > 0) candidates.push(Math.max(now, Math.min(...outcomeExpiries)));
  return candidates;
}

function releaseExpiredSession(session: SessionRecord, now: number): SessionRecord {
  return session.expiresAt > now ? session : releaseSession(session);
}

function releaseSession(session: SessionRecord): SessionRecord {
  const statusOutbox = [...session.statusOutbox];
  const leased: Record<string, PendingReservation> = {};
  const released: string[] = [];
  for (const [identifier, reservation] of Object.entries(session.pending)) {
    if (reservation.admittedAt !== undefined) {
      leased[identifier] = reservation;
      continue;
    }
    released.push(identifier);
    if (reservation.kind === 'message' && reservation.attemptNumber !== undefined) {
      statusOutbox.push(
        reservationStatusEvent(session, reservation, reservation.attemptNumber, 'failed'),
      );
    }
  }
  const { runTimes: _released, ...current } = session;
  return {
    ...current,
    ...NO_SESSION_TOTALS,
    ...FRESH_RUN,
    pending: leased,
    completedReservations: [],
    abandonedReservations: [...session.abandonedReservations, ...released],
    statusOutbox,
  };
}

function releaseLapsedReservations(session: SessionRecord, nowMilliseconds: number): SessionRecord {
  const lapsed = Object.entries(session.pending).filter(
    ([, reservation]) =>
      reservation.admittedAt !== undefined && leaseEnd(reservation.admittedAt) <= nowMilliseconds,
  );
  if (lapsed.length === 0) return session;
  const lapsedIdentifiers = new Set(lapsed.map(([identifier]) => identifier));
  const statusOutbox = [...session.statusOutbox];
  for (const [, reservation] of lapsed) {
    if (reservation.kind === 'message' && reservation.attemptNumber !== undefined) {
      statusOutbox.push(
        reservationStatusEvent(session, reservation, reservation.attemptNumber, 'failed'),
      );
    }
  }
  return {
    ...session,
    pending: Object.fromEntries(
      Object.entries(session.pending).filter(([identifier]) => !lapsedIdentifiers.has(identifier)),
    ),
    abandonedReservations: [...session.abandonedReservations, ...lapsedIdentifiers],
    statusOutbox,
  };
}

function leaseEnd(admittedAt: number): number {
  return admittedAt + RESERVATION_LEASE_MILLISECONDS;
}

function isSettlementOf(reservationIdentifier: string): (settlement: ChatSettlement) => boolean {
  return (settlement) => settlement.reservationIdentifier === reservationIdentifier;
}

function withoutSettlement(
  settlements: readonly ChatSettlement[],
  reservationIdentifier: string,
): readonly ChatSettlement[] {
  return settlements.filter(
    (settlement) => settlement.reservationIdentifier !== reservationIdentifier,
  );
}

function withoutChatInFlight(session: SessionRecord): SessionRecord {
  const { chatInFlight: _released, ...released } = session;
  return released;
}

function releaseChatInFlight(
  session: SessionRecord,
  inFlight: ChatReservation,
  outcome: ChatReleaseInput['outcome'],
  now: number,
  retryAt: number,
): SessionRecord {
  return {
    ...withoutChatInFlight(session),
    chatAttempts: Math.max(0, (session.chatAttempts ?? 0) - (outcome === 'released' ? 1 : 0)),
    chatSettlements: [
      ...(session.chatSettlements ?? []),
      chatSettlement(inFlight, outcome, now, retryAt),
    ],
  };
}

function releaseLapsedChat(session: SessionRecord, now: number): SessionRecord {
  const inFlight = session.chatInFlight;
  if (!inFlight || leaseEnd(inFlight.admittedAt) > now) return session;
  return releaseChatInFlight(session, inFlight, 'failed', now, now);
}

function chatSettlement(
  inFlight: ChatReservation,
  outcome: GraderChatSettlementOutcome,
  now: number,
  retryAt: number,
): ChatSettlement {
  return {
    reservationIdentifier: inFlight.reservationIdentifier,
    visitorAuthority: inFlight.visitorAuthority,
    day: inFlight.day,
    outcome,
    recordedAt: now,
    retryAt,
  };
}

function chatOutcomeKey(messageId: string): string {
  return `${CHAT_OUTCOME_KEY_PREFIX}${messageId}`;
}

function admittedBySession(reservation: PendingReservation, session: SessionRecord): boolean {
  return (
    reservation.sessionIdentifier === undefined ||
    reservation.sessionIdentifier === session.sessionIdentifier
  );
}

function inCurrentRun(reservation: PendingReservation, session: SessionRecord): boolean {
  return (
    admittedBySession(reservation, session) &&
    (reservation.run === undefined || reservation.run === session.run)
  );
}

function runAnalysisPending(session: SessionRecord): boolean {
  return (
    !session.runInferenceStarted ||
    Object.values(session.pending).some(
      (reservation) => reservation.kind === 'message' && inCurrentRun(reservation, session),
    )
  );
}

function publicAttemptsExhausted(session: SessionRecord): boolean {
  return session.attemptLimit !== null && session.completedAttempts >= session.attemptLimit;
}

function startNextRun(session: SessionRecord): SessionRecord {
  const run = session.run + 1;
  return {
    ...abandonPendingInferences(session),
    ...FRESH_RUN,
    run,
    runTimes: { sessionIdentifier: session.sessionIdentifier, run, startedAt: Date.now() },
  };
}

function currentRunTimes(session: SessionRecord): RunTimes | undefined {
  const times = session.runTimes;
  return times?.sessionIdentifier === session.sessionIdentifier && times.run === session.run
    ? times
    : undefined;
}

function completedRunTimes(session: SessionRecord, completedAt: number): RunTimes {
  return {
    sessionIdentifier: session.sessionIdentifier,
    run: session.run,
    startedAt: currentRunTimes(session)?.startedAt ?? completedAt,
    completedAt,
  };
}

/**
 * Whether the current run produced no proposal yet carries no times of its own, as when a worker
 * that keeps none opened it with an upload: it has no report to revoke, so it is adopted as opening
 * now and continues with the files it owns.
 */
function adoptableRun(session: SessionRecord): boolean {
  return (
    currentRunTimes(session) === undefined && !session.runInferenceStarted && !session.runCompleted
  );
}

function withAdoptedRunTimes(session: SessionRecord, now: number): SessionRecord {
  if (!adoptableRun(session)) return session;
  return {
    ...session,
    runTimes: { sessionIdentifier: session.sessionIdentifier, run: session.run, startedAt: now },
  };
}

/**
 * Whether the current run is older than `validFrom`: by its completion, or its start while it has
 * not completed. A run that reached a proposal with its times missing or carried over from another
 * run reads as the session's issue time, the earliest any of its runs can have opened, and a run
 * completed without a recorded completion reads as its start; both err toward a fresh run, which the
 * next upload opens. An upload-only run without times is adopted as opening now.
 */
function runRevoked(
  session: SessionRecord,
  validFrom: number,
  issuedAtSeconds: number,
  now = Date.now(),
): boolean {
  const times = currentRunTimes(session);
  let runTime: number;
  if (times !== undefined) {
    runTime = session.runCompleted ? (times.completedAt ?? times.startedAt) : times.startedAt;
  } else {
    runTime = adoptableRun(session) ? now : issuedAtSeconds * 1000;
  }
  return runTime < validFrom;
}

function abandonPendingInferences(session: SessionRecord): SessionRecord {
  const abandoned = Object.entries(session.pending).filter(
    ([, reservation]) => reservation.kind === 'message',
  );
  if (abandoned.length === 0) return session;
  const pending = Object.fromEntries(
    Object.entries(session.pending).filter(([, reservation]) => reservation.kind !== 'message'),
  );
  const statusOutbox = [...session.statusOutbox];
  for (const [, reservation] of abandoned) {
    if (reservation.attemptNumber !== undefined) {
      statusOutbox.push(
        reservationStatusEvent(session, reservation, reservation.attemptNumber, 'failed'),
      );
    }
  }
  return {
    ...session,
    pending,
    abandonedReservations: [
      ...session.abandonedReservations,
      ...abandoned.map(([identifier]) => identifier),
    ],
    statusOutbox,
  };
}

/** A stored session that counts its uploads and inferences without dividing them into runs. */
interface SessionRecordWithoutRuns extends Omit<
  SessionRecord,
  keyof typeof FRESH_RUN | 'run' | 'abandonedReservations'
> {
  readonly fileIdentifiers: readonly string[];
}

/** A session's chat state as a worker that did not date its daily holds stored it. */
type StoredSessionRecord = Omit<SessionRecord, 'chatInFlight' | 'chatSettlements'> & {
  readonly chatInFlight?: Omit<ChatReservation, 'day'> & { readonly day?: string };
  readonly chatSettlements?: readonly (Omit<ChatSettlement, 'day'> & { readonly day?: string })[];
};

async function readSession(
  storage: DurableObjectStorage | DurableObjectTransaction,
): Promise<SessionRecord | undefined> {
  const stored = await storage.get<StoredSessionRecord | SessionRecordWithoutRuns>(
    SESSION_STORAGE_KEY,
  );
  if (!stored) return undefined;
  return withDatedChatHolds('run' in stored ? stored : asFirstRun(stored));
}

function withDatedChatHolds(session: StoredSessionRecord): SessionRecord {
  const { chatInFlight, chatSettlements, ...rest } = session;
  return {
    ...rest,
    ...(chatInFlight
      ? {
          chatInFlight: {
            ...chatInFlight,
            day: chatInFlight.day ?? utcDayOf(chatInFlight.admittedAt),
          },
        }
      : {}),
    ...(chatSettlements
      ? {
          chatSettlements: chatSettlements.map((settlement) => ({
            ...settlement,
            day: settlement.day ?? utcDayOf(settlement.recordedAt),
          })),
        }
      : {}),
  };
}

function utcDayOf(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString().slice(0, 10);
}

function asFirstRun(stored: SessionRecordWithoutRuns): SessionRecord {
  const runInferences =
    stored.messageCount +
    Object.values(stored.pending).filter((reservation) => reservation.kind === 'message').length;
  return {
    ...stored,
    run: 1,
    runUploads: stored.uploadCount,
    runInferences,
    runInferenceStarted: runInferences > 0,
    runCompleted: false,
    abandonedReservations: [],
  };
}

function statusEvent(
  session: SessionRecord,
  attemptNumber: number,
  status: AuditStatus,
  sessionIdentifier: string = session.sessionIdentifier,
  storeOrigin: string = session.storeOrigin,
): AuditStatusEvent {
  return {
    version: 1,
    eventIdentifier: crypto.randomUUID(),
    auditIdentifier: session.auditIdentifier,
    sessionIdentifier,
    storeOrigin,
    attemptNumber,
    status,
    occurredAt: epochSeconds(),
  };
}

function reservationStatusEvent(
  session: SessionRecord,
  reservation: PendingReservation,
  attemptNumber: number,
  status: AuditStatus,
): AuditStatusEvent {
  return statusEvent(
    session,
    attemptNumber,
    status,
    reservation.sessionIdentifier,
    reservation.storeOrigin,
  );
}

function withAdmittingOrigin(
  pending: Readonly<Record<string, PendingReservation>>,
  storeOrigin: string,
): Record<string, PendingReservation> {
  return Object.fromEntries(
    Object.entries(pending).map(([identifier, reservation]) => [
      identifier,
      reservation.storeOrigin === undefined ? { ...reservation, storeOrigin } : reservation,
    ]),
  );
}

function latest(entries: readonly string[], retained: number): readonly string[] {
  return entries.length > retained ? entries.slice(entries.length - retained) : entries;
}

function serializedBytes(session: SessionRecord): number {
  return new TextEncoder().encode(JSON.stringify(session)).byteLength;
}

async function fileReferenceDigest(fileReference: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fileReference));
  return base64UrlEncode(new Uint8Array(digest));
}

function authorityStub(auditIdentifier: string, env: Env): DurableObjectStub {
  const namespace = auditSessionAuthority(env);
  return namespace.get(namespace.idFromName(auditIdentifier));
}

function internalRequest(origin: string, path: string, body: object): Request {
  return new Request(new URL(path, origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readInput<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function internalResponse(status: number): Response {
  return new Response(null, { status });
}

function matchesSession(
  session: SessionRecord,
  input: Pick<ReserveInput, 'auditIdentifier' | 'sessionIdentifier' | 'storeOrigin' | 'expiresAt'>,
): boolean {
  return (
    session.auditIdentifier === input.auditIdentifier &&
    session.sessionIdentifier === input.sessionIdentifier &&
    session.storeOrigin === input.storeOrigin &&
    session.expiresAt === input.expiresAt &&
    session.expiresAt > epochSeconds()
  );
}

function assertAuthoritySuccess(response: Response): void {
  if (response.ok) return;
  throw authorityFailure(response.status);
}

function authorityFailure(status: number): WorkerError {
  return new WorkerError('The grader-session authority rejected the request.', {
    status: 500,
    exceptionType: 'AuditSessionAuthorityException',
    messageDetail: `Internal authority status ${status}`,
  });
}

function quotaError(message: string): WorkerError {
  return new WorkerError(message, { status: 429, exceptionType: 'AuditQuotaException' });
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
