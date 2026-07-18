/**
 * Cart-drawer conductor (#96) — PROPOSE. The SINGLE-SURFACE (open cart drawer)
 * twin of `onboarding-batch-all`: reuses the shared onboarding PROPOSE blocks and
 * only authors the drawer-specific fragments (this folder). STABLE order = the
 * cacheable prefix (frozen). Design: docs/prompts/cartdrawer-batch-all.md.
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
import cartdrawerBatchIntro from './_intro.md';
import cartdrawerBatchReceive from './_receive.md';
import cartdrawerBatchDrawerGuidance from './_drawer-guidance.md';
import cartdrawerBatchAppearanceKeys from './_appearance-keys.md';
import cartdrawerBatchOutputAndRules from './_output-and-rules.md';

export default composePrompt(
  cartdrawerBatchIntro,
  sharedMobileFirst,
  sharedJsonHardening,
  blockBoxPlacement,
  cartdrawerBatchReceive,
  sharedGuidance,
  sharedBoxVocab,
  cartdrawerBatchDrawerGuidance,
  sharedAppearanceHeader,
  cartdrawerBatchAppearanceKeys,
  sharedMobileRule,
  cartdrawerBatchOutputAndRules,
  sharedJsonTail,
);
