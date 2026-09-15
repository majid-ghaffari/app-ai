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
 * no-ops to a plain upload); prompt-aware public references are self-contained
 * authenticated ciphertext under the required `TOKEN_ENCRYPTION_SECRET`, so they never
 * depend on KV consistency. `AUDIT_SESSIONS` is required when the audit
 * exchange/bearer feature is exercised and fails closed when absent.
 *
 * The `Env` interface below is the single source of truth for the worker's
 * bindings. Its members are deliberately typed optional: the runtime cannot
 * guarantee a binding exists, so code CANNOT consume one directly — every read
 * must flow through the accessors here, which validate fail-fast. Enforced by
 * the config fitness scans in test/architecture.test.ts (no absolute URLs in
 * src outside this module; no `env.X || …` / `env.X ?? …` inline fallbacks).
 */

// `ModelTier` is a compile-time-only type: the capability tier a prompt group
// declares. Importing it as `import type` is erased by the bundler, so this
import type { ProviderName } from './lib/inference-types';
// does not create a runtime import cycle with `prompt-registry.ts` (which
// imports `resolveModel` and `modelOverrides` from here).
import type { ModelTier } from './prompt-registry';

/**
 * The worker's environment bindings (wrangler.toml + Cloudflare secrets).
 * Single source of truth — handlers/lib receive this whole object and read
 * values only through the accessors below.
 */
export interface Env {
  /** Deployment label used for diagnostics; LOG_TARGETS_* alone controls log routing. */
  readonly ENVIRONMENT?: string;
  /** Explicit opt-in for paid provider calls outside production. */
  readonly AI_CHANNEL?: string;
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
  /** OpenAI API origin (`https://api.openai.com`), no trailing slash. Non-secret var. */
  readonly OPENAI_API_BASE?: string;
  /**
   * Gemini Developer API origin including its version segment
   * (`https://generativelanguage.googleapis.com/v1beta`), no trailing slash.
   * Non-secret var.
   */
  readonly GEMINI_API_BASE?: string;
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
   * The `SubscriberID` Personalizer reports for the master account. Only that
   * subscriber may read the operator diagnostics route; every other validated
   * merchant is answered as though the route did not exist. Non-secret var.
   */
  readonly MASTER_SUBSCRIBER_ID?: string;
  /**
   * Concrete model bound to the `fast` capability tier — the latency-sensitive /
   * cheapest one-shot prompts (`placement`). Non-secret var; the ONLY place a
   * `fast`-tier model id appears. The id itself selects the provider through
   * the model catalog, and must resolve to a model whose capabilities satisfy
   * every prompt group on this tier.
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
   * flagship (the agent-loop chat prompts + the heaviest
   * classification). Non-secret var; the ONLY place a `frontier`-tier model id
   * appears.
   */
  readonly MODEL_FRONTIER?: string;
  /**
   * OPTIONAL sparse per-prompt exceptions to the tier bindings above, as a
   * comma-separated `promptGroupOrPromptName=modelId` list. Empty by default;
   * a prompt name beats its group, and a group beats its tier binding. The
   * registry rejects a key that names no registered prompt or prompt group, so
   * a typo can never become a silent no-op. Non-secret var.
   */
  readonly MODEL_OVERRIDES?: string;
  /**
   * Anthropic API key. SECRET — Cloudflare encrypted secret / .dev.vars. Always
   * required: the unregistered `/messages` passthrough speaks Anthropic.
   */
  readonly CLAUDE_API_KEY?: string;
  /**
   * OpenAI API key. SECRET — required only while a resolved route uses OpenAI;
   * a blank one is not reported missing on a deployment that routes nothing
   * there (`missingRequiredSecretNames`).
   */
  readonly OPENAI_API_KEY?: string;
  /**
   * Gemini API key. SECRET — required only while a resolved route uses Gemini;
   * a blank one is not reported missing on a deployment that routes nothing
   * there (`missingRequiredSecretNames`).
   */
  readonly GEMINI_API_KEY?: string;
  /**
   * Base64-encoded 32 random bytes. It is an HKDF ROOT, never used directly as
   * a cipher key: separate AES-GCM and HMAC subkeys are derived from it for
   * sealed opaque file references, sealed inference continuations, and the
   * keyed tenant pseudonym that scopes both (and the dedup KV records). SECRET.
   */
  readonly TOKEN_ENCRYPTION_SECRET?: string;
  /**
   * Metadata-only KV namespace for best-effort file dedup.
   * Dedup may no-op when absent; public reference correctness does not use KV.
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
  /** HMAC key shared only by the website activation issuer and app-ai. SECRET. */
  readonly AUDIT_ACTIVATION_SIGNING_SECRET?: string;
  /** HMAC key used only by app-ai to sign exchanged audit sessions. SECRET. */
  readonly AUDIT_SESSION_SIGNING_SECRET?: string;
  /** HMAC key shared with the website only for audit-status callbacks. SECRET. */
  readonly AUDIT_STATUS_SIGNING_SECRET?: string;
  /**
   * Comma-separated origins a website-signed activation may name in its
   * `statusCallbackUrl` claim. The website owns the callback path and signs it
   * into the token; this deployment owns the set of hosts it may be sent to.
   */
  readonly AUDIT_STATUS_ORIGINS?: string;
  /** Strongly consistent authority for activation consumption, quotas, and file ownership. */
  readonly AUDIT_SESSIONS?: DurableObjectNamespace;
  /** Lifetime of an exchanged audit session in seconds. */
  readonly AUDIT_SESSION_TTL_SECONDS?: string;
  /** Maximum successful file uploads in one audit session. */
  readonly AUDIT_MAX_UPLOADS?: string;
  /** Maximum successful inference requests in one audit session. */
  readonly AUDIT_MAX_MESSAGES?: string;
  /** Maximum bytes accepted by one audit file upload. */
  readonly AUDIT_MAX_UPLOAD_BYTES?: string;
  /** Maximum aggregate uploaded bytes reserved or completed by one audit session. */
  readonly AUDIT_MAX_TOTAL_UPLOAD_BYTES?: string;
  /** Maximum JSON request bytes accepted by one audit inference. */
  readonly AUDIT_MAX_MESSAGE_BYTES?: string;
}

