import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggingRuntime, toLogValue } from '../src/lib/logger';
import { ENV } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('environment-routed logger', () => {
  it('fans one record to console and Seq and preserves request context', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const tasks: Promise<unknown>[] = [];
    const runtime = createLoggingRuntime(
      { ...ENV, LOG_TARGETS_INFO: 'console,seq' },
      (task) => tasks.push(task),
      { requestId: 'request-9', contextId: 'context-9' },
    );

    runtime.child({ subscriberId: 42 }).logger('Messages').info('Forwarded', { model: 'sonnet' });

    expect(consoleInfo).toHaveBeenCalledTimes(1);
    await tasks[0];
    const event = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      '@l': 'Information',
      Scope: 'Messages',
      Message: 'Forwarded',
      requestId: 'request-9',
      contextId: 'context-9',
      subscriberId: 42,
      Detail: { model: 'sonnet' },
    });
  });

  it('sends an optional Seq key only when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const withoutKey: Promise<unknown>[] = [];
    createLoggingRuntime({ ...ENV, LOG_TARGETS_ERROR: 'seq' }, (task) => withoutKey.push(task))
      .logger('A')
      .error('boom', new Error('one'));
    await withoutKey[0];
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual({
      'Content-Type': 'application/json',
    });

    const withKey: Promise<unknown>[] = [];
    createLoggingRuntime({ ...ENV, LOG_TARGETS_ERROR: 'seq', LOG_SEQ_API_KEY: 'seq-key' }, (task) =>
      withKey.push(task),
    )
      .logger('B')
      .error('boom', new Error('two'));
    await withKey[0];
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toEqual({
      'Content-Type': 'application/json',
      'X-Seq-ApiKey': 'seq-key',
    });
  });

  it('keeps rich errors and context ids while redacting actual secret fields', () => {
    const cause = new Error('database unavailable');
    const error = new Error('provider failed', { cause });
    Object.assign(error, { status: 502, apiKey: 'secret', contextId: 'ctx-visible' });
    expect(toLogValue(error)).toMatchObject({
      name: 'Error',
      message: 'provider failed',
      stack: expect.any(String),
      cause: { message: 'database unavailable', stack: expect.any(String) },
      status: 502,
      apiKey: '[REDACTED]',
      contextId: 'ctx-visible',
    });
    expect(
      toLogValue({ authorization: 'Bearer x', password: 'p', fileId: 'file-visible' }),
    ).toEqual({ authorization: '[REDACTED]', password: '[REDACTED]', fileId: 'file-visible' });
  });

  it('redacts secret fields in request context before sink delivery', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const tasks: Promise<unknown>[] = [];
    createLoggingRuntime({ ...ENV, LOG_TARGETS_ERROR: 'seq' }, (task) => tasks.push(task), {
      contextId: 'ctx-visible',
      serviceToken: 'hidden',
    })
      .logger('Router')
      .error('failed');
    await tasks[0];
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body.contextId).toBe('ctx-visible');
    expect(body.serviceToken).toBe('[REDACTED]');
  });

  it('routes production error/fatal only to Seq without Worker console output', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const tasks: Promise<unknown>[] = [];
    const runtime = createLoggingRuntime(
      {
        ...ENV,
        LOG_TARGETS_ERROR: 'seq',
        LOG_TARGETS_FATAL: 'seq',
      },
      (task) => tasks.push(task),
    );
    runtime.logger('Worker').error('error', new Error('e'));
    runtime.logger('Worker').fatal('fatal', new Error('f'));
    runtime.logger('Worker').warn('ignored');
    await Promise.all(tasks);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('captures rejected background work without rethrowing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const tasks: Promise<unknown>[] = [];
    const runtime = createLoggingRuntime(
      { ...ENV, LOG_TARGETS_ERROR: 'seq' },
      (task) => tasks.push(task),
      { requestId: 'background-request' },
    );
    runtime.runBackground('Worker', 'refresh', Promise.reject(new Error('refresh failed')));
    await Promise.all(tasks);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is fail-open when the Seq sink rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Seq down')));
    const tasks: Promise<unknown>[] = [];
    const runtime = createLoggingRuntime({ ...ENV, LOG_TARGETS_ERROR: 'seq' }, (task) =>
      tasks.push(task),
    );
    expect(() => runtime.logger('Worker').error('failure', new Error('app failure'))).not.toThrow();
    await expect(Promise.all(tasks)).resolves.toEqual([undefined]);
  });
});
