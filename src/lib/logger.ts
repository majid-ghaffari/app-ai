/**
 * Environment-routed structured logging.
 *
 * Application code emits one levelled record. Deployment configuration routes each level to zero,
 * one, or several registered sinks. Environment names never decide logging behavior: local may use
 * console + Seq while Cloudflare uses Seq only, entirely through LOG_TARGETS_* bindings.
 */

import {
  logSeqApiKey,
  logSeqIngestUrl,
  logTargets,
  type Env,
  type LogLevel,
  type LogTarget,
} from '../config';

export type BackgroundTaskScheduler = (task: Promise<unknown>) => void;

export interface LogContext extends Record<string, unknown> {
  contextId?: string | null;
  subscriberId?: number;
  requestId?: string;
  route?: string;
  prompt?: string | null;
}

export interface Logger {
  trace(message: string, details?: unknown): void;
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, error?: unknown, details?: unknown): void;
  fatal(message: string, error?: unknown, details?: unknown): void;
  child(context: LogContext): Logger;
}

export interface LoggingRuntime {
  logger(scope: string, context?: LogContext): Logger;
  child(context: LogContext): LoggingRuntime;
  runBackground(scope: string, operation: string, task: Promise<unknown>): void;
}

interface LogRecord {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  context: LogContext;
  details?: unknown;
  exception?: unknown;
}

const LEVEL_TO_CONSOLE: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

const LEVEL_TO_SEQ: Record<LogLevel, string> = {
  trace: 'Verbose',
  debug: 'Debug',
  info: 'Information',
  warn: 'Warning',
  error: 'Error',
  fatal: 'Fatal',
};

/** A silent logger for pure helpers/tests whose production caller supplies the real request logger. */
export const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

/** Silent runtime for isolated pure-handler tests; production always supplies a configured runtime. */
export const silentLoggingRuntime: LoggingRuntime = {
  logger: () => silentLogger,
  child: () => silentLoggingRuntime,
  runBackground: (_scope, _operation, task) => {
    void task.catch(() => undefined);
  },
};

/** Build one immutable request-scoped logging runtime. */
export function createLoggingRuntime(
  env: Env,
  schedule?: BackgroundTaskScheduler,
  baseContext: LogContext = {},
): LoggingRuntime {
  // Parse every level at the boundary so malformed deployment configuration fails before work starts.
  const routes = new Map<LogLevel, readonly LogTarget[]>();
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    routes.set(level, logTargets(env, level));
  }

  const anySeq = [...routes.values()].some((targets) => targets.includes('seq'));
  const seqUrl = anySeq ? logSeqIngestUrl(env) : null;
  const seqApiKey = anySeq ? logSeqApiKey(env) : null;

  function makeRuntime(runtimeContext: LogContext): LoggingRuntime {
    return {
      logger(scope, context = {}) {
        return makeLogger(scope, { ...runtimeContext, ...context });
      },
      child(context) {
        return makeRuntime({ ...runtimeContext, ...context });
      },
      runBackground(scope, operation, task) {
        const guarded = task.catch((error: unknown) => {
          makeLogger(scope, runtimeContext).error(`Background task failed: ${operation}`, error, {
            operation,
          });
        });
        if (schedule) {
          try {
            schedule(guarded);
          } catch {
            void guarded;
          }
        } else void guarded;
      },
    };
  }

  function makeLogger(scope: string, context: LogContext): Logger {
    const emit = (level: LogLevel, message: string, exception?: unknown, details?: unknown) => {
      const targets = routes.get(level) ?? [];
      if (targets.length === 0) return;
      const record: LogRecord = {
        timestamp: new Date().toISOString(),
        level,
        scope,
        message,
        context: sanitizeContext(context),
        ...(details === undefined ? {} : { details: toLogValue(details) }),
        ...(exception === undefined ? {} : { exception: toLogValue(exception) }),
      };
      for (const target of targets) {
        if (target === 'console') {
          writeConsole(record);
        } else if (target === 'seq' && seqUrl) {
          const delivery = deliverToSeq(seqUrl, seqApiKey, record);
          if (schedule) {
            try {
              schedule(delivery);
            } catch {
              // A logging sink must never recursively log or alter the application response.
            }
          } else {
            void delivery;
          }
        }
      }
    };

    return {
      trace: (message, details) => emit('trace', message, undefined, details),
      debug: (message, details) => emit('debug', message, undefined, details),
      info: (message, details) => emit('info', message, undefined, details),
      warn: (message, details) => emit('warn', message, undefined, details),
      error: (message, error, details) => emit('error', message, error, details),
      fatal: (message, error, details) => emit('fatal', message, error, details),
      child: (childContext) => makeLogger(scope, { ...context, ...childContext }),
    };
  }

  return makeRuntime(baseContext);
}

/** Convert exceptions and structured details into JSON-safe diagnostic data. */
export function toLogValue(
  value: unknown,
  seen = new WeakSet<object>(),
  propertyName?: string,
): unknown {
  if (propertyName && isSecretProperty(propertyName)) return '[REDACTED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular Error]';
    seen.add(value);
    const record: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    if ('cause' in value && value.cause !== undefined) {
      record.cause = toLogValue(value.cause, seen, 'cause');
    }
    for (const key of Object.keys(value)) {
      record[key] = toLogValue((value as unknown as Record<string, unknown>)[key], seen, key);
    }
    return record;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map((entry) => toLogValue(entry, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toLogValue(entry, seen, key),
      ]),
    );
  }
  return String(value);
}

function sanitizeContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, toLogValue(value, new WeakSet(), key)]),
  );
}

/** Redact credential-bearing fields while retaining operational ids such as contextId. */
function isSecretProperty(propertyName: string): boolean {
  const normalized = propertyName.replaceAll('-', '_').toLowerCase();
  const compact = normalized.replaceAll('_', '');
  return (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'set_cookie' ||
    normalized === 'password' ||
    normalized === 'passwd' ||
    normalized === 'secret' ||
    normalized.endsWith('_secret') ||
    compact === 'token' ||
    compact.endsWith('token') ||
    compact === 'apikey' ||
    compact.endsWith('apikey') ||
    normalized === 'x_api_key' ||
    normalized === 'x_seq_apikey'
  );
}

function writeConsole(record: LogRecord): void {
  const method = LEVEL_TO_CONSOLE[record.level];
  if (
    Object.keys(record.context).length === 0 &&
    record.details === undefined &&
    record.exception === undefined
  ) {
    console[method](`[${record.scope}]`, record.message);
    return;
  }
  const detailRecord =
    record.details && typeof record.details === 'object' && !Array.isArray(record.details)
      ? record.details
      : record.details === undefined
        ? {}
        : { Detail: record.details };
  console[method](`[${record.scope}]`, record.message, {
    ...record.context,
    ...detailRecord,
    ...(record.exception === undefined ? {} : { Exception: record.exception }),
  });
}

async function deliverToSeq(
  ingestUrl: string,
  apiKey: string | null,
  record: LogRecord,
): Promise<void> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['X-Seq-ApiKey'] = apiKey;
    await fetch(ingestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        '@t': record.timestamp,
        '@mt': '{Scope}: {Message}',
        '@l': LEVEL_TO_SEQ[record.level],
        Application: 'app-ai',
        Scope: record.scope,
        Message: record.message,
        LogLevel: record.level,
        ...record.context,
        ...(record.details === undefined ? {} : { Detail: record.details }),
        ...(record.exception === undefined ? {} : { Exception: record.exception }),
      }),
    });
  } catch {
    // Sink delivery is fail-open and cannot recursively report through itself.
  }
}
