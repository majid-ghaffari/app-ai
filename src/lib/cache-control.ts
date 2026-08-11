/**
 * Prompt-caching `cache_control` management for the /messages proxy.
 *
 * Anthropic allows at most 4 `cache_control` breakpoints per request. The
 * system prompt and any prompt-attachment files (uploaded by the image-selection
 * flow) each claim a slot. A caller may reserve the terminal stable user-prefix
 * block before the remaining slots are distributed across the largest user
 * content blocks (images > documents) in the first user message. The internal
 * reservation marker is stripped before forwarding, and content blocks stay in
 * their original order.
 */

import { silentLogger, type Logger } from './logger';
import type { CacheControl, CacheableBlock, ClientMessagesPayload } from './anthropic';

/** Anthropic's hard limit on cache_control breakpoints per request. */
const MAX_CACHE_BLOCKS = 4;

/** Internal user-block member that reserves the stable-prefix breakpoint. */
export const STABLE_CACHE_PREFIX_MARKER = 'limespot_stable_cache_prefix';

/**
 * Extended 1-hour cache breakpoint. Used for the STABLE prefix (system prompt,
 * reused file attachments, per-page reused user images/HTML) so the cache
 * survives traffic gaps between requests. 1h TTL is GA — no beta header needed.
 * 1h write costs 2× base input; reads are 0.1× (break-even ≥3 requests).
 */
export const EXTENDED_CACHE_CONTROL: CacheControl = { type: 'ephemeral', ttl: '1h' };

/** Rough byte-size estimates used only to rank user blocks by cache value. */
const IMAGE_SIZE_ESTIMATE = 1000000;
const DOCUMENT_SIZE_ESTIMATE = 100000;

/**
 * Mutate `claudePayload` in place so its `cache_control` breakpoints respect the
 * 4-block limit. The system prompt and the `attachmentFileCount` attachment blocks
 * prepended to the first user message each claim a slot. A user block carrying
 * `limespot_stable_cache_prefix: true` reserves the next slot; that internal member
 * is stripped from every message block before the payload leaves the worker. The
 * remaining slots are distributed across the largest user content blocks (images
 * > documents), and `cache_control` is stripped from the rest.
 *
 * @param attachmentFileCount Number of prompt-attachment blocks prepended to the
 *   first user message (exact count from the caller — never re-derived heuristically).
 */
