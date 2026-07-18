import * as prompts from './prompts';
import { composePrompt } from './prompts/_compose';
import { LOOK_AT_PAGE_TOOL } from './lib/client-tools';
import type { Effort, ToolDefinition } from './lib/anthropic';
import { resolveModel, type Env } from './config';

/**
 * System-prompt REGISTRY — maps a prompt NAME → `{ tier, maxTokens, usesTools,
 * clientTools?, description, attachments, effort? }` (the model/token/tool
 * choices). It is the single source of truth consumers read through
 * `getSystemPrompt(name, env)`, never hardcoding text or metadata.
 *
 * Prompt TEXT lives under `src/prompts/` (pure `.md`) and is assembled by the
 * barrel `src/prompts/index.ts` — each entry's `prompt:` here references
 * `prompts.<name>`. See:
 *   • `src/prompts/CLAUDE.md` — the authoritative prompt inventory + doc-sync rule.
 *   • root `CLAUDE.md` → "Prompt registry" — the build-time `.md` bundling, the
 *     Anthropic prompt-caching design (why composed prompts are ordered +
 *     input-free), and the single/multi-file/composed layout convention.
 */

/**
 * Semantic capability TIER for a prompt — a provider-agnostic classification of
 * how much model muscle the prompt needs, NOT a model id. The registry entries
 * carry a tier; config binds each tier to a concrete model (`resolveModel` in
 * src/config.ts), so switching model versions OR provider is a config-only change.
 *   • `fast`     — latency-sensitive / cheapest one-shot structured prompts.
 *   • `balanced` — the multi-modal / JSON reasoners (proposals, visual-verify, the
 *                  onboarding batch/review passes, the behavioral/visual probes).
 *   • `frontier` — the most-capable flagship; the agent-loop chat prompts + the
 *                  heaviest classification. The DEFAULT tier.
 */
export type ModelTier = 'fast' | 'balanced' | 'frontier';

/** The tier a registry entry gets when it omits `tier` — the flagship agent-loop tier. */
const DEFAULT_TIER: ModelTier = 'frontier';

/** A file prepended to the first message (uploaded via the Files API dedup). */
export interface PromptAttachment {
  content: string;
  mimeType: string;
  filename: string;
}

/**
 * One registry entry — the single source of truth for a prompt's text + its
 * model / token / tool choices:
 *   - prompt:      the system-prompt text (from the `src/prompts/` barrel)
 *   - model:       the model for this prompt — a deploy-time configuration
 *                  choice, resolved from the entry's capability tier
 *                  (`resolveModel`, src/config.ts) when the entry is read
 *                  through `getSystemPrompt(name, env)`
 *   - maxTokens:   default max_tokens for this prompt
 *   - usesTools:   whether the agent loop sends the SERVER toolset definitions
 *                  (the integration toolsets the worker executes server→server).
 *                  Mutually exclusive with `clientTools`.
 *   - clientTools: OPTIONAL — when present, this prompt's tools execute on the
 *                  CLIENT, not in the worker (the handler sends THESE definitions in
 *                  place of the server toolset and returns the calls in
 *                  `done.toolCalls`). Mutually exclusive with `usesTools`. Its live
 *                  consumer is `onboarding-chat` (#111), which carries the CLIENT
 *                  `look_at_page` tool so the chat model can ask the browser to LOOK
 *                  at a page (the store iframe is the AI's hands). This is the
 *                  generic client-tool capability seam.
 *   - description: short human-readable note (registry documentation)
 *   - attachments: files prepended to the first message (image-selection only)
 *   - effort:      OPTIONAL output effort. When set AND the entry's model
 *                  supports effort (lib/anthropic.ts `supportsEffort`),
 *                  handlers add `output_config: { effort }` to the payload
 *                  (lowers output tokens). On a model that doesn't support
 *                  effort the handler omits it (sending it returns a 400), so
 *                  only set `effort` on an effort-supporting model. Omit for
 *                  the default ('high').
 */
export interface SystemPromptEntry {
  prompt: string;
  model: string;
  maxTokens: number;
  usesTools: boolean;
  description: string;
  attachments: PromptAttachment[];
  effort?: Effort;
  /** CLIENT-executed tool schema (mutually exclusive with `usesTools`). See the
   *  field docs above. Its live consumer is `onboarding-chat` (#111), which carries
   *  the `look_at_page` client tool; the generic client-tool capability seam. */
  clientTools?: readonly ToolDefinition[];
}

