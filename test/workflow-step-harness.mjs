/**
 * Runs a workflow step's `run:` script as the runner does (`bash --noprofile --norc -eo pipefail`),
 * with each stub an executable on PATH ahead of the real commands. Every stub appends its name and
 * arguments to `calls.log` before its body runs; the scratch directory is `RUNNER_TEMP`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export function runStep(script, stubs, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'preview-step-'));
  try {
    const calls = join(directory, 'calls.log');
    writeFileSync(calls, '');
    for (const [command, body] of Object.entries(stubs)) {
      const path = join(directory, command);
      writeFileSync(path, `#!/bin/bash\necho "${command} $*" >> "${calls}"\n${body}\n`);
      chmodSync(path, 0o755);
    }
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: {
        PATH: `${directory}:${process.env.PATH ?? ''}`,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: join(directory, 'output'),
        ...env,
      },
    });
    return { status: result.status, stderr: result.stderr, calls: readFileSync(calls, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
