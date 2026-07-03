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

/**
 * The worker's environment bindings (wrangler.toml + Cloudflare secrets).
 * Single source of truth — handlers/lib receive this whole object and read
 * values only through the accessors below.
 */
export interface Env {
  /**
   * Deployment metadata (`production` / `local`) — surfaced for dashboard/tail
   * context only; worker code does not branch on it.
   */
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
  /** Comma-separated Origins allowed to send credentialed CORS requests. Non-secret var. */
  readonly CREDENTIALED_ORIGINS?: string;
  /** Default Anthropic model for the prompt registry (chat/onboarding/…). Non-secret var. */
  readonly MODEL_DEFAULT?: string;
  /** Anthropic model for the latency-sensitive placement prompt. Non-secret var. */
  readonly MODEL_PLACEMENT?: string;
  /** Anthropic API key. SECRET — Cloudflare encrypted secret / .dev.vars. */
  readonly CLAUDE_API_KEY?: string;
  /**
   * OPTIONAL KV namespace for Files API content-hash dedup. When absent,
   * lib/file-dedup.ts explicitly no-ops to a plain upload (documented
   * degradation, not a hidden default).
   */
  readonly FILES_KV?: KVNamespace;
}

/** The required string variables (everything in `Env` except `ENVIRONMENT` metadata and the optional `FILES_KV`). */
type RequiredVarName =
  | 'PERSONALIZER_API_URL'
  | 'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN'
  | 'ANTHROPIC_API_BASE'
  | 'CREDENTIALED_ORIGINS'
  | 'MODEL_DEFAULT'
  | 'MODEL_PLACEMENT'
  | 'CLAUDE_API_KEY';

/** The variables that are SECRETS (encrypted-secret channel, never wrangler.toml `[vars]`). */
const SECRET_VAR_NAMES: readonly RequiredVarName[] = [
  'CLAUDE_API_KEY',
  'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN',
];

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

/** Default Anthropic model for the prompt registry's agent-loop prompts. */
export function modelDefault(env: Env): string {
  return requireVar(env, 'MODEL_DEFAULT');
}

/** Anthropic model for the latency-sensitive, structured placement prompt. */
export function modelPlacement(env: Env): string {
  return requireVar(env, 'MODEL_PLACEMENT');
}

/** The Anthropic API key. Only lib/anthropic.ts may call this. */
export function claudeApiKey(env: Env): string {
  return requireVar(env, 'CLAUDE_API_KEY');
}

/** Origins allowed to send credentialed CORS requests (parsed, trimmed, empties dropped). */
export function credentialedOrigins(env: Env): readonly string[] {
  return requireVar(env, 'CREDENTIALED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
