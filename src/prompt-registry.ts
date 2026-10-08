import * as prompts from './prompts';
import { composePrompt } from './prompts/_compose';
import { LOOK_AT_PAGE_TOOL } from './lib/client-tools';
import type {
  CanonicalToolDefinition,
  FilePolicy,
  ModelCapabilities,
  ModelCapabilityName,
  ModelProfile,
  ProviderApiFamily,
  ProviderName,
  SemanticEffort,
} from './lib/inference-types';
import {
  BOUNDED_FREE_VISUAL_MODEL,
  getFilePolicy,
  modelMaxOutputTokens,
  resolveModelFamily,
  type FilePolicyName,
  type ModelProfileName,
} from './inference/model-catalog';
import {
  graderChatBookletVersion,
  graderChatMaxReplyTokens,
  isProductionDeployment,
  modelOverrides,
  resolveModel,
  validateProviderBases,
  type Env,
} from './config';
import { aiSubprocessorOf, mayServeRoute } from './lib/ai-providers';
import { WorkerError } from './lib/responses';

export { getFilePolicy, listFilePolicies } from './inference/model-catalog';
export type { FilePolicyName, ModelProfileName } from './inference/model-catalog';

/**
 * System-prompt REGISTRY — maps a prompt NAME → `{ group, maxTokens, usesTools,
 * clientTools?, description, attachments, effort? }`, with groups owning a
 * capability tier and the capabilities they require. It is the single source of
 * truth consumers read through `getSystemPrompt(name, env)`, never hardcoding
 * text or metadata.
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
 * The capability tier a prompt group runs on. Prompt entries name groups, groups
 * name tiers, and each tier binds to one configured model id; callers never send
 * a tier or a model.
 *   • `fast`     — latency-sensitive / cheapest one-shot structured prompts.
 *   • `balanced` — the multi-modal / JSON reasoners (proposals, visual-verify, the
 *                  onboarding batch/review passes, the behavioral/visual probes).
 *   • `frontier` — the most-capable flagship for agent loops and heavy classification.
 */
export type ModelTier = 'fast' | 'balanced' | 'frontier';

/** Every registered prompt contract name. */
export type PromptName =
  | 'image-selection'
  | 'chat'
  | 'billing-assistant'
  | 'grader-chat'
  | 'onboarding-chat'
  | 'onboarding'
  | 'placement'
  | 'proposals'
  | 'visual-verify'
  | 'visual-verify-free'
  | 'onboarding-batch'
  | 'onboarding-batch-all'
  | 'onboarding-review'
  | 'onboarding-review-all'
  | 'onboarding-review-gate-all'
  | 'onboarding-css-review'
  | 'onboarding-currency-recovery'
  | 'cartdrawer-batch-all'
  | 'cartdrawer-review-all'
  | 'optimize-demand'
  | 'analytics-insights'
  | 'probe-industry'
  | 'probe-cart-wiring'
  | 'probe-style'
  | 'probe-template'
  | 'probe-currency';

export const FREE_VISUAL_VERIFY_PROMPT = 'visual-verify-free' as const;

/** Prompt compatibility groups that own routing and provider-file policy. */
export type PromptGroupName =
  | 'image-selection'
  | 'studio-data-agent'
  | 'studio-visual-agent'
  | 'placement-vision'
  | 'setup-strategy'
  | 'onboarding-visual'
  | 'onboarding-qc-gate'
  | 'cartdrawer-visual'
  | 'render-verification'
  | 'free-render-verification'
  | 'website-analysis-visual'
  | 'website-industry'
  | 'analytics-narrative'
  | 'billing-narrative'
  | 'grader-sales';

/** A prompt group's routing and file-compatibility contract. */
export interface PromptGroupDefinition {
  /**
   * The capability tier whose configured model this group runs on. The concrete
   * model comes from `MODEL_<TIER>` (or a `MODEL_OVERRIDES` exception), and the
   * model catalog turns that id into the group's provider, API family,
   * capabilities, and direct-file policy — the group names none of them.
   */
  readonly tier: ModelTier;
  /**
   * Capabilities a resolved model must HAVE for this group's prompts to be
   * CORRECT. A cost characteristic is not one of them: `inlineCacheBreakpoints`
   * says a provider honours per-block cache markers, which only Anthropic does —
   * OpenAI and Gemini cache a stable request prefix automatically instead. Requiring the MECHANISM rather than the outcome makes a provider
   * that caches by another route unroutable, so that flag is required by no
   * group and reported per prompt by `describePromptRoutes`.
   */
  readonly requirements: readonly ModelCapabilityName[];
  /**
   * Whether the group's prompts receive merchant, shopper, user or captured-page content. In
   * production only a provider the DPA lists may serve a group that does.
   */
  readonly carriesCustomerContent: boolean;
  /**
   * OPTIONAL — the group whose provider file route carries this group's evidence,
   * so a cascade that hands one uploaded evidence set from a cheaper classifier to
   * a more capable reasoner uploads those bytes once and mints one reference both
   * groups accept. Omitted means the group routes its own uploads. The named group
   * must share this group's file policy, provider, and API family, and must not
   * itself borrow a route.
   */
  readonly fileRouteGroup?: PromptGroupName;
}

const PROMPT_GROUPS: Readonly<Record<PromptGroupName, PromptGroupDefinition>> = {
  'image-selection': {
    tier: 'fast',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'structuredOutput'],
  },
  'studio-data-agent': {
    tier: 'frontier',
    carriesCustomerContent: true,
    requirements: ['streaming', 'serverTools', 'textConversation'],
  },
  'studio-visual-agent': {
    tier: 'frontier',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'streaming', 'clientTools', 'textConversation'],
  },
  'placement-vision': {
    tier: 'fast',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'streaming', 'structuredOutput'],
  },
  'setup-strategy': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'streaming', 'structuredOutput', 'serverTools'],
  },
  'onboarding-visual': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'structuredOutput', 'reasoning'],
  },
  'onboarding-qc-gate': {
    tier: 'fast',
    carriesCustomerContent: true,
    fileRouteGroup: 'onboarding-visual',
    requirements: ['vision', 'reusableFiles', 'structuredOutput'],
  },
  'cartdrawer-visual': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'structuredOutput'],
  },
  'render-verification': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'structuredOutput'],
  },
  'free-render-verification': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['vision'],
  },
  'website-analysis-visual': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'structuredOutput'],
  },
  'website-industry': {
    tier: 'frontier',
    carriesCustomerContent: true,
    requirements: ['vision', 'reusableFiles', 'structuredOutput'],
  },
  'analytics-narrative': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['streaming', 'structuredOutput'],
  },
  'billing-narrative': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['streaming', 'textConversation'],
  },
  'grader-sales': {
    tier: 'balanced',
    carriesCustomerContent: true,
    requirements: ['textConversation'],
  },
};

