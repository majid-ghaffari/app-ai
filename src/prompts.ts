/**
 * System Prompt Registry
 *
 * Every prompt lives ONLY under `src/prompts/`. There is exactly one prompt
 * location — no second folder anywhere in the repo. The registry imports each
 * prompt's TEXT (as a string) and pairs it with that prompt's METADATA (model /
 * token / tool choices). The registry is the single source of truth — consumers
 * (handlers/chat.ts, handlers/messages.ts) read text + metadata through
 * `getSystemPrompt` instead of hardcoding them.
 *
 * ── Prompt layout convention (single vs. multi-file) ──────────────────────────
 *   • SIMPLE prompt  → one file: `src/prompts/<name>.md`
 *       e.g. chat.md, onboarding.md, placement.md, proposals.md,
 *       analytics-insights.md. Import the file and use it as `prompt`.
 *   • MULTI-FILE prompt → a folder: `src/prompts/<name>/`
 *       e.g. image-selection/. A multi-file prompt is made of parts:
 *         - `prompt.md`   — the main system prompt (required).
 *         - `<name>.md` / any additional non-underscore `.md` context part —
 *           composed into the system prompt via `composePrompt(...)` when a
 *           prompt wants extra grounding text appended after the main prompt.
 *         - a sample/attachment file (e.g. `sample.md`) — NOT part of the
 *           system prompt; wired as an `attachments` entry so it is uploaded
 *           and prepended to the first message (see handlers/messages.ts).
 *         - underscore-prefixed files (`_*.md`) — EXCLUDED from the bundle
 *           (never imported, never sent to the API), matching the LimeSpot `_`
 *           convention. Per-prompt design/maintenance docs live at
 *           `docs/prompts/<name>.md`, not inside the prompt folder.
 *   Both shapes resolve to the SAME registry entry shape below, so consumers
 *   don't care whether a prompt is single- or multi-file.
 *
 * The `.md` imports are bundled at BUILD time, NOT read from disk at runtime:
 *   • Worker (wrangler/esbuild): the `[[rules]]` Text rule in wrangler.toml
 *     (`globs = ["**\/*.md"]`) turns `import x from './x.md'` — including from
 *     nested folders like `./prompts/image-selection/prompt.md` — into the
 *     file's string contents.
 *   • Tests (vitest/vite): the inline Text-loader plugin in vitest.config.ts
 *     does the same for any `.md` (nested included), with the SAME import
 *     specifier (no `?raw` suffix).
 * Cloudflare Workers have no runtime filesystem, so `fs.readFile` is not an
 * option — everything is bundled ahead of time.
 */

// Simple (single-file) prompts.
import chatPrompt from './prompts/chat.md';
import onboardingPrompt from './prompts/onboarding.md';
import placementPrompt from './prompts/placement.md';
import proposalsPrompt from './prompts/proposals.md';
import analyticsInsightsPrompt from './prompts/analytics-insights.md';

// Multi-file prompt: image-selection. `prompt.md` is the system prompt;
// `sample.md` is uploaded as an attachment (training examples). Its
// design/maintenance doc lives at docs/prompts/image-selection.md (not bundled).
import imageSelectionPrompt from './prompts/image-selection/prompt.md';
import imageSelectionSample from './prompts/image-selection/sample.md';

import type { Effort, ToolDefinition } from './lib/anthropic';
import { modelDefault, modelPlacement, type Env } from './config';

/** A file prepended to the first message (uploaded via the Files API dedup). */
export interface PromptAttachment {
  content: string;
  mimeType: string;
  filename: string;
}

/**
 * One registry entry — the single source of truth for a prompt's text + its
 * model / token / tool choices:
 *   - prompt:      the system-prompt text (single .md, or composed via
 *                  `composePrompt` from a multi-file prompt's parts)
 *   - model:       the Anthropic model for this prompt — a deploy-time
 *                  configuration choice, resolved from the MODEL_DEFAULT /
 *                  MODEL_PLACEMENT variables (src/config.ts) when the entry is
 *                  read through `getSystemPrompt(name, env)`
 *   - maxTokens:   default max_tokens for this prompt
 *   - usesTools:   whether the agent loop sends the SERVER toolset definitions
 *                  (the integration toolsets the worker executes server→server).
 *                  Mutually exclusive with `clientTools`.
 *   - clientTools: OPTIONAL — when present, this prompt's tools execute on the
 *                  CLIENT, not in the worker. The handler sends THESE definitions
 *                  to the model (in place of the server toolset), and on a
 *                  `tool_use` it returns the calls to the client in
 *                  `done.toolCalls` and stops the turn (it never executes them).
 *                  The client runs them and calls `/chat` again with the
 *                  `tool_result`. Set `usesTools: false` alongside it. DORMANT
 *                  capability: no prompt on this branch opts in, so the handler's
 *                  client-tool branch (handlers/chat.ts) is dead code here — the
 *                  field is the typed, unused hook a client-tool prompt would set.
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
   *  field docs above + handlers/chat.ts `clientTools` handling. DORMANT here:
   *  no registry entry sets it on this branch, so it has no consumer yet. */
  clientTools?: readonly ToolDefinition[];
}

