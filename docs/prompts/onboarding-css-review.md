# onboarding-css-review

The targeted advanced-CSS specialist of onboarding quality control. It runs only for pages whose
ordinary visual review reported `advanced-css-required`, and it is the only review stage allowed to
emit managed `advancedCss` visual actions.

## Contract

- Endpoint: `POST /messages` with `X-Personalizer-System-Prompt: onboarding-css-review`.
- Prompt group: `onboarding-visual`, whose model profile resolves to `MODEL_BALANCED`; medium
  effort, 2048 output tokens, no tools.
- Handshake: carries `rulesetVersion`, so a caller's `X-Personalizer-Ruleset-Version` must match.
- Input: the flagged CURRENT pages at both widths, the applied plan, render evidence, prior
  history, and the currently managed visual actions — the same uploaded references the holistic
  review already minted on the `onboarding-visual` file route.
- Output: JSON-only, the same recoverable page-verdict shape plus `visualActions`, where each page
  contributes at most one `advancedCss` action
  (`{ "action": "advancedCss", "args": { "operation", "page", "boxType"?, "rules" } }`).

## Rules the prompt enforces

- Selectors begin with `&`, stay inside the LimeSpot component/page scope, and never target
  merchant or theme elements globally. Declarations are plain CSS declarations only — no braces,
  imports, URLs, scripts, expressions, custom-property writes, or `!important`. A `media` value is
  exactly `(min-width: Npx)` or `(max-width: Npx)`.
- `operation: "remove"` removes an existing managed rule that is visibly causing the defect.
- A missing width is a hard unresolved gate: no action, the page stays failed, `evidence-incomplete`
  is reported, and `needsEscalation` is set. When no safe scoped rule exists the same holds with
  `uncertain`.
- It never emits currency actions or ordinary box corrections, and never repeats an action already
  present in prior history unless the current pixels prove it has not been applied.

## Evidence rationale

Existing appearance settings are always preferred; this specialist exists only for the visible
corrections those settings cannot express. Reusing the holistic review's references keeps the
escalation free of a second upload of the same pixels.
