/**
 * Coverage for the Website-Analysis PROBE mechanism — the `probe-<id>` prompt
 * convention, the industry probe, and its frozen JSON output contract:
 *   • the registry resolves `probe-industry` (text + metadata + model);
 *   • the probe index (`PROBE_SCHEMAS` / `PROBE_PREFIX` / `isProbeName`) is
 *     coherent with the registered probes;
 *   • `POST /messages` routes the `X-Personalizer-System-Prompt: probe-industry`
 *     header to the probe (injects its system block, no attachments);
 *   • the probe's output contract (`{ industry, confidence, findings }`) is
 *     asserted via a schema/parse check on a representative assistant text.
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { getSystemPrompt, isProbeName, PROBE_PREFIX, PROBE_SCHEMAS } from '../src/prompt-registry';
import { handleMessages } from '../src/handlers/messages';
import { ENV, CORS, stubFetch, fetchCall, sentBody } from './helpers';

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

afterEach(() => vi.restoreAllMocks());

describe('probe registry', () => {
  it('resolves `probe-industry` with its text + metadata + resolved model', () => {
    const entry = getSystemPrompt('probe-industry', ENV);
    // Model is the DEFAULT `frontier` tier, resolved from config.
    expect(entry.model).toBe(ENV.MODEL_FRONTIER);
    expect(entry.usesTools).toBe(false);
    // No bundled sample — the caller uploads HTML + screenshot per request.
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
    // The system text is the industry probe prompt (JSON-only industry call).
    expect(entry.prompt).toMatch(/Industry Probe/i);
    expect(entry.prompt).toMatch(/JSON/i);
    expect(entry.prompt).toMatch(/"industry"/);
    expect(entry.prompt).toMatch(/"confidence"/);
    expect(entry.prompt).toMatch(/"findings"/);
  });

  it('follows the `probe-<id>` naming convention', () => {
    expect(PROBE_PREFIX).toBe('probe-');
    expect(isProbeName('probe-industry')).toBe(true);
    expect(isProbeName('probe-style')).toBe(true);
    expect(isProbeName('image-selection')).toBe(false);
    expect(isProbeName('chat')).toBe(false);
  });

  it('documents an output schema for every registered probe (index ↔ registry)', () => {
    for (const name of Object.keys(PROBE_SCHEMAS)) {
      // Every documented probe name obeys the convention…
      expect(isProbeName(name)).toBe(true);
      // …resolves in the registry…
      expect(() => getSystemPrompt(name, ENV)).not.toThrow();
      // …and carries a described output contract.
      expect(PROBE_SCHEMAS[name]?.description.length).toBeGreaterThan(0);
      expect(PROBE_SCHEMAS[name]?.outputSchema.length).toBeGreaterThan(0);
    }
    // The industry probe's frozen schema is exactly the contract lib builds to.
    expect(PROBE_SCHEMAS['probe-industry']?.outputSchema).toBe(
      '{ "industry": string, "confidence": number (0..1), "findings": string[] }',
    );
  });

  it('resolves the generative `probe-template` on the `balanced` tier (Sonnet)', () => {
    const entry = getSystemPrompt('probe-template', ENV);
    // The template GENERATOR runs on the `balanced` tier, NOT the default
    // `frontier` tier.
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    // Still a JSON-only probe — no tools, no bundled attachments.
    expect(entry.usesTools).toBe(false);
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
    expect(entry.prompt).toMatch(/JSON/i);
  });

  it('the template probe text names its allowed grammar + safety contract', () => {
    const entry = getSystemPrompt('probe-template', ENV);
    expect(entry.prompt).toMatch(/template probe/i);
    // Output contract.
    expect(entry.prompt).toMatch(/"html"/);
    expect(entry.prompt).toMatch(/"css"/);
    expect(entry.prompt).toMatch(/"cssScoped"/);
    expect(entry.prompt).toMatch(/"setupObject"/);
    expect(entry.prompt).toMatch(/"baseTemplateName"/);
    // Product data-model — the ONLY bindable data.
    expect(entry.prompt).toMatch(/product\.DisplayUrl/);
    expect(entry.prompt).toMatch(/product\.Identifier/);
    expect(entry.prompt).toMatch(/product\.Title/);
    expect(entry.prompt).toMatch(/product\.Vendor/);
    // @Ls* children delegated the LimeSpot-owned parts.
    expect(entry.prompt).toMatch(/LsProductImage/);
    expect(entry.prompt).toMatch(/LsProductPrice/);
    expect(entry.prompt).toMatch(/LsCardQuickAction/);
    // The forbidden surfaces — spelled out so the model stays inside the grammar.
    expect(entry.prompt).toMatch(/v-html/);
    expect(entry.prompt).toMatch(/v-on/);
    // A CONSTRAINED SetupObject is allowed (WIP-gated), but the code-exec / network /
    // data-exfil surfaces are hard-rejected — the prompt must spell that out.
    expect(entry.prompt).toMatch(/SetupObject|setupObject/);
    expect(entry.prompt).toMatch(/eval|new Function/);
    expect(entry.prompt).toMatch(/fetch|XMLHttpRequest/);
    expect(entry.prompt).toMatch(/localStorage|document\.cookie/);
  });

  it('resolves the Sonnet probes `probe-cart-wiring` + `probe-style` on the `balanced` tier', () => {
    for (const name of ['probe-cart-wiring', 'probe-style']) {
      const entry = getSystemPrompt(name, ENV);
      // These heavier behavioral/visual classifiers run on the `balanced` tier,
      // NOT the default `frontier` tier the industry probe uses.
      expect(entry.model).toBe(ENV.MODEL_BALANCED);
      expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
      // Still JSON-only probes — no tools, no bundled attachments.
      expect(entry.usesTools).toBe(false);
      expect(entry.attachments).toEqual([]);
      expect(entry.maxTokens).toBeGreaterThan(0);
      expect(entry.prompt).toMatch(/JSON/i);
    }
  });

  it('the cart-wiring probe text names its selectors + surfaceType contract', () => {
    const entry = getSystemPrompt('probe-cart-wiring', ENV);
    expect(entry.prompt).toMatch(/cart-wiring probe/i);
    expect(entry.prompt).toMatch(/cartButtonQuerySelector/);
    expect(entry.prompt).toMatch(/cartContainerQuerySelector/);
    expect(entry.prompt).toMatch(/cartInnerQuerySelector/);
    expect(entry.prompt).toMatch(/surfaceType/);
    expect(entry.prompt).toMatch(/refreshAuto/);
    // Behavioral classification vocabulary.
    expect(entry.prompt).toMatch(/drawer/);
    expect(entry.prompt).toMatch(/modal/);
    expect(entry.prompt).toMatch(/dropdown/);
    expect(entry.prompt).toMatch(/native/);
    // Never invent a selector — null when unsure.
    expect(entry.prompt).toMatch(/null/);
  });

  it('the style probe text names its style descriptor contract', () => {
    const entry = getSystemPrompt('probe-style', ENV);
    expect(entry.prompt).toMatch(/style probe/i);
    expect(entry.prompt).toMatch(/layout/);
    expect(entry.prompt).toMatch(/typography/);
    expect(entry.prompt).toMatch(/cardOrientation/);
    expect(entry.prompt).toMatch(/cardStyle/);
    expect(entry.prompt).toMatch(/saleSign/);
    // Read verbatim from CSS; omit unknowns rather than guess.
    expect(entry.prompt).toMatch(/verbatim/i);
    expect(entry.prompt).toMatch(/omit/i);
  });

  it('documents an output schema for the two new probes', () => {
    expect(PROBE_SCHEMAS['probe-cart-wiring']?.outputSchema).toMatch(/surfaceType/);
    expect(PROBE_SCHEMAS['probe-cart-wiring']?.outputSchema).toMatch(/refreshAuto/);
    expect(PROBE_SCHEMAS['probe-style']?.outputSchema).toMatch(/typography/);
    expect(PROBE_SCHEMAS['probe-style']?.outputSchema).toMatch(/cardOrientation/);
  });

  it('throws on an unknown probe name', () => {
    expect(() => getSystemPrompt('probe-nonexistent', ENV)).toThrow(/not found/i);
  });
});

describe('POST /messages — probe-cart-wiring + probe-style routing', () => {
  function messagesRequest(body: unknown, systemPrompt: string): Request {
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': systemPrompt,
      },
      body: JSON.stringify(body),
    });
  }

  it('injects each Sonnet probe system block + defaults the model to the `balanced` tier', async () => {
    for (const [name, marker] of [
      ['probe-cart-wiring', /cart-wiring probe/i],
      ['probe-style', /style probe/i],
    ] as const) {
      const fetchMock = stubFetch();
      fetchMock.mockResolvedValue(jsonOk({ content: [] }));

      await handleMessages(
        // Body WITHOUT `model` — the probe transport omits it so the registry is
        // authoritative (both Sonnet probes → the `balanced` tier).
        messagesRequest({ max_tokens: 1, messages: [{ role: 'user', content: 'go' }] }, name),
        ENV,
        CORS,
      );

      const urls = fetchMock.mock.calls.map(([url]) => String(url));
      // No attachments → no /files upload.
      expect(urls.some((url) => url.includes('/files'))).toBe(false);
      const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
      const sent = sentBody(fetchCall(fetchMock, idx).init);
      expect(sent.system?.[0]?.text).toMatch(marker);
      expect(sent.model).toBe(ENV.MODEL_BALANCED);
      vi.restoreAllMocks();
    }
  });
});

describe('POST /messages — probe-industry routing', () => {
  function messagesRequest(body: unknown, systemPrompt: string): Request {
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': systemPrompt,
      },
      body: JSON.stringify(body),
    });
  }

  it('injects the industry probe system block for the probe-industry header', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ content: [] }));

    await handleMessages(
      messagesRequest(
        {
          model: 'm',
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'document', source: { type: 'file', file_id: 'html_1' } },
                { type: 'image', source: { type: 'file', file_id: 'shot_1' } },
              ],
            },
          ],
        },
        'probe-industry',
      ),
      ENV,
      CORS,
    );

    // The probe carries no attachments, so NO /files upload happens (unlike
    // image-selection, which first uploads its sample.md). The document + image
    // content blocks do trigger a best-effort /messages/count_tokens pre-flight,
    // so grab the real /messages POST — the one that isn't count_tokens.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('/files'))).toBe(false);
    const messagesCallIndex = urls.findIndex((url) => url.endsWith('/v1/messages'));
    expect(messagesCallIndex).toBeGreaterThanOrEqual(0);
    const sent = sentBody(fetchCall(fetchMock, messagesCallIndex).init);
    expect(fetchCall(fetchMock, messagesCallIndex).url).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(sent.system?.[0]?.type).toBe('text');
    expect(sent.system?.[0]?.text).toMatch(/Industry Probe/i);
    // Stable, reused prefix → extended 1h cache (matches image-selection).
    expect(sent.system?.[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // The caller's HTML + screenshot content blocks flow through untouched.
    const firstMessageContent = sent.messages?.[0]?.content;
    expect(Array.isArray(firstMessageContent)).toBe(true);
  });

  it('defaults `model` to the registry entry (the `frontier` tier) when the body omits it', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ content: [] }));

    await handleMessages(
      // Body WITHOUT `model` — the probe transport omits it so the server's
      // registry is authoritative (probe-industry → the default `frontier` tier).
      messagesRequest(
        { max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'probe-industry',
      ),
      ENV,
      CORS,
    );

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const messagesCallIndex = urls.findIndex((url) => url.endsWith('/v1/messages'));
    const sent = sentBody(fetchCall(fetchMock, messagesCallIndex).init);
    expect(sent.model).toBe(ENV.MODEL_FRONTIER);
  });

  it('preserves a caller-supplied `model` (image-selection is unaffected)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(jsonOk({ content: [] }));

    await handleMessages(
      // A caller that sends its own model (e.g. image-selection sends Haiku)
      // OWNS it — the registry-model default must not override it.
      messagesRequest(
        { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'probe-industry',
      ),
      ENV,
      CORS,
    );

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    const messagesCallIndex = urls.findIndex((url) => url.endsWith('/v1/messages'));
    const sent = sentBody(fetchCall(fetchMock, messagesCallIndex).init);
    expect(sent.model).toBe('claude-haiku-4-5');
  });

  it('returns the Anthropic envelope with the assistant JSON text unchanged', async () => {
    const assistantText = JSON.stringify({
      industry: 'Apparel & Fashion',
      confidence: 0.9,
      findings: ['Navigation lists Men, Women, Accessories.'],
    });
    stubFetch().mockResolvedValue(jsonOk({ content: [{ type: 'text', text: assistantText }] }));

    const res = await handleMessages(
      messagesRequest(
        { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'probe-industry',
      ),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe(assistantText);
  });
});

describe('probe-industry output contract', () => {
  /** Assert an object satisfies the frozen `{ industry, confidence, findings }` shape. */
  function assertIndustryShape(value: unknown): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const obj = value as Record<string, unknown>;
    // Exactly the three contract keys — no extras, no missing.
    expect(Object.keys(obj).sort()).toEqual(['confidence', 'findings', 'industry']);
    expect(typeof obj.industry).toBe('string');
    expect(typeof obj.confidence).toBe('number');
    expect(obj.confidence as number).toBeGreaterThanOrEqual(0);
    expect(obj.confidence as number).toBeLessThanOrEqual(1);
    expect(Array.isArray(obj.findings)).toBe(true);
    for (const finding of obj.findings as unknown[]) {
      expect(typeof finding).toBe('string');
    }
  }

  it('parses a well-formed probe response', () => {
    const assistantText = JSON.stringify({
      industry: 'Beauty & Cosmetics',
      confidence: 0.82,
      findings: [
        'Hero imagery features skincare and makeup products.',
        'Collections named Skincare, Makeup, Fragrance.',
      ],
    });
    assertIndustryShape(JSON.parse(assistantText));
  });

  it('accepts the low-signal `Unknown` / empty-findings sink', () => {
    const assistantText = JSON.stringify({
      industry: 'Unknown',
      confidence: 0.2,
      findings: [],
    });
    assertIndustryShape(JSON.parse(assistantText));
  });

  it('rejects a response missing a contract key', () => {
    const bad = JSON.parse(JSON.stringify({ industry: 'Electronics', confidence: 0.7 }));
    expect(() => assertIndustryShape(bad)).toThrow();
  });

  it('rejects an out-of-range confidence', () => {
    const bad = JSON.parse(
      JSON.stringify({ industry: 'Electronics', confidence: 1.5, findings: [] }),
    );
    expect(() => assertIndustryShape(bad)).toThrow();
  });

  it('rejects non-string findings', () => {
    const bad = JSON.parse(
      JSON.stringify({ industry: 'Electronics', confidence: 0.5, findings: [42] }),
    );
    expect(() => assertIndustryShape(bad)).toThrow();
  });
});
