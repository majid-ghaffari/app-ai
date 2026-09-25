import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SUBSCRIPTION_MODELS = new Set([
  'k3',
  'k3-256k',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
]);

const SMOKE_TOOL = {
  type: 'function',
  function: {
    name: 'report_status',
    description: 'Report the smoke-test status.',
    parameters: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
};

export function assertKimiLiveOptIn(env) {
  if (env.KIMI_LIVE_SMOKE !== '1' || env.AI_CHANNEL !== 'prod') {
    throw new Error(
      'Paid Kimi Code smoke is disabled. Set KIMI_LIVE_SMOKE=1 and AI_CHANNEL=prod explicitly.',
    );
  }
}

function requireValue(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`Missing required live-smoke variable ${name}`);
  return value;
}

function reasoningControl(model) {
  if (model !== 'kimi-for-coding-highspeed') return { reasoning_effort: 'low' };
  return { thinking: { type: 'enabled', keep: 'all' } };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return { body: JSON.parse(text), text };
  } catch {
    return { body: null, text };
  }
}

async function post(fetchImpl, url, key, payload) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const { body, text } = await readJson(response);
  return { status: response.status, ok: response.ok, body, text };
}

function requireOk(probe, result) {
  if (!result.ok) {
    throw new Error(`Kimi probe ${probe} failed (${result.status}): ${result.text.slice(0, 500)}`);
  }
}

function baseMessages(instruction) {
  return [
    { role: 'system', content: 'Return the requested smoke-test result and no extra text.' },
    { role: 'user', content: instruction },
  ];
}

async function probeAuthAndChat(context) {
  const result = await post(context.fetchImpl, context.chatUrl, context.key, {
    model: context.model,
    messages: baseMessages('Confirm the adapter contract.'),
    ...reasoningControl(context.model),
    max_completion_tokens: 2048,
  });
  requireOk('auth-and-chat', result);
  const choice = result.body?.choices?.[0];
  if (result.body?.object !== 'chat.completion' || result.body?.model !== context.model) {
    throw new Error('Kimi probe auth-and-chat returned an unexpected completion envelope');
  }
  if (choice?.finish_reason !== 'stop') {
    throw new Error(`Kimi probe auth-and-chat finished as ${choice?.finish_reason}`);
  }
  const usage = result.body?.usage;
  if (
    !Number.isSafeInteger(usage?.prompt_tokens) ||
    !Number.isSafeInteger(usage?.completion_tokens) ||
    usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens
  ) {
    throw new Error('Kimi probe auth-and-chat returned invalid usage');
  }
  return {
    outcome: 'accepted',
    detail: {
      hasReasoningContent: typeof choice?.message?.reasoning_content === 'string',
      usage,
    },
  };
}

async function probeStructuredOutputStrict(context) {
  const result = await post(context.fetchImpl, context.chatUrl, context.key, {
    model: context.model,
    messages: baseMessages('Return the smoke object.'),
    ...reasoningControl(context.model),
    max_completion_tokens: 2048,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'app_ai_kimi_smoke',
        strict: true,
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean', enum: [true] } },
          required: ['ok'],
          additionalProperties: false,
        },
      },
    },
  });
  requireOk('structured-output-strict', result);
  let parsed;
  try {
    parsed = JSON.parse(result.body?.choices?.[0]?.message?.content);
  } catch {
    throw new Error('Kimi probe structured-output-strict returned non-JSON content');
  }
  if (parsed?.ok !== true || Object.keys(parsed).length !== 1) {
    throw new Error('Kimi probe structured-output-strict did not honour the schema');
  }
  return { outcome: 'accepted', detail: { parsed } };
}

async function probeStreamDoneSentinel(context) {
  const response = await context.fetchImpl(context.chatUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: context.model,
      messages: baseMessages('Count from one to five.'),
      ...reasoningControl(context.model),
      max_completion_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Kimi probe stream-done-sentinel failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  const payloads = streamPayloads(raw);
  if (!payloads.includes('[DONE]')) {
    throw new Error('Kimi probe stream-done-sentinel did not emit data: [DONE]');
  }
  const chunks = payloads
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload));
  const usageIndexes = chunks.flatMap((chunk, index) => (chunk?.usage ? [index] : []));
  const reasoningIndexes = chunks.flatMap((chunk, index) =>
    chunk?.choices?.[0]?.delta?.reasoning_content ? [index] : [],
  );
  const contentIndexes = chunks.flatMap((chunk, index) =>
    chunk?.choices?.[0]?.delta?.content ? [index] : [],
  );
  return {
    outcome: 'accepted',
    detail: {
      frameCount: chunks.length,
      usageIndexes,
      reasoningPrecedesContent:
        reasoningIndexes.length === 0 ||
        contentIndexes.length === 0 ||
        Math.max(...reasoningIndexes) < Math.min(...contentIndexes),
    },
  };
}

