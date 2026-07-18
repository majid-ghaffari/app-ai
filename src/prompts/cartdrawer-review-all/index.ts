/**
 * Cart-drawer conductor (#96) — REVIEW. The SINGLE-SURFACE twin of
 * `onboarding-review-all`: reuses the shared review blocks (classify, correction
 * verbs, box vocab, JSON hardening/tail) and only authors the drawer-specific
 * fragments (this folder). STABLE order = the cacheable prefix (frozen). Design:
 * docs/prompts/cartdrawer-review-all.md.
 */
import { composePrompt } from '../_compose';
import sharedJsonHardening from '../onboarding-shared/_shared-json-hardening.md';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import sharedBoxVocabReview from '../onboarding-shared/_shared-box-vocab-review.md';
import sharedCorrectionVerbs from '../onboarding-shared/_shared-correction-verbs.md';
import sharedReviewClassify from '../onboarding-shared/_shared-review-classify.md';
import cartdrawerReviewIntro from './_intro.md';
import cartdrawerReviewWhyAndReceive from './_why-and-receive.md';
import cartdrawerReviewClassifyTail from './_classify-tail.md';
import cartdrawerReviewCorrectionVerbsDetail from './_correction-verbs-detail.md';
import cartdrawerReviewOutputAndRules from './_output-and-rules.md';

export default composePrompt(
  cartdrawerReviewIntro,
  sharedJsonHardening,
  cartdrawerReviewWhyAndReceive,
  sharedReviewClassify,
  cartdrawerReviewClassifyTail,
  sharedCorrectionVerbs,
  cartdrawerReviewCorrectionVerbsDetail,
  sharedBoxVocabReview,
  cartdrawerReviewOutputAndRules,
  sharedJsonTail,
);
