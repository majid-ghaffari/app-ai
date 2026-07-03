/**
 * Toolset registry (src/toolsets/registry.ts) — party-driven composition, the
 * per-request credential seam, and the frozen model-visible tool contract
 * (docs/TOOLSETS.md; lib CONTRACTS.md §2). Composition is keyed off the
 * subscriber's available IntegrationParty set: always-active toolsets (empty
 * `integrationParties`, e.g. personalizer) join every request; party-gated
 * toolsets join only when their party is present.
 *
 * fetch is mocked — no real network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { composeToolsets } from '../src/toolsets/registry';
import type { EntityReference } from '../src/lib/references';
import { ENV, stubFetch, fetchCall, headerOf } from './helpers';

const AUTH = { contextId: 'ctx-1', env: ENV };

describe('composeToolsets — composition', () => {
  it('no parties → only the always-active personalizer toolset, definitions in stable order', () => {
    const toolsets = composeToolsets([], AUTH);
    expect(toolsets.names).toEqual(['personalizer']);
    expect(toolsets.definitions.map((definition) => definition.name)).toEqual([
      'get_store_analytics',
      'list_segments',
      'list_campaigns',
      'get_store_config',
      'get_entity_context',
    ]);
  });

  it('a party the subscriber has but no toolset declares is ignored (still just personalizer)', () => {
    const toolsets = composeToolsets(['HubSpot', 'Yotpo'], AUTH);
    expect(toolsets.names).toEqual(['personalizer']);
  });

  it('a party-gated toolset joins only when its party is present', () => {
    const toolsets = composeToolsets(['Klaviyo'], AUTH);
    expect(toolsets.names).toEqual(['personalizer', 'klaviyo']);
  });

  it('composes every toolset: names + tool definitions in registered order (personalizer always first)', () => {
    const toolsets = composeToolsets(
      ['ShopifyPersonalizer', 'BigCommercePersonalizer', 'Klaviyo', 'Google'],
      AUTH,
    );
    expect(toolsets.names).toEqual([
      'personalizer',
      'shopify',
      'bigcommerce',
      'klaviyo',
      'google-ads',
    ]);
    expect(toolsets.definitions.map((definition) => definition.name)).toEqual([
      'get_store_analytics',
      'list_segments',
      'list_campaigns',
      'get_store_config',
      'get_entity_context',
      'shopify_rest_request',
      'shopify_graphql',
      'bigcommerce_rest_request',
      'klaviyo_rest_request',
      'google_ads_gaql_query',
    ]);
  });

  it('two compositions are independent (per-request scope, no shared state)', () => {
    const a = composeToolsets([], { contextId: 'ctx-A', env: ENV });
    const b = composeToolsets([], { contextId: 'ctx-B', env: ENV });
    expect(a).not.toBe(b);
    expect(a.definitions).toEqual(b.definitions);
  });
});

describe('composeToolsets — party gating', () => {
  afterEach(() => vi.restoreAllMocks());

  it("a gated-off toolset's tool degrades to the Unknown-tool shape with NO backend call", async () => {
    const fetchMock = stubFetch();

    // No Shopify party → the shopify toolset is not composed; its tool is unknown.
    const toolsets = composeToolsets([], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'shop.json',
    });

    expect(out).toEqual({
      ok: false,
      name: 'shopify_rest_request',
      result: { error: 'Unknown tool: shopify_rest_request' },
      summary: 'Unknown tool: shopify_rest_request',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a name no toolset owns degrades identically', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets([], AUTH);
    const out = await toolsets.execute('nope', {});

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe('Unknown tool: nope');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('composeToolsets — credential seam', () => {
  afterEach(() => vi.restoreAllMocks());

  it('personalizer resolves the composition contextId and forwards it as the Brain auth header', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const toolsets = composeToolsets([], { contextId: 'ctx-42', env: ENV });
    const out = await toolsets.execute('get_store_config', {});

    expect(out.ok).toBe(true);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://brain.test/v2/ai-tools/store-config');
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBe('ctx-42');
  });

  it('credentials are scoped to their composition — two requests never share them', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const a = composeToolsets([], { contextId: 'ctx-A', env: ENV });
    const b = composeToolsets([], { contextId: 'ctx-B', env: ENV });
    await a.execute('get_store_config', {});
    await b.execute('get_store_config', {});

    expect(headerOf(fetchCall(fetchMock, 0).init, 'X-Personalizer-Context-ID')).toBe('ctx-A');
    expect(headerOf(fetchCall(fetchMock, 1).init, 'X-Personalizer-Context-ID')).toBe('ctx-B');
  });

  it('credentials never appear in the model-visible tool definitions', () => {
    const secret = 'ctx-super-secret-credential';
    const toolsets = composeToolsets([], { contextId: secret, env: ENV });
    expect(JSON.stringify(toolsets.definitions)).not.toContain(secret);
  });

  it('per-call extras (refs) reach the owning toolset executor', async () => {
    const fetchMock = stubFetch();

    const refs: EntityReference[] = [
      { type: 'analytics-tab', label: 'Overview', metadata: { tab: 'overview', period: '30' } },
    ];
    const toolsets = composeToolsets([], AUTH);
    const out = await toolsets.execute(
      'get_entity_context',
      { type: 'analytics-tab', id: 'analytics/overview' },
      { refs },
    );

    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ tab: 'overview', period: '30' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('frozen model-visible tool contract', () => {
  it('composed tool names + input schemas match the contract snapshot byte-for-byte', async () => {
    const { definitions } = composeToolsets(
      ['ShopifyPersonalizer', 'BigCommercePersonalizer', 'Klaviyo', 'Google'],
      AUTH,
    );
    await expect(JSON.stringify(definitions, null, 2)).toMatchFileSnapshot(
      './__snapshots__/tool-definitions.contract.json',
    );
  });
});
