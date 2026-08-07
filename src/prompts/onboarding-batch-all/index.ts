/**
 * Onboarding BATCH — PROPOSE the WHOLE store in ONE holistic call. Same per-page
 * reasoning as `onboarding-batch`, but the ONLY prompt that ALSO composes the
 * three OFF-PAGE blocks (audience segments + discount specs + the store-wide
 * output envelope) — appended AFTER the on-page output+rules so the box/PB portion
 * stays byte-identical. STABLE order = the cacheable prefix (frozen). Byte-pinned
 * by test/onboarding-prompt-blocks.test.ts. Design: docs/prompts/onboarding-batch.md.
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
import blockAudienceSegments from '../onboarding-shared/_block-audience-segments.md';
import blockDiscountSpecs from '../onboarding-shared/_block-discount-specs.md';
import blockStoreWideOutput from '../onboarding-shared/_block-store-wide-output.md';
import batchAllIntro from './_intro.md';
import batchAllReceive from './_receive.md';
import batchAllCatalogNote from './_catalog-note.md';
import batchAllPbDetail from './_pb-detail.md';
import batchAllAppearanceKeys from './_appearance-keys.md';
import batchAllOutputAndRules from './_output-and-rules.md';

export default composePrompt(
  batchAllIntro,
  blockFixedRules,
  sharedMobileFirst,
  sharedJsonHardening,
  blockBoxPlacement,
  batchAllReceive,
  sharedGuidance,
  sharedBoxVocab,
  batchAllCatalogNote,
  blockPbPlacement,
  batchAllPbDetail,
  sharedAppearanceHeader,
  batchAllAppearanceKeys,
  sharedMobileRule,
  batchAllOutputAndRules,
  blockAudienceSegments,
  blockDiscountSpecs,
  blockStoreWideOutput,
  sharedJsonTail,
);
