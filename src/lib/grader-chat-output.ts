const LINKABLE_DOMAIN = 'limespot.com';
const BARE_HOST_SCHEME = 'https:';

/** The actions a Grader chat button may name, the closed list the prompt's buttons block teaches. */
export const GRADER_CHAT_CHOICE_ACTIONS = [
  'grader.book-call',
  'grader.install',
  'grader.open-link',
] as const;

/** Why a reply was withheld from the visitor. */
export type GraderChatWithholdReason =
  | 'incomplete'
  | 'empty'
  | 'malformed-choices'
  | 'external-link';

/** The outcome of checking one model reply before the visitor sees it. */
export type GraderChatReplyReview =
  | { readonly withheld: false }
  | { readonly withheld: true; readonly reason: GraderChatWithholdReason };

const INVISIBLE_CHARACTERS =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;
const WHATWG_DOT_EQUIVALENTS = /[\u3002\uFF0E\uFF61]/gu;
const LINK_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\S+/gu,
  /(?<![\p{L}\p{N}.-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,24}\.?(?::[0-9]{1,5})?(?:[/\\?#][^\s<>()[\]"'`]*)?(?![\p{L}\p{N}])/gu,
  /(?<![^\s<>()[\]"'`@])[^\s<>()[\]"'`@]+@[^\s<>()[\]"'`]+/gu,
  /\[[0-9a-f.]*:[0-9a-f:.]*\](?::[0-9]{1,5})?(?:[/\\?#][^\s<>()[\]"'`]*)?/giu,
];
const MARKDOWN_LINK_TARGET = /\]\(\s*([^)\s]+)/gu;
const TRAILING_PUNCTUATION = /[.,;:!?'"’)\]]+$/u;
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|[01]?[0-9]?[0-9])';
const IPV4_LITERAL = new RegExp(`(?<![0-9.])(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}(?![0-9])`, 'u');
const LIMESPOT_MAILTO = /^mailto:[^\s@%?,;/\\:]+@(?:[a-z0-9-]+\.)*limespot\.com$/iu;
const LIMESPOT_EMAIL = /^[^\s@%?,;/\\:]+@(?:[a-z0-9-]+\.)*limespot\.com$/iu;
const HOSTNAME_SHAPED_BRANDS: ReadonlySet<string> = new Set(['judge.me']);
const WORD = /\S+/gu;
const WORD_OPENING_PUNCTUATION = /^["'“‘(*_]+/u;
const WORD_CLOSING_PUNCTUATION = /[.,;:!?"'’”)*_]+$/u;
const POSSESSIVE_SUFFIX = /['’]s$/u;
const CHAT_ENVELOPE_KEYS = ['reply', 'proposals', 'directives', 'choices'] as const;
const RAW_MARKUP =
  /[`*~|{}[\]]|\\(?:[!-/:-@[-`{-~]|$)|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])|<[A-Za-z/!?]|&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/mu;
const LIST_MARKER = /^(?:-|[0-9]+[.)])\s+/u;
const RAW_LINE_OPENER = /^(?:#{1,6}(?:\s|$)|>|\+\s)/u;
const RULE_LINE = /^[-=\s]+$/u;
const INDENTED_LINE = /^(?:\t| {4})\s*\S/u;
const LINE_BREAK = /\r?\n/u;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const URL_SHAPE = /^www\.|[/\\?#:]/iu;
const FENCE = '```';
const FENCE_INFO = 'json';
const CHOICE_MEMBERS: ReadonlySet<string> = new Set(['label', 'action', 'args']);
const LINK_CHOICE_ACTION: (typeof GRADER_CHAT_CHOICE_ACTIONS)[number] = 'grader.open-link';
const HTTPS_PREFIX = /^https:\/\//iu;

interface LocatedEnvelope {
  readonly object: Record<string, unknown>;
  readonly start: number;
  readonly end: number;
}

interface ChoiceText {
  readonly labels: readonly string[];
  readonly hrefs: readonly string[];
}

type DeliveredText =
  | { readonly readable: false }
  | {
      readonly readable: true;
      readonly texts: readonly string[];
      readonly hrefs: readonly string[];
    };

/**
 * Decide whether a model reply may reach the visitor. A reply may end with one buttons block, and
 * the guard first finds it exactly as lib's `parseChatEnvelope` does: the whole reply read as JSON,
 * else the first fenced block — an optional `json` info string, then everything up to the next
 * fence — that parses as an object carrying `reply`, `proposals`, `directives` or `choices`, else
 * the span from the first `{` to the last `}` when one of those keys stands quoted inside it. The
 * object found must hold only a non-empty `choices` array whose every entry is an object with a
 * non-empty string `label`, an optional `action` that is exactly one of `GRADER_CHAT_CHOICE_ACTIONS`
 * as `JSON.parse` decodes it, and `args` holding only a string `href` when, and only when, that
 * action is `grader.open-link`. A block of any other shape withholds the reply as
 * `malformed-choices`.
 *
 * lib shows a Grader reply as plain text, a text node with no Markdown applied, so beside that one
 * block a reply may hold only plain sentences, paragraphs, and list lines opening with `- ` or a
 * number and `.` or `)`. The prose around the block, or the whole reply when no block parsed, and
 * every label withhold the reply as `malformed-choices` when, after the same folding the link guard
 * reads by, they hold a backtick, an asterisk, a tilde, a vertical bar, a square bracket, a `{` or
 * `}`, a backslash before ASCII punctuation or at a line's end, an underscore not between two
 * letters or digits, an HTML or XML tag shape (`<` before a letter, `/`, `!` or `?`) or an entity or
 * numeric character reference, or when a line holding text is indented by a tab or four spaces,
 * holds only `-`, `=` and spaces, or opens, list marker aside, with a heading `#`, a quote `>` or a
 * `+` bullet. That covers every GitHub Flavored Markdown construct a plain-text bubble would show
 * as raw characters — headings, rules, indented and fenced code, HTML, reference definitions,
 * tables, quotes, task items, escapes and hard breaks, references, code spans, emphasis,
 * strikethrough, links, images, footnotes and autolinks — and every JSON array; what remains,
 * paragraphs, simple list lines, bare site names and email addresses, is plain text, since a text
 * node is never linked. A whole reply that `JSON.parse` reads as anything
 * but that block — a string, a number, `true`, `false` or `null` as much as an array or object —
 * is withheld the same way.
 *
 * The link guard then reads the prose outside the block, every decoded label and every decoded
 * `href`, never an action name, each after Unicode compatibility folding, invisible-character
 * removal, and mapping every WHATWG dot equivalent to `.`, so neither a JSON escape nor a folded
 * character can hide a link. Every link is a button, so prose and labels carry no URL at all: any
 * token shaped like a URI — a letter-first scheme of any length, a colon, and then any
 * non-whitespace character, `https://limespot.com` and `mailto:` included — and any hostname
 * opening with `www.` or followed by a path, a port, a query or a fragment withholds the reply. A
 * bare hostname names a site and passes only when the WHATWG `URL` parser reads it, prefixed with
 * `https://`, with no credentials, no backslash in its authority, and a host that is limespot.com
 * or one of its subdomains; a plain email address passes only as exactly one recipient at
 * limespot.com with no `%`. Any four dot-separated octets withhold the reply whatever follows them,
 * since no IP literal is limespot.com. A brand on the listed names shaped like a hostname,
 * `Judge.me`, is no link when it stands as a plain word: in any letter case, bounded by whitespace,
 * with only opening quotes or a parenthesis before it and only sentence punctuation, closing quotes,
 * a parenthesis or a possessive `'s` after it. With a scheme, a path, a port, a query or fragment,
 * `www.` or another subdomain, or an `@` it is read as a hostname like any other. A button's `href`
 * must be a whole `https` URL with no credentials, no backslash in its authority, and a host that is
 * limespot.com or one of its subdomains; an action name written anywhere but a valid block's
 * `action` is read as a hostname like any other. Either finding withholds the reply as
 * `external-link`. A reply the model did not finish, or left empty, is withheld too rather than
 * delivered cut off. Claims are the prompt's to govern, never this check's.
 */
export function reviewGraderChatReply(reply: string, completed: boolean): GraderChatReplyReview {
  if (!completed) return { withheld: true, reason: 'incomplete' };
  if (reply.trim().length === 0) return { withheld: true, reason: 'empty' };
  const delivered = deliveredText(reply);
  if (!delivered.readable) return { withheld: true, reason: 'malformed-choices' };
  if (delivered.texts.some(carriesLink) || !delivered.hrefs.every(isLimeSpotHref)) {
    return { withheld: true, reason: 'external-link' };
  }
  return { withheld: false };
}

function deliveredText(reply: string): DeliveredText {
  if (isOtherJson(reply.trim())) return { readable: false };
  const envelope = locateChatEnvelope(reply);
  const prose = envelope ? proseOutside(reply, envelope.start, envelope.end) : reply;
  if (showsRawStructure(prose)) return { readable: false };
  if (!envelope) return { readable: true, texts: [prose], hrefs: [] };
  const choices = choiceText(envelope.object);
  if (!choices || choices.labels.some(showsRawStructure)) return { readable: false };
  return { readable: true, texts: [prose, ...choices.labels], hrefs: choices.hrefs };
}

function locateChatEnvelope(text: string): LocatedEnvelope | null {
  const trimmed = text.trim();
  const direct = chatEnvelope(trimmed);
  if (direct) {
    const start = text.indexOf(trimmed);
    return { object: direct, start, end: start + trimmed.length };
  }
  let from = 0;
  for (;;) {
    const open = text.indexOf(FENCE, from);
    if (open < 0) break;
    const infoEnd = open + FENCE.length;
    const bodyStart = text.startsWith(FENCE_INFO, infoEnd) ? infoEnd + FENCE_INFO.length : infoEnd;
    const close = text.indexOf(FENCE, bodyStart);
    if (close < 0) break;
    const fenced = chatEnvelope(text.slice(bodyStart, close).trim());
    if (fenced) return { object: fenced, start: open, end: close + FENCE.length };
    from = close + FENCE.length;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) return null;
  const named = CHAT_ENVELOPE_KEYS.some((key) => {
    const at = text.indexOf(`"${key}"`, start + 1);
    return at >= 0 && at + key.length + 2 < end;
  });
  const embedded = named ? chatEnvelope(text.slice(start, end)) : null;
  return embedded ? { object: embedded, start, end } : null;
}

function showsRawStructure(source: string): boolean {
  const text = visibleText(source);
  if (RAW_MARKUP.test(text)) return true;
  return text.split(LINE_BREAK).some((line) => {
    const trimmed = line.trim();
    return (
      INDENTED_LINE.test(line) ||
      RULE_LINE.test(trimmed) ||
      RAW_LINE_OPENER.test(trimmed.replace(LIST_MARKER, ''))
    );
  });
}

function isOtherJson(candidate: string): boolean {
  try {
    JSON.parse(candidate);
  } catch {
    return false;
  }
  return chatEnvelope(candidate) === null;
}

function chatEnvelope(candidate: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  return CHAT_ENVELOPE_KEYS.some((key) => key in parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function proseOutside(text: string, start: number, end: number): string {
  const before = text.slice(0, start).trim();
  const after = text.slice(end).trim();
  if (before && after) return `${before}\n\n${after}`;
  return before || after;
}

function choiceText(envelope: Record<string, unknown>): ChoiceText | null {
  const members = Object.keys(envelope);
  const { choices } = envelope;
  if (members.length !== 1 || members[0] !== 'choices') return null;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const labels: string[] = [];
  const hrefs: string[] = [];
  for (const choice of choices) {
    if (!isRecord(choice) || !Object.keys(choice).every((member) => CHOICE_MEMBERS.has(member))) {
      return null;
    }
    const { label, action, args } = choice;
    if (typeof label !== 'string' || label.trim().length === 0) return null;
    labels.push(label);
    if (!('action' in choice)) {
      if ('args' in choice) return null;
      continue;
    }
    if (!isChoiceAction(action)) return null;
    if (action !== LINK_CHOICE_ACTION) {
      if ('args' in choice) return null;
      continue;
    }
    if (!isRecord(args) || Object.keys(args).length !== 1 || typeof args.href !== 'string') {
      return null;
    }
    hrefs.push(args.href);
  }
  return { labels, hrefs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChoiceAction(value: unknown): boolean {
  return (GRADER_CHAT_CHOICE_ACTIONS as readonly unknown[]).includes(value);
}

function carriesLink(source: string): boolean {
  const text = visibleText(source);
  return (
    IPV4_LITERAL.test(text) ||
    linkTargets(text).some((target) => isUrl(target) || !isLimeSpotTarget(target))
  );
}

function isUrl(raw: string): boolean {
  const target = raw.replace(TRAILING_PUNCTUATION, '');
  if (URL_SCHEME.test(target)) return true;
  return !target.includes('@') && URL_SHAPE.test(target);
}

function linksOffSite(source: string): boolean {
  const text = visibleText(source);
  return IPV4_LITERAL.test(text) || linkTargets(text).some((target) => !isLimeSpotTarget(target));
}

function isLimeSpotHref(href: string): boolean {
  const target = visibleText(href);
  return (
    HTTPS_PREFIX.test(target) &&
    isLimeSpotUrl(target, target.slice(target.indexOf('//') + 2)) &&
    !linksOffSite(target)
  );
}

function visibleText(source: string): string {
  return source
    .normalize('NFKC')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(WHATWG_DOT_EQUIVALENTS, '.');
}

function linkTargets(text: string): string[] {
  const prose = text.replace(WORD, (word) => (isStandaloneBrand(word) ? ' ' : word));
  const targets = LINK_PATTERNS.flatMap((pattern) =>
    [...prose.matchAll(pattern)].map((match) => match[0]),
  );
  for (const match of text.matchAll(MARKDOWN_LINK_TARGET)) targets.push(match[1] ?? '');
  return targets;
}

function isStandaloneBrand(word: string): boolean {
  const name = word
    .replace(WORD_OPENING_PUNCTUATION, '')
    .replace(WORD_CLOSING_PUNCTUATION, '')
    .replace(POSSESSIVE_SUFFIX, '');
  return HOSTNAME_SHAPED_BRANDS.has(name.toLowerCase());
}

function isLimeSpotTarget(raw: string): boolean {
  const target = raw.replace(TRAILING_PUNCTUATION, '');
  if (/^mailto:/iu.test(target)) return LIMESPOT_MAILTO.test(target);
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
    if (!/^https?:\/\//iu.test(target)) return false;
    return isLimeSpotUrl(target, target.slice(target.indexOf('//') + 2));
  }
  if (target.includes('@')) return LIMESPOT_EMAIL.test(target);
  return isLimeSpotBareHost(target);
}

function isLimeSpotBareHost(candidate: string): boolean {
  if (candidate.length === 0 || candidate.startsWith('/')) return false;
  return isLimeSpotUrl(`${BARE_HOST_SCHEME}//${candidate}`, candidate);
}

function isLimeSpotUrl(href: string, afterScheme: string): boolean {
  if ((afterScheme.split(/[/?#]/u)[0] ?? '').includes('\\')) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.replace(/\.$/u, '');
  return host === LINKABLE_DOMAIN || host.endsWith(`.${LINKABLE_DOMAIN}`);
}
