/**
 * dev-shim-cache.mjs — the on-disk record/replay response cache for the dev
 * Claude-Code shim (`scripts/dev-claude-shim.mjs`).
 *
 * WHY: the shim fulfils inference through Claude Code, which is free but SLOW —
 * a full five-page Studio onboarding run costs minutes of model time, which
 * makes fidelity-critical end-to-end specs painful to iterate on. This module
 * lets a repeated identical call replay from disk instead of re-running the
 * model. It is dev-only tooling: never imported by `src/`, never bundled, never
 * run in production.
 *
 * ── WHAT THE KEY IS DERIVED FROM ────────────────────────────────────────────
 *
 * SHA-256 over the canonical (recursively key-sorted) JSON of:
 *
 *   { cacheFormat, transport, model, contextId, attachmentIdentity,
 *     body: normalizeRequestBody(body) }
 *
 *   - `transport`      — 'messages' (non-stream) vs 'stream' (SSE). The two
 *                        record different payloads and must never cross-serve.
 *   - `model`          — the EFFECTIVE model (the request's, else the shim
 *                        default), so changing SHIM_DEFAULT_MODEL invalidates.
 *   - `contextId`      — the tool bridge calls Personalizer with it, so a
 *                        different store can produce a different answer.
 *   - `attachmentIdentity` — which attachment rule below produced the key, so
 *                        the two modes can never read each other's entries.
 *   - `body`           — the FULL request body (system, messages, tools,
 *                        max_tokens, output_config, cache_control markers, …),
 *                        verbatim except for the normalization below.
 *
 * Matching is EXACT on that material. There is no approximate match and no
 * "closest entry" fallback: anything that is not a byte-for-byte key match is a
 * miss, and a miss records fresh.
 *
 * ── WHY THE BODY IS NORMALIZED FIRST ────────────────────────────────────────
 *
 * Hashing the raw body cannot hit, because the worker's own flows put values in
 * it that are freshly minted on every run and identify nothing:
 *
 *   1. `{type:'image'|'document', source:{type:'file', file_id}}` — the shim
 *      mints a brand-new `file_dev_…` id for every upload, so the onboarding
 *      screenshot flow carries a different id each run.
 *   2. `tool_use.id` / `tool_result.tool_use_id` — minted per turn by the model
 *      and echoed back into every subsequent request body by the client tool
 *      loop, so turn 2 onwards of ANY tool conversation is unrepeatable.
 *   3. WHICH attachment positions happen to share one upload. The worker dedupes
 *      uploads by content, so two tiles that render byte-identically arrive as
 *      ONE `file_id` referenced twice — and as two separate ids on the next run,
 *      when the same two tiles differ by a pixel. Numbering an attachment by the
 *      IDENTITY of its id therefore shifts every later ordinal the moment a
 *      duplicate appears or stops appearing.
 *
 * Content-hashing the attachment bytes does not help either: a fresh screenshot
 * of a live store is never byte-identical to the last one.
 *
 * So normalization replaces exactly those VOLATILE IDENTITY values — and
 * nothing else — with ordinal placeholders assigned in document order:
 *
 *   - a `file` source's `file_id`   → `<shim-cache:file:N>`, N counting
 *     attachments in DOCUMENT ORDER — the block's POSITION, never the id's
 *     identity, so one deduped upload keys the same as two separate ones
 *   - an inline `base64` source's `data` → `<shim-cache:bytes:N>` the same way
 *     (`media_type` is kept: a media-type change IS semantic)
 *   - `tool_use.id` and `tool_result.tool_use_id` → `<shim-cache:tool:N>`, from
 *     ONE shared id→ordinal map. Identity, deliberately, and unlike attachments:
 *     which result answers which call is prompt STRUCTURE, it is stable for a
 *     given conversation shape, and it must contribute to the key
 *
 * Every other member is hashed verbatim. A changed prompt, system block, tool
 * schema, `max_tokens`, effort, or tool-result CONTENT therefore misses.
 *
 * ── THE LIMITATION THIS BUYS, STATED PLAINLY ────────────────────────────────
 *
 * Under the default rule an attachment contributes its POSITION and its source
 * KIND and nothing else, so two calls whose only difference is the attached
 * image — or whether two of those images arrived as one deduped upload or two —
 * get the SAME key and the SAME cached answer. For deterministic replay of a
 * known scenario that is exactly the intent. It is WRONG for a test whose whole
 * purpose is to vary the image and observe a different answer — such a test must
 * run with `SHIM_CACHE_ATTACHMENT_BYTES=1`, which keys attachments by a SHA-256
 * of their bytes instead (an unresolvable file id then keys by the raw id, so it
 * fails toward a miss, never toward a wrong hit), or with the cache off
 * entirely.
 *
 * Normalization erases volatile IDENTITY, never volatile CONTENT: a tool result
 * whose text differs between runs still misses, loudly, as it should.
 *
 * ── ON-DISK LAYOUT ──────────────────────────────────────────────────────────
 *
 *   <SHIM_CACHE_DIR, default ../.dev-cache/claude-shim relative to this file>
 *     <sha256-hex>.json      one entry per recorded call
 *
 * Each entry is self-describing:
 *
 *   {
 *     "cacheFormat": 1,                 // bumped when the layout or the key
 *                                       //   derivation changes; a mismatch is
 *                                       //   an automatic miss
 *     "key": "<sha256-hex>",            // re-checked against the filename key
 *     "transport": "messages"|"stream",
 *     "model": "…", "contextId": "…",
 *     "attachmentIdentity": "placeholder"|"digest",
 *     "recordedAt": "<ISO-8601>",
 *     "label": "…",                     // ADVISORY ONLY — a human triage hint,
 *                                       //   never read back for matching
 *     "response": { … }                 // transport "messages"
 *     "frames": [{ "event", "data" }]   // transport "stream", in emission order
 *   }
 *
 * The directory is disposable and gitignored: `rm -rf` it to invalidate
 * everything. Entries can contain store data — they are never committed.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Entry-format version. Bump it whenever the key derivation or the entry
 * envelope changes: every existing entry then reads as unusable and is
 * re-recorded, rather than replaying an answer keyed under older rules.
 */
