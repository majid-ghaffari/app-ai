/**
 * Model-id comparison shared by the paid provider probe scripts.
 *
 * A configured id is often an ALIAS: the provider answers, or publishes, the
 * dated or numbered snapshot the alias resolved to. Comparing for equality
 * fails a perfectly good response for that reason alone, so the probes use the
 * rule here instead.
 */

/**
 * Whether `returned` is `requested`, or the snapshot `requested` resolved to
 * (`gpt-5-mini` → `gpt-5-mini-2025-08-07`, `gemini-3.5-flash` →
 * `gemini-3.5-flash-002`). The suffix must be DATED or NUMBERED: a word suffix
 * names a different model, and a bare prefix test would let `gpt-5` swallow
 * `gpt-5-mini` and `gemini-3.5-flash` swallow `gemini-3.5-flash-lite`.
 */
export function resolvesToRequestedModel(returned, requested) {
  if (typeof returned !== 'string') return false;
  if (returned === requested) return true;
  if (!returned.startsWith(`${requested}-`)) return false;
  return /^\d/.test(returned.slice(requested.length + 1));
}
