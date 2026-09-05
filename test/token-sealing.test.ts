/**
 * The one token-sealing implementation behind opaque file references and
 * inference continuations: the wire format is pinned by fixtures sealed under
 * the fixture secret, so the module can change only while every existing
 * token still opens.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretConfigurationError } from '../src/config';
import { decodeOpaqueContinuation } from '../src/inference/continuation';
import { fileTenantScope, openOwnedFileReference } from '../src/inference/file-references';
import {
  base64UrlDecode,
  base64UrlEncode,
  deriveSealingKey,
  openToken,
  sealToken,
  type SealingPurpose,
} from '../src/inference/token-sealing';
import { ENV } from './helpers';

/**
 * Sealed under the fixture `TOKEN_ENCRYPTION_SECRET` with `Date.now` frozen at
 * `SEALED_AT`. A byte of drift in key derivation, the envelope, the associated
 * data, or the alphabet leaves these unopenable.
 */
const SEALED_AT = Date.parse('2026-09-04T00:00:00.000Z');
const FIXTURE = {
  contextId: 'ctx-sealing-fixture',
  tenantScope: 'tenant:baf103fae488e76690bdd2b8a9daab56db953a7c9688b0a367452d174f0c31e2',
  accountScope: 'anthropic:62af8704764faf8ea82fc61c',
  reference:
    'file_ref_v1_eIv91TWz6bOrdf9jinYA3dapyeVepLG4Xl4xRQ2NnomR7PA88k4Onj7mCV8CI0fm_8jls82tQmmddDEtgr7XBvvmXmk2i0YSv-NPqqH_7RzW1BegOR9OAfcI7spTGXVl30NCCH2ZcDgduOY-AN1zpj6gvZwS6bltGrqePOi7zy2tGnMfVaUMCVTnZyUWapol7PleZ5t1VaqbRpsIxVwcvrsa5WemJCin--9_7YOKveEtqqwUB2PaESHQR_7DkMjIBpyZcRcDLs8eboRXzC99A3kw_PNorn-KIvSK5IBMlm572dwBwfzHa0goEBpMcPUS73DA9sJwOmsNL8W2VM7yT9BnVtP78F7mRrDHXQo2DQJMywBYc7rel0VCm4O8qmUWXyuM3gxyoq9A3r-w6OL43BXIdc892d3buYARso_cCsLMqEFMmadOkei0KYvks1SOURIS2-CLJ6o45l9osWfqby5nId-CILEmQby597P2yHysBA8X3dJjB2NwqGR09toicVuVZI9dcTIP_lSelWVM0oKP8xdHAWY6i7rnol32XYqUSnJCOJ82m18PxieNRvGrrAwYi90Kv1pFCSda9ewlGzUKHBQzF2WrFdCDHmcN',
  continuation:
    'continuation_v2_1e2Brr9ByNM54P0gCqCUC89HRA9xiBkjsgkt73V198YLVbdq49S74VXx97yDWL675ELzCsXMwx8jh2X06hLF6pEpXmZd9nKqXpzfrwBc8tfch9LFP6_QusLgKU8SG0K9mb461ZA0NJ3FicwFFzyNrhReI2NTw-l8RA9DMX4D3jE6FZM4V8ptFQ9FJHLpHBuvicPhqSrQGnvR6CPIR-E6NehzrKwNkDK3IFtcn07h-sD_F9eB3kyKO61XHNRN-qBjgN5NJsdnOhBLmLY-h31xbX3s3iBbLeWQ-9JgJQIgmgAZ0kRf7V0CShBxA_kVG9L_KiXiWt3Ba3veS9OklEJ1KoFkJjGisCQY1R4ZBFE_T6TrDIIONjKgevPVkjSrmYoOjjay-2zs8qn5_7milzTlaxWzmjWHp7sWTK_2uPRwcxvaJDQJKlU',
} as const;

const PURPOSE: SealingPurpose = { salt: 'app-ai:test:v1', info: 'test-encryption' };

afterEach(() => vi.restoreAllMocks());