/**
 * The onboarding PLAYBOOK ruleset version — the cross-repo handshake identifier.
 * It is embedded VERBATIM as the FIRST LINE of `onboarding-shared/_block-fixed-rules.md`
 * (composed into the four onboarding prompts' stable prefix) AND set on those four
 * entries' `rulesetVersion` PLUS the three sibling conductors that reuse the same
 * shared onboarding playbook blocks — `cartdrawer-batch-all`, `cartdrawer-review-all`,
 * and `optimize-demand`. The lib holds the equal string and sends it as the
 * `X-Personalizer-Ruleset-Version` header on those `/messages` calls; the handler
 * (`validateRulesetVersion`) rejects a mismatch with a 409 so a lib built against a
 * stale playbook never proposes against the wrong enforced rules. Bump this string
 * (and the block's first line, pinned equal by a unit test) whenever the
 * enforced-rule set changes.
 */
export const ONBOARDING_RULESET_VERSION = 'limespot-onboarding-playbook-v2';

/**
 * A registry output budget that resolves to the documented maximum output of whichever model the
 * prompt's route selects. It is a ceiling, not a spend: unused output tokens cost nothing and do
 * not count toward rate limits.
 */
export const MODEL_MAXIMUM_OUTPUT = 'model-maximum' as const;

/** A registry output budget that resolves to the deployment's `GRADER_CHAT_MAX_REPLY_TOKENS`. */
export const GRADER_CHAT_REPLY_BUDGET = 'grader-chat-reply-budget' as const;

/** A file prepended to the first message (uploaded via the Files API dedup). */
export interface PromptAttachment {
  content: string;
  mimeType: string;
  filename: string;
}

/**
 * One resolved registry entry — the single source of truth for a prompt's
 * text, compatibility group, provider route, file policy, token budget, and tools:
 *   - prompt:      the system-prompt text (from the `src/prompts/` barrel)
 *   - model:       the configured model, resolved through group → tier → the
 *                  `MODEL_<TIER>` binding (or a `MODEL_OVERRIDES` exception)
 *   - maxTokens:   default max_tokens for this prompt
 *   - usesTools:   whether the agent loop sends the SERVER toolset definitions
 *                  (the integration toolsets the worker executes server→server).
 *                  Mutually exclusive with `clientTools`.
 *   - clientTools: OPTIONAL — when present, this prompt's tools execute on the
 *                  CLIENT, not in the worker (the handler sends THESE definitions in
 *                  place of the server toolset and returns the calls in
 *                  `done.toolCalls`). Mutually exclusive with `usesTools`. Its live
 *                  consumer is `onboarding-chat`, which carries the CLIENT
 *                  `look_at_page` tool so the chat model can ask the browser to LOOK
 *                  at a page (the store iframe is the AI's hands). This is the
 *                  generic client-tool capability seam.
 *   - description: short human-readable note (registry documentation)
 *   - attachments: files prepended to the first message (image-selection only)
 *   - effort:      OPTIONAL output effort. When set AND the entry's model
 *                  supports effort (the selected adapter owns its model gate),
 *                  the canonical request carries semantic effort and the
 *                  adapter maps or omits it. On a model that doesn't support
 *                  effort the adapter omits it (sending it returns a 400), so
 *                  only set `effort` on an effort-supporting model. Omit for
 *                  the default ('high').
 */
export interface SystemPromptEntry {
  /** This entry's own registered name. */
  name: PromptName;
  /** The prompt compatibility group that owns this entry's route and file policy. */
  group: PromptGroupName;
  /** The capability tier the group runs on. */
  tier: ModelTier;
  prompt: string;
  model: string;
  /** Model family the configured model belongs to, per the model catalog. */
  modelProfile: ModelProfileName;
  /** Provider that serves the configured model, inferred from its id. */
  provider: ProviderName;
  /** Resolved provider API family. */
  apiFamily: ProviderApiFamily;
  /** Resolved direct-provider file policy name. */
  filePolicy: FilePolicyName;
  /** Capabilities of the resolved model's family. */
  capabilities: ModelCapabilities;
  maxTokens: number;
  usesTools: boolean;
  description: string;
  attachments: PromptAttachment[];
  effort?: SemanticEffort;
  /**
   * OPTIONAL adaptive effort policy for latency-sensitive QC. The caller may describe whether a
   * request is the ordinary fast path or an evidence/schema/quality escalation, but this registry
   * remains the authority that maps that neutral signal to provider-specific effort values.
   * Mutually exclusive with `effort`.
   */
  adaptiveEffort?: { default: SemanticEffort; escalated: SemanticEffort };
  /** CLIENT-executed tool schema (mutually exclusive with `usesTools`). See the
   *  field docs above. Its live consumer is `onboarding-chat`, which carries
   *  the `look_at_page` client tool; the generic client-tool capability seam. */
  clientTools?: readonly CanonicalToolDefinition[];
  /**
   * OPTIONAL onboarding-playbook ruleset version (`ONBOARDING_RULESET_VERSION`).
   * Set on every prompt whose stable prefix composes the shared onboarding
   * PLAYBOOK blocks — the four onboarding propose/review prompts PLUS the
   * cart-drawer propose/review (`cartdrawer-batch-all` / `cartdrawer-review-all`)
   * and the on-demand `optimize-demand` prompt (all reuse the same box-placement /
   * guidance / box-vocab / correction-verb blocks that encode the playbook). When
   * present, the handler enforces the cross-repo handshake: a caller's
   * `X-Personalizer-Ruleset-Version` header must match, else the request is
   * rejected (409). Entries without it (probes / chat / image-selection) skip the
   * handshake entirely.
   */
  rulesetVersion?: string;
  /**
   * OPTIONAL — when `true`, the /messages handler fetches the tenant's canonical
   * Brain default RecommendationsSettings, projects the AI-relevant per-box
   * defaults, and injects them as a cacheable SYSTEM block after the stable prompt
   * (lib/brain-defaults.ts). Set ONLY on the box-PROPOSE prompts (onboarding /
   * cart-drawer / optimize) — the ones that decide box style/fallback/limits and
   * benefit from knowing the store's defaults. Review prompts (which judge a
   * rendered result) and probes do not set it. The lib never sends the defaults;
   * app-ai fetches them server-side (no transport field).
   */
  injectsBrainDefaults?: boolean;
}