function streamPayloads(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => frame.slice(frame.indexOf(':') + 1).trim());
}

async function probeStreamedToolCall(context) {
  const response = await context.fetchImpl(context.chatUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: context.model,
      messages: baseMessages('Call report_status with ok set to true.'),
      tools: [SMOKE_TOOL],
      tool_choice: context.model.startsWith('k3') ? 'required' : 'auto',
      ...reasoningControl(context.model),
      max_completion_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Kimi probe streamed-tool-call failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }
  const payloads = streamPayloads(raw);
  if (!payloads.includes('[DONE]')) {
    throw new Error('Kimi probe streamed-tool-call did not emit data: [DONE]');
  }
  const chunks = payloads
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload));
  const calls = new Map();
  let finishReason = null;
  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    for (const delta of choice?.delta?.tool_calls ?? []) {
      const index = delta.index;
      const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof delta.id === 'string') current.id = delta.id;
      if (typeof delta.function?.name === 'string') current.name = delta.function.name;
      if (typeof delta.function?.arguments === 'string') {
        current.arguments += delta.function.arguments;
      }
      calls.set(index, current);
    }
  }
  const call = calls.get(0);
  let input = null;
  try {
    input = JSON.parse(call?.arguments ?? '');
  } catch {
    throw new Error('Kimi probe streamed-tool-call returned invalid tool JSON');
  }
  if (
    finishReason !== 'tool_calls' ||
    calls.size !== 1 ||
    typeof call?.id !== 'string' ||
    call.id.length === 0 ||
    call.name !== 'report_status' ||
    input?.ok !== true
  ) {
    throw new Error('Kimi probe streamed-tool-call returned an invalid tool call');
  }
  return {
    outcome: 'accepted',
    detail: { frameCount: chunks.length, finishReason, toolName: call.name, input },
  };
}

async function probeInlineImage(context) {
  const result = await post(context.fetchImpl, context.chatUrl, context.key, {
    model: context.model,
    messages: [
      { role: 'system', content: 'Describe the image in one word.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What colour is this?' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}` },
          },
        ],
      },
    ],
    ...reasoningControl(context.model),
    max_completion_tokens: 2048,
  });
  return {
    outcome: result.ok ? 'accepted' : 'rejected',
    detail: { status: result.status, body: result.ok ? null : result.text.slice(0, 500) },
  };
}

async function probeFilesApi(context) {
  const form = new FormData();
  const bytes = Uint8Array.from(atob(ONE_PIXEL_PNG_BASE64), (character) => character.charCodeAt(0));
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'probe.png');
  form.append('purpose', 'image');
  const response = await context.fetchImpl(context.filesUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.key}` },
    body: form,
  });
  const { body, text } = await readJson(response);
  let imageReferenceStatus = null;
  let imageReferenceFinishReason = null;
  let deleteStatus = null;
  if (response.ok && typeof body?.id === 'string') {
    const referenced = await post(context.fetchImpl, context.chatUrl, context.key, {
      model: context.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Confirm that you can see the attached image. Reply OK.' },
            { type: 'image_url', image_url: { url: `ms://${body.id}` } },
          ],
        },
      ],
      ...reasoningControl(context.model),
      max_completion_tokens: 2048,
    });
    imageReferenceStatus = referenced.status;
    imageReferenceFinishReason = referenced.body?.choices?.[0]?.finish_reason ?? null;
    const deleted = await context.fetchImpl(`${context.filesUrl}/${encodeURIComponent(body.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${context.key}` },
    });
    deleteStatus = deleted.status;
  }
  return {
    outcome:
      response.ok && imageReferenceStatus === 200 && imageReferenceFinishReason === 'stop'
        ? 'accepted'
        : 'rejected',
    detail: {
      status: response.status,
      idPresent: typeof body?.id === 'string',
      imageReferenceStatus,
      imageReferenceFinishReason,
      deleteStatus,
      body: response.ok ? null : text.slice(0, 500),
    },
  };
}

