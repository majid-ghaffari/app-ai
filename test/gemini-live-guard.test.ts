/** No-credit default for the optional paid Gemini probe matrix. */

import { describe, expect, it, vi } from 'vitest';
import {
  PROBE_ANSWER_TOKENS,
  assertGeminiLiveOptIn,
  runGeminiSmoke,
} from '../scripts/verify-gemini.mjs';
import {
  GEMINI_DEFAULT_THINKING_LEVEL,
  geminiSharedOutputBudget,
  type GeminiThinkingLevel,
} from '../src/inference/adapters/gemini-output-budget';

const LIVE = {
  GEMINI_LIVE_SMOKE: '1',
  AI_CHANNEL: 'prod',
  GEMINI_API_BASE: 'https://gemini.test/v1beta',
  GEMINI_API_KEY: 'test-key',
  GEMINI_SMOKE_MODEL: 'gemini-3.5-flash',
} as const;

const USAGE = { promptTokenCount: 9, candidatesTokenCount: 4, totalTokenCount: 13 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function textCompletion(text: string): Response {
  return json({
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: USAGE,
    responseId: 'resp_probe',
  });
}

/** A turn that spent the whole shared output budget on thinking. */
function thoughtOnlyCompletion(): Response {
  return json({
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text: 'weighing', thought: true }] },
        finishReason: 'MAX_TOKENS',
      },
    ],
    usageMetadata: { ...USAGE, candidatesTokenCount: 0, thoughtsTokenCount: 241 },
    responseId: 'resp_starved',
  });
}

