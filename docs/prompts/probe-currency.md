# Currency-Format Probe — Maintenance Doc

The design/maintenance record for the `probe-currency` Website-Analysis probe. The runtime file it documents lives at [`src/prompts/probe-currency/prompt.md`](../../src/prompts/probe-currency/prompt.md) (system prompt), registered as `probe-currency` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts) with its frozen output schema recorded in `PROBE_SCHEMAS`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](../PROMPT-AUTHORING.md). See [probe-industry.md](probe-industry.md) for what a probe is in general.

## `probe-currency`

- **Purpose:** SELECT which of exactly TWO candidate KINDS (`money` vs `money_with_currency`) matches how a store actually displays prices, so LimeSpot renders its own boxes with the store's currency format. This is a SELECTION probe — the model picks a `candidateId`, it never describes or emits a format.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`) like the other visual probes.
- **Tools:** none (one-shot JSON).
- **Attachments:** none. The caller uploads the store's price-showing screenshots per request and sends the candidate list as a text block.

### Why SELECT-only

The store's real numeric values are already known (each sample's `amount`), and each candidate is a set of fully-formed renderings of those values produced by ONE of the platform's money filters. So the only thing the model can add — and the only thing that is safe for it to add — is a PICK: which KIND's renderings match the store. The model must NOT invent or emit any prefix, suffix, symbol, thousands delimiter, decimal separator, decimal-digit count, format string, regex, or code. The lib's deterministic parser AGGREGATES the chosen kind's samples (the large 7-figure sample reveals grouping; the divisor is DERIVED per sample from `(amount, rendered-number)`) to produce the concrete `{ prefix, suffix, separator, delimiter, decimalDigits }`; a model-authored format is neither needed nor trusted. `candidateId` is the only load-bearing field.

### Input

- `screenshots` — one or more rendered images of store pages that show real prices (product cards, product detail, cart). May be partial or missing.
- `candidates` — a JSON array (text block, sent AFTER the cache breakpoint since it is per-shop VARIABLE data) of the KINDS to choose between: normally exactly TWO entries — one `money`, one `money_with_currency`. **Each candidate is ONE KIND carrying a LIST of `{ amount, value }` samples** — several known amounts rendered that one way (small amounts plus a large one that reveals the thousands grouping):

  ```json
  {
    "candidateId": "USD:money",
    "kind": "money",
    "hasCurrencyCode": false,
    "samples": [
      { "amount": 1234, "value": "$12.34" },
      { "amount": 123456789, "value": "$1,234,567.89" }
    ]
  }
  ```

  This is the cross-repo candidate shape the lib's Shopify adapter builds: `candidateId` (opaque return id, shape `<Currency>:money` | `<Currency>:money_with_currency` — treated as opaque, never parsed by the model), `kind` (`"money"` or `"money_with_currency"`), `hasCurrencyCode` (the boolean form of `kind`), and `samples` (the list of `{ amount, value }` renderings for that kind — `amount` the trusted known numeric, `value` the rendered string). The list carries the two kinds as SEPARATE candidates that differ ONLY in whether a currency code is shown — so the model picks BETWEEN the two by what the store displays, and never chooses among the samples inside one candidate.

Any input may be absent or low-signal — the probe never fails, it returns `"none"` and lowers `confidence`.

### Frozen output contract

The assistant text is a single JSON object of exactly this shape:

```json
{
  "candidateId": "USD:money",
  "confidence": 0.9,
  "reasoning": "Product cards show prices like $1,299.00 with no currency code beside them, matching the plain money candidate rather than money_with_currency."
}
```

- `candidateId` — ONE of the provided ids, or `"none"`. Never an id absent from `candidates`, never a fabricated id.
- `confidence` — number in `[0, 1]`.
- `reasoning` — one sentence citing the store prices compared; it MUST NOT contain a prefix/suffix/delimiter/decimal-count/format string the model invented.

A parallel lib consumer builds to this shape (`PROBE_SCHEMAS['probe-currency']`) — do not deviate without updating both sides.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: probe-currency`.
- Body: a standard Anthropic messages payload. User content = the price-showing screenshot image(s) (uploaded via `POST /files`) + a text block carrying the `candidates` JSON array. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative; `max_tokens` is registry-governed (512).
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
