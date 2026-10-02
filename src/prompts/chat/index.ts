import { composePrompt } from '../_compose';
import sharedChatFormatting from '../assistant-shared/_shared-chat-formatting.md';
import studioIdentity from './_studio-identity.md';
import studioContext from './_studio-context.md';
import studioDirectives from './_studio-directives.md';

/**
 * Studio chat: this prompt's Studio identity, naming the platforms Studio serves, and its
 * Studio-only context and directive fragments around the shared chat-bubble formatting block,
 * final newline included, byte-pinned by test/assistant-prompt-blocks.test.ts.
 */
export default `${composePrompt(studioIdentity, studioContext, sharedChatFormatting, studioDirectives)}\n`;
