/**
 * Entity-context resolution (src/toolsets/personalizer/entity-context.ts) — the
 * per-record-type fetcher table + normalizers behind the Referenced-Entities
 * block and the `get_entity_context` record dispatch.
 *
 * Asserts the frozen model-visible AiToolEntityContext contract (lib
 * CONTRACTS.md §2): per-type Brain routes + context-ID forwarding, the exact
 * normalized shape (member order, Summary grammar, Fields minimums, one-hop
 * Related, null-member omission), the campaign discount→html→image probe, the
 * tenant re-check, and the failure semantics (miss → Found:false; auth /
 * subscriber-lookup / malformed-guid → throw).
 *
 * fetch is mocked — no real network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  fetchEntityContext,
  type SharedEntityLookup,
} from '../src/toolsets/personalizer/entity-context';
import { ENV, stubFetch, fetchCall, fetchedUrls, headerOf, type FetchMock } from './helpers';

const SUB_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CAMPAIGN_GUID = '11111111-2222-3333-4444-555555555555';
const SEGMENT_GUID = '99999999-8888-7777-6666-555555555555';
const OTHER_SUB_GUID = 'ffffffff-0000-1111-2222-333333333333';

const SUBSCRIBER = { Guid: SUB_GUID, Title: 'Test Store', CurrencyCode: 'USD' };

/** A discount campaign as Brain serializes it (nulls omitted). */
const DISCOUNT = {
  Guid: CAMPAIGN_GUID,
  SubscriberGuid: SUB_GUID,
  Title: 'Summer Sale',
  Status: 'Active',
  DiscountTarget: 'Bundle',
  DiscountType: 'Percentage',
  DiscountPercentage: 12.5,
  StartDate: '2026-05-01T00:00:00',
  EndDate: '2026-08-31T00:00:00',
  Conditions: { BundleCondition: { MinimumAmount: 50 } },
  UserSegmentGuids: [SEGMENT_GUID],
  CreateDate: '2026-04-01T00:00:00',
};

const SEGMENT = {
  Guid: SEGMENT_GUID,
  SubscriberGuid: SUB_GUID,
  Title: 'VIP Customers',
  Status: 'Active',
  Deleted: false,
  Description: 'Top spenders',
  CreationDate: '2026-01-15T10:00:00',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status });

/** fetch stub routed by URL substring — first match wins, everything else 404s. */
function stubRoutes(routes: Array<[string, (url: string) => Response]>): FetchMock {
  const fetchMock = stubFetch();
  fetchMock.mockImplementation((url) => {
    const u = String(url);
    for (const [match, respond] of routes) {
      if (u.includes(match)) return Promise.resolve(respond(u));
    }
    return Promise.resolve(new Response('Not Found', { status: 404 }));
  });
  return fetchMock;
}

const subscriberRoute = (): [string, (url: string) => Response] => [
  '/v2/accounts/subscriber',
  () => json(SUBSCRIBER),
];

afterEach(() => vi.restoreAllMocks());

describe('fetchEntityContext — campaign (discount hit)', () => {
  it('normalizes the discount campaign to the frozen shape, member order included', async () => {
    const fetchMock = stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => json(DISCOUNT)],
      ['/v1/subscriberSegment?guid=', () => json(SEGMENT)],
    ]);

    const out = await fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx-9', ENV);

    expect(out).toEqual({
      Type: 'campaign',
      Id: CAMPAIGN_GUID,
      Found: true,
      Title: 'Summer Sale',
      Status: 'Active',
      Kind: 'discount',
      Summary:
        'Discount campaign "Summer Sale" (Active), 12.5% off, running 2026-05-01 to 2026-08-31.',
      Fields: {
        DiscountTarget: 'Bundle',
        DiscountType: 'Percentage',
        DiscountPercentage: 12.5,
        StartDate: '2026-05-01T00:00:00',
        EndDate: '2026-08-31T00:00:00',
        MinimumAmount: 50,
      },
      Related: [{ Type: 'segment', Id: SEGMENT_GUID, Title: 'VIP Customers' }],
    });
    // Frozen member order (mirrors Brain's AiToolEntityContext DataContract).
    expect(Object.keys(out)).toEqual([
      'Type',
      'Id',
      'Found',
      'Title',
      'Status',
      'Kind',
      'Summary',
      'Fields',
      'Related',
    ]);
    // DiscountAmount was absent on the record → omitted, never null.
    expect('DiscountAmount' in (out.Fields ?? {})).toBe(false);

    // Routes: subscriber + discount + one related-segment load, all with the context-ID.
    const urls = fetchedUrls(fetchMock);
    expect(urls).toEqual([
      'https://brain.test/v2/accounts/subscriber',
      `https://brain.test/v2/discount-campaigns/discount-campaign/${CAMPAIGN_GUID}`,
      `https://brain.test/v1/subscriberSegment?guid=${SEGMENT_GUID}`,
    ]);
    for (let call = 0; call < fetchMock.mock.calls.length; call++) {
      expect(headerOf(fetchCall(fetchMock, call).init, 'X-Personalizer-Context-ID')).toBe('ctx-9');
    }
    // No extra validation roundtrip — the forwarded context-ID is the auth.
    expect(urls.some((u) => u.includes('validate-context-id'))).toBe(false);
  });

  it('uppercase input id is normalized to the lowercase Guid echo', async () => {
    stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => json(DISCOUNT)],
      ['/v1/subscriberSegment?guid=', () => json(SEGMENT)],
    ]);
    const out = await fetchEntityContext('campaign', CAMPAIGN_GUID.toUpperCase(), 'ctx', ENV);
    expect(out.Id).toBe(CAMPAIGN_GUID);
  });
});

