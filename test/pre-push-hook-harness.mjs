/**
 * Runs the committed `.githooks/pre-push` as git does, with the remote's name and URL as arguments
 * and the pushed refs on stdin, inside a scratch workspace: a git repository standing in for this
 * one, beside a stub shared gate at `../_enforcement/git-hooks/pre-push` that saves the refs it is
 * handed and exits with `sharedGateStatus`. `npm` is a stub on PATH that logs each call and fails
 * the script named by `npmFailsOn`; `node_modules/.bin/tsc` and `eslint` exist unless `installed`
 * is false.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../.githooks/pre-push', import.meta.url));

function writeExecutable(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

export function runPrePush(
  refLines,
  { installed = true, sharedGateStatus = 0, npmFailsOn = 'none' } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), 'pre-push-'));
  try {
    const repository = join(workspace, 'app-ai');
    const calls = join(workspace, 'npm-calls.log');
    const sharedGateInput = join(workspace, 'shared-gate-input');
    const env = { PATH: `${join(workspace, 'bin')}:${process.env.PATH ?? ''}`, HOME: workspace };
    writeFileSync(calls, '');

    const init = spawnSync('git', ['init', '--quiet', repository], { encoding: 'utf8', env });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    writeExecutable(
      join(workspace, '_enforcement', 'git-hooks', 'pre-push'),
      `cat > "${sharedGateInput}"\nexit ${sharedGateStatus}`,
    );
    writeExecutable(
      join(workspace, 'bin', 'npm'),
      `echo "npm $*" >> "${calls}"\n[ "$2" != "${npmFailsOn}" ]`,
    );
    if (installed) {
      writeExecutable(join(repository, 'node_modules', '.bin', 'tsc'), 'exit 0');
      writeExecutable(join(repository, 'node_modules', '.bin', 'eslint'), 'exit 0');
    }

    const result = spawnSync(HOOK, ['origin', 'git@github.com:limespot/app-ai.git'], {
      cwd: repository,
      input: refLines.map((line) => `${line}\n`).join(''),
      encoding: 'utf8',
      env,
    });
    if (result.error) throw result.error;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      npmCalls: readFileSync(calls, 'utf8'),
      sharedGateInput: existsSync(sharedGateInput) ? readFileSync(sharedGateInput, 'utf8') : null,
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
