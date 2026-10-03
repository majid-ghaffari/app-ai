import { composePrompt } from '../_compose';
import sharedChatFormatting from '../assistant-shared/_shared-chat-formatting.md';
import graderIdentity from './_identity.md';
import graderBoundaries from './_boundaries.md';
import bookletV1 from './booklets/v1.md';
import bookletV2 from './booklets/v2.md';

/** The fixed headings of a Grader chat marketing booklet, in order. */
export const GRADER_CHAT_BOOKLET_HEADINGS = [
  'What LimeSpot does',
  'Claims we may make',
  'Prices we may state',
  'Never say',
  'Objections',
  'Handoff',
] as const;

/** Every marketing booklet file, keyed by the version `GRADER_CHAT_BOOKLET_VERSION` names. */
export const graderChatBookletSources: ReadonlyMap<number, string> = new Map([
  [1, bookletV1],
  [2, bookletV2],
]);

/** The model-visible text of a booklet file: its HTML-comment editor notes removed. */
export function graderChatBookletText(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/gu, '').trim();
}

/**
 * The grader-chat system text: the platform-neutral Grader identity, the one Grader boundaries
 * block, the shared chat-bubble formatting block, and the booklet, the only part that names a
 * platform.
 */
export function composeGraderChat(bookletSource: string): string {
  return composePrompt(
    graderIdentity,
    graderBoundaries,
    sharedChatFormatting,
    graderChatBookletText(bookletSource),
  );
}

/** A booklet's sections by heading, in file order. */
export function graderChatBookletSections(booklet: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  let heading: string | null = null;
  let body: string[] = [];
  for (const line of booklet.split('\n')) {
    const match = /^## (.+?)\s*$/u.exec(line);
    if (match?.[1] !== undefined) {
      if (heading !== null) sections.set(heading, body.join('\n').trim());
      heading = match[1];
      body = [];
      continue;
    }
    body.push(line);
  }
  if (heading !== null) sections.set(heading, body.join('\n').trim());
  return sections;
}