describe('fetchEntityContext — campaign probe (discount → html → image)', () => {
  it('falls through to an html campaign', async () => {
    stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/', () => new Response('', { status: 404 })],
      [
        '/v2/html-campaigns/html-campaign/',
        () =>
          json({
            Guid: CAMPAIGN_GUID,
            SubscriberGuid: SUB_GUID,
            Title: 'Hero Block',
            Status: 'Active',
            CreateDate: '2026-02-01T00:00:00',
          }),
      ],
    ]);

    const out = await fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out).toEqual({
      Type: 'campaign',
      Id: CAMPAIGN_GUID,
      Found: true,
      Title: 'Hero Block',
      Status: 'Active',
      Kind: 'html',
      Summary: 'HTML content campaign "Hero Block" (Active).',
      Fields: { CreateDate: '2026-02-01T00:00:00' },
      Related: [],
    });
  });

  it('falls through to an image campaign (v1, query-string guid)', async () => {
    const fetchMock = stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/', () => new Response('', { status: 404 })],
      ['/v2/html-campaigns/', () => new Response(null, { status: 204 })],
      [
        '/v1/imageCampaigns?guid=',
        () =>
          json({
            Guid: CAMPAIGN_GUID,
            SubscriberGuid: SUB_GUID,
            Title: 'Banner Swap',
            Status: 'Inactive',
            CreateDate: '2026-03-01T00:00:00',
          }),
      ],
    ]);

    const out = await fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out.Kind).toBe('image');
    expect(out.Summary).toBe('Image content campaign "Banner Swap" (Inactive).');
    expect(out.Fields).toEqual({ CreateDate: '2026-03-01T00:00:00' });
    expect(fetchedUrls(fetchMock)).toContain(
      `https://brain.test/v1/imageCampaigns?guid=${CAMPAIGN_GUID}`,
    );
  });

  it('all probes miss → the exact not-found shape', async () => {
    stubRoutes([subscriberRoute()]);
    const out = await fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out).toEqual({ Type: 'campaign', Id: CAMPAIGN_GUID, Found: false });
  });
});

describe('fetchEntityContext — bundle', () => {
  it('same discount record, bundle-flavored Summary', async () => {
    stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => json(DISCOUNT)],
      ['/v1/subscriberSegment?guid=', () => json(SEGMENT)],
    ]);
    const out = await fetchEntityContext('bundle', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out.Type).toBe('bundle');
    expect(out.Kind).toBe('discount');
    expect(out.Summary).toBe(
      'Bundle discount campaign "Summer Sale" (Active), 12.5% off, running 2026-05-01 to 2026-08-31.',
    );
    expect(out.Fields).toEqual({
      DiscountTarget: 'Bundle',
      DiscountType: 'Percentage',
      DiscountPercentage: 12.5,
      StartDate: '2026-05-01T00:00:00',
      EndDate: '2026-08-31T00:00:00',
      MinimumAmount: 50,
    });
  });
});

describe('discount Summary grammar (0.## amounts, schedule)', () => {
  const discountVariant = (patch: Record<string, unknown>) => {
    const base: Record<string, unknown> = { ...DISCOUNT, UserSegmentGuids: [] };
    delete base.DiscountPercentage;
    delete base.EndDate;
    return { ...base, ...patch };
  };

  const resolveWith = async (record: unknown) => {
    stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => json(record)],
    ]);
    return fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx', ENV);
  };

  it('integer percentage renders bare, open-ended schedule renders "from"', async () => {
    const out = await resolveWith(discountVariant({ DiscountPercentage: 15 }));
    expect(out.Summary).toBe(
      'Discount campaign "Summer Sale" (Active), 15% off, running from 2026-05-01.',
    );
  });

  it('amount fallback when no percentage', async () => {
    const out = await resolveWith(discountVariant({ DiscountAmount: 10 }));
    expect(out.Summary).toContain('10 off');
  });

  it('DiscountType literal when neither percentage nor amount is set', async () => {
    const out = await resolveWith(discountVariant({}));
    expect(out.Summary).toContain('Percentage, running from 2026-05-01.');
  });
});

