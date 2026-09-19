/**
 * Model catalog — the facts a configured model id implies.
 *
 * Model IDS are configuration: `MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER`
 * bind a capability tier to a concrete model, and the sparse `MODEL_OVERRIDES`
 * list carries per-prompt exceptions. What a model IS — which provider serves it,
 * over which API family, with which capabilities, under which direct-file policy —
 * is a property of the model itself, not of a deployment, so it lives here in code
 * and never in `wrangler.toml`.
 *
 * Matching is by model-id FAMILY PREFIX, never by exact id, so a newly released
 * version inside a family inherits its family's facts with no code change. A model
 * id matching no family THROWS, naming the id and the variable that supplied it —
 * there is no default provider to fall through to, because guessing a provider is
 * how a credential, a file route, and a tenant's evidence end up at the wrong
 * vendor.
 *
 * A family prefix resolves to exactly ONE provider. Two providers serving the same
 * model family (the same weights behind two endpoints) cannot be distinguished by
 * a model id alone and must be separated at the prefix, not guessed here.
 *
 * The catalog decides WHICH provider a model belongs to. How that provider is
 * reached — which adapter instance, over which transport — stays in
 * `factory.ts`; a provider named here whose adapter is absent fails at adapter
 * selection, before any provider I/O.
 */

import type {
  FilePolicy,
  ModelCapabilities,
  ProviderApiFamily,
  ProviderName,
} from '../lib/inference-types';

export const BOUNDED_FREE_VISUAL_MODEL = '@cf/qwen/qwen3.8-27b';

/**
 * Direct-provider file policies. Each states how one provider takes uploaded
 * evidence and which API families can address a file uploaded under it.
 */
const FILE_POLICIES = {
  'anthropic-provider-files': {
    name: 'anthropic-provider-files',
    provider: 'anthropic',
    compatibleApiFamilies: ['anthropic-messages'],
    inputMode: 'provider-file',
    lifecycle: 'provider-managed',
    purpose: null,
  },
  'openai-user-data-files': {
    name: 'openai-user-data-files',
    provider: 'openai',
    compatibleApiFamilies: ['openai-responses'],
    inputMode: 'provider-file',
    lifecycle: 'provider-managed',
    purpose: 'user_data',
  },
  'gemini-provider-files': {
    name: 'gemini-provider-files',
    provider: 'gemini',
    compatibleApiFamilies: ['gemini-generate-content'],
    inputMode: 'provider-file',
    lifecycle: 'provider-managed',
    purpose: null,
  },
  'cloudflare-inline': {
    name: 'cloudflare-inline',
    provider: 'cloudflare',
    compatibleApiFamilies: ['cloudflare-workers-ai'],
    inputMode: 'inline',
    lifecycle: 'request-scoped',
    purpose: null,
  },
} as const satisfies Record<string, FilePolicy>;

/** Every direct-provider file policy the catalog can resolve. */
export type FilePolicyName = keyof typeof FILE_POLICIES;

/** Read one direct-provider file policy. */
export function getFilePolicy(name: FilePolicyName): FilePolicy {
  return FILE_POLICIES[name];
}

/** Every declared file-policy name, in declaration order. */
export function listFilePolicies(): readonly FilePolicyName[] {
  return Object.keys(FILE_POLICIES) as FilePolicyName[];
}

/**
 * One model family: the model-id prefixes that identify it and everything a
 * model id inside it implies.
 */
interface ModelFamilyDefinition {
  /** Stable profile identity carried by continuation tokens, traces, and errors. */
  readonly profile: string;
  /** The model-id prefixes that belong to this family. Longest match wins. */
  readonly prefixes: readonly [string, ...string[]];
  readonly provider: ProviderName;
  readonly apiFamily: ProviderApiFamily;
  readonly capabilities: ModelCapabilities;
  readonly filePolicy: FilePolicyName;
}

const EVERY_CAPABILITY: ModelCapabilities = {
  vision: true,
  providerFiles: true,
  streaming: true,
  structuredOutput: true,
  serverTools: true,
  clientTools: true,
  reasoning: true,
  inlineCacheBreakpoints: true,
};

/**
 * The catalog. Capabilities state what the family's models can do, not what a
 * prompt group happens to ask of them: a prompt group's `requirements` are
 * validated against these, so a capability declared here wider than reality is
 * how an unsupported request reaches a provider.
 */
