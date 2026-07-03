/**
 * Platform toolsets (src/toolsets/{shopify,bigcommerce,klaviyo,google-ads}/ +
 * src/toolsets/integration-bridge.ts) — the wire shapes toward Brain's AI platform
 * proxy (`v2/integration-bridge/*`), the call-channel credential seam
 * (context-ID + service token, never a platform token), and the frozen
 * error-discrimination rule: `X-Ls-Integration-Bridge-Error` absent → the platform
 * speaking, surfaced verbatim as data (any status); present → LimeSpot-layer
 * envelope, degraded.
 *
 * fetch is mocked — no real network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { composeToolsets } from '../src/toolsets/registry';
import { ENV, stubFetch, fetchCall, headerOf, sentBody } from './helpers';

const SERVICE_TOKEN = ENV.PERSONALIZER_INTEGRATION_BRIDGE_TOKEN as string;
const AUTH = { contextId: 'ctx-1', env: ENV };

/** The ENV fixture minus the service token (the not-configured degrade cases). */
const { PERSONALIZER_INTEGRATION_BRIDGE_TOKEN: _serviceToken, ...ENV_WITHOUT_SERVICE_TOKEN } = ENV;

/** Mock one platform-speaking response (no X-Ls-Integration-Bridge-Error header). */
function platformResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

/** Mock one LimeSpot-layer error response (X-Ls-Integration-Bridge-Error present). */
function proxyErrorResponse(envelope: Record<string, string>, status: number) {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'X-Ls-Integration-Bridge-Error': 'gateway' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('shopify toolset — REST wire shape', () => {
  it('GET maps onto {verb} v2/integration-bridge/ShopifyPersonalizer/rest/{path}?{query} with both channel headers and no body', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"products":[]}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'products.json',
      query: { limit: '50' },
    });

    expect(out.ok).toBe(true);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe(
      'https://brain.test/v2/integration-bridge/ShopifyPersonalizer/rest/products.json?limit=50',
    );
    expect(init.method).toBe('GET');
    expect(headerOf(init, 'X-Personalizer-Context-ID')).toBe('ctx-1');
    expect(headerOf(init, 'X-Personalizer-Integration-Bridge-Token')).toBe(SERVICE_TOKEN);
    expect(init.body).toBeUndefined();
  });

  it('POST forwards the JSON body with Content-Type application/json', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"product":{"id":1}}', 201));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'POST',
      path: 'products.json',
      body: { product: { title: 'Tee' } },
    });

    expect(out.ok).toBe(true);
    expect((out.result as { platformStatus: number }).platformStatus).toBe(201);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe(
      'https://brain.test/v2/integration-bridge/ShopifyPersonalizer/rest/products.json',
    );
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'Content-Type')).toBe('application/json');
    expect(sentBody(init)).toEqual({ product: { title: 'Tee' } });
  });

  it('uppercases a lowercase method so the body still forwards and the verb is standard', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"product":{"id":1}}', 201));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'post',
      path: 'products.json',
      body: { product: { title: 'Tee' } },
    });

    expect(out.ok).toBe(true);
    const { init } = fetchCall(fetchMock, 0);
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'Content-Type')).toBe('application/json');
    expect(sentBody(init)).toEqual({ product: { title: 'Tee' } });
  });

  it('DELETE carries no body', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    await toolsets.execute('shopify_rest_request', {
      method: 'DELETE',
      path: 'products/123.json',
      body: { ignored: true },
    });

    const { init } = fetchCall(fetchMock, 0);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(headerOf(init, 'Content-Type')).toBeUndefined();
  });
});