/** Required string variables; optional bindings and LOG_SEQ_API_KEY are intentionally excluded. */
type RequiredVarName =
  | 'ENVIRONMENT'
  | 'PERSONALIZER_API_URL'
  | 'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN'
  | 'ANTHROPIC_API_BASE'
  | 'OPENAI_API_BASE'
  | 'GEMINI_API_BASE'
  | 'LOG_TARGETS_TRACE'
  | 'LOG_TARGETS_DEBUG'
  | 'LOG_TARGETS_INFO'
  | 'LOG_TARGETS_WARN'
  | 'LOG_TARGETS_ERROR'
  | 'LOG_TARGETS_FATAL'
  | 'LOG_SEQ_INGEST_URL'
  | 'CREDENTIALED_ORIGINS'
  | 'MASTER_SUBSCRIBER_ID'
  | 'MODEL_FAST'
  | 'MODEL_BALANCED'
  | 'MODEL_FRONTIER'
  | 'CLAUDE_API_KEY'
  | 'AUDIT_ACTIVATION_SIGNING_SECRET'
  | 'AUDIT_SESSION_SIGNING_SECRET'
  | 'AUDIT_STATUS_SIGNING_SECRET'
  | 'AUDIT_STATUS_ORIGINS'
  | 'AUDIT_SESSION_TTL_SECONDS'
  | 'AUDIT_MAX_UPLOADS'
  | 'AUDIT_MAX_MESSAGES'
  | 'AUDIT_MAX_UPLOAD_BYTES'
  | 'AUDIT_MAX_TOTAL_UPLOAD_BYTES'
  | 'AUDIT_MAX_MESSAGE_BYTES'
  | 'OPENAI_API_KEY'
  | 'GEMINI_API_KEY'
  | 'TOKEN_ENCRYPTION_SECRET';

