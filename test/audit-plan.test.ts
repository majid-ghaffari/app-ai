import { describe, expect, it } from 'vitest';

import {
  auditRunCeiling,
  GRADER_TILES_PER_WIDTH,
  PLANNED_AUDIT_RUN,
  PROPOSAL_PAGE_VOCABULARY,
} from '../src/lib/audit-plan';
import { onboardingBatch, onboardingBatchAll } from '../src/prompts';
import { ENV } from './helpers';

function pageVocabulary(prompt: string): string[] {
  const section = prompt.split('### Page vocabulary')[1];
  if (section === undefined) throw new Error('the proposal prompt names no page vocabulary');
  const line = section.trim().split('\n')[0] ?? '';
  return [...line.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1] ?? '');
}

describe('grader run plan', () => {
  it('plans exactly the pages the proposal prompts plan', () => {
    expect(pageVocabulary(onboardingBatchAll)).toEqual([...PROPOSAL_PAGE_VOCABULARY]);
    expect(pageVocabulary(onboardingBatch)).toEqual([...PROPOSAL_PAGE_VOCABULARY]);
  });

  it("plans the most tiles Studio's capture cuts one width of a page into", () => {
    expect(GRADER_TILES_PER_WIDTH).toBe(24);
  });

  it('plans every page at both widths with that many tiles, a recapture adding no upload', () => {
    expect(PLANNED_AUDIT_RUN.uploads).toBe(7 * 2 * 24);
  });

  it('plans four whole-store sends and a per-page retry of every page, each repaired at most twice', () => {
    expect(PLANNED_AUDIT_RUN.inferences).toBe((1 + 2) * (4 + 7));
  });

  it('holds one run to the plan times the deployment headroom', () => {
    expect(auditRunCeiling(ENV)).toEqual({ uploads: 672, inferences: 66 });
    expect(auditRunCeiling({ ...ENV, AUDIT_RUN_HEADROOM: '1' })).toEqual(PLANNED_AUDIT_RUN);
  });
});
