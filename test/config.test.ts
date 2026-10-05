/**
 * Configuration module (src/config.ts) — the no-fallback contract: every
 * required variable read fails fast with an error naming the variable and
 * where to set it; FILES_KV alone is optional for internal dedup. Sealed public
 * file references use a required encryption key instead of KV consistency, and
 * audit configuration is fail-fast when the scoped audit route is used.
 *
 * Also pins the PRODUCTION configuration values in wrangler.toml `[vars]` —
 * the deployed wire contract (Brain routing, model choices) is config, so
 * the contract proof reads the deploy manifest itself.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  personalizerApiUrl,
  deploymentEnvironment,
  personalizerIntegrationBridgeToken,
  anthropicApiBase,
  openaiApiBase,
  moonshotApiBase,
  kimiApiBase,
  logSeqApiKey,
  logSeqIngestUrl,
  logTargets,
  claudeApiKey,
  openaiApiKey,
  moonshotApiKey,
  kimiApiKey,
  tokenEncryptionSecret,
  credentialedOrigins,
  auditActivationSigningSecret,
  auditStatusOrigins,
  auditStatusSigningSecret,
  auditMaxMessageBytes,
  messagesKeepAliveIntervalMilliseconds,
  auditMaxRuns,
  auditMaxUploadBytes,
  auditRunHeadroom,
  auditSessionAuthority,
  auditSessionSigningSecret,
  auditSessionTtlSeconds,
  freeVisualVerifyDailyLimit,
  graderChatAlertEvery,
  graderChatAlertSlackWebhookUrl,
  graderChatBookletVersion,
  graderChatEffort,
  graderChatEnabled,
  graderChatMaxInputCharacters,
  graderChatMaxReplyTokens,
  graderChatMessagesPerDay,
  graderChatMessagesPerAudit,
  graderChatMessagesPerVisitorPerDay,
  graderExtensionBuiltAfter,
  graderRunsValidFrom,
  freeVisualVerifyAcceptanceReserve,
  freeVisualVerifyEnabled,
  inferenceQuotaInternalOrigin,
  missingRequiredSecretNames,
  resolveModel,
  type Env,
} from '../src/config';
import { describePromptRoutes, validateModelRouting } from '../src/prompt-registry';
import { graderChatRoute } from '../src/handlers/grader-chat';
import { ENV } from './helpers';

const EMPTY_ENV: Env = {};

describe('config accessors — present values', () => {
  it('returns the configured values verbatim', () => {
    expect(deploymentEnvironment(ENV)).toBe('test');
    expect(personalizerApiUrl(ENV)).toBe('https://brain.test');
    expect(anthropicApiBase(ENV)).toBe('https://api.anthropic.com');
    expect(openaiApiBase(ENV)).toBe('https://api.openai.com');
    expect(moonshotApiBase(ENV)).toBe('https://api.moonshot.ai');
    expect(kimiApiBase(ENV)).toBe('https://api.kimi.com/coding');
    expect(logSeqIngestUrl(ENV)).toBe('https://seq.test/ingest/clef');
    expect(logSeqApiKey(ENV)).toBeNull();
    expect(claudeApiKey(ENV)).toBe('test-key');
    expect(openaiApiKey(ENV)).toBe('test-openai-key');
    expect(moonshotApiKey(ENV)).toBe('test-moonshot-key');
    expect(kimiApiKey(ENV)).toBe('test-kimi-key');
    expect(tokenEncryptionSecret(ENV)).toBe(ENV.TOKEN_ENCRYPTION_SECRET);
    expect(personalizerIntegrationBridgeToken(ENV)).toBe('svc-token-256bit-opaque');
    expect(auditActivationSigningSecret(ENV)).toBe(ENV.AUDIT_ACTIVATION_SIGNING_SECRET);
    expect(auditSessionSigningSecret(ENV)).toBe(ENV.AUDIT_SESSION_SIGNING_SECRET);
    expect(auditStatusSigningSecret(ENV)).toBe(ENV.AUDIT_STATUS_SIGNING_SECRET);
    expect(auditStatusOrigins(ENV)).toEqual(['https://limespot.test']);
    expect(auditSessionTtlSeconds(ENV)).toBe(2592000);
    expect(graderRunsValidFrom(ENV)).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(graderExtensionBuiltAfter(ENV)).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(auditMaxRuns(ENV)).toBe(4);
    expect(auditRunHeadroom(ENV)).toBe(2);
    expect(auditMaxUploadBytes(ENV)).toBe(8000000);
    expect(auditMaxMessageBytes(ENV)).toBe(1000000);
    expect(messagesKeepAliveIntervalMilliseconds(ENV)).toBe(15000);
  });

  it.each([
    ['anthropic', anthropicApiBase, 'ANTHROPIC_API_BASE', 'https://api.anthropic.com'],
    ['openai', openaiApiBase, 'OPENAI_API_BASE', 'https://api.openai.com'],
    ['moonshot', moonshotApiBase, 'MOONSHOT_API_BASE', 'https://api.moonshot.ai'],
    ['kimi', kimiApiBase, 'KIMI_API_BASE', 'https://api.kimi.com/coding'],
  ] as const)('requires explicit local paid opt-in for %s', (_provider, accessor, key, base) => {
    const { AI_CHANNEL: _channel, ...withoutChannel } = ENV;
    const local = { ...withoutChannel, ENVIRONMENT: 'local', [key]: base };
    expect(() => accessor(local)).toThrow(/AI_CHANNEL=prod/);
    expect(accessor({ ...local, AI_CHANNEL: 'prod' })).toBe(base);
    expect(accessor({ ...local, [key]: 'http://127.0.0.1:9999' })).toBe('http://127.0.0.1:9999');
    expect(() => accessor({ ...local, [key]: 'https://provider-proxy.example' })).toThrow(
      /AI_CHANNEL=prod/,
    );
    expect(() => accessor({ ...local, [key]: 'file:///tmp/provider' })).toThrow(/http or https/);
  });

  it('resolveModel maps each capability tier to its bound variable value', () => {
    expect(resolveModel(ENV, 'fast')).toBe('claude-haiku-4-5');
    expect(resolveModel(ENV, 'balanced')).toBe('claude-sonnet-5');
    expect(resolveModel(ENV, 'frontier')).toBe('claude-opus-4-8');
    // The tier reads its OWN bound var, not another tier's.
    expect(resolveModel(ENV, 'fast')).toBe(ENV.MODEL_FAST);
    expect(resolveModel(ENV, 'balanced')).toBe(ENV.MODEL_BALANCED);
    expect(resolveModel(ENV, 'frontier')).toBe(ENV.MODEL_FRONTIER);
  });

  it('accepts only bare origins in AUDIT_STATUS_ORIGINS, HTTPS off the loopback', () => {
    expect(
      auditStatusOrigins({
        ...ENV,
        AUDIT_STATUS_ORIGINS: ' https://limespot.com , http://127.0.0.1:5173 ,, ',
      }),
    ).toEqual(['https://limespot.com', 'http://127.0.0.1:5173']);
    expect(() => auditStatusOrigins({ ...ENV, AUDIT_STATUS_ORIGINS: ' , ' })).toThrow(
      /must list at least one callback origin/,
    );
    expect(() =>
      auditStatusOrigins({ ...ENV, AUDIT_STATUS_ORIGINS: '/studio/activate/api/status' }),
    ).toThrow(/must be an absolute origin/);
    expect(() =>
      auditStatusOrigins({ ...ENV, AUDIT_STATUS_ORIGINS: 'https://limespot.com/studio' }),
    ).toThrow(/must be a bare scheme:\/\/host/);
    expect(() =>
      auditStatusOrigins({ ...ENV, AUDIT_STATUS_ORIGINS: 'http://limespot.com' }),
    ).toThrow(/must use HTTPS/);
  });

  it('refuses a loopback HTTP callback origin in a production deployment', () => {
    expect(() =>
      auditStatusOrigins({
        ...ENV,
        ENVIRONMENT: 'production',
        AUDIT_STATUS_ORIGINS: 'http://127.0.0.1:5173',
      }),
    ).toThrow(/must use HTTPS/);
  });

  it('names the configuration channel in every malformed-origin error', () => {
    for (const value of [
      ' , ',
      '/studio/activate/api/status',
      'https://limespot.com/studio',
      'http://limespot.com',
    ]) {
      expect(() => auditStatusOrigins({ ...ENV, AUDIT_STATUS_ORIGINS: value })).toThrow(
        /Set it in wrangler\.toml \[vars\] \(production\) or in \.dev\.vars/,
      );
    }
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
  it('deploymentEnvironment names ENVIRONMENT and where to set it', () => {
    expect(() => deploymentEnvironment(EMPTY_ENV)).toThrow(
      /Missing required configuration variable ENVIRONMENT.*wrangler\.toml/,
    );
  });
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

  it('OpenAI accessors fail fast with the correct config channel', () => {
    expect(() => openaiApiBase(EMPTY_ENV)).toThrow(
      /Missing required configuration variable OPENAI_API_BASE.*wrangler\.toml/,
    );
    expect(() => openaiApiKey(EMPTY_ENV)).toThrow(
      /Missing required configuration variable OPENAI_API_KEY.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('Moonshot accessors fail fast with the correct config channel', () => {
    expect(() => moonshotApiBase(EMPTY_ENV)).toThrow(
      /Missing required configuration variable MOONSHOT_API_BASE.*wrangler\.toml/,
    );
    expect(() => moonshotApiKey(EMPTY_ENV)).toThrow(
      /Missing required configuration variable MOONSHOT_API_KEY.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('Kimi Code accessors fail fast with the correct config channel', () => {
    expect(() => kimiApiBase(EMPTY_ENV)).toThrow(
      /Missing required configuration variable KIMI_API_BASE.*wrangler\.toml/,
    );
    expect(() => kimiApiKey(EMPTY_ENV)).toThrow(
      /Missing required configuration variable KIMI_API_KEY.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('logSeqIngestUrl names LOG_SEQ_INGEST_URL', () => {
    expect(() => logSeqIngestUrl(EMPTY_ENV)).toThrow(
      /Missing required configuration variable LOG_SEQ_INGEST_URL.*wrangler\.toml/,
    );
  });

  it('logTargets validates ignore, fan-out, duplicates, and unknown targets', () => {
    expect(logTargets({ ...ENV, LOG_TARGETS_INFO: 'console, seq,console' }, 'info')).toEqual([
      'console',
      'seq',
    ]);
    expect(logTargets({ ...ENV, LOG_TARGETS_INFO: 'ignore' }, 'info')).toEqual([]);
    expect(() => logTargets({ ...ENV, LOG_TARGETS_INFO: 'ignore,seq' }, 'info')).toThrow(
      /cannot combine 'ignore'/,
    );
    expect(() => logTargets({ ...ENV, LOG_TARGETS_INFO: 'future' }, 'info')).toThrow(
      /unknown log target 'future'/,
    );
  });

  it('claudeApiKey names CLAUDE_API_KEY and the secret channels', () => {
    expect(() => claudeApiKey(EMPTY_ENV)).toThrow(
      /Missing required configuration variable CLAUDE_API_KEY.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('tokenEncryptionSecret names TOKEN_ENCRYPTION_SECRET and the secret channels', () => {
    expect(() => tokenEncryptionSecret(EMPTY_ENV)).toThrow(
      /Missing required configuration variable TOKEN_ENCRYPTION_SECRET.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('personalizerIntegrationBridgeToken names PERSONALIZER_INTEGRATION_BRIDGE_TOKEN and the secret channels', () => {
    expect(() => personalizerIntegrationBridgeToken(EMPTY_ENV)).toThrow(
      /Missing required configuration variable PERSONALIZER_INTEGRATION_BRIDGE_TOKEN.*encrypted secret.*\.dev\.vars/,
    );
  });

  it('audit secrets require separate strong encrypted values', () => {
    expect(() => auditActivationSigningSecret(EMPTY_ENV)).toThrow(
      /AUDIT_ACTIVATION_SIGNING_SECRET.*encrypted secret.*\.dev\.vars/,
    );
    expect(() => auditSessionSigningSecret(EMPTY_ENV)).toThrow(
      /AUDIT_SESSION_SIGNING_SECRET.*encrypted secret.*\.dev\.vars/,
    );
    expect(() => auditStatusSigningSecret(EMPTY_ENV)).toThrow(
      /AUDIT_STATUS_SIGNING_SECRET.*encrypted secret.*\.dev\.vars/,
    );
    expect(() => auditStatusOrigins(EMPTY_ENV)).toThrow(/AUDIT_STATUS_ORIGINS.*wrangler\.toml/);
    expect(() =>
      auditActivationSigningSecret({ AUDIT_ACTIVATION_SIGNING_SECRET: 'too-short' }),
    ).toThrow(/at least 32 bytes/);
  });

  it('audit numeric limits and the Durable Object binding fail fast', () => {
    expect(() => auditSessionTtlSeconds(EMPTY_ENV)).toThrow(/AUDIT_SESSION_TTL_SECONDS/);
    expect(() => graderRunsValidFrom(EMPTY_ENV)).toThrow(/GRADER_RUNS_VALID_FROM/);
    expect(() => graderExtensionBuiltAfter(EMPTY_ENV)).toThrow(/GRADER_EXTENSION_BUILT_AFTER/);
    for (const malformed of [
      '2026-01-01',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00+02:00',
      '2026-02-30T00:00:00Z',
      'yesterday',
    ]) {
      expect(() => graderRunsValidFrom({ ...ENV, GRADER_RUNS_VALID_FROM: malformed })).toThrow(
        /GRADER_RUNS_VALID_FROM must be an ISO-8601 UTC timestamp/,
      );
      expect(() =>
        graderExtensionBuiltAfter({ ...ENV, GRADER_EXTENSION_BUILT_AFTER: malformed }),
      ).toThrow(/GRADER_EXTENSION_BUILT_AFTER must be an ISO-8601 UTC timestamp/);
    }
    expect(
      graderRunsValidFrom({ ...ENV, GRADER_RUNS_VALID_FROM: '2026-10-03T17:30:00.250Z' }),
    ).toBe(Date.parse('2026-10-03T17:30:00.250Z'));
    expect(() => auditMaxRuns({ ...ENV, AUDIT_MAX_RUNS: '0' })).toThrow(
      /AUDIT_MAX_RUNS must be a positive integer/,
    );
    expect(() => auditRunHeadroom({ ...ENV, AUDIT_RUN_HEADROOM: '1.5' })).toThrow(
      /AUDIT_RUN_HEADROOM must be a positive integer/,
    );
    expect(() => auditMaxUploadBytes(EMPTY_ENV)).toThrow(/AUDIT_MAX_UPLOAD_BYTES/);
    expect(() => auditMaxMessageBytes(EMPTY_ENV)).toThrow(/AUDIT_MAX_MESSAGE_BYTES/);
    expect(() => auditSessionAuthority(EMPTY_ENV)).toThrow(/binding AUDIT_SESSIONS/);
  });

  it('protected visual verification configuration fails fast', () => {
    expect(freeVisualVerifyEnabled(ENV)).toBe(true);
    expect(freeVisualVerifyDailyLimit(ENV)).toBe(8);
    expect(freeVisualVerifyAcceptanceReserve(ENV)).toBe(4);
    expect(() =>
      freeVisualVerifyDailyLimit({ ...ENV, FREE_VISUAL_VERIFY_DAILY_LIMIT: '9' }),
    ).toThrow(/must not exceed 8/);
    expect(() =>
      freeVisualVerifyAcceptanceReserve({
        ...ENV,
        FREE_VISUAL_VERIFY_ACCEPTANCE_RESERVE: '8',
      }),
    ).toThrow(/must be below the daily limit/);
    expect(inferenceQuotaInternalOrigin(ENV)).toBe('https://inference-quota.internal');
    expect(() => auditSessionAuthority(EMPTY_ENV)).toThrow(/binding AUDIT_SESSIONS/);
    expect(() => freeVisualVerifyEnabled({ ...ENV, FREE_VISUAL_VERIFY_ENABLED: 'maybe' })).toThrow(
      /must be true or false/,
    );
  });

  it('Grader chat configuration parses, validates, and fails fast', () => {
    expect(graderChatEnabled(ENV)).toBe(true);
    expect(graderChatEnabled({ ...ENV, GRADER_CHAT_ENABLED: 'False' })).toBe(false);
    expect(() => graderChatEnabled({ ...ENV, GRADER_CHAT_ENABLED: 'yes' })).toThrow(
      /GRADER_CHAT_ENABLED must be true or false/,
    );
    expect(graderChatMessagesPerAudit(ENV)).toBe(25);
    expect(graderChatMessagesPerVisitorPerDay(ENV)).toBe(50);
    expect(graderChatMessagesPerDay(ENV)).toBe(10000);
    expect(graderChatMaxInputCharacters(ENV)).toBe(500);
    expect(graderChatMaxReplyTokens(ENV)).toBe(600);
    expect(graderChatEffort(ENV)).toBe('low');
    expect(graderChatEffort({ ...ENV, GRADER_CHAT_EFFORT: 'Medium' })).toBe('medium');
    expect(() => graderChatEffort({ ...ENV, GRADER_CHAT_EFFORT: 'max' })).toThrow(
      /GRADER_CHAT_EFFORT must be one of low, medium, high, xhigh/,
    );
    expect(graderChatBookletVersion(ENV)).toBe(3);
    expect(graderChatAlertEvery(ENV)).toBe(500);
    for (const [name, accessor] of [
      ['GRADER_CHAT_MESSAGES_PER_AUDIT', graderChatMessagesPerAudit],
      ['GRADER_CHAT_MESSAGES_PER_VISITOR_PER_DAY', graderChatMessagesPerVisitorPerDay],
      ['GRADER_CHAT_MESSAGES_PER_DAY', graderChatMessagesPerDay],
      ['GRADER_CHAT_MAX_INPUT_CHARACTERS', graderChatMaxInputCharacters],
      ['GRADER_CHAT_MAX_REPLY_TOKENS', graderChatMaxReplyTokens],
      ['GRADER_CHAT_BOOKLET_VERSION', graderChatBookletVersion],
      ['GRADER_CHAT_ALERT_EVERY', graderChatAlertEvery],
    ] as const) {
      expect(() => accessor({ ...ENV, [name]: '0' }), name).toThrow(
        new RegExp(`${name} must be a positive integer`),
      );
      expect(() => accessor(EMPTY_ENV), name).toThrow(
        new RegExp(`Missing required configuration variable ${name}.*wrangler\\.toml`),
      );
    }
    expect(() => graderChatEnabled(EMPTY_ENV)).toThrow(/GRADER_CHAT_ENABLED.*wrangler\.toml/);
    expect(() => graderChatEffort(EMPTY_ENV)).toThrow(/GRADER_CHAT_EFFORT.*wrangler\.toml/);
  });

  it('treats the chat-volume alert webhook as an optional HTTPS secret', () => {
    expect(graderChatAlertSlackWebhookUrl(ENV)).toBeNull();
    expect(
      graderChatAlertSlackWebhookUrl({ ...ENV, GRADER_CHAT_ALERT_SLACK_WEBHOOK_URL: '' }),
    ).toBeNull();
    expect(
      graderChatAlertSlackWebhookUrl({
        ...ENV,
        GRADER_CHAT_ALERT_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/T/B/X',
      }),
    ).toBe('https://hooks.slack.test/services/T/B/X');
    for (const value of ['http://hooks.slack.test/services/T/B/X', 'not a url']) {
      expect(() =>
        graderChatAlertSlackWebhookUrl({ ...ENV, GRADER_CHAT_ALERT_SLACK_WEBHOOK_URL: value }),
      ).toThrow(/must be an absolute HTTPS URL/);
    }
    expect(missingRequiredSecretNames(ENV, ['anthropic'])).not.toContain(
      'GRADER_CHAT_ALERT_SLACK_WEBHOOK_URL',
    );
  });

  it('the keep-alive interval names its variable and is a positive whole number', () => {
    expect(() => messagesKeepAliveIntervalMilliseconds(EMPTY_ENV)).toThrow(
      /MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS/,
    );
    expect(() =>
      messagesKeepAliveIntervalMilliseconds({
        ...ENV,
        MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS: '0',
      }),
    ).toThrow(/MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS must be a positive integer/);
  });

  it('credentialedOrigins names CREDENTIALED_ORIGINS', () => {
    expect(() => credentialedOrigins(EMPTY_ENV)).toThrow(
      /Missing required configuration variable CREDENTIALED_ORIGINS/,
    );
  });

  it('resolveModel names the tier variable (MODEL_FAST / MODEL_BALANCED / MODEL_FRONTIER) when absent', () => {
    expect(() => resolveModel(EMPTY_ENV, 'fast')).toThrow(
      /Missing required configuration variable MODEL_FAST/,
    );
    expect(() => resolveModel(EMPTY_ENV, 'balanced')).toThrow(
      /Missing required configuration variable MODEL_BALANCED/,
    );
    expect(() => resolveModel(EMPTY_ENV, 'frontier')).toThrow(
      /Missing required configuration variable MODEL_FRONTIER/,
    );
  });

  it('reports a provider key missing only while a route uses that provider', () => {
    const {
      OPENAI_API_KEY: _openai,
      MOONSHOT_API_KEY: _moonshot,
      KIMI_API_KEY: _kimi,
      GEMINI_API_KEY: _gemini,
      CLAUDE_API_KEY: _claude,
      ...none
    } = ENV;
    expect(missingRequiredSecretNames(none, ['anthropic'])).toEqual(['CLAUDE_API_KEY']);
    expect(missingRequiredSecretNames(none, ['anthropic', 'gemini'])).toEqual([
      'CLAUDE_API_KEY',
      'GEMINI_API_KEY',
    ]);
    expect(missingRequiredSecretNames(none, ['moonshot'])).toEqual(['MOONSHOT_API_KEY']);
    expect(missingRequiredSecretNames(none, ['kimi'])).toEqual(['KIMI_API_KEY']);
    expect(
      missingRequiredSecretNames(none, ['anthropic', 'openai', 'moonshot', 'kimi', 'gemini']),
    ).toEqual([
      'CLAUDE_API_KEY',
      'OPENAI_API_KEY',
      'MOONSHOT_API_KEY',
      'KIMI_API_KEY',
      'GEMINI_API_KEY',
    ]);
    // Non-provider secrets are required whatever is routed.
    const { TOKEN_ENCRYPTION_SECRET: _sealing, ...noSealing } = ENV;
    expect(missingRequiredSecretNames(noSealing, [])).toEqual(['TOKEN_ENCRYPTION_SECRET']);
    expect(missingRequiredSecretNames(ENV, [])).toEqual([]);
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

const devVarsExampleFiles = import.meta.glob('../.dev.vars.example', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const configSourceFiles = import.meta.glob('../src/config.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** The one file that is allowed to say what a binding is called. */
function configSource(): string {
  const source = Object.values(configSourceFiles)[0];
  if (!source) throw new Error('src/config.ts not found next to test/');
  return source;
}

