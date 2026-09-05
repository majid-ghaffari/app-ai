/**
 * Explicitly paid Gemini `generateContent` probe matrix.
 *
 * This script is outside CI/default gates and refuses provider I/O until both
 * paid-channel acknowledgements are present. It closes the seams the adapter
 * documents as unverified: the structured-output shape, the SSE framing and its
 * absent terminal sentinel, the error envelope, the single-shot upload
 * protocol, and the mandatory thought signature on a function call.
 *
 * REQUIRED probes assert the contract the adapter ships and throw on any
 * deviation. EXPLORATORY probes record what the live API accepted so the
 * documented unknowns can be closed with evidence. A probe whose turn spent the
 * whole shared output budget on thinking reports the `starved` outcome, which is
 * a provider outcome rather than a contract deviation.
 */

import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { resolvesToRequestedModel } from './provider-model-ids.mjs';
import {
  GEMINI_DEFAULT_THINKING_LEVEL,
  geminiSharedOutputBudget,
} from '../src/inference/adapters/gemini-output-budget.ts';

/** A 1x1 transparent PNG, small enough to send inline in a probe body. */
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The ANSWER budget a probe asks for. Probe prompts are trivial, so a small one
 * is plenty; what matters is that the request is sized the way the adapter sizes
 * a live one — this answer budget plus the allowance for the thinking that
 * shares it, taken from the adapter's own sizing rather than a number of the
 * probe's own.
 */
export const PROBE_ANSWER_TOKENS = 256;

/**
 * The thinking level every probe declares. The adapter always sends a level, and
 * a request declaring no effort resolves to this one, so a probe that declared
 * none would exercise a request shape production never sends.
 */
const PROBE_THINKING_LEVEL = GEMINI_DEFAULT_THINKING_LEVEL;

const PROBE_MAX_OUTPUT_TOKENS = geminiSharedOutputBudget(PROBE_ANSWER_TOKENS, PROBE_THINKING_LEVEL);

function generationConfig(extra = {}, thinkingLevel = PROBE_THINKING_LEVEL) {
  return {
    maxOutputTokens: geminiSharedOutputBudget(PROBE_ANSWER_TOKENS, thinkingLevel),
    thinkingConfig: { thinkingLevel },
    ...extra,
  };
}

const SMOKE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
};

const SMOKE_TOOL = {
  name: 'report_status',
  description: 'Report the smoke-test status.',
  parameters: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
};

export function assertGeminiLiveOptIn(env) {
  if (env.GEMINI_LIVE_SMOKE !== '1' || env.AI_CHANNEL !== 'prod') {
    throw new Error(
      'Paid Gemini smoke is disabled. Set GEMINI_LIVE_SMOKE=1 and AI_CHANNEL=prod explicitly.',
    );
  }
}

function requireValue(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`Missing required live-smoke variable ${name}`);
  return value;
}

function uploadBase(base) {
  const url = new URL(base);
  url.pathname = `/upload${url.pathname}`;
  return url.toString().replace(/\/$/, '');
}

async function readJson(response) {
  const text = await response.text();
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: null, text };
  }
}

async function post(fetchImpl, url, key, payload, headers = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const { body, text } = await readJson(response);
  return { status: response.status, ok: response.ok, body, text, response };
}

function userText(text) {
  return [{ role: 'user', parts: [{ text }] }];
}

function requireOk(probe, result) {
  if (!result.ok) {
    throw new Error(
      `Gemini probe ${probe} failed (${result.status}): ${result.text.slice(0, 500)}`,
    );
  }
}

function firstCandidateParts(body) {
  const parts = body?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts : [];
}

function visibleText(body) {
  return firstCandidateParts(body)
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('');
}

/**
 * Thinking and the answer share one budget, so a turn can terminate having
 * produced only thoughts. That is a real provider outcome rather than a broken
 * contract, so a probe reports it as its own `starved` outcome — with the token
 * accounting that proves it — instead of failing the matrix.
 */
function starvedByThinking(body, hasVisibleResult) {
  if (body?.candidates?.[0]?.finishReason !== 'MAX_TOKENS' || hasVisibleResult) return null;
  return {
    outcome: 'starved',
    detail: {
      finishReason: 'MAX_TOKENS',
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      thoughtsTokenCount: body?.usageMetadata?.thoughtsTokenCount ?? null,
      candidatesTokenCount: body?.usageMetadata?.candidatesTokenCount ?? null,
    },
  };
}

