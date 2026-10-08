import { auditRunHeadroom, graderChatMessagesPerAudit, type Env } from '../config';

/** The page kinds the onboarding proposal prompts plan, named exactly as those prompts name them. */
export const PROPOSAL_PAGE_VOCABULARY = [
  'Home',
  'Product',
  'Collection',
  'Cart',
  'SlidingCart',
  'Search',
  'Blog',
] as const;

/** The request header a Grader client names the audit plan it follows in. */
export const AUDIT_PLAN_VERSION_HEADER = 'X-LimeSpot-Audit-Plan-Version';

/** The audit plan versions this worker holds an allowance for, each documented in docs/AUDIT-AUTH.md. */
export const SUPPORTED_AUDIT_PLAN_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/** The plan a request naming no version follows; only a build naming its build time may name none. */
export const UNDECLARED_AUDIT_PLAN_VERSION = 1;

/** The first plan version whose runs include the Grader's sales chat. */
export const GRADER_CHAT_PLAN_VERSION = 2;

/**
 * The hard ceiling plan version 2 sets on the chat messages one audit is answered across all of its
 * runs and sessions, above any configured allowance; neither a retry nor a reissued link restores a
 * spent message.
 */
export const GRADER_CHAT_MESSAGE_CEILING = 50;

const PROPOSAL_WIDTHS = 2;
const BROWSER_CANVAS_MAX_HEIGHT_PIXELS = 32_767;
const STUDIO_TILE_HEIGHT_PIXELS = 1_500;
const STUDIO_TILE_OVERLAP_PIXELS = 100;
const GRADER_PROPOSAL_REPAIRS = 2;
const GRADER_WHOLE_STORE_SENDS = 4;

/** The most tiles Studio's capture cuts one page at one width into: the tallest raster a browser holds. */
export const GRADER_TILES_PER_WIDTH = Math.ceil(
  (BROWSER_CANVAS_MAX_HEIGHT_PIXELS - STUDIO_TILE_OVERLAP_PIXELS) /
    (STUDIO_TILE_HEIGHT_PIXELS - STUDIO_TILE_OVERLAP_PIXELS),
);

/** The uploads and proposal inferences one grader run plans at most. */
export interface AuditRunAllowance {
  readonly uploads: number;
  readonly inferences: number;
}

/** The most one grader run can need, before any headroom. */
export const PLANNED_AUDIT_RUN: AuditRunAllowance = {
  uploads: PROPOSAL_PAGE_VOCABULARY.length * PROPOSAL_WIDTHS * GRADER_TILES_PER_WIDTH,
  inferences:
    (1 + GRADER_PROPOSAL_REPAIRS) * (GRADER_WHOLE_STORE_SENDS + PROPOSAL_PAGE_VOCABULARY.length),
};

/** One run's abuse ceiling: the planned run times this deployment's headroom. */
export function auditRunCeiling(env: Env): AuditRunAllowance {
  const headroom = auditRunHeadroom(env);
  return {
    uploads: PLANNED_AUDIT_RUN.uploads * headroom,
    inferences: PLANNED_AUDIT_RUN.inferences * headroom,
  };
}

/**
 * Whether a request's declared plan version is one this worker holds an allowance for; a missing
 * declaration follows plan 1, and `assertCompatibleAuditClient` refuses it from a build naming no
 * build time.
 */
export function isSupportedAuditPlanVersion(declared: string | null): boolean {
  if (declared === null) return true;
  return /^[1-9][0-9]*$/u.test(declared) && SUPPORTED_AUDIT_PLAN_VERSIONS.has(Number(declared));
}

/** The plan version a supported declaration names; a missing declaration follows plan 1. */
export function declaredAuditPlanVersion(declared: string | null): number {
  if (!isSupportedAuditPlanVersion(declared)) {
    throw new Error(`Audit plan version "${String(declared)}" is not supported.`);
  }
  return declared === null ? UNDECLARED_AUDIT_PLAN_VERSION : Number(declared);
}

/** Whether a plan version's runs include the Grader's sales chat. */
export function planIncludesGraderChat(planVersion: number): boolean {
  return planVersion >= GRADER_CHAT_PLAN_VERSION;
}

/**
 * How many model calls a chat allowance pays for per answered message: a call that failed or was
 * aborted after provider I/O began counts as an attempt, and attempts are held to this multiple of
 * the answered allowance, per audit and per visitor day.
 */
export const GRADER_CHAT_ATTEMPTS_PER_ANSWER = 2;

/** The chat messages one audit is answered: the deployment's allowance, held under the plan's ceiling. */
export function graderChatMessageAllowance(env: Env): number {
  const configured = graderChatMessagesPerAudit(env);
  if (configured > GRADER_CHAT_MESSAGE_CEILING) {
    throw new Error(
      `GRADER_CHAT_MESSAGES_PER_AUDIT must not exceed the plan's ${GRADER_CHAT_MESSAGE_CEILING}-message chat ceiling.`,
    );
  }
  return configured;
}

/** The model calls one audit's chat may start, answered or not. */
export function graderChatAttemptAllowance(env: Env): number {
  return GRADER_CHAT_ATTEMPTS_PER_ANSWER * graderChatMessageAllowance(env);
}
