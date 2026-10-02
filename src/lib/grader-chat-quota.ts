import {
  auditSessionAuthority,
  graderChatAlertEvery,
  graderChatMessagesPerDay,
  graderChatMessagesPerVisitorPerDay,
  inferenceQuotaInternalOrigin,
  type Env,
} from '../config';
import { base64UrlEncode, deriveSealingKey, type SealingPurpose } from '../inference/token-sealing';
import { GRADER_CHAT_ATTEMPTS_PER_ANSWER } from './audit-plan';
import { notifyGraderChatVolume } from './grader-chat-alerts';
import type { Logger } from './logger';
import { WorkerError } from './responses';

const STORAGE_KEY = 'grader-chat-quota';
const DAILY_AUTHORITY_NAME = 'grader-chat-daily';
const VISITOR_AUTHORITY_PREFIX = 'grader-chat-visitor:';
const VISITOR_PSEUDONYM_PURPOSE: SealingPurpose = {
  salt: 'app-ai:grader-chat:v1',
  info: 'visitor-pseudonym-hmac',
};
const DAY_MILLISECONDS = 86_400_000;
const ALERT_RETRY_MILLISECONDS = 60_000;
const PAST_DAY_SETTLEMENT_GRACE_MILLISECONDS = 3_600_000;

/** The internal Durable Object path that reserves one chat message on a named daily counter. */
export const GRADER_CHAT_QUOTA_RESERVE_PATH = '/reserve-grader-chat-quota';

/** The internal Durable Object path that commits or releases a daily-counter reservation. */
export const GRADER_CHAT_QUOTA_FINALIZE_PATH = '/finalize-grader-chat-quota';

/** Every reason the Grader chat refuses a message, each the `MessageDetail` of its refusal. */
export type GraderChatRefusalCode =
  | 'grader_chat_disabled'
  | 'grader_chat_not_in_plan'
  | 'grader_chat_input_too_long'
  | 'grader_chat_message_reused'
  | 'grader_chat_history_unverified'
  | 'grader_chat_busy'
  | 'grader_chat_not_open'
  | 'grader_chat_run_failed'
  | 'grader_chat_audit_limit'
  | 'grader_chat_attempt_limit'
  | 'grader_chat_visitor_limit'
  | 'grader_chat_daily_limit'
  | 'audit_session_expired';

const REFUSALS: Readonly<
  Record<
    GraderChatRefusalCode,
    { readonly status: number; readonly exceptionType: string; readonly message: string }
  >
> = {
  grader_chat_disabled: {
    status: 503,
    exceptionType: 'ServiceUnavailableException',
    message: 'The grader chat is not available right now.',
  },
  grader_chat_not_in_plan: {
    status: 403,
    exceptionType: 'AuditScopeException',
    message:
      'This grader version has no chat. Update the LimeSpot extension to chat about a report.',
  },
  grader_chat_input_too_long: {
    status: 400,
    exceptionType: 'ArgumentException',
    message: 'The message is longer than the grader chat accepts.',
  },
  grader_chat_message_reused: {
    status: 400,
    exceptionType: 'ArgumentException',
    message: 'This grader chat message identifier was already used.',
  },
  grader_chat_history_unverified: {
    status: 403,
    exceptionType: 'AuditScopeException',
    message: 'The grader chat history does not match the replies this audit received.',
  },
  grader_chat_busy: {
    status: 409,
    exceptionType: 'GraderChatBusyException',
    message: 'The grader chat is still answering the previous message.',
  },
  grader_chat_not_open: {
    status: 409,
    exceptionType: 'GraderChatUnavailableException',
    message: 'The grader chat opens once the analysis has completed.',
  },
  grader_chat_run_failed: {
    status: 409,
    exceptionType: 'GraderChatUnavailableException',
    message: 'The grader chat is unavailable because the analysis did not complete.',
  },
  grader_chat_audit_limit: {
    status: 429,
    exceptionType: 'GraderChatQuotaException',
    message: 'Every grader chat message for this report has been used.',
  },
  grader_chat_attempt_limit: {
    status: 429,
    exceptionType: 'GraderChatQuotaException',
    message: 'The grader chat has started too many unanswered messages.',
  },
  grader_chat_visitor_limit: {
    status: 429,
    exceptionType: 'GraderChatQuotaException',
    message: "Today's grader chat messages have been used.",
  },
  grader_chat_daily_limit: {
    status: 429,
    exceptionType: 'GraderChatQuotaException',
    message: 'The grader chat has reached its limit for today.',
  },
  audit_session_expired: {
    status: 401,
    exceptionType: 'AuditAuthorizationException',
    message: 'The grader session has expired.',
  },
};

