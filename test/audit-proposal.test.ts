import { describe, expect, it } from 'vitest';

import {
  PROPOSAL_BOX_VOCABULARY,
  isUsableProposal,
  readProposalManifest,
} from '../src/lib/audit-proposal';
import boxVocabularyBlock from '../src/prompts/onboarding-shared/_shared-box-vocab.md';
import wholeStoreReceiveBlock from '../src/prompts/onboarding-batch-all/_receive.md';
import { anthropicMessage } from './helpers';

function reply(text: string, stopReason = 'end_turn'): Record<string, unknown> {
  return anthropicMessage([{ type: 'text', text }], { stop_reason: stopReason });
}

const BOX = { boxType: 'MostPopular', position: 'after', anchorNumber: 2 };
const WHOLE_STORE_MANIFEST = readProposalManifest([
  [
    'PAGE Home: DESKTOP TILES images 1-2, MOBILE TILES images 3-3, CANDIDATE ANCHORS 1..6',
    '  CANDIDATES (each number is INSERT or REPLACE):',
    'PAGE Cart: DESKTOP TILES images 4-4, MOBILE TILES images 5-5, CANDIDATE ANCHORS 1..3',
    'PAGE Blog: DESKTOP TILES images 6-6, MOBILE TILES images 7-7, CANDIDATE ANCHORS none',
    'Propose the placement plan for EACH page listed above.',
  ].join('\n'),
]);

describe('the grader proposal manifest', () => {
  it('reads every requested page and its candidate range', () => {
    expect(WHOLE_STORE_MANIFEST).toEqual([
      { page: 'Home', anchorMax: 6 },
      { page: 'Cart', anchorMax: 3 },
      { page: 'Blog', anchorMax: 0 },
    ]);
    expect(
      readProposalManifest(['PAGE: Product\nDESKTOP TILES: 2\nCANDIDATE ANCHORS: 1..4\nPropose.']),
    ).toEqual([{ page: 'Product', anchorMax: 4 }]);
  });

  it('parses the manifest lines exactly as the whole-store prompt defines them', () => {
    const exampleLines = [...wholeStoreReceiveBlock.matchAll(/`(PAGE [^`]+)`/gu)].map(
      (match) => match[1] ?? '',
    );
    expect(exampleLines.length).toBeGreaterThan(0);
    expect(readProposalManifest([exampleLines.join('\n')])).toHaveLength(exampleLines.length);
  });

  it('checks box types against the vocabulary the prompts give the model', () => {
    const vocabularyLine = boxVocabularyBlock
      .split('\n')
      .find((line) => line.startsWith('`MostPopular`'));
    const names = [...(vocabularyLine ?? '').matchAll(/`([A-Za-z]+)`/gu)].map((match) => match[1]);
    expect(names).toEqual([...PROPOSAL_BOX_VOCABULARY]);
  });
});

describe('a usable grader proposal', () => {
  const plan = (pages: Record<string, unknown>): string => JSON.stringify({ pages });

  it('accepts a complete whole-store plan directly, fenced, or embedded in prose', () => {
    const complete = plan({ Home: { boxes: [BOX] }, Cart: { boxes: [] }, Blog: { boxes: [] } });
    for (const text of [complete, `\`\`\`json\n${complete}\n\`\`\``, `The plan: ${complete}`]) {
      expect(isUsableProposal('onboarding-batch-all', reply(text), WHOLE_STORE_MANIFEST)).toBe(
        true,
      );
    }
  });

  it('refuses a whole-store plan the conductor would not accept', () => {
    const refused = {
      'an object box': plan({ Home: { boxes: [{}] }, Cart: { boxes: [] }, Blog: { boxes: [] } }),
      'an unknown box type': plan({
        Home: { boxes: [{ ...BOX, boxType: 'Carousel' }] },
        Cart: { boxes: [] },
        Blog: { boxes: [] },
      }),
      'a bad position': plan({
        Home: { boxes: [{ ...BOX, position: 'inside' }] },
        Cart: { boxes: [] },
        Blog: { boxes: [] },
      }),
      'an anchor outside the page range': plan({
        Home: { boxes: [] },
        Cart: { boxes: [{ ...BOX, anchorNumber: 4 }] },
        Blog: { boxes: [] },
      }),
      'a box on a page with no candidates': plan({
        Home: { boxes: [] },
        Cart: { boxes: [] },
        Blog: { boxes: [BOX] },
      }),
      'a requested page left out': plan({ Home: { boxes: [BOX] }, Cart: { boxes: [] } }),
      'one arbitrary page': plan({ Search: { boxes: [] } }),
    };
    for (const [label, text] of Object.entries(refused)) {
      expect(
        isUsableProposal('onboarding-batch-all', reply(text), WHOLE_STORE_MANIFEST),
        label,
      ).toBe(false);
    }
  });

  it('requires the per-page plan to answer the requested page', () => {
    const manifest = readProposalManifest(['PAGE: Home\nCANDIDATE ANCHORS: 1..6']);
    expect(
      isUsableProposal('onboarding-batch', reply('{"page":"Home","boxes":[]}'), manifest),
    ).toBe(true);
    expect(
      isUsableProposal('onboarding-batch', reply('{"page":"Cart","boxes":[]}'), manifest),
    ).toBe(false);
    expect(isUsableProposal('onboarding-batch', reply('{"boxes":[]}'), manifest)).toBe(false);
    expect(
      isUsableProposal(
        'onboarding-batch',
        reply(JSON.stringify({ page: 'Home', boxes: [{}] })),
        manifest,
      ),
    ).toBe(false);
  });

  it('refuses any plan when the request carried no manifest it could read', () => {
    const wholeStore = plan({ Home: { boxes: [BOX] } });
    expect(isUsableProposal('onboarding-batch-all', reply(wholeStore), [])).toBe(false);
    const page = JSON.stringify({ page: 'Home', boxes: [BOX] });
    expect(isUsableProposal('onboarding-batch', reply(page), [])).toBe(false);
    expect(
      isUsableProposal('onboarding-batch', reply(page), readProposalManifest(['PAGE: Home'])),
    ).toBe(false);
  });

  it("refuses a candidate past the conductor's bound whatever range the manifest names", () => {
    const manifest = readProposalManifest([
      'PAGE Home: DESKTOP TILES images 1-1, MOBILE TILES images 2-2, CANDIDATE ANCHORS 1..600',
    ]);
    const atAnchor = (anchorNumber: number): string =>
      plan({ Home: { boxes: [{ ...BOX, anchorNumber }] } });
    expect(isUsableProposal('onboarding-batch-all', reply(atAnchor(500)), manifest)).toBe(true);
    expect(isUsableProposal('onboarding-batch-all', reply(atAnchor(501)), manifest)).toBe(false);
  });

  it('refuses prose, malformed JSON, and an empty plan', () => {
    for (const text of [
      'no plan today',
      '{"pages":',
      '{}',
      '{"pages":{}}',
      '{"pages":{"Home":{}}}',
    ]) {
      expect(isUsableProposal('onboarding-batch-all', reply(text), []), text).toBe(false);
    }
  });

  it('refuses a reply that did not finish', () => {
    const text = plan({ Home: { boxes: [] }, Cart: { boxes: [] }, Blog: { boxes: [] } });
    for (const stopReason of ['max_tokens', 'refusal']) {
      expect(
        isUsableProposal('onboarding-batch-all', reply(text, stopReason), WHOLE_STORE_MANIFEST),
      ).toBe(false);
    }
  });
});
