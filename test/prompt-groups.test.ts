/**
 * Registry contracts: the exact prompt inventory, prompt groups, profile and
 * file-policy ownership, capability fitness, and file-reusing fallback
 * compatibility.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROMPT_FALLBACK_EDGES,
  getFilePolicy,
  getFileRouteGroup,
  getGroupModelRoute,
  getPromptGroup,
  getPromptGroupDefinition,
  getPromptRequiredCapabilities,
  getSystemPrompt,
  listFileRouteGroups,
  listPromptGroups,
  listPromptNames,
  validatePromptRegistry,
  validateResolvedGroupRoute,
  type PromptGroupName,
  type PromptName,
} from '../src/prompt-registry';
import { handleFileUpload } from '../src/handlers/files';
import type {
  OpaqueFileReference,
  PromptAwareFileUploadIntent,
  PromptAwareFileUploadResponse,
} from '../src/lib/inference-types';
import { CORS, ENV, kvMock, stubFetch, DISTANT_FILE_EXPIRY } from './helpers';

const promptDocs = import.meta.glob('../docs/prompts/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

afterEach(() => vi.restoreAllMocks());

const EXPECTED_GROUPS: Readonly<Record<PromptGroupName, readonly PromptName[]>> = {
  'image-selection': ['image-selection'],
  'studio-data-agent': ['chat', 'onboarding'],
  'studio-visual-agent': ['onboarding-chat'],
  'placement-vision': ['placement'],
  'setup-strategy': ['proposals'],
  'onboarding-visual': [
    'onboarding-batch',
    'onboarding-batch-all',
    'onboarding-review',
    'onboarding-review-all',
    'onboarding-currency-recovery',
    'onboarding-css-review',
    'optimize-demand',
    'probe-currency',
  ],
  'onboarding-qc-gate': ['onboarding-review-gate-all'],
  'cartdrawer-visual': ['cartdrawer-batch-all', 'cartdrawer-review-all'],
  'optimization-conductor': [
    'optimize-boxes',
    'optimize-ads-audiences',
    'optimize-progress-bar',
    'optimize-bundles',
  ],
  'render-verification': ['visual-verify'],
  'free-render-verification': ['visual-verify-free'],
  'website-analysis-visual': ['probe-cart-wiring', 'probe-style', 'probe-template'],
  'website-industry': ['probe-industry'],
  'analytics-narrative': ['analytics-insights'],
  'billing-narrative': ['billing-assistant'],
  'grader-sales': ['grader-chat'],
};

const EXPECTED_FALLBACK_EDGES = [
  {
    name: 'whole-store proposal to per-page fallback',
    from: 'onboarding-batch-all',
    to: 'onboarding-batch',
    reusesFiles: true,
  },
  {
    name: 'holistic review to lean retry',
    from: 'onboarding-review-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'holistic review to page-chunk retry',
    from: 'onboarding-review-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'whole-store proposal evidence to holistic review',
    from: 'onboarding-batch-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'per-page proposal evidence to holistic review',
    from: 'onboarding-batch',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'quality gate to detailed holistic review',
    from: 'onboarding-review-gate-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'holistic review to advanced-CSS specialist',
    from: 'onboarding-review-all',
    to: 'onboarding-css-review',
    reusesFiles: true,
  },
  {
    name: 'holistic review evidence to currency recovery',
    from: 'onboarding-review-all',
    to: 'onboarding-currency-recovery',
    reusesFiles: true,
  },
  {
    name: 'optimize proposal to rendered review',
    from: 'optimize-demand',
    to: 'onboarding-review',
    reusesFiles: true,
  },
  {
    name: 'cart-drawer proposal to review',
    from: 'cartdrawer-batch-all',
    to: 'cartdrawer-review-all',
    reusesFiles: true,
  },
  {
    name: 'cart-drawer review correction round',
    from: 'cartdrawer-review-all',
    to: 'cartdrawer-review-all',
    reusesFiles: true,
  },
] as const;

describe('prompt registry groups and routes', () => {
  it('keeps one maintenance document per registered prompt', () => {
    const missing = listPromptNames().filter(
      (name) => !Object.keys(promptDocs).some((path) => path.endsWith(`/docs/prompts/${name}.md`)),
    );
    expect(missing).toEqual([]);
  });

  it('covers the approved prompt inventory exactly once', () => {
    const expectedNames = Object.values(EXPECTED_GROUPS).flat();
    expect(listPromptNames()).toHaveLength(expectedNames.length);
    expect(new Set(expectedNames).size).toBe(expectedNames.length);
    expect([...listPromptNames()].sort()).toEqual([...expectedNames].sort());
  });

  it('assigns every prompt to the approved group map', () => {
    const actual = Object.fromEntries(
      listPromptGroups().map((group) => [
        group,
        listPromptNames().filter((prompt) => getPromptGroup(prompt) === group),
      ]),
    );
    expect(actual).toEqual(EXPECTED_GROUPS);
  });

  it('resolves group -> tier -> configured model -> provider and file policy', () => {
    for (const groupName of listPromptGroups()) {
      const group = getPromptGroupDefinition(groupName);
      const { profile, policy: filePolicy } = getGroupModelRoute(groupName, ENV);
      if (groupName === 'free-render-verification') {
        expect(profile.model).toBe('@cf/qwen/qwen3.8-27b');
        expect(profile.provider).toBe('cloudflare');
        expect(profile.apiFamily).toBe('cloudflare-workers-ai');
        expect(filePolicy.name).toBe('cloudflare-inline');
      } else {
        expect(profile.model).toBe(
          { fast: ENV.MODEL_FAST, balanced: ENV.MODEL_BALANCED, frontier: ENV.MODEL_FRONTIER }[
            group.tier
          ],
        );
        expect(profile.provider).toBe('anthropic');
        expect(profile.apiFamily).toBe('anthropic-messages');
        expect(filePolicy).toEqual({
          name: 'anthropic-provider-files',
          provider: 'anthropic',
          compatibleApiFamilies: ['anthropic-messages'],
          inputMode: 'provider-file',
          lifecycle: 'provider-managed',
          purpose: null,
          requestedLifetimeSeconds: 30 * 24 * 60 * 60,
        });
      }
      for (const requirement of group.requirements) {
        expect(profile.capabilities[requirement], `${groupName} requires ${requirement}`).toBe(
          true,
        );
      }
    }
    for (const promptName of listPromptNames()) {
      const entry = getSystemPrompt(promptName, ENV);
      for (const requirement of getPromptRequiredCapabilities(promptName)) {
        expect(entry.capabilities[requirement], `${promptName} requires ${requirement}`).toBe(true);
      }
    }
  });

  it('keeps image-selection on the effective fast route without a caller model pin', () => {
    const entry = getSystemPrompt('image-selection', ENV);
    expect(entry.group).toBe('image-selection');
    expect(entry.tier).toBe('fast');
    expect(entry.modelProfile).toBe('claude-haiku');
    expect(entry.model).toBe(ENV.MODEL_FAST);
    expect(entry.provider).toBe('anthropic');
    expect(entry.filePolicy).toBe('anthropic-provider-files');
  });

  it('keeps every file-reusing fallback on one provider file route', () => {
    expect(PROMPT_FALLBACK_EDGES).toEqual(EXPECTED_FALLBACK_EDGES);
    for (const edge of PROMPT_FALLBACK_EDGES) {
      expect(getFileRouteGroup(getPromptGroup(edge.from)), edge.name).toBe(
        getFileRouteGroup(getPromptGroup(edge.to)),
      );
    }
  });

  it('shares one provider file route between the QC gate and the detailed reviewer', () => {
    expect(getFileRouteGroup('onboarding-qc-gate')).toBe('onboarding-visual');
    expect(getFileRouteGroup('onboarding-visual')).toBe('onboarding-visual');
    expect(listFileRouteGroups('onboarding-visual')).toEqual([
      'onboarding-visual',
      'onboarding-qc-gate',
    ]);
    expect(getGroupModelRoute('onboarding-qc-gate', ENV).profile.model).toBe(ENV.MODEL_FAST);
  });

  it('passes the executable registry validation with no orphan group/profile/policy', () => {
    expect(validatePromptRegistry).not.toThrow();
  });

  it('rejects incompatible dormant OpenAI routes before a prompt group can select them', () => {
    const candidate = {
      name: 'openai-candidate',
      provider: 'openai' as const,
      apiFamily: 'openai-responses' as const,
      capabilities: {
        vision: true,
        reusableFiles: true,
        providerFiles: true,
        streaming: true,
        structuredOutput: true,
        serverTools: true,
        clientTools: false,
        reasoning: true,
        inlineCacheBreakpoints: true,
        textConversation: true,
      },
    };
    const openAIFilePolicy = {
      name: 'openai-user-data-files',
      provider: 'openai' as const,
      compatibleApiFamilies: ['openai-responses' as const],
      inputMode: 'provider-file' as const,
      lifecycle: 'provider-managed' as const,
      purpose: 'user_data',
      requestedLifetimeSeconds: null,
    };
    expect(() =>
      validateResolvedGroupRoute('candidate', candidate, openAIFilePolicy, [
        'vision',
        'structuredOutput',
      ]),
    ).not.toThrow();
    expect(() =>
      validateResolvedGroupRoute(
        'candidate',
        candidate,
        getFilePolicy('anthropic-provider-files'),
        [],
      ),
    ).toThrow(/incompatible/);
    expect(() =>
      validateResolvedGroupRoute('studio-visual-agent', candidate, openAIFilePolicy, [
        'clientTools',
      ]),
    ).toThrow(/requires clientTools/);
  });

  it('rejects incompatible dormant Moonshot routes before a prompt group can select them', () => {
    const candidate = {
      name: 'moonshot-kimi-k3-candidate',
      provider: 'moonshot' as const,
      apiFamily: 'moonshot-chat-completions' as const,
      capabilities: {
        vision: true,
        reusableFiles: true,
        providerFiles: true,
        streaming: true,
        structuredOutput: true,
        serverTools: true,
        clientTools: true,
        reasoning: true,
        inlineCacheBreakpoints: false,
        textConversation: true,
      },
    };
    const moonshotFilePolicy = {
      name: 'moonshot-image-files',
      provider: 'moonshot' as const,
      compatibleApiFamilies: ['moonshot-chat-completions' as const],
      inputMode: 'provider-file' as const,
      lifecycle: 'provider-managed' as const,
      purpose: 'image',
      requestedLifetimeSeconds: null,
    };
    expect(() =>
      validateResolvedGroupRoute('candidate', candidate, moonshotFilePolicy, [
        'vision',
        'structuredOutput',
        'serverTools',
      ]),
    ).not.toThrow();
    expect(() =>
      validateResolvedGroupRoute(
        'candidate',
        candidate,
        getFilePolicy('anthropic-provider-files'),
        [],
      ),
    ).toThrow(/incompatible/);
    expect(() =>
      validateResolvedGroupRoute('image-selection', candidate, moonshotFilePolicy, [
        'inlineCacheBreakpoints',
      ]),
    ).toThrow(/requires inlineCacheBreakpoints/);
  });
});

describe('prompt-aware /files contract fixture', () => {
  const contractFiles = import.meta.glob('./__snapshots__/prompt-aware-files.contract.json', {
    eager: true,
    query: '?raw',
    import: 'default',
  }) as Record<string, string>;

  it('freezes the multipart destination field and the opaque prompt-addressable response', () => {
    const raw = Object.values(contractFiles)[0];
    if (!raw) throw new Error('prompt-aware-files.contract.json is missing');
    const expectedFixture = {
      promptInventory: [
        'image-selection',
        'chat',
        'onboarding-chat',
        'onboarding',
        'placement',
        'proposals',
        'analytics-insights',
        'probe-cart-wiring',
        'probe-industry',
        'probe-style',
        'probe-template',
        'probe-currency',
        'onboarding-currency-recovery',
        'onboarding-css-review',
        'onboarding-batch',
        'onboarding-batch-all',
        'onboarding-review',
        'onboarding-review-all',
        'onboarding-review-gate-all',
        'cartdrawer-batch-all',
        'cartdrawer-review-all',
        'optimize-demand',
        'optimize-boxes',
        'optimize-ads-audiences',
        'optimize-progress-bar',
        'optimize-bundles',
        'visual-verify',
        'grader-chat',
      ],
      request: {
        contentType: 'multipart/form-data',
        fields: {
          file: 'File',
          prompt: ['onboarding-batch-all', 'onboarding-review-all', 'onboarding-review-gate-all'],
        },
        promptField: 'repeated; one or more registered prompt names',
      },
      singleRouteResponse: {
        id: 'opaque_file_reference',
        type: 'file',
        references: {
          'onboarding-batch-all': {
            id: 'opaque_file_reference',
            type: 'file',
          },
          'onboarding-review-all': {
            id: 'opaque_file_reference',
            type: 'file',
          },
          'onboarding-review-gate-all': {
            id: 'opaque_file_reference',
            type: 'file',
          },
        },
      },
      multiRouteResponse: {
        id: 'opaque_onboarding_reference',
        type: 'file',
        references: {
          'onboarding-review-all': {
            id: 'opaque_onboarding_reference',
            type: 'file',
          },
          'visual-verify': {
            id: 'opaque_verification_reference',
            type: 'file',
          },
        },
      },
    } as const;
    const intent = {
      prompts: expectedFixture.request.fields.prompt,
    } satisfies PromptAwareFileUploadIntent<PromptName>;
    const single = expectedFixture.singleRouteResponse satisfies PromptAwareFileUploadResponse<
      'onboarding-batch-all' | 'onboarding-review-all' | 'onboarding-review-gate-all'
    >;
    const multi = expectedFixture.multiRouteResponse satisfies PromptAwareFileUploadResponse<
      'onboarding-review-all' | 'visual-verify'
    >;
    expect(intent.prompts).toHaveLength(expectedFixture.request.fields.prompt.length);
    // The fixture is the lib's copy byte-for-byte: every prompt it names must be
    // registered here. app-ai may register prompts the lib never selects (the
    // website-side `billing-assistant`), so the inventory is a subset check, not
    // an equality one — and the count is read from the fixture, never retyped.
    const registered = new Set<string>(listPromptNames());
    for (const prompt of expectedFixture.promptInventory) {
      expect(registered.has(prompt), `${prompt} must be registered`).toBe(true);
    }
    expect(expectedFixture.promptInventory).toHaveLength(
      new Set(expectedFixture.promptInventory).size,
    );
    expect(single.type).toBe('file');
    // One resolved route addresses every declared prompt: the map names all three,
    // each holding the one shared reference the top-level id repeats.
    expect(Object.keys(single.references)).toEqual([...expectedFixture.request.fields.prompt]);
    for (const reference of Object.values(single.references)) {
      expect(reference).toEqual({ id: single.id, type: 'file' });
    }
    expect(Object.keys(multi.references)).toHaveLength(2);
    expect(JSON.parse(raw) as unknown).toEqual(expectedFixture);
    expect(raw).toBe(`${JSON.stringify(expectedFixture, null, 2)}\n`);
  });

  interface ContractFixture {
    readonly request: { readonly fields: { readonly prompt: readonly PromptName[] } };
    readonly singleRouteResponse: PromptAwareFileUploadResponse<PromptName>;
    readonly multiRouteResponse: PromptAwareFileUploadResponse<PromptName>;
  }

  function fixture(): ContractFixture {
    const raw = Object.values(contractFiles)[0];
    if (!raw) throw new Error('prompt-aware-files.contract.json is missing');
    return JSON.parse(raw) as ContractFixture;
  }

  /**
   * The fixture's reference ids are placeholders, so a live response is compared
   * on SHAPE: every declared prompt present, `type: 'file'` throughout, and the
   * same sharing relationships — destinations the fixture gives one placeholder
   * must come back holding one minted reference, and two placeholders must not.
   * Numbering by first appearance is what removes the random value while keeping
   * the relationship it stands for.
   */
  function referenceShape(response: PromptAwareFileUploadResponse<PromptName>): unknown {
    const positions = new Map<string, number>();
    const position = (reference: OpaqueFileReference): unknown => {
      if (!positions.has(reference.id)) positions.set(reference.id, positions.size);
      return { id: `reference-${positions.get(reference.id)}`, type: reference.type };
    };
    return {
      ...(position(response) as Record<string, unknown>),
      references: Object.fromEntries(
        Object.entries(response.references).map(([prompt, reference]) => [
          prompt,
          position(reference as OpaqueFileReference),
        ]),
      ),
    };
  }

  async function upload(
    prompts: readonly PromptName[],
    uploadedIds: readonly string[],
  ): Promise<PromptAwareFileUploadResponse<PromptName>> {
    const fetchMock = stubFetch();
    for (const id of uploadedIds) {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id,
            type: 'file',
            mime_type: 'image/png',
            size_bytes: 1,
            expires_at: DISTANT_FILE_EXPIRY,
          }),
          {
            status: 200,
          },
        ),
      );
    }
    const { env } = kvMock();
    const body = new FormData();
    body.append('file', new Blob(['x'], { type: 'image/png' }), 'a.png');
    for (const prompt of prompts) body.append('prompt', prompt);
    const response = await handleFileUpload(
      new Request('https://app-ai.test/files', {
        method: 'POST',
        headers: { 'X-Personalizer-Context-ID': 'ctx-contract-fixture' },
        body,
      }),
      env,
      CORS,
    );
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(uploadedIds.length);
    return (await response.json()) as PromptAwareFileUploadResponse<PromptName>;
  }

  it('answers the fixture request shape with the fixture single-route response shape', async () => {
    const contract = fixture();
    const actual = await upload(contract.request.fields.prompt, ['file_contract_single']);
    expect(referenceShape(actual)).toEqual(referenceShape(contract.singleRouteResponse));
    expect(Object.keys(actual.references)).toEqual([...contract.request.fields.prompt]);
    expect(actual.id).toMatch(/^file_ref_v1_[A-Za-z0-9_-]+$/);
    for (const reference of Object.values(actual.references)) {
      expect(reference).toEqual({ id: actual.id, type: 'file' });
    }
  });

  it('answers a two-route request with the fixture multi-route response shape', async () => {
    const contract = fixture();
    const prompts = Object.keys(contract.multiRouteResponse.references) as PromptName[];
    const actual = await upload(prompts, ['file_contract_onboarding', 'file_contract_verify']);
    expect(referenceShape(actual)).toEqual(referenceShape(contract.multiRouteResponse));
    expect(Object.keys(actual.references)).toEqual(prompts);
    for (const reference of Object.values(actual.references)) {
      expect(reference.type).toBe('file');
      expect(reference.id).toMatch(/^file_ref_v1_[A-Za-z0-9_-]+$/);
    }
    // Two routes, so the second destination holds a reference of its own.
    const [first, second] = prompts;
    if (!first || !second) throw new Error('the fixture must declare two destinations');
    expect(actual.references[first]?.id).toBe(actual.id);
    expect(actual.references[second]?.id).not.toBe(actual.id);
  });
});
