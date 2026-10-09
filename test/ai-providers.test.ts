import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRootAiProviders } from '../scripts/root-ai-providers.mjs';
import worker from '../src/index';
import { handleFileUpload } from '../src/handlers/files';
import { anthropicApiBase, openaiApiBase, type Env } from '../src/config';
import {
  AI_SUBPROCESSORS,
  aiSubprocessorOf,
  isOfficialProviderBase,
  mayServeRoute,
} from '../src/lib/ai-providers';
import { PROVIDER_NAMES } from '../src/inference/model-catalog';
import {
  getModelProfile,
  getPromptGroupDefinition,
  listPromptGroups,
  validateProviderConfiguration,
} from '../src/prompt-registry';
import { silentLoggingRuntime } from '../src/lib/logger';
import { CORS, ENV, rootStandards, stubFetch } from './helpers';

const PRODUCTION: Env = { ...ENV, ENVIRONMENT: 'production' };
const { KIMI_API_KEY: _kimiKey, ...PRODUCTION_WITHOUT_KIMI_KEY } = PRODUCTION;
const PROTECTED_VISUAL = 'free-render-verification=@cf/qwen/qwen3.8-27b';
const KIMI_GRADER = `${PROTECTED_VISUAL},onboarding-visual=kimi-for-coding,onboarding-qc-gate=kimi-for-coding`;
const OWN_API_BASES = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  moonshot: 'https://api.moonshot.ai',
  kimi: 'https://api.kimi.com/coding',
} as const;
function rootAiProviders(): ReturnType<typeof readRootAiProviders> {
  const { directory, whenUnreadable } = rootStandards();
  return readRootAiProviders(directory, whenUnreadable);
}

function byProvider(left: { provider: string }, right: { provider: string }): number {
  return left.provider < right.provider ? -1 : left.provider > right.provider ? 1 : 0;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the AI provider allow-list matches the workspace’s ai-providers.json', () => {
  it('lists exactly the providers ai-providers.json lists, each with its DPA name and API origin', async () => {
    const { path, providers } = await rootAiProviders();
    expect(
      Object.entries(AI_SUBPROCESSORS)
        .map(([provider, { dpaName, apiHost }]) => ({
          provider,
          dpaName,
          apiOrigin: `https://${apiHost}`,
        }))
        .sort(byProvider),
      `AI_SUBPROCESSORS must match ${path}; both change only in the release that changes the DPA`,
    ).toEqual(
      providers
        .map(({ provider, dpaName, apiOrigin }) => ({ provider, dpaName, apiOrigin }))
        .sort(byProvider),
    );
  });

  it('maps every catalogued provider to one ai-providers.json lists, at its origin, except Moonshot and Kimi Code', async () => {
    const { path, providers } = await rootAiProviders();
    const originOf = new Map(providers.map(({ provider, apiOrigin }) => [provider, apiOrigin]));
    expect(
      PROVIDER_NAMES.filter((provider) => aiSubprocessorOf(provider) === null).sort(),
      `only Moonshot and Kimi Code stay outside ${path}, and only for routes carrying no customer content`,
    ).toEqual(['kimi', 'moonshot']);
    for (const provider of PROVIDER_NAMES) {
      const name = aiSubprocessorOf(provider);
      if (name === null) continue;
      expect(originOf.has(name), `${provider} maps to ${name}, which ${path} does not list`).toBe(
        true,
      );
    }
    for (const [provider, base] of Object.entries(OWN_API_BASES) as [
      keyof typeof OWN_API_BASES,
      string,
    ][]) {
      const name = aiSubprocessorOf(provider);
      if (name === null) continue;
      expect(
        new URL(base).origin,
        `${provider}'s own API base must be at the origin ${path} gives ${name}`,
      ).toBe(originOf.get(name));
    }
    expect(
      aiSubprocessorOf('cloudflare'),
      'Workers AI is reached through its binding, with no API base tying it to its entry, so its mapping is pinned by name',
    ).toBe('CLOUDFLARE_WORKERS_AI');
  });

  it('lets Moonshot and Kimi Code serve only routes carrying no customer content, and pins those routes: none', () => {
    expect(
      listPromptGroups().filter((group) => !getPromptGroupDefinition(group).carriesCustomerContent),
    ).toEqual([]);
    for (const provider of ['moonshot', 'kimi'] as const) {
      expect(mayServeRoute(provider, true)).toBe(false);
      expect(mayServeRoute(provider, false)).toBe(true);
    }
    for (const provider of ['anthropic', 'openai', 'gemini', 'cloudflare'] as const) {
      expect(mayServeRoute(provider, true)).toBe(true);
    }
  });

  it('accepts only each provider’s own API base, written exactly', () => {
    const own = OWN_API_BASES;
    for (const [provider, base] of Object.entries(own) as [keyof typeof own, string][]) {
      expect(isOfficialProviderBase(provider, base), base).toBe(true);
      for (const refused of [
        `${base}/`,
        base.replace('https:', 'http:'),
        `${base}?route=other`,
        `${base}#fragment`,
        base.replace('://', '://user:secret@'),
        base.toUpperCase(),
        'https://provider-proxy.example.test',
        'http://127.0.0.1:8788',
      ]) {
        expect(isOfficialProviderBase(provider, refused), `${provider} ${refused}`).toBe(false);
      }
    }
    expect(isOfficialProviderBase('openai', own.anthropic)).toBe(false);
    expect(isOfficialProviderBase('cloudflare', own.anthropic)).toBe(false);
  });
});