/** The variables that are SECRETS (encrypted-secret channel, never wrangler.toml `[vars]`). */
const SECRET_VAR_NAMES: readonly RequiredVarName[] = [
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'TOKEN_ENCRYPTION_SECRET',
  'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN',
  'AUDIT_ACTIVATION_SIGNING_SECRET',
  'AUDIT_SESSION_SIGNING_SECRET',
  'AUDIT_STATUS_SIGNING_SECRET',
];

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type LogTarget = 'console' | 'seq';

/** Deployment label used to distinguish production fail-closed runtime contracts. */
export function deploymentEnvironment(env: Env): string {
  return requireVar(env, 'ENVIRONMENT');
}

const LOG_TARGET_VAR: Record<LogLevel, RequiredVarName> = {
  trace: 'LOG_TARGETS_TRACE',
  debug: 'LOG_TARGETS_DEBUG',
  info: 'LOG_TARGETS_INFO',
  warn: 'LOG_TARGETS_WARN',
  error: 'LOG_TARGETS_ERROR',
  fatal: 'LOG_TARGETS_FATAL',
};

/**
 * A required SECRET is absent or unusable. The message names the secret and
 * where an operator sets it — for logs and thrown-error callers — and the
 * public Brain envelope never carries it: `lib/responses.ts` answers a merchant
 * route with a generic message for this class, so an internal instruction
 * about the secret store never reaches a client.
 */
export class SecretConfigurationError extends Error {
  readonly secretName: string;

  constructor(secretName: string, message: string) {
    super(message);
    this.name = 'SecretConfigurationError';
    this.secretName = secretName;
  }
}

/** Where a non-secret variable is set, appended to every configuration error naming one. */
const SET_IN_VARS =
  'Set it in wrangler.toml [vars] (production) or in .dev.vars (local dev — see .dev.vars.example).';

/** Read one required variable, throwing a config error naming it when absent. */
function requireVar(env: Env, name: RequiredVarName): string {
  const value = env[name];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (SECRET_VAR_NAMES.includes(name)) {
    throw new SecretConfigurationError(
      name,
      `Missing required configuration variable ${name}. Set it as a Cloudflare encrypted secret (production) or in .dev.vars (local dev, gitignored — see .dev.vars.example).`,
    );
  }
  throw new Error(`Missing required configuration variable ${name}. ${SET_IN_VARS}`);
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
  return paidProviderBase(env, 'ANTHROPIC_API_BASE', 'anthropic');
}

/** OpenAI API origin. Only the OpenAI wire adapter may call this. */
export function openaiApiBase(env: Env): string {
  return paidProviderBase(env, 'OPENAI_API_BASE', 'openai');
}

/** Gemini API origin. Only the Gemini wire adapter may call this. */
export function geminiApiBase(env: Env): string {
  return paidProviderBase(env, 'GEMINI_API_BASE', 'gemini');
}

