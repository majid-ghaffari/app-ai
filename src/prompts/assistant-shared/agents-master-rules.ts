import { composePrompt } from '../_compose';
import agentsCore from './_shared-agents-core.md';
import agentsConversation from './_shared-agents-master.md';

/**
 * The agents master rules every conversational owner-facing prompt composes right after its
 * identity: the core, a byte-for-byte copy of limespot/root's `_standards/agent-rules-core.md`
 * that Brain's merchant agents carry too, then the rules that hold in a conversation with the owner.
 */
export const agentsMasterRules = composePrompt(agentsCore, agentsConversation);
