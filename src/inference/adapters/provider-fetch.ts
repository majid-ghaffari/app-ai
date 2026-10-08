/**
 * Fetch from an AI provider's API without following a redirect: the runtime is asked for `manual`,
 * and a 3xx answer is refused by throwing, so no body, credential or file id reaches the origin a
 * redirect names.
 */
export async function fetchProvider(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new TypeError(
      `${provider} answered ${response.status} with a redirect, which is never followed`,
    );
  }
  return response;
}
