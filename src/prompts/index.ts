/**
 * Prompt-text barrel — every registered prompt's FINAL system text as a named
 * export, so `../prompt-registry.ts` (the registry) is just `import * as prompts from
 * './prompts'`. Composed prompts (onboarding / cart-drawer / optimize twins, `chat`,
 * `grader-chat`) are assembled in their own `index.ts` (fragments + shared blocks +
 * `composePrompt`); `grader-chat` exports its composition, booklet map and booklet structure,
 * because configuration picks its booklet and resolving one checks its headings;
 * single-file / multi-file / probe / visual-verify prompts re-export their raw
 * `.md` text here. The image-selection SAMPLE is an attachment (not system text),
 * re-exported so the registry can wire it. Inventory + doc-sync: ./CLAUDE.md.
 */

// Single-file prompts (raw `.md` text used directly).
export { default as billingAssistant } from './billing-assistant.md';
export { default as onboardingChat } from './onboarding-chat.md';
export { default as onboarding } from './onboarding.md';
export { default as placement } from './placement.md';
export { default as proposals } from './proposals.md';
export { default as analyticsInsights } from './analytics-insights.md';
export { default as kimiHtmlRetrieval } from './kimi-html-retrieval.md';

// Multi-file prompt: image-selection. `prompt.md` = system text; `sample.md` =
// a training-examples attachment (uploaded, prepended to the first message).
export { default as imageSelection } from './image-selection/prompt.md';
export { default as imageSelectionSample } from './image-selection/sample.md';

import visualVerify from './visual-verify/prompt.md';
export { visualVerify };
export const visualVerifyFree = visualVerify;

// Website-Analysis probes (each a single `prompt.md`).
export { default as probeIndustry } from './probe-industry/prompt.md';
export { default as probeCartWiring } from './probe-cart-wiring/prompt.md';
export { default as probeStyle } from './probe-style/prompt.md';
export { default as probeTemplate } from './probe-template/prompt.md';
export { default as probeCurrency } from './probe-currency/prompt.md';
export { default as onboardingCurrencyRecovery } from './onboarding-currency-recovery/prompt.md';
export { default as onboardingCssReview } from './onboarding-css-review/prompt.md';

// Composed prompts (each folder's index.ts assembles fragments + shared blocks).
export { default as chat } from './chat';
export {
  GRADER_CHAT_BOOKLET_HEADINGS,
  composeGraderChat,
  graderChatBookletSections,
  graderChatBookletSources,
  graderChatBookletText,
} from './grader-chat';
export { default as onboardingBatch } from './onboarding-batch';
export { default as onboardingBatchAll } from './onboarding-batch-all';
export { default as onboardingReview } from './onboarding-review';
export { default as onboardingReviewAll } from './onboarding-review-all';
export { default as onboardingReviewGateAll } from './onboarding-review-gate-all.md';
export { default as cartdrawerBatchAll } from './cartdrawer-batch-all';
export { default as cartdrawerReviewAll } from './cartdrawer-review-all';
export { default as optimizeDemand } from './optimize-demand';
