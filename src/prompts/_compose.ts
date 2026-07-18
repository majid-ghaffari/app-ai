/**
 * Compose a multi-file / composed prompt's system text from ordered parts (main
 * prompt first, then any additional context / composed BLOCK parts). Parts are
 * the already-imported STRING CONTENTS of `.md` files — each is trimmed and the
 * parts are joined with a blank line. Falsy parts are skipped. The join is the
 * whole compose contract: `composePrompt(a, b, c)` === `[a,b,c].map(trim).join('\n\n')`,
 * so a stable part order yields a byte-stable, cacheable prefix.
 */
export function composePrompt(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((part) => part.trim())
    .join('\n\n');
}