function paidProviderBase(
  env: Env,
  name: Extract<RequiredVarName, `${string}_API_BASE`>,
  provider: string,
): string {
  const value = requireVar(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  const optedIn = env.AI_CHANNEL?.trim().toLowerCase() === 'prod';
  if (!isProductionDeployment(env) && !optedIn && !isLoopbackHost(url)) {
    throw new Error(
      `Refusing paid ${provider} provider call outside production without AI_CHANNEL=prod`,
    );
  }
  return value;
}

/** The deployed-versus-local distinction every fail-closed configuration rule keys off. */
function isProductionDeployment(env: Env): boolean {
  return env.ENVIRONMENT?.trim().toLowerCase() === 'production';
}

/** A host that can only be this machine, so plain HTTP carries nothing off it. */
function isLoopbackHost(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
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
 * Resolve a capability tier to the concrete configured model. This is the only
 * place a tier maps to a model id. Reads via the fail-fast `requireVar`, so a
 * missing binding throws naming the variable (`MODEL_FAST` / `MODEL_BALANCED` /
 * `MODEL_FRONTIER`). What that model id then implies — provider, API family,
 * capabilities, direct-file policy — is the model catalog's answer, not this
 * module's.
 */
export function resolveModel(env: Env, tier: ModelTier): string {
  return requireVar(env, TIER_VAR[tier]);
}

/**
 * Sparse per-prompt / per-prompt-group model exceptions, parsed from
 * `MODEL_OVERRIDES`. OPTIONAL by design — an unset or empty value yields no
 * overrides, and reading it never throws for absence (the presence test is
 * explicit, not a config fallback). A malformed or repeated entry DOES throw:
 * the registry validates the keys, this validates the syntax.
 */
export function modelOverrides(env: Env): ReadonlyMap<string, string> {
  const overrides = new Map<string, string>();
  const raw = env.MODEL_OVERRIDES;
  if (typeof raw !== 'string' || raw.trim().length === 0) return overrides;
  for (const entry of raw.split(',')) {
    const text = entry.trim();
    if (text.length === 0) continue;
    const separator = text.indexOf('=');
    const key = separator === -1 ? '' : text.slice(0, separator).trim();
    const model = separator === -1 ? '' : text.slice(separator + 1).trim();
    if (key.length === 0 || model.length === 0) {
      throw new Error(
        `MODEL_OVERRIDES entry "${text}" must read promptGroupOrPromptName=modelId. ${SET_IN_VARS}`,
      );
    }
    if (overrides.has(key)) {
      throw new Error(`MODEL_OVERRIDES sets ${key} more than once.`);
    }
    overrides.set(key, model);
  }
  return overrides;
}

/** The one subscriber allowed to read the operator diagnostics route. */
export function masterSubscriberId(env: Env): number {
  return positiveIntegerVar(env, 'MASTER_SUBSCRIBER_ID');
}

/** The secret each provider's wire adapter reads. */
const PROVIDER_SECRET_VAR: Readonly<Record<ProviderName, RequiredVarName>> = {
  anthropic: 'CLAUDE_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * The REQUIRED secrets this environment has not been given, by NAME ONLY.
 *
 * A provider's key is required only while some resolved route uses that
 * provider (`providersInUse` — the registry knows which; this module cannot),
 * so a deployment routing everything to one provider is not forever told the
 * others' keys are missing. Every other secret is required unconditionally.
 *
 * A blank-secret report exists so an operator can see what is still unset
 * without opening the secret store; it therefore never returns, derives, or
 * hints at a value — no prefix, no length, no presence of a partial. A secret
 * that IS set contributes nothing to the result at all.
 */
export function missingRequiredSecretNames(
  env: Env,
  providersInUse: Iterable<ProviderName>,
): readonly string[] {
  const providers = new Set(providersInUse);
  const dormantProviderSecrets = new Set(
    (Object.keys(PROVIDER_SECRET_VAR) as ProviderName[])
      .filter((provider) => !providers.has(provider))
      .map((provider) => PROVIDER_SECRET_VAR[provider]),
  );
  return SECRET_VAR_NAMES.filter((name) => {
    if (dormantProviderSecrets.has(name)) return false;
    const value = env[name];
    return typeof value !== 'string' || value.length === 0;
  });
}

/** The Anthropic API key. Only the Anthropic wire adapter may call this. */
export function claudeApiKey(env: Env): string {
  return requireVar(env, 'CLAUDE_API_KEY');
}

/** The OpenAI API key. Only the OpenAI wire adapter may call this. */
export function openaiApiKey(env: Env): string {
  return requireVar(env, 'OPENAI_API_KEY');
}

/** The Gemini API key. Only the Gemini wire adapter may call this. */
export function geminiApiKey(env: Env): string {
  return requireVar(env, 'GEMINI_API_KEY');
}

/**
 * The HKDF root every app-ai-sealed token is derived from — opaque file
 * references, inference continuations, and the tenant pseudonym that binds
 * them. Not file-specific and never applied as a cipher key directly.
 */
export function tokenEncryptionSecret(env: Env): string {
  return requireVar(env, 'TOKEN_ENCRYPTION_SECRET');
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

/** Website/app-ai HMAC key used only to verify activation tokens. */
export function auditActivationSigningSecret(env: Env): string {
  return strongSigningSecret(env, 'AUDIT_ACTIVATION_SIGNING_SECRET');
}

/** App-ai-only HMAC key used to sign and verify exchanged audit sessions. */
export function auditSessionSigningSecret(env: Env): string {
  return strongSigningSecret(env, 'AUDIT_SESSION_SIGNING_SECRET');
}

/** Website/app-ai HMAC key used only to authenticate audit-status callbacks. */
export function auditStatusSigningSecret(env: Env): string {
  return strongSigningSecret(env, 'AUDIT_STATUS_SIGNING_SECRET');
}

/**
 * The origins a website-signed activation may name as its status-callback
 * destination. Each entry is a bare `scheme://host[:port]` origin and must use
 * HTTPS; plain HTTP is accepted only on a loopback host outside production, the
 * same deployed-versus-local distinction the paid-provider guard applies.
 */
export function auditStatusOrigins(env: Env): readonly string[] {
  const origins = requireVar(env, 'AUDIT_STATUS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) {
    throw new Error(`AUDIT_STATUS_ORIGINS must list at least one callback origin. ${SET_IN_VARS}`);
  }
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(
        `AUDIT_STATUS_ORIGINS entry "${origin}" must be an absolute origin. ${SET_IN_VARS}`,
      );
    }
    if (url.origin !== origin) {
      throw new Error(
        `AUDIT_STATUS_ORIGINS entry "${origin}" must be a bare scheme://host[:port] origin. ${SET_IN_VARS}`,
      );
    }
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHost(url) && !isProductionDeployment(env))
    ) {
      throw new Error(
        `AUDIT_STATUS_ORIGINS entry "${origin}" must use HTTPS; plain HTTP is accepted only on a loopback host outside production. ${SET_IN_VARS}`,
      );
    }
  }
  return origins;
}

