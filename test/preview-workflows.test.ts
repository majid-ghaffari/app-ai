/**
 * The `preview-<name>` tag workflows as committed: each credential reaches only the steps that use
 * it, a redeploy withdraws the registry entry before Wrangler replaces the Preview and registers it
 * again only after both probes see this run's revision, the registered host is the workers.dev form
 * of the admin Chrome extension's App AI allowlist, Wrangler runs only on the Preview ID
 * `scripts/preview-ownership.mjs` claimed, and a tag deletion goes through that script. The probe
 * and deploy steps run here as committed, under bash with stubbed commands.
 */
import { describe, expect, it } from 'vitest';

import deleteWorkflow from '../.github/workflows/preview-delete.yml?raw';
import deployWorkflow from '../.github/workflows/preview-deploy.yml?raw';
import { runStep } from './workflow-step-harness.mjs';

interface WorkflowStep {
  readonly name: string;
  readonly text: string;
}

/** The workflow's one job: everything before its `steps:` key, and each step by name or action. */
function splitJob(workflow: string): { preamble: string; steps: readonly WorkflowStep[] } {
  const stepsKey = '\n    steps:\n';
  const at = workflow.indexOf(stepsKey);
  if (at === -1 || workflow.indexOf(stepsKey, at + 1) !== -1) {
    throw new Error('expected a workflow with exactly one job and one steps list');
  }
  const steps = workflow
    .slice(at + stepsKey.length)
    .split(/\n(?= {6}- )/)
    .map((text) => {
      const header = text.match(/^ {6}- (?:name|uses): (.+)$/m)?.[1];
      if (!header) throw new Error(`step without a name or action: ${text.slice(0, 80)}`);
      return { name: header, text };
    });
  return { preamble: workflow.slice(0, at), steps };
}

/** One workflow's steps, looked up by name; a missing step fails the test that asks for it. */
function stepLookup(workflow: string, file: string) {
  const { steps } = splitJob(workflow);
  const indexOf = (name: string): number => {
    const index = steps.findIndex((step) => step.name === name);
    if (index === -1) throw new Error(`${file} has no step "${name}"`);
    return index;
  };
  const stepText = (name: string): string => steps[indexOf(name)]?.text ?? '';
  return { steps, indexOf, stepText };
}

/** A step's `run: |` block, de-indented, as the runner hands it to bash. */
function runBlock(stepText: string): string {
  const key = 'run: |\n';
  const at = stepText.indexOf(key);
  if (at === -1) throw new Error(`step without a run block: ${stepText.slice(0, 80)}`);
  const lines = stepText
    .slice(at + key.length)
    .replace(/\n+$/, '')
    .split('\n');
  const indent = lines[0]?.match(/^ */)?.[0].length ?? 0;
  return `${lines.map((line) => line.slice(indent)).join('\n')}\n`;
}

function secretsOf(text: string): readonly string[] {
  return [
    ...new Set([...text.matchAll(/secrets\.([A-Z_]+)/g)].map((match) => match[1] ?? '')),
  ].sort();
}

const WORKFLOWS = [
  {
    file: 'preview-deploy.yml',
    workflow: deployWorkflow,
    consumers: new Map([
      ['Withdraw the registry entry', ['PREVIEW_ADMIN_SECRET']],
      ['Deploy the Worker Preview', ['CLOUDFLARE_API_TOKEN']],
      ['Register in preview registry', ['PREVIEW_ADMIN_SECRET']],
    ]),
  },
  {
    file: 'preview-delete.yml',
    workflow: deleteWorkflow,
    consumers: new Map([
      ['Unregister from preview registry', ['PREVIEW_ADMIN_SECRET']],
      ['Delete the owned Worker Preview', ['CLOUDFLARE_API_TOKEN']],
    ]),
  },
] as const;

describe('preview tag workflows — credential scope', () => {
  for (const { file, workflow, consumers } of WORKFLOWS) {
    it(`${file} hands each credential only to the steps that use it`, () => {
      const { preamble, steps } = splitJob(workflow);
      expect(secretsOf(preamble), `${file}: workflow or job scope`).toEqual([]);
      for (const step of steps) {
        expect(secretsOf(step.text), `${file}: step "${step.name}"`).toEqual(
          [...(consumers.get(step.name) ?? [])].sort(),
        );
      }
      expect(steps.map((step) => step.name)).toEqual(expect.arrayContaining([...consumers.keys()]));
    });
  }

  it('preview-deploy.yml installs without lifecycle scripts', () => {
    const install = splitJob(deployWorkflow).steps.find(
      (step) => step.name === 'Install dependencies',
    );
    expect(install?.text).toMatch(/^ +run: npm ci --ignore-scripts$/m);
    expect(deployWorkflow).not.toMatch(/npm ci(?! --ignore-scripts)/);
  });

  it('preview-delete.yml installs nothing', () => {
    expect(deleteWorkflow).not.toMatch(/\bnpm\b|\bnpx\b/);
  });
});