function streamBody(options: { finish?: boolean; sentinel?: boolean } = {}): string {
  const frames = [
    {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'one ' }] } }],
      responseId: 'r',
    },
    {
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'two' }] },
          ...(options.finish === false ? {} : { finishReason: 'STOP' }),
        },
      ],
      usageMetadata: USAGE,
      responseId: 'r',
    },
  ];
  const lines = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`);
  if (options.sentinel) lines.push('data: [DONE]\n\n');
  return lines.join('');
}

interface RouterOptions {
  readonly toolSignature?: string | null;
  readonly stream?: { finish?: boolean; sentinel?: boolean };
  readonly catalogModel?: string;
  readonly starve?: boolean;
}

function router(options: RouterOptions = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    if (url.includes('/upload/')) return json({ error: { code: 'invalid_request' } }, 400);
    if (url.endsWith('/models')) {
      return json({
        models: [
          {
            name: `models/${options.catalogModel ?? 'gemini-3.5-flash'}`,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
          },
          { name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
        ],
      });
    }
    if (url.includes(':streamGenerateContent')) {
      return new Response(streamBody(options.stream ?? {}));
    }
    if (url.includes(':countTokens')) return json({ totalTokens: 21 });
    if (typeof body?.contents === 'string') {
      return json({ error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } }, 400);
    }
    const generationConfig = body?.generationConfig as Record<string, unknown> | undefined;
    if (generationConfig?.responseFormat) {
      return json({ error: { code: 'parameter_unknown', message: 'responseFormat' } }, 400);
    }
    if (generationConfig?.responseSchema) return textCompletion('{"ok":true}');
    if (body?.tools) {
      const signature = options.toolSignature === undefined ? 'sig-probe' : options.toolSignature;
      return json({
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: { id: 'fc_probe', name: 'report_status', args: { ok: true } },
                  ...(signature === null ? {} : { thoughtSignature: signature }),
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: USAGE,
        responseId: 'resp_tool',
      });
    }
    return options.starve ? thoughtOnlyCompletion() : textCompletion('ready');
  });
}

describe('Gemini live-probe credit guard', () => {
  it('requires both explicit paid-channel opt-ins', () => {
    expect(() => assertGeminiLiveOptIn({})).toThrow(/GEMINI_LIVE_SMOKE=1.*AI_CHANNEL=prod/);
    expect(() => assertGeminiLiveOptIn({ GEMINI_LIVE_SMOKE: '1' })).toThrow(/AI_CHANNEL=prod/);
    expect(() => assertGeminiLiveOptIn({ AI_CHANNEL: 'prod' })).toThrow(/GEMINI_LIVE_SMOKE=1/);
    expect(() =>
      assertGeminiLiveOptIn({ GEMINI_LIVE_SMOKE: '1', AI_CHANNEL: 'prod' }),
    ).not.toThrow();
  });

  it('throws on a missing precondition before any provider call', async () => {
    const fetchMock = router();
    const { GEMINI_API_KEY: _key, ...withoutKey } = LIVE;
    await expect(runGeminiSmoke(withoutKey, fetchMock)).rejects.toThrow('GEMINI_API_KEY');
    const { GEMINI_SMOKE_MODEL: _model, ...withoutModel } = LIVE;
    await expect(runGeminiSmoke(withoutModel, fetchMock)).rejects.toThrow('GEMINI_SMOKE_MODEL');
    await expect(
      runGeminiSmoke({ ...LIVE, GEMINI_SMOKE_MODEL: 'gemini-2.5-flash' }, fetchMock),
    ).rejects.toThrow(/Unsupported Gemini smoke model/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records every documented unknown and asserts the shipped contract', async () => {
    const fetchMock = router();
    const results = await runGeminiSmoke(LIVE, fetchMock);
    const byProbe = Object.fromEntries(results.map((result) => [result.probe, result]));
    expect(results.map((result) => result.probe)).toEqual([
      'models-catalog',
      'auth-and-generate',
      'structured-output-flat',
      'thought-signature',
      'stream-framing',
      'count-tokens-wrapper',
      'thinking-level-budget',
      'structured-output-nested',
      'inline-data-snake-case',
      'error-envelope',
      'upload-protocol-multipart',
    ]);
    for (const probe of [
      'auth-and-generate',
      'structured-output-flat',
      'thought-signature',
      'stream-framing',
      'count-tokens-wrapper',
      'models-catalog',
    ]) {
      expect(byProbe[probe]).toMatchObject({ required: true, outcome: 'accepted' });
    }
    expect(byProbe['thought-signature']?.detail).toMatchObject({ functionCallId: 'fc_probe' });
    expect(byProbe['stream-framing']?.detail).toMatchObject({
      terminalSentinel: false,
      finishIndex: 1,
      usageIndexes: [1],
      responseIdStable: true,
    });
    expect(byProbe['models-catalog']?.detail).toMatchObject({
      model: 'gemini-3.5-flash',
      servedAs: 'models/gemini-3.5-flash',
      generateContentModels: [
        { name: 'models/gemini-3.5-flash', inputTokenLimit: 1048576, outputTokenLimit: 65536 },
      ],
    });
    expect(byProbe['thinking-level-budget']).toMatchObject({
      required: false,
      outcome: 'accepted',
      detail: { finishReason: 'STOP', visibleTextLength: 5 },
    });
    expect(byProbe['structured-output-nested']).toMatchObject({
      required: false,
      outcome: 'rejected',
    });
    expect(byProbe['inline-data-snake-case']).toMatchObject({ outcome: 'accepted' });
    expect(byProbe['error-envelope']?.detail).toMatchObject({
      status: 400,
      codeType: 'number',
      statusField: 'INVALID_ARGUMENT',
    });
    expect(byProbe['upload-protocol-multipart']).toMatchObject({ outcome: 'rejected' });
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('reports a thinking-starved turn as its own outcome, not a contract failure', async () => {
    const results = await runGeminiSmoke(LIVE, router({ starve: true }));
    const byProbe = Object.fromEntries(results.map((result) => [result.probe, result]));
    expect(byProbe['auth-and-generate']).toMatchObject({
      required: true,
      outcome: 'starved',
      detail: {
        finishReason: 'MAX_TOKENS',
        maxOutputTokens: geminiSharedOutputBudget(
          PROBE_ANSWER_TOKENS,
          GEMINI_DEFAULT_THINKING_LEVEL,
        ),
        thoughtsTokenCount: 241,
        candidatesTokenCount: 0,
      },
    });
  });

  it('fails loudly when a required probe breaks the shipped contract', async () => {
    await expect(runGeminiSmoke(LIVE, router({ toolSignature: null }))).rejects.toThrow(
      /first functionCall part with no thoughtSignature/,
    );
    await expect(runGeminiSmoke(LIVE, router({ stream: { finish: false } }))).rejects.toThrow(
      /closed without any finishReason/,
    );
    await expect(runGeminiSmoke(LIVE, router({ catalogModel: 'gemini-3-pro' }))).rejects.toThrow(
      /does not serve gemini-3.5-flash for generateContent/,
    );
    // A longer id from another family member is not the requested model either.
    await expect(
      runGeminiSmoke(LIVE, router({ catalogModel: 'gemini-3.5-flash-lite' })),
    ).rejects.toThrow(/does not serve gemini-3.5-flash for generateContent/);
  });

  it('accepts the numbered snapshot an aliased smoke model resolves to', async () => {
    const results = await runGeminiSmoke(LIVE, router({ catalogModel: 'gemini-3.5-flash-002' }));
    expect(results.find((result) => result.probe === 'models-catalog')).toMatchObject({
      outcome: 'accepted',
      detail: { model: 'gemini-3.5-flash', servedAs: 'models/gemini-3.5-flash-002' },
    });
  });

  it('sizes every generating probe the way the adapter sizes a live request', async () => {
    const fetchMock = router();
    await runGeminiSmoke(LIVE, fetchMock);
    interface ProbeGenerationConfig {
      maxOutputTokens?: number;
      thinkingConfig?: { thinkingLevel?: GeminiThinkingLevel };
    }
    const configs = fetchMock.mock.calls
      .map(([, init]) =>
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as {
              generationConfig?: ProbeGenerationConfig;
              generateContentRequest?: { generationConfig?: ProbeGenerationConfig };
            })
          : null,
      )
      .flatMap((body) => {
        const config = body?.generationConfig ?? body?.generateContentRequest?.generationConfig;
        return config?.maxOutputTokens === undefined ? [] : [config];
      });
    expect(configs.length).toBeGreaterThan(0);
    for (const config of configs) {
      // A declared level is what makes the shared budget's split knowable, and
      // the budget is the adapter's own sizing of that level — never a number
      // the probe matrix chose for itself.
      const level = config.thinkingConfig?.thinkingLevel;
      expect(level).toBeDefined();
      if (level === undefined) throw new Error('a probe declared no thinking level');
      expect(config.maxOutputTokens).toBe(geminiSharedOutputBudget(PROBE_ANSWER_TOKENS, level));
    }
    // The matrix exercises the level an effort-less production request resolves
    // to, and the cheapest rung as well.
    const levels = new Set(configs.map((config) => config.thinkingConfig?.thinkingLevel));
    expect(levels.has(GEMINI_DEFAULT_THINKING_LEVEL)).toBe(true);
    expect(levels.has('low')).toBe(true);
  });
});
