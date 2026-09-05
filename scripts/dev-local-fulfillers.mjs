/** Provider-neutral local inference fulfillers used only by the development shim. */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCAL_FULFILLERS = new Set(['claude-code', 'codex']);
const LOCAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'tool_use',
  'refusal',
  'pause_turn',
  'model_context_window_exceeded',
]);
const CODEX_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];
const CODEX_KILL_GRACE_MS = 1_000;

function envText(env, name) {
  const value = env?.[name];
  return typeof value === 'string' ? value : '';
}

/** Select the local fulfiller explicitly; Claude Code retains the established default. */
export function localFulfillerName(env = process.env) {
  const configured = envText(env, 'LOCAL_AI_FULFILLER').trim();
  const name = (configured.length > 0 ? configured : 'claude-code').toLowerCase();
  if (!LOCAL_FULFILLERS.has(name)) {
    throw new Error(`Unsupported LOCAL_AI_FULFILLER ${name}`);
  }
  return name;
}

/** Block every known paid provider origin in local/test unless the channel is explicit. */
export function assertLocalInferenceChannel(env = process.env) {
  const channel = envText(env, 'AI_CHANNEL').trim().toLowerCase();
  const selected = [
    'ANTHROPIC_API_BASE',
    'OPENAI_API_BASE',
    'MOONSHOT_API_BASE',
    'KIMI_API_BASE',
  ].filter((name) => {
    const value = envText(env, name).trim();
    if (!value) return false;
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must be an absolute URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${name} must use http or https`);
    }
    return !isLoopbackHostname(url.hostname);
  });
  if (selected.length > 0 && channel !== 'prod') {
    throw new Error(
      `Refusing paid local inference through ${selected.join(', ')} without AI_CHANNEL=prod`,
    );
  }
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Build the exact environment inherited by Codex, excluding every app/provider secret. */
export function codexChildEnvironment(env = process.env) {
  const channel = envText(env, 'AI_CHANNEL').trim().toLowerCase();
  const apiKey = envText(env, 'CODEX_API_KEY');
  if (apiKey && channel !== 'prod') {
    throw new Error('Refusing paid Codex API-key inference without AI_CHANNEL=prod');
  }
  const childEnv = {};
  for (const name of CODEX_ENV_ALLOWLIST) {
    const value = envText(env, name);
    if (value) childEnv[name] = value;
  }
  if (apiKey) childEnv.CODEX_API_KEY = apiKey;
  return childEnv;
}

/** Compose the bounded non-interactive Codex invocation. */
export function composeCodexExecArgs({
  model,
  effort,
  cwd,
  images = [],
  outputSchemaPath,
  outputPath,
  authMethod = 'chatgpt',
}) {
  if (!model || !String(model).trim()) throw new Error('CODEX_LOCAL_MODEL is required');
  const args = [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--config',
    'features.shell_tool=false',
    '--config',
    'web_search="disabled"',
    '--config',
    'features.remote_plugin=false',
    '--config',
    'features.apps=false',
    '--config',
    'features.skill_mcp_dependency_install=false',
    '--config',
    'agents.enabled=false',
    '--config',
    'project_doc_max_bytes=0',
    '--config',
    `forced_login_method=${JSON.stringify(authMethod)}`,
    '--skip-git-repo-check',
    '--json',
    '--color',
    'never',
    '--model',
    String(model),
    '--cd',
    cwd,
    '--output-last-message',
    outputPath,
  ];
  if (effort) args.push('--config', `model_reasoning_effort=${JSON.stringify(effort)}`);
  if (outputSchemaPath) args.push('--output-schema', outputSchemaPath);
  for (const image of images) args.push('--image', image);
  args.push('-');
  return args;
}

/** Translate an Anthropic-compatible shim request into a one-shot Codex prompt. */
export function codexPromptFrom(body) {
  const sections = [];
  const system = Array.isArray(body?.system)
    ? body.system
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n')
    : typeof body?.system === 'string'
      ? body.system
      : '';
  if (system) sections.push(`<system>\n${system}\n</system>`);
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const blocks = typeof message?.content === 'string' ? [message.content] : message?.content;
    const text = (Array.isArray(blocks) ? blocks : [])
      .flatMap((block) => {
        if (typeof block === 'string') return [block];
        if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
        if (block?.type === 'tool_result')
          return [`[tool result] ${JSON.stringify(block.content)}`];
        if (block?.type === 'document' && block.source?.type === 'text') {
          return [String(block.source.data ?? block.source.text ?? '')];
        }
        return [];
      })
      .join('\n');
    if (text) sections.push(`<${message?.role || 'user'}>\n${text}\n</${message?.role || 'user'}>`);
  }
  sections.push('Return only the final answer requested by the system and user messages.');
  return sections.join('\n\n');
}

function validateCodexContent(body) {
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    throw new Error('Codex local fulfiller requires a non-empty messages array');
  }
  if (
    body.output_config !== undefined &&
    (!body.output_config ||
      typeof body.output_config !== 'object' ||
      Array.isArray(body.output_config))
  ) {
    throw new Error('Codex local fulfiller requires an output_config object');
  }
  const format = body.output_config?.format;
  if (format !== undefined) {
    if (!format || typeof format !== 'object' || Array.isArray(format)) {
      throw new Error('Codex local fulfiller requires a structured-output format object');
    }
    if (format.type !== 'json_schema') {
      throw new Error('Codex local fulfiller supports only json_schema structured output');
    }
    if (!format.schema || typeof format.schema !== 'object' || Array.isArray(format.schema)) {
      throw new Error('Codex json_schema output requires a schema object');
    }
  }
  if (
    body?.output_config?.effort !== undefined &&
    !['low', 'medium', 'high', 'xhigh'].includes(body.output_config.effort)
  ) {
    throw new Error('Codex local fulfiller received an unsupported reasoning effort');
  }
  if (Array.isArray(body?.system)) {
    for (const block of body.system) {
      if (block?.type !== 'text' || typeof block.text !== 'string') {
        throw new Error('Codex local fulfiller supports only text system blocks');
      }
    }
  } else if (body?.system !== undefined && typeof body.system !== 'string') {
    throw new Error('Codex local fulfiller supports only text system content');
  }
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      throw new Error('Codex local fulfiller requires user or assistant message roles');
    }
    if (typeof message?.content === 'string') continue;
    if (!Array.isArray(message?.content)) {
      throw new Error('Codex local fulfiller requires string or block-array message content');
    }
    for (const block of message.content) {
      if (block?.type === 'text' && typeof block.text === 'string') continue;
      if (block?.type === 'image' && block.source?.type === 'base64') {
        const data = block.source.data;
        const mediaType = block.source.media_type;
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
          throw new Error(`Codex local fulfiller does not support image media type ${mediaType}`);
        }
        if (
          typeof data !== 'string' ||
          data.length === 0 ||
          data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
        ) {
          throw new Error('Codex image input must contain valid base64 data');
        }
        continue;
      }
      if (
        block?.type === 'document' &&
        block.source?.type === 'text' &&
        (typeof block.source.data === 'string' || typeof block.source.text === 'string')
      ) {
        continue;
      }
      throw new Error(`Codex local fulfiller does not support content block ${block?.type}`);
    }
  }
}

function imageParts(body) {
  const output = [];
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type !== 'image' || block.source?.type !== 'base64') continue;
      output.push({
        mediaType: String(block.source.media_type || 'image/png'),
        data: block.source.data,
      });
    }
  }
  return output;
}

function extensionFor(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/gif') return 'gif';
  return 'png';
}

/** Parse Codex JSONL usage without depending on unstable intermediate event text. */
export function codexUsageFromJsonl(value) {
  let terminalUsage = null;
  for (const line of String(value).split('\n')) {
    if (!line.trim()) continue;
    if (terminalUsage) throw new Error('Codex emitted events after terminal usage');
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('Codex emitted malformed JSONL');
    }
    if (
      !event ||
      typeof event !== 'object' ||
      Array.isArray(event) ||
      typeof event.type !== 'string'
    ) {
      throw new Error('Codex emitted malformed JSONL');
    }
    if (event?.type === 'turn.failed' || event?.type === 'error') {
      throw new Error('Codex reported a failed turn');
    }
    if (event?.type !== 'turn.completed') continue;
    const candidate = event.usage;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !nonNegativeInteger(candidate.input_tokens) ||
      !nonNegativeInteger(candidate.output_tokens) ||
      (candidate.cached_input_tokens !== undefined &&
        !nonNegativeInteger(candidate.cached_input_tokens))
    ) {
      throw new Error('Codex emitted invalid terminal usage');
    }
    terminalUsage = candidate;
  }
  if (!terminalUsage) throw new Error('Codex omitted terminal usage');
  return {
    input_tokens: terminalUsage.input_tokens,
    output_tokens: terminalUsage.output_tokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: terminalUsage.cached_input_tokens ?? 0,
  };
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Select one canonical local one-shot fulfiller. Claude Code remains injected
 * by the existing shim so this module stays independent of either vendor SDK.
 */
export async function fulfillLocalOneShot(body, options = {}) {
  const env = options.env || process.env;
  const fulfiller = localFulfillerName(env);
  if (fulfiller === 'codex') {
    const result = await fulfillWithCodex(body, options);
    const localResult = {
      fulfiller,
      model: envText(env, 'CODEX_LOCAL_MODEL').trim(),
      content: [{ type: 'text', text: result.text }],
      stopReason: 'end_turn',
      usage: result.usage,
    };
    validateLocalFulfillmentResult(localResult);
    return localResult;
  }
  if (typeof options.claudeCode !== 'function') {
    throw new Error('Claude Code local fulfiller is unavailable');
  }
  const result = { fulfiller, ...(await options.claudeCode(body, options.abortSignal)) };
  validateLocalFulfillmentResult(result);
  return result;
}

/** Convert the neutral local result back to the shim's Anthropic-compatible envelope. */
export function anthropicMessageFromLocalResult(result, id) {
  validateLocalFulfillmentResult(result);
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content: result.content,
    stop_reason: result.stopReason,
    stop_sequence: null,
    usage: result.usage,
  };
}

function validateLocalFulfillmentResult(result) {
  if (
    !result ||
    typeof result !== 'object' ||
    !LOCAL_FULFILLERS.has(result.fulfiller) ||
    typeof result.model !== 'string' ||
    result.model.trim().length === 0 ||
    !LOCAL_STOP_REASONS.has(result.stopReason) ||
    !Array.isArray(result.content) ||
    !validLocalContent(result.content) ||
    !validLocalUsage(result.usage)
  ) {
    throw new Error('Local fulfiller returned an invalid canonical result');
  }
}

function validLocalContent(content) {
  return content.every(
    (block) =>
      block &&
      typeof block === 'object' &&
      ((block.type === 'text' && typeof block.text === 'string') ||
        (block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          block.id.length > 0 &&
          typeof block.name === 'string' &&
          block.name.length > 0 &&
          block.input !== null &&
          typeof block.input === 'object' &&
          !Array.isArray(block.input))),
  );
}

function validLocalUsage(usage) {
  return (
    usage &&
    typeof usage === 'object' &&
    nonNegativeInteger(usage.input_tokens) &&
    nonNegativeInteger(usage.output_tokens) &&
    nonNegativeInteger(usage.cache_creation_input_tokens) &&
    nonNegativeInteger(usage.cache_read_input_tokens)
  );
}

/** Run one tool-free Codex turn. All filesystem artifacts are ephemeral. */
export async function fulfillWithCodex(body, options = {}) {
  if (body?.stream !== undefined && body.stream !== false) {
    throw new Error('Codex local fulfiller does not support streaming');
  }
  if (body?.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 0)) {
    throw new Error('Codex local fulfiller does not support tool calls');
  }
  const env = options.env || process.env;
  const model = envText(env, 'CODEX_LOCAL_MODEL').trim();
  if (!model) throw new Error('CODEX_LOCAL_MODEL is required');
  const childEnvironment = codexChildEnvironment(env);
  if (options.abortSignal?.aborted) throw new DOMException('Codex cancelled', 'AbortError');
  validateCodexContent(body);
  const prompt = codexPromptFrom(body);
  const images = imageParts(body);
  const workdir = await mkdtemp(join(tmpdir(), 'app-ai-codex-'));
  const outputPath = join(workdir, 'last-message.txt');
  const schema = body?.output_config?.format?.schema;
  const schemaPath =
    schema && typeof schema === 'object' ? join(workdir, 'output-schema.json') : null;
  const imagePaths = [];
  try {
    if (schemaPath) await writeFile(schemaPath, JSON.stringify(schema), 'utf8');
    for (const [index, image] of images.entries()) {
      if (typeof image.data !== 'string') throw new Error('Codex image input omitted base64 data');
      const path = join(workdir, `image-${index}.${extensionFor(image.mediaType)}`);
      await writeFile(path, Buffer.from(image.data, 'base64'));
      imagePaths.push(path);
    }
    const args = composeCodexExecArgs({
      model,
      effort: body?.output_config?.effort,
      cwd: workdir,
      images: imagePaths,
      outputSchemaPath: schemaPath,
      outputPath,
      authMethod: childEnvironment.CODEX_API_KEY ? 'api' : 'chatgpt',
    });
    const run = options.run || runCodexProcess;
    if (options.abortSignal?.aborted) throw new DOMException('Codex cancelled', 'AbortError');
    const executed = await run(args, prompt, options.abortSignal, {
      environment: childEnvironment,
    });
    const text =
      typeof executed.text === 'string' ? executed.text : await readFile(outputPath, 'utf8');
    return { text, usage: codexUsageFromJsonl(executed.stdout) };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Spawn boundary kept injectable for deterministic offline tests. */
export function runCodexProcess(args, prompt, abortSignal, options = {}) {
  if (abortSignal?.aborted) {
    return Promise.reject(new DOMException('Codex cancelled', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const spawnProcess = options.spawnProcess || spawn;
    const child = spawnProcess('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.environment || codexChildEnvironment(process.env),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborted = false;
    let stdinError = null;
    let childError = null;
    let killTimer = null;
    const finish = (action) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener('abort', abort);
      action();
    };
    const terminate = () => {
      child.kill('SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(
          () => child.kill('SIGKILL'),
          options.killGraceMs ?? CODEX_KILL_GRACE_MS,
        );
      }
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', (error) => {
      stdinError = error;
      terminate();
    });
    child.on('error', (error) => {
      childError = error;
    });
    child.on('close', (code, signal) => {
      if (aborted || abortSignal?.aborted) {
        return finish(() => reject(new DOMException('Codex cancelled', 'AbortError')));
      }
      if (stdinError) return finish(() => reject(stdinError));
      if (childError) return finish(() => reject(childError));
      if (code !== 0) {
        return finish(() => reject(new Error(`Codex exited ${code ?? signal}: ${stderr.trim()}`)));
      }
      finish(() => resolve({ stdout, stderr }));
    });
    child.stdin.end(prompt);
  });
}