async function probeAuthAndGenerate(context) {
  const result = await post(context.fetchImpl, context.generateUrl, context.key, {
    contents: userText('Reply with the single word ready.'),
    generationConfig: generationConfig(),
  });
  requireOk('auth-and-generate', result);
  const text = visibleText(result.body);
  const starved = starvedByThinking(result.body, text.length > 0);
  if (starved) return starved;
  if (text.length === 0) {
    throw new Error('Gemini probe auth-and-generate returned no visible assistant text');
  }
  if (!Number.isSafeInteger(result.body?.usageMetadata?.promptTokenCount)) {
    throw new Error('Gemini probe auth-and-generate returned no usageMetadata.promptTokenCount');
  }
  return {
    outcome: 'accepted',
    detail: {
      finishReason: result.body?.candidates?.[0]?.finishReason ?? null,
      modelVersion: result.body?.modelVersion ?? null,
      usageMetadata: result.body?.usageMetadata ?? null,
    },
  };
}

async function probeStructuredOutputFlat(context) {
  const result = await post(context.fetchImpl, context.generateUrl, context.key, {
    contents: userText('Return the smoke object.'),
    generationConfig: generationConfig({
      responseMimeType: 'application/json',
      responseSchema: SMOKE_SCHEMA,
    }),
  });
  requireOk('structured-output-flat', result);
  const text = visibleText(result.body);
  const starved = starvedByThinking(result.body, text.length > 0);
  if (starved) return starved;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini probe structured-output-flat returned non-JSON text: ${text}`);
  }
  if (typeof parsed?.ok !== 'boolean') {
    throw new Error('Gemini probe structured-output-flat did not honour the response schema');
  }
  return { outcome: 'accepted', detail: { parsed } };
}

async function probeStructuredOutputNested(context) {
  const result = await post(context.fetchImpl, context.generateUrl, context.key, {
    contents: userText('Return the smoke object.'),
    generationConfig: generationConfig({
      responseFormat: { text: { mimeType: 'application/json', schema: SMOKE_SCHEMA } },
    }),
  });
  return {
    outcome: result.ok ? 'accepted' : 'rejected',
    detail: { status: result.status, body: result.ok ? null : result.text.slice(0, 500) },
  };
}

async function probeInlineDataSnakeCase(context) {
  const result = await post(context.fetchImpl, context.generateUrl, context.key, {
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Name one colour in this image.' },
          { inline_data: { mime_type: 'image/png', data: ONE_PIXEL_PNG_BASE64 } },
        ],
      },
    ],
    generationConfig: generationConfig(),
  });
  return {
    outcome: result.ok ? 'accepted' : 'rejected',
    detail: { status: result.status, body: result.ok ? null : result.text.slice(0, 500) },
  };
}

async function probeThoughtSignature(context) {
  const result = await post(context.fetchImpl, context.generateUrl, context.key, {
    contents: userText('Call report_status with ok set to true.'),
    tools: [{ functionDeclarations: [SMOKE_TOOL] }],
    toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    generationConfig: generationConfig(),
  });
  requireOk('thought-signature', result);
  const callPart = firstCandidateParts(result.body).find((part) => part.functionCall);
  const starved = starvedByThinking(result.body, Boolean(callPart));
  if (starved) return starved;
  if (!callPart) {
    throw new Error('Gemini probe thought-signature returned no functionCall part');
  }
  if (typeof callPart.functionCall.id !== 'string' || callPart.functionCall.id.length === 0) {
    throw new Error('Gemini probe thought-signature returned a functionCall without an id');
  }
  if (typeof callPart.thoughtSignature !== 'string' || callPart.thoughtSignature.length === 0) {
    throw new Error(
      'Gemini probe thought-signature returned a first functionCall part with no thoughtSignature',
    );
  }
  return {
    outcome: 'accepted',
    detail: {
      finishReason: result.body?.candidates?.[0]?.finishReason ?? null,
      functionCallId: callPart.functionCall.id,
      signatureLength: callPart.thoughtSignature.length,
    },
  };
}

async function probeStreamFraming(context) {
  const response = await context.fetchImpl(context.streamUrl, {
    method: 'POST',
    headers: { 'x-goog-api-key': context.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: userText('Count from one to five.'),
      generationConfig: generationConfig(),
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Gemini probe stream-framing failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  const frames = raw
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame.length > 0);
  const dataFrames = frames.filter((frame) => frame.startsWith('data:'));
  const payloads = dataFrames.map((frame) => frame.slice(frame.indexOf(':') + 1).trim());
  const terminalSentinel = payloads.includes('[DONE]');
  const chunks = payloads
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => {
      try {
        return JSON.parse(payload);
      } catch {
        throw new Error(`Gemini probe stream-framing produced an unparsable frame: ${payload}`);
      }
    });
  const finishIndex = chunks.findIndex((chunk) => chunk?.candidates?.[0]?.finishReason);
  if (finishIndex === -1) {
    throw new Error('Gemini probe stream-framing closed without any finishReason');
  }
  const usageIndexes = chunks.flatMap((chunk, index) => (chunk?.usageMetadata ? [index] : []));
  return {
    outcome: 'accepted',
    detail: {
      frameCount: chunks.length,
      nonDataFrames: frames.length - dataFrames.length,
      terminalSentinel,
      finishIndex,
      usageIndexes,
      responseIdStable: new Set(chunks.map((chunk) => chunk?.responseId)).size === 1,
    },
  };
}

async function probeCountTokensWrapper(context) {
  const result = await post(context.fetchImpl, context.countTokensUrl, context.key, {
    generateContentRequest: {
      model: `models/${context.model}`,
      contents: userText('Count these tokens.'),
      systemInstruction: { parts: [{ text: 'You are a probe.' }] },
      generationConfig: generationConfig(),
    },
  });
  requireOk('count-tokens-wrapper', result);
  if (!Number.isSafeInteger(result.body?.totalTokens)) {
    throw new Error('Gemini probe count-tokens-wrapper returned no integer totalTokens');
  }
  return { outcome: 'accepted', detail: { totalTokens: result.body.totalTokens } };
}

async function probeErrorEnvelope(context) {
  const result = await post(context.fetchImpl, context.generateUrl, context.key, {
    contents: 'this is not a contents array',
  });
  if (result.ok) {
    throw new Error('Gemini probe error-envelope was accepted; it must be rejected');
  }
  const error = result.body?.error ?? null;
  return {
    outcome: 'rejected',
    detail: {
      status: result.status,
      codeType: error === null ? null : typeof error.code,
      code: error?.code ?? null,
      statusField: error?.status ?? null,
      hasDetails: Array.isArray(error?.details),
    },
  };
}

async function probeUploadProtocolMultipart(context) {
  const response = await context.fetchImpl(`${context.uploadBase}/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': context.key,
      'X-Goog-Upload-Protocol': 'multipart',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'app-ai-probe.png' } }),
  });
  const { text } = await readJson(response);
  return {
    outcome: response.ok ? 'accepted' : 'rejected',
    detail: { status: response.status, body: text.slice(0, 500) },
  };
}

