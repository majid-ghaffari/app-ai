import { composePrompt } from '../_compose';
import { agentsMasterRules } from '../assistant-shared/agents-master-rules';
import sharedBoxVocab from '../onboarding-shared/_shared-box-vocab.md';
import sharedJsonTail from '../onboarding-shared/_shared-json-tail.md';
import optimizationIdentity from '../optimization-shared/_identity.md';
import optimizationStep from '../optimization-shared/_step.md';
import optimizationWords from '../optimization-shared/_words.md';
import boxesArea from './_area.md';
import boxesOutput from './_output.md';

/**
 * The Optimization conductor's Recommendation Boxes step, the words over the Merchandising Agent's
 * applied box changes: the Optimization identity, the agents master rules, the shared step and words
 * blocks, then this area, the shared box vocabulary and its output contract, final newline included,
 * byte-pinned by test/optimization-prompts.test.ts.
 */
export default `${composePrompt(optimizationIdentity, agentsMasterRules, optimizationStep, optimizationWords, boxesArea, sharedBoxVocab, boxesOutput, sharedJsonTail)}\n`;