describe('shopify toolset — GraphQL wire shape', () => {
  it('POSTs the { Query, Variables } wire body to v2/integration-bridge/ShopifyPersonalizer/graphql', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"data":{}}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_graphql', {
      query: 'query($n:Int!){ products(first:$n){ edges { node { id } } } }',
      variables: { n: 5 },
    });

    expect(out.ok).toBe(true);
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://brain.test/v2/integration-bridge/ShopifyPersonalizer/graphql');
    expect(init.method).toBe('POST');
    expect(headerOf(init, 'Content-Type')).toBe('application/json');
    expect(headerOf(init, 'X-Personalizer-Integration-Bridge-Token')).toBe(SERVICE_TOKEN);
    expect(sentBody(init)).toEqual({
      Query: 'query($n:Int!){ products(first:$n){ edges { node { id } } } }',
      Variables: { n: 5 },
    });
  });

  it('omits Variables from the wire body when the model sends none', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"data":{}}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    await toolsets.execute('shopify_graphql', { query: '{ shop { name } }' });

    const body = sentBody(fetchCall(fetchMock, 0).init);
    expect(body).toEqual({ Query: '{ shop { name } }' });
    expect('Variables' in body).toBe(false);
  });

  it('surfaces the full raw GraphQL response (data + errors + extensions) as data', async () => {
    const graphBody = {
      data: null,
      errors: [{ message: "Field 'nope' doesn't exist" }],
      extensions: { cost: { requestedQueryCost: 5 } },
    };
    stubFetch().mockResolvedValue(platformResponse(JSON.stringify(graphBody)));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_graphql', { query: '{ nope }' });

    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ platformStatus: 200, body: graphBody });
  });
});

describe('bigcommerce toolset', () => {
  it('forwards the version-prefixed path onto v2/integration-bridge/BigCommercePersonalizer/rest/', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"data":[],"meta":{}}'));

    const toolsets = composeToolsets(['BigCommercePersonalizer'], AUTH);
    const out = await toolsets.execute('bigcommerce_rest_request', {
      method: 'GET',
      path: 'v3/catalog/products',
      query: { page: '2' },
    });

    expect(out.ok).toBe(true);
    expect(fetchCall(fetchMock, 0).url).toBe(
      'https://brain.test/v2/integration-bridge/BigCommercePersonalizer/rest/v3/catalog/products?page=2',
    );
  });
});

describe('klaviyo toolset', () => {
  it('forwards the Klaviyo path + JSON:API query params onto v2/integration-bridge/Klaviyo/rest/', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"data":[],"links":{}}'));

    const toolsets = composeToolsets(['Klaviyo'], AUTH);
    const out = await toolsets.execute('klaviyo_rest_request', {
      method: 'GET',
      path: 'api/segments',
      query: { 'page[cursor]': 'abc' },
    });

    expect(out.ok).toBe(true);
    expect(fetchCall(fetchMock, 0).url).toBe(
      `https://brain.test/v2/integration-bridge/Klaviyo/rest/api/segments?${new URLSearchParams({ 'page[cursor]': 'abc' })}`,
    );
  });
});

