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

const PROPOSAL_WIDTHS = 2;
const GRADER_TILES_PER_WIDTH = 2;
const GRADER_PROPOSAL_REPAIRS = 2;
const GRADER_PROPOSAL_SENDS = 2;

/** The uploads and proposal inferences one grader run plans at most. */
export interface AuditRunAllowance {
  readonly uploads: number;
  readonly inferences: number;
}

/** The most one grader run can need, before any headroom. */
export const PLANNED_AUDIT_RUN: AuditRunAllowance = {
  uploads: PROPOSAL_PAGE_VOCABULARY.length * PROPOSAL_WIDTHS * GRADER_TILES_PER_WIDTH,
  inferences: (1 + GRADER_PROPOSAL_REPAIRS) * GRADER_PROPOSAL_SENDS,
};

/** One run's abuse ceiling: the planned run times this deployment's headroom. */
export function auditRunCeiling(env: Env): AuditRunAllowance {
  const headroom = auditRunHeadroom(env);
  return {
    uploads: PLANNED_AUDIT_RUN.uploads * headroom,
    inferences: PLANNED_AUDIT_RUN.inferences * headroom,
  };
}
