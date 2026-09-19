/**
 * Strongly consistent authority for extension-driven Studio audits.
 *
 * One Durable Object is addressed by the website-signed audit identifier. It
 * consumes activation identifiers once, permits one active browser session,
 * preserves the public completion count across reissued links, owns provider
 * file identifiers, reserves quotas, and durably retries ordered website status
 * callbacks to the destination the activation signed.
 */

import {
  auditMaxMessages,
  auditMaxTotalUploadBytes,
  auditMaxUploads,
  auditSessionAuthority,
  type Env,
} from '../config';
import { deliverAuditStatusEvent, type AuditStatus, type AuditStatusEvent } from './audit-status';
import { WorkerError } from './responses';
import { reserveFreeVisualVerificationSlot } from './inference-quota-authority';

const SESSION_STORAGE_KEY = 'session';
const CALLBACK_RETRY_MILLISECONDS = 60_000;

type ReservationKind = 'upload' | 'message';

interface PendingReservation {
  readonly kind: ReservationKind;
  readonly uploadBytes: number;
  readonly attemptNumber?: number;
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
  readonly uploadCount: number;
  readonly totalUploadBytes: number;
  readonly messageCount: number;
  readonly fileIdentifiers: readonly string[];
  readonly pending: Readonly<Record<string, PendingReservation>>;
  readonly completedReservations: readonly string[];
  readonly statusOutbox: readonly AuditStatusEvent[];
}

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
}

