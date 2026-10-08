/**
 * Architecture fitness tests — static scans over src/ that enforce the
 * standing invariants (CLAUDE.md → Key Principles, docs/CODE-PATTERNS.md,
 * docs/TOOLSETS.md). Each scan names the rule it enforces; weakening one is a
 * deliberate contract change, not a cleanup.
 *
 *   1. Capability-driven composition — every composeToolsets call site in a
 *      handler passes subscriber parties and AI-tool capabilities; only
 *      handlers + the toolset layer touch the registry.
 *   2. Secrets never logged — API keys/tokens stay out of log calls and the
 *      model-visible system builder never sees the request context-ID.
 *   3. One error shape — the retired `{ error: { message } }` envelope pattern
 *      never reappears; every handler builds errors through lib/responses.
 *   4. No Hardcoded Config Values — no absolute URL literals in src code OR
 *      in scripts/ (config lives in wrangler [vars] / .dev.vars behind the
 *      typed Env; the Node scripts take explicit environment variables), and
 *      no inline fallbacks on config reads anywhere (`env.X || / ??`,
 *      `process.env.X || / ??`) — missing config = error.
 *   5. Credentials stay out of URLs — a context-ID may be read from a query
 *      string for the master-gated GET /prompts diagnostics and nowhere else,
 *      so no other route can grow a credential that browser history and
 *      intermediaries see.
 *
 * The scans read src/ + scripts/ via import.meta.glob (vite raw imports) — no
 * Node fs.
 */

import { describe, it, expect } from 'vitest';

const sourceModules = import.meta.glob('../src/**/*.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const handlerModules = import.meta.glob('../src/handlers/*.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const scriptModules = import.meta.glob('../scripts/**/*.mjs', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const testModules = import.meta.glob('../test/**/*.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Strip block comments and line comments (protecting `://` inside URLs). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, (_match, prefix: string) => prefix);
}

/**
 * Extract the argument text of every `<callee>(...)` call in `source`
 * (balanced-paren walk — good enough for this codebase's call sites).
 */
function callArguments(source: string, calleePattern: RegExp): string[] {
  const results: string[] = [];
  const matcher = new RegExp(calleePattern.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    let depth = 1;
    let position = match.index + match[0].length;
    const start = position;
    while (position < source.length && depth > 0) {
      const character = source[position];
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      position += 1;
    }
    results.push(source.slice(start, position - 1));
  }
  return results;
}

describe('fitness: strict TypeScript has no suppression directives', () => {
  it('keeps source, scripts, and tests free of TypeScript suppression comments', () => {
    for (const [path, source] of Object.entries({
      ...sourceModules,
      ...scriptModules,
      ...testModules,
    })) {
      if (path.endsWith('/architecture.test.ts')) continue;
      expect(source, `${path}: fix the type instead of suppressing it`).not.toMatch(
        /@ts-(?:ignore|expect-error|nocheck)/,
      );
    }
  });
});

describe('fitness: party-driven composition', () => {
  it('every handler composing toolsets drives it from the subscriber parties, not a static allowlist', () => {
    let composingHandlers = 0;
    for (const [path, source] of Object.entries(handlerModules)) {
      if (!source.includes('composeToolsets(')) continue;
      composingHandlers += 1;
      // Composition is data-driven off the subscriber's available parties — the
      // static endpoint toolset-name allowlist model is retired.
      expect(
        source,
        `${path}: composition must be party-driven — no static const <NAME>_TOOLSETS allowlist`,
      ).not.toMatch(/const [A-Z_]+_TOOLSETS = \[/);
      expect(source, `${path}: pass the subscriber's availableParties to composeToolsets`).toMatch(
        /composeToolsets\(\s*availableParties/,
      );
      expect(source, `${path}: pass availableAiTools to composeToolsets`).toMatch(
        /composeToolsets\([\s\S]*availableAiTools/,
      );
    }
    // /chat is the one composing endpoint — a new one must land party-driven too.
    expect(composingHandlers).toBeGreaterThanOrEqual(1);
  });

  it('the router grants Brain data tools only for capability contract version 1', () => {
    const routerSource = Object.entries(sourceModules).find(([path]) =>
      path.endsWith('/index.ts'),
    )?.[1];
    const authSource = Object.entries(sourceModules).find(([path]) =>
      path.endsWith('/lib/auth.ts'),
    )?.[1];
    if (!routerSource) throw new Error('src/index.ts not found in the scan');
    if (!authSource) throw new Error('src/lib/auth.ts not found in the scan');
    expect(authSource).toContain('export const SUPPORTED_AI_TOOLS_CONTRACT_VERSION');
    expect(routerSource).toContain(
      'validation.AiToolsContractVersion === SUPPORTED_AI_TOOLS_CONTRACT_VERSION',
    );
    expect(routerSource).toContain('validation.AvailableAiTools ?? []');
  });

  it('only handlers and the toolset layer touch the registry', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.includes('/handlers/') || path.includes('/toolsets/')) continue;
      expect(source, `${path}: composeToolsets is handler/toolset territory`).not.toContain(
        'composeToolsets',
      );
    }
  });
});

