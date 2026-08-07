# Style Probe — Maintenance Doc

The design/maintenance record for the `probe-style` Website-Analysis probe. The runtime file it documents lives at [`src/prompts/probe-style/prompt.md`](../../src/prompts/probe-style/prompt.md) (system prompt), registered as `probe-style` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts) with its frozen output schema recorded in `PROBE_SCHEMAS`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md). See [probe-industry.md](probe-industry.md) for what a probe is in general.

## `probe-style`

- **Purpose:** Observe a store's EXISTING product-card styling from cleaned HTML + screenshots of pages that already display products, so LimeSpot renders its recommendation boxes to match.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`). Reads colours/fonts verbatim from the site CSS — benefits from the stronger reasoner.
- **Tools:** none (one-shot JSON).
- **Attachments:** none. The caller uploads the store's HTML + product-page screenshots per request.

### Input

- Cleaned HTML (may include inline styles / class names / CSS; may be partial).
- Screenshots of pages that already show product cards (grid/carousel/collection). May be partial or missing.

Any input may be absent or low-signal — the probe never fails, it infers and lowers `confidence`.

### Frozen output contract

The assistant text is a single JSON object; fields the model cannot determine are OMITTED (never guessed):

```json
{
  "layout": "carousel|grid|rows",
  "cardOrientation": "vertical|horizontal",
  "cardStyle": "rounded|sharp|elevated",
  "typography": {
    "fontFamily": "string",
    "fontSize": "string",
    "fontWeight": "string",
    "textCase": "none|uppercase|lowercase|capitalize",
    "color": "string",
    "align": "left|center|right"
  },
  "price": {
    "fontFamily": "string",
    "fontSize": "string",
    "fontWeight": "string",
    "color": "string",
    "saleColor": "string"
  },
  "saleSign": { "present": true, "color": "string", "background": "string" },
  "cta": {
    "color": "string",
    "background": "string",
    "hoverBackground": "string",
    "borderRadius": "string",
    "fontWeight": "string",
    "textCase": "string"
  },
  "arrows": { "color": "string", "background": "string", "shape": "chevron|circle|square" },
  "image": { "borderRadius": 0, "aspect": "square|portrait|landscape" },
  "confidence": 0.0,
  "findings": ["string"]
}
```

- Colours and fonts are read VERBATIM from the site CSS / inline styles when present; only inferred visually from screenshots when the CSS is silent.
- `image.borderRadius` is a number (px). All other enumerated fields use the vocabularies above.
- OMIT any field (or nested field) that cannot be determined — do not guess. `confidence` reflects how much was inferred vs. read.
- `findings` is always an array.

A parallel lib consumer builds to this shape — do not deviate without updating both sides.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: probe-style`.
- Body: a standard Anthropic messages payload. User content = the cleaned-HTML document(s) + product-page screenshot image(s), uploaded via `POST /files`. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