export const CACHE_FORMAT_VERSION = 2;

/**
 * Default cache directory, resolved from THIS FILE's location rather than the
 * process working directory, so the shim writes to the same place no matter
 * where it was started from.
 */
const DEFAULT_CACHE_DIRECTORY = fileURLToPath(
  new URL('../.dev-cache/claude-shim', import.meta.url),
);

/** The truthy spellings the shim already accepts for its boolean env flags. */
const TRUTHY = /^(1|true|yes|on)$/i;

/** Their mirror image, for the one flag that is an opt-OUT rather than an opt-in. */
const FALSY = /^(0|false|no|off)$/i;

/**
 * Read `env[name]`, returning `fallback` when unset/empty. Bracket access plus
 * an explicit fallback ARGUMENT (never an inline `||` / `??` on the env read),
 * matching the shim's own `envOr` so the env-fallback fitness scan over
 * `scripts/` stays green.
 */
function envValue(env, name, fallback) {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Is the cache on? ON BY DEFAULT — `SHIM_CACHE` is an opt-OUT, not an opt-in:
 * `SHIM_CACHE=0` (also `false`/`no`/`off`) turns recording and replay off, and
 * anything else, including unset, leaves them on.
 *
 * The hazard that default carries is real and does not go away: someone who does
 * not know the cache exists could be handed a recorded answer they cannot tell
 * from a fresh one. It is paid for by being LOUD rather than by being off — the
 * shim reports its cache state and its running HIT/MISS/RECORD counts on
 * `GET /health`, marks EVERY served response with an `x-dev-shim-cache:
 * hit|miss|off` header, and logs every outcome. A caller that wants to know
 * whether an answer came off disk can always find out without reading a log.
 */
export function cacheEnabled(env = process.env) {
  return !FALSY.test(envValue(env, 'SHIM_CACHE', ''));
}

/** Where entries live. `SHIM_CACHE_DIR` overrides the default directory. */
export function cacheDirectory(env = process.env) {
  return envValue(env, 'SHIM_CACHE_DIR', DEFAULT_CACHE_DIRECTORY);
}

/**
 * How attachments contribute to the key: `'placeholder'` (default — position
 * only, so a re-captured screenshot still hits) or `'digest'` (a SHA-256 of the
 * bytes, for a test that varies the image on purpose), via
 * `SHIM_CACHE_ATTACHMENT_BYTES=1`.
 */
export function attachmentIdentityMode(env = process.env) {
  return TRUTHY.test(envValue(env, 'SHIM_CACHE_ATTACHMENT_BYTES', '')) ? 'digest' : 'placeholder';
}

/** Should the shim throw away every recorded entry at startup? `SHIM_CACHE_RESET=1`. */
export function cacheResetRequested(env = process.env) {
  return TRUTHY.test(envValue(env, 'SHIM_CACHE_RESET', ''));
}

/**
 * Delete every recorded entry — the callable form of `rm -rf <directory>`, for
 * starting a run from a known-empty cache. Absent directory is a no-op.
 */
export function clearCacheDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
}

