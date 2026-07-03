/**
 * Architecture fitness tests — static scans over src/ that enforce the
 * standing invariants (CLAUDE.md → Key Principles, docs/CODE-PATTERNS.md,
 * docs/TOOLSETS.md). Each scan names the rule it enforces; weakening one is a
 * deliberate contract change, not a cleanup.
 *
 *   1. Party-driven composition — every composeToolsets call site in a handler
 *      passes the subscriber's available parties, never a static toolset-name
 *      allowlist literal; only handlers + the toolset layer touch the registry.
 *   2. Credentials never logged — no log/console call references a credential
 *      identifier; the model-visible system builder never sees the context-ID.
 *   3. One error shape — the retired `{ error: { message } }` envelope pattern
 *      never reappears; every handler builds errors through lib/responses.
 *   4. No Hardcoded Config Values — no absolute URL literals in src code OR
 *      in scripts/ (config lives in wrangler [vars] / .dev.vars behind the
 *      typed Env; the Node scripts take explicit environment variables), and
 *      no inline fallbacks on config reads anywhere (`env.X || / ??`,
 *      `process.env.X || / ??`) — missing config = error.
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
    }
    // /chat is the one composing endpoint — a new one must land party-driven too.
    expect(composingHandlers).toBeGreaterThanOrEqual(1);
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

describe('fitness: credentials never enter logs or model context', () => {
  const CREDENTIAL_IDENTIFIERS = [
    'contextId',
    'credentials',
    'CLAUDE_API_KEY',
    'apiKey',
    'PERSONALIZER_INTEGRATION_BRIDGE_TOKEN',
    'serviceToken',
  ];

  it('no log/console call references a credential identifier', () => {
    for (const [path, source] of Object.entries(sourceModules)) {
      const code = stripComments(source);
      const logArguments = callArguments(
        code,
        /\b(?:log\.(?:info|warn|error)|console\.(?:log|warn|error|info|debug))\(/,
      );
      for (const argumentText of logArguments) {
        for (const identifier of CREDENTIAL_IDENTIFIERS) {
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

describe('fitness: No Hardcoded Config Values', () => {
  it('no absolute URL literal in src or scripts code (config lives behind the typed Env / explicit env vars)', () => {
    for (const [path, source] of [
      ...Object.entries(sourceModules),
      ...Object.entries(scriptModules),
    ]) {
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
        /\benv\.(PERSONALIZER_API_URL|ANTHROPIC_API_BASE|CLAUDE_API_KEY|PERSONALIZER_INTEGRATION_BRIDGE_TOKEN|CREDENTIALED_ORIGINS|ENVIRONMENT)\b/,
      );
    }
  });
});
