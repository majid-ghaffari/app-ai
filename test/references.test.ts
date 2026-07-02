/**
 * Chat referencing — `context.refs` intake + the Referenced-Entities block
 * (src/lib/references.ts). Covers the frozen contract (lib CONTRACTS.md §1/§8):
 * intake sanitization + the 5-ref cap, category paths, per-type resolution
 * (record → Brain per-record admin endpoints via toolsets/personalizer/entity-context.ts,
 * analytics → own metadata with NO Brain call), the exact frozen block string,
 * and allSettled failure degradation.
 *
 * fetch is mocked — no real network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  MAX_CHAT_REFS,
  RECORD_REF_TYPES,
  ANALYTICS_REF_TYPES,
  sanitizeRefs,
  refCategoryPath,
  resolveRef,
  buildReferencedEntitiesBlock,
  type EntityReference,
} from '../src/lib/references';
import { ENV, stubFetch, fetchCall, fetchedUrls, headerOf, type FetchMock } from './helpers';

const SUB_GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CAMPAIGN_GUID = '11111111-2222-3333-4444-555555555555';
const SEGMENT_GUID = '99999999-8888-7777-6666-555555555555';
const DEAD_GUID = '00000000-0000-0000-0000-00000000dead';

const SUBSCRIBER = { Guid: SUB_GUID, Title: 'Test Store', CurrencyCode: 'USD' };

/** A found discount campaign (no targeted segments) as Brain serializes it. */
const DISCOUNT = {
  Guid: CAMPAIGN_GUID,
  SubscriberGuid: SUB_GUID,
  Title: 'Summer Sale',
  Status: 'Active',
  DiscountTarget: 'Bundle',
  DiscountType: 'Percentage',
  DiscountPercentage: 12.5,
  StartDate: '2026-05-01T00:00:00',
  UserSegmentGuids: [],
};

/** The frozen normalized payload `resolveRef` renders for DISCOUNT. */
const DISCOUNT_PAYLOAD =
  `{"Type":"campaign","Id":"${CAMPAIGN_GUID}","Found":true,` +
  '"Title":"Summer Sale","Status":"Active","Kind":"discount",' +
  '"Summary":"Discount campaign \\"Summer Sale\\" (Active), 12.5% off, running from 2026-05-01.",' +
  '"Fields":{"DiscountTarget":"Bundle","DiscountType":"Percentage","DiscountPercentage":12.5,' +
  '"StartDate":"2026-05-01T00:00:00"},"Related":[]}';

afterEach(() => vi.restoreAllMocks());

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

/** fetch stub routed by URL substring — first match wins, everything else 404s. */
function stubBrain(routes: Array<[string, (url: string) => Response]>): FetchMock {
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
  () => jsonOk(SUBSCRIBER),
];

describe('constants', () => {
  it('caps refs at 5 and freezes the type sets', () => {
    expect(MAX_CHAT_REFS).toBe(5);
    expect(RECORD_REF_TYPES).toEqual(['campaign', 'segment', 'progress-bar', 'bundle']);
    expect(ANALYTICS_REF_TYPES).toEqual(['analytics-metric', 'analytics-tab']);
  });
});

describe('sanitizeRefs (intake)', () => {
  it('returns [] for anything that is not an array', () => {
    expect(sanitizeRefs(undefined)).toEqual([]);
    expect(sanitizeRefs(null)).toEqual([]);
    expect(sanitizeRefs('refs')).toEqual([]);
    expect(sanitizeRefs({ type: 'campaign', id: 'g' })).toEqual([]);
  });

  it('drops non-object entries and entries without a valid type literal', () => {
    const good = { type: 'segment', id: 'guid-1' };
    const out = sanitizeRefs([null, 'x', 42, ['nested'], { type: 'unknown', id: 'g' }, good, {}]);
    expect(out).toEqual([good]);
  });

  it('drops record-type entries without a non-empty id string', () => {
    const out = sanitizeRefs([
      { type: 'campaign' },
      { type: 'bundle', id: '' },
      { type: 'progress-bar', id: 42 },
      { type: 'campaign', id: 'guid-ok' },
    ]);
    expect(out).toEqual([{ type: 'campaign', id: 'guid-ok' }]);
  });

  it('keeps analytics entries without an id', () => {
    const ref = { type: 'analytics-tab', metadata: { tab: 'overview', period: '30' } };
    expect(sanitizeRefs([ref])).toEqual([ref]);
  });

  it('caps at MAX_CHAT_REFS, keeping the first five in order', () => {
    const refs = Array.from({ length: 7 }, (_unused, i) => ({ type: 'segment', id: `g-${i}` }));
    const out = sanitizeRefs(refs);
    expect(out).toHaveLength(5);
    expect(out.map((ref) => ref.id)).toEqual(['g-0', 'g-1', 'g-2', 'g-3', 'g-4']);
  });
});