/**
 * Compose a multi-file prompt's system text from ordered parts (main prompt
 * first, then any additional non-underscore context parts). Parts are trimmed
 * and joined with a blank line. Falsy parts are skipped. Underscore-prefixed
 * files are excluded from the bundle and must NOT be passed here.
 */
function composePrompt(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part) => part.trim())
    .join('\n\n');
}

/**
 * A registry definition: a `SystemPromptEntry` whose model is still a
 * deploy-time choice (a config accessor), materialized per read by
 * `getSystemPrompt(name, env)`. Which accessor a prompt uses is registry
 * data (placement pairs with the faster placement model; everything else
 * pairs with the default model); WHICH model that resolves to is
 * configuration (wrangler [vars] / .dev.vars).
 */
type SystemPromptDefinition = Omit<SystemPromptEntry, 'model'> & {
  model: (env: Env) => string;
};

const systemPrompts: Record<string, SystemPromptDefinition> = {
  'image-selection': {
    // Multi-file prompt: system text composed from `image-selection/prompt.md`.
    // (Its design/maintenance doc lives at docs/prompts/image-selection.md.)
    prompt: composePrompt(imageSelectionPrompt),
    model: modelDefault,
    maxTokens: 4096,
    usesTools: false,
    description:
      'Analyzes page HTML + screenshot to produce CSS selectors for image/text/CTA personalization (JSON-only output). Multi-file prompt: prompt.md as the system prompt + sample.md as a training-examples attachment.',
    // `sample.md` (training examples) is uploaded once and prepended to the
    // first message as a document block (dedup + extended cache in messages.ts).
    attachments: [
      {
        content: imageSelectionSample,
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
  chat: {
    prompt: chatPrompt,
    model: modelDefault,
    maxTokens: 4096,
    usesTools: true,
    description:
      'General conversational Studio assistant; runs the tool-use agent loop to read store data.',
    attachments: [],
  },

  // New-merchant onboarding assistant — opinionated, applies best-practice defaults.
  onboarding: {
    prompt: onboardingPrompt,
    model: modelDefault,
    maxTokens: 4096,
    usesTools: true,
    description:
      'New-merchant onboarding assistant; applies best-practice defaults and runs the tool-use agent loop.',
    attachments: [],
  },

  // Placement assistant — returns ONLY a structured JSON proposal (no prose, no tools).
  placement: {
    prompt: placementPrompt,
    model: modelPlacement,
    maxTokens: 2048,
    usesTools: false,
    description: 'Structured placement proposer; one-shot JSON, no tools, faster model.',
    attachments: [],
    // No `effort`: the placement model (Haiku 4.5) does not support
    // `output_config.effort`. The handler guards on model capability and would
    // omit it regardless; setting it here would be dead config. If placement
    // moves to an effort-supporting model, add `effort: 'low'` then.
  },

  // Per-store SETUP PROPOSAL — grounds in the store's real data (via the tool-use
  // agent loop) + the best-practice catalog, returns a single structured JSON
  // proposal (boxes per page, segments, progress-bar offer+threshold, bundles).
  // Drives the onboarding's AI-driven recommendations (lib brain/proposals.ts).
  proposals: {
    prompt: proposalsPrompt,
    model: modelDefault,
    maxTokens: 4096,
    usesTools: true,
    description:
      'Per-store setup proposer; runs the tool-use agent loop to ground in real store data, returns a structured JSON proposal.',
    attachments: [],
  },

  // Analytics INSIGHTS — grounds in the merchant's real analytics data for the
  // selected period (folded into the system prompt as grounding context) and
  // returns ONLY a structured JSON array of up to three { kind, text } insights.
  // One-shot, no tools (the data is handed over as grounding, not fetched).
  // Drives Studio's per-tab AI Insights cards (lib analytics/ai-insights.tsx).
  'analytics-insights': {
    prompt: analyticsInsightsPrompt,
    model: modelDefault,
    maxTokens: 1024,
    usesTools: false,
    description:
      'Analytics insights generator; one-shot JSON array over the tab’s real data (grounding), no tools.',
    attachments: [],
  },
};

/**
 * Get a system prompt entry by name (text + metadata), with the entry's
 * deploy-time model choice resolved from configuration. Throws on an unknown
 * name (and, via the config accessors, on a missing model variable).
 */
export function getSystemPrompt(name: string, env: Env): SystemPromptEntry {
  const definition = systemPrompts[name];
  if (!definition) {
    throw new Error(`System prompt not found: ${name}`);
  }
  return { ...definition, model: definition.model(env) };
}
