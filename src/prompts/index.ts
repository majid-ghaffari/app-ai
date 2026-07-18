/**
 * Prompt-text barrel — every registered prompt's FINAL system text as a named
 * export, so `../prompt-registry.ts` (the registry) is just `import * as prompts from
 * './prompts'`. Composed prompts (onboarding / cart-drawer / optimize twins) are
 * assembled in their own `index.ts` (fragments + shared blocks + `composePrompt`);
 * single-file / multi-file / probe / visual-verify prompts re-export their raw
 * `.md` text here. The image-selection SAMPLE is an attachment (not system text),
 * re-exported so the registry can wire it. Inventory + doc-sync: ./CLAUDE.md.
 */

// Single-file prompts (raw `.md` text used directly).
export { default as chat } from './chat.md';
export { default as onboardingChat } from './onboarding-chat.md';
export { default as onboarding } from './onboarding.md';
export { default as placement } from './placement.md';
export { default as proposals } from './proposals.md';
export { default as analyticsInsights } from './analytics-insights.md';

// Multi-file prompt: image-selection. `prompt.md` = system text; `sample.md` =
// a training-examples attachment (uploaded, prepended to the first message).
export { default as imageSelection } from './image-selection/prompt.md';
export { default as imageSelectionSample } from './image-selection/sample.md';

// Visual-verify — the quality-gate reasoner (single `prompt.md`).
export { default as visualVerify } from './visual-verify/prompt.md';

// Website-Analysis probes (each a single `prompt.md`).
export { default as probeIndustry } from './probe-industry/prompt.md';
export { default as probeCartWiring } from './probe-cart-wiring/prompt.md';
export { default as probeStyle } from './probe-style/prompt.md';
export { default as probeTemplate } from './probe-template/prompt.md';

// Composed prompts (each folder's index.ts assembles fragments + shared blocks).
export { default as onboardingBatch } from './onboarding-batch';
export { default as onboardingBatchAll } from './onboarding-batch-all';
export { default as onboardingReview } from './onboarding-review';
export { default as onboardingReviewAll } from './onboarding-review-all';
export { default as cartdrawerBatchAll } from './cartdrawer-batch-all';
export { default as cartdrawerReviewAll } from './cartdrawer-review-all';
export { default as optimizeDemand } from './optimize-demand';
