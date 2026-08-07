/**
 * Coverage for the `onboarding-review` prompt — the REVIEW half of onboarding
 * "batch mode": given a page name + a full-page screenshot AFTER the propose plan
 * was applied + the applied plan, it returns a verdict { pass, feedback,
 * corrections, failureClass }. It mirrors `visual-verify` — a multi-modal judge
 * whose truth is the pixels — but adds the crucial NON-CRITICAL 'placement' vs
 * CRITICAL 'styling' failure classification and limits corrections to the two
 * existing write verbs (styleBox / addBox / removeBox). Structured output
 * (usesTools: false, no clientTools), header-selected on POST /messages. Asserts:
 *   • the registry resolves `onboarding-review` with the `balanced` tier
 *     (Sonnet), no tools, no attachments;
 *   • the prompt text names its input + the verdict contract + the placement /
 *     styling classification + the three allowed correction actions;
 *   • POST /messages routes the header to the prompt (injects the system block,
 *     no /files upload) and defaults the model to the `balanced` tier;
 *   • the output contract is asserted via a parse/validate check across a pass
 *     verdict, a NON-CRITICAL placement verdict, and a CRITICAL styling verdict.
 *
 * fetch + env are mocked; no network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { getSystemPrompt, isProbeName } from '../src/prompt-registry';
import { handleMessages } from '../src/handlers/messages';
import { ENV, CORS, stubFetch, fetchCall, sentBody } from './helpers';

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

afterEach(() => vi.restoreAllMocks());

/** The three allowed correction actions — the existing write verbs, no new ones. */
const CORRECTION_ACTIONS = ['styleBox', 'removeBox', 'addBox'];
/** The valid failureClass values (null is also allowed). */
const FAILURE_CLASSES = ['placement', 'styling'];

describe('onboarding-review registry entry', () => {
  it('resolves with the `balanced` tier (Sonnet), no tools, no attachments', () => {
    const entry = getSystemPrompt('onboarding-review', ENV);
    // The multi-modal judge runs on the `balanced` tier (Sonnet), like visual-verify.
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.model).not.toBe(ENV.MODEL_FRONTIER);
    // Structured output — one-shot JSON, no server tools, no CLIENT tools.
    expect(entry.usesTools).toBe(false);
    expect(entry.clientTools).toBeUndefined();
    // No bundled attachments — the lib uploads the after-render screenshot per run.
    expect(entry.attachments).toEqual([]);
    expect(entry.maxTokens).toBeGreaterThan(0);
    expect(entry.effort).toBe('low');
  });

  it('is NOT a `probe-<id>` name — an onboarding step, not a Website-Analysis probe', () => {
    expect(isProbeName('onboarding-review')).toBe(false);
  });

  it('the prompt text names its input, verdict contract, classification, and write verbs', () => {
    const entry = getSystemPrompt('onboarding-review', ENV);
    // JSON-only structured output.
    expect(entry.prompt).toMatch(/JSON/i);
    // Input: TWO after-render screenshots — desktop + mobile — + the applied plan.
    expect(entry.prompt).toMatch(/screenshot/i);
    expect(entry.prompt).toMatch(/plan/i);
    expect(entry.prompt).toMatch(/desktop/i);
    expect(entry.prompt).toMatch(/mobile/i);
    // Mobile is first-class; the page passes only if BOTH widths pass.
    expect(entry.prompt).toMatch(/both widths|BOTH widths/);
    expect(entry.prompt).toMatch(/only if.*both|both.*only|either width/i);
    expect(entry.prompt).toMatch(/majority/i);
    // Pixels are the source of truth (mirrors visual-verify).
    expect(entry.prompt).toMatch(/pixels/i);
    // The output contract keys.
    expect(entry.prompt).toMatch(/"pass"/);
    expect(entry.prompt).toMatch(/"feedback"/);
    expect(entry.prompt).toMatch(/"corrections"/);
    expect(entry.prompt).toMatch(/"failureClass"/);
    // The crucial classification — both failure classes + non-critical/critical.
    expect(entry.prompt).toMatch(/placement/);
    expect(entry.prompt).toMatch(/styling/);
    expect(entry.prompt).toMatch(/non-critical/i);
    expect(entry.prompt).toMatch(/critical/i);
    // The three allowed correction actions — no new mutation types.
    for (const action of CORRECTION_ACTIONS) expect(entry.prompt).toContain(action);
    // addBox re-places by a numbered section: position (before/after/replace) + anchorNumber,
    // aligned with the propose step's semantics (never anchorIndex).
    expect(entry.prompt).toMatch(/anchorNumber/);
    expect(entry.prompt).toMatch(/position/);
    expect(entry.prompt).toMatch(/before/);
    expect(entry.prompt).toMatch(/after/);
    expect(entry.prompt).toMatch(/replace/);
    expect(entry.prompt).not.toMatch(/anchorIndex/);
    // A mobile-only styling break is fixable via appearancePatchMobile (2 mobile knobs).
    expect(entry.prompt).toMatch(/appearancePatchMobile/);
    expect(entry.prompt).toMatch(/ImageHeightMobile/);
    expect(entry.prompt).toMatch(/MarginRightMobile/);
    // A one-width (mobile) break is a CRITICAL styling fail.
    expect(entry.prompt).toMatch(/mobile[- ]only|one width|ONE width/i);
  });

  it('hardens output reliability with an explicit JSON-only final instruction', () => {
    const entry = getSystemPrompt('onboarding-review', ENV);
    // The final hardening line: ONLY the JSON object, no prose/markdown fences.
    expect(entry.prompt).toMatch(/ONLY the JSON object/i);
    expect(entry.prompt).toMatch(/no (prose|explanation)/i);
    expect(entry.prompt).toMatch(/code fences?/i);
  });

  it('throws on an unknown prompt name', () => {
    expect(() => getSystemPrompt('onboarding-review-nope', ENV)).toThrow(/not found/i);
  });
});