/** Every member declared on the typed `Env` interface, in declaration order. */
function declaredEnvMembers(): readonly string[] {
  const source = configSource();
  const start = source.indexOf('export interface Env {');
  if (start === -1) throw new Error('src/config.ts declares no Env interface');
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}readonly ([A-Z][A-Z0-9_]*)\?:/gm)].map((match) => {
    const name = match[1];
    if (!name) throw new Error('unparsed Env member');
    return name;
  });
}

/** Names listed in the SECRET_VAR_NAMES table — the encrypted-secret channel. */
function declaredSecretNames(): readonly string[] {
  const source = configSource();
  const start = source.indexOf('const SECRET_VAR_NAMES');
  if (start === -1) throw new Error('src/config.ts declares no SECRET_VAR_NAMES');
  const body = source.slice(start, source.indexOf('];', start));
  return [...body.matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => {
    const name = match[1];
    if (!name) throw new Error('unparsed secret name');
    return name;
  });
}

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

/**
 * The `[vars]` table parsed into the bindings it declares. Every entry is a
 * quoted string, so a line that is neither blank, a comment, nor `KEY = "value"`
 * is a parse failure here rather than a binding silently left out of the proof.
 */
function parsedProductionVars(): ReadonlyMap<string, string> {
  const vars = new Map<string, string>();
  for (const line of productionVars().split('\n')) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('#')) continue;
    const match = text.match(/^([A-Z][A-Z0-9_]*) = "(.*)"$/);
    if (!match?.[1] || match[2] === undefined) {
      throw new Error(`wrangler.toml [vars] line is not a quoted string binding: ${text}`);
    }
    vars.set(match[1], match[2]);
  }
  return vars;
}

