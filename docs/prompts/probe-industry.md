# Industry Probe — Maintenance Doc

The design/maintenance record for the `probe-industry` Website-Analysis probe. The runtime file it documents lives at [`src/prompts/probe-industry/prompt.md`](../../src/prompts/probe-industry/prompt.md) (system prompt), registered as `probe-industry` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts) with its frozen output schema recorded in `PROBE_SCHEMAS`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md).

## What a probe is

A **probe** is a named `POST /messages` system prompt for Website Analysis. It takes page evidence — a cleaned-HTML document + a screenshot image, uploaded via `POST /files` and referenced as content blocks on the first user message (the same muscle as `image-selection`) — and returns **JSON ONLY** per a fixed schema. No tools, no prose, no code fences. Probes are header-selected: the client sends `X-Personalizer-System-Prompt: probe-<id>`.

The convention: every probe registers under a `probe-<id>` name (`PROBE_PREFIX = 'probe-'`), ships its system text at `src/prompts/probe-<id>/prompt.md`, and documents its output contract in `PROBE_SCHEMAS[probe-<id>]`. Future probes (style, cart-wiring, …) drop in identically — a new prompt file, a new registry entry, a new `PROBE_SCHEMAS` entry, a maintenance doc here. No handler change is needed: `/messages` serves any header-selected prompt.

## `probe-industry`

- **Purpose:** Given a storefront HOMEPAGE screenshot + cleaned HTML, determine the merchant's industry / retail vertical and the evidence supporting it.
- **Model:** the `frontier` tier / default (currently `claude-opus-4-8`) — the classification benefits from the stronger model; not latency-critical like placement.
- **Tools:** none (one-shot JSON).
- **Attachments:** none. Unlike `image-selection`, the probe carries no bundled training sample — the caller uploads the page's HTML + screenshot per request.

### Frozen output contract

The assistant text is a single JSON object, exactly:

```json
{
  "industry": "string",
  "confidence": 0.0,
  "findings": ["string"]
}
```

- `industry` — a concise conventional retail category (2–4 words), or `"Unknown"` when undeterminable.
- `confidence` — a number in `[0, 1]`; high only when multiple independent signals agree, low when evidence is sparse/conflicting or an input is missing.
- `findings` — an array of short factual observations justifying the call (always an array; `[]` only when there is genuinely nothing to report).

No extra keys, no missing keys. A parallel lib agent builds to this shape — do not deviate without updating both sides.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: probe-industry`.
- Body: a standard Anthropic messages payload. User content = `[document(cleaned-HTML file_id), image(screenshot file_id)]`, both uploaded via `POST /files` (same flow as image-selection).
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.

### Tolerance

Either input may be absent or low-signal. The prompt never fails on missing data — it infers from what remains and lowers `confidence`. `industry: "Unknown"` with low confidence is the sink for genuinely undeterminable pages.