// ── Normalization ────────────────────────────────────────────────────────────

/** SHA-256 hex of a string or byte buffer. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * A placeholder token for one normalized value. The `shim-cache:` prefix cannot
 * collide with a real file id, tool-use id, or base64 payload.
 */
function placeholder(kind, ordinal) {
  return `<shim-cache:${kind}:${ordinal}>`;
}

/**
 * Ordinal for `identity` within `assigned`, allocating one on first sight — so a
 * value seen twice keys as the SAME ordinal both times. Used for tool ids only,
 * where that repetition is the linkage the key must carry.
 */
function ordinalFor(assigned, identity) {
  const existing = assigned.get(identity);
  if (typeof existing === 'number') return existing;
  const next = assigned.size + 1;
  assigned.set(identity, next);
  return next;
}

/**
 * Replace the volatile-identity values in a request body with stable ordinal
 * placeholders (see the module header for exactly which values and why).
 * Returns a normalized CLONE — the caller's body is never mutated.
 *
 * @param {unknown} body The parsed request body.
 * @param {{ attachmentIdentity?: 'placeholder'|'digest',
 *           attachmentBytes?: (fileId: string) => Uint8Array|null }} [options]
 *   `attachmentBytes` resolves a `file_id` to its stored bytes; it is only
 *   consulted in `'digest'` mode, where an unresolvable id keys by the raw id
 *   (a guaranteed miss) rather than silently collapsing to a positional match.
 */
export function normalizeRequestBody(body, options = {}) {
  const mode = options.attachmentIdentity === 'digest' ? 'digest' : 'placeholder';
  const resolveBytes =
    typeof options.attachmentBytes === 'function' ? options.attachmentBytes : null;
  // POSITION counters, not identity maps: an attachment is numbered by where it
  // sits among the attachments of its kind, so a `file_id` the worker deduped
  // across two positions numbers exactly like two separate uploads would. See
  // the module header — keying attachment ordinals to identity is what made two
  // runs of one onboarding call differ, and it can only ever differ, because
  // whether two live screenshots come out byte-identical is not repeatable.
  const attachmentPositions = { file: 0, bytes: 0 };
  // ONE map for both tool_use.id and tool_result.tool_use_id, so a result keeps
  // pointing at the same ordinal as the call it answers.
  const toolOrdinals = new Map();

  /** The key material standing in for a `file` source's id. */
  function fileIdentity(fileId) {
    if (mode === 'digest') {
      const bytes = resolveBytes ? resolveBytes(fileId) : null;
      return bytes
        ? `<shim-cache:file:sha256:${sha256(bytes)}>`
        : `<shim-cache:file:raw:${fileId}>`;
    }
    attachmentPositions.file += 1;
    return placeholder('file', attachmentPositions.file);
  }

  /** The key material standing in for an inline base64 payload. */
  function inlineIdentity(data) {
    if (mode === 'digest') return `<shim-cache:bytes:sha256:${sha256(data)}>`;
    attachmentPositions.bytes += 1;
    return placeholder('bytes', attachmentPositions.bytes);
  }

  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value === null || typeof value !== 'object') return value;

    /** @type {Record<string, unknown>} */
    const out = {};
    const isAttachment = value.type === 'image' || value.type === 'document';
    for (const [member, memberValue] of Object.entries(value)) {
      if (
        isAttachment &&
        member === 'source' &&
        memberValue !== null &&
        typeof memberValue === 'object' &&
        !Array.isArray(memberValue)
      ) {
        const source = { ...memberValue };
        if (source.type === 'file' && typeof source.file_id === 'string') {
          source.file_id = fileIdentity(source.file_id);
        } else if (source.type === 'base64' && typeof source.data === 'string') {
          source.data = inlineIdentity(source.data);
        }
        out[member] = normalize(source);
        continue;
      }
      if (value.type === 'tool_use' && member === 'id' && typeof memberValue === 'string') {
        out[member] = placeholder('tool', ordinalFor(toolOrdinals, memberValue));
        continue;
      }
      if (
        value.type === 'tool_result' &&
        member === 'tool_use_id' &&
        typeof memberValue === 'string'
      ) {
        out[member] = placeholder('tool', ordinalFor(toolOrdinals, memberValue));
        continue;
      }
      out[member] = normalize(memberValue);
    }
    return out;
  }

  return normalize(body);
}

