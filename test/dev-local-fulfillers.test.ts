/** Canonical local fulfiller contracts. No Codex/Claude process or provider network is used. */

import { access, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  anthropicMessageFromLocalResult,
  assertLocalInferenceChannel,
  codexChildEnvironment,
  codexPromptFrom,
  codexUsageFromJsonl,
  composeCodexExecArgs,
  fulfillLocalOneShot,
  fulfillWithCodex,
  localFulfillerName,
  runCodexProcess,
} from '../scripts/dev-local-fulfillers.mjs';

function fakeCodexChild() {
  const childListeners = new Map<string, (...args: unknown[]) => void>();
  const stdoutListeners = new Map<string, (...args: unknown[]) => void>();
  const stderrListeners = new Map<string, (...args: unknown[]) => void>();
  const stdinListeners = new Map<string, (...args: unknown[]) => void>();
  const child = {
    stdout: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        stdoutListeners.set(event, listener);
      }),
    },
    stderr: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        stderrListeners.set(event, listener);
      }),
    },
    stdin: {
      end: vi.fn(),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        stdinListeners.set(event, listener);
      }),
    },
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      childListeners.set(event, listener);
    }),
    kill: vi.fn(() => true),
  };
  return {
    child,
    emitChild: (event: string, ...args: unknown[]) => childListeners.get(event)?.(...args),
    emitStdout: (value: string) => stdoutListeners.get('data')?.(value),
    emitStderr: (value: string) => stderrListeners.get('data')?.(value),
    emitStdinError: (error: Error) => stdinListeners.get('error')?.(error),
  };
}

