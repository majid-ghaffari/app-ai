/**
 * Gemini's shared thinking/answer output budget.
 *
 * Gemini's `maxOutputTokens` is ONE budget covering thinking tokens AND the
 * answer, where Anthropic's `max_tokens` bounds the answer alone. A canonical
 * `maxOutputTokens` means the ANSWER budget — that is what a prompt group sizes
 * and what a caller reads back — so a Gemini request carries that budget PLUS an
 * allowance for the thinking that shares it. Sending the answer budget unchanged
 * would hand a prompt a smaller answer purely because it landed on this
 * provider, and a small budget can be spent entirely on thoughts: HTTP 200,
 * `finishReason: MAX_TOKENS`, and nothing but `thought: true` parts.
 *
 * The allowance is per thinking LEVEL because Gemini 3 exposes thinking as the
 * qualitative `thinkingLevel` rather than a token count, so an exact split
 * cannot be pinned. The level is therefore always sent — including for a request
 * that declares no effort — so the reserved share is a declared translation
 * rather than a guess at whichever level the provider would have chosen. Unused
 * output tokens are not billed, so the allowance costs nothing on a turn that
 * thinks less than it reserves.
 *
 * The sizing lives in its own dependency-free module because the paid probe
 * matrix (`scripts/verify-gemini.mjs`) sizes its requests through it too: a
 * probe sending a budget of its own would exercise a request shape production
 * never sends.
 */

/** The thinking ladder `thinkingLevel` accepts on the served model family. */
export type GeminiThinkingLevel = 'low' | 'medium' | 'high';

/** Output tokens reserved for the thinking half of the shared budget, per level. */
export const GEMINI_THINKING_ALLOWANCE_TOKENS: Readonly<Record<GeminiThinkingLevel, number>> = {
  low: 4096,
  medium: 8192,
  high: 16384,
};

/**
 * The level a request resolves to when it declares no effort — the most
 * expensive level the model could pick, so the allowance can never
 * under-reserve against what the provider actually spends.
 */
export const GEMINI_DEFAULT_THINKING_LEVEL: GeminiThinkingLevel = 'high';

/** The `maxOutputTokens` a request carries to hold `answerTokens` plus its thinking. */
export function geminiSharedOutputBudget(answerTokens: number, level: GeminiThinkingLevel): number {
  return answerTokens + GEMINI_THINKING_ALLOWANCE_TOKENS[level];
}