export function manageCacheControl(
  claudePayload: ClientMessagesPayload,
  attachmentFileCount = 0,
  log: Logger = silentLogger,
): void {
  const firstMessage = claudePayload.messages?.[0];
  if (!firstMessage || !Array.isArray(firstMessage.content)) {
    stripStablePrefixMarkers(claudePayload);
    return;
  }
  const firstContent = firstMessage.content;

  // The marker rides on the block itself so prepended attachments cannot shift
  // its identity. Use the final true marker as the terminal stable-prefix block,
  // then remove every internal marker from the payload before Anthropic sees it.
  const stablePrefixBlock = findStablePrefixBlock(firstContent, attachmentFileCount);
  stripStablePrefixMarkers(claudePayload);
  // Client-supplied breakpoints outside the proxy-owned attachment prefix are never authoritative.
  // Clear them across the whole conversation before allocating the bounded user slots below; if a
  // text/tool block (or a later message) retained its marker, the ranked image count could look
  // valid while the actual Anthropic payload exceeded the global four-breakpoint limit.
  stripUnmanagedUserCacheControl(claudePayload, attachmentFileCount);

  // Count the ACTUAL cache_control breakpoints the system prefix claims — one for
  // the stable prompt, plus a second when the propose path injected a Brain-defaults
  // block (messages.ts). An array is counted precisely; a bare string prompt is one.
  let systemCacheBlocks = Array.isArray(claudePayload.system)
    ? (claudePayload.system as CacheableBlock[]).filter((block) => block.cache_control).length
    : claudePayload.system
      ? 1
      : 0;
  if (systemCacheBlocks > MAX_CACHE_BLOCKS && Array.isArray(claudePayload.system)) {
    let keptSystemBlocks = 0;
    for (const block of claudePayload.system as CacheableBlock[]) {
      if (!block.cache_control) {
        continue;
      }
      keptSystemBlocks += 1;
      if (keptSystemBlocks > MAX_CACHE_BLOCKS) {
        delete block.cache_control;
      }
    }
    systemCacheBlocks = MAX_CACHE_BLOCKS;
  }

  // Reserve the explicit stable prefix ahead of attachments only when an
  // overfull caller would otherwise consume all four slots. The normal handler
  // path has at most two system blocks and one attachment, so no attachment is
  // displaced there.
  const stablePrefixSlots = stablePrefixBlock && systemCacheBlocks < MAX_CACHE_BLOCKS ? 1 : 0;
  const attachmentSlotsAvailable = Math.max(
    0,
    MAX_CACHE_BLOCKS - systemCacheBlocks - stablePrefixSlots,
  );
  let attachmentCacheBlocks = 0;
  for (const block of firstContent.slice(0, attachmentFileCount)) {
    if (!block.cache_control) {
      continue;
    }
    if (attachmentCacheBlocks < attachmentSlotsAvailable) {
      attachmentCacheBlocks += 1;
    } else {
      delete block.cache_control;
      log.info(`Removed cache from user ${block.type ?? 'content'} (attachment slot limit)`);
    }
  }

  const usedCacheSlots = systemCacheBlocks + attachmentCacheBlocks;
  const remainingSlots = MAX_CACHE_BLOCKS - usedCacheSlots - stablePrefixSlots;

  log.info(
    `${usedCacheSlots + stablePrefixSlots}/${MAX_CACHE_BLOCKS} slots used (${systemCacheBlocks} system + ${attachmentCacheBlocks} attachments + ${stablePrefixSlots} stable prefix), ${remainingSlots} available for ranked user content`,
  );

  if (stablePrefixSlots === 1 && stablePrefixBlock) {
    stablePrefixBlock.cache_control = { ...EXTENDED_CACHE_CONTROL };
    log.info('Applied cache to explicit stable user-content prefix');
  } else if (stablePrefixBlock?.cache_control) {
    delete stablePrefixBlock.cache_control;
    log.warn('No cache slot available for explicit stable user-content prefix');
  }

  // The prepended attachment blocks are the first `attachmentFileCount` entries;
  // everything after them is user content eligible for the remaining slots.
  // Rank by estimated size (largest caches best).
  const userBlocks = firstContent
    .slice(attachmentFileCount)
    .filter((block) => block !== stablePrefixBlock)
    .map((block: CacheableBlock) => ({
      block,
      size:
        block.type === 'image'
          ? IMAGE_SIZE_ESTIMATE
          : block.type === 'document'
            ? DOCUMENT_SIZE_ESTIMATE
            : 0,
    }))
    .filter((item) => item.size > 0);

  if (remainingSlots > 0) {
    userBlocks.sort((a, b) => b.size - a.size);

    userBlocks.slice(0, remainingSlots).forEach((item) => {
      item.block.cache_control = { ...EXTENDED_CACHE_CONTROL };
      log.info(`Applied cache to user ${item.block.type} (~${Math.round(item.size / 1024)}KB)`);
    });

    userBlocks.slice(remainingSlots).forEach((item) => {
      if (item.block.cache_control) {
        delete item.block.cache_control;
        log.info(`Removed cache from user ${item.block.type} (insufficient slots)`);
      }
    });
  } else {
    userBlocks.forEach((item) => {
      if (item.block.cache_control) {
        delete item.block.cache_control;
        log.info(`Removed cache from user ${item.block.type} (no slots available)`);
      }
    });
  }
}

function findStablePrefixBlock(
  firstContent: CacheableBlock[],
  attachmentFileCount: number,
): CacheableBlock | undefined {
  for (let index = firstContent.length - 1; index >= attachmentFileCount; index -= 1) {
    const block = firstContent[index];
    if (block?.[STABLE_CACHE_PREFIX_MARKER] === true) {
      return block;
    }
  }
  return undefined;
}

function stripStablePrefixMarkers(claudePayload: ClientMessagesPayload): void {
  for (const message of claudePayload.messages ?? []) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (STABLE_CACHE_PREFIX_MARKER in block) {
        delete block[STABLE_CACHE_PREFIX_MARKER];
      }
    }
  }
}

function stripUnmanagedUserCacheControl(
  claudePayload: ClientMessagesPayload,
  attachmentFileCount: number,
): void {
  for (
    let messageIndex = 0;
    messageIndex < (claudePayload.messages?.length ?? 0);
    messageIndex += 1
  ) {
    const content = claudePayload.messages?.[messageIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      if (messageIndex === 0 && blockIndex < attachmentFileCount) continue;
      const block = content[blockIndex];
      if (block) delete block.cache_control;
    }
  }
}