async function probeModelsCatalog(context) {
  const response = await context.fetchImpl(`${context.base}/models`, {
    headers: { 'x-goog-api-key': context.key },
  });
  const { body, text } = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `Gemini probe models-catalog failed (${response.status}): ${text.slice(0, 500)}`,
    );
  }
  const models = Array.isArray(body?.models) ? body.models : [];
  const generateContentModels = models
    .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((model) => ({
      name: model.name,
      inputTokenLimit: model.inputTokenLimit ?? null,
      outputTokenLimit: model.outputTokenLimit ?? null,
    }));
  if (generateContentModels.length === 0) {
    throw new Error('Gemini probe models-catalog advertised no generateContent model');
  }
  // The catalog is the authority on which ids this API surface actually serves,
  // so a smoke model that is merely well-formed fails here by name rather than
  // as a 404 inside every later probe. A requested id may be an ALIAS the
  // catalog publishes as a dated or numbered snapshot, so that resolves too —
  // while a word-suffixed id is a DIFFERENT model (`gemini-3.5-flash` is not
  // `gemini-3.5-flash-lite`) and does not.
  const served = generateContentModels.find((entry) =>
    resolvesToRequestedModel(entry.name, `models/${context.model}`),
  );
  if (!served) {
    throw new Error(
      `Gemini probe models-catalog does not serve ${context.model} for generateContent`,
    );
  }
  return {
    outcome: 'accepted',
    detail: { model: context.model, servedAs: served.name, generateContentModels },
  };
}

