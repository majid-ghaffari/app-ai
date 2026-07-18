# Cart-Wiring Probe — Maintenance Doc

The design/maintenance record for the `probe-cart-wiring` Website-Analysis probe. The runtime file it documents lives at [`src/prompts/probe-cart-wiring/prompt.md`](../../src/prompts/probe-cart-wiring/prompt.md) (system prompt), registered as `probe-cart-wiring` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts) with its frozen output schema recorded in `PROBE_SCHEMAS`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md). See [probe-industry.md](probe-industry.md) for what a probe is in general.

## `probe-cart-wiring`

- **Purpose:** Classify a store's cart UI from BEHAVIORAL evidence gathered by driving the real storefront, and return the selectors + surface type LimeSpot needs to inject a cart recommendation box.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`). The classification is harder than the one-shot industry call — it reasons over multiple stages of behavior, not a single page.
- **Tools:** none (one-shot JSON).
- **Attachments:** none. The caller uploads the per-stage evidence per request.

### Input

Screenshots + cleaned HTML for three stages of driving the real cart, plus driver notes:

- **closed-page** — the page with the cart NOT open (trigger visible, surface closed).
- **opened-cart** — the same page AFTER the cart trigger was clicked.
- **populated-cart** — the cart AFTER an item was added (to observe how/whether contents change).
- **notes** — what was clicked, what appeared/grew, the post-add DOM delta, and whether restoring the prior cart state worked.

Any stage/screenshot may be partial or missing — the probe never fails, it infers and lowers `confidence`.

### Frozen output contract

The assistant text is a single JSON object, exactly:

```json
{
  "cartButtonQuerySelector": "string|null",
  "cartContainerQuerySelector": "string|null",
  "cartInnerQuerySelector": "string|null",
  "cartTriggerFunction": "string|null",
  "cartUpdateFunction": "string|null",
  "surfaceType": "drawer|modal|dropdown|native",
  "refreshAuto": true,
  "confidence": 0.0,
  "findings": ["string"]
}
```

- `surfaceType` is classified VISUALLY/BEHAVIORALLY: a slide-in side panel = `drawer`; a centered dialog = `modal`; a small panel anchored under the trigger = `dropdown`; the theme handling open/refresh itself = `native`.
- Never invent a selector — use `null` when unsure.
- `refreshAuto` is true ONLY if the container's contents actually mutated after the add; set `cartUpdateFunction` only when `refreshAuto` is false (null otherwise).
- `findings` is always an array.

No extra keys, no missing keys. A parallel lib consumer builds to this shape — do not deviate without updating both sides.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: probe-cart-wiring`.
- Body: a standard Anthropic messages payload. User content = the per-stage evidence blocks (documents + images uploaded via `POST /files`) plus a text block of the driver notes. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