/**
 * A registry definition whose route is materialized by `getSystemPrompt(name,
 * env)`. Prompt definitions contain no provider, model, profile, file-policy, or
 * tier-binding override.
 */
type SystemPromptDefinition = Omit<
  SystemPromptEntry,
  | 'name'
  | 'tier'
  | 'model'
  | 'modelProfile'
  | 'provider'
  | 'apiFamily'
  | 'filePolicy'
  | 'capabilities'
  | 'maxTokens'
> & { maxTokens: number | typeof MODEL_MAXIMUM_OUTPUT | typeof GRADER_CHAT_REPLY_BUDGET };

const systemPrompts: Record<PromptName, SystemPromptDefinition> = {
  'image-selection': {
    group: 'image-selection',
    // Multi-file prompt: system text composed from `image-selection/prompt.md`.
    // (Its design/maintenance doc lives at docs/prompts/image-selection.md.)
    // The image-selection group runs on the fast tier.
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
  // The studio-data-agent group runs on the frontier tier.
  chat: {
    group: 'studio-data-agent',
    prompt: prompts.chat,
    maxTokens: 4096,
    usesTools: true,
    description:
      'General conversational Studio assistant; runs the tool-use agent loop to read store data.',
    attachments: [],
  },

  // Subscription and billing assistant — a no-tool `/chat` surface for the
  // subscription experience. It answers only from the request's current pricing
  // grounding, never accepts payment secrets, and cannot mutate an account or a
  // subscription. The billing-narrative group runs on the balanced tier.
  'billing-assistant': {
    group: 'billing-narrative',
    prompt: prompts.billingAssistant,
    maxTokens: 768,
    usesTools: false,
    description:
      'Subscription and billing assistant; answers only from the current plan and store-specific pricing grounding, with no tools or account mutations.',
    attachments: [],
  },

  'grader-chat': {
    group: 'grader-sales',
    prompt: prompts.composeGraderChat(newestGraderChatBookletSource()),
    maxTokens: GRADER_CHAT_REPLY_BUDGET,
    usesTools: false,
    description:
      "Growth Grader sales chat over one store's Grader report, grounded only in the marketing booklet; text only, no tools, no Studio directives, steers to installing LimeSpot.",
    attachments: [],
  },

  // Onboarding / visual chat — the CLIENT-tool twin of `chat`. Same SYSTEM
  // provider class as `chat`, but instead of the SERVER data toolset it carries the
  // CLIENT `look_at_page` tool, which executes in the merchant's BROWSER (the store
  // iframe is the AI's hands): on a `look_at_page` tool_use the /chat loop returns
  // the call in `done.toolCalls` and STOPS — the lib captures/serves a screenshot of
  // the named page, appends it as an image block on the tool_result turn, and calls
  // /chat again so the model can SEE what rendered before it answers or refines a box.
  // `clientTools` is mutually exclusive with `usesTools` (chat.ts), so this is a
  // SEPARATE entry, not a flag on `chat` — a turn is EITHER server-data-tools OR the
  // visual client tool, never both. This is the FIRST live consumer of the dormant
  // client-tool mode; the onboarding refine loop / interactive review / cart-drawer
  // chat / on-demand optimize all select it to gain visual self-inspection.
  'onboarding-chat': {
    group: 'studio-visual-agent',
    prompt: prompts.onboardingChat,
    maxTokens: 4096,
    usesTools: false,
    clientTools: [LOOK_AT_PAGE_TOOL],
    description:
      'Onboarding / visual Studio chat; same identity + tier as `chat` but its OWN system prompt (`onboarding-chat.md`) — it DROPS the server-data-tool guidance (no `get_store_analytics` / `get_entity_context` in this client-tool mode) and instead steers the model to the CLIENT `look_at_page` tool (executed in the browser: capture/serve a full-page screenshot) so it can SEE the page before it answers or refines. Runs the /chat loop in CLIENT-tool mode: a look_at_page tool_use returns done.toolCalls and stops; the lib runs it and re-calls /chat with the screenshot.',
    attachments: [],
  },

  // New-merchant onboarding assistant — opinionated, applies best-practice defaults.
  // The studio-data-agent group runs on the frontier tier.
  onboarding: {
    group: 'studio-data-agent',
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
    group: 'placement-vision',
    prompt: prompts.placement,
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
    group: 'setup-strategy',
    prompt: prompts.proposals,
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
    group: 'render-verification',
    prompt: prompts.visualVerify,
    maxTokens: 2048,
    usesTools: false,
    description:
      'Visual verification judge; given a plain-language intent + a multi-modal rendered snapshot (screenshot + cleaned HTML + console + inspection facts: computed styles / elementFromPoint hit-test / rects), returns JSON-only { pass, reason, fix }. Used by BOTH the internal test harness (free channel) and the product self-verify loop. Sonnet, no tools.',
    attachments: [],
  },
  [FREE_VISUAL_VERIFY_PROMPT]: {
    group: 'free-render-verification',
    prompt: prompts.visualVerifyFree,
    maxTokens: 1024,
    usesTools: false,
    description:
      'Protected-CI visual verification judge over an inline screenshot and inspection facts; returns JSON-only { pass, reason, fix } through the Workers AI free allocation.',
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
    group: 'onboarding-visual',
    prompt: prompts.onboardingBatch,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    injectsBrainDefaults: true,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    effort: 'low',
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
    group: 'onboarding-visual',
    prompt: prompts.onboardingBatchAll,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    injectsBrainDefaults: true,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    effort: 'medium',
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
    group: 'onboarding-visual',
    prompt: prompts.onboardingReview,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    effort: 'low',
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
  // review round-trips into one. Low effort is the fast path and content-free recovery
  // metadata selects medium effort for lean/chunk retries. Recovery keeps this same prompt
  // contract across full, lean, and parallel page-chunk calls, preserving its uploaded
  // references. JSON-only, no tools. Design:
  // docs/prompts/onboarding-review-all.md.
  'onboarding-review-all': {
    group: 'onboarding-visual',
    prompt: prompts.onboardingReviewAll,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    adaptiveEffort: { default: 'low', escalated: 'medium' },
    usesTools: false,
    description:
      'Adaptive onboarding REVIEW for the WHOLE STORE; given current pages at desktop+mobile plus round-0/clean references, plans, and history, returns compact { pages: { <page>: { pass, feedback, corrections, failureClass, issueCodes? } }, needsEscalation }. Low effort by default; medium on bounded recovery. Currency/CSS actions are outside the common response. Sonnet, no tools.',
    attachments: [],
  },

  // Onboarding QC GATE — the cascade's first pass. It classifies every dirty page from
  // bounded whole-store evidence on the fast tier and emits one compact pass/issue-code
  // verdict per page, never a correction. Only failed, uncertain, malformed, or uncovered
  // pages go on to `onboarding-review-all`. Its group borrows the onboarding-visual file
  // route, so the gate and the detailed reviewer read ONE uploaded evidence set.
  'onboarding-review-gate-all': {
    group: 'onboarding-qc-gate',
    prompt: prompts.onboardingReviewGateAll,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    usesTools: false,
    description:
      'Fast holistic onboarding QC gate over bounded desktop/mobile evidence. Returns one compact pass/issue-code verdict per page and never emits corrections; only failed, uncertain, or uncovered pages enter the balanced detailed reviewer.',
    attachments: [],
  },

  // Exceptional bounded recovery when the holistic proposal omitted the required currency verdict.
  // It reuses a compact subset of already-uploaded store tiles and returns one currency action. It
  // is not a Website-Analysis probe and does not fetch/capture anything.
  'onboarding-currency-recovery': {
    group: 'onboarding-visual',
    prompt: prompts.onboardingCurrencyRecovery,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    effort: 'low',
    usesTools: false,
    description:
      'Bounded pre-QC recovery for an omitted holistic currency verdict; selects a deterministic candidate (including none), or with no candidates returns one validated explicit six-argument format. JSON-only { visualActions: [setCurrencyFormat] }.',
    attachments: [],
  },

  // Advanced-CSS QC specialist — entered only when common QC emits `advanced-css-required`.
  // It reuses the holistic review's evidence and returns the same page verdict shape plus
  // validated managed `advancedCss` visual actions; ordinary review responses cannot.
  'onboarding-css-review': {
    group: 'onboarding-visual',
    prompt: prompts.onboardingCssReview,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    effort: 'medium',
    usesTools: false,
    description:
      'Targeted advanced-CSS QC specialist for pages the low-effort holistic review cannot repair through standard appearance keys. Returns the same page verdict shape plus only validated managed advancedCss visual actions. Sonnet, no tools.',
    attachments: [],
  },

  // Cart-drawer conductor — PROPOSE. The SINGLE-SURFACE twin of
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
    group: 'cartdrawer-visual',
    prompt: prompts.cartdrawerBatchAll,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    injectsBrainDefaults: true,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    usesTools: false,
    description:
      'Cart-drawer SINGLE-SURFACE PROPOSE; given the OPEN cart drawer (a rendered overlay) at desktop + mobile widths + the numbered candidate manifest (INSERT anchors + any REPLACE grids inside the drawer), returns { boxes: [ { boxType, position, anchorNumber, styleReferenceSelector?, appearancePatch, appearancePatchMobile, reasoning } ], progressBar?: { position, anchorNumber, reasoning } } — the `boxes` array plus the OPTIONAL Smart Progress Bar slot (the SECOND host of the bar: top of the drawer; omitted when the drawer already shows a threshold bar; no `pages` wrapper, no segments/discounts). Favors compact cross-sell/upsell strips that fit the narrow drawer below the line items and above the checkout CTA. Structured output, the conductor applies it box-by-box. Sonnet, no tools.',
    attachments: [],
  },

  // Cart-drawer conductor — REVIEW. The SINGLE-SURFACE twin of
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
    group: 'cartdrawer-visual',
    prompt: prompts.cartdrawerReviewAll,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
    usesTools: false,
    description:
      'Cart-drawer SINGLE-SURFACE REVIEW; given the OPEN cart drawer AFTER the plan was applied (desktop + mobile after-render screenshots) + the applied plan, returns a flat JSON verdict { pass, feedback, corrections, failureClass } for the drawer (no `pages` wrapper) — failureClass classifies a failure as NON-CRITICAL "placement" vs CRITICAL "styling" (including a box that overflows the narrow drawer). Corrections limited to styleBox / addBox / removeBox, each targeting the drawer implicitly (no page field). Sonnet, no tools.',
    attachments: [],
  },

  // On-demand OPTIMIZE — PROPOSE. The SINGLE-PAGE, DEMAND-FIRST twin of
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
    group: 'onboarding-visual',
    prompt: prompts.optimizeDemand,
    rulesetVersion: ONBOARDING_RULESET_VERSION,
    injectsBrainDefaults: true,
    maxTokens: MODEL_MAXIMUM_OUTPUT,
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
  // The analytics-narrative group runs on the balanced tier.
  'analytics-insights': {
    group: 'analytics-narrative',
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
  // The website-industry group runs on the frontier tier.
  'probe-industry': {
    group: 'website-industry',
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
    group: 'website-analysis-visual',
    prompt: prompts.probeCartWiring,
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
    group: 'website-analysis-visual',
    prompt: prompts.probeStyle,
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
    group: 'website-analysis-visual',
    prompt: prompts.probeTemplate,
    maxTokens: 4096,
    usesTools: false,
    description:
      'Website-analysis template probe; GENERATES a rec-box card-slot template (markup + scoped CSS only, no script/SetupObject) reproducing the merchant card from its screenshot + HTML, markup limited to the allowed grammar (allowed tags + @Ls* children, v-if/v-for/v-bind/named slots), bindings only to the product data-model. Returns JSON-only { html, css, cssScoped, baseTemplateName, confidence, notes }. Sonnet, no tools.',
    attachments: [],
  },

  // Currency-format probe — SELECT-ONLY. Given store screenshots that display real
  // prices + exactly TWO candidate KINDS (a `money` and a `money_with_currency`
  // candidate, each { candidateId, kind, hasCurrencyCode, samples: [{ amount, value }] }
  // carrying its full sample list — sent as a text block AFTER the cache breakpoint) —
  // returns the single `candidateId` whose KIND matches how prices appear on the
  // store (or `"none"`). The two candidates differ ONLY in whether a currency code
  // is printed; the model picks BETWEEN them by what the store shows. It SELECTS
  // ONLY — it MUST NOT invent or emit any prefix/suffix/delimiter/decimal-count/
  // format string; the lib's deterministic parser AGGREGATES all of the chosen
  // kind's samples to derive the concrete format. A `balanced`-tier reasoner like
  // the other visual probes; the pick is a small structured output, so a low token
  // ceiling. JSON-only, no tools.
  'probe-currency': {
    group: 'onboarding-visual',
    prompt: prompts.probeCurrency,
    maxTokens: 512,
    usesTools: false,
    description:
      'Website-analysis currency-format probe; given store screenshots showing real prices + exactly TWO candidate KINDS [{ candidateId ("<Currency>:money" | "<Currency>:money_with_currency"), kind, hasCurrencyCode, samples: [{ amount, value }] }], SELECTS the candidateId whose KIND matches the store (or "none"). Returns JSON-only { candidateId, confidence, reasoning }. Select-only — picks BETWEEN the money / money_with_currency candidates by whether a currency code is shown, never invents/emits format metadata (the lib aggregates the chosen kind\'s samples to derive the format). Sonnet, no tools.',
    attachments: [],
  },
};

/** A documented prompt transition that reuses provider-uploaded evidence. */
export interface PromptFallbackEdge {
  readonly name: string;
  readonly from: PromptName;
  readonly to: PromptName;
  readonly reusesFiles: true;
}

/** The complete fallback/retry graph whose edges retain uploaded evidence. */
export const PROMPT_FALLBACK_EDGES = [
  {
    name: 'whole-store proposal to per-page fallback',
    from: 'onboarding-batch-all',
    to: 'onboarding-batch',
    reusesFiles: true,
  },
  {
    name: 'holistic review to lean retry',
    from: 'onboarding-review-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'holistic review to page-chunk retry',
    from: 'onboarding-review-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'whole-store proposal evidence to holistic review',
    from: 'onboarding-batch-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'per-page proposal evidence to holistic review',
    from: 'onboarding-batch',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'quality gate to detailed holistic review',
    from: 'onboarding-review-gate-all',
    to: 'onboarding-review-all',
    reusesFiles: true,
  },
  {
    name: 'holistic review to advanced-CSS specialist',
    from: 'onboarding-review-all',
    to: 'onboarding-css-review',
    reusesFiles: true,
  },
  {
    name: 'holistic review evidence to currency recovery',
    from: 'onboarding-review-all',
    to: 'onboarding-currency-recovery',
    reusesFiles: true,
  },
  {
    name: 'optimize proposal to rendered review',
    from: 'optimize-demand',
    to: 'onboarding-review',
    reusesFiles: true,
  },
  {
    name: 'cart-drawer proposal to review',
    from: 'cartdrawer-batch-all',
    to: 'cartdrawer-review-all',
    reusesFiles: true,
  },
  {
    name: 'cart-drawer review correction round',
    from: 'cartdrawer-review-all',
    to: 'cartdrawer-review-all',
    reusesFiles: true,
  },
] as const satisfies readonly PromptFallbackEdge[];

/** The exact registered prompt-name inventory, in registry order. */
export function listPromptNames(): readonly PromptName[] {
  return Object.keys(systemPrompts) as PromptName[];
}

/** Whether an external selector names one of the exact registered contracts. */
export function isPromptName(name: string): name is PromptName {
  return Object.prototype.hasOwnProperty.call(systemPrompts, name);
}

/** Whether a name is one of the exact registered prompt groups. */
export function isPromptGroupName(name: string): name is PromptGroupName {
  return Object.prototype.hasOwnProperty.call(PROMPT_GROUPS, name);
}

/** The exact prompt-group inventory. */
export function listPromptGroups(): readonly PromptGroupName[] {
  return Object.keys(PROMPT_GROUPS) as PromptGroupName[];
}

/** Resolve one prompt's compatibility group without reading model configuration. */
export function getPromptGroup(name: PromptName): PromptGroupName {
  return systemPrompts[name].group;
}

/** Read one prompt-group definition. */
export function getPromptGroupDefinition(name: PromptGroupName): PromptGroupDefinition {
  return PROMPT_GROUPS[name];
}

/**
 * `MODEL_OVERRIDES` with every key checked against the registry. An override
 * naming no registered prompt or prompt group throws here rather than silently
 * doing nothing, which is the whole reason a typo is survivable configuration.
 */
function validatedModelOverrides(env: Env): ReadonlyMap<string, string> {
  const overrides = modelOverrides(env);
  for (const key of overrides.keys()) {
    if (isPromptName(key) || isPromptGroupName(key)) continue;
    throw new Error(
      `MODEL_OVERRIDES key "${key}" names no registered prompt or prompt group. ` +
        `Valid prompt groups: ${listPromptGroups().join(', ')}. ` +
        `Valid prompts: ${listPromptNames().join(', ')}.`,
    );
  }
  return overrides;
}

/** The configured model for one group, and the variable that supplied it. */
function configuredModel(
  group: PromptGroupName,
  prompt: PromptName | null,
  env: Env,
): { model: string; configuredBy: string } {
  const overrides = validatedModelOverrides(env);
  // Most specific wins: a prompt exception beats its group's, which beats the
  // group's tier binding.
  for (const key of prompt === null ? [group] : [prompt, group]) {
    const model = overrides.get(key);
    if (model !== undefined) return { model, configuredBy: `MODEL_OVERRIDES entry "${key}"` };
  }
  const tier = PROMPT_GROUPS[group].tier;
  return { model: resolveModel(env, tier), configuredBy: TIER_VARIABLE[tier] };
}

/** The configuration variable each capability tier is bound to. */
const TIER_VARIABLE: Readonly<Record<ModelTier, string>> = {
  fast: 'MODEL_FAST',
  balanced: 'MODEL_BALANCED',
  frontier: 'MODEL_FRONTIER',
};

/** The route a `/messages` request naming no registered prompt runs on. */
export interface UnregisteredMessagesRoute {
  readonly model: string;
  readonly maxTokens: number;
}

/** The fixed output budget of the unregistered-selector `/messages` passthrough. */
export const UNREGISTERED_MESSAGES_MAX_TOKENS = 4096;

/**
 * Resolve the route for a `/messages` request that names no registered prompt.
 * That path is an Anthropic-wire passthrough: the caller owns the conversation,
 * but the model and the output budget are app-ai's decision exactly as they are
 * for a registered prompt — a caller-sent `model` or `max_tokens` is replaced,
 * never honoured. The model is the `fast` tier binding, and because the
 * passthrough speaks the Anthropic Messages API and nothing else, a binding
 * that resolves elsewhere fails closed here rather than at the provider.
 */
export function getUnregisteredMessagesRoute(env: Env): UnregisteredMessagesRoute {
  const model = resolveModel(env, 'fast');
  const family = resolveModelFamily(model, TIER_VARIABLE.fast);
  if (family.provider !== 'anthropic' || family.apiFamily !== 'anthropic-messages') {
    throw new Error(
      `The unregistered /messages passthrough speaks the Anthropic Messages API, but ${TIER_VARIABLE.fast} resolves ${model} to ${family.provider}/${family.apiFamily}`,
    );
  }
  return { model, maxTokens: UNREGISTERED_MESSAGES_MAX_TOKENS };
}

/** A group's fully resolved model profile together with its direct-file policy. */
export interface ResolvedModelRoute {
  readonly profile: ModelProfile;
  readonly policy: FilePolicy;
  readonly modelProfile: ModelProfileName;
  readonly filePolicy: FilePolicyName;
}

/**
 * Resolve one route from configuration and reject it before any provider I/O.
 * The configured model id decides the provider, API family, capabilities, and
 * file policy through the catalog; this then checks those against what the
 * group asked for, so a settings-level model swap cannot quietly deliver a
 * model that cannot do the group's job.
 */
function resolveRoute(
  group: PromptGroupName,
  prompt: PromptName | null,
  env: Env,
): ResolvedModelRoute {
  const { model, configuredBy } = configuredModel(group, prompt, env);
  const family = resolveModelFamily(model, configuredBy);
  assertProviderMayServe(group, family.provider, model, configuredBy, env);
  const profile: ModelProfile = {
    name: family.profile,
    provider: family.provider,
    apiFamily: family.apiFamily,
    model,
    capabilities: family.capabilities,
  };
  const policy = getFilePolicy(family.filePolicy);
  const requirements =
    prompt === null ? PROMPT_GROUPS[group].requirements : getPromptRequiredCapabilities(prompt);
  validateResolvedGroupRoute(group, profile, policy, requirements);
  return { profile, policy, modelProfile: family.profile, filePolicy: family.filePolicy };
}

function assertProviderMayServe(
  group: PromptGroupName,
  provider: ProviderName,
  model: string,
  configuredBy: string,
  env: Env,
): void {
  if (!isProductionDeployment(env)) return;
  if (mayServeRoute(provider, PROMPT_GROUPS[group].carriesCustomerContent)) return;
  throw new WorkerError(
    `${configuredBy} routes ${group} to ${model} at ${provider}, which LimeSpot's DPA does not list as an AI sub-processor for customer content.`,
    {
      status: 503,
      exceptionType: 'ProviderNotAllowedException',
      messageDetail: 'provider_not_allowed',
    },
  );
}

/**
 * Throw unless, in production, every prompt and group, every `MODEL_OVERRIDES` entry among them,
 * resolves to a provider that may serve it, every prompt whose conversation carries earlier turns
 * (`textConversation`) or browser-owned tools (`clientTools`) resolves to a model whose family can
 * carry them across requests, and every configured provider API base is that provider's own. Outside production it checks nothing, so the adapter tests and paid smoke
 * matrices keep every catalogued provider.
 */
export function validateProviderConfiguration(env: Env): void {
  if (!isProductionDeployment(env)) return;
  validatedModelOverrides(env);
  for (const group of listPromptGroups()) checkConfiguredProvider(group, null, env);
  for (const name of listPromptNames()) checkConfiguredProvider(getPromptGroup(name), name, env);
  checkConfiguredProvider(null, null, env);
  for (const name of listPromptNames()) {
    const requirements = getPromptRequiredCapabilities(name);
    if (requirements.includes('textConversation') || requirements.includes('clientTools')) {
      getModelProfile(name, env);
    }
  }
  validateProviderBases(env);
}

function checkConfiguredProvider(
  group: PromptGroupName | null,
  prompt: PromptName | null,
  env: Env,
): void {
  if (group === null) {
    const model = resolveModel(env, 'fast');
    const provider = resolveModelFamily(model, TIER_VARIABLE.fast).provider;
    if (aiSubprocessorOf(provider) === null) {
      throw new Error(
        `${TIER_VARIABLE.fast} resolves to ${provider}, which the DPA does not list.`,
      );
    }
    return;
  }
  const { model, configuredBy } = configuredModel(group, prompt, env);
  assertProviderMayServe(
    group,
    resolveModelFamily(model, configuredBy).provider,
    model,
    configuredBy,
    env,
  );
}

/** Resolve and validate the model route one prompt group's uploads travel. */
export function getGroupModelRoute(group: PromptGroupName, env: Env): ResolvedModelRoute {
  return resolveRoute(group, null, env);
}

/**
 * Resolve and validate the model profile one registered prompt runs on.
 *
 * A prompt reads evidence uploaded on its group's file route, so its resolved
 * provider, API family, and file policy must equal that route's. A per-prompt
 * override that moves one prompt of a shared route to another provider is
 * rejected here rather than at the moment a reference fails to open.
 */
export function getModelProfile(prompt: PromptName, env: Env): ModelProfile {
  const group = getPromptGroup(prompt);
  const { profile, filePolicy } = resolveRoute(group, prompt, env);
  const route = getGroupModelRoute(getFileRouteGroup(group), env);
  if (
    route.profile.provider !== profile.provider ||
    route.profile.apiFamily !== profile.apiFamily ||
    route.filePolicy !== filePolicy
  ) {
    throw new Error(
      `Prompt ${prompt} resolves to ${profile.provider}/${profile.apiFamily}, incompatible with the ${getFileRouteGroup(group)} file route on ${route.profile.provider}/${route.profile.apiFamily}`,
    );
  }
  return profile;
}

/**
 * The group whose provider file route carries a group's evidence — itself unless it
 * borrows another group's route.
 */
export function getFileRouteGroup(name: PromptGroupName): PromptGroupName {
  return PROMPT_GROUPS[name].fileRouteGroup ?? name;
}

/** Every group whose evidence rides one group's provider file route, in registry order. */
export function listFileRouteGroups(routeGroup: PromptGroupName): readonly PromptGroupName[] {
  return listPromptGroups().filter((group) => getFileRouteGroup(group) === routeGroup);
}

/** Validate one resolved group route, including dormant/test candidate profiles. */
export function validateResolvedGroupRoute(
  routeName: string,
  profile: Pick<ModelProfile, 'name' | 'provider' | 'apiFamily' | 'capabilities'>,
  filePolicy: FilePolicy,
  requirements: readonly ModelCapabilityName[],
): void {
  if (
    filePolicy.provider !== profile.provider ||
    !filePolicy.compatibleApiFamilies.includes(profile.apiFamily)
  ) {
    throw new Error(
      `Group ${routeName} file policy ${filePolicy.name} is incompatible with profile ${profile.name}`,
    );
  }
  for (const requirement of requirements) {
    if (!profile.capabilities[requirement]) {
      throw new Error(
        `Group ${routeName} requires ${requirement}, unsupported by profile ${profile.name}`,
      );
    }
  }
}

function featureRequirements(definition: SystemPromptDefinition): readonly ModelCapabilityName[] {
  const requirements: ModelCapabilityName[] = [];
  if (definition.usesTools) requirements.push('serverTools');
  if (definition.clientTools) requirements.push('clientTools');
  if (definition.attachments.length > 0) requirements.push('reusableFiles');
  if (definition.effort || definition.adaptiveEffort) requirements.push('reasoning');
  return requirements;
}

/** All declared and feature-derived capabilities required by one prompt. */
export function getPromptRequiredCapabilities(name: PromptName): readonly ModelCapabilityName[] {
  const definition = systemPrompts[name];
  const group = PROMPT_GROUPS[definition.group];
  return [...new Set([...group.requirements, ...featureRequirements(definition)])];
}

/**
 * Validate the registry GRAPH — everything true of it without reading
 * configuration. The module invokes this once at initialization; tests also
 * call it directly as an executable architecture fitness contract. What a
 * configured model turns the graph into is `validateModelRouting(env)`.
 */
export function validatePromptRegistry(): void {
  const usedGroups = new Set<PromptGroupName>();

  for (const name of listPromptNames()) {
    const definition = systemPrompts[name];
    const group = PROMPT_GROUPS[definition.group];
    if (!group) {
      throw new Error(`Prompt ${name} references unknown group ${definition.group}`);
    }
    usedGroups.add(definition.group);

    if (definition.usesTools && definition.clientTools) {
      throw new Error(`Prompt ${name} cannot use server tools and client tools together`);
    }

    if (definition.effort && definition.adaptiveEffort) {
      throw new Error(`Prompt ${name} cannot declare a fixed effort and an adaptive effort policy`);
    }

    if (definition.clientTools?.some((tool) => tool.execution !== 'client')) {
      throw new Error(`Prompt ${name} contains a non-client tool in clientTools`);
    }

    for (const derivedRequirement of featureRequirements(definition)) {
      if (!group.requirements.includes(derivedRequirement)) {
        throw new Error(
          `Prompt ${name} uses ${derivedRequirement}, missing from group ${definition.group} requirements`,
        );
      }
    }
  }

  for (const group of listPromptGroups()) {
    if (!usedGroups.has(group)) throw new Error(`Orphan prompt group: ${group}`);
    const routeGroupName = PROMPT_GROUPS[group].fileRouteGroup;
    if (!routeGroupName) continue;
    const routeGroup = PROMPT_GROUPS[routeGroupName];
    if (!routeGroup) {
      throw new Error(`Group ${group} borrows the file route of unknown group ${routeGroupName}`);
    }
    if (routeGroup.fileRouteGroup) {
      throw new Error(`Group ${group} borrows a file route that is itself borrowed`);
    }
  }

  for (const edge of PROMPT_FALLBACK_EDGES) {
    const fromGroup = getFileRouteGroup(systemPrompts[edge.from].group);
    const toGroup = getFileRouteGroup(systemPrompts[edge.to].group);
    if (fromGroup !== toGroup) {
      throw new Error(
        `File-reusing fallback ${edge.name} crosses file routes ${fromGroup} -> ${toGroup}`,
      );
    }
  }
}

validatePromptRegistry();

/** What one registered prompt resolves to under the current configuration. */
export interface PromptRouteDescription {
  readonly name: PromptName;
  readonly group: PromptGroupName;
  readonly tier: ModelTier;
  readonly requirements: readonly ModelCapabilityName[];
  readonly model: string | null;
  readonly modelProfile: ModelProfileName | null;
  readonly provider: ProviderName | null;
  readonly apiFamily: ProviderApiFamily | null;
  readonly filePolicy: FilePolicyName | null;
  /**
   * Whether the resolved model honours the per-block cache markers this prompt's
   * canonical request carries. A `false` here is not a fault — that provider
   * caches a stable prefix implicitly — but it tells an operator which prompts
   * pay for their reuse through request ORDERING rather than through markers.
   */
  readonly inlineCacheBreakpoints: boolean | null;
  /** Whether the configured model satisfies this prompt's whole contract. */
  readonly valid: boolean;
  /** Why it does not, when it does not. */
  readonly error?: string;
}

/**
 * Describe every registered prompt against the current configuration, reporting
 * a resolution failure per prompt instead of throwing. Operator diagnostics read
 * this; correctness paths use `getModelProfile`, which throws.
 */
export function describePromptRoutes(env: Env): readonly PromptRouteDescription[] {
  return listPromptNames().map((name) => {
    const group = getPromptGroup(name);
    const shared = {
      name,
      group,
      tier: PROMPT_GROUPS[group].tier,
      requirements: getPromptRequiredCapabilities(name),
    } as const;
    try {
      const profile = getModelProfile(name, env);
      const { modelProfile, filePolicy } = resolveRoute(group, name, env);
      getSystemPrompt(name, env);
      return {
        ...shared,
        model: profile.model,
        modelProfile,
        provider: profile.provider,
        apiFamily: profile.apiFamily,
        filePolicy,
        inlineCacheBreakpoints: profile.capabilities.inlineCacheBreakpoints,
        valid: true,
      };
    } catch (error) {
      return {
        ...shared,
        model: null,
        modelProfile: null,
        provider: null,
        apiFamily: null,
        filePolicy: null,
        inlineCacheBreakpoints: null,
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/**
 * Every provider some resolved route sends inference to under this
 * configuration. Anthropic is always among them — the unregistered `/messages`
 * passthrough speaks nothing else — and a prompt whose route does not resolve
 * contributes no provider, so this never names one from a broken binding.
 */
export function providersInUse(env: Env): ReadonlySet<ProviderName> {
  const providers = new Set<ProviderName>(['anthropic']);
  for (const route of describePromptRoutes(env)) {
    if (route.provider !== null) providers.add(route.provider);
  }
  return providers;
}

/**
 * Resolve and validate every prompt and group route, and the unregistered
 * `/messages` passthrough route, under one configuration, throwing on the first
 * that cannot be served. Tests and the production `/health` readiness check
 * call it as the executable statement that the deployed model bindings fit
 * everything the worker routes.
 */
export function validateModelRouting(env: Env): void {
  for (const group of listPromptGroups()) getGroupModelRoute(group, env);
  for (const name of listPromptNames()) {
    getModelProfile(name, env);
    getSystemPrompt(name, env);
  }
  getUnregisteredMessagesRoute(env);
  assertFreeVisualVerifyRoute(env);
}

export function assertFreeVisualVerifyRoute(env: Env): void {
  const freeVisualRoute = getSystemPrompt(FREE_VISUAL_VERIFY_PROMPT, env);
  if (
    freeVisualRoute.provider !== 'cloudflare' ||
    freeVisualRoute.apiFamily !== 'cloudflare-workers-ai' ||
    freeVisualRoute.model !== BOUNDED_FREE_VISUAL_MODEL
  ) {
    throw new Error(
      `${FREE_VISUAL_VERIFY_PROMPT} must resolve to the bounded Cloudflare Workers AI model.`,
    );
  }
}

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
  'probe-currency': {
    description:
      'SELECT-ONLY currency-KIND pick from store screenshots showing real prices + exactly TWO candidates [{ candidateId ("<Currency>:money" | "<Currency>:money_with_currency"), kind ("money"|"money_with_currency"), hasCurrencyCode, samples: [{ amount, value }] }], each candidate carrying its full sample list. Returns the candidateId whose KIND matches how the store writes prices (or \'none\'); the two candidates differ ONLY in whether a currency code is shown, and the model picks BETWEEN them by what the store displays. The model never invents/emits any prefix/suffix/delimiter/decimal-count/format string — candidateId is the only load-bearing field; the lib\'s deterministic parser aggregates the chosen kind\'s samples to derive the concrete format.',
    outputSchema:
      '{ "candidateId": string (one provided id | "none"), "confidence": number (0..1), "reasoning": string }',
  },
};

/** Whether a system-prompt name is a Website-Analysis probe (`probe-<id>`). */
export function isProbeName(name: string): boolean {
  return name.startsWith(PROBE_PREFIX);
}

/** The booklet versions a deployment may select with `GRADER_CHAT_BOOKLET_VERSION`. */
export function listGraderChatBookletVersions(): readonly number[] {
  return [...prompts.graderChatBookletSources.keys()].sort((left, right) => left - right);
}

function newestGraderChatBookletSource(): string {
  const newest = listGraderChatBookletVersions().at(-1);
  const source = newest === undefined ? undefined : prompts.graderChatBookletSources.get(newest);
  if (source === undefined) throw new Error('The grader-chat prompt has no booklet.');
  return source;
}

/** The grader-chat system text and booklet a request is answered with under this configuration. */
export interface GraderChatPrompt {
  readonly prompt: string;
  readonly bookletVersion: number;
  /** The booklet's model-visible text, the part of the system text every claim is grounded in. */
  readonly booklet: string;
}

/**
 * Resolve the grader-chat system text for the configured booklet version, refusing an unknown
 * version and a booklet whose headings are not exactly the fixed ones, in order.
 */
export function getGraderChatPrompt(env: Env): GraderChatPrompt {
  const bookletVersion = graderChatBookletVersion(env);
  const source = prompts.graderChatBookletSources.get(bookletVersion);
  if (source === undefined) {
    throw new Error(
      `GRADER_CHAT_BOOKLET_VERSION ${bookletVersion} names no booklet. Known versions: ${listGraderChatBookletVersions().join(', ')}.`,
    );
  }
  const booklet = prompts.graderChatBookletText(source);
  const headings = [...prompts.graderChatBookletSections(booklet).keys()];
  if (headings.join('\n') !== prompts.GRADER_CHAT_BOOKLET_HEADINGS.join('\n')) {
    throw new Error(
      `Grader chat booklet v${bookletVersion} must have exactly these headings, in order: ${prompts.GRADER_CHAT_BOOKLET_HEADINGS.join(', ')}.`,
    );
  }
  return { prompt: prompts.composeGraderChat(source), bookletVersion, booklet };
}

/**
 * Get a system prompt entry by name with its complete group-owned route.
 * Throws on an unknown name and on a missing configured model binding.
 */
export function getSystemPrompt(name: string, env: Env): SystemPromptEntry {
  const definition = systemPrompts[name as PromptName];
  if (!definition) {
    throw new Error(`System prompt not found: ${name}`);
  }
  const promptName = name as PromptName;
  const { profile, modelProfile, filePolicy } = resolveRoute(definition.group, promptName, env);
  return {
    ...definition,
    name: promptName,
    tier: PROMPT_GROUPS[definition.group].tier,
    maxTokens: resolveOutputBudget(definition.maxTokens, profile.model, env),
    model: profile.model,
    modelProfile,
    provider: profile.provider,
    apiFamily: profile.apiFamily,
    filePolicy,
    capabilities: profile.capabilities,
  };
}

function resolveOutputBudget(
  budget: SystemPromptDefinition['maxTokens'],
  model: string,
  env: Env,
): number {
  if (budget === MODEL_MAXIMUM_OUTPUT) return modelMaxOutputTokens(model);
  if (budget === GRADER_CHAT_REPLY_BUDGET) return graderChatMaxReplyTokens(env);
  return budget;
}
