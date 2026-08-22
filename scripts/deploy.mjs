/**
 * Production deployment launcher.
 *
 * A raw `wrangler deploy` omits `__APP_AI_REV__`, making production `/health` fail closed and
 * destroying the ability to identify the exact served code. Resolve the repository revision
 * before spawning Wrangler and fail closed if it cannot be determined.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { composeRevisionedWranglerArgs, resolveShortRev } from './dev.mjs';

export function composeWranglerDeployArgs(rev, extraArgs = []) {
  return composeRevisionedWranglerArgs('deploy', rev, extraArgs);
}

/** Compose Cloudflare's non-production version upload with the same exact revision marker. */
export function composeWranglerPreviewArgs(rev, extraArgs = []) {
  return ['versions', ...composeRevisionedWranglerArgs('upload', rev, extraArgs)];
}

/**
 * Select the Cloudflare operation. `--preview` belongs to this launcher rather than Wrangler and
 * is removed before the remaining arguments are forwarded verbatim.
 */
export function resolveDeployInvocation(argv) {
  if (argv[0] === '--preview') {
    return { preview: true, extraArgs: argv.slice(1) };
  }
  return { preview: false, extraArgs: argv };
}

export function main(argv = process.argv.slice(2)) {
  let rev;
  try {
    rev = resolveShortRev();
  } catch (error) {
    console.error(
      '[app-ai deploy] Refusing to deploy without an attributable git revision. ' +
        (error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
    return;
  }

  const invocation = resolveDeployInvocation(argv);
  const wranglerArgs = invocation.preview
    ? composeWranglerPreviewArgs(rev, invocation.extraArgs)
    : composeWranglerDeployArgs(rev, invocation.extraArgs);
  const child = spawn('wrangler', wranglerArgs, { stdio: 'inherit' });
  child.on('error', (error) => {
    console.error('[app-ai deploy] Failed to launch wrangler:', error);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