const MODEL_FAMILIES = [
  {
    profile: 'claude-opus',
    prefixes: ['claude-opus-'],
    provider: 'anthropic',
    apiFamily: 'anthropic-messages',
    capabilities: EVERY_CAPABILITY,
    filePolicy: 'anthropic-provider-files',
  },
  {
    profile: 'claude-fable',
    prefixes: ['claude-fable-'],
    provider: 'anthropic',
    apiFamily: 'anthropic-messages',
    capabilities: EVERY_CAPABILITY,
    filePolicy: 'anthropic-provider-files',
  },
  {
    profile: 'claude-sonnet',
    prefixes: ['claude-sonnet-'],
    provider: 'anthropic',
    apiFamily: 'anthropic-messages',
    capabilities: EVERY_CAPABILITY,
    filePolicy: 'anthropic-provider-files',
  },
  {
    // Haiku carries no reasoning control; the Anthropic adapter's effort gate
    // (`adapters/anthropic-wire.ts`) is the wire-level statement of the same fact.
    profile: 'claude-haiku',
    prefixes: ['claude-haiku-'],
    provider: 'anthropic',
    apiFamily: 'anthropic-messages',
    capabilities: { ...EVERY_CAPABILITY, reasoning: false },
    filePolicy: 'anthropic-provider-files',
  },
  {
    profile: 'gpt',
    prefixes: ['gpt-'],
    provider: 'openai',
    apiFamily: 'openai-responses',
    capabilities: EVERY_CAPABILITY,
    filePolicy: 'openai-user-data-files',
  },
  {
    profile: 'gemini',
    prefixes: ['gemini-'],
    provider: 'gemini',
    apiFamily: 'gemini-generate-content',
    // Gemini has no cache breakpoints; implicit prefix caching is automatic and
    // needs no request field, and the explicit `cachedContents` resource is a
    // separate lifecycle no adapter owns.
    capabilities: { ...EVERY_CAPABILITY, inlineCacheBreakpoints: false },
    filePolicy: 'gemini-provider-files',
  },
  {
    profile: 'qwen-vision',
    prefixes: ['@cf/qwen/qwen3.8-'],
    provider: 'cloudflare',
    apiFamily: 'cloudflare-workers-ai',
    capabilities: {
      vision: true,
      providerFiles: false,
      streaming: false,
      structuredOutput: false,
      serverTools: false,
      clientTools: false,
      reasoning: false,
      inlineCacheBreakpoints: false,
    },
    filePolicy: 'cloudflare-inline',
  },
] as const satisfies readonly ModelFamilyDefinition[];

/** Every model-family identity the catalog can resolve. */
export type ModelProfileName = (typeof MODEL_FAMILIES)[number]['profile'];

/** One resolved model family. */
export interface ModelFamily {
  readonly profile: ModelProfileName;
  readonly prefixes: readonly [string, ...string[]];
  readonly provider: ProviderName;
  readonly apiFamily: ProviderApiFamily;
  readonly capabilities: ModelCapabilities;
  readonly filePolicy: FilePolicyName;
}

/** Every catalogued family, in declaration order. */
export function listModelFamilies(): readonly ModelFamily[] {
  return MODEL_FAMILIES;
}

/**
 * Every provider a catalogued model can resolve to. A provider with no family
 * is unreachable by configuration, so this is also the complete set a sealed
 * token or continuation may name.
 */
export const PROVIDER_NAMES: readonly ProviderName[] = [
  ...new Set(MODEL_FAMILIES.map((family) => family.provider)),
];

/**
 * Resolve a configured model id to its family.
 *
 * `configuredBy` names the variable the id came from, so an unrecognised id
 * points the operator straight at the setting to fix. Longest matching prefix
 * wins, so a narrower family always beats a broader one.
 */
export function resolveModelFamily(model: string, configuredBy: string): ModelFamily {
  let matched: ModelFamily | null = null;
  let matchedLength = 0;
  for (const family of MODEL_FAMILIES) {
    for (const prefix of family.prefixes) {
      if (model.startsWith(prefix) && prefix.length > matchedLength) {
        matched = family;
        matchedLength = prefix.length;
      }
    }
  }
  if (!matched) {
    throw new Error(
      `Unknown model id "${model}" configured by ${configuredBy}. ` +
        `It matches no model family in src/inference/model-catalog.ts, so no provider owns it. ` +
        `Configure a model in one of the known families (${knownPrefixes()}), or add its family to the catalog.`,
    );
  }
  return matched;
}

function knownPrefixes(): string {
  return MODEL_FAMILIES.flatMap((family) => family.prefixes)
    .map((prefix) => `${prefix}*`)
    .join(', ');
}

/**
 * Reject a catalog that cannot resolve deterministically. Runs once at module
 * initialization and is called directly by the architecture fitness tests.
 */
export function validateModelCatalog(): void {
  const profiles = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const family of MODEL_FAMILIES) {
    if (profiles.has(family.profile)) {
      throw new Error(`Duplicate model-family profile: ${family.profile}`);
    }
    profiles.add(family.profile);
    const policy = FILE_POLICIES[family.filePolicy];
    if (policy.provider !== family.provider) {
      throw new Error(
        `Model family ${family.profile} names file policy ${policy.name} owned by ${policy.provider}`,
      );
    }
    const compatible: readonly ProviderApiFamily[] = policy.compatibleApiFamilies;
    if (!compatible.includes(family.apiFamily)) {
      throw new Error(
        `Model family ${family.profile} uses ${family.apiFamily}, unsupported by file policy ${policy.name}`,
      );
    }
    for (const prefix of family.prefixes) {
      const owner = prefixes.get(prefix);
      if (owner) {
        throw new Error(`Model-id prefix "${prefix}" is claimed by ${owner} and ${family.profile}`);
      }
      prefixes.set(prefix, family.profile);
    }
  }
  for (const [prefix, owner] of prefixes) {
    for (const [other, otherOwner] of prefixes) {
      // A nested prefix is fine (longest match wins) only while both sides agree
      // on the provider; otherwise one id would belong to two vendors.
      if (prefix === other || !other.startsWith(prefix)) continue;
      const ownerFamily = MODEL_FAMILIES.find((family) => family.profile === owner);
      const otherFamily = MODEL_FAMILIES.find((family) => family.profile === otherOwner);
      if (ownerFamily && otherFamily && ownerFamily.provider !== otherFamily.provider) {
        throw new Error(
          `Nested model-id prefixes "${prefix}" and "${other}" resolve to different providers`,
        );
      }
    }
  }
  for (const name of listFilePolicies()) {
    if (!MODEL_FAMILIES.some((family) => family.filePolicy === name)) {
      throw new Error(`Orphan file policy: ${name}`);
    }
  }
}

validateModelCatalog();