describe('fetchEntityContext — segment', () => {
  it('normalizes a found segment (Kind omitted — Brain serializes it null)', async () => {
    const fetchMock = stubRoutes([
      subscriberRoute(),
      ['/v1/subscriberSegment?guid=', () => json({ ...SEGMENT, TemplateGuid: OTHER_SUB_GUID })],
    ]);

    const out = await fetchEntityContext('segment', SEGMENT_GUID, 'ctx', ENV);
    expect(out).toEqual({
      Type: 'segment',
      Id: SEGMENT_GUID,
      Found: true,
      Title: 'VIP Customers',
      Status: 'Active',
      Summary: 'Audience segment "VIP Customers" (Active).',
      Fields: {
        TemplateGuid: OTHER_SUB_GUID,
        Description: 'Top spenders',
        CreationDate: '2026-01-15T10:00:00',
      },
      Related: [],
    });
    expect('Kind' in out).toBe(false);
    expect(fetchedUrls(fetchMock)).toContain(
      `https://brain.test/v1/subscriberSegment?guid=${SEGMENT_GUID}`,
    );
  });

  it('missing Status → "unknown status" in the Summary, Status omitted', async () => {
    const segment: Record<string, unknown> = { ...SEGMENT };
    delete segment.Status;
    stubRoutes([subscriberRoute(), ['/v1/subscriberSegment?guid=', () => json(segment)]]);

    const out = await fetchEntityContext('segment', SEGMENT_GUID, 'ctx', ENV);
    expect(out.Summary).toBe('Audience segment "VIP Customers" (unknown status).');
    expect('Status' in out).toBe(false);
  });

  it('deleted segment → Found:false', async () => {
    stubRoutes([
      subscriberRoute(),
      ['/v1/subscriberSegment?guid=', () => json({ ...SEGMENT, Deleted: true })],
    ]);
    const out = await fetchEntityContext('segment', SEGMENT_GUID, 'ctx', ENV);
    expect(out).toEqual({ Type: 'segment', Id: SEGMENT_GUID, Found: false });
  });

  it('cross-subscriber segment → Found:false (tenant re-check)', async () => {
    stubRoutes([
      subscriberRoute(),
      ['/v1/subscriberSegment?guid=', () => json({ ...SEGMENT, SubscriberGuid: OTHER_SUB_GUID })],
    ]);
    const out = await fetchEntityContext('segment', SEGMENT_GUID, 'ctx', ENV);
    expect(out.Found).toBe(false);
  });
});

describe('fetchEntityContext — progress-bar', () => {
  const PROGRESS_BAR = {
    Guid: CAMPAIGN_GUID,
    SubscriberGuid: SUB_GUID,
    Title: 'Free Shipping Bar',
    Status: 'Active',
    Tiers: [
      null,
      {
        MinimumAmount: 50,
        OfferType: 'FreeShipping',
        OfferMessage: 'Free shipping!',
        ExtraField: 'dropped',
      },
      { MinimumAmount: 100, OfferType: 'Discount', DiscountPercentage: 10 },
    ],
    FinalMessage: 'You did it!',
    CreateDate: '2026-04-15T00:00:00',
  };

  it('slims tiers, merges the subscriber currency, counts tiers in the Summary', async () => {
    const fetchMock = stubRoutes([
      subscriberRoute(),
      ['/v2/progress-bar-campaigns/', () => json(PROGRESS_BAR)],
    ]);

    const out = await fetchEntityContext('progress-bar', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out).toEqual({
      Type: 'progress-bar',
      Id: CAMPAIGN_GUID,
      Found: true,
      Title: 'Free Shipping Bar',
      Status: 'Active',
      Kind: 'progressbar',
      Summary: 'Smart progress bar "Free Shipping Bar" (Active) with 2 tier(s).',
      Fields: {
        Tiers: [
          { MinimumAmount: 50, OfferType: 'FreeShipping', OfferMessage: 'Free shipping!' },
          { MinimumAmount: 100, OfferType: 'Discount', DiscountPercentage: 10 },
        ],
        FinalMessage: 'You did it!',
        Currency: 'USD',
        CreateDate: '2026-04-15T00:00:00',
      },
      Related: [],
    });
    expect(fetchedUrls(fetchMock)).toContain(
      `https://brain.test/v2/progress-bar-campaigns/${CAMPAIGN_GUID}`,
    );
  });

  it('absent Tiers → empty list, "0 tier(s)"', async () => {
    const campaign: Record<string, unknown> = { ...PROGRESS_BAR };
    delete campaign.Tiers;
    stubRoutes([subscriberRoute(), ['/v2/progress-bar-campaigns/', () => json(campaign)]]);

    const out = await fetchEntityContext('progress-bar', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out.Summary).toContain('with 0 tier(s)');
    expect(out.Fields?.Tiers).toEqual([]);
  });
});

