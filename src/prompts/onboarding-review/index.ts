/**
 * Onboarding BATCH — REVIEW one page. Composed system text: per-page REVIEW
 * fragments (this folder) + shared review blocks (classify, correction verbs,
 * box vocab, JSON hardening/tail), in a STABLE order that is the cacheable prefix
 * (frozen). Byte-pinned by test/onboarding-prompt-blocks.test.ts. Design:
 * docs/prompts/onboarding-review.md.
 */
import { composePrompt } from '../_compose';
import blockFixedRules from '../onboarding-shared/_block-fixed-rules.md';
import sharedJsonHardening from '../onboarding-shared/_shared-json-hardening.md';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import sharedBoxVocabReview from '../onboarding-shared/_shared-box-vocab-review.md';
import sharedCorrectionVerbs from '../onboarding-shared/_shared-correction-verbs.md';
import sharedReviewClassify from '../onboarding-shared/_shared-review-classify.md';
import reviewIntro from './_intro.md';
import reviewWhyAndReceive from './_why-and-receive.md';
import reviewClassifyTail from './_classify-tail.md';
import reviewCorrectionVerbsDetail from './_correction-verbs-detail.md';
import reviewOutputAndRules from './_output-and-rules.md';

export default composePrompt(
  reviewIntro,
  blockFixedRules,
  sharedJsonHardening,
  reviewWhyAndReceive,
  sharedReviewClassify,
  reviewClassifyTail,
  sharedCorrectionVerbs,
  reviewCorrectionVerbsDetail,
  sharedBoxVocabReview,
  reviewOutputAndRules,
  sharedJsonTail,
);