async function probeReasoningToolReplay(context) {
  const messages = baseMessages('Call report_status with ok set to true.');
  const first = await post(context.fetchImpl, context.chatUrl, context.key, {
    model: context.model,
    messages,
    tools: [SMOKE_TOOL],
    tool_choice: context.model.startsWith('k3') ? 'required' : 'auto',
    ...reasoningControl(context.model),
    max_completion_tokens: 2048,
  });
  requireOk('reasoning-tool-replay', first);
  const firstChoice = first.body?.choices?.[0];
  const assistant = first.body?.choices?.[0]?.message;
  const calls = assistant?.tool_calls;
  const call = calls?.[0];
  let input = null;
  try {
    input = JSON.parse(call?.function?.arguments ?? '');
  } catch {
    throw new Error('Kimi probe reasoning-tool-replay returned invalid tool JSON');
  }
  if (
    firstChoice?.finish_reason !== 'tool_calls' ||
    typeof assistant?.reasoning_content !== 'string' ||
    assistant.reasoning_content.length === 0 ||
    !Array.isArray(calls) ||
    calls.length !== 1 ||
    typeof call?.id !== 'string' ||
    call?.function?.name !== 'report_status' ||
    input?.ok !== true
  ) {
    throw new Error('Kimi probe reasoning-tool-replay returned an invalid first tool turn');
  }
  const replayedAssistant = {
    role: 'assistant',
    content: assistant.content ?? '',
    reasoning_content: assistant.reasoning_content,
    tool_calls: calls,
  };
  const second = await post(context.fetchImpl, context.chatUrl, context.key, {
    model: context.model,
    messages: [
      ...messages,
      replayedAssistant,
      { role: 'tool', tool_call_id: call.id, content: 'ok' },
    ],
    tools: [SMOKE_TOOL],
    ...reasoningControl(context.model),
    max_completion_tokens: 2048,
  });
  requireOk('reasoning-tool-replay', second);
  const secondFinishReason = second.body?.choices?.[0]?.finish_reason;
  if (secondFinishReason !== 'stop') {
    throw new Error(
      `Kimi probe reasoning-tool-replay final turn finished as ${secondFinishReason}`,
    );
  }
  return {
    outcome: 'accepted',
    detail: {
      firstFinishReason: firstChoice.finish_reason,
      secondFinishReason,
      reasoningLength: assistant.reasoning_content.length,
    },
  };
}

async function probeReasoningReplayWithoutContent(context) {
  const result = await post(context.fetchImpl, context.chatUrl, context.key, {
    model: context.model,
    messages: [
      { role: 'system', content: 'Use the tool, then answer.' },
      { role: 'user', content: 'Report the status.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'probe_call_1',
            type: 'function',
            function: { name: 'report_status', arguments: '{"ok":true}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'probe_call_1', content: 'ok' },
    ],
    tools: [SMOKE_TOOL],
    ...reasoningControl(context.model),
    max_completion_tokens: 2048,
  });
  return {
    outcome: result.ok ? 'accepted' : 'rejected',
    detail: {
      status: result.status,
      body: result.ok ? null : result.text.slice(0, 500),
    },
  };
}

async function probeErrorEnvelope(context) {
  const result = await post(context.fetchImpl, context.chatUrl, context.key, {
    model: context.model,
    messages: 'this is not a messages array',
  });
  if (result.ok) {
    throw new Error('Kimi probe error-envelope was accepted; it must be rejected');
  }
  const error = result.body?.error ?? null;
  return {
    outcome: 'rejected',
    detail: {
      status: result.status,
      shape: error === null ? Object.keys(result.body ?? {}) : Object.keys(error),
      type: error?.type ?? null,
      code: error?.code ?? null,
    },
  };
}

const PROBES = [
  { id: 'auth-and-chat', required: true, run: probeAuthAndChat },
  { id: 'structured-output-strict', required: true, run: probeStructuredOutputStrict },
  { id: 'stream-done-sentinel', required: true, run: probeStreamDoneSentinel },
  { id: 'streamed-tool-call', required: true, run: probeStreamedToolCall },
  { id: 'inline-image', required: false, run: probeInlineImage },
  { id: 'files-api', required: true, run: probeFilesApi },
  { id: 'reasoning-tool-replay', required: true, run: probeReasoningToolReplay },
  {
    id: 'reasoning-replay-without-content',
    required: false,
    run: probeReasoningReplayWithoutContent,
  },
  { id: 'error-envelope', required: false, run: probeErrorEnvelope },
];

export async function runKimiSmoke(env = process.env, fetchImpl = fetch) {
  assertKimiLiveOptIn(env);
  const base = requireValue(env, 'KIMI_API_BASE').replace(/\/$/, '');
  const key = requireValue(env, 'KIMI_API_KEY');
  const model = requireValue(env, 'KIMI_SMOKE_MODEL');
  if (!SUBSCRIPTION_MODELS.has(model)) {
    throw new Error(`Unsupported Kimi smoke model ${model}`);
  }
  const context = {
    fetchImpl,
    key,
    model,
    chatUrl: `${base}/v1/chat/completions`,
    filesUrl: `${base}/v1/files`,
  };

  const results = [];
  for (const probe of PROBES) {
    const started = Date.now();
    if (probe.required) {
      const { outcome, detail } = await probe.run(context);
      if (outcome !== 'accepted') {
        throw new Error(`Kimi probe ${probe.id} was ${outcome}: ${JSON.stringify(detail)}`);
      }
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
  const results = await runKimiSmoke();
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
