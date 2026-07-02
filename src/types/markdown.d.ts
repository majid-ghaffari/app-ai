/**
 * Prompt `.md` files import as their raw text contents (bundled at build time):
 * the `[[rules]] type = "Text"` rule in wrangler.toml for the worker bundle,
 * and the inline raw-markdown plugin in vitest.config.ts for tests.
 */
declare module '*.md' {
  const text: string;
  export default text;
}
