/** No-credit default for the optional paid OpenAI smoke matrix. */

import { describe, expect, it, vi } from 'vitest';
import { assertOpenAILiveOptIn, runOpenAISmoke } from '../scripts/verify-openai.mjs';

describe('OpenAI live-smoke credit guard', () => {
  it('requires both explicit paid-channel opt-ins', () => {
    expect(() => assertOpenAILiveOptIn({})).toThrow(/OPENAI_LIVE_SMOKE=1.*AI_CHANNEL=prod/);
    expect(() => assertOpenAILiveOptIn({ OPENAI_LIVE_SMOKE: '1' })).toThrow(/AI_CHANNEL=prod/);
    expect(() => assertOpenAILiveOptIn({ AI_CHANNEL: 'prod' })).toThrow(/OPENAI_LIVE_SMOKE=1/);
    expect(() =>
      assertOpenAILiveOptIn({ OPENAI_LIVE_SMOKE: '1', AI_CHANNEL: 'prod' }),
    ).not.toThrow();
  });

  it('runs a multi-model matrix only after the guard and validates terminal envelopes', async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string };
      return new Response(
        JSON.stringify({
          id: 'resp_smoke',
          object: 'response',
          model: request.model,
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    const results = await runOpenAISmoke(
      {
        OPENAI_LIVE_SMOKE: '1',
        AI_CHANNEL: 'prod',
        OPENAI_API_BASE: 'https://openai.test',
        OPENAI_API_KEY: 'test-key',
        OPENAI_SMOKE_MODELS: 'model-a, model-b',
      },
      fetchMock,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.map((result: { model: string }) => result.model)).toEqual([
      'model-a',
      'model-b',
    ]);
  });

  it('accepts the dated snapshot an alias resolves to and reports which one served', async () => {
    const snapshotFetch = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: 'resp_alias',
            object: 'response',
            // The provider answers an alias with the snapshot it resolved to.
            model: `${(JSON.parse(String(init?.body)) as { model: string }).model}-2025-08-07`,
            status: 'completed',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        ),
    );
    const results = await runOpenAISmoke(
      {
        OPENAI_LIVE_SMOKE: '1',
        AI_CHANNEL: 'prod',
        OPENAI_API_BASE: 'https://openai.test',
        OPENAI_API_KEY: 'test-key',
        OPENAI_SMOKE_MODELS: 'gpt-5-mini',
      },
      snapshotFetch,
    );
    expect(results).toMatchObject([
      { model: 'gpt-5-mini', resolvedModel: 'gpt-5-mini-2025-08-07' },
    ]);
  });

  it('rejects a different family member that merely shares the requested prefix', async () => {
    // `gpt-5` must never accept `gpt-5-mini`: the boundary is a snapshot suffix
    // on the SAME id, not any longer id starting with it.
    const wrongModelFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_wrong',
          object: 'response',
          model: 'gpt-5-mini',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    );
    await expect(
      runOpenAISmoke(
        {
          OPENAI_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          OPENAI_API_BASE: 'https://openai.test',
          OPENAI_API_KEY: 'test-key',
          OPENAI_SMOKE_MODELS: 'gpt-5-nano',
        },
        wrongModelFetch,
      ),
    ).rejects.toThrow(/OpenAI smoke failed for gpt-5-nano/);
  });

  it('fails when the live result does not prove the structured response contract', async () => {
    const invalidFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'resp_bad',
          object: 'response',
          model: 'model-a',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    );
    await expect(
      runOpenAISmoke(
        {
          OPENAI_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          OPENAI_API_BASE: 'https://openai.test',
          OPENAI_API_KEY: 'test-key',
          OPENAI_SMOKE_MODELS: 'model-a',
        },
        invalidFetch,
      ),
    ).rejects.toThrow(/structured output/);
  });

  it('validates paid configuration and usage before reporting a smoke success', async () => {
    const fetchMock = vi.fn();
    await expect(
      runOpenAISmoke(
        { OPENAI_LIVE_SMOKE: '1', AI_CHANNEL: 'prod', OPENAI_API_BASE: 'https://openai.test' },
        fetchMock,
      ),
    ).rejects.toThrow('OPENAI_API_KEY');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'resp_usage',
          object: 'response',
          model: 'model-a',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
            },
          ],
          usage: { input_tokens: -1, output_tokens: 1 },
        }),
      ),
    );
    await expect(
      runOpenAISmoke(
        {
          OPENAI_LIVE_SMOKE: '1',
          AI_CHANNEL: 'prod',
          OPENAI_API_BASE: 'https://openai.test',
          OPENAI_API_KEY: 'test-key',
          OPENAI_SMOKE_MODELS: 'model-a',
        },
        fetchMock,
      ),
    ).rejects.toThrow('invalid usage');
  });
});