/** The deployed model-routing bindings over the test fixture's other members. */
function deployedModelRoutingEnv(): Env {
  const vars = parsedProductionVars();
  const binding = (
    name: 'MODEL_FAST' | 'MODEL_BALANCED' | 'MODEL_FRONTIER' | 'MODEL_OVERRIDES',
  ) => {
    const value = vars.get(name);
    if (value === undefined) throw new Error(`wrangler.toml [vars] declares no ${name}`);
    return value;
  };
  return {
    ...ENV,
    MODEL_FAST: binding('MODEL_FAST'),
    MODEL_BALANCED: binding('MODEL_BALANCED'),
    MODEL_FRONTIER: binding('MODEL_FRONTIER'),
    MODEL_OVERRIDES: binding('MODEL_OVERRIDES'),
  };
}

describe('configuration files stay reconciled with the typed Env', () => {
  it('documents every binding the worker reads in .dev.vars.example', () => {
    const example = Object.values(devVarsExampleFiles)[0];
    if (!example) throw new Error('.dev.vars.example not found next to test/');
    const members = declaredEnvMembers();
    // A guard that has never seen the whole set is not a guard.
    expect(members.length).toBeGreaterThan(25);
    for (const member of members) {
      expect(example, `${member} is undocumented in .dev.vars.example`).toContain(member);
    }
  });

  it('marks every documented key REQUIRED or OPTIONAL and leaves every secret blank', () => {
    const example = Object.values(devVarsExampleFiles)[0];
    if (!example) throw new Error('.dev.vars.example not found next to test/');
    for (const secret of declaredSecretNames()) {
      // A committed example never carries a value that could be mistaken for one.
      expect(example, `${secret} must be blank in the committed example`).toMatch(
        new RegExp(`^${secret}=$`, 'm'),
      );
    }
    expect(example).toMatch(/REQUIRED/);
    expect(example).toMatch(/OPTIONAL/);
  });

  it('declares the provisioned Gemini and Kimi channel in both files', () => {
    const example = Object.values(devVarsExampleFiles)[0] ?? '';
    const manifest = Object.values(wranglerFiles)[0] ?? '';
    expect(productionVars()).toContain(
      'GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"',
    );
    expect(productionVars()).toContain('KIMI_API_BASE = "https://api.kimi.com/coding"');
    for (const key of ['GEMINI_API_BASE', 'KIMI_API_BASE', 'GEMINI_API_KEY', 'KIMI_API_KEY']) {
      expect(example, `${key} is undocumented in .dev.vars.example`).toContain(key);
    }
    for (const secret of ['GEMINI_API_KEY', 'KIMI_API_KEY']) {
      expect(productionVars()).not.toContain(secret);
      expect(manifest).toContain(secret);
    }
  });
});