/** The Brain-shaped refusal for one Grader chat reason. */
export function graderChatRefusal(code: GraderChatRefusalCode): WorkerError {
  const refusal = REFUSALS[code];
  return new WorkerError(refusal.message, {
    status: refusal.status,
    exceptionType: refusal.exceptionType,
    messageDetail: code,
  });
}

/** The two daily allowances one chat message holds while it is answered. */
export interface GraderChatQuotaHold {
  readonly reservationIdentifier: string;
  readonly visitorAuthority: string;
  /** The UTC day the request captured once, which named the visitor's counter and dates both holds. */
  readonly day: string;
}

/**
 * How a held message ends on its counters: answered and counted; failed after the model was called,
 * so its attempt stays charged; or released before any model call, so its attempt is refunded.
 */
export type GraderChatSettlementOutcome = 'answered' | 'failed' | 'released';

/** How a request's daily holds were taken: both held, or refused because the UTC day changed first. */
export type GraderChatQuotaOutcome = 'held' | 'day-changed';

/** A multiple of `GRADER_CHAT_ALERT_EVERY` the deployment's daily chat count reached. */
export interface GraderChatVolumeAlert {
  readonly count: number;
  readonly limit: number;
}

/** The current UTC day, `YYYY-MM-DD`, which a chat request captures once. */
export function graderChatDay(): string {
  return utcDay(Date.now());
}

/**
 * The daily counter that holds this visitor's messages on `day`: a keyed, day-scoped pseudonym of
 * `CF-Connecting-IP`. The raw address is never stored.
 */
