/** Provider-neutral cache-intent placement for growing canonical conversations. */

import type { InferenceContent, InferenceMessage } from '../lib/inference-types';

/** External compatibility marker that reserves the terminal stable input-prefix block. */
export const STABLE_CACHE_PREFIX_MARKER = 'limespot_stable_cache_prefix';

/** Apply short-lived breakpoints while preserving every extended stable-prefix intent. */
export function applyCanonicalConversationBreakpoints(
  messages: InferenceMessage[],
  maxBreakpoints: number,
  interval = 15,
): void {
  const content = messages
    .filter((message) => message.role !== 'system')
    .flatMap((message) => message.content.flatMap(cacheableContent));
  for (const item of content) {
    if (item.cache === 'short') setCache(item, 'none');
  }
  const extended = content.filter((item) => item.cache === 'extended');
  for (const item of extended.slice(0, -1)) setCache(item, 'none');
  const eligible = content.filter((item) => item.cache !== 'extended');
  let placed = 0;
  for (let index = eligible.length - 1; index >= 0 && placed < maxBreakpoints; index -= interval) {
    const item = eligible[index];
    if (item) {
      setCache(item, 'short');
      placed += 1;
    }
  }
}

/** Whether the conversation carries a stable provider-file prefix breakpoint. */
export function hasExtendedFilePrefix(messages: readonly InferenceMessage[]): boolean {
  return messages.some((message) =>
    message.content.some(
      (content) =>
        (content.type === 'image' || content.type === 'document') && content.cache === 'extended',
    ),
  );
}

function setCache(content: InferenceContent, cache: InferenceContent['cache']): void {
  (content as { cache: InferenceContent['cache'] }).cache = cache;
}

/** Allocate the Anthropic-parity four cache intents before adapter serialization. */
export function allocateSingleTurnCache(
  messages: InferenceMessage[],
  systemCacheBlocks: number,
  attachmentCount: number,
  maxCacheBlocks = 4,
): void {
  // Caller wire cache markers are advisory only. Clear every nested document
  // marker across the full history before allocating the canonical budget.
  for (const message of messages) {
    for (const item of message.content) {
      if (
        item.type === 'document' &&
        item.source.type === 'content' &&
        Array.isArray(item.source.content)
      ) {
        for (const nested of item.source.content) setCache(nested, 'none');
      }
    }
  }
  const first = messages[0];
  if (!first) return;
  const content = [...first.content];
  const stablePrefix = [...content]
    .slice(attachmentCount)
    .reverse()
    .find((item) => item.cache === 'extended');
  const stableSlots = stablePrefix && systemCacheBlocks < maxCacheBlocks ? 1 : 0;
  let remainingAttachmentSlots = Math.max(0, maxCacheBlocks - systemCacheBlocks - stableSlots);
  let keptAttachments = 0;
  for (const attachment of content.slice(0, attachmentCount)) {
    if (attachment.cache !== 'extended') continue;
    if (remainingAttachmentSlots > 0) {
      keptAttachments += 1;
      remainingAttachmentSlots -= 1;
    } else {
      setCache(attachment, 'none');
    }
  }
  const remaining = Math.max(0, maxCacheBlocks - systemCacheBlocks - stableSlots - keptAttachments);
  const ranked = content
    .slice(attachmentCount)
    .filter((item) => item !== stablePrefix && (item.type === 'image' || item.type === 'document'))
    .sort((left, right) => Number(right.type === 'image') - Number(left.type === 'image'));
  ranked.forEach((item, index) => setCache(item, index < remaining ? 'extended' : 'none'));
  messages[0] = { ...first, content };
}

function cacheableContent(content: InferenceContent): InferenceContent[] {
  if (
    content.type === 'document' &&
    content.source.type === 'content' &&
    Array.isArray(content.source.content)
  ) {
    return [content, ...content.source.content];
  }
  return [content];
}
