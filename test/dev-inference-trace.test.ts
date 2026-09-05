/** Structured inference traces use the same environment-routed logger as every other record. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDevelopmentInferenceTrace } from '../src/lib/dev-inference-trace';
import { createLoggingRuntime } from '../src/lib/logger';
import type { ClientMessagesPayload } from '../src/inference/adapters/anthropic-wire';
import { ENV } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inference trace', () => {
  it('emits a correlated TRACE record through the configured sinks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const tasks: Promise<unknown>[] = [];
    const runtime = createLoggingRuntime(
      { ...ENV, LOG_TARGETS_TRACE: 'seq' },
      (task) => tasks.push(task),
      { contextId: 'context-live-123', requestId: 'request-1' },
    );
    const trace = createDevelopmentInferenceTrace(
      runtime.logger('InferenceTrace'),
      'messages',
      'onboarding-currency-recovery',
    );

    trace.record('response.received', { content: [{ type: 'text', text: 'CAD' }] });

    expect(tasks).toHaveLength(1);
    await tasks[0];
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://seq.test/ingest/clef');
    const event = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(event).toMatchObject({
      '@l': 'Verbose',
      Scope: 'InferenceTrace',
      Message: 'inference.response.received',
      contextId: '[REDACTED]',
      requestId: 'request-1',
    });
    expect(JSON.stringify(event.Detail)).toContain('CAD');
  });

  it('is ignored when TRACE has no configured target', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const trace = createDevelopmentInferenceTrace(
      createLoggingRuntime(ENV).logger('InferenceTrace'),
      'messages',
      'onboarding-batch-all',
    );
    trace.record('request.forwarded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retains diagnostic text and tool decisions while redacting file references', () => {
    const consoleLog = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const trace = createDevelopmentInferenceTrace(
      createLoggingRuntime({ ...ENV, LOG_TARGETS_TRACE: 'console' }).logger('InferenceTrace'),
      'chat',
      'placement',
    );
    const payload: ClientMessagesPayload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'activeCurrency: CAD' },
            { type: 'image', source: { type: 'file', file_id: 'file-secret-handle' } },
            {
              type: 'tool_use',
              name: 'look_at_page',
              input: {
                page: 'Product',
                fileId: 'file-secret-tool-input',
                screenshot: { type: 'base64', media_type: 'image/png', data: 'secret-base64' },
              },
            },
          ],
        },
      ],
    };

    trace.record('request.forwarded', { messages: payload.messages });

    const serialized = JSON.stringify(consoleLog.mock.calls[0]);
    expect(serialized).toContain('activeCurrency: CAD');
    expect(serialized).toContain('look_at_page');
    expect(serialized).not.toContain('file-secret-handle');
    expect(serialized).not.toContain('file-secret-tool-input');
    expect(serialized).not.toContain('secret-base64');
    expect(serialized).toContain('"source":{"type":"file"}');
  });

  it('redacts arbitrary failure/tool fields centrally at the trace sink', () => {
    const consoleLog = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const trace = createDevelopmentInferenceTrace(
      createLoggingRuntime({ ...ENV, LOG_TARGETS_TRACE: 'console' }).logger('InferenceTrace'),
      'chat',
      'onboarding-chat',
    );
    trace.record('request.failed', {
      message: 'provider rejected file_secret_failure',
      continuation: 'v1.provider-state-secret',
      providerState: { raw: 'secret' },
      tool: {
        input: { file_id: 'file_secret_input' },
        result: {
          fileId: 'file_secret_result',
          screenshot: { type: 'base64', mediaType: 'image/png', data: 'encoded-secret' },
        },
      },
    });
    const serialized = JSON.stringify(consoleLog.mock.calls[0]);
    expect(serialized).toContain('[opaque-file]');
    expect(serialized).not.toContain('file_secret');
    expect(serialized).not.toContain('provider-state-secret');
    expect(serialized).not.toContain('encoded-secret');
    expect(serialized).not.toContain('providerState');
  });
});
