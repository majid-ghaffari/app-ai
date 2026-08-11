/**
 * Worker configuration — the ONE place environment bindings are read.
 *
 * Every configuration value lives OUTSIDE the code (docs/CODE-PATTERNS.md →
 * "No Hardcoded Config Values"):
 *
 *   • Non-secret vars → wrangler.toml `[vars]` (production values; local
 *     `wrangler dev` overrides them from `.dev.vars`).
 *   • Secrets → Cloudflare encrypted secrets (production) / `.dev.vars`
 *     (local dev, gitignored — see `.dev.vars.example` for every knob).
 *
 * MISSING CONFIG = ERROR. There are no fallback defaults anywhere: a required
 * variable that is absent throws at first access, naming the variable and
 * where to set it (the router's catch maps the throw to the Brain-shaped 500
 * envelope). The one genuinely optional binding is `FILES_KV`, whose absence
 * changes behavior explicitly and documentedly (lib/file-dedup.ts gracefully
 * no-ops to a plain upload).
 *
 * The `Env` interface below is the single source of truth for the worker's
 * bindings. Its members are deliberately typed optional: the runtime cannot
 * guarantee a binding exists, so code CANNOT consume one directly — every read
 * must flow through the accessors here, which validate fail-fast. Enforced by
 * the config fitness scans in test/architecture.test.ts (no absolute URLs in
 * src outside this module; no `env.X || …` / `env.X ?? …` inline fallbacks).
 */

// `ModelTier` is a compile-time-only type (the semantic capability tiers the
// prompt registry uses). Importing it as `import type` is erased by the bundler,
// so this does NOT create a runtime import cycle with `prompt-registry.ts` (which imports
// `resolveModel` from here).
import type { ModelTier } from './prompt-registry';

/**
 * The worker's environment bindings (wrangler.toml + Cloudflare secrets).
 * Single source of truth — handlers/lib receive this whole object and read
 * values only through the accessors below.
 */
export interface Env {
  /** Deployment label used for diagnostics; LOG_TARGETS_* alone controls log routing. */
  readonly ENVIRONMENT?: string;
  /** Personalizer API base URL, no trailing slash. Non-secret var. */
  readonly PERSONALIZER_API_URL?: string;
  /**
   * Caller-auth token toward Personalizer's integration bridge, sent as the
   * `X-Personalizer-Integration-Bridge-Token` header by the platform toolsets'
   * call channel (src/toolsets/integration-bridge.ts). SECRET — Cloudflare
   * encrypted secret / .dev.vars.
   */
  readonly PERSONALIZER_INTEGRATION_BRIDGE_TOKEN?: string;
  /** Anthropic API origin (`https://api.anthropic.com`), no trailing slash. Non-secret var. */
  readonly ANTHROPIC_API_BASE?: string;
  /** Per-level comma-separated log sink routes (`console`, `seq`, or `ignore`). */
  readonly LOG_TARGETS_TRACE?: string;
  readonly LOG_TARGETS_DEBUG?: string;
  readonly LOG_TARGETS_INFO?: string;
  readonly LOG_TARGETS_WARN?: string;
  readonly LOG_TARGETS_ERROR?: string;
  readonly LOG_TARGETS_FATAL?: string;
  /** Seq CLEF ingestion endpoint. Non-secret var. */
  readonly LOG_SEQ_INGEST_URL?: string;
  /** Optional Seq ingestion key. SECRET when configured. */
  readonly LOG_SEQ_API_KEY?: string;
  /** Comma-separated Origins allowed to send credentialed CORS requests. Non-secret var. */
  readonly CREDENTIALED_ORIGINS?: string;
  /**
   * Concrete model bound to the `fast` capability tier — the latency-sensitive /
   * cheapest one-shot prompts (`placement`). Non-secret var; the ONLY place a
   * `fast`-tier model id appears (swap it to bump a version or switch provider).
   */
  readonly MODEL_FAST?: string;
  /**
   * Concrete model bound to the `balanced` capability tier — the multi-modal /
   * JSON reasoners (proposals, visual-verify, the onboarding batch/review passes,
   * the behavioral/visual/generative probes). Non-secret var; the ONLY place a
   * `balanced`-tier model id appears.
   */
  readonly MODEL_BALANCED?: string;
  /**
   * Concrete model bound to the `frontier` capability tier — the most-capable
   * flagship, the DEFAULT tier (the agent-loop chat prompts + the heaviest
   * classification). Non-secret var; the ONLY place a `frontier`-tier model id
   * appears.
   */
  readonly MODEL_FRONTIER?: string;
  /** Anthropic API key. SECRET — Cloudflare encrypted secret / .dev.vars. */
  readonly CLAUDE_API_KEY?: string;
  /**
   * OPTIONAL KV namespace for Files API content-hash dedup. When absent,
   * lib/file-dedup.ts explicitly no-ops to a plain upload (documented
   * degradation, not a hidden default).
   */
  readonly FILES_KV?: KVNamespace;
  /**
   * OPTIONAL override for the Brain-defaults source URL (lib/brain-defaults.ts).
   * When set, the defaults provider fetches the canonical default
   * RecommendationsSettings from THIS URL as-is (intended for the platform's
   * CDN-hosted object, fetched without the merchant context-ID). When absent,
   * the provider uses the authenticated Brain endpoint
   * (`${PERSONALIZER_API_URL}/v1/personalizerConfig?defaultRecommendationsSettings=true`,
   * forwarding the context-ID). Its absence changes behavior explicitly and
   * documentedly — a config seam, not a hidden default.
   */
  readonly RECOMMENDATIONS_DEFAULTS_URL?: string;
}

