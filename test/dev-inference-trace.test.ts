/** Structured inference traces use the same environment-routed logger as every other record. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDevelopmentInferenceTrace,
  traceableContent,
  traceableMessages,
  traceableSystem,
} from '../src/lib/dev-inference-trace';
import { createLoggingRuntime } from '../src/lib/logger';
import type { ClientMessagesPayload } from '../src/lib/anthropic';
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
      contextId: 'context-live-123',
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

  it('retains diagnostic text, tool decisions, and file references', () => {
    const payload: ClientMessagesPayload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'activeCurrency: CAD' },
            { type: 'image', source: { type: 'file', file_id: 'file-secret-handle' } },
            { type: 'tool_use', name: 'look_at_page', input: { page: 'Product' } },
          ],
        },
      ],
    };

    const serialized = JSON.stringify(traceableMessages(payload));
    expect(serialized).toContain('activeCurrency: CAD');
    expect(serialized).toContain('look_at_page');
    expect(serialized).toContain('file-secret-handle');
    expect(serialized).toContain('"source":{"type":"file"');
  });

  it('preserves stable system text and assistant response text', () => {
    expect(
      traceableSystem([
        { type: 'text', text: 'abc' },
        { type: 'text', text: '12345' },
      ]),
    ).toEqual([
      { type: 'text', text: 'abc' },
      { type: 'text', text: '12345' },
    ]);
    expect(traceableContent([{ type: 'text', text: '{"candidateId":"CAD:money"}' }])).toEqual([
      { type: 'text', text: '{"candidateId":"CAD:money"}' },
    ]);
  });
});
