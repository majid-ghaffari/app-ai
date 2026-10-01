const WWW_LABEL = 'www.';

/**
 * Whether two storefront origins are the same store: the same scheme and port, and hosts equal once
 * one leading `www.` label, where present, is removed from each. The URL parser lowercases and
 * IDN-normalises both hosts first. No other subdomain is equivalent and nothing crosses domains.
 */
export function isSameStoreOrigin(first: string, second: string): boolean {
  const firstUrl = parsedOrigin(first);
  const secondUrl = parsedOrigin(second);
  return (
    firstUrl !== null &&
    secondUrl !== null &&
    firstUrl.protocol === secondUrl.protocol &&
    firstUrl.port === secondUrl.port &&
    storeHost(firstUrl.hostname) === storeHost(secondUrl.hostname)
  );
}

function storeHost(hostname: string): string {
  return hostname.startsWith(WWW_LABEL) ? hostname.slice(WWW_LABEL.length) : hostname;
}

function parsedOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.hostname ? url : null;
  } catch {
    return null;
  }
}
