import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleMessages } from '../src/handlers/messages';
import { getSystemPrompt } from '../src/prompt-registry';
import { CORS, ENV, fetchedUrls, stubFetch } from './helpers';

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

afterEach(() => vi.restoreAllMocks());

describe('onboarding-currency-recovery', () => {
  it('is a bounded JSON-only visual-action contract without a hardcoded currency', () => {
    const entry = getSystemPrompt('onboarding-currency-recovery', ENV);
    expect(entry.model).toBe(ENV.MODEL_BALANCED);
    expect(entry.maxTokens).toBe(512);
    expect(entry.usesTools).toBe(false);
    expect(entry.prompt).toContain('visualActions');
    expect(entry.prompt).toContain('setCurrencyFormat');
    expect(entry.prompt).not.toContain('CAD');
  });

  it('goes directly to inference without a blocking count_tokens request', async () => {
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      jsonOk({
        content: [
          {
            type: 'text',
            text: '{"visualActions":[{"action":"setCurrencyFormat","args":{"candidateId":"none"}}]}',
          },
        ],
      }),
    );
    const request = new Request('https://app-ai.test/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Personalizer-Context-ID': 'ctx',
        'X-Personalizer-System-Prompt': 'onboarding-currency-recovery',
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'file', file_id: 'price-tile' } },
              { type: 'text', text: 'CURRENCY RECOVERY DATA {}' },
            ],
          },
        ],
      }),
    });

    const response = await handleMessages(request, ENV, CORS);
    expect(response.status).toBe(200);
    expect(fetchedUrls(fetchMock)).toEqual(['https://api.anthropic.com/v1/messages']);
  });
});