describe('sealed token wire format', () => {
  it('opens a file reference sealed before this module existed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SEALED_AT + 60 * 60 * 1000);
    await expect(fileTenantScope(FIXTURE.contextId, ENV)).resolves.toBe(FIXTURE.tenantScope);
    await expect(
      openOwnedFileReference(FIXTURE.reference, ENV, FIXTURE.tenantScope),
    ).resolves.toEqual({
      provider: 'anthropic',
      accountScope: FIXTURE.accountScope,
      tenantScope: FIXTURE.tenantScope,
      filePolicy: 'anthropic-provider-files',
      compatibleGroups: ['placement-vision'],
      upstreamFileId: 'file_sealed_fixture',
      contentHash: 'sha256:fixture',
      mediaType: 'image/png',
      sizeBytes: 7,
      expiresAt: null,
    });
  });

  it('opens a continuation sealed before this module existed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(SEALED_AT + 60 * 60 * 1000);
    await expect(
      decodeOpaqueContinuation(
        FIXTURE.continuation,
        {
          tenantScope: FIXTURE.tenantScope,
          promptGroup: 'studio-visual-agent',
          modelProfile: 'claude-opus',
        },
        ENV,
      ),
    ).resolves.toEqual({
      backend: 'anthropic',
      value: { contentBlocks: [{ type: 'text', text: 'fixture' }] },
    });
  });
});

describe('sealToken / openToken', () => {
  it('round-trips under the sealing key and refuses tampering, a foreign prefix, and a foreign purpose', async () => {
    const key = await deriveSealingKey(ENV, PURPOSE, 'AES-GCM', ['encrypt', 'decrypt']);
    const token = await sealToken('t_', key, '{"hello":"world"}');
    expect(token).toMatch(/^t_[A-Za-z0-9_-]+$/);
    await expect(openToken('t_', key, token)).resolves.toBe('{"hello":"world"}');

    const tampered = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(openToken('t_', key, tampered)).rejects.toThrow();
    await expect(openToken('u_', key, `u_${token.slice(2)}`)).rejects.toThrow();
    await expect(openToken('t_', key, 't_AAAA')).rejects.toThrow('invalid sealed token');

    const otherPurpose = await deriveSealingKey(ENV, { ...PURPOSE, info: 'other' }, 'AES-GCM', [
      'encrypt',
      'decrypt',
    ]);
    await expect(openToken('t_', otherPurpose, token)).rejects.toThrow();
  });

  it('reports an absent or malformed secret as configuration, not as the caller token', async () => {
    const { TOKEN_ENCRYPTION_SECRET: _absent, ...missing } = ENV;
    await expect(deriveSealingKey(missing, PURPOSE, 'HMAC', ['sign'])).rejects.toBeInstanceOf(
      SecretConfigurationError,
    );
    await expect(deriveSealingKey(missing, PURPOSE, 'HMAC', ['sign'])).rejects.toThrow(
      /Missing required configuration variable TOKEN_ENCRYPTION_SECRET/,
    );
    await expect(
      deriveSealingKey({ ...ENV, TOKEN_ENCRYPTION_SECRET: '***' }, PURPOSE, 'HMAC', ['sign']),
    ).rejects.toThrow('TOKEN_ENCRYPTION_SECRET must be valid base64');
    await expect(
      deriveSealingKey({ ...ENV, TOKEN_ENCRYPTION_SECRET: 'c2hvcnQ=' }, PURPOSE, 'HMAC', ['sign']),
    ).rejects.toMatchObject({
      name: 'SecretConfigurationError',
      message: 'TOKEN_ENCRYPTION_SECRET must decode to exactly 32 bytes',
    });
  });
});

describe('base64url', () => {
  it('round-trips a payload larger than the JavaScript argument limit', () => {
    const bytes = Uint8Array.from({ length: 300 * 1024 }, (_, index) => (index * 7919) % 256);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it('is unpadded and uses the url alphabet', () => {
    expect(base64UrlEncode(new Uint8Array([251, 255, 191]))).toBe('-_-_');
    expect(base64UrlEncode(new Uint8Array([1]))).toBe('AQ');
    expect(base64UrlDecode('AQ')).toEqual(new Uint8Array([1]));
  });
});