// ── Key derivation ───────────────────────────────────────────────────────────

/**
 * Deterministic JSON: object members emitted in sorted-key order, arrays in
 * their own order. Two bodies that are the same JSON VALUE therefore produce
 * the same key regardless of member order on the wire — which is exactness
 * about JSON, not an approximate match.
 */
export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const members = Object.keys(value)
    .sort()
    .map((member) => `${JSON.stringify(member)}:${canonicalJson(value[member])}`);
  return `{${members.join(',')}}`;
}

/**
 * The cache key for one request. See the module header for the full derivation.
 *
 * @param {{ body: unknown, model: string, contextId: string,
 *           transport: 'messages'|'stream', attachmentIdentity?: 'placeholder'|'digest',
 *           attachmentBytes?: (fileId: string) => Uint8Array|null }} request
 */
export function deriveCacheKey(request) {
  const attachmentIdentity = request.attachmentIdentity === 'digest' ? 'digest' : 'placeholder';
  const material = canonicalJson({
    cacheFormat: CACHE_FORMAT_VERSION,
    transport: request.transport,
    model: request.model,
    contextId: request.contextId,
    attachmentIdentity,
    body: normalizeRequestBody(request.body, {
      attachmentIdentity,
      attachmentBytes: request.attachmentBytes,
    }),
  });
  return sha256(material);
}

/**
 * A short human-readable hint for an entry: the last user turn's text, squeezed
 * onto one line. ADVISORY ONLY — written into the entry for triage when you are
 * staring at a directory of hash-named files, never read back for matching.
 */
export function cacheLabel(body, limit = 120) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join(' ');
    }
    const squeezed = text.replace(/\s+/g, ' ').trim();
    if (squeezed) return squeezed.slice(0, limit);
  }
  return '';
}

// ── On-disk entries ──────────────────────────────────────────────────────────

/** The file one entry lives in. Flat: one hash-named JSON per recorded call. */
export function cacheEntryPath(directory, key) {
  return join(directory, `${key}.json`);
}

/**
 * Read the entry for `key`, or null when there is none or it cannot be trusted.
 *
 * Every rejection reason is reported through `onUnusable` so a corrupt or
 * stale-format entry is visible in the log rather than being an unexplained
 * slow run. A rejected entry is a MISS: the caller re-records it.
 *
 * @param {string} directory
 * @param {string} key
 * @param {'messages'|'stream'} transport
 * @param {(reason: string) => void} [onUnusable]
 */
export function readCacheEntry(directory, key, transport, onUnusable) {
  const report = typeof onUnusable === 'function' ? onUnusable : () => {};
  let raw;
  try {
    raw = readFileSync(cacheEntryPath(directory, key), 'utf8');
  } catch {
    return null; // absent — an ordinary miss, not a problem worth reporting.
  }

  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (error) {
    report(`unreadable JSON: ${error?.message ?? error}`);
    return null;
  }
  if (entry === null || typeof entry !== 'object') {
    report('entry is not an object');
    return null;
  }
  if (entry.cacheFormat !== CACHE_FORMAT_VERSION) {
    report(
      `recorded under cacheFormat ${entry.cacheFormat}, this shim expects ${CACHE_FORMAT_VERSION}`,
    );
    return null;
  }
  if (entry.key !== key) {
    report(`entry declares key ${entry.key}`);
    return null;
  }
  if (entry.transport !== transport) {
    report(`entry is a ${entry.transport} recording, this request is ${transport}`);
    return null;
  }
  if (transport === 'messages') {
    if (entry.response === null || typeof entry.response !== 'object') {
      report('non-stream entry carries no response body');
      return null;
    }
  } else if (!Array.isArray(entry.frames) || entry.frames.length === 0) {
    report('stream entry carries no frames');
    return null;
  }
  return entry;
}

/**
 * Write one entry. Written to a temporary name and renamed into place, so a
 * concurrent reader never sees a half-written entry, and a crashed write leaves
 * no readable file.
 *
 * @returns {string} the path written
 */
export function writeCacheEntry(directory, key, entry) {
  mkdirSync(directory, { recursive: true });
  const finalPath = cacheEntryPath(directory, key);
  const temporaryPath = `${finalPath}.${process.pid}.writing`;
  writeFileSync(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, finalPath);
  return finalPath;
}