describe('google-ads toolset — GAQL wire shape', () => {
  it('POSTs the { Query, PageSize } wire body to v2/integration-bridge/Google/gaql', async () => {
    const gaqlBody = { Results: [{ campaign: { id: '1' } }], NextPageToken: 'tok' };
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse(JSON.stringify(gaqlBody)));

    const toolsets = composeToolsets(['Google'], AUTH);
    const out = await toolsets.execute('google_ads_gaql_query', {
      query: 'SELECT campaign.id FROM campaign',
      pageSize: 100,
    });

    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ platformStatus: 200, body: gaqlBody });
    const { url, init } = fetchCall(fetchMock, 0);
    expect(url).toBe('https://brain.test/v2/integration-bridge/Google/gaql');
    expect(init.method).toBe('POST');
    expect(sentBody(init)).toEqual({
      Query: 'SELECT campaign.id FROM campaign',
      PageSize: 100,
    });
  });

  it('omits PageSize from the wire body when the model sends none', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"Results":[],"NextPageToken":""}'));

    const toolsets = composeToolsets(['Google'], AUTH);
    await toolsets.execute('google_ads_gaql_query', { query: 'SELECT campaign.id FROM campaign' });

    const body = sentBody(fetchCall(fetchMock, 0).init);
    expect(body).toEqual({ Query: 'SELECT campaign.id FROM campaign' });
    expect('PageSize' in body).toBe(false);
  });

  it('threads pageToken onto the wire body as PageToken so the model can page', async () => {
    const page2 = { Results: [{ campaign: { id: '2' } }], NextPageToken: '' };
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse(JSON.stringify(page2)));

    const toolsets = composeToolsets(['Google'], AUTH);
    const out = await toolsets.execute('google_ads_gaql_query', {
      query: 'SELECT campaign.id FROM campaign',
      pageSize: 100,
      pageToken: 'tok',
    });

    expect(out.ok).toBe(true);
    // NextPageToken from the platform body surfaces verbatim as data.
    expect(out.result).toEqual({ platformStatus: 200, body: page2 });
    expect(sentBody(fetchCall(fetchMock, 0).init)).toEqual({
      Query: 'SELECT campaign.id FROM campaign',
      PageSize: 100,
      PageToken: 'tok',
    });
  });

  it('omits PageToken from the wire body when the model sends none or an empty string', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"Results":[],"NextPageToken":""}'));

    const toolsets = composeToolsets(['Google'], AUTH);
    await toolsets.execute('google_ads_gaql_query', {
      query: 'SELECT campaign.id FROM campaign',
      pageToken: '',
    });

    const body = sentBody(fetchCall(fetchMock, 0).init);
    expect(body).toEqual({ Query: 'SELECT campaign.id FROM campaign' });
    expect('PageToken' in body).toBe(false);
  });
});

