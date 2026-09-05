import { fileURLToPath } from 'node:url';
import process from 'node:process';

export function assertMoonshotLiveOptIn(env) {
  if (env.MOONSHOT_LIVE_SMOKE !== '1' || env.AI_CHANNEL !== 'prod') {
    throw new Error(
      'Paid Moonshot smoke is disabled. Set MOONSHOT_LIVE_SMOKE=1 and AI_CHANNEL=prod explicitly.',
    );
  }
}

function requireValue(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`Missing required live-smoke variable ${name}`);
  return value;
}

function reasoningControl(model) {
  if (model === 'kimi-k3') return { reasoning_effort: 'low' };
  if (model === 'kimi-k2.6' || model === 'kimi-k2.7-code' || model === 'kimi-k2.7-code-highspeed') {
    return { thinking: { type: 'enabled', keep: 'all' } };
  }
  throw new Error(`Unsupported Moonshot smoke model ${model}`);
}

export async function runMoonshotSmoke(env = process.env, fetchImpl = fetch) {
  assertMoonshotLiveOptIn(env);
  const base = requireValue(env, 'MOONSHOT_API_BASE').replace(/\/$/, '');
  const key = requireValue(env, 'MOONSHOT_API_KEY');
  const models = requireValue(env, 'MOONSHOT_SMOKE_MODELS')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) throw new Error('MOONSHOT_SMOKE_MODELS did not contain a model');
  const controls = models.map((model) => reasoningControl(model));

  const results = [];
  for (const [index, model] of models.entries()) {
    const started = Date.now();
    const response = await fetchImpl(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Return the requested smoke-test object and no additional text.',
          },
          { role: 'user', content: 'Confirm the adapter contract.' },
        ],
        ...controls[index],
        max_completion_tokens: 256,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'app_ai_moonshot_smoke',
            strict: true,
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean', enum: [true] } },
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
      data?.object !== 'chat.completion' ||
      data?.model !== model ||
      data?.choices?.length !== 1 ||
      data.choices[0]?.finish_reason !== 'stop' ||
      typeof data.choices[0]?.message?.reasoning_content !== 'string'
    ) {
      throw new Error(`Moonshot smoke failed for ${model}: ${JSON.stringify(data)}`);
    }
    let structured;
    try {
      structured = JSON.parse(data.choices[0]?.message?.content);
    } catch {
      throw new Error(`Moonshot smoke returned invalid structured output for ${model}`);
    }
    if (
      !structured ||
      typeof structured !== 'object' ||
      structured.ok !== true ||
      Object.keys(structured).length !== 1
    ) {
      throw new Error(`Moonshot smoke returned invalid structured output for ${model}`);
    }
    if (
      !Number.isSafeInteger(data.usage?.prompt_tokens) ||
      data.usage.prompt_tokens < 0 ||
      !Number.isSafeInteger(data.usage?.completion_tokens) ||
      data.usage.completion_tokens < 0 ||
      data.usage.total_tokens !== data.usage.prompt_tokens + data.usage.completion_tokens
    ) {
      throw new Error(`Moonshot smoke returned invalid usage for ${model}`);
    }
    results.push({ model, usage: data.usage, latencyMs: Date.now() - started });
  }
  return results;
}

async function main() {
  const results = await runMoonshotSmoke();
  for (const result of results) {
    console.log(
      `${result.model}: completed (${result.latencyMs}ms, input=${result.usage?.prompt_tokens ?? '?'}, output=${result.usage?.completion_tokens ?? '?'})`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
