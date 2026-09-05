import { describe, expect, it, vi } from 'vitest';
import { assertKimiLiveOptIn, runKimiSmoke } from '../scripts/verify-kimi.mjs';

const LIVE = {
  KIMI_LIVE_SMOKE: '1',
  AI_CHANNEL: 'prod',
  KIMI_API_BASE: 'https://kimi.test/coding',
  KIMI_API_KEY: 'test-key',
  KIMI_SMOKE_MODEL: 'k3',
} as const;

const USAGE = { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function completion(content: string, model = 'k3'): Response {
  return json({
    id: 'cmpl_probe',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, reasoning_content: 'thinking' },
        finish_reason: 'stop',
      },
    ],
    usage: USAGE,
  });
}

function streamBody(sentinel = true): string {
  const frames = [
    {
      id: 'c',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'k3',
      choices: [
        { index: 0, delta: { role: 'assistant', reasoning_content: 'plan' }, finish_reason: null },
      ],
    },
    {
      id: 'c',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'k3',
      choices: [{ index: 0, delta: { content: 'one two' }, finish_reason: 'stop' }],
      usage: USAGE,
    },
  ];
  const lines = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  if (sentinel) lines.push('data: [DONE]\n\n');
  return lines.join('');
}

interface RouterOptions {
  readonly sentinel?: boolean;
  readonly filesStatus?: number;
}

function router(options: RouterOptions = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/files')) {
      return options.filesStatus
        ? json({ error: { message: 'not found' } }, options.filesStatus)
        : json({ id: 'kimi_smoke_file', object: 'file', purpose: 'image' });
    }
    if (url.endsWith('/v1/files/kimi_smoke_file')) {
      return json({ error: { message: 'not found' } }, 404);
    }
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (typeof body?.messages === 'string') {
      return json(
        { error: { message: 'bad request', type: 'invalid_request_error', code: null } },
        400,
      );
    }
    if (body?.stream === true) return new Response(streamBody(options.sentinel ?? true));
    const model = typeof body?.model === 'string' ? body.model : 'k3';
    if (body?.response_format) return completion('{"ok":true}', model);
    if (Array.isArray(body?.messages) && body.messages.some((message) => message.role === 'tool')) {
      return json(
        { error: { message: 'missing reasoning_content', type: 'invalid_request_error' } },
        400,
      );
    }
    return completion('ready', model);
  });
}

describe('Kimi Code live-probe credit guard', () => {
  it('requires both explicit paid-channel opt-ins', () => {
    expect(() => assertKimiLiveOptIn({})).toThrow(/KIMI_LIVE_SMOKE=1.*AI_CHANNEL=prod/);
    expect(() => assertKimiLiveOptIn({ KIMI_LIVE_SMOKE: '1' })).toThrow(/AI_CHANNEL=prod/);
    expect(() => assertKimiLiveOptIn({ AI_CHANNEL: 'prod' })).toThrow(/KIMI_LIVE_SMOKE=1/);
    expect(() => assertKimiLiveOptIn({ KIMI_LIVE_SMOKE: '1', AI_CHANNEL: 'prod' })).not.toThrow();
  });

  it('throws on a missing precondition before any provider call', async () => {
    const fetchMock = router();
    const { KIMI_API_KEY: _key, ...withoutKey } = LIVE;
    await expect(runKimiSmoke(withoutKey, fetchMock)).rejects.toThrow('KIMI_API_KEY');
    const { KIMI_API_BASE: _base, ...withoutBase } = LIVE;
    await expect(runKimiSmoke(withoutBase, fetchMock)).rejects.toThrow('KIMI_API_BASE');
    await expect(runKimiSmoke({ ...LIVE, KIMI_SMOKE_MODEL: 'kimi-k3' }, fetchMock)).rejects.toThrow(
      /Unsupported Kimi smoke model kimi-k3/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asserts the shipped contract and records the subscription unknowns', async () => {
    const fetchMock = router();
    const results = await runKimiSmoke(LIVE, fetchMock);
    const byProbe = Object.fromEntries(results.map((result) => [result.probe, result]));
    expect(results.map((result) => result.probe)).toEqual([
      'auth-and-chat',
      'structured-output-strict',
      'stream-done-sentinel',
      'inline-image',
      'files-api',
      'reasoning-replay-without-content',
      'error-envelope',
    ]);
    expect(byProbe['auth-and-chat']).toMatchObject({ required: true, outcome: 'accepted' });
    expect(byProbe['auth-and-chat']?.detail).toMatchObject({ hasReasoningContent: true });
    expect(byProbe['structured-output-strict']).toMatchObject({ outcome: 'accepted' });
    expect(byProbe['stream-done-sentinel']?.detail).toMatchObject({
      frameCount: 2,
      usageIndexes: [1],
      reasoningPrecedesContent: true,
    });
    expect(byProbe['inline-image']).toMatchObject({ required: false, outcome: 'accepted' });
    expect(byProbe['files-api']).toMatchObject({
      required: true,
      outcome: 'accepted',
      detail: {
        status: 200,
        idPresent: true,
        imageReferenceStatus: 200,
        imageReferenceFinishReason: 'stop',
        deleteStatus: 404,
      },
    });
    expect(byProbe['reasoning-replay-without-content']).toMatchObject({ outcome: 'rejected' });
    expect(byProbe['error-envelope']?.detail).toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(9);

    const authBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(authBody).toMatchObject({
      model: 'k3',
      reasoning_effort: 'low',
      max_completion_tokens: 2048,
    });
    for (const index of [1, 2]) {
      const body = JSON.parse(String(fetchMock.mock.calls[index]?.[1]?.body));
      expect(body.max_completion_tokens).toBe(2048);
    }
    expect(authBody).not.toHaveProperty('thinking');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://kimi.test/coding/v1/chat/completions');
  });

  it('sends reasoning effort for the K2.8 subscription id', async () => {
    const fetchMock = router();
    await runKimiSmoke({ ...LIVE, KIMI_SMOKE_MODEL: 'kimi-for-coding' }, fetchMock);
    const authBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(authBody).toMatchObject({ model: 'kimi-for-coding', reasoning_effort: 'low' });
    expect(authBody).not.toHaveProperty('thinking');
  });

  it('sends preserved thinking for the K2.7 highspeed subscription id', async () => {
    const fetchMock = router();
    await runKimiSmoke({ ...LIVE, KIMI_SMOKE_MODEL: 'kimi-for-coding-highspeed' }, fetchMock);
    const authBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(authBody).toMatchObject({
      model: 'kimi-for-coding-highspeed',
      thinking: { type: 'enabled', keep: 'all' },
    });
    expect(authBody).not.toHaveProperty('reasoning_effort');
  });

  it('fails loudly when the subscription host drops the terminal sentinel', async () => {
    await expect(runKimiSmoke(LIVE, router({ sentinel: false }))).rejects.toThrow(
      /did not emit data: \[DONE\]/,
    );
  });

  it('fails loudly when image upload or its ms reference is unavailable', async () => {
    await expect(runKimiSmoke(LIVE, router({ filesStatus: 500 }))).rejects.toThrow(/files-api/);
  });
});