describe('preview-deploy.yml — advertisement and host', () => {
  const { steps, indexOf, stepText } = stepLookup(deployWorkflow, 'preview-deploy.yml');

  it('withdraws the registry entry before the deploy and registers only after both probes', () => {
    expect(indexOf('Withdraw the registry entry')).toBeLessThan(
      indexOf('Deploy the Worker Preview'),
    );
    expect(indexOf('Deploy the Worker Preview')).toBeLessThan(indexOf('Probe the Preview'));
    expect(indexOf('Probe the Preview')).toBeLessThan(indexOf('Register in preview registry'));
    expect(stepText('Withdraw the registry entry')).toMatch(
      /-X DELETE[\s\S]*"\$PREVIEW_REGISTRY_URL\/previews\/app-ai\/\$PREVIEW_NAME"/,
    );
    expect(stepText('Withdraw the registry entry')).toContain(
      `[ "$(echo "$resp" | jq -r '.ok')" = "true" ] || { echo "Registry withdrawal failed: $resp" >&2; exit 1; }`,
    );
    expect(stepText('Probe the Preview')).toContain('"$PREVIEW_URL/health"');
    expect(stepText('Probe the Preview')).toContain('"$PREVIEW_URL/prompts"');
    expect(stepText('Register in preview registry')).toContain('-X POST');
    const deploys = steps.filter((step) => step.text.includes('deploy:preview'));
    expect(deploys.map((step) => step.name)).toEqual(['Deploy the Worker Preview']);
  });

  it('registers only the workers.dev host of the admin Chrome extension App AI allowlist', () => {
    const deploy = stepText('Deploy the Worker Preview');
    // admin-chrome-extension lib/previewRegistry.ts, the workers.dev App AI host pattern.
    expect(deploy).toContain(
      String.raw`EXTENSION_HOST_RE='^[a-z0-9][a-z0-9-]*-app-ai\.floral-rice-85c3\.workers\.dev$'`,
    );
    expect(deploy).toContain(
      'EXPECTED_URL="https://${PREVIEW_NAME}-app-ai.floral-rice-85c3.workers.dev"',
    );
    expect(deployWorkflow).not.toMatch(/\[a-z0-9-\]\+\\\\?\.workers/);
    expect(stepText('Register in preview registry')).toContain(
      'PREVIEW_URL: ${{ steps.preview.outputs.url }}',
    );
  });
});

describe('preview-deploy.yml — the registered revision', () => {
  const { stepText } = stepLookup(deployWorkflow, 'preview-deploy.yml');
  const probe = runBlock(stepText('Probe the Preview'));

  /** A curl stub answering each /health call with the next revision, and /prompts with 401. */
  function curlServing(revisions: readonly string[]): string {
    return [
      'out=; url=; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done',
      'case "$url" in',
      '  */health) n=$(grep -c "/health" "$RUNNER_TEMP/calls.log")',
      `    revs=(${revisions.join(' ')})`,
      '    [ "$n" -le "${#revs[@]}" ] || n=${#revs[@]}',
      '    rev="${revs[$((n - 1))]}"',
      `    printf '{"ok":true,"buildRev":"%s"}' "$rev" > "$out"; printf 200 ;;`,
      `  */prompts) printf '{}' > "$out"; printf 401 ;;`,
      'esac',
    ].join('\n');
  }
  const probeEnv = {
    PREVIEW_URL: 'https://foo-app-ai.floral-rice-85c3.workers.dev',
    PREVIEW_NAME: 'foo',
    GITHUB_SHA: 'abc1234def5678',
  };
  const stubs = { git: 'echo abc1234', sleep: ':' };

  it('checks out the event commit, not the movable tag', () => {
    expect(stepText('actions/checkout@v4')).toMatch(/^ +ref: \$\{\{ github\.sha \}\}$/m);
    expect(deployWorkflow).not.toContain('github.ref }}');
  });

  it('passes only once /health serves this run’s revision', () => {
    const run = runStep(probe, { ...stubs, curl: curlServing(['0ld0000', 'abc1234']) }, probeEnv);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.calls.match(/workers\.dev\/health$/gm)).toHaveLength(2);
  });

  it('fails while every 200 serves an earlier revision', () => {
    const run = runStep(probe, { ...stubs, curl: curlServing(['0ld0000']) }, probeEnv);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("serving revision '0ld0000', not abc1234");
    expect(run.calls).not.toContain('/prompts');
  });
});

