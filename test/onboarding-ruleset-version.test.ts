/**
 * Coverage for the cross-repo onboarding RULESET-VERSION handshake (F7 + L5):
 *   • the registry constant `ONBOARDING_RULESET_VERSION` equals the FIRST LINE of
 *     the composed `_block-fixed-rules.md` (the pinned seam — the lib holds the
 *     equal string and sends it as a header);
 *   • the four onboarding propose/review entries declare `rulesetVersion`; the
 *     non-onboarding prompts (probes / chat / image-selection) do NOT;
 *   • the version string + the enforced-rule guidance compose into each
 *     onboarding prompt's STABLE prefix (the cached system block, not per-shop data);
 *   • POST /messages proceeds on a MATCHING header, proceeds on an ABSENT header
 *     (fail-OPEN rollout default), and rejects a MISMATCH with a 409
 *     `RulesetVersionMismatchException` in the Brain envelope naming BOTH versions.
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { getSystemPrompt, ONBOARDING_RULESET_VERSION } from '../src/prompt-registry';
import blockFixedRules from '../src/prompts/onboarding-shared/_block-fixed-rules.md';
import { handleMessages } from '../src/handlers/messages';
import { ENV, CORS, stubFetch } from './helpers';

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

const ONBOARDING_PROMPTS = [
  'onboarding-batch',
  'onboarding-batch-all',
  'onboarding-review',
  'onboarding-review-all',
] as const;

// The sibling playbook conductors that reuse the shared onboarding blocks and so
// ALSO participate in the handshake (they carry `rulesetVersion` too, but do NOT
// compose `_block-fixed-rules.md` — the version is their playbook contract id).
const SIBLING_HANDSHAKE_PROMPTS = [
  'cartdrawer-batch-all',
  'cartdrawer-review-all',
  'optimize-demand',
] as const;

// Prompts that must NOT participate in the handshake (no `rulesetVersion`).
const NON_HANDSHAKE_PROMPTS = [
  'chat',
  'image-selection',
  'proposals',
  'visual-verify',
  'probe-industry',
  'probe-style',
  'onboarding-currency-recovery',
];

afterEach(() => vi.restoreAllMocks());

describe('onboarding ruleset-version — registry ↔ prompt pin', () => {
  it('the fixed-rules block FIRST LINE is exactly the registry version string', () => {
    const firstLine = blockFixedRules.trim().split('\n')[0];
    expect(firstLine).toBe(ONBOARDING_RULESET_VERSION);
    // The version is the literal cross-repo constant the lib must match.
    expect(ONBOARDING_RULESET_VERSION).toBe('limespot-onboarding-playbook-v2');
  });

  it('the four onboarding entries declare the ruleset version', () => {
    for (const name of ONBOARDING_PROMPTS) {
      expect(getSystemPrompt(name, ENV).rulesetVersion).toBe(ONBOARDING_RULESET_VERSION);
    }
  });

  it('the three sibling playbook conductors ALSO declare the ruleset version', () => {
    for (const name of SIBLING_HANDSHAKE_PROMPTS) {
      expect(getSystemPrompt(name, ENV).rulesetVersion).toBe(ONBOARDING_RULESET_VERSION);
    }
  });

  it('non-handshake prompts do NOT declare a ruleset version', () => {
    for (const name of NON_HANDSHAKE_PROMPTS) {
      expect(getSystemPrompt(name, ENV).rulesetVersion).toBeUndefined();
    }
  });

  it('the version + enforced-rule guidance compose into each onboarding stable prefix', () => {
    for (const name of ONBOARDING_PROMPTS) {
      const prompt = getSystemPrompt(name, ENV).prompt;
      expect(prompt).toContain(ONBOARDING_RULESET_VERSION);
      // The enforced-rule guidance (advisory framing) rides with it.
      expect(prompt).toContain('applied deterministically AFTER your proposal');
      expect(prompt).toMatch(/Upsell` falls back to Related Items/);
      expect(prompt).toMatch(/BoughtTogether.*falls back to Cross-Sell/);
      expect(prompt).toMatch(/Cart-page Smart Progress Bar always sits at the TOP/);
    }
  });
});

describe('POST /messages — ruleset-version handshake enforcement', () => {
  function messagesRequest(systemPrompt: string, rulesetHeader?: string | null): Request {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Personalizer-Context-ID': 'ctx',
      'X-Personalizer-System-Prompt': systemPrompt,
    };
    if (rulesetHeader != null) headers['X-Personalizer-Ruleset-Version'] = rulesetHeader;
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [{ role: 'user', content: 'go' }] }),
    });
  }

  it('PROCEEDS to Anthropic when the header MATCHES the entry version', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [] }));

    const res = await handleMessages(
      messagesRequest('onboarding-batch-all', ONBOARDING_RULESET_VERSION),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith('/v1/messages'))).toBe(true);
  });

  it('PROCEEDS (fail-OPEN) when the header is ABSENT — the rollout default', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [] }));

    const res = await handleMessages(messagesRequest('onboarding-batch-all'), ENV, CORS);
    expect(res.status).toBe(200);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith('/v1/messages'))).toBe(true);
  });

  it('REJECTS a MISMATCH with a 409 RulesetVersionMismatchException naming both versions', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [] }));

    const res = await handleMessages(
      messagesRequest('onboarding-batch-all', 'limespot-onboarding-playbook-v0'),
      ENV,
      CORS,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ExceptionType).toBe('RulesetVersionMismatchException');
    // Both the caller's stale version AND the server's expected version are named.
    expect(String(body.Message)).toContain('limespot-onboarding-playbook-v0');
    expect(String(body.Message)).toContain(ONBOARDING_RULESET_VERSION);
    // No inference happened — the gate fired before the Anthropic call.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith('/v1/messages'))).toBe(false);
  });

  it('IGNORES the header for a non-onboarding prompt (no rulesetVersion → skip)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [] }));

    // A mismatching header on a prompt that does not declare a version is a no-op.
    const res = await handleMessages(
      messagesRequest('probe-industry', 'limespot-onboarding-playbook-v0'),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.endsWith('/v1/messages'))).toBe(true);
  });

  it('enforces the handshake for every onboarding prompt (mismatch → 409)', async () => {
    for (const name of ONBOARDING_PROMPTS) {
      const fetchMock = stubFetch();
      fetchMock.mockImplementation(async () => jsonOk({ content: [] }));
      const res = await handleMessages(messagesRequest(name, 'wrong-version'), ENV, CORS);
      expect(res.status).toBe(409);
      vi.restoreAllMocks();
    }
  });

  it('enforces the handshake for the three sibling conductors too (mismatch → 409)', async () => {
    for (const name of SIBLING_HANDSHAKE_PROMPTS) {
      const fetchMock = stubFetch();
      fetchMock.mockImplementation(async () => jsonOk({ content: [] }));
      const res = await handleMessages(messagesRequest(name, 'wrong-version'), ENV, CORS);
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ExceptionType).toBe('RulesetVersionMismatchException');
      // No inference happened — the gate fired before the Anthropic call.
      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.endsWith('/v1/messages'))).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it('the siblings PROCEED on a MATCHING header and (fail-OPEN) on an ABSENT header', async () => {
    for (const name of SIBLING_HANDSHAKE_PROMPTS) {
      // Matching header → reaches Anthropic.
      let fetchMock = stubFetch();
      fetchMock.mockImplementation(async () => jsonOk({ content: [] }));
      let res = await handleMessages(messagesRequest(name, ONBOARDING_RULESET_VERSION), ENV, CORS);
      expect(res.status).toBe(200);
      expect(
        fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.endsWith('/v1/messages')),
      ).toBe(true);
      vi.restoreAllMocks();

      // Absent header → fail-OPEN rollout default: still proceeds.
      fetchMock = stubFetch();
      fetchMock.mockImplementation(async () => jsonOk({ content: [] }));
      res = await handleMessages(messagesRequest(name), ENV, CORS);
      expect(res.status).toBe(200);
      expect(
        fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.endsWith('/v1/messages')),
      ).toBe(true);
      vi.restoreAllMocks();
    }
  });
});
