/** Authenticated public transport for provider continuation state between HTTP requests. */

import type { Env } from '../config';
import type { InferenceBackendName, ProviderContinuationState } from '../lib/inference-types';
import { PROVIDER_NAMES } from './model-catalog';
import { deriveSealingKey, openToken, sealToken, type SealingPurpose } from './token-sealing';

const TOKEN_PREFIX = 'continuation_v2_';
const TOKEN_PATTERN = /^continuation_v2_[A-Za-z0-9_-]+$/;
const MAX_TOKEN_CHARACTERS = 2_000_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** This token family's own key: no other sealed token derives from the same salt/info. */
const SEALING_PURPOSE: SealingPurpose = {
  salt: 'app-ai:inference-continuation:v2',
  info: 'opaque-continuation-encryption',
};
/**
 * The backends a sealed continuation may name. `InferenceBackendName` also
 * covers the local development fulfillers, whose state exists only inside the
 * dev shim and never travels a public token: no production adapter emits one,
 * so a token naming one is refused here rather than carried to an adapter as if
 * it were a production route.
 */
const SEALABLE_BACKENDS = new Set<InferenceBackendName>(PROVIDER_NAMES);

/** Server-resolved ownership that a continuation token may not change. */
export interface ContinuationRoute {
  readonly tenantScope: string;
  readonly promptGroup: string;
  readonly modelProfile: string;
}

interface ContinuationEnvelope extends ContinuationRoute {
  readonly version: 2;
  readonly expiresAt: string;
  readonly state: ProviderContinuationState;
}

/** Validate the shared sealing secret before interpreting caller token bytes. */
export async function preflightContinuationSealing(env: Env): Promise<void> {
  await importContinuationKey(env);
}

/** Encrypt and authenticate adapter-owned state with its tenant and resolved route. */
export async function encodeOpaqueContinuation(
  state: ProviderContinuationState,
  route: ContinuationRoute,
  env: Env,
): Promise<string> {
  const envelope: ContinuationEnvelope = {
    version: 2,
    expiresAt: new Date(Date.now() + MAX_AGE_MS).toISOString(),
    ...route,
    state,
  };
  const token = await sealToken(
    TOKEN_PREFIX,
    await importContinuationKey(env),
    JSON.stringify(envelope),
  );
  if (token.length > MAX_TOKEN_CHARACTERS) {
    throw new Error('Inference continuation state exceeds the maximum transport size');
  }
  return token;
}

/** Open a token and reject tampering, expiry, or tenant/group/profile replay. */
export async function decodeOpaqueContinuation(
  token: string,
  route: ContinuationRoute,
  env: Env,
): Promise<ProviderContinuationState> {
  if (!TOKEN_PATTERN.test(token) || token.length > MAX_TOKEN_CHARACTERS) {
    throw new Error('Invalid inference continuation token');
  }
  const key = await importContinuationKey(env);
  try {
    const envelope = JSON.parse(await openToken(TOKEN_PREFIX, key, token)) as unknown;
    if (!isEnvelope(envelope)) throw new Error('invalid shape');
    if (
      Date.parse(envelope.expiresAt) <= Date.now() ||
      envelope.tenantScope !== route.tenantScope ||
      envelope.promptGroup !== route.promptGroup ||
      envelope.modelProfile !== route.modelProfile
    ) {
      throw new Error('invalid owner');
    }
    return envelope.state;
  } catch {
    throw new Error('Invalid inference continuation token');
  }
}

function isEnvelope(value: unknown): value is ContinuationEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 2 ||
    typeof envelope.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(envelope.expiresAt)) ||
    typeof envelope.tenantScope !== 'string' ||
    envelope.tenantScope.length === 0 ||
    typeof envelope.promptGroup !== 'string' ||
    envelope.promptGroup.length === 0 ||
    typeof envelope.modelProfile !== 'string' ||
    envelope.modelProfile.length === 0 ||
    !envelope.state ||
    typeof envelope.state !== 'object' ||
    Array.isArray(envelope.state)
  ) {
    return false;
  }
  const state = envelope.state as Record<string, unknown>;
  return SEALABLE_BACKENDS.has(state.backend as InferenceBackendName) && 'value' in state;
}

async function importContinuationKey(env: Env): Promise<CryptoKey> {
  return deriveSealingKey(env, SEALING_PURPOSE, 'AES-GCM', ['encrypt', 'decrypt']);
}
