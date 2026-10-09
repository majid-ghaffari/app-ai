import { composePrompt } from '../_compose';
import { agentsMasterRules } from '../assistant-shared/agents-master-rules';
import billingIdentity from './_identity.md';
import billingRules from './_rules.md';

/**
 * Subscription chat: the billing assistant's identity, then the agents master rules, then its own
 * narrower scope, grounding and no-mutation rules, final newline included, byte-pinned by
 * test/assistant-prompt-blocks.test.ts.
 */
export default `${composePrompt(billingIdentity, agentsMasterRules, billingRules)}\n`;
