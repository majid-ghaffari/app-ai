/**
 * The one implementation of sealed public tokens: the shared secret's
 * validation, purpose-separated key derivation, the authenticated envelope
 * (nonce ‖ ciphertext under AES-GCM, with the token prefix as associated data),
 * and the unpadded base64url alphabet the tokens travel in.
 *
 * Opaque file references and inference continuations are both sealed here.
 * Each names its own purpose — an HKDF salt and info string — so the two never
 * share a key even though they share the secret, and their wire formats are
 * fixed by the prefix, nonce length, and alphabet declared once in this module.
 */

import { SecretConfigurationError, tokenEncryptionSecret, type Env } from '../config';

/** Bytes of random nonce that lead every sealed token. */
const NONCE_BYTES = 12;
/** AES-GCM's authentication tag; a token shorter than nonce + tag holds nothing. */
const TAG_BYTES = 16;
/** The shared secret decodes to exactly this many bytes. */
const SECRET_BYTES = 32;

/** What a derived key is for — an HKDF salt/info pair that isolates it from every other purpose. */
export interface SealingPurpose {
  readonly salt: string;
  readonly info: string;
}

/**
 * Derive one purpose's key from the shared secret. The secret is validated on
 * every derivation: absent, undecodable, or wrongly sized, it is a
 * `SecretConfigurationError` — an operator fault, never the caller's token.
 */
export async function deriveSealingKey(
  env: Env,
  purpose: SealingPurpose,
  algorithm: 'AES-GCM' | 'HMAC',
  usages: ('encrypt' | 'decrypt' | 'sign')[],
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', sealingSecretBytes(env), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(purpose.salt),
      info: new TextEncoder().encode(purpose.info),
    },
    baseKey,
    algorithm === 'AES-GCM'
      ? { name: 'AES-GCM', length: 256 }
      : { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    usages,
  );
}

/** Seal `plaintext` under `key` as `<prefix><base64url(nonce ‖ ciphertext)>`. */
export async function sealToken(
  prefix: string,
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(prefix) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return `${prefix}${base64UrlEncode(concatBytes(nonce, ciphertext))}`;
}

/**
 * Open a token sealed by `sealToken` under the same prefix and key, returning
 * its plaintext. Throws on any token that is too short, undecodable, or fails
 * authentication; the caller decides what that means for its route.
 */
export async function openToken(prefix: string, key: CryptoKey, token: string): Promise<string> {
  const sealed = base64UrlDecode(token.slice(prefix.length));
  if (sealed.byteLength <= NONCE_BYTES + TAG_BYTES) throw new Error('invalid sealed token');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: sealed.slice(0, NONCE_BYTES),
      additionalData: new TextEncoder().encode(prefix),
    },
    key,
    sealed.slice(NONCE_BYTES),
  );
  return new TextDecoder().decode(plaintext);
}

/** Throws `SecretConfigurationError` unless the shared secret is usable; the readiness check calls it. */
export function assertSealingSecretUsable(env: Env): void {
  sealingSecretBytes(env);
}

/** The shared secret's bytes, validated. */
function sealingSecretBytes(env: Env): Uint8Array {
  const encoded = tokenEncryptionSecret(env);
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(encoded);
  } catch {
    throw new SecretConfigurationError(
      'TOKEN_ENCRYPTION_SECRET',
      'TOKEN_ENCRYPTION_SECRET must be valid base64',
    );
  }
  if (bytes.byteLength !== SECRET_BYTES) {
    throw new SecretConfigurationError(
      'TOKEN_ENCRYPTION_SECRET',
      `TOKEN_ENCRYPTION_SECRET must decode to exactly ${SECRET_BYTES} bytes`,
    );
  }
  return bytes;
}

/** Unpadded base64url, encoded in bounded chunks so a large payload never overflows the call stack. */
export function base64UrlEncode(value: Uint8Array): string {
  let binary = '';
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The inverse of `base64UrlEncode`; throws on text outside the alphabet. */
export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return base64Decode(padded);
}

function base64Decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const output = new Uint8Array(first.byteLength + second.byteLength);
  output.set(first, 0);
  output.set(second, first.byteLength);
  return output;
}