describe('refCategoryPath', () => {
  it('record types → record/{type}', () => {
    for (const type of RECORD_REF_TYPES) {
      expect(refCategoryPath({ type, id: 'g' })).toBe(`record/${type}`);
    }
  });

  it('analytics-tab → analytics/{tab}; analytics-metric → analytics/{tab}/{metricKey}', () => {
    expect(refCategoryPath({ type: 'analytics-tab', metadata: { tab: 'overview' } })).toBe(
      'analytics/overview',
    );
    expect(
      refCategoryPath({
        type: 'analytics-metric',
        metadata: { tab: 'overview', metricKey: 'aov-opportunity' },
      }),
    ).toBe('analytics/overview/aov-opportunity');
  });
});

describe('resolveRef', () => {
  it('record ref → per-record Brain endpoints with the context-ID header, normalized payload', async () => {
    const fetchMock = stubBrain([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => jsonOk(DISCOUNT)],
    ]);

    const payload = await resolveRef({ type: 'campaign', id: CAMPAIGN_GUID }, 'ctx-9', ENV);
    expect(payload).toBe(DISCOUNT_PAYLOAD);
    expect(fetchedUrls(fetchMock)).toEqual([
      'https://brain.test/v2/accounts/subscriber',
      `https://brain.test/v2/discount-campaigns/discount-campaign/${CAMPAIGN_GUID}`,
    ]);
    for (let call = 0; call < fetchMock.mock.calls.length; call++) {
      expect(headerOf(fetchCall(fetchMock, call).init, 'X-Personalizer-Context-ID')).toBe('ctx-9');
    }
  });

  it('record ref → throws when the subscriber lookup fails', async () => {
    stubFetch().mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(resolveRef({ type: 'segment', id: SEGMENT_GUID }, 'ctx', ENV)).rejects.toThrow(
      /500/,
    );
  });

  it('record ref with an unresolvable id → the Found:false payload (not a throw)', async () => {
    stubBrain([subscriberRoute()]);
    const payload = await resolveRef({ type: 'campaign', id: CAMPAIGN_GUID }, 'ctx', ENV);
    expect(payload).toBe(`{"Type":"campaign","Id":"${CAMPAIGN_GUID}","Found":false}`);
  });

  it('analytics ref → metadata verbatim as one-line JSON, NO fetch', async () => {
    const fetchMock = stubFetch();

    const ref: EntityReference = {
      type: 'analytics-metric',
      metadata: { tab: 'overview', period: '30', metricKey: 'aov-opportunity', value: 42 },
    };
    const payload = await resolveRef(ref, 'ctx', ENV);
    expect(payload).toBe(JSON.stringify(ref.metadata));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('buildReferencedEntitiesBlock', () => {
  it('returns null when there are no refs', async () => {
    expect(await buildReferencedEntitiesBlock([], 'ctx', ENV)).toBeNull();
    expect(await buildReferencedEntitiesBlock(undefined, 'ctx', ENV)).toBeNull();
  });

  it('matches the frozen block string exactly (heading + preamble + line grammar)', async () => {
    stubBrain([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => jsonOk(DISCOUNT)],
    ]);

    const refs: EntityReference[] = [
      { type: 'campaign', id: CAMPAIGN_GUID, label: 'Summer Sale' },
      {
        type: 'analytics-metric',
        label: 'AOV opportunity',
        metadata: { tab: 'overview', period: '30', metricKey: 'aov-opportunity' },
      },
    ];
    const block = await buildReferencedEntitiesBlock(refs, 'ctx', ENV);

    // FROZEN string snapshot — contract §3.2. Do not restructure to pass.
    expect(block).toBe(
      '## Referenced Entities\n' +
        'The user opened this conversation with the entities below ALREADY in context. They ARE the topic — do not ask "which one?". Ground every answer in this data.\n' +
        '\n' +
        `- [campaign] "Summer Sale" (id ${CAMPAIGN_GUID}): ${DISCOUNT_PAYLOAD}\n` +
        '- [analytics-metric] "AOV opportunity" (analytics/overview/aov-opportunity): {"tab":"overview","period":"30","metricKey":"aov-opportunity"}',
    );
  });

  it('label falls back to id, then to the category path', async () => {
    stubBrain([subscriberRoute()]);
    const block = await buildReferencedEntitiesBlock(
      [
        { type: 'bundle', id: CAMPAIGN_GUID },
        { type: 'analytics-tab', metadata: { tab: 'overview', period: '30' } },
      ],
      'ctx',
      ENV,
    );
    expect(block).toContain(
      `- [bundle] "${CAMPAIGN_GUID}" (id ${CAMPAIGN_GUID}): ` +
        `{"Type":"bundle","Id":"${CAMPAIGN_GUID}","Found":false}`,
    );
    expect(block).toContain(
      '- [analytics-tab] "analytics/overview" (analytics/overview): {"tab":"overview","period":"30"}',
    );
  });

  it('a failing ref degrades to "(could not load)" while the others stay intact (allSettled)', async () => {
    const segment = {
      Guid: SEGMENT_GUID,
      SubscriberGuid: SUB_GUID,
      Title: 'VIP Customers',
      Status: 'Active',
      Deleted: false,
      CreationDate: '2026-01-15T10:00:00',
    };
    const fetchMock = stubFetch();
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.includes(`guid=${DEAD_GUID}`)) {
        return Promise.reject(new Error('network down'));
      }
      if (u.includes('/v2/accounts/subscriber')) {
        return Promise.resolve(jsonOk(SUBSCRIBER));
      }
      return Promise.resolve(jsonOk(segment));
    });

    const block = await buildReferencedEntitiesBlock(
      [
        { type: 'segment', id: DEAD_GUID, label: 'Dead' },
        { type: 'segment', id: SEGMENT_GUID, label: 'Live' },
      ],
      'ctx',
      ENV,
    );
    expect(block).toContain(`- [segment] "Dead" (id ${DEAD_GUID}): (could not load)`);
    expect(block).toContain(
      `- [segment] "Live" (id ${SEGMENT_GUID}): {"Type":"segment","Id":"${SEGMENT_GUID}","Found":true,` +
        '"Title":"VIP Customers","Status":"Active",' +
        '"Summary":"Audience segment \\"VIP Customers\\" (Active).",' +
        '"Fields":{"CreationDate":"2026-01-15T10:00:00"},"Related":[]}',
    );
  });

  it('one block build makes ONE subscriber lookup across all record refs', async () => {
    const fetchMock = stubBrain([
      subscriberRoute(),
      ['/v2/discount-campaigns/discount-campaign/', () => jsonOk(DISCOUNT)],
    ]);
    await buildReferencedEntitiesBlock(
      [
        { type: 'campaign', id: CAMPAIGN_GUID },
        { type: 'bundle', id: CAMPAIGN_GUID },
      ],
      'ctx',
      ENV,
    );
    const subscriberCalls = fetchedUrls(fetchMock).filter((u) =>
      u.includes('/v2/accounts/subscriber'),
    );
    expect(subscriberCalls).toHaveLength(1);
  });

  it('analytics-only refs build the block with NO Brain call', async () => {
    const fetchMock = stubFetch();

    const block = await buildReferencedEntitiesBlock(
      [{ type: 'analytics-tab', label: 'Overview', metadata: { tab: 'overview', period: '30' } }],
      'ctx',
      ENV,
    );
    expect(block).toContain('- [analytics-tab] "Overview" (analytics/overview):');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
