/**
 * Configuration module (src/config.ts) — the no-fallback contract: every
 * required variable read fails fast with an error naming the variable and
 * where to set it; the optional FILES_KV binding is the only allowed absence
 * (its degradation is covered in test/token-saving.test.ts → file-dedup no-op).
 *
 * Also pins the PRODUCTION configuration values in wrangler.toml `[vars]` —
 * the deployed wire contract (Brain routing, model choices) is config now, so
 * the contract proof reads the deploy manifest itself.
 */

import { describe, it, expect } from 'vitest';

import {
  personalizerApiUrl,
  personalizerIntegrationBridgeToken,
  anthropicApiBase,
  claudeApiKey,
  credentialedOrigins,
  modelDefault,
  modelPlacement,
  type Env,
} from '../src/config';
import { ENV } from './helpers';

const EMPTY_ENV: Env = {};

describe('config accessors — present values', () => {
  it('returns the configured values verbatim', () => {
    expect(personalizerApiUrl(ENV)).toBe('https://brain.test');
    expect(anthropicApiBase(ENV)).toBe('https://api.anthropic.com');
    expect(claudeApiKey(ENV)).toBe('test-key');
    expect(personalizerIntegrationBridgeToken(ENV)).toBe('svc-token-256bit-opaque');
    expect(modelDefault(ENV)).toBe('claude-opus-4-8');
    expect(modelPlacement(ENV)).toBe('claude-haiku-4-5');
  });

  it('parses CREDENTIALED_ORIGINS as a trimmed, empties-dropped comma list', () => {
    const env: Env = {
      ...ENV,
      CREDENTIALED_ORIGINS: ' https://a.example , http://localhost:4200 ,, ',
    };
    expect(credentialedOrigins(env)).toEqual(['https://a.example', 'http://localhost:4200']);
  });
});

describe('config accessors — missing config = error (no fallback defaults)', () => {
  it('personalizerApiUrl names PERSONALIZER_API_URL and where to set it', () => {
    expect(() => personalizerApiUrl(EMPTY_ENV)).toThrow(
      /Missing required configuration variable PERSONALIZER_API_URL.*wrangler\.toml/,
    );
  });

  it('anthropicApiBase names ANTHROPIC_API_BASE', () => {
    expect(() => anthropicApiBase(EMPTY_ENV)).toThrow(
      /Missing required configuration variable ANTHROPIC_API_BASE.*wrangler\.toml/,
    );
  });

  it('claudeApiKey names CLAUDE_API_KEY and the secret channels', () => {
    expect(() => claudeApiKey(EMPTY_ENV)).toThrow(
      /Missing required configuration variable CLAUDE_API_KEY.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('personalizerIntegrationBridgeToken names PERSONALIZER_INTEGRATION_BRIDGE_TOKEN and the secret channels', () => {
    expect(() => personalizerIntegrationBridgeToken(EMPTY_ENV)).toThrow(
      /Missing required configuration variable PERSONALIZER_INTEGRATION_BRIDGE_TOKEN.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('credentialedOrigins names CREDENTIALED_ORIGINS', () => {
    expect(() => credentialedOrigins(EMPTY_ENV)).toThrow(
      /Missing required configuration variable CREDENTIALED_ORIGINS/,
    );
  });

  it('the model accessors name MODEL_DEFAULT / MODEL_PLACEMENT', () => {
    expect(() => modelDefault(EMPTY_ENV)).toThrow(
      /Missing required configuration variable MODEL_DEFAULT/,
    );
    expect(() => modelPlacement(EMPTY_ENV)).toThrow(
      /Missing required configuration variable MODEL_PLACEMENT/,
    );
  });

  it('an empty-string variable is treated as missing, not as a value', () => {
    expect(() => personalizerApiUrl({ PERSONALIZER_API_URL: '' })).toThrow(
      /Missing required configuration variable PERSONALIZER_API_URL/,
    );
  });
});

// ── Production configuration contract (wrangler.toml) ────────────────────────

const wranglerFiles = import.meta.glob('../wrangler.toml', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** The `[vars]` table of wrangler.toml (up to the next `[` table header). */
function productionVars(): string {
  const toml = Object.values(wranglerFiles)[0];
  if (!toml) throw new Error('wrangler.toml not found next to test/');
  const start = toml.indexOf('\n[vars]\n');
  if (start === -1) throw new Error('wrangler.toml has no [vars] table');
  const body = toml.slice(start + '\n[vars]\n'.length);
  const nextTable = body.search(/^\[/m);
  return nextTable === -1 ? body : body.slice(0, nextTable);
}

describe('production [vars] — the deployed configuration values', () => {
  it('routes Brain calls to https://personalizer.io in production', () => {
    expect(productionVars()).toContain('PERSONALIZER_API_URL = "https://personalizer.io"');
  });

  it('routes Anthropic calls to https://api.anthropic.com', () => {
    expect(productionVars()).toContain('ANTHROPIC_API_BASE = "https://api.anthropic.com"');
  });

  it('pins the deploy-time model choices (default agent-loop model + placement model)', () => {
    expect(productionVars()).toContain('MODEL_DEFAULT = "claude-opus-4-8"');
    expect(productionVars()).toContain('MODEL_PLACEMENT = "claude-haiku-4-5"');
  });

  it('keeps the credentialed dev-origin allowlist', () => {
    expect(productionVars()).toContain(
      'CREDENTIALED_ORIGINS = "https://local-app.limespot.com,http://localhost:4200,http://localhost:3000"',
    );
  });

  it('declares every required variable except the secrets (encrypted, dashboard-managed)', () => {
    const vars = productionVars();
    for (const name of [
      'PERSONALIZER_API_URL',
      'ANTHROPIC_API_BASE',
      'CREDENTIALED_ORIGINS',
      'MODEL_DEFAULT',
      'MODEL_PLACEMENT',
    ]) {
      expect(vars).toContain(`${name} = `);
    }
    expect(vars).not.toContain('CLAUDE_API_KEY');
    expect(vars).not.toContain('PERSONALIZER_INTEGRATION_BRIDGE_TOKEN');
  });
});
