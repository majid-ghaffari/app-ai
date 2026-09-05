/**
 * Explicitly paid OpenAI Responses smoke matrix.
 *
 * This script is never part of CI or default gates. It refuses to call the
 * provider unless both opt-ins are present, then runs the same structured,
 * reasoning-enabled request against every comma-separated candidate model.
 */

import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { resolvesToRequestedModel } from './provider-model-ids.mjs';

export function assertOpenAILiveOptIn(env) {
  if (env.OPENAI_LIVE_SMOKE !== '1' || env.AI_CHANNEL !== 'prod') {
    throw new Error(
      'Paid OpenAI smoke is disabled. Set OPENAI_LIVE_SMOKE=1 and AI_CHANNEL=prod explicitly.',
    );
  }
}

function requireValue(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`Missing required live-smoke variable ${name}`);
  return value;
}

export async function runOpenAISmoke(env = process.env, fetchImpl = fetch) {
  assertOpenAILiveOptIn(env);
  const base = requireValue(env, 'OPENAI_API_BASE').replace(/\/$/, '');
  const key = requireValue(env, 'OPENAI_API_KEY');
  const models = requireValue(env, 'OPENAI_SMOKE_MODELS')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) throw new Error('OPENAI_SMOKE_MODELS did not contain a model');

  const results = [];
  for (const model of models) {
    const started = Date.now();
    const response = await fetchImpl(`${base}/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        store: false,
        input: 'Return the requested smoke-test object and no additional text.',
        reasoning: { effort: 'low' },
        max_output_tokens: 256,
        text: {
          format: {
            type: 'json_schema',
            name: 'app_ai_openai_smoke',
            strict: true,
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean', const: true } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    const data = await response.json();
    if (
      !response.ok ||
      data?.object !== 'response' ||
      data?.status !== 'completed' ||
      !resolvesToRequestedModel(data?.model, model)
    ) {
      throw new Error(`OpenAI smoke failed for ${model}: ${JSON.stringify(data)}`);
    }
    const outputText = data.output
      ?.filter((item) => item?.type === 'message' && item.role === 'assistant')
      .flatMap((item) => item.content ?? [])
      .find((part) => part?.type === 'output_text')?.text;
    let structured;
    try {
      structured = JSON.parse(outputText);
    } catch {
      throw new Error(`OpenAI smoke returned invalid structured output for ${model}`);
    }
    if (
      !structured ||
      typeof structured !== 'object' ||
      structured.ok !== true ||
      Object.keys(structured).length !== 1
    ) {
      throw new Error(`OpenAI smoke returned invalid structured output for ${model}`);
    }
    if (
      !Number.isSafeInteger(data.usage?.input_tokens) ||
      data.usage.input_tokens < 0 ||
      !Number.isSafeInteger(data.usage?.output_tokens) ||
      data.usage.output_tokens < 0
    ) {
      throw new Error(`OpenAI smoke returned invalid usage for ${model}`);
    }
    results.push({
      model,
      resolvedModel: data.model,
      usage: data.usage,
      latencyMs: Date.now() - started,
    });
  }
  return results;
}

async function main() {
  const results = await runOpenAISmoke();
  for (const result of results) {
    console.log(
      `${result.model} -> ${result.resolvedModel}: completed (${result.latencyMs}ms, input=${result.usage?.input_tokens ?? '?'}, output=${result.usage?.output_tokens ?? '?'})`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