describe('error discrimination — X-Ls-Integration-Bridge-Error is the rule', () => {
  it('header ABSENT: a platform 4xx surfaces verbatim as DATA (ok: true), so the model can self-correct', async () => {
    const platformError = { errors: { title: ["can't be blank"] } };
    stubFetch().mockResolvedValue(platformResponse(JSON.stringify(platformError), 422));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'POST',
      path: 'products.json',
      body: { product: {} },
    });

    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ platformStatus: 422, body: platformError });
    expect(out.summary).toContain('422');
  });

  it('header ABSENT: a non-JSON platform body surfaces as raw text', async () => {
    stubFetch().mockResolvedValue(platformResponse('Too Many Requests', 429));

    const toolsets = composeToolsets(['Klaviyo'], AUTH);
    const out = await toolsets.execute('klaviyo_rest_request', {
      method: 'GET',
      path: 'api/segments',
    });

    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ platformStatus: 429, body: 'Too Many Requests' });
  });

  it('header PRESENT: the LimeSpot envelope degrades to "<Message> (<ExceptionType>)"', async () => {
    stubFetch().mockResolvedValue(
      proxyErrorResponse(
        {
          Message: 'Subscriber has no installed integration.',
          ExceptionType: 'SubscriberInvalidOrUninstalledException',
        },
        400,
      ),
    );

    const toolsets = composeToolsets(['BigCommercePersonalizer'], AUTH);
    const out = await toolsets.execute('bigcommerce_rest_request', {
      method: 'GET',
      path: 'v3/catalog/products',
    });

    expect(out).toEqual({
      ok: false,
      name: 'bigcommerce_rest_request',
      result: {
        error: 'Subscriber has no installed integration. (SubscriberInvalidOrUninstalledException)',
      },
      summary: 'bigcommerce_rest_request error',
    });
  });

  it('header PRESENT with an unparsable body degrades to the status fallback', async () => {
    stubFetch().mockResolvedValue(
      new Response('gateway blew up', {
        status: 502,
        headers: { 'X-Ls-Integration-Bridge-Error': 'gateway' },
      }),
    );

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_graphql', { query: '{ shop { name } }' });

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe(
      'Integration bridge request failed (502) (Exception)',
    );
  });

  it('whitelisted platform headers surface as result.headers (lowercased keys) — Link makes page_info cursors reachable', async () => {
    const link = '<https://shop.myshopify.com/admin/api/products.json?page_info=abc>; rel="next"';
    stubFetch().mockResolvedValue(
      platformResponse('{"products":[]}', 200, {
        Link: link,
        'X-Shopify-Shop-Api-Call-Limit': '32/40',
        'X-Custom-Platform-Header': 'dropped',
      }),
    );

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'products.json',
      query: { limit: '50' },
    });

    expect(out.ok).toBe(true);
    expect(out.result).toEqual({
      platformStatus: 200,
      headers: { link, 'x-shopify-shop-api-call-limit': '32/40' },
      body: { products: [] },
    });
  });

  it('Retry-After + Klaviyo RateLimit-* headers surface on a platform 429 so the model can back off', async () => {
    stubFetch().mockResolvedValue(
      platformResponse('{"errors":"rate"}', 429, {
        'Retry-After': '2.0',
        'RateLimit-Limit': '75',
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': '3',
      }),
    );

    const toolsets = composeToolsets(['Klaviyo'], AUTH);
    const out = await toolsets.execute('klaviyo_rest_request', {
      method: 'GET',
      path: 'api/segments',
    });

    expect(out.ok).toBe(true);
    expect((out.result as { headers: unknown }).headers).toEqual({
      'retry-after': '2.0',
      'ratelimit-limit': '75',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '3',
    });
  });

  it('BigCommerce X-Rate-Limit-* headers surface with lowercased keys', async () => {
    stubFetch().mockResolvedValue(
      platformResponse('{"data":[]}', 200, {
        'X-Rate-Limit-Requests-Left': '145',
        'X-Rate-Limit-Time-Reset-Ms': '12000',
        'X-Rate-Limit-Requests-Quota': 'not-whitelisted',
      }),
    );

    const toolsets = composeToolsets(['BigCommercePersonalizer'], AUTH);
    const out = await toolsets.execute('bigcommerce_rest_request', {
      method: 'GET',
      path: 'v3/catalog/products',
    });

    expect(out.ok).toBe(true);
    expect((out.result as { headers: unknown }).headers).toEqual({
      'x-rate-limit-requests-left': '145',
      'x-rate-limit-time-reset-ms': '12000',
    });
  });

  it('the headers member is omitted entirely when no whitelisted header is present', async () => {
    stubFetch().mockResolvedValue(platformResponse('{"shop":{}}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'shop.json',
    });

    expect(out.ok).toBe(true);
    expect('headers' in (out.result as Record<string, unknown>)).toBe(false);
  });

  it('a network failure degrades the tool call — never throws', async () => {
    stubFetch().mockRejectedValue(new Error('connection reset'));

    const toolsets = composeToolsets(['Google'], AUTH);
    const out = await toolsets.execute('google_ads_gaql_query', { query: 'SELECT 1' });

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe(
      'Integration bridge google_ads_gaql_query error: connection reset',
    );
  });
});

describe('call-channel credential seam', () => {
  it('degrades with NO proxy call when the service token is not configured', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets(['ShopifyPersonalizer'], {
      contextId: 'ctx-1',
      env: ENV_WITHOUT_SERVICE_TOKEN,
    });
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'products.json',
    });

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toMatch(
      /^Toolset shopify credentials unavailable: Missing required configuration variable PERSONALIZER_INTEGRATION_BRIDGE_TOKEN\./,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades with NO proxy call when the context is missing', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets(['Klaviyo'], { contextId: '', env: ENV });
    const out = await toolsets.execute('klaviyo_rest_request', {
      method: 'GET',
      path: 'api/segments',
    });

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe(
      'Toolset klaviyo credentials unavailable: Missing context',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the service token never appears in the model-visible definitions or tool results', async () => {
    stubFetch().mockResolvedValue(platformResponse('{"ok":1}'));

    const toolsets = composeToolsets(
      ['ShopifyPersonalizer', 'BigCommercePersonalizer', 'Klaviyo', 'Google'],
      AUTH,
    );
    expect(JSON.stringify(toolsets.definitions)).not.toContain(SERVICE_TOKEN);

    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'shop.json',
    });
    expect(JSON.stringify(out)).not.toContain(SERVICE_TOKEN);
  });
});