describe('ownership — the tag workflows act only on a Preview they created', () => {
  const OWNER_OUTPUT = 'echo "owner=app-ai:${NAME}:${TAG}" >> "$GITHUB_OUTPUT"';
  const NAMESPACE_ENV =
    'PREVIEW_REGISTRY_KV_NAMESPACE_ID: ${{ vars.PREVIEW_REGISTRY_KV_NAMESPACE_ID }}';
  const ID = '63bafce9179948688866bb22268eb1c6';
  const SHA = 'a'.repeat(40);
  const deploy = stepLookup(deployWorkflow, 'preview-deploy.yml');
  const teardown = stepLookup(deleteWorkflow, 'preview-delete.yml');
  const script = runBlock(deploy.stepText('Deploy the Worker Preview'));
  const env = {
    CLOUDFLARE_API_TOKEN: 'token',
    PREVIEW_NAME: 'foo',
    OWNER_MARKER: 'app-ai:foo:preview-foo',
    GITHUB_REF_NAME: 'preview-foo',
    GITHUB_SHA: SHA,
  };
  const wranglerPrinting = (id: string) =>
    `cat <<'JSON'\n${JSON.stringify({
      preview: { id, name: 'foo', urls: ['https://foo-app-ai.floral-rice-85c3.workers.dev'] },
      deployment: { annotations: { 'workers/tag': 'app-ai:foo:preview-foo' } },
    })}\nJSON`;

  it('labels every deployment with the marker and registers only a deployment carrying it', () => {
    expect(deploy.stepText('Parse tag')).toContain(OWNER_OUTPUT);
    const step = deploy.stepText('Deploy the Worker Preview');
    expect(step).toContain(NAMESPACE_ENV);
    expect(step).toContain('--name "$PREVIEW_ID" --tag "$OWNER_MARKER" --json');
    const readBack = step.indexOf(`'.deployment.annotations["workers/tag"] == $owner'`);
    expect(readBack).toBeGreaterThan(step.indexOf('deploy:preview'));
    expect(readBack).toBeLessThan(step.indexOf('>> "$GITHUB_OUTPUT"'));
  });

  it('never runs Wrangler when the ownership claim refuses', () => {
    const refused = runStep(script, { node: 'exit 1', npm: 'exit 0' }, env);
    expect(refused.status).toBe(1);
    expect(refused.calls).toBe(
      `node scripts/preview-ownership.mjs claim --name foo --tag preview-foo --commit ${SHA}\n`,
    );
  });

  it('deploys by the claimed ID and registers nothing when Wrangler answers another Preview', () => {
    const owned = runStep(script, { node: `echo ${ID}`, npm: wranglerPrinting(ID) }, env);
    expect(owned.status).toBe(0);
    expect(owned.calls).toContain(
      `npm run --silent deploy:preview -- --name ${ID} --tag app-ai:foo:preview-foo --json`,
    );
    const other = runStep(
      script,
      { node: `echo ${ID}`, npm: wranglerPrinting('0f1e2d3c4b5a69788796a5b4c3d2e1f0') },
      env,
    );
    expect(other.status).toBe(1);
    expect(other.stderr).toContain('nothing is registered');
  });

  it('unregisters first, then deletes only through the recorded ID', () => {
    expect(teardown.indexOf('Unregister from preview registry')).toBeLessThan(
      teardown.indexOf('Delete the owned Worker Preview'),
    );
    expect(teardown.stepText('Parse deleted tag')).toContain('echo "tag=$TAG" >> "$GITHUB_OUTPUT"');
    const step = teardown.stepText('Delete the owned Worker Preview');
    expect(step).toContain(NAMESPACE_ENV);
    expect(step).toMatch(
      /^ +run: node scripts\/preview-ownership\.mjs delete --name "\$PREVIEW_NAME" --tag "\$PREVIEW_TAG"$/m,
    );
    expect(step).toContain('CLOUDFLARE_API_BASE_URL: https://api.cloudflare.com/client/v4');
    expect(deleteWorkflow).not.toMatch(/wrangler|workers\/workers/);
  });
});