describe('POST /messages — onboarding-review routing', () => {
  function messagesRequest(body: unknown, systemPrompt: string): Request {
    return new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': systemPrompt,
      },
      body: JSON.stringify(body),
    });
  }

  it('injects the onboarding-review system block + defaults the model to the `balanced` tier', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(async () => jsonOk({ content: [], input_tokens: 0 }));

    await handleMessages(
      // Body WITHOUT `model` — the transport omits it so the registry is
      // authoritative (onboarding-review → the `balanced` tier).
      messagesRequest(
        {
          max_tokens: 1,
          messages: [
            {
              role: 'user',
              content: [
                // TWO after-render screenshots — desktop + mobile — judged together.
                { type: 'image', source: { type: 'file', file_id: 'shot_after_desktop' } },
                { type: 'image', source: { type: 'file', file_id: 'shot_after_mobile' } },
                { type: 'text', text: 'page: Product\nplan: { ...applied plan... }' },
              ],
            },
          ],
        },
        'onboarding-review',
      ),
      ENV,
      CORS,
    );

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    // No attachments → no /files upload (the lib uploads the screenshot itself).
    expect(urls.some((url) => url.includes('/files'))).toBe(false);
    const idx = urls.findIndex((url) => url.endsWith('/v1/messages'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const sent = sentBody(fetchCall(fetchMock, idx).init);
    expect(sent.system?.[0]?.type).toBe('text');
    expect(sent.system?.[0]?.text).toMatch(/onboarding/i);
    expect(sent.model).toBe(ENV.MODEL_BALANCED);
    expect(sent.output_config).toEqual({ effort: 'low' });
    expect(Array.isArray(sent.messages?.[0]?.content)).toBe(true);
  });

  it('returns the Anthropic envelope with the assistant verdict JSON unchanged', async () => {
    const verdict = JSON.stringify({
      pass: false,
      feedback: 'BoughtTogether clashes with the store cards.',
      corrections: [
        {
          action: 'styleBox',
          args: {
            page: 'Product',
            boxType: 'BoughtTogether',
            appearancePatch: { ImageBorderRadius: 0, NavigationArrowType: 'none' },
          },
        },
      ],
      failureClass: 'styling',
    });
    stubFetch().mockResolvedValue(jsonOk({ content: [{ type: 'text', text: verdict }] }));

    const res = await handleMessages(
      messagesRequest(
        { max_tokens: 1, messages: [{ role: 'user', content: 'go' }] },
        'onboarding-review',
      ),
      ENV,
      CORS,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ text: string }> };
    expect(body.content[0]?.text).toBe(verdict);
  });
});

