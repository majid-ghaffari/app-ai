/**
 * Production and preview deployment launcher.
 *
 * A raw `wrangler deploy` omits `__APP_AI_REV__`, making production `/health` fail closed and
 * destroying the ability to identify the exact served code. Resolve the repository revision
 * before spawning Wrangler and fail closed if it cannot be determined.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  composeRevisionedPreviewsDefine,
  composeRevisionedWranglerArgs,
  resolveShortRev,
} from './dev.mjs';

const WRANGLER_CONFIG_PATH = fileURLToPath(new URL('../wrangler.toml', import.meta.url));

/**
 * The gitignored copy of `wrangler.toml` that `wrangler preview` reads. It sits beside the original
 * so every relative path in it resolves the same, and it exists only while the command runs.
 */
export const PREVIEW_CONFIG_PATH = fileURLToPath(
  new URL('../.wrangler-preview.toml', import.meta.url),
);

export function composeWranglerDeployArgs(rev, extraArgs = []) {
  return composeRevisionedWranglerArgs('deploy', rev, extraArgs);
}

/** Compose a Cloudflare Worker Preview deployment, read from the revision-stamped copy. */
export function composeWranglerPreviewArgs(extraArgs = []) {
  return ['preview', '--config', PREVIEW_CONFIG_PATH, ...extraArgs];
}

/**
 * `wrangler preview` takes no `--define` and bundles with `previews.define` alone, so the revision
 * is appended there, to a copy of the configuration and never to the committed file.
 */
export function composePreviewConfig(wranglerToml, rev) {
  if (/^\[previews\.define\]\s*$/m.test(wranglerToml)) {
    throw new Error('wrangler.toml declares [previews.define]; the preview launcher owns it.');
  }
  return `${wranglerToml.replace(/\n*$/, '\n')}\n${composeRevisionedPreviewsDefine(rev)}`;
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
  if (invocation.preview) {
    writeFileSync(
      PREVIEW_CONFIG_PATH,
      composePreviewConfig(readFileSync(WRANGLER_CONFIG_PATH, 'utf8'), rev),
    );
  }
  const removePreviewConfig = () => {
    if (invocation.preview) rmSync(PREVIEW_CONFIG_PATH, { force: true });
  };
  const wranglerArgs = invocation.preview
    ? composeWranglerPreviewArgs(invocation.extraArgs)
    : composeWranglerDeployArgs(rev, invocation.extraArgs);
  const child = spawn('wrangler', wranglerArgs, { stdio: 'inherit' });
  child.on('error', (error) => {
    removePreviewConfig();
    console.error('[app-ai deploy] Failed to launch wrangler:', error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    removePreviewConfig();
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
