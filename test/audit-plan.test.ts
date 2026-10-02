import { describe, expect, it } from 'vitest';

import {
  auditRunCeiling,
  declaredAuditPlanVersion,
  GRADER_CHAT_MESSAGE_CEILING,
  GRADER_TILES_PER_WIDTH,
  graderChatMessageAllowance,
  isSupportedAuditPlanVersion,
  planIncludesGraderChat,
  PLANNED_AUDIT_RUN,
  PROPOSAL_PAGE_VOCABULARY,
  SUPPORTED_AUDIT_PLAN_VERSIONS,
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

describe('grader plan versions', () => {
  it('holds an allowance for plan versions 1 and 2, and a request naming none follows plan 1', () => {
    expect([...SUPPORTED_AUDIT_PLAN_VERSIONS]).toEqual([1, 2]);
    expect(declaredAuditPlanVersion(null)).toBe(1);
    expect(declaredAuditPlanVersion('1')).toBe(1);
    expect(declaredAuditPlanVersion('2')).toBe(2);
    for (const declared of ['3', '0', '02', '2.0', 'v2', '']) {
      expect(isSupportedAuditPlanVersion(declared), declared).toBe(false);
      expect(() => declaredAuditPlanVersion(declared), declared).toThrow(/not supported/);
    }
  });

  it('shares one capture plan across both versions and adds the chat only in version 2', () => {
    expect(planIncludesGraderChat(1)).toBe(false);
    expect(planIncludesGraderChat(2)).toBe(true);
    expect(auditRunCeiling(ENV)).toEqual({ uploads: 672, inferences: 66 });
  });

  it("holds an audit's chat allowance, across its runs and sessions, under version 2's hard ceiling of 50 messages", () => {
    expect(GRADER_CHAT_MESSAGE_CEILING).toBe(50);
    expect(graderChatMessageAllowance(ENV)).toBe(25);
    expect(graderChatMessageAllowance({ ...ENV, GRADER_CHAT_MESSAGES_PER_AUDIT: '50' })).toBe(50);
    expect(() =>
      graderChatMessageAllowance({ ...ENV, GRADER_CHAT_MESSAGES_PER_AUDIT: '51' }),
    ).toThrow(/must not exceed the plan's 50-message chat ceiling/);
  });
});
