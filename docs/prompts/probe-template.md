# Template Probe — Maintenance Doc

The design/maintenance record for the `probe-template` Website-Analysis probe. The runtime file it documents lives at [`src/prompts/probe-template/prompt.md`](../../src/prompts/probe-template/prompt.md) (system prompt), registered as `probe-template` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts) with its frozen output schema recorded in `PROBE_SCHEMAS`. The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md). See [probe-industry.md](probe-industry.md) for what a probe is in general, and [probe-style.md](probe-style.md) for the sibling that OBSERVES styling (this one GENERATES a template).

## `probe-template`

- **Purpose:** GENERATE a LimeSpot recommendation-box CARD-SLOT template (markup + scoped CSS ONLY, no script/SetupObject) that reproduces the merchant's OWN product card from its screenshot + cleaned HTML/CSS, so LimeSpot's boxes match the store's native product cards when no built-in variant is close enough. This is the generative counterpart to `probe-style` (which only classifies styling into a built-in variant's appearance options).
- **Model:** the `balanced` tier (currently `claude-sonnet-5`) — the same tier as the `proposals` reasoner and the visual/behavioral probes. Generation is the harder task; it benefits from the stronger reasoner.
- **Tools:** none (one-shot JSON).
- **Attachments:** none. The caller uploads the product-card screenshot + cleaned HTML/CSS per request.

### Input

- A screenshot of ONE of the store's existing product cards (the visual target).
- The card's cleaned HTML/CSS (may include class names / inline styles; may be partial).

Any input may be absent or low-signal — the probe never fails, it reproduces what it can and lowers `confidence`.

### SAFETY — this prompt is NOT the security boundary

The generated template's markup is executed by the LimeSpot runtime (custom templates render via `new Function` for their SetupObject). v1 is safe BY CONSTRUCTION:

1. **SetupObject is FORCED EMPTY.** This probe outputs markup + scoped CSS ONLY — there is no script/SetupObject field. The lib consumer forces an empty `SetupObject` and REJECTS any non-empty one, removing the code-exec surface entirely.
2. **The lib side runs an AST binding-allowlist validator** (`admin/ai/analysis/template-safety.ts`) that parses the generated HTML with `@vue/compiler-dom` and REJECTS unless every rule below holds. This prompt describes the safe grammar so the model stays inside it, but the lib validator is the real gate — the prompt cannot be trusted to be safe on its own.

So the prompt's grammar and the lib validator MUST stay in lockstep. If you loosen the prompt grammar, loosen the validator too (and vice-versa), or generated templates that the prompt allows will be silently rejected (or, worse, an unvalidated surface opens).

### The allowed grammar (mirrored by the lib validator)

- **Allowed tags:** `li`, `a`, `div`, `span`, `img`, `h1`–`h6`, `p`, plus the `@Ls*` child components (`LsProductImage` / `LsProductPrice` / `LsProductReview` / `LsProductSaleTag` / `LsCardQuickAction`). Nothing else.
- **Allowed directives:** `v-if` / `v-else-if` / `v-else`, `v-for`, `v-bind` / `:` (for `:class` / `:style` / `:href` / `:id` / `:data-*` / `:aria-*` / `:product`), named slots only.
- **Forbidden (any one REJECTS the whole template):** `v-html`, `v-on` / `@` handlers, `:href` to anything other than `product.DisplayUrl`, any interpolation / bind that CALLS A FUNCTION or reads OUTSIDE the product data-model, and any non-empty script/SetupObject.
- **Product data-model (the only bindable data):** `product.DisplayUrl`, `product.Identifier`, `product.Title`, `product.Vendor`, plus whole-`product` pass-through to an `@Ls*` child. Confirmed against `@LsVerticalProductCard.vue`.

### Frozen output contract

The assistant text is a single JSON object of this shape:

```json
{
  "html": "string (card markup within the allowed grammar; root is a single <li>)",
  "css": "string (scoped plain CSS, not SCSS)",
  "cssScoped": true,
  "baseTemplateName": "carousel|grid|rows",
  "confidence": 0.0,
  "notes": ["string"]
}
```

- `html` — the card markup; the ROOT element is a single `<li>`.
- `css` — scoped plain CSS. `cssScoped` is ALWAYS `true`.
- `baseTemplateName` — the closest built-in base (`carousel` / `grid` / `rows`); also the fallback base if the generated template is rejected.
- `confidence` in `[0, 1]`; reflects how much was inferred vs. read from the CSS.
- `notes` — always an array.

A parallel lib consumer (`normalizeTemplate` in `admin/ai/analysis/template-map.ts`) builds to this shape — do not deviate without updating both sides AND the lib AST validator.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: probe-template`.
- Body: a standard Anthropic messages payload. User content = the card screenshot image(s) + the cleaned-HTML document(s), uploaded via `POST /files`. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
