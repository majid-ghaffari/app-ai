import type { ClientActions } from '../../lib/client-actions';
import { composePrompt } from '../_compose';
import { agentsMasterRules } from './agents-master-rules';
import sharedChatFormatting from './_shared-chat-formatting.md';
import studioIdentity from './_shared-studio-identity.md';
import studioContext from './_shared-studio-context.md';
import studioGrounding from './_shared-studio-grounding.md';
import studioTeam from './_shared-studio-team.md';
import studioDirectives from './_shared-studio-directives.md';
import studioMoveBox from './_shared-studio-move-box.md';
import studioChoices from './_shared-studio-choices.md';
import studioSupport from './_shared-studio-support.md';
import studioSupportAsk from './_shared-studio-support-ask.md';

/**
 * A Studio chat's system text for a client that carries out `actions`: the Studio identity, the
 * agents master rules, the Studio context, the chat's own `toolsBlock`, the grounding, team and
 * formatting blocks, the box directives with the move-box block only for `moveBox`, the choices and
 * team directives, then Support through `requestSupport` or, without it, by asking in the chat,
 * final newline included.
 */
export function composeStudioChat(toolsBlock: string, actions: ClientActions): string {
  return `${composePrompt(
    studioIdentity,
    agentsMasterRules,
    studioContext,
    toolsBlock,
    studioGrounding,
    studioTeam,
    sharedChatFormatting,
    studioDirectives,
    actions.has('moveBox') ? studioMoveBox : '',
    studioChoices,
    actions.has('requestSupport') ? studioSupport : studioSupportAsk,
  )}\n`;
}
