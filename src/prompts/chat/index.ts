import { NO_CLIENT_ACTIONS, type ClientActions } from '../../lib/client-actions';
import { composeStudioChat } from '../assistant-shared/studio-chat';
import dataTools from './_data-tools.md';

/**
 * Studio chat for a client that carries out `actions`: the Studio chat blocks with this chat's
 * server data tools, byte-pinned by test/assistant-prompt-blocks.test.ts.
 */
export function composeChat(actions: ClientActions): string {
  return composeStudioChat(dataTools, actions);
}

export default composeChat(NO_CLIENT_ACTIONS);