/**
 * Every probe declares `thinkingConfig.thinkingLevel`, because a budget split
 * between thinking and the answer is only knowable when the level is declared.
 * This one declares the cheapest level on the ladder and records that the field
 * is accepted there too, with how much of the shared budget thinking consumed.
 */
async function probeThinkingLevelBudget(context) {
  const result = await post(context.fetchImpl, context.generateUrl, context.key, {
    contents: userText('Reply with the single word ready.'),
    generationConfig: generationConfig({}, 'low'),
  });
  return {
    outcome: result.ok ? 'accepted' : 'rejected',
    detail: {
      status: result.status,
      finishReason: result.body?.candidates?.[0]?.finishReason ?? null,
      visibleTextLength: result.ok ? visibleText(result.body).length : null,
      thoughtsTokenCount: result.body?.usageMetadata?.thoughtsTokenCount ?? null,
      body: result.ok ? null : result.text.slice(0, 500),
    },
  };
}

// The catalog probe runs first: it is the one that proves the configured smoke
// model is served at all, and it costs no inference.
const PROBES = [
  { id: 'models-catalog', required: true, run: probeModelsCatalog },
  { id: 'auth-and-generate', required: true, run: probeAuthAndGenerate },
  { id: 'structured-output-flat', required: true, run: probeStructuredOutputFlat },
  { id: 'thought-signature', required: true, run: probeThoughtSignature },
  { id: 'stream-framing', required: true, run: probeStreamFraming },
  { id: 'count-tokens-wrapper', required: true, run: probeCountTokensWrapper },
  { id: 'thinking-level-budget', required: false, run: probeThinkingLevelBudget },
  { id: 'structured-output-nested', required: false, run: probeStructuredOutputNested },
  { id: 'inline-data-snake-case', required: false, run: probeInlineDataSnakeCase },
  { id: 'error-envelope', required: false, run: probeErrorEnvelope },
  { id: 'upload-protocol-multipart', required: false, run: probeUploadProtocolMultipart },
];

export async function runGeminiSmoke(env = process.env, fetchImpl = fetch) {
  assertGeminiLiveOptIn(env);
  const base = requireValue(env, 'GEMINI_API_BASE').replace(/\/$/, '');
  const key = requireValue(env, 'GEMINI_API_KEY');
  const model = requireValue(env, 'GEMINI_SMOKE_MODEL');
  // The family prefix the adapter serves. It is a shape rule, not an inventory:
  // whether this API surface actually serves the id is what the models-catalog
  // probe answers, from the catalog itself, before any inference is paid for.
  if (!model.startsWith('gemini-3')) {
    throw new Error(`Unsupported Gemini smoke model ${model}`);
  }
  const context = {
    fetchImpl,
    base,
    key,
    model,
    uploadBase: uploadBase(base),
    generateUrl: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    streamUrl: `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    countTokensUrl: `${base}/models/${encodeURIComponent(model)}:countTokens`,
  };

  const results = [];
  for (const probe of PROBES) {
    const started = Date.now();
    if (probe.required) {
      const { outcome, detail } = await probe.run(context);
      results.push({
        probe: probe.id,
        required: true,
        outcome,
        detail,
        latencyMs: Date.now() - started,
      });
      continue;
    }
    let outcome = 'errored';
    let detail = null;
    try {
      ({ outcome, detail } = await probe.run(context));
    } catch (error) {
      detail = { message: error instanceof Error ? error.message : String(error) };
    }
    results.push({
      probe: probe.id,
      required: false,
      outcome,
      detail,
      latencyMs: Date.now() - started,
    });
  }
  return results;
}

async function main() {
  const results = await runGeminiSmoke();
  for (const result of results) {
    console.log(
      `${result.probe} [${result.required ? 'required' : 'exploratory'}]: ${result.outcome} (${result.latencyMs}ms)`,
    );
    console.log(`  ${JSON.stringify(result.detail)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