describe('local inference channel selection and paid guards', () => {
  it('retains Claude Code by default and accepts an explicit Codex fulfiller', () => {
    expect(localFulfillerName({})).toBe('claude-code');
    expect(localFulfillerName({ LOCAL_AI_FULFILLER: 'codex' })).toBe('codex');
    expect(() => localFulfillerName({ LOCAL_AI_FULFILLER: 'remote' })).toThrow(/Unsupported/);
  });

  it.each([
    ['ANTHROPIC_API_BASE', 'https://api.anthropic.com'],
    ['OPENAI_API_BASE', 'https://api.openai.com'],
  ])('blocks local paid %s without explicit production opt-in', (name, base) => {
    expect(() => assertLocalInferenceChannel({ [name]: base })).toThrow(/AI_CHANNEL=prod/);
    expect(() => assertLocalInferenceChannel({ [name]: base, AI_CHANNEL: 'prod' })).not.toThrow();
  });

  it('allows local provider endpoints without paid opt-in', () => {
    expect(() =>
      assertLocalInferenceChannel({
        ANTHROPIC_API_BASE: 'http://127.0.0.1:8788',
        OPENAI_API_BASE: 'http://localhost:8789',
      }),
    ).not.toThrow();
    expect(() =>
      assertLocalInferenceChannel({ OPENAI_API_BASE: 'https://provider-proxy.example' }),
    ).toThrow(/AI_CHANNEL=prod/);
    expect(() => assertLocalInferenceChannel({ OPENAI_API_BASE: 'not a URL' })).toThrow(
      /absolute URL/,
    );
    expect(() => assertLocalInferenceChannel({ OPENAI_API_BASE: 'file:///tmp/provider' })).toThrow(
      /http or https/,
    );
  });

  it('requires paid opt-in for an API key and exposes only an allowlisted child environment', () => {
    expect(() => codexChildEnvironment({ CODEX_API_KEY: 'paid-key', PATH: '/bin' })).toThrow(
      /AI_CHANNEL=prod/,
    );
    expect(
      codexChildEnvironment({
        AI_CHANNEL: 'prod',
        CODEX_API_KEY: 'paid-key',
        PATH: '/bin',
        HOME: '/safe-home',
        CLAUDE_API_KEY: 'anthropic-secret',
        PERSONALIZER_INTEGRATION_BRIDGE_TOKEN: 'bridge-secret',
        LS_DEV_CONTEXT_ID: 'merchant-secret',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/safe-home', CODEX_API_KEY: 'paid-key' });
  });
});

describe('Codex non-interactive fulfiller', () => {
  it('composes an ephemeral read-only explicit-model/image/schema invocation', () => {
    expect(
      composeCodexExecArgs({
        model: 'gpt-codex-test',
        effort: 'high',
        cwd: '/tmp/work',
        images: ['/tmp/work/a.png'],
        outputSchemaPath: '/tmp/work/schema.json',
        outputPath: '/tmp/work/result.txt',
      }),
    ).toEqual([
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--config',
      'features.shell_tool=false',
      '--config',
      'web_search="disabled"',
      '--config',
      'features.remote_plugin=false',
      '--config',
      'features.apps=false',
      '--config',
      'features.skill_mcp_dependency_install=false',
      '--config',
      'agents.enabled=false',
      '--config',
      'project_doc_max_bytes=0',
      '--config',
      'forced_login_method="chatgpt"',
      '--skip-git-repo-check',
      '--json',
      '--color',
      'never',
      '--model',
      'gpt-codex-test',
      '--cd',
      '/tmp/work',
      '--output-last-message',
      '/tmp/work/result.txt',
      '--config',
      'model_reasoning_effort="high"',
      '--output-schema',
      '/tmp/work/schema.json',
      '--image',
      '/tmp/work/a.png',
      '-',
    ]);
    expect(
      composeCodexExecArgs({
        model: 'gpt-codex-test',
        authMethod: 'api',
        cwd: '/tmp/work',
        outputPath: '/tmp/work/result.txt',
      }),
    ).toContain('forced_login_method="api"');
  });

  it('builds a bounded transcript and normalizes final JSONL usage', () => {
    expect(
      codexPromptFrom({
        system: 'Return JSON',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect this page' },
              { type: 'document', source: { type: 'text', data: 'Page source' } },
            ],
          },
          { role: 'assistant', content: 'Earlier answer' },
        ],
      }),
    ).toContain('<assistant>\nEarlier answer\n</assistant>');
    expect(
      codexPromptFrom({
        system: [{ type: 'text', text: 'System block' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Go' }] }],
      }),
    ).toContain('<system>\nSystem block\n</system>');
    expect(
      codexUsageFromJsonl(
        '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":7,"output_tokens":4}}\n',
      ),
    ).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 7,
    });
  });

  it.each([
    '',
    'not json',
    'null\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
    '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":2}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":-1,"output_tokens":2}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":"2"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n{"type":"item.completed"}',
    '{"type":"turn.failed"}',
  ])('rejects malformed or unsuccessful Codex JSONL: %j', (jsonl) => {
    expect(() => codexUsageFromJsonl(jsonl)).toThrow(/Codex/);
  });

  it('runs one structured visual turn through an injected process and cleans temp artifacts', async () => {
    let workdir = '';
    const run = vi.fn(
      async (
        args: readonly string[],
        prompt: string,
        _abortSignal: AbortSignal | undefined,
        processOptions: { environment: Readonly<Record<string, string>> },
      ) => {
        expect(prompt).toContain('Inspect');
        expect(args).toContain('--image');
        expect(args).toContain('--output-schema');
        expect(args).toContain('model_reasoning_effort="high"');
        workdir = args[args.indexOf('--cd') + 1] ?? '';
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        const schemaPath = args[args.indexOf('--output-schema') + 1];
        const imagePath = args[args.indexOf('--image') + 1];
        if (!outputPath) throw new Error('missing output path');
        if (!schemaPath || !imagePath) throw new Error('missing schema/image path');
        await expect(readFile(schemaPath, 'utf8')).resolves.toBe('{"type":"object"}');
        await expect(readFile(imagePath, 'utf8')).resolves.toBe('hello');
        await writeFile(outputPath, '{"ok":true}', 'utf8');
        expect(processOptions.environment).toEqual({ PATH: '/bin' });
        return {
          stdout: '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}\n',
          stderr: '',
        };
      },
    );
    await expect(
      fulfillWithCodex(
        {
          system: 'Return JSON',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Inspect' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
                },
              ],
            },
          ],
          output_config: {
            effort: 'high',
            format: { type: 'json_schema', schema: { type: 'object' } },
          },
        },
        {
          env: {
            CODEX_LOCAL_MODEL: 'gpt-codex-test',
            PATH: '/bin',
            CLAUDE_API_KEY: 'must-not-leak',
          },
          run,
        },
      ),
    ).resolves.toEqual({
      text: '{"ok":true}',
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    expect(run).toHaveBeenCalledOnce();
    await expect(access(workdir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ])('writes accepted %s image input with a truthful extension', async (mediaType, extension) => {
    const run = vi.fn(async (args: readonly string[]) => {
      const imagePath = args[args.indexOf('--image') + 1];
      expect(imagePath).toMatch(new RegExp(`\\.${extension}$`));
      return {
        text: 'ok',
        stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
        stderr: '',
      };
    });
    await fulfillWithCodex(
      {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: 'aGVsbG8=' },
              },
            ],
          },
        ],
      },
      { env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' }, run },
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it('dispatches Claude Code and Codex through one canonical local result contract', async () => {
    const claudeCode = vi.fn(async () => ({
      model: 'claude-local',
      content: [{ type: 'text' as const, text: 'claude result' }],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }));
    await expect(fulfillLocalOneShot({}, { env: {}, claudeCode })).resolves.toMatchObject({
      fulfiller: 'claude-code',
      model: 'claude-local',
      content: [{ type: 'text', text: 'claude result' }],
    });
    expect(claudeCode).toHaveBeenCalledOnce();

    await expect(
      fulfillLocalOneShot(
        { messages: [{ role: 'user', content: 'codex prompt' }] },
        {
          env: { LOCAL_AI_FULFILLER: 'codex', CODEX_LOCAL_MODEL: 'gpt-codex-test' },
          run: async () => ({
            text: 'codex result',
            stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
            stderr: '',
          }),
        },
      ),
    ).resolves.toMatchObject({
      fulfiller: 'codex',
      model: 'gpt-codex-test',
      content: [{ type: 'text', text: 'codex result' }],
    });
  });

  it('rejects an ambient Codex API key before creating artifacts or starting the runner', async () => {
    const run = vi.fn();
    await expect(
      fulfillWithCodex(
        { messages: [{ role: 'user', content: 'must not spend' }] },
        {
          env: {
            CODEX_LOCAL_MODEL: 'gpt-codex-test',
            CODEX_API_KEY: 'ambient-paid-key',
          },
          run,
        },
      ),
    ).rejects.toThrow(/AI_CHANNEL=prod/);
    expect(run).not.toHaveBeenCalled();
  });

  it('uses API auth only with explicit opt-in and still isolates the child environment', async () => {
    const run = vi.fn(
      async (
        args: readonly string[],
        _prompt: string,
        _signal: AbortSignal | undefined,
        processOptions: { environment: Readonly<Record<string, string>> },
      ) => {
        expect(args).toContain('forced_login_method="api"');
        expect(processOptions.environment).toEqual({
          PATH: '/bin',
          CODEX_API_KEY: 'explicit-paid-key',
        });
        return {
          text: 'paid opt-in result',
          stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
          stderr: '',
        };
      },
    );
    await expect(
      fulfillWithCodex(
        { messages: [{ role: 'user', content: 'explicitly opted in' }] },
        {
          env: {
            AI_CHANNEL: 'prod',
            CODEX_API_KEY: 'explicit-paid-key',
            CODEX_LOCAL_MODEL: 'gpt-codex-test',
            PATH: '/bin',
            CLAUDE_API_KEY: 'must-not-leak',
          },
          run,
        },
      ),
    ).resolves.toMatchObject({ text: 'paid opt-in result' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('serializes the canonical local result into the exact shim response envelope', () => {
    expect(
      anthropicMessageFromLocalResult(
        {
          fulfiller: 'codex',
          model: 'gpt-codex-test',
          content: [{ type: 'text', text: '{"ok":true}' }],
          stopReason: 'end_turn',
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        'msg_dev_test',
      ),
    ).toEqual({
      id: 'msg_dev_test',
      type: 'message',
      role: 'assistant',
      model: 'gpt-codex-test',
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
  });

  it('rejects malformed results from either local fulfiller before serialization', async () => {
    const untypedFulfill = fulfillLocalOneShot as unknown as (
      body: unknown,
      options: { env: Record<string, string>; claudeCode: () => Promise<unknown> },
    ) => Promise<unknown>;
    await expect(
      untypedFulfill({}, { env: {}, claudeCode: async () => ({ model: 'misspelled' }) }),
    ).rejects.toThrow(/invalid canonical result/);
    const untypedSerialize = anthropicMessageFromLocalResult as unknown as (
      result: unknown,
      id: string,
    ) => unknown;
    expect(() =>
      untypedSerialize(
        {
          fulfiller: 'codex',
          model: 'gpt-codex-test',
          content: [{ type: 'tool_use', id: 'call_1', name: 'bad', input: [] }],
          stopReason: 'tool_use',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        'msg_invalid',
      ),
    ).toThrow(/invalid canonical result/);
  });

  it('terminates the non-interactive Codex child on cancellation', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const stdout = { on: vi.fn() };
    const stderr = { on: vi.fn() };
    const stdin = { end: vi.fn(), on: vi.fn() };
    const child = {
      stdout,
      stderr,
      stdin,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      kill: vi.fn(() => true),
    };
    const spawnProcess = vi.fn(() => child);
    const controller = new AbortController();
    const pending = runCodexProcess(['exec', '-'], 'bounded prompt', controller.signal, {
      spawnProcess,
      environment: { PATH: '/bin' },
      killGraceMs: 1_000,
    });

    controller.abort();

    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    listeners.get('error')?.(new Error('kill raced with child state'));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    listeners.get('close')?.(null, 'SIGKILL');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawnProcess).toHaveBeenCalledWith('codex', ['exec', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/bin' },
    });
    expect(stdin.end).toHaveBeenCalledWith('bounded prompt');
    vi.useRealTimers();
  });

  it('does not spawn Codex when the request is already cancelled', async () => {
    const spawnProcess = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      runCodexProcess(['exec', '-'], 'bounded prompt', controller.signal, {
        spawnProcess,
        environment: {},
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spawnProcess).not.toHaveBeenCalled();

    const run = vi.fn();
    await expect(
      fulfillWithCodex(
        { messages: [{ role: 'user', content: 'do not run' }] },
        {
          env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' },
          abortSignal: controller.signal,
          run,
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).not.toHaveBeenCalled();
  });

  it('normalizes successful, nonzero, spawn-error, and stdin-error process outcomes', async () => {
    const success = fakeCodexChild();
    const successSpawn = vi.fn(() => success.child);
    const successful = runCodexProcess(['exec', '-'], 'prompt', undefined, {
      spawnProcess: successSpawn,
      environment: { PATH: '/bin' },
    });
    success.emitStdout('{"type":"turn.completed"}\n');
    success.emitStderr('diagnostic');
    success.emitChild('close', 0, null);
    await expect(successful).resolves.toEqual({
      stdout: '{"type":"turn.completed"}\n',
      stderr: 'diagnostic',
    });

    const failed = fakeCodexChild();
    const nonzero = runCodexProcess(['exec', '-'], 'prompt', undefined, {
      spawnProcess: vi.fn(() => failed.child),
      environment: {},
    });
    failed.emitStderr('bad invocation');
    failed.emitChild('close', 2, null);
    await expect(nonzero).rejects.toThrow(/exited 2: bad invocation/);

    const spawnFailed = fakeCodexChild();
    const spawnError = runCodexProcess(['exec', '-'], 'prompt', undefined, {
      spawnProcess: vi.fn(() => spawnFailed.child),
      environment: {},
    });
    spawnFailed.emitChild('error', new Error('spawn failed'));
    spawnFailed.emitChild('close', null, null);
    await expect(spawnError).rejects.toThrow(/spawn failed/);

    const stdinFailed = fakeCodexChild();
    const stdinError = runCodexProcess(['exec', '-'], 'prompt', undefined, {
      spawnProcess: vi.fn(() => stdinFailed.child),
      environment: {},
    });
    stdinFailed.emitStdinError(new Error('stdin failed'));
    expect(stdinFailed.child.kill).toHaveBeenCalledWith('SIGTERM');
    stdinFailed.emitChild('close', 1, null);
    await expect(stdinError).rejects.toThrow(/stdin failed/);
  });

  it('removes temporary artifacts when the Codex process fails', async () => {
    let workdir = '';
    const run = vi.fn(async (args: readonly string[]) => {
      workdir = args[args.indexOf('--cd') + 1] ?? '';
      throw new Error('process failed');
    });
    await expect(
      fulfillWithCodex(
        { messages: [{ role: 'user', content: 'fail after setup' }] },
        { env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' }, run },
      ),
    ).rejects.toThrow(/process failed/);
    await expect(access(workdir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing model, streaming, and tools before spawning', async () => {
    const run = vi.fn();
    await expect(fulfillWithCodex({}, { env: {}, run })).rejects.toThrow(/CODEX_LOCAL_MODEL/);
    await expect(
      fulfillWithCodex({ stream: true }, { env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' }, run }),
    ).rejects.toThrow(/does not support streaming/);
    await expect(
      fulfillWithCodex(
        { tools: [{ name: 'tool' }] },
        { env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' }, run },
      ),
    ).rejects.toThrow(/does not support tool calls/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, [], 'messages'])(
    'rejects a missing, malformed, or empty messages collection before spawning: %j',
    async (messages) => {
      const run = vi.fn();
      await expect(
        fulfillWithCodex({ messages }, { env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' }, run }),
      ).rejects.toThrow(/non-empty messages array/);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each([
    { type: 'image', source: { type: 'url', url: 'https://images.invalid/a.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-base64' } },
    { type: 'document', source: { type: 'base64', data: 'aGVsbG8=' } },
    { type: 'document', source: { type: 'text' } },
    { type: 'tool_use', id: 'call_1', name: 'tool', input: {} },
    { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
  ])('rejects unsupported or malformed content before spawning: %j', async (block) => {
    const run = vi.fn();
    await expect(
      fulfillWithCodex(
        { messages: [{ role: 'user', content: [block] }] },
        { env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' }, run },
      ),
    ).rejects.toThrow(/does not support|valid base64/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    {
      output_config: { format: { type: 'text' } },
      messages: [{ role: 'user', content: 'go' }],
    },
    {
      output_config: { format: { type: 'json_schema' } },
      messages: [{ role: 'user', content: 'go' }],
    },
    {
      output_config: { format: { type: 'json_schema', schema: [] } },
      messages: [{ role: 'user', content: 'go' }],
    },
    {
      output_config: { format: { schema: { type: 'object' } } },
      messages: [{ role: 'user', content: 'go' }],
    },
    { output_config: { format: [] }, messages: [{ role: 'user', content: 'go' }] },
    { output_config: [], messages: [{ role: 'user', content: 'go' }] },
    { output_config: { effort: 'extreme' }, messages: [{ role: 'user', content: 'go' }] },
    { stream: 'false', messages: [{ role: 'user', content: 'go' }] },
    { tools: {}, messages: [{ role: 'user', content: 'go' }] },
    { system: [{ type: 'image' }], messages: [{ role: 'user', content: 'go' }] },
    { messages: [{ role: 'system', content: 'not a Messages API role' }] },
  ])('rejects unsupported request controls before spawning: %j', async (body) => {
    const run = vi.fn();
    await expect(
      fulfillWithCodex(body, { env: { CODEX_LOCAL_MODEL: 'gpt-codex-test' }, run }),
    ).rejects.toThrow(/Codex/);
    expect(run).not.toHaveBeenCalled();
  });
});
