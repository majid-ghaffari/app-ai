/**
 * app-ai dev launcher — starts `wrangler dev` with a DETERMINISTIC build-rev define.
 *
 * `src/build-rev.ts` reads the esbuild `--define __APP_AI_REV__` global and falls back to
 * `'dev'` when the define is absent. `/health` returns that as `buildRev`, and the FREE-stack
 * preflight (the lib's `preflightMatrixStack`) rejects a worker whose `buildRev` is `'dev'` /
 * absent / not the expected frozen SHA — a stale worker would invalidate the evidence run.
 *
 * This launcher resolves `git rev-parse --short HEAD` IN NODE (shell-independent) and passes it as
 * `--define __APP_AI_REV__:"<sha>"`, so the marker is injected under ANY launcher (npm, nohup, a
 * background supervisor, a non-shell exec). It FAILS LOUD — a non-zero exit, never a silent
 * no-define — if git cannot resolve a revision, so a worker that would report `buildRev:"dev"` can
 * never start green.
 *
 * The deploy path (`wrangler deploy`) is intentionally left define-less: production is not the
 * exact-marker FREE stack, and `'dev'` there is by design (see `src/build-rev.ts`).
 */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** The esbuild `--define` global name that `src/build-rev.ts` reads. */
const APP_AI_REV_DEFINE = '__APP_AI_REV__';

/**
 * Resolve the short git revision. `runGit` is injectable for tests; by default it runs
 * `git rev-parse --short HEAD`. Throws (fail loud) when git fails OR yields an empty revision —
 * the caller must never fall back to launching without the define.
 */
export function resolveShortRev(
  runGit = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }),
) {
  const rev = String(runGit()).trim();
  if (!rev) {
    throw new Error('git rev-parse --short HEAD produced an empty revision');
  }
  return rev;
}

/** Compose the `wrangler dev` argv with the build-rev define, appending any extra args verbatim. */
export function composeWranglerArgs(rev, extraArgs = []) {
  return ['dev', '--define', `${APP_AI_REV_DEFINE}:"${rev}"`, ...extraArgs];
}

export function main(argv = process.argv.slice(2)) {
  let rev;
  try {
    rev = resolveShortRev();
  } catch (error) {
    console.error(
      `[app-ai dev] Refusing to start: could not resolve the git revision for ${APP_AI_REV_DEFINE}. ` +
        'A worker launched without the define reports buildRev:"dev", which the FREE-stack preflight ' +
        'rejects because a stale worker invalidates the evidence run. Fix the git checkout and retry.',
    );
    console.error(`[app-ai dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
    return;
  }

  const child = spawn('wrangler', composeWranglerArgs(rev, argv), { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error('[app-ai dev] Failed to launch wrangler:', error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

// Run only when executed directly (`node scripts/dev.mjs`), not when imported by a test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
