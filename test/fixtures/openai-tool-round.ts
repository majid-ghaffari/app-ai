/**
 * Two genuine OpenAI Responses streams for one server-tool round, with the two requests app-ai sent:
 * the first answered with a tool call, the second answered after app-ai replayed that call untouched
 * with its output. Response, item and call identifiers are replaced by numbered placeholders; neither
 * stream carried encrypted reasoning or an account identifier to redact.
 */
export const OPENAI_TOOL_ROUND_CAPTURE = {
  capturedAt: '2026-10-11T01:34:02Z',
  endpoint: 'POST https://api.openai.com/v1/responses, streamed',
  model: 'gpt-5.6-luna',
  request: {
    model: 'gpt-5.6-luna',
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You look up records with the lookup tool, then answer in one short sentence.',
            prompt_cache_breakpoint: {
              mode: 'explicit',
            },
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Look up record 42.',
            prompt_cache_breakpoint: {
              mode: 'explicit',
            },
          },
        ],
      },
    ],
    max_output_tokens: 1200,
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'app-ai:setup-strategy:gpt',
    prompt_cache_options: {
      mode: 'explicit',
      ttl: '30m',
    },
    reasoning: {
      effort: 'low',
    },
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a record',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    stream: true,
  },
  toolCallTurn:
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_redacted1","object":"response","created_at":1791682440,"status":"in_progress","access_programs":null,"background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":1200,"max_tool_calls":null,"model":"gpt-5.6-luna","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"app-ai:setup-strategy:gpt","prompt_cache_options":{"mode":"explicit","ttl":"30m"},"prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"low","mode":"standard","summary":null},"safety_identifier":null,"service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[{"type":"function","description":"Look up a record","name":"lookup","output_schema":null,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":0}\n\nevent: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_redacted1","object":"response","created_at":1791682440,"status":"in_progress","access_programs":null,"background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":1200,"max_tool_calls":null,"model":"gpt-5.6-luna","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"app-ai:setup-strategy:gpt","prompt_cache_options":{"mode":"explicit","ttl":"30m"},"prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"low","mode":"standard","summary":null},"safety_identifier":null,"service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[{"type":"function","description":"Look up a record","name":"lookup","output_schema":null,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":1}\n\nevent: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_redacted1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_redacted1","name":"lookup"},"output_index":0,"sequence_number":2}\n\nevent: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"","item_id":"fc_redacted1","obfuscation":"mTGjYTQrstVivJ","output_index":0,"sequence_number":3}\n\nevent: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"id","item_id":"fc_redacted1","obfuscation":"VkY7BwpA7etOUf","output_index":0,"sequence_number":4}\n\nevent: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"\\":\\"","item_id":"fc_redacted1","obfuscation":"ZVn0Pglg1vChD","output_index":0,"sequence_number":5}\n\nevent: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"42","item_id":"fc_redacted1","obfuscation":"MfosTHQby0ut2w","output_index":0,"sequence_number":6}\n\nevent: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"\\"}","item_id":"fc_redacted1","obfuscation":"dLbb75HyghbgeQ","output_index":0,"sequence_number":7}\n\nevent: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","arguments":"{\\"id\\":\\"42\\"}","item_id":"fc_redacted1","output_index":0,"sequence_number":8}\n\nevent: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"fc_redacted1","type":"function_call","status":"completed","arguments":"{\\"id\\":\\"42\\"}","call_id":"call_redacted1","name":"lookup"},"output_index":0,"sequence_number":9}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_redacted1","object":"response","created_at":1791682440,"status":"completed","access_programs":null,"background":false,"completed_at":1791682442,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":1200,"max_tool_calls":null,"model":"gpt-5.6-luna","moderation":null,"output":[{"id":"fc_redacted1","type":"function_call","status":"completed","arguments":"{\\"id\\":\\"42\\"}","call_id":"call_redacted1","name":"lookup"}],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"app-ai:setup-strategy:gpt","prompt_cache_options":{"mode":"explicit","ttl":"30m"},"prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"low","mode":"standard","summary":null},"safety_identifier":null,"service_tier":"default","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[{"type":"function","description":"Look up a record","name":"lookup","output_schema":null,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":{"input_tokens":66,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":0},"output_tokens":17,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":83},"user":null,"metadata":{}},"sequence_number":10}\n\n',
  replayRequest: {
    model: 'gpt-5.6-luna',
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'You look up records with the lookup tool, then answer in one short sentence.',
            prompt_cache_breakpoint: {
              mode: 'explicit',
            },
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Look up record 42.',
          },
        ],
      },
      {
        id: 'fc_redacted1',
        type: 'function_call',
        status: 'completed',
        arguments: '{"id":"42"}',
        call_id: 'call_redacted1',
        name: 'lookup',
      },
      {
        type: 'function_call_output',
        call_id: 'call_redacted1',
        output: [
          {
            type: 'input_text',
            text: 'record 42: a blue mug',
            prompt_cache_breakpoint: {
              mode: 'explicit',
            },
          },
        ],
      },
    ],
    max_output_tokens: 1200,
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'app-ai:setup-strategy:gpt',
    prompt_cache_options: {
      mode: 'explicit',
      ttl: '30m',
    },
    reasoning: {
      effort: 'low',
    },
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a record',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
            },
          },
          required: ['id'],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    stream: true,
  },
  answerTurn:
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_redacted2","object":"response","created_at":1791682505,"status":"in_progress","access_programs":null,"background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":1200,"max_tool_calls":null,"model":"gpt-5.6-luna","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"app-ai:setup-strategy:gpt","prompt_cache_options":{"mode":"explicit","ttl":"30m"},"prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"low","mode":"standard","summary":null},"safety_identifier":null,"service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[{"type":"function","description":"Look up a record","name":"lookup","output_schema":null,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":0}\n\nevent: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_redacted2","object":"response","created_at":1791682505,"status":"in_progress","access_programs":null,"background":false,"completed_at":null,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":1200,"max_tool_calls":null,"model":"gpt-5.6-luna","moderation":null,"output":[],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"app-ai:setup-strategy:gpt","prompt_cache_options":{"mode":"explicit","ttl":"30m"},"prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"low","mode":"standard","summary":null},"safety_identifier":null,"service_tier":"auto","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[{"type":"function","description":"Look up a record","name":"lookup","output_schema":null,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":null,"user":null,"metadata":{}},"sequence_number":1}\n\nevent: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_redacted1","type":"message","status":"in_progress","content":[],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":2}\n\nevent: response.content_part.added\ndata: {"type":"response.content_part.added","content_index":0,"item_id":"msg_redacted1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":""},"sequence_number":3}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":"Record","item_id":"msg_redacted1","logprobs":[],"obfuscation":"mw3qnJUTW1","output_index":0,"sequence_number":4}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":" ","item_id":"msg_redacted1","logprobs":[],"obfuscation":"VEubzVQFgmsDcTM","output_index":0,"sequence_number":5}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":"42","item_id":"msg_redacted1","logprobs":[],"obfuscation":"KSR6JxllzHRwmG","output_index":0,"sequence_number":6}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":" is","item_id":"msg_redacted1","logprobs":[],"obfuscation":"m4kfekHGwos9P","output_index":0,"sequence_number":7}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":" a","item_id":"msg_redacted1","logprobs":[],"obfuscation":"XDdtmztSZyel21","output_index":0,"sequence_number":8}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":" blue","item_id":"msg_redacted1","logprobs":[],"obfuscation":"VgTAXGalthv","output_index":0,"sequence_number":9}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":" mug","item_id":"msg_redacted1","logprobs":[],"obfuscation":"8bzpq6z4JWQT","output_index":0,"sequence_number":10}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","content_index":0,"delta":".","item_id":"msg_redacted1","logprobs":[],"obfuscation":"jd4e5rvFbJYmbHm","output_index":0,"sequence_number":11}\n\nevent: response.output_text.done\ndata: {"type":"response.output_text.done","content_index":0,"item_id":"msg_redacted1","logprobs":[],"output_index":0,"sequence_number":12,"text":"Record 42 is a blue mug."}\n\nevent: response.content_part.done\ndata: {"type":"response.content_part.done","content_index":0,"item_id":"msg_redacted1","output_index":0,"part":{"type":"output_text","annotations":[],"logprobs":[],"text":"Record 42 is a blue mug."},"sequence_number":13}\n\nevent: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"msg_redacted1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"Record 42 is a blue mug."}],"phase":"final_answer","role":"assistant"},"output_index":0,"sequence_number":14}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_redacted2","object":"response","created_at":1791682505,"status":"completed","access_programs":null,"background":false,"completed_at":1791682506,"error":null,"frequency_penalty":0.0,"incomplete_details":null,"instructions":null,"max_output_tokens":1200,"max_tool_calls":null,"model":"gpt-5.6-luna","moderation":null,"output":[{"id":"msg_redacted1","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"Record 42 is a blue mug."}],"phase":"final_answer","role":"assistant"}],"parallel_tool_calls":true,"presence_penalty":0.0,"previous_response_id":null,"prompt_cache_key":"app-ai:setup-strategy:gpt","prompt_cache_options":{"mode":"explicit","ttl":"30m"},"prompt_cache_retention":"24h","reasoning":{"context":"all_turns","effort":"low","mode":"standard","summary":null},"safety_identifier":null,"service_tier":"default","store":false,"temperature":1.0,"text":{"format":{"type":"text"},"verbosity":"medium"},"tool_choice":"auto","tool_usage":{"image_gen":{"input_tokens":0,"input_tokens_details":{"image_tokens":0,"text_tokens":0},"output_tokens":0,"output_tokens_details":{"image_tokens":0,"text_tokens":0},"total_tokens":0},"web_search":{"num_requests":0}},"tools":[{"type":"function","description":"Look up a record","name":"lookup","output_schema":null,"parameters":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false},"strict":true}],"top_logprobs":0,"top_p":0.98,"truncation":"disabled","usage":{"input_tokens":100,"input_tokens_details":{"cache_write_tokens":0,"cached_tokens":0},"output_tokens":12,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":112},"user":null,"metadata":{}},"sequence_number":15}\n\n',
} as const;
