import { composePrompt } from '../_compose';
import { agentsMasterRules } from '../assistant-shared/agents-master-rules';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import optimizationIdentity from '../optimization-shared/_identity.md';
import optimizationStep from '../optimization-shared/_step.md';
import optimizationWords from '../optimization-shared/_words.md';
import adsAudiencesArea from './_area.md';
import adsAudiencesOutput from './_output.md';

/**
 * The Optimization conductor's Google Ads & Audiences step: the Optimization identity, the agents
 * master rules, the shared step and words blocks, then this area and its output contract, final
 * newline included, byte-pinned by test/optimization-prompts.test.ts.
 */
export default `${composePrompt(optimizationIdentity, agentsMasterRules, optimizationStep, optimizationWords, adsAudiencesArea, adsAudiencesOutput, sharedJsonTail)}\n`;
