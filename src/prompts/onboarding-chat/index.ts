import { NO_CLIENT_ACTIONS, type ClientActions } from '../../lib/client-actions';
import { composeStudioChat } from '../assistant-shared/studio-chat';
import lookAtPage from './_look-at-page.md';

/**
 * Studio chat with the `look_at_page` client tool, for a client that carries out `actions`:
 * `chat`'s blocks in `chat`'s order, with the look-at-page block in place of the server data
 * tools, byte-pinned by test/assistant-prompt-blocks.test.ts.
 */
export function composeOnboardingChat(actions: ClientActions): string {
  return composeStudioChat(lookAtPage, actions);
}

export default composeOnboardingChat(NO_CLIENT_ACTIONS);