describe('fitness: secrets never enter logs or model context', () => {
  const SECRET_IDENTIFIERS = [
    'CLAUDE_API_KEY',
    'OPENAI_API_KEY',
    'MOONSHOT_API_KEY',
    'KIMI_API_KEY',
    'GEMINI_API_KEY',
    'TOKEN_ENCRYPTION_SECRET',
    'apiKey',
    'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN',
    'serviceToken',
    'AUDIT_ACTIVATION_SIGNING_SECRET',
    'AUDIT_SESSION_SIGNING_SECRET',
    'AUDIT_STATUS_SIGNING_SECRET',
    'GRADER_CHAT_ALERT_SLACK_WEBHOOK_URL',
  ];

  it('no log/console call references a credential identifier', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      const code = stripComments(source);
      const logArguments = callArguments(
        code,
        /\b(?:log\.(?:info|warn|error)|console\.(?:log|warn|error|info|debug))\(/,
      );
      for (const argumentText of logArguments) {
        for (const identifier of SECRET_IDENTIFIERS) {
          expect(
            argumentText,
            `${path}: a log call must never carry ${identifier} (docs/TOOLSETS.md security standards)`,
          ).not.toContain(identifier);
        }
      }
    }
  });

  it('the model-visible system builder (buildSystem) never sees the context-ID', () => {
    const chatSource = Object.entries(sourceModules).find(([path]) =>
      path.endsWith('handlers/chat.ts'),
    )?.[1];
    if (!chatSource) throw new Error('src/handlers/chat.ts not found in the scan');
    const buildSystemStart = chatSource.indexOf('export function buildSystem');
    expect(buildSystemStart).toBeGreaterThan(-1);
    const buildSystemEnd = chatSource.indexOf('\nexport ', buildSystemStart + 1);
    const buildSystemSource = chatSource.slice(
      buildSystemStart,
      buildSystemEnd === -1 ? undefined : buildSystemEnd,
    );
    expect(buildSystemSource).not.toContain('contextId');
    expect(buildSystemSource).not.toContain('credentials');
  });

  it('a degraded tool result cannot carry a raw upstream body', () => {
    const typesSource = Object.entries(sourceModules).find(([path]) =>
      path.endsWith('toolsets/types.ts'),
    )?.[1];
    if (!typesSource) throw new Error('src/toolsets/types.ts not found in the scan');
    const failureStart = typesSource.indexOf('export interface ToolExecutionFailure');
    const failureEnd = typesSource.indexOf('\n}', failureStart);
    const failureSource = typesSource.slice(failureStart, failureEnd);
    expect(failureSource).toContain('result: { error: string }');
    expect(failureSource).not.toContain('body');
  });

  it('no log call carries provider file identifiers', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      const logArguments = callArguments(
        stripComments(source),
        /\b(?:log\.(?:info|warn|error)|console\.(?:log|warn|error|info|debug))\(/,
      );
      for (const argumentText of logArguments) {
        expect(argumentText, `${path}: provider file ids never enter logs`).not.toMatch(
          /\b(?:fileId|file_id|upstreamFileId)\b/,
        );
      }
    }
  });
});