describe('a production configuration outside the allow-list fails validation before serving', () => {
  const outsideTheList = [
    ['a MODEL_OVERRIDES group key onto Kimi Code', { MODEL_OVERRIDES: KIMI_GRADER }, /kimi/],
    [
      'a MODEL_OVERRIDES group key onto metered Moonshot',
      { MODEL_OVERRIDES: `${PROTECTED_VISUAL},grader-sales=kimi-k3` },
      /moonshot/,
    ],
    ['a tier variable onto Kimi Code', { MODEL_BALANCED: 'kimi-for-coding' }, /kimi/],
    ['a model id no provider owns', { MODEL_FAST: 'mistral-large-3' }, /mistral-large-3/],
    [
      'OPENAI_API_BASE at a host that is not OpenAI’s',
      { OPENAI_API_BASE: 'https://openai-proxy.example.test' },
      /OPENAI_API_BASE/,
    ],
    [
      'ANTHROPIC_API_BASE with a trailing slash',
      { ANTHROPIC_API_BASE: 'https://api.anthropic.com/' },
      /ANTHROPIC_API_BASE/,
    ],
    [
      'GEMINI_API_BASE over plain HTTP',
      { GEMINI_API_BASE: 'http://generativelanguage.googleapis.com/v1beta' },
      /GEMINI_API_BASE/,
    ],
    [
      'MOONSHOT_API_BASE at another host',
      { MOONSHOT_API_BASE: 'https://moonshot-proxy.example.test' },
      /MOONSHOT_API_BASE/,
    ],
  ] as const;

  for (const [label, settings, reason] of outsideTheList) {
    it(`refuses ${label}`, () => {
      expect(() => validateProviderConfiguration({ ...PRODUCTION, ...settings })).toThrow(reason);
    });
  }

  it('refuses an xAI model on a tier or an override, as any provider off the list', () => {
    expect(
      Object.values(AI_SUBPROCESSORS).map(({ apiHost }) => apiHost),
      'xAI is off the allow-list',
    ).not.toContain('api.x.ai');
    for (const settings of [
      { MODEL_BALANCED: 'grok-4' },
      { MODEL_OVERRIDES: `${PROTECTED_VISUAL},onboarding-visual=grok-4` },
    ]) {
      expect(() => validateProviderConfiguration({ ...PRODUCTION, ...settings })).toThrow(/grok-4/);
    }
  });

  it('accepts the providers the DPA lists on a route their family can serve', () => {
    for (const overrides of [
      `${PROTECTED_VISUAL},onboarding-visual=gpt-5.1,onboarding-qc-gate=gpt-5.1,analytics-narrative=gpt-5.1`,
      `${PROTECTED_VISUAL},onboarding-visual=gemini-3-pro,onboarding-qc-gate=gemini-3-flash`,
    ]) {
      expect(() =>
        validateProviderConfiguration({ ...PRODUCTION, MODEL_OVERRIDES: overrides }),
      ).not.toThrow();
    }
    expect(() => validateProviderConfiguration(PRODUCTION)).not.toThrow();
  });

  it('leaves Moonshot and Kimi Code to the adapter tests and paid smoke matrices outside production', () => {
    expect(() =>
      validateProviderConfiguration({ ...ENV, MODEL_OVERRIDES: KIMI_GRADER }),
    ).not.toThrow();
    expect(
      getModelProfile('onboarding-batch-all', { ...ENV, MODEL_OVERRIDES: KIMI_GRADER }),
    ).toMatchObject({ provider: 'kimi' });
  });

  it('refuses every request but /health with 503, before any call, read, or credential', async () => {
    const fetchMock = stubFetch();
    const reads = new Set<PropertyKey>();
    const target: Env = { ...PRODUCTION_WITHOUT_KIMI_KEY, MODEL_OVERRIDES: KIMI_GRADER };
    const env = new Proxy(target, {
      get(object, key, receiver) {
        reads.add(key);
        return Reflect.get(object, key, receiver);
      },
    });
    for (const request of [
      new Request('https://app-ai.test/audit/session/exchange', { method: 'POST', body: '{}' }),
      new Request('https://app-ai.test/messages', {
        method: 'POST',
        headers: {
          'X-Personalizer-Context-ID': 'ctx',
          'X-Personalizer-System-Prompt': 'onboarding-batch-all',
        },
        body: '{"messages":[]}',
      }),
      new Request('https://app-ai.test/files', { method: 'POST', body: new FormData() }),
    ]) {
      const refused = await worker.fetch(request, env);
      expect(refused.status, request.url).toBe(503);
      expect(await refused.json()).toEqual({
        Message: 'App AI service is not ready.',
        ExceptionType: 'ServiceUnavailableException',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reads.has('KIMI_API_KEY')).toBe(false);
    expect(reads.has('AUDIT_SESSIONS')).toBe(false);

    vi.stubGlobal('__APP_AI_REV__', 'fc00704');
    vi.resetModules();
    try {
      const { default: servedWorker } = await import('../src/index');
      const health = await servedWorker.fetch(new Request('https://app-ai.test/health'), env);
      expect(health.status).toBe(503);
      const ready = await servedWorker.fetch(new Request('https://app-ai.test/health'), PRODUCTION);
      expect(ready.status).toBe(200);
    } finally {
      vi.resetModules();
    }
  });

  it('serves a production configuration inside the allow-list', async () => {
    stubFetch();
    const answered = await worker.fetch(
      new Request('https://app-ai.test/messages', { method: 'POST', body: '{}' }),
      { ...PRODUCTION },
    );
    expect(answered.status).toBe(401);
  });

  it('refuses a disallowed route at resolution, before any adapter reads a credential', async () => {
    const env: Env = { ...PRODUCTION_WITHOUT_KIMI_KEY, MODEL_OVERRIDES: KIMI_GRADER };
    expect(() => getModelProfile('onboarding-batch-all', env)).toThrow(/kimi/);
    const form = new FormData();
    form.set('file', new File(['tile'], 'tile.webp', { type: 'image/webp' }));
    form.append('prompt', 'onboarding-batch-all');
    const refused = await handleFileUpload(
      new Request('https://app-ai.test/files', { method: 'POST', body: form }),
      env,
      CORS,
      silentLoggingRuntime,
      { tenantScope: 'tenant-test' },
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      ExceptionType: 'ProviderNotAllowedException',
      MessageDetail: 'provider_not_allowed',
    });
  });

  it('pins every provider base to its own API at request time in production', () => {
    expect(anthropicApiBase(PRODUCTION)).toBe('https://api.anthropic.com');
    expect(() =>
      openaiApiBase({ ...PRODUCTION, OPENAI_API_BASE: 'https://openai-proxy.example.test' }),
    ).toThrow(/OPENAI_API_BASE/);
    expect(openaiApiBase({ ...ENV, OPENAI_API_BASE: 'http://127.0.0.1:8788' })).toBe(
      'http://127.0.0.1:8788',
    );
  });
});