interface FreeVisualVerificationReserveInput {
  readonly limit: number;
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

/** Atomically consume an activation and create the audit's one active session. */
export async function createAuditAuthoritySession(
  input: AuditAuthorityExchange,
  env: Env,
): Promise<void> {
  const response = await authorityStub(input.auditIdentifier, env).fetch(
    internalRequest(input.storeOrigin, '/exchange', input),
  );
  if (response.status === 409) {
    throw new WorkerError('The activation token has already been used.', {
      status: 409,
      exceptionType: 'AuditActivationConsumedException',
    });
  }
  if (response.status === 423) {
    throw new WorkerError('This grader already has an active browser session.', {
      status: 409,
      exceptionType: 'AuditSessionActiveException',
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
  if (response.status === 401) {
    throw auditAuthorizationError('The grader session is missing, expired, or no longer valid.');
  }
  if (response.status === 403) {
    throw new WorkerError('The inference request references a file outside this grader session.', {
      status: 403,
      exceptionType: 'AuditScopeException',
    });
  }
  if (response.status === 409) {
    throw new WorkerError('Another grader attempt is already in progress.', {
      status: 409,
      exceptionType: 'AuditAttemptInProgressException',
    });
  }
  if (response.status === 429) throw quotaError('The grader session quota has been reached.');
  assertAuthoritySuccess(response);
  return {
    auditIdentifier: input.auditIdentifier,
    sessionIdentifier: input.sessionIdentifier,
    reservationIdentifier,
    kind: input.kind,
  };
}

/** Commit a successful paid operation or release its reservation after failure. */
export async function finalizeAuditAuthorityRequest(
  authorization: AuditAuthorityReservation,
  storeOrigin: string,
  succeeded: boolean,
  fileIdentifier: string | undefined,
  env: Env,
): Promise<void> {
  const input: FinalizeInput = {
    reservationIdentifier: authorization.reservationIdentifier,
    succeeded,
    ...(fileIdentifier === undefined ? {} : { fileIdentifier }),
  };
  const response = await authorityStub(authorization.auditIdentifier, env).fetch(
    internalRequest(storeOrigin, '/finalize', input),
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
    if (path === '/reserve-free-visual-verification') {
      return this.reserveFreeVisualVerification(
        await readInput<FreeVisualVerificationReserveInput>(request),
      );
    }
    return internalResponse(404);
  }

  async alarm(): Promise<void> {
    await this.expirePendingSession();
    await this.flushStatusOutbox();
    await this.scheduleAlarm();
  }

  private async exchange(input: ExchangeInput): Promise<Response> {
    const status = await this.state.storage.transaction(async (storage) => {
      const existing = await storage.get<SessionRecord>(SESSION_STORAGE_KEY);
      if (existing?.consumedActivationIdentifiers.includes(input.activationIdentifier)) return 409;
      if (
        existing &&
        (existing.auditIdentifier !== input.auditIdentifier ||
          existing.storeOrigin !== input.storeOrigin ||
          existing.attemptLimit !== input.attemptLimit)
      ) {
        return 403;
      }
      if (
        existing &&
        existing.attemptLimit !== null &&
        existing.completedAttempts >= existing.attemptLimit
      ) {
        return 429;
      }
      const now = epochSeconds();
      if (existing && existing.expiresAt > now) return 423;

      const expired = existing ? releaseExpiredSession(existing, now) : undefined;
      const session: SessionRecord = {
        auditIdentifier: input.auditIdentifier,
        attemptLimit: input.attemptLimit,
        storeOrigin: input.storeOrigin,
        statusCallbackUrl: input.statusCallbackUrl,
        completedAttempts: expired?.completedAttempts ?? 0,
        consumedActivationIdentifiers: [
          ...(expired?.consumedActivationIdentifiers ?? []),
          input.activationIdentifier,
        ],
        sessionIdentifier: input.sessionIdentifier,
        expiresAt: input.expiresAt,
        uploadCount: 0,
        totalUploadBytes: 0,
        messageCount: 0,
        fileIdentifiers: [],
        pending: {},
        completedReservations: [],
        statusOutbox: expired?.statusOutbox ?? [],
      };
      await storage.put(SESSION_STORAGE_KEY, session);
      return 201;
    });
    if (status === 201) {
      await this.flushStatusOutbox();
      await this.scheduleAlarm();
    }
    return internalResponse(status);
  }

  private async reserve(input: ReserveInput): Promise<Response> {
    const status = await this.state.storage.transaction(async (storage) => {
      const session = await storage.get<SessionRecord>(SESSION_STORAGE_KEY);
      if (!session || !matchesSession(session, input)) return 401;
      if (session.pending[input.reservationIdentifier]) return 200;

      const pending = Object.values(session.pending);
      if (input.kind === 'upload') {
        const pendingUploads = pending.filter((item) => item.kind === 'upload');
        const pendingBytes = pendingUploads.reduce((total, item) => total + item.uploadBytes, 0);
        if (
          session.uploadCount + pendingUploads.length >= auditMaxUploads(this.env) ||
          session.totalUploadBytes + pendingBytes + input.uploadBytes >
            auditMaxTotalUploadBytes(this.env)
        ) {
          return 429;
        }
      } else {
        if (pending.some((item) => item.kind === 'message')) return 409;
        if (session.messageCount >= auditMaxMessages(this.env)) return 429;
        const attemptNumber = session.completedAttempts + 1;
        if (session.attemptLimit !== null && attemptNumber > session.attemptLimit) return 429;
        const owned = new Set(session.fileIdentifiers);
        if (input.referencedFileIdentifiers.some((identifier) => !owned.has(identifier))) {
          return 403;
        }
        const started = statusEvent(session, attemptNumber, 'started');
        await storage.put(SESSION_STORAGE_KEY, {
          ...session,
          pending: {
            ...session.pending,
            [input.reservationIdentifier]: {
              kind: input.kind,
              uploadBytes: 0,
              attemptNumber,
            },
          },
          statusOutbox: [...session.statusOutbox, started],
        } satisfies SessionRecord);
        return 200;
      }

      await storage.put(SESSION_STORAGE_KEY, {
        ...session,
        pending: {
          ...session.pending,
          [input.reservationIdentifier]: {
            kind: input.kind,
            uploadBytes: input.uploadBytes,
          },
        },
      } satisfies SessionRecord);
      return 200;
    });
    if (status === 200) {
      await this.flushStatusOutbox();
      await this.scheduleAlarm();
    }
    return internalResponse(status);
  }

  private async reserveFreeVisualVerification(
    input: FreeVisualVerificationReserveInput,
  ): Promise<Response> {
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) return internalResponse(400);
    const accepted = await reserveFreeVisualVerificationSlot(this.state.storage, input.limit);
    return internalResponse(accepted ? 201 : 429);
  }

  private async finalize(input: FinalizeInput): Promise<Response> {
    const status = await this.state.storage.transaction(async (storage) => {
      const session = await storage.get<SessionRecord>(SESSION_STORAGE_KEY);
      if (!session) return 401;
      if (session.completedReservations.includes(input.reservationIdentifier)) return 204;
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
      const fileIdentifiers =
        input.succeeded && reservation.kind === 'upload' && input.fileIdentifier
          ? [...new Set([...session.fileIdentifiers, input.fileIdentifier])]
          : session.fileIdentifiers;
      const messageSucceeded = input.succeeded && reservation.kind === 'message';
      const statusOutbox = [...session.statusOutbox];
      if (reservation.kind === 'message' && reservation.attemptNumber !== undefined) {
        statusOutbox.push(
          statusEvent(
            session,
            reservation.attemptNumber,
            messageSucceeded ? 'completed' : 'failed',
          ),
        );
      }
      await storage.put(SESSION_STORAGE_KEY, {
        ...session,
        completedAttempts: session.completedAttempts + (messageSucceeded ? 1 : 0),
        uploadCount:
          session.uploadCount + (input.succeeded && reservation.kind === 'upload' ? 1 : 0),
        totalUploadBytes:
          session.totalUploadBytes +
          (input.succeeded && reservation.kind === 'upload' ? reservation.uploadBytes : 0),
        messageCount: session.messageCount + (messageSucceeded ? 1 : 0),
        fileIdentifiers,
        pending,
        completedReservations: input.succeeded
          ? [...session.completedReservations, input.reservationIdentifier]
          : session.completedReservations,
        statusOutbox,
      } satisfies SessionRecord);
      return 204;
    });
    if (status === 204) {
      await this.flushStatusOutbox();
      await this.scheduleAlarm();
    }
    return internalResponse(status);
  }

  private async expirePendingSession(): Promise<void> {
    const now = epochSeconds();
    await this.state.storage.transaction(async (storage) => {
      const session = await storage.get<SessionRecord>(SESSION_STORAGE_KEY);
      if (!session || session.expiresAt > now) return;
      await storage.put(SESSION_STORAGE_KEY, releaseExpiredSession(session, now));
    });
  }

  private async flushStatusOutbox(): Promise<void> {
    while (true) {
      const session = await this.state.storage.get<SessionRecord>(SESSION_STORAGE_KEY);
      const event = session?.statusOutbox[0];
      if (!session || !event) return;
      if (!(await deliverAuditStatusEvent(event, session.statusCallbackUrl, this.env))) return;
      await this.state.storage.transaction(async (storage) => {
        const current = await storage.get<SessionRecord>(SESSION_STORAGE_KEY);
        if (!current || current.statusOutbox[0]?.eventIdentifier !== event.eventIdentifier) return;
        await storage.put(SESSION_STORAGE_KEY, {
          ...current,
          statusOutbox: current.statusOutbox.slice(1),
        } satisfies SessionRecord);
      });
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const session = await this.state.storage.get<SessionRecord>(SESSION_STORAGE_KEY);
    if (!session) return;
    const now = Date.now();
    const candidates: number[] = [];
    if (session.statusOutbox.length > 0) candidates.push(now + CALLBACK_RETRY_MILLISECONDS);
    const sessionExpiry = session.expiresAt * 1000;
    if (sessionExpiry > now) candidates.push(sessionExpiry);
    if (candidates.length > 0) await this.state.storage.setAlarm(Math.min(...candidates));
  }
}

function releaseExpiredSession(session: SessionRecord, now: number): SessionRecord {
  if (session.expiresAt > now) return session;
  const statusOutbox = [...session.statusOutbox];
  for (const reservation of Object.values(session.pending)) {
    if (reservation.kind === 'message' && reservation.attemptNumber !== undefined) {
      statusOutbox.push(statusEvent(session, reservation.attemptNumber, 'failed'));
    }
  }
  // Retain only the stable attempt ledger, token replay set, and durable callback
  // outbox. Provider file identifiers and per-session counters are no longer
  // useful after expiry and must not become long-lived audit metadata.
  return {
    ...session,
    uploadCount: 0,
    totalUploadBytes: 0,
    messageCount: 0,
    fileIdentifiers: [],
    pending: {},
    completedReservations: [],
    statusOutbox,
  };
}

function statusEvent(
  session: SessionRecord,
  attemptNumber: number,
  status: AuditStatus,
): AuditStatusEvent {
  return {
    version: 1,
    eventIdentifier: crypto.randomUUID(),
    auditIdentifier: session.auditIdentifier,
    sessionIdentifier: session.sessionIdentifier,
    storeOrigin: session.storeOrigin,
    attemptNumber,
    status,
    occurredAt: epochSeconds(),
  };
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

function matchesSession(session: SessionRecord, input: ReserveInput): boolean {
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
  throw new WorkerError('The grader-session authority rejected the request.', {
    status: 500,
    exceptionType: 'AuditSessionAuthorityException',
    messageDetail: `Internal authority status ${response.status}`,
  });
}

function auditAuthorizationError(message: string): WorkerError {
  return new WorkerError(message, { status: 401, exceptionType: 'AuditAuthorizationException' });
}

function quotaError(message: string): WorkerError {
  return new WorkerError(message, { status: 429, exceptionType: 'AuditQuotaException' });
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
