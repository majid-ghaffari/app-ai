import { composePrompt } from '../_compose';
import { agentsMasterRules } from '../assistant-shared/agents-master-rules';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import optimizationIdentity from '../optimization-shared/_identity.md';
import optimizationStep from '../optimization-shared/_step.md';
import optimizationWords from '../optimization-shared/_words.md';
import perAudienceOffers from '../optimization-shared/_per-audience-offers.md';
import bundlesArea from './_area.md';

/**
 * The Optimization conductor's Bundle Discounts step: the Optimization identity, the agents master
 * rules, the shared step and words blocks, then this area and the shared per-audience offers block
 * with its output contract, final newline included, byte-pinned by test/optimization-prompts.test.ts.
 */
export default `${composePrompt(optimizationIdentity, agentsMasterRules, optimizationStep, optimizationWords, bundlesArea, perAudienceOffers, sharedJsonTail)}\n`;
