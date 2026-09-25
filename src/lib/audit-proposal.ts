const COMPLETE_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

const PROPOSAL_POSITIONS = new Set(['before', 'after', 'replace']);

/** The highest candidate number the conductor places a box at; it drops any box beyond it. */
export const MAX_PROPOSAL_ANCHOR = 500;

/** The box names the proposal prompts' box vocabulary tells the model to use, exactly as written. */
export const PROPOSAL_BOX_VOCABULARY = [
  'MostPopular',
  'Trending',
  'NewArrivals',
  'YouMayLike',
  'RecentViews',
  'BoughtTogether',
  'CrossSell',
  'Upsell',
  'RelatedItems',
  'FeaturedCollection',
] as const;

const BOX_TYPES = new Set<string>(PROPOSAL_BOX_VOCABULARY);

/**
 * One page a grader inference asked the model to plan, read from the request's page manifest in
 * the line format the proposal prompts define. `anchorMax` is the page's highest numbered
 * candidate, 0 when it has none, and null when the manifest names no range.
 */
export interface ProposalManifestPage {
  readonly page: string;
  readonly anchorMax: number | null;
}

/** Read the pages, and each page's candidate range, that a grader inference's text asks for. */
export function readProposalManifest(texts: readonly string[]): readonly ProposalManifestPage[] {
  const pages: ProposalManifestPage[] = [];
  for (const text of texts) {
    let singlePage: string | null = null;
    let singleAnchorMax: number | null = null;
    for (const line of text.split('\n')) {
      const wholeStore = /^PAGE (.+?): .*CANDIDATE ANCHORS (?:1\.\.(\d+)|none)\s*$/u.exec(line);
      if (wholeStore?.[1]) {
        pages.push({ page: wholeStore[1], anchorMax: anchorMax(wholeStore[2]) });
        continue;
      }
      const page = /^PAGE: (.+?)\s*$/u.exec(line)?.[1];
      if (page) singlePage = page;
      const range = /^CANDIDATE ANCHORS: (?:1\.\.(\d+)|none)\s*$/u.exec(line);
      if (range) singleAnchorMax = anchorMax(range[1]);
    }
    if (singlePage) pages.push({ page: singlePage, anchorMax: singleAnchorMax });
  }
  return pages;
}

/**
 * Whether a grader inference's `/messages` response body is a proposal the conductor can use: a
 * complete reply whose assistant text parses as the proposal contract of `prompt`, planning every
 * page `manifest` names, with every box naming a vocabulary box type, a placement position, and a
 * candidate number inside its page's range and the conductor's bound. A request whose manifest did
 * not parse — no page for the whole-store prompt, or not exactly one page with a known range for
 * the per-page prompt — establishes no contract, so no reply to it is usable. Only a usable reply
 * completes a public run; any other successful reply is reported as a failed attempt.
 */
export function isUsableProposal(
  prompt: string,
  responseBody: unknown,
  manifest: readonly ProposalManifestPage[],
): boolean {
  const message = asRecord(responseBody);
  if (!message || message.type !== 'message' || !Array.isArray(message.content)) return false;
  if (typeof message.stop_reason !== 'string' || !COMPLETE_STOP_REASONS.has(message.stop_reason)) {
    return false;
  }
  const text = message.content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block?.text as string)
    .join('');
  const proposal = parseProposalObject(text);
  if (!proposal) return false;
  if (prompt === 'onboarding-batch-all') return isWholeStoreProposal(proposal, manifest);
  if (prompt === 'onboarding-batch') return isPageProposal(proposal, manifest);
  return false;
}

function isWholeStoreProposal(
  proposal: Record<string, unknown>,
  manifest: readonly ProposalManifestPage[],
): boolean {
  const pages = asRecord(proposal.pages);
  if (!pages || manifest.length === 0) return false;
  const plans = Object.entries(pages);
  if (plans.length === 0) return false;
  const planned = new Set(plans.map(([page]) => pageKey(page)));
  if (manifest.some((entry) => !planned.has(pageKey(entry.page)))) return false;
  return plans.every(([page, plan]) => isPagePlan(asRecord(plan), rangeOf(page, manifest)));
}

function isPageProposal(
  proposal: Record<string, unknown>,
  manifest: readonly ProposalManifestPage[],
): boolean {
  const page = proposal.page;
  if (typeof page !== 'string' || page.trim().length === 0) return false;
  const requested = manifest[0];
  if (manifest.length !== 1 || !requested || requested.anchorMax === null) return false;
  if (pageKey(requested.page) !== pageKey(page)) return false;
  return isPagePlan(proposal, rangeOf(page, manifest));
}

function isPagePlan(plan: Record<string, unknown> | null, maxAnchor: number | null): boolean {
  return !!plan && Array.isArray(plan.boxes) && plan.boxes.every((box) => isBox(box, maxAnchor));
}

function isBox(raw: unknown, maxAnchor: number | null): boolean {
  const box = asRecord(raw);
  if (!box || typeof box.boxType !== 'string' || !BOX_TYPES.has(box.boxType)) return false;
  if (typeof box.position !== 'string' || !PROPOSAL_POSITIONS.has(box.position)) return false;
  const anchor = box.anchorNumber;
  return (
    typeof anchor === 'number' &&
    Number.isInteger(anchor) &&
    anchor >= 1 &&
    anchor <= MAX_PROPOSAL_ANCHOR &&
    (maxAnchor === null || anchor <= maxAnchor)
  );
}

function rangeOf(page: string, manifest: readonly ProposalManifestPage[]): number | null {
  return manifest.find((entry) => pageKey(entry.page) === pageKey(page))?.anchorMax ?? null;
}

function anchorMax(raw: string | undefined): number {
  return raw === undefined ? 0 : Number(raw);
}

function pageKey(page: string): string {
  return page.trim().toLowerCase();
}

function parseProposalObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)?.[1];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const embedded = start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
  for (const candidate of [trimmed, fenced, embedded]) {
    if (candidate === undefined) continue;
    try {
      const parsed = asRecord(JSON.parse(candidate) as unknown);
      if (parsed) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