describe('fitness: one error shape (Brain wire envelope)', () => {
  it('the retired { error: { message } } envelope pattern never reappears in src', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      const code = stripComments(source);
      expect(code, `${path}: use the Brain envelope via lib/responses`).not.toMatch(
        /error:\s*\{\s*message\b/,
      );
      expect(code, `${path}: never serialize a bespoke error envelope`).not.toMatch(
        /JSON\.stringify\(\s*\{\s*error\b/,
      );
    }
  });

  it('every non-health handler builds error responses through lib/responses', () => {
    for (const [path, source] of Object.entries(handlerModules)) {
      if (path.endsWith('health.ts')) continue;
      expect(source, `${path}: import the shared error helpers`).toMatch(
        /from '\.\.\/lib\/responses'/,
      );
    }
  });
});

describe('fitness: prompt-grouped provider authority', () => {
  it('the existing prompt-registry.ts is the only source module importing the prompt barrel', () => {
    const owners = Object.entries(sourceModules)
      .filter(([, source]) => /from ['"]\.\/prompts['"]/.test(stripComments(source)))
      .map(([path]) => path);
    expect(owners).toEqual(['../src/prompt-registry.ts']);
  });

  it('handlers do not resolve model bindings or read MODEL_* configuration', () => {
    for (const [path, source] of Object.entries(handlerModules)) {
      const code = stripComments(source);
      expect(
        code,
        `${path}: prompt -> group -> profile routing belongs to the registry`,
      ).not.toContain('resolveModel(');
      expect(code, `${path}: concrete model bindings belong to config/registry`).not.toMatch(
        /\bMODEL_(?:FAST|BALANCED|FRONTIER)\b/,
      );
    }
  });

  it('provider/model/profile/file-policy/effort fields do not exist on public handler request-body interfaces', () => {
    for (const [path, source] of Object.entries(handlerModules)) {
      const code = stripComments(source);
      const requestInterfaces = code.match(/interface \w*Request(?:Body)?\s*\{[\s\S]*?\n\}/g) ?? [];
      for (const requestInterface of requestInterfaces) {
        expect(
          requestInterface,
          `${path}: callers name prompts, never providers/profiles/file policies`,
        ).not.toMatch(/\b(provider|model|modelProfile|filePolicy|effort)\??\s*:/);
      }
    }
  });

  it('/messages builds registered requests only from registry-owned model and effort policy', () => {
    const messagesSource = Object.entries(handlerModules).find(([path]) =>
      path.endsWith('handlers/messages.ts'),
    )?.[1];
    if (!messagesSource) throw new Error('src/handlers/messages.ts not found in the scan');
    const code = stripComments(messagesSource);
    expect(code).not.toContain('claudePayload.model');
    expect(code).not.toContain('body.model');
    expect(code).not.toContain('body.effort');
    expect(code).toContain('const profile = getModelProfile(entry.name, env)');
    expect(code).toContain('const policy = getFilePolicy(entry.filePolicy)');
    expect(code).toContain('modelProfile: profile');
    expect(code).toContain('filePolicy: policy');
    expect(code).toContain('maxOutputTokens: entry.maxTokens');
    expect(code).toContain('...(requestPolicy.effort ? { effort: requestPolicy.effort } : {})');
    expect(code).toContain('entry.adaptiveEffort');
    expect(code).toContain('createInferenceService(env, tenantScope).complete(inferenceRequest)');
  });

  it('provider wire modules are isolated under inference/adapters', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.includes('/inference/adapters/') || path.endsWith('/inference/factory.ts')) continue;
      const code = stripComments(source);
      expect(code, `${path}: provider protocol imports belong to adapters`).not.toMatch(
        /from ['"][^'"]*inference\/adapters\/(?:anthropic|openai|moonshot|kimi|gemini)[^'"]*['"]|from ['"][^'"]*lib\/anthropic['"]/,
      );
    }
  });

  it('provider endpoint and credential accessors are consumed only by adapters', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.includes('/inference/adapters/') || path.endsWith('/config.ts')) continue;
      const code = stripComments(source);
      expect(code, `${path}: provider transport authority belongs to its adapter`).not.toMatch(
        /\b(?:anthropicApiBase|claudeApiKey|openaiApiBase|openaiApiKey|moonshotApiBase|moonshotApiKey|kimiApiBase|kimiApiKey|geminiApiBase|geminiApiKey)\b/,
      );
    }
  });

  it('every provider transport goes through the non-following provider fetch', () => {
    const adapters = Object.entries(sourceModules).filter(([path]) =>
      path.includes('/inference/adapters/'),
    );
    expect(adapters.length).toBeGreaterThan(5);
    for (const [path, source] of adapters) {
      if (path.endsWith('/inference/adapters/provider-fetch.ts')) continue;
      expect(
        stripComments(source),
        `${path}: call fetchProvider, which follows no redirect`,
      ).not.toMatch(/(?<![\w.])fetch\(/);
    }
  });

  it('the inference factory is the only provider-neutral module selecting an adapter', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (!path.includes('/inference/')) continue;
      if (path.includes('/inference/adapters/') || path.endsWith('/inference/factory.ts')) continue;
      const code = stripComments(source);
      expect(code, `${path}: provider switches belong only to inference/factory.ts`).not.toMatch(
        /\.(?:provider|apiFamily)\s*===/,
      );
    }
  });

  it('handlers do not reconstruct provider continuation wire state', () => {
    for (const [path, source] of Object.entries(handlerModules)) {
      const code = stripComments(source);
      expect(
        code,
        `${path}: provider history recovery belongs to inference compatibility`,
      ).not.toMatch(
        /\.provider\s*===\s*['"](?:anthropic|openai|moonshot|kimi|gemini)['"]|\bcontentBlocks\b/,
      );
    }
  });

  it('provider-required public continuation is preflighted before file or inference I/O', () => {
    for (const filename of ['handlers/messages.ts', 'handlers/chat.ts']) {
      const source = Object.entries(handlerModules).find(([path]) => path.endsWith(filename))?.[1];
      if (!source) throw new Error(`${filename} not found in the scan`);
      const requirement = source.indexOf('requiresOrdinaryTurnContinuation(profile, env)');
      const missingState = source.indexOf('isRequiredContinuationMissing(profile, env');
      const serviceCall = source.indexOf('createInferenceService(');
      expect(
        requirement,
        `${filename}: continuation route requirement must be resolved`,
      ).toBeGreaterThan(-1);
      expect(
        requirement,
        `${filename}: required continuation must fail before provider/file service I/O`,
      ).toBeLessThan(serviceCall);
      expect(
        missingState,
        `${filename}: assistant history must require its continuation`,
      ).toBeGreaterThan(-1);
      expect(
        missingState,
        `${filename}: missing continuation must fail before provider/file service I/O`,
      ).toBeLessThan(serviceCall);
    }
  });

  it('prompt-aware uploads validate destinations before provider upload', () => {
    const filesSource = Object.entries(handlerModules).find(([path]) =>
      path.endsWith('handlers/files.ts'),
    )?.[1];
    if (!filesSource) throw new Error('src/handlers/files.ts not found in the scan');
    const code = stripComments(filesSource);
    expect(code).toContain("formData.getAll('prompt')");
    expect(code).toContain('isPromptName(value)');
    expect(code).toContain('resolvePromptFileRoute(prompt, env, files, tenantScope)');
    expect(code).toContain("formData.getAll('file')");
    expect(code).toContain('uniqueRoutes.map(async (route)');
    // Every route settles before the handler answers, so a route failure releases
    // the provider objects its siblings created instead of orphaning them.
    expect(code).toContain('Promise.allSettled(');
    expect(code).toContain('releaseOrphanedUploads(succeeded, files, log)');
    expect(code.indexOf('parseDestinationPrompts(formData')).toBeLessThan(
      code.indexOf('file.arrayBuffer()'),
    );
    expect(code.indexOf('parseDestinationPrompts(formData')).toBeLessThan(
      code.indexOf('dedupUpload('),
    );
  });

  it('public file IDs stay opaque and adapters consume only resolved provider references', () => {
    const types = Object.entries(sourceModules).find(([path]) =>
      path.endsWith('/lib/inference-types.ts'),
    )?.[1];
    const anthropicAdapter = Object.entries(sourceModules).find(([path]) =>
      path.endsWith('/inference/adapters/anthropic.ts'),
    )?.[1];
    if (!types || !anthropicAdapter) throw new Error('file-reference contract modules missing');
    const publicShape = types.match(/export interface OpaqueFileReference\s*\{[\s\S]*?\n\}/)?.[0];
    if (!publicShape) throw new Error('OpaqueFileReference not found');
    expect(publicShape).not.toMatch(/provider|account|policy|upstream|model/i);
    expect(types).toContain('readonly tenantScope: string;');
    expect(stripComments(anthropicAdapter)).toContain('source.reference.upstreamFileId');
    expect(stripComments(anthropicAdapter)).toContain(
      'Anthropic received an unresolved public file reference',
    );
  });

  it('no source module recognises a raw provider file id', () => {
    // Every file id that crosses a public boundary is a sealed reference, and
    // the unregistered /messages passthrough refuses provider file blocks, so
    // nothing in src/ has a reason to sniff a bare `file_…` string.
    for (const [path, source] of Object.entries(sourceModules)) {
      const code = stripComments(source);
      expect(code, `${path}: raw provider file ids are never recognised`).not.toMatch(
        /startsWith\(['"]file_/,
      );
      expect(code, `${path}: no raw-id compatibility bypass`).not.toMatch(
        /legacyAnthropicReference/,
      );
    }
  });

  it('the shared agent runtime preserves normalized adapter error events', () => {
    const serviceSource = Object.entries(sourceModules).find(([path]) =>
      path.endsWith('/inference/service.ts'),
    )?.[1];
    if (!serviceSource) throw new Error('src/inference/service.ts not found in the scan');
    expect(stripComments(serviceSource)).toContain(
      "if (event.type === 'error') throw new InferenceFailure(event.error)",
    );
  });
});

describe('fitness: query-string credentials are scoped to GET /prompts', () => {
  const PARAMETER = 'personalizerContextId';
  const READER = 'promptsDiagnosticsContextId';

  function sourceOf(suffix: string): string {
    const found = Object.entries(sourceModules).find(([path]) => path.endsWith(suffix))?.[1];
    if (!found) throw new Error(`src/${suffix} not found in the scan`);
    return stripComments(found);
  }

  it('only the prompts handler names the diagnostics query parameter', () => {
    const naming = Object.entries(sourceModules)
      .filter(([, source]) => stripComments(source).includes(PARAMETER))
      .map(([path]) => path);
    for (const path of naming) {
      expect(
        path,
        `${path}: only src/handlers/prompts.ts may name a credential query parameter`,
      ).toMatch(/handlers\/prompts\.ts$/);
    }
    expect(naming).toHaveLength(1);
  });

  it('no module besides the prompts handler reads a query parameter at all', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.endsWith('handlers/prompts.ts')) continue;
      expect(
        stripComments(source),
        `${path}: query-parameter credentials are the GET /prompts diagnostics only`,
      ).not.toMatch(/searchParams\s*\.\s*get\s*\(/);
    }
  });

  it('the router consults the URL only on the GET /prompts dispatch, header first', () => {
    const router = sourceOf('src/index.ts');
    expect(router.match(new RegExp(`${READER}\\(`, 'g'))).toHaveLength(1);
    expect(router).toMatch(
      new RegExp(`pathname === '/prompts' && method === 'GET'\\s*\\?\\s*${READER}\\(`),
    );
    // The header wins: the URL is consulted only while the header carries nothing.
    expect(router).toMatch(
      /const headerContextId = request\.headers\.get\('X-Personalizer-Context-ID'\)/,
    );
    expect(router).toMatch(/headerContextId === null && pathname === '\/prompts'/);
    expect(router).toMatch(/const contextId = headerContextId \?\? urlContextId/);
    // A URL credential that does not authenticate as the master answers exactly
    // as one carrying no credential, so this route cannot be told apart from a
    // path that reads no query parameter.
    expect(router).toMatch(/throw urlContextId === null \? error : missingContextIdError\(\)/);
    expect(router).toMatch(/credentialFromUrl: urlContextId !== null/);
  });

  it('no module besides the router calls the diagnostics reader', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.endsWith('src/index.ts') || path.endsWith('handlers/prompts.ts')) continue;
      expect(
        stripComments(source),
        `${path}: only the router reads the GET /prompts URL credential`,
      ).not.toContain(READER);
    }
  });

  it('the logger strips credential-bearing query parameters from every logged string', () => {
    const logger = sourceOf('src/lib/logger.ts');
    // The sanitizer, not a per-call-site habit, is what keeps a URL credential
    // out of a sink: every string entering a record goes through it.
    expect(logger.slice(logger.indexOf('function sanitizeLogText'))).toContain(
      'redactCredentialQueryParameters(redactOpaqueFileIds(value))',
    );
    for (const sanitized of [
      'message: sanitizeLogText(message)',
      "if (typeof value === 'string') return sanitizeLogText(value)",
      'message: sanitizeLogText(value.message)',
      'stack: value.stack ? sanitizeLogText(value.stack) : value.stack',
    ]) {
      expect(logger, 'every string entering a record is sanitized').toContain(sanitized);
    }
  });
});

