/**
 * Model catalog + configured-model routing.
 *
 * The provider is INFERRED from the configured model id, so these pin the three
 * things that inference must never get wrong: a family prefix matches every
 * version inside the family, an unrecognised id fails loudly at resolution
 * instead of defaulting to a provider, and a resolved model is checked against
 * the prompt group's declared requirements before anything reaches a provider.
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_NAMES,
  getFilePolicy,
  listFilePolicies,
  listModelFamilies,
  resolveModelFamily,
  validateModelCatalog,
} from '../src/inference/model-catalog';
import {
  UNREGISTERED_MESSAGES_MAX_TOKENS,
  describePromptRoutes,
  getGroupModelRoute,
  getModelProfile,
  getSystemPrompt,
  getUnregisteredMessagesRoute,
  listPromptGroups,
  listPromptNames,
  validateModelRouting,
} from '../src/prompt-registry';
import { modelOverrides } from '../src/config';
import type { Env } from '../src/config';
import { ENV } from './helpers';

describe('model catalog', () => {
  it('passes its own executable consistency contract', () => {
    expect(validateModelCatalog).not.toThrow();
    const prefixes = listModelFamilies().flatMap((family) => family.prefixes);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    const profiles = listModelFamilies().map((family) => family.profile);
    expect(new Set(profiles).size).toBe(profiles.length);
  });

  it('keeps every family on a file policy its own provider and API family own', () => {
    for (const family of listModelFamilies()) {
      const policy = getFilePolicy(family.filePolicy);
      expect(policy.provider, family.profile).toBe(family.provider);
      expect(policy.compatibleApiFamilies, family.profile).toContain(family.apiFamily);
    }
    for (const name of listFilePolicies()) {
      expect(
        listModelFamilies().some((family) => family.filePolicy === name),
        `${name} is orphaned`,
      ).toBe(true);
    }
  });

  it('reports exactly the providers a configured model can name', () => {
    expect([...PROVIDER_NAMES].sort()).toEqual(['anthropic', 'gemini', 'openai']);
    expect(new Set(PROVIDER_NAMES).size).toBe(PROVIDER_NAMES.length);
  });

  it('matches by family prefix, so an unreleased version inherits its family', () => {
    // Exactly the bug a literal-id table has: a version bump silently loses the
    // family's provider, capabilities, and file policy.
    for (const model of ['claude-opus-4-8', 'claude-opus-4-9', 'claude-opus-5-0-preview']) {
      const family = resolveModelFamily(model, 'MODEL_FRONTIER');
      expect(family.profile, model).toBe('claude-opus');
      expect(family.provider, model).toBe('anthropic');
      expect(family.apiFamily, model).toBe('anthropic-messages');
      expect(family.filePolicy, model).toBe('anthropic-provider-files');
    }
    expect(resolveModelFamily('claude-haiku-9', 'MODEL_FAST').profile).toBe('claude-haiku');
    expect(resolveModelFamily('claude-sonnet-6', 'MODEL_BALANCED').profile).toBe('claude-sonnet');
  });

  it('infers a non-Anthropic provider from the model id alone', () => {
    expect(resolveModelFamily('gemini-3.5-flash', 'MODEL_FAST')).toMatchObject({
      profile: 'gemini',
      provider: 'gemini',
      apiFamily: 'gemini-generate-content',
      filePolicy: 'gemini-provider-files',
    });
    expect(resolveModelFamily('gpt-5.2', 'MODEL_FRONTIER').provider).toBe('openai');
  });

  it('declares no inline cache breakpoints where the provider exposes none', () => {
    // Gemini caches a repeated prefix implicitly, with no per-block request
    // field, so the catalog states the mechanism it lacks rather than implying
    // it cannot cache.
    expect(
      resolveModelFamily('gemini-3.5-flash', 'MODEL_FAST').capabilities.inlineCacheBreakpoints,
    ).toBe(false);
    expect(getFilePolicy('gemini-provider-files')).toMatchObject({
      inputMode: 'provider-file',
      lifecycle: 'provider-managed',
      purpose: null,
    });
  });

  it('states each family capability set as a fact, not as a prompt-group preference', () => {
    // Haiku carries no reasoning control; nothing else in the Anthropic families does not.
    expect(resolveModelFamily('claude-haiku-4-5', 'MODEL_FAST').capabilities.reasoning).toBe(false);
    expect(resolveModelFamily('claude-sonnet-5', 'MODEL_BALANCED').capabilities.reasoning).toBe(
      true,
    );
    // Gemini honours no inline cache marker; the catalog says so rather than pretending parity.
    expect(
      resolveModelFamily('gemini-3-pro', 'MODEL_BALANCED').capabilities.inlineCacheBreakpoints,
    ).toBe(false);
  });

  it('throws on an unrecognised model id, naming the id and the setting that supplied it', () => {
    expect(() => resolveModelFamily('llama-4-scout', 'MODEL_FAST')).toThrow(
      /Unknown model id "llama-4-scout" configured by MODEL_FAST/,
    );
    // No default provider to fall through to.
    expect(() => resolveModelFamily('', 'MODEL_BALANCED')).toThrow(/Unknown model id/);
    expect(() => resolveModelFamily('claude-opus', 'MODEL_FRONTIER')).toThrow(/Unknown model id/);
  });
});

describe('configured model routing', () => {
  it('resolves every registered prompt and group under the test fixture bindings', () => {
    expect(() => validateModelRouting(ENV)).not.toThrow();
    for (const description of describePromptRoutes(ENV)) {
      expect(description.valid, `${description.name}: ${description.error ?? ''}`).toBe(true);
      expect(description.provider).toBe('anthropic');
      expect(description.error).toBeUndefined();
    }
  });

  it('binds the unregistered /messages passthrough to the fast tier and refuses a non-Anthropic binding', () => {
    expect(getUnregisteredMessagesRoute(ENV)).toEqual({
      model: ENV.MODEL_FAST,
      maxTokens: UNREGISTERED_MESSAGES_MAX_TOKENS,
    });
    // The passthrough speaks the Anthropic Messages API only, so a tier bound
    // elsewhere fails at resolution, naming the variable, not at the provider.
    expect(() => getUnregisteredMessagesRoute({ ...ENV, MODEL_FAST: 'gpt-5.2' })).toThrow(
      /MODEL_FAST resolves gpt-5\.2 to openai\/openai-responses/,
    );
    const { MODEL_FAST: _absent, ...missing } = ENV;
    expect(() => getUnregisteredMessagesRoute(missing)).toThrow(/MODEL_FAST/);
    // The passthrough is part of what the worker routes, so whole-configuration
    // validation rejects a fast tier the passthrough cannot speak even when
    // every registered prompt resolves (the qc gate follows its borrowed
    // Anthropic file route through an override).
    const openaiFast: Env = {
      ...ENV,
      MODEL_FAST: 'gpt-5.2',
      MODEL_OVERRIDES: 'onboarding-qc-gate=claude-haiku-4-5',
    };
    for (const description of describePromptRoutes(openaiFast)) {
      expect(description.valid, `${description.name}: ${description.error ?? ''}`).toBe(true);
    }
    expect(() => validateModelRouting(openaiFast)).toThrow(/unregistered \/messages passthrough/);
  });

  it('routes a tier to another provider from configuration alone', () => {
    const env: Env = { ...ENV, MODEL_FAST: 'gpt-5.2' };
    const placement = getSystemPrompt('placement', env);
    expect(placement.provider).toBe('openai');
    expect(placement.apiFamily).toBe('openai-responses');
    expect(placement.modelProfile).toBe('gpt');
    expect(placement.filePolicy).toBe('openai-user-data-files');
    expect(placement.model).toBe('gpt-5.2');
    // The groups still bound to MODEL_FRONTIER are untouched.
    expect(getSystemPrompt('chat', env).provider).toBe('anthropic');
  });

  it('routes a provider that caches implicitly instead of by breakpoint', () => {
    // Honouring inline cache markers is a cost characteristic, not a correctness
    // requirement: a provider that caches a stable prefix implicitly routes, and
    // the per-prompt report is where an operator sees its markers are inert.
    const env: Env = { ...ENV, MODEL_FAST: 'gemini-3.5-flash' };
    const placement = getSystemPrompt('placement', env);
    expect(placement.provider).toBe('gemini');
    expect(placement.apiFamily).toBe('gemini-generate-content');
    expect(placement.filePolicy).toBe('gemini-provider-files');
    expect(placement.model).toBe('gemini-3.5-flash');
    const routes = describePromptRoutes(env);
    const route = routes.find((entry) => entry.name === 'placement');
    expect(route?.valid).toBe(true);
    expect(route?.inlineCacheBreakpoints).toBe(false);
    expect(route?.requirements).not.toContain('inlineCacheBreakpoints');
    // A prompt on an unchanged tier still reports honoured markers.
    expect(routes.find((entry) => entry.name === 'chat')?.inlineCacheBreakpoints).toBe(true);
  });

  it('fails a tier bound to a model no family claims, before any provider I/O', () => {
    const env: Env = { ...ENV, MODEL_BALANCED: 'mistral-large-3' };
    expect(() => getSystemPrompt('proposals', env)).toThrow(
      /Unknown model id "mistral-large-3" configured by MODEL_BALANCED/,
    );
    expect(() => getGroupModelRoute('onboarding-visual', env)).toThrow(/Unknown model id/);
    const invalid = describePromptRoutes(env).filter((route) => !route.valid);
    expect(invalid.length).toBeGreaterThan(0);
    for (const route of invalid) {
      expect(route.provider).toBeNull();
      expect(route.error).toMatch(/Unknown model id/);
    }
  });

  it('rejects a configured model that cannot do the group its tier serves', () => {
    // onboarding-visual declares `reasoning`; Haiku has no reasoning control.
    const env: Env = { ...ENV, MODEL_BALANCED: 'claude-haiku-4-5' };
    expect(() => getSystemPrompt('onboarding-batch', env)).toThrow(
      /Group onboarding-visual requires reasoning, unsupported by profile claude-haiku/,
    );
    const gate = describePromptRoutes(env).find((route) => route.name === 'onboarding-batch');
    expect(gate?.valid).toBe(false);
    expect(gate?.error).toMatch(/requires reasoning/);
  });
});

describe('MODEL_OVERRIDES', () => {
  it('is empty by default and when explicitly blank', () => {
    expect(modelOverrides(ENV).size).toBe(0);
    expect(modelOverrides({ ...ENV, MODEL_OVERRIDES: '' }).size).toBe(0);
    expect(modelOverrides({ ...ENV, MODEL_OVERRIDES: '  ' }).size).toBe(0);
  });

  it('parses a sparse comma-separated list, trimming each side', () => {
    const parsed = modelOverrides({
      ...ENV,
      MODEL_OVERRIDES: ' website-industry = claude-sonnet-5 , placement=claude-haiku-4-5 ',
    });
    expect([...parsed]).toEqual([
      ['website-industry', 'claude-sonnet-5'],
      ['placement', 'claude-haiku-4-5'],
    ]);
  });

  it('overrides a whole group, and a single prompt beats its group', () => {
    const grouped: Env = { ...ENV, MODEL_OVERRIDES: 'website-analysis-visual=claude-opus-4-8' };
    expect(getSystemPrompt('probe-style', grouped).model).toBe('claude-opus-4-8');
    expect(getSystemPrompt('probe-style', grouped).modelProfile).toBe('claude-opus');
    // A prompt outside the overridden group keeps its tier binding.
    expect(getSystemPrompt('visual-verify', grouped).model).toBe(ENV.MODEL_BALANCED);

    const specific: Env = {
      ...ENV,
      MODEL_OVERRIDES: 'website-analysis-visual=claude-opus-4-8,probe-style=claude-sonnet-5',
    };
    expect(getSystemPrompt('probe-style', specific).model).toBe('claude-sonnet-5');
    expect(getSystemPrompt('probe-template', specific).model).toBe('claude-opus-4-8');
  });

  it('throws on a key naming no registered prompt or prompt group, listing the valid keys', () => {
    const env: Env = { ...ENV, MODEL_OVERRIDES: 'onboarding-btach=claude-opus-4-8' };
    let thrown: unknown;
    try {
      getSystemPrompt('chat', env);
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/MODEL_OVERRIDES key "onboarding-btach" names no registered prompt/);
    for (const group of listPromptGroups()) expect(message).toContain(group);
    for (const prompt of listPromptNames()) expect(message).toContain(prompt);
  });

  it('throws on a malformed or repeated entry rather than dropping it', () => {
    expect(() => modelOverrides({ ...ENV, MODEL_OVERRIDES: 'placement' })).toThrow(
      /must read promptGroupOrPromptName=modelId/,
    );
    expect(() => modelOverrides({ ...ENV, MODEL_OVERRIDES: 'placement=' })).toThrow(
      /must read promptGroupOrPromptName=modelId/,
    );
    expect(() => modelOverrides({ ...ENV, MODEL_OVERRIDES: '=claude-opus-4-8' })).toThrow(
      /must read promptGroupOrPromptName=modelId/,
    );
    expect(() =>
      modelOverrides({ ...ENV, MODEL_OVERRIDES: 'placement=claude-opus-4-8,placement=gpt-5' }),
    ).toThrow(/sets placement more than once/);
  });

  it('rejects an override that moves one prompt off its shared provider file route', () => {
    // onboarding-visual owns the file route that onboarding-qc-gate borrows, so
    // one prompt jumping providers would strand the evidence both passes read.
    const env: Env = { ...ENV, MODEL_OVERRIDES: 'onboarding-review-all=gpt-5.2' };
    expect(() => getModelProfile('onboarding-review-all', env)).toThrow(
      /incompatible with the onboarding-visual file route on anthropic\/anthropic-messages/,
    );
    // Moving the whole route, group and all, is coherent and therefore allowed.
    const wholeRoute: Env = {
      ...ENV,
      MODEL_OVERRIDES: 'onboarding-visual=gpt-5.2,onboarding-qc-gate=gpt-5.2',
    };
    expect(getModelProfile('onboarding-review-all', wholeRoute).provider).toBe('openai');
    expect(getModelProfile('onboarding-review-gate-all', wholeRoute).provider).toBe('openai');
  });
});
