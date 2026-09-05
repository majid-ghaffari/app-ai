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
import packageManifest from '../package.json';
import ciWorkflow from '../.github/workflows/ci.yml?raw';
import deploymentDocs from '../README.md?raw';
import { composeWranglerArgs, resolveDevLogPath, resolveShortRev } from '../scripts/dev.mjs';
import * as deployLauncher from '../scripts/deploy.mjs';
import { isAttributableBuildRevision } from '../src/build-rev';

const { composeWranglerDeployArgs, composeWranglerPreviewArgs, resolveDeployInvocation } =
  deployLauncher;

const workflowModules = import.meta.glob('../.github/workflows/*.{yml,yaml}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

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

  it('stamps production deploys with the same exact revision', () => {
    expect(composeWranglerDeployArgs('abc1234', ['--dry-run'])).toEqual([
      'deploy',
      '--define',
      '__APP_AI_REV__:"abc1234"',
      '--dry-run',
    ]);
  });

  it('stamps non-production version uploads with the same exact revision', () => {
    expect(composeWranglerPreviewArgs('abc1234', ['--message', 'preview'])).toEqual([
      'versions',
      'upload',
      '--define',
      '__APP_AI_REV__:"abc1234"',
      '--message',
      'preview',
    ]);
  });

  it('consumes the launcher-only --preview mode instead of forwarding it to Wrangler', () => {
    expect(resolveDeployInvocation(['--preview', '--message', 'preview'])).toEqual({
      preview: true,
      extraArgs: ['--message', 'preview'],
    });
    expect(resolveDeployInvocation(['--dry-run'])).toEqual({
      preview: false,
      extraArgs: ['--dry-run'],
    });
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

describe('repo-controlled deploy entry points', () => {
  it('routes deploy, preview, and dry-run scripts through the revision-stamping launcher', () => {
    expect(packageManifest.scripts.deploy).toBe('node scripts/deploy.mjs');
    expect(packageManifest.scripts['deploy:dry-run']).toBe('node scripts/deploy.mjs --dry-run');
    expect(packageManifest.scripts['deploy:preview']).toBe('node scripts/deploy.mjs --preview');
    for (const [name, command] of Object.entries(packageManifest.scripts)) {
      expect(command, `package script ${name} must not bypass the revision launcher`).not.toMatch(
        /(?:^|\s)(?:npx\s+)?wrangler\s+(?:deploy|versions\s+upload)(?:\s|$)/,
      );
    }
  });

  it('makes CI use the stamped dry-run entry point and rejects a raw Wrangler bypass', () => {
    expect(ciWorkflow).toContain('run: npm run deploy:dry-run');
    for (const [path, workflow] of Object.entries(workflowModules)) {
      expect(path, 'workflow scan must name each source').toMatch(/\.ya?ml$/);
      expect(workflow, `${path}: deploy through a revision-stamping package script`).not.toMatch(
        /run:\s*(?:[|>][-+]?\s*)?(?:npx\s+)?wrangler\s+(?:deploy|versions\s+upload)/,
      );
    }
  });

  it('pins the dashboard-owned Workers Builds commands in repository documentation', () => {
    expect(deploymentDocs).toContain('leave **Build command** blank');
    expect(deploymentDocs).toContain('**Deploy command** to exactly `npm run deploy`');
    expect(deploymentDocs).toContain('`npm run deploy:preview`');
    expect(deploymentDocs).toMatch(/does not read them from\s+`wrangler\.toml`/);
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

  it('accepts only real short/full hexadecimal git revisions as attributable', () => {
    expect(isAttributableBuildRevision('fc00704')).toBe(true);
    expect(isAttributableBuildRevision('fc00704a35103f52d955f0c600db8583f4f7a123')).toBe(true);
    expect(isAttributableBuildRevision('dev')).toBe(false);
    expect(isAttributableBuildRevision('')).toBe(false);
    expect(isAttributableBuildRevision('build-123')).toBe(false);
  });
});