describe('Related (one-hop targeted segments)', () => {
  it('drops failing, deleted, and cross-subscriber segments', async () => {
    const deadGuid = '00000000-0000-0000-0000-00000000dead';
    const crossGuid = '12121212-3434-5656-7878-909090909090';
    const record = {
      ...DISCOUNT,
      UserSegmentGuids: [SEGMENT_GUID, deadGuid, OTHER_SUB_GUID],
    };
    stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => json(record)],
      [`guid=${SEGMENT_GUID}`, () => json(SEGMENT)],
      [`guid=${deadGuid}`, () => new Response('boom', { status: 500 })],
      [`guid=${OTHER_SUB_GUID}`, () => json({ ...SEGMENT, SubscriberGuid: crossGuid })],
    ]);

    const out = await fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out.Related).toEqual([{ Type: 'segment', Id: SEGMENT_GUID, Title: 'VIP Customers' }]);
  });

  it('no targeted segments → empty Related, no segment fetches', async () => {
    const fetchMock = stubRoutes([
      subscriberRoute(),
      [
        '/v2/discount-campaigns/discount-campaign/',
        () => json({ ...DISCOUNT, UserSegmentGuids: [] }),
      ],
    ]);
    const out = await fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out.Related).toEqual([]);
    expect(fetchedUrls(fetchMock).some((u) => u.includes('subscriberSegment'))).toBe(false);
  });
});

describe('failure semantics', () => {
  it('malformed guid → throws, no Brain call', async () => {
    const fetchMock = stubRoutes([subscriberRoute()]);
    await expect(fetchEntityContext('campaign', 'not-a-guid', 'ctx', ENV)).rejects.toThrow(
      /Invalid entity guid/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unknown type → throws, no Brain call', async () => {
    const fetchMock = stubRoutes([subscriberRoute()]);
    await expect(fetchEntityContext('nope', CAMPAIGN_GUID, 'ctx', ENV)).rejects.toThrow(
      /Unknown entity-context type/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('subscriber lookup failure → throws (the tenant guard never fails open)', async () => {
    stubRoutes([['/v2/accounts/subscriber', () => new Response('boom', { status: 500 })]]);
    await expect(fetchEntityContext('campaign', CAMPAIGN_GUID, 'ctx', ENV)).rejects.toThrow(
      /subscriber lookup failed: 500/,
    );
  });

  it('record fetch 401 → throws (rejected context-ID surfaces, never Found:false)', async () => {
    stubRoutes([
      subscriberRoute(),
      ['/v2/discount-campaigns/', () => new Response('denied', { status: 401 })],
    ]);
    await expect(fetchEntityContext('bundle', CAMPAIGN_GUID, 'ctx', ENV)).rejects.toThrow(/401/);
  });

  it('record fetch 500 → a miss (Found:false), mirroring the swallowed facade read', async () => {
    stubRoutes([
      subscriberRoute(),
      ['/v2/progress-bar-campaigns/', () => new Response('boom', { status: 500 })],
    ]);
    const out = await fetchEntityContext('progress-bar', CAMPAIGN_GUID, 'ctx', ENV);
    expect(out).toEqual({ Type: 'progress-bar', Id: CAMPAIGN_GUID, Found: false });
  });
});

describe('shared subscriber lookup', () => {
  it('concurrent resolutions passing one shared object make ONE subscriber call', async () => {
    const fetchMock = stubRoutes([
      subscriberRoute(),
      ['/v1/subscriberSegment?guid=', () => json(SEGMENT)],
    ]);

    const shared: SharedEntityLookup = {};
    await Promise.all([
      fetchEntityContext('segment', SEGMENT_GUID, 'ctx', ENV, shared),
      fetchEntityContext('segment', SEGMENT_GUID, 'ctx', ENV, shared),
    ]);

    const subscriberCalls = fetchedUrls(fetchMock).filter((u) =>
      u.includes('/v2/accounts/subscriber'),
    );
    expect(subscriberCalls).toHaveLength(1);
  });
});
