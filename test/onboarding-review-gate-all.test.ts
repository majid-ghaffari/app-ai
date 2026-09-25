import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMessages } from '../src/handlers/messages';
import { getSystemPrompt } from '../src/prompt-registry';
import {
  anthropicMessage,
  CORS,
  ENV,
  fetchCall,
  fetchedUrls,
  sentBody,
  stubFetch,
} from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('onboarding-review-gate-all', () => {
  it('is a compact fast-tier, correction-free prompt', () => {
    const entry = getSystemPrompt('onboarding-review-gate-all', ENV);
    expect(entry.model).toBe(ENV.MODEL_FAST);
    expect(entry.maxTokens).toBe(64000);
    expect(entry.usesTools).toBe(false);
    expect(entry.attachments).toEqual([]);
    expect(entry.prompt).toContain('issueCodes');
    expect(entry.prompt).toMatch(/Do not propose corrections/i);
    expect(entry.prompt).not.toContain('styleBox');
  });

  it('routes through /messages with registry-owned model and budget', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(anthropicMessage()), { status: 200 }));
    const request = new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': 'onboarding-review-gate-all',
        'X-Personalizer-Ruleset-Version':
          getSystemPrompt('onboarding-review-gate-all', ENV).rulesetVersion ?? '',
      },
      body: JSON.stringify({
        max_tokens: 99999,
        messages: [{ role: 'user', content: 'gate' }],
      }),
    });

    expect((await handleMessages(request, ENV, CORS)).status).toBe(200);
    const index = fetchedUrls(fetchMock).findIndex((url) => url.endsWith('/v1/messages'));
    const body = sentBody(fetchCall(fetchMock, index).init);
    expect(body.model).toBe(ENV.MODEL_FAST);
    expect(body.max_tokens).toBe(64000);
    expect(body.system).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('fast whole-store visual quality gate'),
        }),
      ]),
    );
  });
});