/**
 * A registry definition: a `SystemPromptEntry` whose model is still a
 * deploy-time choice, materialized per read by `getSystemPrompt(name, env)`.
 * Instead of naming a model, an entry names a semantic capability `tier`
 * (`fast` / `balanced` / `frontier`) — registry data describing how much muscle
 * the prompt needs. WHICH concrete model that tier resolves to is configuration
 * (wrangler [vars] / .dev.vars, bound via `resolveModel`). An entry that OMITS
 * `tier` gets `DEFAULT_TIER` (the flagship agent-loop tier).
 */
type SystemPromptDefinition = Omit<SystemPromptEntry, 'model'> & {
  tier?: ModelTier;
};

const systemPrompts: Record<string, SystemPromptDefinition> = {
  'image-selection': {
    // Multi-file prompt: system text composed from `image-selection/prompt.md`.
    // (Its design/maintenance doc lives at docs/prompts/image-selection.md.)
    // No `tier`: runs on the DEFAULT `frontier` tier.
    prompt: composePrompt(prompts.imageSelection),
    maxTokens: 4096,
    usesTools: false,
    description:
      'Analyzes page HTML + screenshot to produce CSS selectors for image/text/CTA personalization (JSON-only output). Multi-file prompt: prompt.md as the system prompt + sample.md as a training-examples attachment.',
    // `sample.md` (training examples) is uploaded once and prepended to the
    // first message as a document block (dedup + extended cache in messages.ts).
    attachments: [
      {
        content: prompts.imageSelectionSample,
        mimeType: 'text/plain',
        filename: 'sample.md',
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Studio AI — server-side system prompts for the chat agent loop.
  // Selected via the X-Personalizer-System-Prompt header on POST /chat.
  // See lib CONTRACTS.md §1 (SSE protocol) and §2 (tool definitions).
  // ──────────────────────────────────────────────────────────────────────────

  // General conversational assistant for LimeSpot Studio merchants.
  // No `tier`: the agent loop runs on the DEFAULT `frontier` tier.
  chat: {
    prompt: prompts.chat,
    maxTokens: 4096,
    usesTools: true,
    description:
      'General conversational Studio assistant; runs the tool-use agent loop to read store data.',
    attachments: [],
  },

  // Onboarding / visual chat (#111) — the CLIENT-tool twin of `chat`. Same SYSTEM
  // prompt + tier (DEFAULT `frontier`) as `chat`, but instead of the SERVER data toolset it carries the
  // CLIENT `look_at_page` tool, which executes in the merchant's BROWSER (the store
  // iframe is the AI's hands): on a `look_at_page` tool_use the /chat loop returns
  // the call in `done.toolCalls` and STOPS — the lib captures/serves a screenshot of
  // the named page, appends it as an image block on the tool_result turn, and calls
  // /chat again so the model can SEE what rendered before it answers or refines a box.
  // `clientTools` is mutually exclusive with `usesTools` (chat.ts), so this is a
  // SEPARATE entry, not a flag on `chat` — a turn is EITHER server-data-tools OR the
  // visual client tool, never both. This is the FIRST live consumer of the dormant
  // client-tool mode; the onboarding refine loop / interactive review / cart-drawer
  // chat / #98 optimize all select it to gain visual self-inspection.
  'onboarding-chat': {
    prompt: prompts.onboardingChat,
    maxTokens: 4096,
    usesTools: false,
    clientTools: [LOOK_AT_PAGE_TOOL],
    description:
      'Onboarding / visual Studio chat; same identity + tier as `chat` but its OWN system prompt (`onboarding-chat.md`) — it DROPS the server-data-tool guidance (no `get_store_analytics` / `get_entity_context` in this client-tool mode) and instead steers the model to the CLIENT `look_at_page` tool (executed in the browser: capture/serve a full-page screenshot) so it can SEE the page before it answers or refines. Runs the /chat loop in CLIENT-tool mode: a look_at_page tool_use returns done.toolCalls and stops; the lib runs it and re-calls /chat with the screenshot.',
    attachments: [],
  },

  // New-merchant onboarding assistant — opinionated, applies best-practice defaults.
  // No `tier`: the agent loop runs on the DEFAULT `frontier` tier.
  onboarding: {
    prompt: prompts.onboarding,
    maxTokens: 4096,
    usesTools: true,
    description:
      'New-merchant onboarding assistant; applies best-practice defaults and runs the tool-use agent loop.',
    attachments: [],
  },

  // Placement assistant — returns ONLY a structured JSON proposal (no prose, no tools).
  // `fast` tier: latency-sensitive one-shot JSON — speed + cost over deep reasoning.
  placement: {
    prompt: prompts.placement,
    tier: 'fast',
    maxTokens: 2048,
    usesTools: false,
    description: 'Structured placement proposer; one-shot JSON, no tools, faster model.',
    attachments: [],
    // No `effort`: the `fast`-tier model (currently Haiku 4.5) does not support
    // `output_config.effort`. The handler guards on model capability and would
    // omit it regardless; setting it here would be dead config. If placement
    // moves to an effort-supporting model, add `effort: 'low'` then.
  },

  // Per-store SETUP PROPOSAL — grounds in REAL PAGE EVIDENCE (the merchant's
  // storefront pages: cleaned HTML + screenshots, uploaded via /files and sent as
  // document/image content blocks, exactly like the Website-Analysis probes) AND
  // the merchant's REAL store data pulled on demand: proposals runs on the
  // /chat tool-use path (usesTools: true), so during reasoning the model can CALL
  // the always-active personalizer toolset — get_store_analytics (real AOV / order
  // count, so the progress-bar threshold is order-derived not just a default),
  // list_segments + list_campaigns (reflect what already exists), get_store_config
  // (platform / industry / configured boxes). Returns a single structured JSON
  // proposal (boxes per page, segments, progress-bar offer+threshold, bundles).
  // Drives the onboarding's AI-driven recommendations (lib brain/proposals.ts).
  // Runs on the `balanced` tier — a page-evidence + tool-grounded JSON reasoner,
  // cost/quality-tuned apart from the default (`frontier`) agent-loop tier.
  // Selected via X-Personalizer-System-Prompt: proposals on POST /chat, with the
  // page evidence uploaded via /files and passed as fileIds.
  proposals: {
    prompt: prompts.proposals,
    tier: 'balanced',
    maxTokens: 4096,
    usesTools: true,
    description:
      'Per-store setup proposer; reasons over real page evidence (cleaned HTML + screenshots) AND pulls real store data on demand via the personalizer toolset (get_store_analytics / list_segments / list_campaigns / get_store_config) through the /chat tool-use loop; returns a structured JSON proposal.',
    attachments: [],
  },

  // Visual Verification — the UNIFIED quality-gate reasoner used by BOTH sides
  // (the internal test harness through the FREE Claude-Code channel, and the
  // product's own customer-side self-verify-and-fix loop). Given a plain-language
  // `intent` plus a MULTI-MODAL rendered snapshot (screenshot image + cleaned
  // HTML excerpt document + a text block carrying console lines + inspection
  // facts), returns ONLY `{ pass, reason, fix }` — pass/fail with a factual
  // reason and an OPTIONAL concrete fix directive the client applies + re-verifies.
  // Header-selected on POST /messages (evidence uploaded via /files, passed as
  // fileIds + a text block). A `balanced`-tier reasoner — multi-modal reasoning
  // on par with the visual/behavioral probes. JSON-only, no tools.
  'visual-verify': {
    prompt: prompts.visualVerify,
    tier: 'balanced',
    maxTokens: 2048,
    usesTools: false,
    description:
      'Visual verification judge; given a plain-language intent + a multi-modal rendered snapshot (screenshot + cleaned HTML + console + inspection facts: computed styles / elementFromPoint hit-test / rects), returns JSON-only { pass, reason, fix }. Used by BOTH the internal test harness (free channel) and the product self-verify loop. Sonnet, no tools.',
    attachments: [],
  },

  // Onboarding BATCH — PROPOSE. Given ONE store page (its name + a full-page
  // screenshot + cleaned HTML, uploaded via /files, plus the enumerated list of
  // VALID placement anchors the lib derives from its interaction-layer injection-
  // point filter), returns ONE JSON plan for the WHOLE page: which boxes to place,
  // at which anchor id (only from the provided list — it may not invent a
  // location), and how to style each (appearancePatch) so the boxes match the
  // store's native cards. A structured-output reasoner — NOT a client-tool agent:
  // the lib conductor applies the plan box-by-box, then sends the page to
  // `onboarding-review`. Header-selected on POST /messages like a probe / visual-
  // verify. `balanced` tier, the same reasoner class as the proposals strategist.
  // JSON-only, no tools. Design: docs/prompts/onboarding-batch.md.
  'onboarding-batch': {
    prompt: prompts.onboardingBatch,
    tier: 'balanced',
    maxTokens: 4096,
    usesTools: false,
    description:
      'Onboarding batch PROPOSE; given ONE page (name + full-page screenshot + cleaned HTML + the enumerated valid placement anchors), returns ONE JSON plan for the whole page — boxes with { boxType, anchorId (from the provided list only), appearancePatch, reasoning }, plus an OPTIONAL Cart-only progressBar { position, anchorNumber, reasoning } (the Smart Progress Bar, AI-placed like a box; no appearance keys). Structured output, the conductor applies it box-by-box. Sonnet, no tools.',
    attachments: [],
  },

  // Onboarding BATCH — PROPOSE ALL PAGES IN ONE CALL, the ONE HOLISTIC propose
  // pass. Same per-page reasoning as `onboarding-batch`, but given EVERY
  // page (Home/Product/Collection/Cart) at both widths + a per-page manifest (which images +
  // anchor range belong to which page) in ONE completion, and returns `{ pages: { Home: { boxes },
  // Product: { boxes }, … } }`. A Cart page's plan MAY also carry an OPTIONAL `progressBar
  // { position, anchorNumber, reasoning }` — the Smart Progress Bar, AI-placed relative to a
  // numbered Cart section like a box (no appearance keys; its look comes from its campaign
  // template), Cart page ONLY. It ADDITIONALLY returns the two STORE-WIDE OFF-PAGE natures as
  // optional top-level keys next to `pages` (CONDUCTOR-FRAMEWORK.md → "One holistic propose pass"):
  // `segments?: [{ title, rationale }]` (audience segments to activate) + `discounts?:
  // [{ title, audience, discountRate, rationale }]` (bundle/discount campaigns). Off-page items get
  // a non-visual review later (a separate lib task) — this prompt only PROPOSES them. Collapses N
  // per-page propose round-trips into one so the merchant's "reading → thinking → reveal" show has a
  // single masked wait. `balanced` tier, like `onboarding-batch`; the lib falls back to
  // per-page `onboarding-batch` if this is unavailable. JSON-only, no tools. Design:
  // docs/prompts/onboarding-batch.md (shared). The per-page `onboarding-batch` does NOT carry the
  // off-page blocks — segments/discounts are store-wide, not a single-page decision.
  'onboarding-batch-all': {
    prompt: prompts.onboardingBatchAll,
    tier: 'balanced',
    maxTokens: 8192,
    usesTools: false,
    description:
      'Onboarding HOLISTIC PROPOSE for the WHOLE STORE in one call; given several pages (each name + desktop+mobile marker screenshots) + a per-page manifest, returns { pages: { <page>: { boxes:[…], progressBar? } }, segments?: [{ title, rationale }], discounts?: [{ title, audience, discountRate, rationale }] } — the per-page box shape (all pages at once) + the OPTIONAL Cart-only progressBar { position, anchorNumber, reasoning } (the Smart Progress Bar, AI-placed like a box; no appearance keys) + the two STORE-WIDE OFF-PAGE natures (audience segments + discount/bundle campaigns). Structured output, the conductor applies each page box-by-box; off-page items get a non-visual review later. Sonnet, no tools.',
    attachments: [],
  },

  // Onboarding BATCH — REVIEW. Given a store page's name + a full-page screenshot
  // AFTER the conductor applied the propose plan + the plan that was applied,
  // returns a verdict { pass, feedback, corrections, failureClass }. The crucial
  // classification: failureClass is null on pass; 'placement' for a NON-CRITICAL
  // wrong-slot/order issue; 'styling' for a CRITICAL bad-render / theme-clash.
  // Corrections are limited to the two existing write verbs — styleBox (appearance
  // patch) and addBox/removeBox (toggle) — no new mutation types. A structured-
  // output judge, header-selected on POST /messages like visual-verify.
  // `balanced` tier. JSON-only, no tools. Design: docs/prompts/onboarding-review.md.
  'onboarding-review': {
    prompt: prompts.onboardingReview,
    tier: 'balanced',
    maxTokens: 2048,
    usesTools: false,
    description:
      'Onboarding batch REVIEW; given a page name + a full-page screenshot AFTER the plan was applied + the applied plan, returns JSON-only { pass, feedback, corrections, failureClass } — failureClass classifies a failure as NON-CRITICAL "placement" vs CRITICAL "styling". Corrections limited to styleBox / addBox / removeBox. Sonnet, no tools.',
    attachments: [],
  },

  // Onboarding BATCH — REVIEW ALL PAGES IN ONE CALL (the fast-show QC-side twin of
  // `onboarding-batch-all`). Same per-page verdict reasoning as `onboarding-review`, but given
  // EVERY applied page (Home/Product/Collection/Cart) at both widths + a per-page manifest (which
  // after-render images + applied plan belong to which page) in ONE completion, and returns
  // `{ pages: { Home: { pass, feedback, corrections, failureClass }, … } }`. Collapses N per-page
  // review round-trips into one so the merchant's quality-control act has a single masked wait.
  // `balanced` tier, like `onboarding-review`; the lib falls back to looping per-page
  // `onboarding-review` if this is unavailable or omits a page. JSON-only, no tools. Design:
  // docs/prompts/onboarding-review-all.md.
  'onboarding-review-all': {
    prompt: prompts.onboardingReviewAll,
    tier: 'balanced',
    maxTokens: 8192,
    usesTools: false,
    description:
      'Onboarding batch REVIEW for the WHOLE STORE in one call; given several applied pages (each name + desktop+mobile after-render screenshots + applied plan) + a per-page manifest, returns { pages: { <page>: { pass, feedback, corrections, failureClass } } } — the same per-page verdict shape, all pages at once. Structured output, the conductor batch-writes each page’s corrections. Sonnet, no tools.',
    attachments: [],
  },

  // Cart-drawer conductor (#96) — PROPOSE. The SINGLE-SURFACE twin of
  // `onboarding-batch-all`: given the OPEN cart DRAWER (a rendered overlay) at
  // desktop + mobile widths + the numbered candidate manifest (INSERT anchors + any
  // REPLACE grids INSIDE the drawer), returns ONE JSON plan of the box(es) to place
  // inside the drawer. NOT paginated — the surface is the drawer alone, so the output
  // has a SINGLE top-level key `boxes` (a single-surface variant of the per-page box
  // shape), with NO `pages` wrapper, NO progressBar (a Cart-PAGE item, not a compact
  // drawer's), and NO off-page segments/discounts (store-wide, decided by onboarding).
  // The lib conductor applies the plan box-by-box, then sends the drawer to
  // `cartdrawer-review-all`. Reuses the shared onboarding blocks (box-placement,
  // mobile-first, box vocab, appearance, JSON hardening/tail); only the drawer-specific
  // fragments are authored. `balanced` tier, the same reasoner class as
  // `onboarding-batch-all`. JSON-only, no tools.
  'cartdrawer-batch-all': {
    prompt: prompts.cartdrawerBatchAll,
    tier: 'balanced',
    maxTokens: 4096,
    usesTools: false,
    description:
      'Cart-drawer SINGLE-SURFACE PROPOSE; given the OPEN cart drawer (a rendered overlay) at desktop + mobile widths + the numbered candidate manifest (INSERT anchors + any REPLACE grids inside the drawer), returns { boxes: [ { boxType, position, anchorNumber, styleReferenceSelector?, appearancePatch, appearancePatchMobile, reasoning } ] } — a SINGLE top-level key `boxes` (no `pages` wrapper, no progressBar, no segments/discounts). Favors compact cross-sell/upsell strips that fit the narrow drawer below the line items and above the checkout CTA. Structured output, the conductor applies it box-by-box. Sonnet, no tools.',
    attachments: [],
  },

  // Cart-drawer conductor (#96) — REVIEW. The SINGLE-SURFACE twin of
  // `onboarding-review-all`: given the AFTER-APPLY OPEN cart drawer at desktop +
  // mobile widths + the applied box plan, returns ONE flat verdict
  // { pass, feedback, corrections, failureClass } for the drawer — no `pages` wrapper.
  // failureClass is null on pass; 'placement' for a NON-CRITICAL wrong-slot issue;
  // 'styling' for a CRITICAL bad-render / theme-clash / overflows-the-narrow-drawer
  // issue. Corrections use the SAME three write verbs (styleBox / removeBox / addBox);
  // each correction's args targets the drawer implicitly (NO `page` field — single
  // surface). Reuses the shared review blocks (classify, correction verbs, box vocab,
  // JSON hardening/tail); only the drawer-specific fragments are authored.
  // `balanced` tier, the same reasoner class as `onboarding-review-all`. JSON-only, no tools.
  'cartdrawer-review-all': {
    prompt: prompts.cartdrawerReviewAll,
    tier: 'balanced',
    maxTokens: 2048,
    usesTools: false,
    description:
      'Cart-drawer SINGLE-SURFACE REVIEW; given the OPEN cart drawer AFTER the plan was applied (desktop + mobile after-render screenshots) + the applied plan, returns a flat JSON verdict { pass, feedback, corrections, failureClass } for the drawer (no `pages` wrapper) — failureClass classifies a failure as NON-CRITICAL "placement" vs CRITICAL "styling" (including a box that overflows the narrow drawer). Corrections limited to styleBox / addBox / removeBox, each targeting the drawer implicitly (no page field). Sonnet, no tools.',
    attachments: [],
  },

  // On-demand OPTIMIZE (#98) — PROPOSE. The SINGLE-PAGE, DEMAND-FIRST twin of
  // `onboarding-batch`: given ONE page (name + a full-page desktop + mobile screenshot
  // + the numbered candidate manifest) AND the merchant's typed DEMAND, returns ONE JSON
  // plan for that page — the box(es) to place, honoring the demand FIRST and then filling
  // gaps with best practice. NOT paginated (a single page, not the whole store), so the
  // output has the per-page `page` + `boxes` shape with NO `pages` wrapper, and NO
  // progressBar / segments / discounts (those are onboarding / store-wide concerns). The
  // lib conductor applies the plan box-by-box, then sends the page to the EXISTING
  // `onboarding-review` for QC (single-page QC is identical; the demand does not gate the
  // verdict for v1). Reuses the shared onboarding blocks (box-placement, mobile-first,
  // guidance, box vocab, appearance, JSON hardening/tail) + the NEW `_block-user-demand`
  // block; only the optimize-specific fragments are authored. `balanced` tier,
  // the same reasoner class as `onboarding-batch`. JSON-only, no tools.
  'optimize-demand': {
    prompt: prompts.optimizeDemand,
    tier: 'balanced',
    maxTokens: 4096,
    usesTools: false,
    description:
      "On-demand OPTIMIZE PROPOSE; given ONE page (name + full-page desktop + mobile screenshots + the numbered candidate manifest) + the merchant's typed DEMAND, returns { page, boxes: [ { boxType, position, anchorNumber, styleReferenceSelector?, appearancePatch, appearancePatchMobile, reasoning } ] } — the per-page box shape (no `pages` wrapper, no progressBar, no segments/discounts), honoring the merchant's explicit request FIRST then best practice. Structured output, the conductor applies it box-by-box then QCs via onboarding-review. Sonnet, no tools.",
    attachments: [],
  },

  // Analytics INSIGHTS — grounds in the merchant's real analytics data for the
  // selected period (folded into the system prompt as grounding context) and
  // returns ONLY a structured JSON array of up to three { kind, text } insights.
  // One-shot, no tools (the data is handed over as grounding, not fetched).
  // Drives Studio's per-tab AI Insights cards (lib analytics/ai-insights.tsx).
  // No `tier`: runs on the DEFAULT `frontier` tier.
  'analytics-insights': {
    prompt: prompts.analyticsInsights,
    maxTokens: 1024,
    usesTools: false,
    description:
      'Analytics insights generator; one-shot JSON array over the tab’s real data (grounding), no tools.',
    attachments: [],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Website-Analysis PROBES (`probe-<id>`). Header-selected on POST /messages,
  // exactly like image-selection: user content = the cleaned-HTML document +
  // the homepage screenshot (uploaded via /files), assistant text = JSON only
  // per the probe's fixed schema (see PROBE_SCHEMAS below). No tools.
  // ──────────────────────────────────────────────────────────────────────────

  // Industry probe — given a storefront homepage screenshot + cleaned HTML,
  // determine the merchant's industry / retail vertical + supporting findings.
  // No `tier`: runs on the DEFAULT `frontier` tier.
  'probe-industry': {
    prompt: prompts.probeIndustry,
    maxTokens: 1024,
    usesTools: false,
    description:
      'Website-analysis industry probe; given a homepage screenshot + cleaned HTML, returns JSON-only { industry, confidence, findings }. No tools.',
    attachments: [],
  },

  // Cart-wiring probe — classifies a store's cart UI from BEHAVIORAL evidence
  // (closed-page → opened-cart → populated-cart screenshots + cleaned HTML +
  // driver notes) and returns the selectors + surface type LimeSpot needs to
  // inject a cart recommendation box. A `balanced`-tier reasoner — the
  // classification is harder than the one-shot industry call. JSON-only, no tools.
  'probe-cart-wiring': {
    prompt: prompts.probeCartWiring,
    tier: 'balanced',
    maxTokens: 2048,
    usesTools: false,
    description:
      'Website-analysis cart-wiring probe; classifies cart UI from behavioral evidence (screenshots + HTML + notes across closed/opened/populated stages), returns JSON-only selectors + surfaceType + refresh behavior. Sonnet, no tools.',
    attachments: [],
  },

  // Style probe — observes a store's EXISTING product-card styling from cleaned
  // HTML + screenshots of pages that already show products, so LimeSpot renders
  // its recommendation boxes to match. A `balanced`-tier reasoner — reads
  // colours/fonts verbatim from the site CSS. JSON-only, no tools.
  'probe-style': {
    prompt: prompts.probeStyle,
    tier: 'balanced',
    maxTokens: 2048,
    usesTools: false,
    description:
      'Website-analysis style probe; observes existing product-card styling (layout, typography, price, CTA, arrows, image) from HTML + screenshots, returns JSON-only style descriptor. Sonnet, no tools.',
    attachments: [],
  },

  // Template probe — GENERATES a rec-box card-slot Vue template (markup + scoped
  // CSS ONLY, no script/SetupObject) that reproduces the merchant's OWN product
  // card from its screenshot + cleaned HTML/CSS, so LimeSpot's boxes match the
  // store's native cards when a built-in variant can't. Markup is limited to a
  // fixed allowed grammar (allowed tags + @Ls* children, v-if/v-for/v-bind/named
  // slots only, NO v-html / v-on / non-product bindings) and binds only to the
  // product data-model — a lib-side AST validator RE-CHECKS every rule before the
  // template is ever rendered, so this prompt describes the safe grammar, it is
  // not the security boundary. A `balanced`-tier reasoner — the harder
  // generative task. JSON-only, no tools.
  'probe-template': {
    prompt: prompts.probeTemplate,
    tier: 'balanced',
    maxTokens: 4096,
    usesTools: false,
    description:
      'Website-analysis template probe; GENERATES a rec-box card-slot template (markup + scoped CSS only, no script/SetupObject) reproducing the merchant card from its screenshot + HTML, markup limited to the allowed grammar (allowed tags + @Ls* children, v-if/v-for/v-bind/named slots), bindings only to the product data-model. Returns JSON-only { html, css, cssScoped, baseTemplateName, confidence, notes }. Sonnet, no tools.',
    attachments: [],
  },
};

/**
 * Probe index — the documented output schema for each Website-Analysis probe,
 * keyed by its `probe-<id>` registry name. A probe's registry entry (above)
 * owns its text / model / token choices; this index records the FROZEN JSON
 * shape the probe's assistant text must satisfy, so the schema lives next to
 * the prompt it describes and future probes document their contract the same
 * way. `PROBE_PREFIX` is the naming convention (`probe-<id>`).
 */
export const PROBE_PREFIX = 'probe-';

export interface ProbeDefinition {
  /** One-line description of what the probe determines. */
  readonly description: string;
  /**
   * Human-readable description of the frozen JSON output contract. The probe's
   * assistant text is a single JSON object of exactly this shape (no prose).
   */
  readonly outputSchema: string;
}

export const PROBE_SCHEMAS: Record<string, ProbeDefinition> = {
  'probe-industry': {
    description:
      'Industry / retail-vertical classification of a storefront homepage from its screenshot + cleaned HTML.',
    outputSchema: '{ "industry": string, "confidence": number (0..1), "findings": string[] }',
  },
  'probe-cart-wiring': {
    description:
      'Cart-UI classification from behavioral evidence (screenshots + cleaned HTML + driver notes across closed → opened → populated stages): the selectors, surface type, and refresh behavior LimeSpot needs to inject a cart recommendation box.',
    outputSchema:
      '{ "cartButtonQuerySelector": string|null, "cartContainerQuerySelector": string|null, "cartInnerQuerySelector": string|null, "cartTriggerFunction": string|null, "cartUpdateFunction": string|null, "surfaceType": "drawer"|"modal"|"dropdown"|"native", "refreshAuto": boolean, "confidence": number (0..1), "findings": string[] }',
  },
  'probe-style': {
    description:
      'Existing product-card styling of a storefront from cleaned HTML + screenshots of pages that already display products, so LimeSpot renders its boxes to match. Undeterminable fields are omitted, never guessed.',
    outputSchema:
      '{ "layout": "carousel"|"grid"|"rows", "cardOrientation": "vertical"|"horizontal", "cardStyle": "rounded"|"sharp"|"elevated", "typography": { "fontFamily": string, "fontSize": string, "fontWeight": string, "textCase": "none"|"uppercase"|"lowercase"|"capitalize", "color": string, "align": "left"|"center"|"right" }, "price": { "fontFamily": string, "fontSize": string, "fontWeight": string, "color": string, "saleColor": string }, "saleSign": { "present": boolean, "color": string, "background": string }, "cta": { "color": string, "background": string, "hoverBackground": string, "borderRadius": string, "fontWeight": string, "textCase": string }, "arrows": { "color": string, "background": string, "shape": "chevron"|"circle"|"square" }, "image": { "borderRadius": number, "aspect": "square"|"portrait"|"landscape" }, "confidence": number (0..1), "findings": string[] }',
  },
  'probe-template': {
    description:
      'GENERATED rec-box card-slot template (markup + scoped CSS only, NO script/SetupObject) reproducing the merchant product card from its screenshot + cleaned HTML/CSS. Markup is limited to the allowed grammar (allowed tags + @Ls* children, v-if/v-for/v-bind/named slots only; NO v-html / v-on / non-product :href / function-call or non-product bindings) and binds only to the product data-model (product.DisplayUrl/.Identifier/.Title/.Vendor + whole-product to @Ls* children). A lib-side AST validator RE-CHECKS every rule before render — this schema is the transport shape, not the security boundary.',
    outputSchema:
      '{ "html": string, "css": string, "cssScoped": true, "baseTemplateName": "carousel"|"grid"|"rows", "confidence": number (0..1), "notes": string[] }',
  },
};

/** Whether a system-prompt name is a Website-Analysis probe (`probe-<id>`). */
export function isProbeName(name: string): boolean {
  return name.startsWith(PROBE_PREFIX);
}

/**
 * Get a system prompt entry by name (text + metadata), with the entry's
 * capability tier resolved to a concrete model from configuration. An entry
 * that omits `tier` uses `DEFAULT_TIER`. Throws on an unknown name (and, via
 * `resolveModel` → the config accessors, on a missing tier-model variable).
 */
export function getSystemPrompt(name: string, env: Env): SystemPromptEntry {
  const definition = systemPrompts[name];
  if (!definition) {
    throw new Error(`System prompt not found: ${name}`);
  }
  const { tier, ...entry } = definition;
  const model = resolveModel(env, tier ?? DEFAULT_TIER);
  return { ...entry, model };
}