describe('fitness: No Hardcoded Config Values', () => {
  it('no absolute URL literal in src or scripts code (config lives behind the typed Env / explicit env vars)', () => {
    for (const [path, source] of [
      ...Object.entries(sourceModules),
      ...Object.entries(scriptModules),
    ]) {
      // The dev Claude-Code shim (scripts/dev-claude-shim.mjs) is standalone
      // local tooling that must run with `npm run dev:shim` and no setup — it
      // carries dev-sane default endpoints (127.0.0.1 Personalizer / its own
      // listen host), each overridable by an env var. It lives OUTSIDE the
      // worker's fail-fast config contract by design (it never ships to prod,
      // and is not bundled), so the no-URL-literal rule does not apply to it.
      if (path.endsWith('dev-claude-shim.mjs')) continue;
      const code = stripComments(source);
      expect(
        code,
        `${path}: URLs are configuration — wrangler [vars] / .dev.vars via src/config.ts (worker) or an explicit required env var (scripts)`,
      ).not.toMatch(/https?:\/\//);
    }
  });

  it('no inline env fallback in src or scripts (missing config = error)', () => {
    for (const [path, source] of [
      ...Object.entries(sourceModules),
      ...Object.entries(scriptModules),
    ]) {
      const code = stripComments(source);
      expect(code, `${path}: env reads must not carry || / ?? fallbacks`).not.toMatch(
        /\benv\.[A-Za-z_]+\s*(\|\||\?\?)/,
      );
      expect(code, `${path}: env reads must not carry || / ?? fallbacks`).not.toMatch(
        /\benv\[[^\]]+\]\s*(\|\||\?\?)/,
      );
      expect(code, `${path}: process.env reads must not carry || / ?? fallbacks`).not.toMatch(
        /\bprocess\.env\.[A-Za-z_]+\s*(\|\||\?\?)/,
      );
      expect(code, `${path}: process.env reads must not carry || / ?? fallbacks`).not.toMatch(
        /\bprocess\.env\[[^\]]+\]\s*(\|\||\?\?)/,
      );
    }
  });

  it('required config variables are read only through src/config.ts accessors', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.endsWith('src/config.ts')) continue;
      const code = stripComments(source);
      // FILES_KV is the one documented OPTIONAL binding (graceful dedup no-op)
      // and may be read off the typed Env directly.
      expect(code, `${path}: read config via the src/config.ts accessors`).not.toMatch(
        /\benv\.(INLINE_EVIDENCE_R2|PERSONALIZER_API_URL|ANTHROPIC_API_BASE|OPENAI_API_BASE|MOONSHOT_API_BASE|KIMI_API_BASE|KIMI_EVIDENCE_MAX_BYTES|KIMI_EVIDENCE_MAX_TOTAL_BYTES|KIMI_EVIDENCE_MAX_TEXT_BYTES|GEMINI_API_BASE|LOG_TARGETS_TRACE|LOG_TARGETS_DEBUG|LOG_TARGETS_INFO|LOG_TARGETS_WARN|LOG_TARGETS_ERROR|LOG_TARGETS_FATAL|LOG_SEQ_INGEST_URL|LOG_SEQ_API_KEY|CLAUDE_API_KEY|OPENAI_API_KEY|MOONSHOT_API_KEY|KIMI_API_KEY|GEMINI_API_KEY|TOKEN_ENCRYPTION_SECRET|PERSONALIZER_INTEGRATION_BRIDGE_TOKEN|CREDENTIALED_ORIGINS|MESSAGES_KEEP_ALIVE_INTERVAL_MILLISECONDS|MASTER_SUBSCRIBER_ID|MODEL_OVERRIDES|ENVIRONMENT)\b/,
      );
    }
  });

  it('Worker application code never bypasses the configured logger with console calls', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      if (path.endsWith('src/lib/logger.ts')) continue;
      expect(stripComments(source), `${path}: route logs through LoggingRuntime`).not.toMatch(
        /\bconsole\.(?:log|debug|info|warn|error)\s*\(/,
      );
    }
  });
});
