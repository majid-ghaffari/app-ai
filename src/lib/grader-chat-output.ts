const LINKABLE_DOMAIN = 'limespot.com';
const BARE_HOST_SCHEME = 'https:';

/** Why a reply was withheld from the visitor. */
export type GraderChatWithholdReason = 'incomplete' | 'empty' | 'external-link';

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

/**
 * Decide whether a model reply may reach the visitor. The link guard is the only check on what a
 * reply says, and it reads the text after Unicode compatibility folding, invisible-character
 * removal, and mapping every WHATWG dot equivalent to `.`. Three paths decide every link-like
 * target. Any token shaped like a URI — a letter-first scheme of any length, a colon, and
 * then any non-whitespace character — is withheld unless it is an `http` or `https` URL that the
 * WHATWG `URL` parser reads with no credentials, no backslash in its authority, and a host that is
 * limespot.com or one of its subdomains, or a `mailto:` link to exactly one recipient at
 * limespot.com with no query and no `%`. A plain email address passes only under that same
 * exact-recipient rule, and a bare hostname, a Markdown target or a bracketed IPv6 literal only
 * under the same `URL` rule as `https://`. Any four dot-separated octets withhold the reply
 * whatever follows them, since no IP literal is limespot.com. A reply the model did not finish, or
 * left empty, is withheld too rather than delivered cut off. Claims are the prompt's to govern,
 * never this check's.
 */
export function reviewGraderChatReply(reply: string, completed: boolean): GraderChatReplyReview {
  if (!completed) return { withheld: true, reason: 'incomplete' };
  if (reply.trim().length === 0) return { withheld: true, reason: 'empty' };
  const text = visibleText(reply);
  if (IPV4_LITERAL.test(text) || linkTargets(text).some((target) => !isLimeSpotTarget(target))) {
    return { withheld: true, reason: 'external-link' };
  }
  return { withheld: false };
}

function visibleText(source: string): string {
  return source
    .normalize('NFKC')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(WHATWG_DOT_EQUIVALENTS, '.');
}

function linkTargets(text: string): string[] {
  const targets = LINK_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[0]),
  );
  for (const match of text.matchAll(MARKDOWN_LINK_TARGET)) targets.push(match[1] ?? '');
  return targets;
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