describe('onboarding-review output contract', () => {
  /** Assert an object satisfies the frozen review-verdict shape. */
  function assertVerdictShape(value: unknown): void {
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    const obj = value as Record<string, unknown>;
    // Exactly the four contract keys — no extras, no missing.
    expect(Object.keys(obj).sort()).toEqual(['corrections', 'failureClass', 'feedback', 'pass']);
    // pass is a boolean.
    expect(typeof obj.pass).toBe('boolean');
    // feedback is a non-empty string.
    expect(typeof obj.feedback).toBe('string');
    expect((obj.feedback as string).length).toBeGreaterThan(0);
    // corrections is an array of the allowed write verbs, each with an args object.
    expect(Array.isArray(obj.corrections)).toBe(true);
    for (const raw of obj.corrections as unknown[]) {
      expect(typeof raw).toBe('object');
      expect(raw).not.toBeNull();
      const correction = raw as Record<string, unknown>;
      expect(CORRECTION_ACTIONS).toContain(correction.action);
      expect(typeof correction.args).toBe('object');
      expect(correction.args).not.toBeNull();
    }
    // failureClass is null OR one of the two classes. And the pass ⇄ null invariant:
    // a passing verdict MUST classify null; a failing verdict MUST NOT be null.
    if (obj.failureClass !== null) {
      expect(FAILURE_CLASSES).toContain(obj.failureClass);
      expect(obj.pass).toBe(false);
    } else {
      expect(obj.pass).toBe(true);
    }
  }

  it('parses a passing verdict (failureClass: null, no corrections)', () => {
    const verdict = JSON.stringify({
      pass: true,
      feedback: 'All three planned boxes rendered in sensible slots and match the store cards.',
      corrections: [],
      failureClass: null,
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('parses a NON-CRITICAL placement verdict (failureClass: "placement")', () => {
    // A box is in a slightly-wrong slot — surfaced as a remove+add re-placement,
    // but classified non-critical.
    const verdict = JSON.stringify({
      pass: false,
      feedback:
        'Recently Viewed rendered near the top instead of the bottom; everything else fine.',
      corrections: [
        { action: 'removeBox', args: { page: 'Home', boxType: 'RecentViews' } },
        {
          action: 'addBox',
          args: {
            page: 'Home',
            boxType: 'RecentViews',
            position: 'before',
            anchorNumber: 5,
            appearancePatch: null,
            appearancePatchMobile: null,
          },
        },
      ],
      failureClass: 'placement',
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('parses a CRITICAL styling verdict (failureClass: "styling")', () => {
    const verdict = JSON.stringify({
      pass: false,
      feedback:
        'BoughtTogether rendered with big rounded cards + chevron arrows that clash with the flat, square, arrow-less store cards.',
      corrections: [
        {
          action: 'styleBox',
          args: {
            page: 'Product',
            boxType: 'BoughtTogether',
            appearancePatch: { ImageBorderRadius: 0, NavigationArrowType: 'none' },
          },
        },
      ],
      failureClass: 'styling',
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('parses a MOBILE-ONLY styling failure fixed via appearancePatchMobile (still critical)', () => {
    // A break at only one width (mobile) is a critical styling fail; the fix is a
    // mobile-only styleBox override that leaves desktop untouched.
    const verdict = JSON.stringify({
      pass: false,
      feedback: 'The featured-collection cards are fine on desktop but far too tall on mobile.',
      corrections: [
        {
          action: 'styleBox',
          args: {
            page: 'Home',
            boxType: 'FeaturedCollection',
            appearancePatchMobile: { ImageHeightMobile: 140 },
          },
        },
      ],
      failureClass: 'styling',
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('parses an addBox correction that uses position "replace"', () => {
    const verdict = JSON.stringify({
      pass: false,
      feedback: 'The empty placeholder strip should be swapped for a Most Popular grid.',
      corrections: [
        {
          action: 'addBox',
          args: {
            page: 'Home',
            boxType: 'MostPopular',
            position: 'replace',
            anchorNumber: 3,
            appearancePatch: { Style: 'grid' },
            appearancePatchMobile: null,
          },
        },
      ],
      failureClass: 'placement',
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('parses a failing verdict that has no safe correction (empty corrections)', () => {
    const verdict = JSON.stringify({
      pass: false,
      feedback: 'The box could not be made to match the theme; flagging for a human.',
      corrections: [],
      failureClass: 'styling',
    });
    assertVerdictShape(JSON.parse(verdict));
  });

  it('rejects a verdict missing a contract key', () => {
    const bad = JSON.parse(JSON.stringify({ pass: true, feedback: 'ok', corrections: [] }));
    expect(() => assertVerdictShape(bad)).toThrow();
  });

  it('rejects a passing verdict with a non-null failureClass (invariant)', () => {
    const bad = JSON.parse(
      JSON.stringify({ pass: true, feedback: 'ok', corrections: [], failureClass: 'placement' }),
    );
    expect(() => assertVerdictShape(bad)).toThrow();
  });

  it('rejects a failing verdict with a null failureClass (invariant)', () => {
    const bad = JSON.parse(
      JSON.stringify({ pass: false, feedback: 'off', corrections: [], failureClass: null }),
    );
    expect(() => assertVerdictShape(bad)).toThrow();
  });

  it('rejects an unknown failureClass value', () => {
    const bad = JSON.parse(
      JSON.stringify({ pass: false, feedback: 'off', corrections: [], failureClass: 'layout' }),
    );
    expect(() => assertVerdictShape(bad)).toThrow();
  });

  it('rejects a correction using an action outside the three write verbs', () => {
    const bad = JSON.parse(
      JSON.stringify({
        pass: false,
        feedback: 'off',
        corrections: [{ action: 'reRender', args: {} }],
        failureClass: 'styling',
      }),
    );
    expect(() => assertVerdictShape(bad)).toThrow();
  });
});
