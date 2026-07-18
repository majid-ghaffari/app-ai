/**
 * Onboarding BATCH — REVIEW the WHOLE store in ONE call (the QC-side twin of
 * `onboarding-batch-all`). Same per-page verdict reasoning as `onboarding-review`,
 * over every applied page at once. STABLE order = the cacheable prefix (frozen).
 * Byte-pinned by test/onboarding-prompt-blocks.test.ts. Design:
 * docs/prompts/onboarding-review-all.md.
 */
import { composePrompt } from '../_compose';
import sharedJsonHardening from '../onboarding-shared/_shared-json-hardening.md';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import sharedBoxVocabReview from '../onboarding-shared/_shared-box-vocab-review.md';
import sharedCorrectionVerbs from '../onboarding-shared/_shared-correction-verbs.md';
import sharedReviewClassify from '../onboarding-shared/_shared-review-classify.md';
import reviewAllIntro from './_intro.md';
import reviewAllWhyAndReceive from './_why-and-receive.md';
import reviewAllClassifyTail from './_classify-tail.md';
import reviewAllCorrectionVerbsDetail from './_correction-verbs-detail.md';
import reviewAllOutputAndRules from './_output-and-rules.md';

export default composePrompt(
  reviewAllIntro,
  sharedJsonHardening,
  reviewAllWhyAndReceive,
  sharedReviewClassify,
  reviewAllClassifyTail,
  sharedCorrectionVerbs,
  reviewAllCorrectionVerbsDetail,
  sharedBoxVocabReview,
  reviewAllOutputAndRules,
  sharedJsonTail,
);
