/**
 * Onboarding BATCH — PROPOSE one page. Composed system text: per-page PROPOSE
 * fragments (this folder) + shared onboarding blocks, in a STABLE order that is
 * the cacheable prefix (a reorder busts the cache — frozen). Byte-pinned by
 * test/onboarding-prompt-blocks.test.ts. Design: docs/prompts/onboarding-batch.md.
 */
import { composePrompt } from '../_compose';
import blockFixedRules from '../onboarding-shared/_block-fixed-rules.md';
import sharedMobileFirst from '../onboarding-shared/_shared-mobile-first.md';
import sharedJsonHardening from '../onboarding-shared/_shared-json-hardening.md';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import sharedGuidance from '../onboarding-shared/_shared-guidance.md';
import sharedBoxVocab from '../onboarding-shared/_shared-box-vocab.md';
import sharedMobileRule from '../onboarding-shared/_shared-mobile-rule.md';
import sharedAppearanceHeader from '../onboarding-shared/_shared-appearance-header.md';
import blockBoxPlacement from '../onboarding-shared/_block-box-placement.md';
import blockPbPlacement from '../onboarding-shared/_block-pb-placement.md';
import batchIntro from './_intro.md';
import batchReceive from './_receive.md';
import batchCatalogNote from './_catalog-note.md';
import batchPbDetail from './_pb-detail.md';
import batchAppearanceKeys from './_appearance-keys.md';
import batchOutputAndRules from './_output-and-rules.md';

export default composePrompt(
  batchIntro,
  blockFixedRules,
  sharedMobileFirst,
  sharedJsonHardening,
  blockBoxPlacement,
  batchReceive,
  sharedGuidance,
  sharedBoxVocab,
  batchCatalogNote,
  blockPbPlacement,
  batchPbDetail,
  sharedAppearanceHeader,
  batchAppearanceKeys,
  sharedMobileRule,
  batchOutputAndRules,
  sharedJsonTail,
);
