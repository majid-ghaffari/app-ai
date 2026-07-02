/**
 * Scoped console logger.
 *
 * In a Cloudflare Worker, `console.*` IS the observability mechanism — logs are
 * read live via `wrangler tail`. This helper just prefixes each line with a
 * scope tag so a single grep over a tail can isolate one subsystem's output.
 *
 *   const log = createLogger('Messages');
 *   log.info('request received');   // → [Messages] request received
 *
 * Levels map to the matching `console` method so log-level filtering in the
 * Cloudflare dashboard still works.
 *
 * SECURITY: no log line ever carries a credential (context-IDs, API keys) —
 * enforced by the credentials-never-logged fitness scan in
 * test/architecture.test.ts (docs/TOOLSETS.md → security standards).
 */

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** @param scope Short subsystem tag, e.g. `'Messages'` or `'Auth'`. */
export function createLogger(scope: string): Logger {
  const tag = `[${scope}]`;
  return {
    info: (...args: unknown[]) => console.log(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}
