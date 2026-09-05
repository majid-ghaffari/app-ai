/** Authenticated public inference-continuation ownership tests. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeOpaqueContinuation,
  encodeOpaqueContinuation,
  preflightContinuationSealing,
  type ContinuationRoute,
} from '../src/inference/continuation';
import { ENV } from './helpers';

const ROUTE: ContinuationRoute = {
  tenantScope: 'tenant:one',
  promptGroup: 'studio-visual-agent',
  modelProfile: 'claude-opus',
};
const STATE = {
  backend: 'openai' as const,
  value: { previousResponseId: 'resp_private' },
};

afterEach(() => vi.restoreAllMocks());

describe('opaque inference continuation', () => {
  it('round-trips only under the exact tenant/group/profile route', async () => {
    const token = await encodeOpaqueContinuation(STATE, ROUTE, ENV);
    await expect(decodeOpaqueContinuation(token, ROUTE, ENV)).resolves.toEqual(STATE);
    for (const wrongRoute of [
      { ...ROUTE, tenantScope: 'tenant:two' },
      { ...ROUTE, promptGroup: 'chat-agent' },
      { ...ROUTE, modelProfile: 'openai-frontier' },
    ]) {
      await expect(decodeOpaqueContinuation(token, wrongRoute, ENV)).rejects.toThrow(
        'Invalid inference continuation token',
      );
    }
  });

  it('refuses a token naming a local development fulfiller as its backend', async () => {
    // `InferenceBackendName` also covers the dev shim's fulfillers. Their state
    // exists only locally and no production adapter emits it, so a sealed token
    // naming one never decodes into a production route.
    for (const backend of ['claude-code', 'codex'] as const) {
      const token = await encodeOpaqueContinuation(
        { backend, value: { session: 'local' } },
        ROUTE,
        ENV,
      );
      await expect(decodeOpaqueContinuation(token, ROUTE, ENV)).rejects.toThrow(
        'Invalid inference continuation token',
      );
    }
    // A production provider on the same route still round-trips.
    const production = await encodeOpaqueContinuation(STATE, ROUTE, ENV);
    await expect(decodeOpaqueContinuation(production, ROUTE, ENV)).resolves.toEqual(STATE);
  });

  it('round-trips provider state larger than the JavaScript argument limit', async () => {
    const state = {
      backend: 'anthropic' as const,
      value: { contentBlocks: [{ type: 'thinking', thinking: 'x'.repeat(180_000) }] },
    };
    const token = await encodeOpaqueContinuation(state, ROUTE, ENV);
    expect(token.length).toBeGreaterThan(125_000);
    await expect(decodeOpaqueContinuation(token, ROUTE, ENV)).resolves.toEqual(state);
  });

  it('rejects provider state that cannot fit in the bounded public transport', async () => {
    const state = {
      backend: 'anthropic' as const,
      value: { contentBlocks: [{ type: 'thinking', thinking: 'x'.repeat(1_600_000) }] },
    };
    await expect(encodeOpaqueContinuation(state, ROUTE, ENV)).rejects.toThrow(
      'exceeds the maximum transport size',
    );
  });

  it('rejects authenticated-ciphertext tampering and expiry', async () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const token = await encodeOpaqueContinuation(STATE, ROUTE, ENV);
    const index = token.length - 20;
    const replacement = token[index] === 'A' ? 'B' : 'A';
    const tampered = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
    await expect(decodeOpaqueContinuation(tampered, ROUTE, ENV)).rejects.toThrow(
      'Invalid inference continuation token',
    );
    vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000 + 1);
    await expect(decodeOpaqueContinuation(token, ROUTE, ENV)).rejects.toThrow(
      'Invalid inference continuation token',
    );
  });

  it('fails fast on missing or malformed sealing configuration', async () => {
    const { TOKEN_ENCRYPTION_SECRET: _key, ...withoutKey } = ENV;
    await expect(preflightContinuationSealing(withoutKey)).rejects.toThrow(
      /Missing required configuration variable TOKEN_ENCRYPTION_SECRET/,
    );
    await expect(
      preflightContinuationSealing({ ...ENV, TOKEN_ENCRYPTION_SECRET: 'bad' }),
    ).rejects.toThrow('exactly 32 bytes');
  });
});