describe('input validation — malformed model input degrades locally, never a proxy call', () => {
  it('REST: a missing path degrades cleanly instead of sending /rest/undefined', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', { method: 'GET' });

    expect(out).toEqual({
      ok: false,
      name: 'shopify_rest_request',
      result: { error: "Invalid input: 'method' and 'path' must be non-empty strings." },
      summary: 'shopify_rest_request error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REST: a non-object input degrades cleanly', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets(['Klaviyo'], AUTH);
    const out = await toolsets.execute('klaviyo_rest_request', null);

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe('Invalid input: input must be an object.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REST: a top-level array input degrades cleanly (not treated as an object)', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', ['GET', 'products.json']);

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe('Invalid input: input must be an object.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GraphQL: a missing query degrades without a proxy call', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_graphql', {});

    expect(out).toEqual({
      ok: false,
      name: 'shopify_graphql',
      result: { error: "Invalid input: 'query' must be a non-empty string." },
      summary: 'shopify_graphql error',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GAQL: an empty query string degrades without a proxy call', async () => {
    const fetchMock = stubFetch();

    const toolsets = composeToolsets(['Google'], AUTH);
    const out = await toolsets.execute('google_ads_gaql_query', { query: '' });

    expect(out.ok).toBe(false);
    expect((out.result as { error: string }).error).toBe(
      "Invalid input: 'query' must be a non-empty string.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('REST path/query normalization — defensive against sloppy model input', () => {
  it('strips any leading slashes from the path so the proxy URL has no double slash', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"data":[]}'));

    const toolsets = composeToolsets(['BigCommercePersonalizer'], AUTH);
    const out = await toolsets.execute('bigcommerce_rest_request', {
      method: 'GET',
      path: '//v3/catalog/products',
    });

    expect(out.ok).toBe(true);
    expect(fetchCall(fetchMock, 0).url).toBe(
      'https://brain.test/v2/integration-bridge/BigCommercePersonalizer/rest/v3/catalog/products',
    );
  });

  it('drops null/undefined query values instead of serializing "null"/"undefined"', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"products":[]}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'products.json',
      query: { limit: '50', page_info: null, cursor: undefined },
    });

    expect(out.ok).toBe(true);
    expect(fetchCall(fetchMock, 0).url).toBe(
      'https://brain.test/v2/integration-bridge/ShopifyPersonalizer/rest/products.json?limit=50',
    );
  });

  it('ignores an array query instead of serializing its indices as ?0=…&1=…', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"products":[]}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'products.json',
      query: ['a', 'b'],
    });

    expect(out.ok).toBe(true);
    expect(fetchCall(fetchMock, 0).url).toBe(
      'https://brain.test/v2/integration-bridge/ShopifyPersonalizer/rest/products.json',
    );
  });

  it('merges a query string embedded in the path with the query object (no double ?)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"products":[]}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'products.json?limit=50',
      query: { page_info: 'abc' },
    });

    expect(out.ok).toBe(true);
    expect(fetchCall(fetchMock, 0).url).toBe(
      'https://brain.test/v2/integration-bridge/ShopifyPersonalizer/rest/products.json?limit=50&page_info=abc',
    );
  });

  it('keeps every param when the model puts multiple ? in the path (later ? treated as &)', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(platformResponse('{"products":[]}'));

    const toolsets = composeToolsets(['ShopifyPersonalizer'], AUTH);
    const out = await toolsets.execute('shopify_rest_request', {
      method: 'GET',
      path: 'products.json?limit=50?other=123',
    });

    expect(out.ok).toBe(true);
    expect(fetchCall(fetchMock, 0).url).toBe(
      'https://brain.test/v2/integration-bridge/ShopifyPersonalizer/rest/products.json?limit=50&other=123',
    );
  });
});
