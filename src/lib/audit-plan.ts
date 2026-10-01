import { auditRunHeadroom, type Env } from '../config';

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
export const SUPPORTED_AUDIT_PLAN_VERSIONS: ReadonlySet<number> = new Set([1]);

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

/** Whether a request's declared plan version is one this worker holds an allowance for; a missing declaration uses the current plan. */
export function isSupportedAuditPlanVersion(declared: string | null): boolean {
  if (declared === null) return true;
  return /^[1-9][0-9]*$/u.test(declared) && SUPPORTED_AUDIT_PLAN_VERSIONS.has(Number(declared));
}
