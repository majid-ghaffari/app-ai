import { describe, expect, it, vi } from 'vitest';
import { assertMoonshotLiveOptIn, runMoonshotSmoke } from '../scripts/verify-moonshot.mjs';

describe('Moonshot live-smoke credit guard', () => {
  it('requires both explicit paid-channel opt-ins', () => {
    expect(() => assertMoonshotLiveOptIn({})).toThrow(/MOONSHOT_LIVE_SMOKE=1.*AI_CHANNEL=prod/);
    expect(() => assertMoonshotLiveOptIn({ MOONSHOT_LIVE_SMOKE: '1' })).toThrow(/AI_CHANNEL=prod/);
    expect(() => assertMoonshotLiveOptIn({ AI_CHANNEL: 'prod' })).toThrow(/MOONSHOT_LIVE_SMOKE=1/);
    expect(() =>
      assertMoonshotLiveOptIn({ MOONSHOT_LIVE_SMOKE: '1', AI_CHANNEL: 'prod' }),
    ).not.toThrow();
  });

  it('runs a guarded multi-model matrix and validates structured terminal results', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown> & { model: string };
      bodies.push(body);
      return new Response(
        JSON.stringify({
          id: 'cmpl_smoke',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"ok":true}', reasoning_content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    const results = await runMoonshotSmoke(
      {
        MOONSHOT_LIVE_SMOKE: '1',
        AI_CHANNEL: 'prod',
        MOONSHOT_API_BASE: 'https://moonshot.test',
        MOONSHOT_API_KEY: 'test-key',
        MOONSHOT_SMOKE_MODELS: 'kimi-k3, kimi-k2.6',
      },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.model)).toEqual(['kimi-k3', 'kimi-k2.6']);
    expect(bodies[0]).toMatchObject({ model: 'kimi-k3', reasoning_effort: 'low' });
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[1]).toMatchObject({
      model: 'kimi-k2.6',
      thinking: { type: 'enabled', keep: 'all' },
    });
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
  });

  it('validates config, structured output, and exact usage before success', async () => {
    const fetchMock = vi.fn();
    await expect(
      runMoonshotSmoke(
        {
          MOONSHOT_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          MOONSHOT_API_BASE: 'https://moonshot.test',
        },
        fetchMock,
      ),
    ).rejects.toThrow('MOONSHOT_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'chat.completion',
          model: 'kimi-k3',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '{"ok":false}',
                reasoning_content: 'noted',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
    );
    await expect(
      runMoonshotSmoke(
        {
          MOONSHOT_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          MOONSHOT_API_BASE: 'https://moonshot.test',
          MOONSHOT_API_KEY: 'test-key',
          MOONSHOT_SMOKE_MODELS: 'kimi-k3',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/invalid structured output/);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'chat.completion',
          model: 'kimi-k3',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"ok":true}' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
    );
    await expect(
      runMoonshotSmoke(
        {
          MOONSHOT_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          MOONSHOT_API_BASE: 'https://moonshot.test',
          MOONSHOT_API_KEY: 'test-key',
          MOONSHOT_SMOKE_MODELS: 'kimi-k3',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/Moonshot smoke failed/);

    await expect(
      runMoonshotSmoke(
        {
          MOONSHOT_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          MOONSHOT_API_BASE: 'https://moonshot.test',
          MOONSHOT_API_KEY: 'test-key',
          MOONSHOT_SMOKE_MODELS: 'unreviewed-model',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/Unsupported Moonshot smoke model/);
    fetchMock.mockClear();
    await expect(
      runMoonshotSmoke(
        {
          MOONSHOT_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          MOONSHOT_API_BASE: 'https://moonshot.test',
          MOONSHOT_API_KEY: 'test-key',
          MOONSHOT_SMOKE_MODELS: 'kimi-k3,unreviewed-model',
        },
        fetchMock,
      ),
    ).rejects.toThrow(/Unsupported Moonshot smoke model/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