/** Required string variables; optional bindings and LOG_SEQ_API_KEY are intentionally excluded. */
type RequiredVarName =
  | 'PERSONALIZER_API_URL'
  | 'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN'
  | 'ANTHROPIC_API_BASE'
  | 'LOG_TARGETS_TRACE'
  | 'LOG_TARGETS_DEBUG'
  | 'LOG_TARGETS_INFO'
  | 'LOG_TARGETS_WARN'
  | 'LOG_TARGETS_ERROR'
  | 'LOG_TARGETS_FATAL'
  | 'LOG_SEQ_INGEST_URL'
  | 'CREDENTIALED_ORIGINS'
  | 'MODEL_FAST'
  | 'MODEL_BALANCED'
  | 'MODEL_FRONTIER'
  | 'CLAUDE_API_KEY';

/** The variables that are SECRETS (encrypted-secret channel, never wrangler.toml `[vars]`). */
const SECRET_VAR_NAMES: readonly RequiredVarName[] = [
  'CLAUDE_API_KEY',
  'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN',
];

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogTarget = 'console' | 'seq';

const LOG_TARGET_VAR: Record<LogLevel, RequiredVarName> = {
  trace: 'LOG_TARGETS_TRACE',
  debug: 'LOG_TARGETS_DEBUG',
  info: 'LOG_TARGETS_INFO',
  warn: 'LOG_TARGETS_WARN',
  error: 'LOG_TARGETS_ERROR',
  fatal: 'LOG_TARGETS_FATAL',
};

/** Read one required variable, throwing a config error naming it when absent. */
function requireVar(env: Env, name: RequiredVarName): string {
  const value = env[name];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  const where = SECRET_VAR_NAMES.includes(name)
    ? 'Set it as a Cloudflare encrypted secret (production) or in .dev.vars (local dev, gitignored — see .dev.vars.example).'
    : 'Set it in wrangler.toml [vars] (production) or in .dev.vars (local dev — see .dev.vars.example).';
  throw new Error(`Missing required configuration variable ${name}. ${where}`);
}

/** Personalizer API base URL. */
export function personalizerApiUrl(env: Env): string {
  return requireVar(env, 'PERSONALIZER_API_URL');
}

/**
 * The caller-auth token for Personalizer's integration bridge. Only the
 * platform toolsets' call-channel seam (src/toolsets/integration-bridge.ts)
 * may call this.
 */
export function personalizerIntegrationBridgeToken(env: Env): string {
  return requireVar(env, 'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN');
}

/** Anthropic API origin (the client appends the versioned `/v1/...` paths). */
export function anthropicApiBase(env: Env): string {
  return requireVar(env, 'ANTHROPIC_API_BASE');
}

/** Parse and validate the configured target fan-out for one log level. */
export function logTargets(env: Env, level: LogLevel): readonly LogTarget[] {
  const raw = requireVar(env, LOG_TARGET_VAR[level]);
  const names = raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (names.length === 1 && names[0] === 'ignore') return [];
  if (names.includes('ignore')) {
    throw new Error(`${LOG_TARGET_VAR[level]} cannot combine 'ignore' with another target.`);
  }
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (name !== 'console' && name !== 'seq') {
      throw new Error(`${LOG_TARGET_VAR[level]} contains unknown log target '${name}'.`);
    }
  }
  return unique as LogTarget[];
}

/** Seq's HTTPS CLEF ingestion endpoint. */
export function logSeqIngestUrl(env: Env): string {
  return requireVar(env, 'LOG_SEQ_INGEST_URL');
}

/** Optional Seq ingestion key; anonymous ingestion remains supported when absent. */
export function logSeqApiKey(env: Env): string | null {
  const value = env.LOG_SEQ_API_KEY;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The config variable each capability tier is bound to (Layer 2 of the indirection). */
const TIER_VAR: Record<ModelTier, RequiredVarName> = {
  fast: 'MODEL_FAST',
  balanced: 'MODEL_BALANCED',
  frontier: 'MODEL_FRONTIER',
};

/**
 * Resolve a semantic capability `tier` (from the prompt registry) to the
 * concrete model bound to it in configuration — the ONLY place a tier maps to a
 * model id. Reads via the fail-fast `requireVar`, so a missing binding throws
 * naming the variable (`MODEL_FAST` / `MODEL_BALANCED` / `MODEL_FRONTIER`).
 * Switching model versions OR provider is a config-only change here.
 */
export function resolveModel(env: Env, tier: ModelTier): string {
  return requireVar(env, TIER_VAR[tier]);
}

/** The Anthropic API key. Only lib/anthropic.ts may call this. */
export function claudeApiKey(env: Env): string {
  return requireVar(env, 'CLAUDE_API_KEY');
}

/**
 * The configured Brain-defaults source URL, or `null` when unset. When a value
 * is present the defaults provider fetches from it as-is (a CDN-hosted object,
 * no context-ID); when `null` the provider builds the authenticated
 * Brain endpoint from `personalizerApiUrl`. OPTIONAL by design — reading it never
 * throws (unlike the required accessors), and it carries no inline `||` / `??`
 * fallback (the ternary is an explicit presence test, not a config fallback).
 */
export function recommendationsDefaultsUrl(env: Env): string | null {
  const value = env.RECOMMENDATIONS_DEFAULTS_URL;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Origins allowed to send credentialed CORS requests (parsed, trimmed, empties dropped). */
export function credentialedOrigins(env: Env): readonly string[] {
  return requireVar(env, 'CREDENTIALED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
