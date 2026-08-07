/**
 * On-demand OPTIMIZE (#98) — PROPOSE. The SINGLE-PAGE, DEMAND-FIRST twin of
 * `onboarding-batch`: composes exactly like it but slots the NEW shared
 * `_block-user-demand` block right after the intro so the merchant's typed request
 * frames the whole plan. Only the optimize-specific fragments (this folder) are
 * authored. STABLE order = the cacheable prefix (frozen). Design:
 * docs/prompts/optimize-demand.md.
 *
 * `_output-and-rules.md` requires the no-change case to emit a ZERO-LENGTH `boxes: []`
 * (never `[{}]` / placeholder objects) — shown as an explicit worked example — so a
 * genuine zero-box optimization is a WELL-FORMED empty proposal, not a sanitize-to-empty degrade.
 */
import { composePrompt } from '../_compose';
import sharedMobileFirst from '../onboarding-shared/_shared-mobile-first.md';
import sharedJsonHardening from '../onboarding-shared/_shared-json-hardening.md';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import sharedGuidance from '../onboarding-shared/_shared-guidance.md';
import sharedBoxVocab from '../onboarding-shared/_shared-box-vocab.md';
import sharedMobileRule from '../onboarding-shared/_shared-mobile-rule.md';
import sharedAppearanceHeader from '../onboarding-shared/_shared-appearance-header.md';
import blockBoxPlacement from '../onboarding-shared/_block-box-placement.md';
import blockUserDemand from '../onboarding-shared/_block-user-demand.md';
import optimizeDemandIntro from './_intro.md';
import optimizeDemandReceive from './_receive.md';
import optimizeDemandAppearanceKeys from './_appearance-keys.md';
import optimizeDemandOutputAndRules from './_output-and-rules.md';

export default composePrompt(
  optimizeDemandIntro,
  blockUserDemand,
  sharedMobileFirst,
  sharedJsonHardening,
  blockBoxPlacement,
  optimizeDemandReceive,
  sharedGuidance,
  sharedBoxVocab,
  sharedAppearanceHeader,
  optimizeDemandAppearanceKeys,
  sharedMobileRule,
  optimizeDemandOutputAndRules,
  sharedJsonTail,
);