describe('production [vars] — the deployed configuration values', () => {
  it('routes Brain calls to https://personalizer.io in production', () => {
    expect(productionVars()).toContain('PERSONALIZER_API_URL = "https://personalizer.io"');
  });

  it('routes Anthropic calls to https://api.anthropic.com', () => {
    expect(productionVars()).toContain('ANTHROPIC_API_BASE = "https://api.anthropic.com"');
  });

  it('pins the dormant OpenAI Responses origin without changing prompt routes', () => {
    expect(productionVars()).toContain('OPENAI_API_BASE = "https://api.openai.com"');
  });

  it('pins the dormant Moonshot Chat Completions origin without changing prompt routes', () => {
    expect(productionVars()).toContain('MOONSHOT_API_BASE = "https://api.moonshot.ai"');
  });

  it('pins the dormant Kimi Code subscription origin on its own account', () => {
    expect(productionVars()).toContain('KIMI_API_BASE = "https://api.kimi.com/coding"');
    expect(productionVars()).toContain('KIMI_EVIDENCE_MAX_BYTES = "8000000"');
    expect(productionVars()).toContain('KIMI_EVIDENCE_MAX_TOTAL_BYTES = "64000000"');
    expect(productionVars()).toContain('KIMI_EVIDENCE_MAX_TEXT_BYTES = "16000000"');
  });

  it('pins the private production and preview R2 evidence buckets', () => {
    const manifest = Object.values(wranglerFiles)[0] ?? '';
    expect(manifest).toContain('[[r2_buckets]]');
    expect(manifest).toContain('binding = "INLINE_EVIDENCE_R2"');
    expect(manifest).toContain('bucket_name = "app-ai-inline-evidence"');
    expect(manifest).toContain('preview_bucket_name = "app-ai-inline-evidence-preview"');
  });

  it('pins the tier→model bindings (fast + balanced + frontier)', () => {
    expect(productionVars()).toContain('MODEL_FAST = "claude-haiku-4-5"');
    expect(productionVars()).toContain('MODEL_BALANCED = "claude-sonnet-5"');
    expect(productionVars()).toContain('MODEL_FRONTIER = "claude-opus-4-8"');
  });

  it('routes only protected visual verification through Workers AI', () => {
    const manifest = Object.values(wranglerFiles)[0] ?? '';
    expect(productionVars()).toContain(
      'MODEL_OVERRIDES = "free-render-verification=@cf/qwen/qwen3.8-27b"',
    );
    expect(manifest).toContain('[ai]');
    expect(manifest).toContain('binding = "AI"');
  });

  it('resolves every registered prompt and group under the deployed model bindings', () => {
    // The deploy manifest's own MODEL_* and MODEL_OVERRIDES values, not the
    // fixture's: an id no catalog family claims, or an override that moves a
    // prompt off its group's shared file route, would 500 every prompt on that
    // tier after deploy, and this is the statement that the pushed config fits.
    const env = deployedModelRoutingEnv();
    expect(() => validateModelRouting(env)).not.toThrow();
    for (const description of describePromptRoutes(env)) {
      expect(description.valid, `${description.name}: ${description.error ?? ''}`).toBe(true);
    }
  });

  it('passes production readiness with every deployed binding, the Grader chat on', async () => {
    const deployed: Env = { ...ENV, ...Object.fromEntries(parsedProductionVars()) };
    expect(graderChatEnabled(deployed)).toBe(true);
    expect(graderChatRoute(deployed).profile).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    vi.stubGlobal('__APP_AI_REV__', 'fc00704');
    vi.resetModules();
    try {
      const { default: servedWorker } = await import('../src/index');
      const ready = await servedWorker.fetch(new Request('https://app-ai.test/health'), deployed);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: 'ok', buildRev: 'fc00704' });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('gates the operator diagnostics on a configured master subscriber', () => {
    expect(productionVars()).toContain('MASTER_SUBSCRIBER_ID = "1"');
  });

  it('writes a keep-alive byte every 15 seconds, well under a 60-second idle cut', () => {
    expect(productionVars()).toContain('MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS = "15000"');
  });

  it('routes durable production QC telemetry and failures to Seq', () => {
    const vars = productionVars();
    for (const level of ['TRACE', 'DEBUG']) {
      expect(vars).toContain(`LOG_TARGETS_${level} = "ignore"`);
    }
    expect(vars).toContain('LOG_TARGETS_INFO = "seq"');
    expect(vars).toContain('LOG_TARGETS_WARN = "seq"');
    expect(vars).toContain('LOG_TARGETS_ERROR = "seq"');
    expect(vars).toContain('LOG_TARGETS_FATAL = "seq"');
    expect(vars).toContain('LOG_SEQ_INGEST_URL = "https://log.limespot.net/ingest/clef"');
    expect(Object.values(wranglerFiles)[0]).not.toContain('[observability]');
  });

  it('keeps the credentialed dev-origin allowlist', () => {
    expect(productionVars()).toContain(
      'CREDENTIALED_ORIGINS = "https://local-app.limespot.com,http://localhost:4200,http://localhost:3000"',
    );
  });

  it('allowlists only the limespot.com origin for signed status callbacks', () => {
    expect(productionVars()).toContain('AUDIT_STATUS_ORIGINS = "https://limespot.com"');
  });

  it('limits a grader session by its runs and holds each run to twice its plan', () => {
    const vars = parsedProductionVars();
    expect(vars.get('AUDIT_MAX_RUNS')).toBe('4');
    expect(vars.get('AUDIT_RUN_HEADROOM')).toBe('2');
    expect(vars.get('AUDIT_MAX_UPLOAD_BYTES')).toBe('8000000');
    expect(vars.get('AUDIT_MAX_MESSAGE_BYTES')).toBe('1000000');
    for (const retired of [
      'AUDIT_MAX_UPLOADS',
      'AUDIT_MAX_MESSAGES',
      'AUDIT_MAX_TOTAL_UPLOAD_BYTES',
    ]) {
      expect(vars.has(retired), `${retired} no longer limits a grader session`).toBe(false);
    }
  });

  it('keeps a grader session, and its chat, for 30 days, as the test fixture does', () => {
    expect(parsedProductionVars().get('AUDIT_SESSION_TTL_SECONDS')).toBe('2592000');
    expect(ENV.AUDIT_SESSION_TTL_SECONDS).toBe(
      parsedProductionVars().get('AUDIT_SESSION_TTL_SECONDS'),
    );
  });

  it('ships both Grader kill switches at a past instant, so a deploy invalidates nothing', () => {
    const vars = parsedProductionVars();
    expect(vars.get('GRADER_RUNS_VALID_FROM')).toBe('2026-01-01T00:00:00Z');
    expect(vars.get('GRADER_EXTENSION_BUILT_AFTER')).toBe('2026-01-01T00:00:00Z');
  });

  it('ships the Grader chat on with its operator defaults', () => {
    const vars = parsedProductionVars();
    expect(vars.get('GRADER_CHAT_ENABLED')).toBe('true');
    expect(vars.get('GRADER_CHAT_MESSAGES_PER_AUDIT')).toBe('25');
    expect(vars.get('GRADER_CHAT_MESSAGES_PER_VISITOR_PER_DAY')).toBe('50');
    expect(vars.get('GRADER_CHAT_MESSAGES_PER_DAY')).toBe('10000');
    expect(vars.get('GRADER_CHAT_MAX_INPUT_CHARACTERS')).toBe('500');
    expect(vars.get('GRADER_CHAT_MAX_REPLY_TOKENS')).toBe('600');
    expect(vars.get('GRADER_CHAT_EFFORT')).toBe('low');
    expect(vars.get('GRADER_CHAT_BOOKLET_VERSION')).toBe('3');
    expect(vars.get('GRADER_CHAT_ALERT_EVERY')).toBe('500');
  });

  it('binds the strongly consistent audit-session authority with its migration', () => {
    const manifest = Object.values(wranglerFiles)[0] ?? '';
    expect(manifest).toContain('name = "AUDIT_SESSIONS"');
    expect(manifest).toContain('class_name = "AuditSessionAuthority"');
    expect(manifest).not.toMatch(/^new_classes\s*=/m);
    expect(manifest).not.toContain('AUDIT_SESSIONS_KV');
  });

  it('hosts the protected inference quota in the existing audit authority', () => {
    const manifest = Object.values(wranglerFiles)[0] ?? '';
    expect(manifest).not.toContain('name = "INFERENCE_QUOTAS"');
    expect(manifest).not.toContain('class_name = "InferenceQuotaAuthority"');
    expect(manifest).not.toContain('tag = "inference-quotas-v3"');
  });

  it('keeps the applied migration ledger intact and renames the class through it', () => {
    const manifest = Object.values(wranglerFiles)[0] ?? '';
    const creation = manifest.indexOf('tag = "demo-sessions-v1"');
    const rename = manifest.indexOf('tag = "audit-sessions-v2"');
    expect(creation).toBeGreaterThan(-1);
    expect(manifest).toContain('new_sqlite_classes = ["DemoSessionAuthority"]');
    expect(rename).toBeGreaterThan(creation);
    expect(manifest).toContain(
      'renamed_classes = [{ from = "DemoSessionAuthority", to = "AuditSessionAuthority" }]',
    );
  });

  it('declares every required variable except the secrets (encrypted, dashboard-managed)', () => {
    const vars = productionVars();
    for (const name of [
      'ENVIRONMENT',
      'PERSONALIZER_API_URL',
      'ANTHROPIC_API_BASE',
      'OPENAI_API_BASE',
      'MOONSHOT_API_BASE',
      'KIMI_API_BASE',
      'CREDENTIALED_ORIGINS',
      'MASTER_SUBSCRIBER_ID',
      'MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS',
      'MODEL_FAST',
      'MODEL_BALANCED',
      'MODEL_FRONTIER',
      'FREE_VISUAL_VERIFY_ENABLED',
      'FREE_VISUAL_VERIFY_DAILY_LIMIT',
      'FREE_VISUAL_VERIFY_ACCEPTANCE_RESERVE',
      'INFERENCE_QUOTA_INTERNAL_ORIGIN',
      'LOG_TARGETS_TRACE',
      'LOG_TARGETS_DEBUG',
      'LOG_TARGETS_INFO',
      'LOG_TARGETS_WARN',
      'LOG_TARGETS_ERROR',
      'LOG_TARGETS_FATAL',
      'LOG_SEQ_INGEST_URL',
      'AUDIT_STATUS_ORIGINS',
      'AUDIT_SESSION_TTL_SECONDS',
      'AUDIT_MAX_RUNS',
      'AUDIT_RUN_HEADROOM',
      'AUDIT_MAX_UPLOAD_BYTES',
      'AUDIT_MAX_MESSAGE_BYTES',
      'GRADER_CHAT_ENABLED',
      'GRADER_CHAT_MESSAGES_PER_AUDIT',
      'GRADER_CHAT_MESSAGES_PER_VISITOR_PER_DAY',
      'GRADER_CHAT_MESSAGES_PER_DAY',
      'GRADER_CHAT_MAX_INPUT_CHARACTERS',
      'GRADER_CHAT_MAX_REPLY_TOKENS',
      'GRADER_CHAT_EFFORT',
      'GRADER_CHAT_BOOKLET_VERSION',
      'GRADER_CHAT_ALERT_EVERY',
      'GRADER_RUNS_VALID_FROM',
      'GRADER_EXTENSION_BUILT_AFTER',
    ]) {
      expect(vars).toContain(`${name} = `);
    }
    expect(vars).not.toContain('GRADER_CHAT_ALERT_SLACK_WEBHOOK_URL');
    expect(vars).not.toContain('CLAUDE_API_KEY');
    expect(vars).not.toContain('OPENAI_API_KEY');
    expect(vars).not.toContain('MOONSHOT_API_KEY');
    expect(vars).not.toContain('KIMI_API_KEY');
    expect(vars).not.toContain('PERSONALIZER_INTEGRATION_BRIDGE_TOKEN');
    expect(vars).not.toContain('AUDIT_ACTIVATION_SIGNING_SECRET');
    expect(vars).not.toContain('AUDIT_SESSION_SIGNING_SECRET');
    expect(vars).not.toContain('AUDIT_STATUS_SIGNING_SECRET');
    expect(vars).not.toContain('TOKEN_ENCRYPTION_SECRET');
    // Derived, so a secret added to src/config.ts cannot quietly appear in [vars].
    for (const secret of declaredSecretNames()) {
      expect(vars, `${secret} must never be a plain-text var`).not.toContain(secret);
    }
  });
});