/** Strongly consistent authority for one-time activation, quotas, and file ownership. */
export function auditSessionAuthority(env: Env): DurableObjectNamespace {
  if (env.AUDIT_SESSIONS) return env.AUDIT_SESSIONS;
  throw new Error(
    'Missing required configuration binding AUDIT_SESSIONS. Bind the AuditSessionAuthority Durable Object in wrangler.toml.',
  );
}

/** Exchanged audit-session lifetime in seconds. */
export function auditSessionTtlSeconds(env: Env): number {
  return positiveIntegerVar(env, 'AUDIT_SESSION_TTL_SECONDS');
}

/** Maximum successful uploads in one audit session. */
export function auditMaxUploads(env: Env): number {
  return positiveIntegerVar(env, 'AUDIT_MAX_UPLOADS');
}

/** Maximum successful inference calls in one audit session. */
export function auditMaxMessages(env: Env): number {
  return positiveIntegerVar(env, 'AUDIT_MAX_MESSAGES');
}

/** Maximum byte length of one audit upload. */
export function auditMaxUploadBytes(env: Env): number {
  return positiveIntegerVar(env, 'AUDIT_MAX_UPLOAD_BYTES');
}

/** Maximum aggregate uploaded bytes reserved or completed by one audit session. */
export function auditMaxTotalUploadBytes(env: Env): number {
  return positiveIntegerVar(env, 'AUDIT_MAX_TOTAL_UPLOAD_BYTES');
}

/** Maximum serialized JSON bytes accepted by one audit inference request. */
export function auditMaxMessageBytes(env: Env): number {
  return positiveIntegerVar(env, 'AUDIT_MAX_MESSAGE_BYTES');
}

function strongSigningSecret(
  env: Env,
  name:
    | 'AUDIT_ACTIVATION_SIGNING_SECRET'
    | 'AUDIT_SESSION_SIGNING_SECRET'
    | 'AUDIT_STATUS_SIGNING_SECRET',
): string {
  const secret = requireVar(env, name);
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error(`${name} must contain at least 32 bytes.`);
  }
  return secret;
}

function positiveIntegerVar(
  env: Env,
  name:
    | 'MASTER_SUBSCRIBER_ID'
    | 'AUDIT_SESSION_TTL_SECONDS'
    | 'AUDIT_MAX_UPLOADS'
    | 'AUDIT_MAX_MESSAGES'
    | 'AUDIT_MAX_UPLOAD_BYTES'
    | 'AUDIT_MAX_TOTAL_UPLOAD_BYTES'
    | 'AUDIT_MAX_MESSAGE_BYTES',
): number {
  const raw = requireVar(env, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
