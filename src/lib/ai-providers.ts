import type { ProviderName } from './inference-types';

interface AiSubprocessorTerms {
  readonly dpaName: string;
  readonly apiHost: string;
}

/**
 * The AI sub-processors LimeSpot's DPA lists, keyed by the stable name code refers to each by, with
 * its name exactly as the DPA prints it and the host of its official API origin, which is always
 * HTTPS. It matches the workspace's canonical `ai-providers.json` and changes only in the release
 * that changes the DPA.
 */
export const AI_SUBPROCESSORS = {
  ANTHROPIC: { dpaName: 'Anthropic, PBC', apiHost: 'api.anthropic.com' },
  OPENAI: { dpaName: 'OpenAI, L.L.C.', apiHost: 'api.openai.com' },
  GEMINI: {
    dpaName: 'Google LLC, Gemini API, paid tier',
    apiHost: 'generativelanguage.googleapis.com',
  },
  CLOUDFLARE_WORKERS_AI: { dpaName: 'Cloudflare, Inc.', apiHost: 'api.cloudflare.com' },
} as const satisfies Readonly<Record<string, AiSubprocessorTerms>>;

export type AiSubprocessor = keyof typeof AI_SUBPROCESSORS;

interface ProviderTerms {
  readonly subprocessor: AiSubprocessor | null;
  readonly apiBase: string | null;
}

const PROVIDERS: Readonly<Record<ProviderName, ProviderTerms>> = {
  anthropic: { subprocessor: 'ANTHROPIC', apiBase: AI_SUBPROCESSORS.ANTHROPIC.apiHost },
  openai: { subprocessor: 'OPENAI', apiBase: AI_SUBPROCESSORS.OPENAI.apiHost },
  gemini: { subprocessor: 'GEMINI', apiBase: `${AI_SUBPROCESSORS.GEMINI.apiHost}/v1beta` },
  cloudflare: { subprocessor: 'CLOUDFLARE_WORKERS_AI', apiBase: null },
  moonshot: { subprocessor: null, apiBase: 'api.moonshot.ai' },
  kimi: { subprocessor: null, apiBase: 'api.kimi.com/coding' },
};

export function aiSubprocessorOf(provider: ProviderName): AiSubprocessor | null {
  return PROVIDERS[provider].subprocessor;
}

/**
 * Whether `provider` may serve a route: any provider the DPA lists, and one it does not list only
 * on a route that carries no merchant, shopper, user or captured-page content.
 */
export function mayServeRoute(provider: ProviderName, carriesCustomerContent: boolean): boolean {
  return PROVIDERS[provider].subprocessor !== null || !carriesCustomerContent;
}

/**
 * Whether `configured` is `provider`'s own API base written exactly: HTTPS, its host and path, and
 * nothing more, not even a trailing slash, so every path appended to it is well formed.
 */
export function isOfficialProviderBase(provider: ProviderName, configured: string): boolean {
  const apiBase = PROVIDERS[provider].apiBase;
  if (apiBase === null) return false;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return false;
  }
  const path = url.pathname === '/' ? '' : url.pathname;
  return (
    url.protocol === 'https:' &&
    `${url.host}${path}` === apiBase &&
    configured === `${url.protocol}//${url.host}${path}`
  );
}
