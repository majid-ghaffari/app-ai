/**
 * `.githooks/pre-push` as committed, driven the way git drives it: the pushed refs on stdin. Every
 * branch push runs the typecheck and lint gate; a push of tags or deletions only skips it and says
 * why; missing tooling fails with the install command; and the shared gate still receives every ref
 * line and still blocks the push when it refuses.
 */
import { describe, expect, it } from 'vitest';

import { runPrePush } from './pre-push-hook-harness.mjs';

const ZERO = '0'.repeat(40);
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const GATE = ['npm run typecheck', 'npm run lint', ''].join('\n');

const TAG_PUSH = `refs/tags/preview-growth-agents ${NEW} refs/tags/preview-growth-agents ${ZERO}`;
const TAG_DELETION = `(delete) ${ZERO} refs/tags/preview-growth-agents ${OLD}`;
const BRANCH_DELETION = `(delete) ${ZERO} refs/heads/aidin/1-feature ${OLD}`;
const FEATURE_PUSH = `refs/heads/aidin/1-feature ${NEW} refs/heads/aidin/1-feature ${OLD}`;
const MAIN_PUSH = `refs/heads/main ${NEW} refs/heads/main ${OLD}`;

describe('pre-push — pushes that carry no branch update skip the gate', () => {
  it.each([
    ['a tag push', [TAG_PUSH]],
    ['a tag deletion', [TAG_DELETION]],
    ['a branch deletion', [BRANCH_DELETION]],
    ['tags and deletions together', [TAG_PUSH, TAG_DELETION, BRANCH_DELETION]],
  ])('%s runs no typecheck or lint and says why', (_name, refLines) => {
    const run = runPrePush(refLines);
    expect(run.status, run.stderr).toBe(0);
    expect(run.npmCalls).toBe('');
    expect(run.stderr).toMatch(/updates no branch/);
  });

  it('skips even where nothing is installed, because nothing would run', () => {
    const run = runPrePush([TAG_DELETION], { installed: false });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toMatch(/npm ci/);
  });
});

describe('pre-push — every branch push runs the gate', () => {
  it.each([
    ['a feature-branch push', [FEATURE_PUSH]],
    ['a main push', [MAIN_PUSH]],
    ['a branch push beside a tag push', [TAG_PUSH, FEATURE_PUSH]],
  ])('%s runs typecheck then lint', (_name, refLines) => {
    const run = runPrePush(refLines);
    expect(run.status, run.stderr).toBe(0);
    expect(run.npmCalls).toBe(GATE);
  });

  it('blocks the push when typecheck fails, before lint runs', () => {
    const run = runPrePush([FEATURE_PUSH], { npmFailsOn: 'typecheck' });
    expect(run.status).toBe(1);
    expect(run.npmCalls).toBe('npm run typecheck\n');
    expect(run.stderr).toMatch(/typecheck failed/);
  });

  it('fails with the install command, not a raw command-not-found, when the tools are missing', () => {
    const run = runPrePush([FEATURE_PUSH], { installed: false });
    expect(run.status).toBe(1);
    expect(run.npmCalls).toBe('');
    expect(run.stderr).toMatch(/tsc is not installed in this checkout\. Run npm ci/);
    expect(run.stderr).not.toMatch(/command not found/);
  });
});

describe('pre-push — the shared gate', () => {
  it('receives every pushed ref line unchanged', () => {
    const refLines = [TAG_PUSH, TAG_DELETION, FEATURE_PUSH];
    expect(runPrePush(refLines).sharedGateInput).toBe(refLines.map((line) => `${line}\n`).join(''));
  });

  it('still blocks the push when it refuses, and nothing else runs', () => {
    const run = runPrePush([MAIN_PUSH], { sharedGateStatus: 1 });
    expect(run.status).toBe(1);
    expect(run.npmCalls).toBe('');
    expect(run.sharedGateInput).toBe(`${MAIN_PUSH}\n`);
  });
});
