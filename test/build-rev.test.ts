/**
 * F19 — the dev launcher composes a DETERMINISTIC build-rev define, and `BUILD_REV` resolves the
 * injected value (or `'dev'` when the define is absent).
 *
 * Two units, no network / no wrangler spawned:
 *   1. `scripts/dev.mjs` — `resolveShortRev` (fail-loud on a git failure / empty rev),
 *      `composeWranglerArgs` (the exact `--define __APP_AI_REV__:"<sha>"` argv, extras appended),
 *      and `resolveDevLogPath` (override or stable local default).
 *   2. `src/build-rev.ts` — `BUILD_REV` reads the injected `__APP_AI_REV__` global when present and
 *      falls back to `'dev'` only when it is absent.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
// @ts-expect-error — .mjs sibling has no .d.ts; the launcher's pure helpers are exercised structurally.
import { composeWranglerArgs, resolveDevLogPath, resolveShortRev } from '../scripts/dev.mjs';

describe('dev launcher — build-rev define composition (F19)', () => {
  it('composes `--define __APP_AI_REV__:"<sha>"` from a resolved rev', () => {
    expect(composeWranglerArgs('abc1234')).toEqual(['dev', '--define', '__APP_AI_REV__:"abc1234"']);
  });

  it('appends extra argv verbatim after the define', () => {
    expect(composeWranglerArgs('abc1234', ['--port', '9999'])).toEqual([
      'dev',
      '--define',
      '__APP_AI_REV__:"abc1234"',
      '--port',
      '9999',
    ]);
  });

  it('resolves the short rev from an injected git runner (trimmed)', () => {
    expect(resolveShortRev(() => 'fc00704\n')).toBe('fc00704');
  });

  it('FAILS LOUD when git rev-parse throws (never a silent no-define)', () => {
    expect(() =>
      resolveShortRev(() => {
        throw new Error('not a git repository');
      }),
    ).toThrow(/not a git repository/);
  });

  it('FAILS LOUD when git yields an empty revision', () => {
    expect(() => resolveShortRev(() => '   \n')).toThrow(/empty revision/);
  });

  it('uses the stable local dev-log default', () => {
    expect(resolveDevLogPath({})).toBe('app-ai-dev.log');
  });

  it('uses a trimmed APP_AI_DEV_LOG_FILE override', () => {
    expect(resolveDevLogPath({ APP_AI_DEV_LOG_FILE: '  /tmp/app-ai-test.log  ' })).toBe(
      '/tmp/app-ai-test.log',
    );
  });
});

describe('BUILD_REV fallback (src/build-rev.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("resolves to 'dev' when the __APP_AI_REV__ define is absent", async () => {
    vi.resetModules();
    const { BUILD_REV } = await import('../src/build-rev');
    expect(BUILD_REV).toBe('dev');
  });

  it('resolves to the injected value when the define is present', async () => {
    vi.stubGlobal('__APP_AI_REV__', 'fc00704');
    vi.resetModules();
    const { BUILD_REV } = await import('../src/build-rev');
    expect(BUILD_REV).toBe('fc00704');
  });
});
