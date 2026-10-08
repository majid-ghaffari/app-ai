import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as anthropicWire from '../src/inference/adapters/anthropic-wire';
import * as geminiWire from '../src/inference/adapters/gemini-wire';
import * as kimiWire from '../src/inference/adapters/kimi-wire';
import * as moonshotWire from '../src/inference/adapters/moonshot-wire';
import * as openaiWire from '../src/inference/adapters/openai-wire';
import type { Env } from '../src/config';
import { ENV } from './helpers';
import { startStubOrigin, type StubOrigin, type StubReply } from './network-harness.mjs';

const PATHS = [
  '/v1/files',
  '/v1/files/file-1',
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/responses',
  '/v1/chat/completions',
  '/coding/v1/chat/completions',
  '/coding/v1/files',
  '/v1beta/models/gemini-3-pro:generateContent',
  '/v1beta/models/gemini-3-pro:streamGenerateContent',
  '/v1beta/models/gemini-3-pro:countTokens',
  '/upload/v1beta/files',
  '/upload/v1beta/files/session',
  '/v1beta/files/file-1',
];
const MESSAGES = {
  model: 'claude-sonnet-5',
  max_tokens: 16,
  messages: [{ role: 'user' as const, content: 'Hello' }],
};
const PAYLOAD = { model: 'model', messages: [{ role: 'user', content: 'Hello' }] };

const redirected: string[] = [];
const reached: string[] = [];
let providerOrigin: StubOrigin;
let elsewhere: StubOrigin;
let env: Env;

function routes(answer: (path: string) => StubReply): Record<string, () => StubReply> {
  return Object.fromEntries(PATHS.map((path) => [path, () => answer(path)]));
}

beforeAll(async () => {
  elsewhere = await startStubOrigin(
    routes((path) => {
      reached.push(path);
      return { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' };
    }),
  );
  providerOrigin = await startStubOrigin(
    routes((path) => {
      redirected.push(path);
      return { status: 307, headers: { Location: `${elsewhere.origin}${path}` }, body: '' };
    }),
  );
  env = {
    ...ENV,
    ANTHROPIC_API_BASE: providerOrigin.origin,
    OPENAI_API_BASE: providerOrigin.origin,
    MOONSHOT_API_BASE: providerOrigin.origin,
    KIMI_API_BASE: `${providerOrigin.origin}/coding`,
    GEMINI_API_BASE: `${providerOrigin.origin}/v1beta`,
  };
});

afterAll(async () => {
  await providerOrigin?.close();
  await elsewhere?.close();
});

beforeEach(() => {
  redirected.length = 0;
  reached.length = 0;
});

describe('a provider redirect to another origin over real HTTP', () => {
  const calls: readonly (readonly [string, string, () => Promise<Response>])[] = [
    ['Anthropic uploadFile', '/v1/files', () => anthropicWire.uploadFile(new FormData(), env)],
    [
      'Anthropic getFileMetadata',
      '/v1/files/file-1',
      () => anthropicWire.getFileMetadata('file-1', env),
    ],
    ['Anthropic deleteFile', '/v1/files/file-1', () => anthropicWire.deleteFile('file-1', env)],
    ['Anthropic createMessage', '/v1/messages', () => anthropicWire.createMessage(MESSAGES, env)],
    [
      'Anthropic countTokens',
      '/v1/messages/count_tokens',
      () => anthropicWire.countTokens(MESSAGES, env),
    ],
    ['Anthropic streamMessage', '/v1/messages', () => anthropicWire.streamMessage(MESSAGES, env)],
    ['OpenAI createResponse', '/v1/responses', () => openaiWire.createResponse(PAYLOAD, env)],
    ['OpenAI uploadFile', '/v1/files', () => openaiWire.uploadFile(new FormData(), env)],
    ['OpenAI getFileMetadata', '/v1/files/file-1', () => openaiWire.getFileMetadata('file-1', env)],
    ['OpenAI deleteFile', '/v1/files/file-1', () => openaiWire.deleteFile('file-1', env)],
    [
      'Gemini generateContent',
      '/v1beta/models/gemini-3-pro:generateContent',
      () => geminiWire.generateContent('gemini-3-pro', PAYLOAD, env),
    ],
    [
      'Gemini streamGenerateContent',
      '/v1beta/models/gemini-3-pro:streamGenerateContent',
      () => geminiWire.streamGenerateContent('gemini-3-pro', PAYLOAD, env),
    ],
    [
      'Gemini countTokens',
      '/v1beta/models/gemini-3-pro:countTokens',
      () => geminiWire.countTokens('gemini-3-pro', PAYLOAD, env),
    ],
    [
      'Gemini startResumableUpload',
      '/upload/v1beta/files',
      () => geminiWire.startResumableUpload('tile.webp', 4, 'image/webp', env),
    ],
    [
      'Gemini finishResumableUpload',
      '/upload/v1beta/files/session',
      () =>
        geminiWire.finishResumableUpload(
          `${providerOrigin.origin}/upload/v1beta/files/session`,
          new Uint8Array([1, 2, 3, 4]),
        ),
    ],
    ['Gemini getFile', '/v1beta/files/file-1', () => geminiWire.getFile('files/file-1', env)],
    ['Gemini deleteFile', '/v1beta/files/file-1', () => geminiWire.deleteFile('files/file-1', env)],
    [
      'Moonshot createChatCompletion',
      '/v1/chat/completions',
      () => moonshotWire.createChatCompletion(PAYLOAD, env),
    ],
    ['Moonshot uploadFile', '/v1/files', () => moonshotWire.uploadFile(new FormData(), env)],
    [
      'Moonshot getFileMetadata',
      '/v1/files/file-1',
      () => moonshotWire.getFileMetadata('file-1', env),
    ],
    ['Moonshot deleteFile', '/v1/files/file-1', () => moonshotWire.deleteFile('file-1', env)],
    [
      'Kimi Code createChatCompletion',
      '/coding/v1/chat/completions',
      () => kimiWire.createChatCompletion(PAYLOAD, env),
    ],
    ['Kimi Code uploadImage', '/coding/v1/files', () => kimiWire.uploadImage(new FormData(), env)],
  ];

  for (const [name, path, call] of calls) {
    it(`is refused for ${name}, and nothing reaches the origin it names`, async () => {
      await expect(call()).rejects.toThrow(/redirect/);
      expect(redirected).toEqual([path]);
      expect(reached).toEqual([]);
    });
  }
});