export async function graderChatVisitorAuthority(
  request: Request,
  day: string,
  env: Env,
): Promise<string> {
  const address = request.headers.get('CF-Connecting-IP');
  const key = await deriveSealingKey(env, VISITOR_PSEUDONYM_PURPOSE, 'HMAC', ['sign']);
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${day}\n${address === null ? '' : address}`),
  );
  return `${VISITOR_AUTHORITY_PREFIX}${base64UrlEncode(new Uint8Array(digest))}`;
}

/**
 * Hold one message against the visitor's and then the deployment's daily allowance, both dated by
 * the hold's captured day. The visitor's counter also holds the day's attempts to
 * `GRADER_CHAT_ATTEMPTS_PER_ANSWER` times its allowance and refuses past it with
 * `grader_chat_attempt_limit`. A counter whose own UTC day is another refuses the hold, and this returns
 * `day-changed` so the caller releases what it took and starts again on the new day's counters. A
 * limit refusal throws; either way, whatever was held is left to the caller's release.
 */
export async function reserveGraderChatQuota(
  hold: GraderChatQuotaHold,
  env: Env,
): Promise<GraderChatQuotaOutcome> {
  const { reservationIdentifier, day } = hold;
  const perVisitor = graderChatMessagesPerVisitorPerDay(env);
  const visitor = await reserveSlot(
    hold.visitorAuthority,
    {
      limit: perVisitor,
      attemptLimit: GRADER_CHAT_ATTEMPTS_PER_ANSWER * perVisitor,
      reservationIdentifier,
      day,
    },
    env,
  );
  if (visitor === 'misdirected') return 'day-changed';
  if (visitor === 'refused') throw graderChatRefusal('grader_chat_visitor_limit');
  if (visitor === 'attempts-exhausted') throw graderChatRefusal('grader_chat_attempt_limit');
  const daily = await reserveSlot(
    DAILY_AUTHORITY_NAME,
    { limit: graderChatMessagesPerDay(env), reservationIdentifier, day },
    env,
  );
  if (daily === 'misdirected') return 'day-changed';
  if (daily !== 'held') throw graderChatRefusal('grader_chat_daily_limit');
  return 'held';
}

/**
 * Settle a message on both daily counters — counted, failed with its attempt kept, or released with
 * its attempt refunded — keyed by the message's reservation so a repeat, or a hold never taken,
 * changes nothing.
 */
export async function finalizeGraderChatQuota(
  hold: GraderChatQuotaHold,
  outcome: GraderChatSettlementOutcome,
  env: Env,
): Promise<void> {
  const { reservationIdentifier, day } = hold;
  await finalizeSlot(hold.visitorAuthority, { reservationIdentifier, day, outcome }, env);
  await finalizeSlot(
    DAILY_AUTHORITY_NAME,
    { reservationIdentifier, day, outcome, alertEvery: graderChatAlertEvery(env) },
    env,
  );
}

/** One reservation request a daily counter receives. */
export interface DailyChatReserveInput {
  readonly limit: number;
  /** The day's attempts, answered or not, past which the counter refuses; absent for no cap. */
  readonly attemptLimit?: number;
  readonly reservationIdentifier: string;
  /** The UTC day the request captured; a counter whose own day is another refuses the hold. */
  readonly day: string;
}

/**
 * How a daily counter took a hold: held, refused at its answered limit or at its attempt limit, or
 * misdirected to the wrong day.
 */
export type DailyChatReservation = 'held' | 'refused' | 'attempts-exhausted' | 'misdirected';

/** One commit or release a daily counter receives; only the deployment counter raises alerts. */
export interface DailyChatFinalizeInput {
  readonly reservationIdentifier: string;
  /** The UTC day the hold was taken on, whose entry it settles on. */
  readonly day: string;
  readonly outcome: GraderChatSettlementOutcome;
  readonly alertEvery?: number;
}

interface DailyChatAlert {
  /** The counter's day and the threshold, `YYYY-MM-DD:<count>`, unique across a rollover. */
  readonly id: string;
  readonly count: number;
  readonly queuedAt: number;
  readonly retryAt: number;
}

interface DailyChatDay {
  readonly count: number;
  /** Holds taken that day, answered or not, less those released before any model call. */
  readonly attempts: number;
  /** Reservation identifier to the epoch millisecond it was admitted. */
  readonly pending: Readonly<Record<string, number>>;
  /** The highest alert threshold already queued for that day. */
  readonly alertedThrough: number;
}

interface DailyChatCounter {
  /** Each UTC day still counting or still holding a message, by `YYYY-MM-DD`. */
  readonly days: Readonly<Record<string, DailyChatDay>>;
  /** Alerts queued for the counter's alarm to deliver, oldest first. */
  readonly alertOutbox?: readonly DailyChatAlert[];
}

const FRESH_DAY: DailyChatDay = { count: 0, attempts: 0, pending: {}, alertedThrough: 0 };

/** The single-day record an earlier worker stored, which the counter reads and upgrades. */
interface FlatDailyChatCounter {
  readonly day: string;
  readonly count: number;
  readonly attempts?: number;
  readonly pending: Readonly<Record<string, number>>;
  readonly alertedThrough: number;
  readonly alertOutbox?: readonly (Omit<DailyChatAlert, 'id'> & { readonly id?: string })[];
}

/** Whether an internal reserve body is well formed. */
export function isDailyChatReserveInput(value: unknown): value is DailyChatReserveInput {
  const input = asRecord(value);
  return (
    input !== null &&
    Number.isSafeInteger(input.limit) &&
    typeof input.limit === 'number' &&
    input.limit > 0 &&
    isReservationIdentifier(input.reservationIdentifier) &&
    (input.attemptLimit === undefined ||
      (Number.isSafeInteger(input.attemptLimit) &&
        typeof input.attemptLimit === 'number' &&
        input.attemptLimit > 0)) &&
    isUtcDay(input.day)
  );
}

/** Whether an internal finalize body is well formed. */
export function isDailyChatFinalizeInput(value: unknown): value is DailyChatFinalizeInput {
  const input = asRecord(value);
  return (
    input !== null &&
    isReservationIdentifier(input.reservationIdentifier) &&
    isUtcDay(input.day) &&
    (input.outcome === 'answered' || input.outcome === 'failed' || input.outcome === 'released') &&
    (input.alertEvery === undefined ||
      (Number.isSafeInteger(input.alertEvery) &&
        typeof input.alertEvery === 'number' &&
        input.alertEvery > 0))
  );
}

/**
 * Atomically hold one slot of a daily counter for the request's captured day. A request dated
 * another day than the counter's own UTC day is misdirected and holds nothing, so one visitor's day
 * never lands on another day's counter. Every hold counts against its day's limit until it is
 * explicitly committed or released, however long that takes, so the counter never admits past its
 * limit; a new day starts its own entry and leaves an earlier day's held messages to settle there.
 */
export async function reserveDailyChatSlot(
  storage: DurableObjectStorage,
  input: DailyChatReserveInput,
): Promise<DailyChatReservation> {
  const now = Date.now();
  const day = utcDay(now);
  if (input.day !== day) return 'misdirected';
  return storage.transaction(async (transaction) => {
    const stored = (await readCounter(transaction)) ?? { days: {} };
    const current = stored.days[day] ?? FRESH_DAY;
    if (current.pending[input.reservationIdentifier] !== undefined) return 'held';
    if (current.count + Object.keys(current.pending).length >= input.limit) return 'refused';
    if (input.attemptLimit !== undefined && current.attempts >= input.attemptLimit) {
      return 'attempts-exhausted';
    }
    await transaction.put(STORAGE_KEY, {
      ...stored,
      days: {
        ...stored.days,
        [day]: {
          ...current,
          attempts: current.attempts + 1,
          pending: { ...current.pending, [input.reservationIdentifier]: now },
        },
      },
    } satisfies DailyChatCounter);
    return 'held';
  });
}

/**
 * Atomically settle one held slot on the day that admitted it, once: answered counts it, failed
 * keeps its attempt charged, and released refunds the attempt; a repeated finalization, or one the
 * counter never held, changes nothing. An answered message on the deployment counter that reaches
 * an alert threshold its day has not alerted queues that alert, under the day's id, in the
 * counter's own outbox in the same transaction. Returns whether it queued one.
 */
export async function finalizeDailyChatSlot(
  storage: DurableObjectStorage,
  input: DailyChatFinalizeInput,
): Promise<boolean> {
  const now = Date.now();
  return storage.transaction(async (transaction) => {
    const stored = await readCounter(transaction);
    const held = stored?.days[input.day];
    if (!stored || !held || held.pending[input.reservationIdentifier] === undefined) return false;
    const { [input.reservationIdentifier]: _settled, ...pending } = held.pending;
    const answered = input.outcome === 'answered';
    const count = held.count + (answered ? 1 : 0);
    const threshold =
      answered && input.alertEvery !== undefined
        ? Math.floor(count / input.alertEvery) * input.alertEvery
        : 0;
    const alert = threshold > held.alertedThrough ? threshold : null;
    await transaction.put(STORAGE_KEY, {
      ...stored,
      days: {
        ...stored.days,
        [input.day]: {
          count,
          attempts: Math.max(0, held.attempts - (input.outcome === 'released' ? 1 : 0)),
          pending,
          alertedThrough: alert ?? held.alertedThrough,
        },
      },
      ...(alert === null
        ? {}
        : {
            alertOutbox: [
              ...(stored.alertOutbox ?? []),
              { id: `${input.day}:${alert}`, count: alert, queuedAt: now, retryAt: now },
            ],
          }),
    } satisfies DailyChatCounter);
    return alert !== null;
  });
}

/**
 * Deliver every due alert in a daily counter's outbox. A delivered or permanently refused alert
 * leaves the outbox; one that may succeed later is retried a minute later, for up to a day.
 */
export async function drainDailyChatAlerts(
  storage: DurableObjectStorage,
  env: Env,
  log: Logger,
): Promise<void> {
  const stored = await readCounter(storage);
  const now = Date.now();
  const due = (stored?.alertOutbox ?? []).filter((alert) => alert.retryAt <= now);
  for (const alert of due) {
    let settled: boolean;
    if (now - alert.queuedAt > DAY_MILLISECONDS) {
      log.error('A grader chat volume alert could not be delivered for a day; it was dropped', {
        count: alert.count,
      });
      settled = true;
    } else {
      const delivery = await notifyGraderChatVolume(
        { count: alert.count, limit: graderChatMessagesPerDay(env) },
        env,
        log,
      );
      settled = delivery !== 'retry';
    }
    await storage.transaction(async (transaction) => {
      const current = await readCounter(transaction);
      if (!current?.alertOutbox?.some((entry) => entry.id === alert.id)) return;
      const outbox = settled
        ? current.alertOutbox.filter((entry) => entry.id !== alert.id)
        : current.alertOutbox.map((entry) =>
            entry.id === alert.id
              ? { ...entry, retryAt: Date.now() + ALERT_RETRY_MILLISECONDS }
              : entry,
          );
      const { alertOutbox: _previous, ...counter } = current;
      await transaction.put(STORAGE_KEY, {
        ...counter,
        ...(outbox.length > 0 ? { alertOutbox: outbox } : {}),
      } satisfies DailyChatCounter);
    });
  }
}

/**
 * Drop each past day of a daily counter that holds no message, or whose held messages outlived
 * every settlement that could still reach them, and remove the record once no day and no queued
 * alert remain. A past day keeps its held messages until they settle, so an answer that lands after
 * midnight still counts, and alerts, on the day that admitted it.
 */
export async function expireDailyChatCounter(storage: DurableObjectStorage): Promise<void> {
  const now = Date.now();
  await storage.transaction(async (transaction) => {
    const stored = await readCounter(transaction);
    if (!stored) return;
    const today = utcDay(now);
    const days = Object.fromEntries(
      Object.entries(stored.days).filter(
        ([day, entry]) =>
          day === today ||
          (Object.keys(entry.pending).length > 0 && now < pastDayRetainedUntil(day)),
      ),
    );
    if (Object.keys(days).length === 0 && !stored.alertOutbox?.length) {
      await transaction.delete(STORAGE_KEY);
      return;
    }
    if (Object.keys(days).length !== Object.keys(stored.days).length) {
      await transaction.put(STORAGE_KEY, { ...stored, days } satisfies DailyChatCounter);
    }
  });
}

/**
 * When a daily counter's alarm should next run: its earliest queued alert, the end of today, or
 * when a past day can be dropped; `null` when it holds no record.
 */
export async function dailyChatCounterAlarmAt(
  storage: DurableObjectStorage,
): Promise<number | null> {
  const stored = await readCounter(storage);
  if (!stored) return null;
  const now = Date.now();
  const today = utcDay(now);
  const candidates = (stored.alertOutbox ?? []).map((alert) => alert.retryAt);
  for (const [day, entry] of Object.entries(stored.days)) {
    if (day === today) candidates.push((Math.floor(now / DAY_MILLISECONDS) + 1) * DAY_MILLISECONDS);
    else if (Object.keys(entry.pending).length === 0) candidates.push(now);
    else candidates.push(pastDayRetainedUntil(day));
  }
  if (candidates.length === 0) return now;
  return Math.max(now, Math.min(...candidates));
}

function pastDayRetainedUntil(day: string): number {
  return (
    Date.parse(`${day}T00:00:00Z`) + 2 * DAY_MILLISECONDS + PAST_DAY_SETTLEMENT_GRACE_MILLISECONDS
  );
}

async function readCounter(
  storage: DurableObjectStorage | DurableObjectTransaction,
): Promise<DailyChatCounter | undefined> {
  const stored = await storage.get<DailyChatCounter | FlatDailyChatCounter>(STORAGE_KEY);
  if (stored === undefined || 'days' in stored) return stored;
  const { day, count, attempts, pending, alertedThrough, alertOutbox } = stored;
  return {
    days: {
      [day]: {
        count,
        attempts: attempts ?? count + Object.keys(pending).length,
        pending,
        alertedThrough,
      },
    },
    ...(alertOutbox?.length
      ? {
          alertOutbox: alertOutbox.map((alert) => ({
            ...alert,
            id: alert.id ?? `${day}:${alert.count}`,
          })),
        }
      : {}),
  };
}

function isUtcDay(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value);
}

async function reserveSlot(
  authorityName: string,
  input: DailyChatReserveInput,
  env: Env,
): Promise<DailyChatReservation> {
  const response = await counterFetch(authorityName, GRADER_CHAT_QUOTA_RESERVE_PATH, input, env);
  if (response.status === 429) return 'refused';
  if (response.status === 421) return 'misdirected';
  if (response.status === 402) return 'attempts-exhausted';
  if (!response.ok) throw counterFailure(response.status);
  return 'held';
}

async function finalizeSlot(
  authorityName: string,
  input: DailyChatFinalizeInput,
  env: Env,
): Promise<void> {
  const response = await counterFetch(authorityName, GRADER_CHAT_QUOTA_FINALIZE_PATH, input, env);
  if (!response.ok) throw counterFailure(response.status);
}

async function counterFetch(
  authorityName: string,
  path: string,
  input: DailyChatReserveInput | DailyChatFinalizeInput,
  env: Env,
): Promise<Response> {
  const namespace = auditSessionAuthority(env);
  return namespace
    .get(namespace.idFromName(authorityName))
    .fetch(`${inferenceQuotaInternalOrigin(env)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
}

function counterFailure(status: number): WorkerError {
  return new WorkerError('The grader chat quota authority rejected the request.', {
    status: 500,
    exceptionType: 'AuditSessionAuthorityException',
    messageDetail: `Internal authority status ${status}`,
  });
}

function utcDay(epochMilliseconds: number): string {
  return new Date(epochMilliseconds).toISOString().slice(0, 10);
}

function isReservationIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
