/**
 * `IntegrationParty` — the single identity that keys the whole AI platform-proxy
 * tree. This is a verbatim mirror of Personalizer's C# enum
 * `LimeSpot.Core/Enums/IntegrationParty.cs` (member NAMES only — the wire form is
 * always the enum name, never its `EnumGuid`). Personalizer is the source of
 * truth; keep these names byte-identical so wire values match on both sides.
 *
 * Two consumers:
 *   • `validate-context-id` returns the subscriber's available parties
 *     (`AvailableIntegrationParties: string[]`, liveness-filtered by
 *     Personalizer) — the input to dynamic toolset composition (registry.ts).
 *   • Each toolset descriptor declares the parties that gate it
 *     (`integrationParties`); the executor builds the integration-bridge URL
 *     segment from the MATCHED party.
 *
 * The v1-active parties (the ones a toolset gates on today) are
 * `ShopifyPersonalizer`, `BigCommercePersonalizer`, `Klaviyo`, `Google`. The
 * full union is mirrored so any name Personalizer may send is representable; an
 * unmatched name simply gates no toolset.
 */
export type IntegrationParty =
  | 'Unknown'
  | 'Internal'
  | 'ExcelFile'
  | 'Intercom'
  | 'HubSpot'
  | 'Salesforce'
  | 'SendGrid'
  | 'ShopifyPersonalizer'
  | 'ShopifyApproach'
  | 'ShopifyCheckout'
  | 'BigCommercePersonalizer'
  | 'WooCommercePersonalizer'
  | 'Elastic'
  | 'Google'
  | 'Klaviyo'
  | 'Chargebee'
  | 'Yotpo'
  | 'OddBytes';
