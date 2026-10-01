import { describe, expect, it } from 'vitest';

import { isSameStoreOrigin } from '../src/lib/store-origin';

describe('isSameStoreOrigin', () => {
  it('treats a store bare domain and its www subdomain as one store, in either direction', () => {
    expect(isSameStoreOrigin('https://example.com', 'https://www.example.com')).toBe(true);
    expect(isSameStoreOrigin('https://www.example.com', 'https://example.com')).toBe(true);
    expect(isSameStoreOrigin('https://example.com', 'https://example.com')).toBe(true);
    expect(isSameStoreOrigin('https://www.shop.example.com', 'https://shop.example.com')).toBe(
      true,
    );
  });

  it('compares hosts after the URL parser lowercases and IDN-normalises them', () => {
    expect(isSameStoreOrigin('https://WWW.Example.COM', 'https://example.com')).toBe(true);
    expect(isSameStoreOrigin('https://www.bücher.example', 'https://xn--bcher-kva.example')).toBe(
      true,
    );
  });

  it('refuses every other subdomain, lookalike domain and second www label', () => {
    expect(isSameStoreOrigin('https://shop.example.com', 'https://example.com')).toBe(false);
    expect(isSameStoreOrigin('https://evilexample.com', 'https://example.com')).toBe(false);
    expect(isSameStoreOrigin('https://wwwexample.com', 'https://example.com')).toBe(false);
    expect(isSameStoreOrigin('https://www.www.example.com', 'https://example.com')).toBe(false);
    expect(isSameStoreOrigin('https://www.www.example.com', 'https://www.example.com')).toBe(false);
    expect(isSameStoreOrigin('https://example.com.evil.test', 'https://example.com')).toBe(false);
  });

  it('requires the scheme and port to match exactly', () => {
    expect(isSameStoreOrigin('http://www.example.com', 'https://example.com')).toBe(false);
    expect(isSameStoreOrigin('https://www.example.com:8443', 'https://example.com')).toBe(false);
    expect(isSameStoreOrigin('https://www.example.com:8443', 'https://example.com:8443')).toBe(
      true,
    );
    expect(isSameStoreOrigin('https://www.example.com:443', 'https://example.com')).toBe(true);
  });

  it('matches nothing to a value that is not an origin', () => {
    expect(isSameStoreOrigin('not a url', 'not a url')).toBe(false);
    expect(isSameStoreOrigin('', 'https://example.com')).toBe(false);
  });
});
