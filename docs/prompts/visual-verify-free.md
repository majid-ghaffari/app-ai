# Protected visual verification

`visual-verify-free` is the protected live-store CI judge. It reuses the production
`visual-verify` system prompt while owning a separate `free-render-verification` group, so its
model resolves to Cloudflare Workers AI without moving the customer-facing route off Anthropic.

## Runtime and access

- Model: `@cf/qwen/qwen3.8-27b` through the Workers AI binding.
- Output budget: at most 1024 tokens.
- Tools, provider files, continuation, streaming, and reasoning controls: none.
- Authorization: a validated Brain response with `CanAdministerAllSubscribers: true`.
- Routing: the request path fails closed unless the prompt resolves to exact model
  `@cf/qwen/qwen3.8-27b` through `cloudflare/cloudflare-workers-ai`.
- Quota: a separately addressed `AuditSessionAuthority` instance admits at most
  `FREE_VISUAL_VERIFY_DAILY_LIMIT` valid binding calls per UTC day; configuration cannot exceed
  eight. `X-Personalizer-Visual-Quota-Class` is `diagnostic` or `acceptance`; an absent header is
  diagnostic. Diagnostics stop at the daily limit minus
  `FREE_VISUAL_VERIFY_ACCEPTANCE_RESERVE`, while acceptance requests may use the whole daily
  allowance. It derives the UTC date itself. Invalid JSON, invalid media, oversized evidence, bad
  routing, and missing bindings do not consume quota.
- Kill switch: `FREE_VISUAL_VERIFY_ENABLED` must remain enabled for inference.

The free-allocation invariant is enforced before quota reservation: system text is at most 6,400
UTF-8 bytes, evidence text is at most 8,192 UTF-8 bytes, the one PNG is at most 4,000,000 decoded
bytes and 1280×900 pixels, and output is at most 1,024 tokens. Conservatively treating every text
byte as a token, the image as one token per 28×28 patch, and request framing as another 1,024 tokens
bounds input below 17,134 tokens. At the configured model's published rates of 40,909 neurons per
million input tokens and 290,909 per million output tokens, one call remains below 999 neurons and
eight remain below 8,000 of the 10,000-neuron daily free allocation.

Brain's administrator proof deploys first. This worker deploys second and must return a valid
authenticated smoke verdict. Lib enables the protected endpoint only after those two gates pass.

## Input

The public request is `POST /messages` with
`X-Personalizer-System-Prompt: visual-verify-free`, a master Context-ID, and one user message. The
quota-class header states whether the request belongs to a focused diagnostic or a complete
acceptance pass. The message content contains exactly one inline base64 PNG block and one text block within the limits
above. The image is the rendered screenshot. The text carries the intent, cleaned HTML excerpt,
console lines, computed styles, target rectangle, and center-point hit test. Pixels are the primary
evidence; DOM presence alone is not proof that the target painted.

The raw body contains only `messages` and optional `max_tokens: 1024`; caller sampling, provider,
model, tool, continuation, metadata, and extra content fields are rejected before canonical parsing.
The one message has role `user`, with the PNG block first and text block second. PNG validation reads
exactly one leading IHDR through consecutive IDAT chunks and a CRC-valid terminal IEND, rejects
unknown critical chunks, validates the IHDR format, and incrementally decompresses into the exact
bounded scanline buffer. Excess output, invalid lengths, and invalid filters fail before quota is
reserved.

The internal authority request contract is documented in
[src/lib/CLAUDE.md](../../src/lib/CLAUDE.md).

The adapter converts that canonical request into Qwen's OpenAI-compatible multimodal shape:

```json
{
  "messages": [
    { "role": "system", "content": "visual-verify system prompt" },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "intent and inspection evidence" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
      ]
    }
  ],
  "max_tokens": 1024,
  "temperature": 0,
  "chat_template_kwargs": { "enable_thinking": false },
  "response_format": { "type": "json_object" }
}
```

## Frozen output

The assistant content is exactly one JSON object with no surrounding prose:

```json
{
  "pass": false,
  "reason": "The target is covered by an opaque overlay at its center point.",
  "fix": null
}
```

`pass` states whether the intent is true in the rendered pixels. `reason` cites the deciding visual
or inspection evidence. `fix` is either `null` or a concrete `{ "action": "...", "args": {} }`
instruction supported by the consumer. The public response remains the established messages
envelope with this JSON string in its assistant text block.

The adapter uses the binding's raw-response mode. Successful Qwen content comes from
`choices[0].message.content`; failed responses preserve Cloudflare's HTTP status and first provider
error code. The request's abort signal reaches the binding so a disconnected caller does not leave
inference running.
