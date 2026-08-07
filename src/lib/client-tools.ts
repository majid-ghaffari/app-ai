/**
 * CLIENT-executed tool definitions (the `clientTools` capability seam).
 *
 * A CLIENT tool is a `ToolDefinition` whose execution happens in the merchant's
 * BROWSER (the store iframe is the AI's hands), not in the worker. A prompt that
 * lists client tools runs the /chat loop in CLIENT-tool mode: on a `tool_use` the
 * handler returns the calls in `done.toolCalls` and STOPS — it never executes
 * them (handlers/chat.ts). `clientTools` is mutually exclusive with `usesTools`
 * (a prompt is EITHER server-tool OR client-tool, never both).
 *
 * ── `look_at_page` — the visual-inspection client tool (#111) ─────────────────
 * The FIRST live consumer of the dormant client-tool mode. It lets the chat model
 * ASK the browser to LOOK at a page: the lib executor captures (or serves a cached)
 * full-page screenshot of the named page, uploads it via /files, and re-calls /chat
 * with the screenshot appended as an image block on the `tool_result` turn — so the
 * model can SEE what actually rendered before it answers or refines. `page` is an
 * OPTIONAL hint (the page name — `Home` / `Product` / `Collection` / `Cart` / …);
 * omitted means "the page the merchant is currently on". The lib side owns the
 * capture/cache seam + the bounded relay loop (lib ai/agent/look-at-page.ts); this
 * module owns ONLY the wire schema the model sees.
 */

import type { ToolDefinition } from './anthropic';

/**
 * `look_at_page` — ask the browser to capture (or serve a cached) full-page
 * screenshot of a store page so the model can visually inspect what rendered.
 * Input: an OPTIONAL `page` name hint; omitted = the merchant's current page.
 * Executed CLIENT-side (the store iframe), never in the worker.
 */
export const LOOK_AT_PAGE_TOOL: ToolDefinition = {
  name: 'look_at_page',
  description:
    "Look at a page of the merchant's live store: capture (or serve a cached) full-page " +
    'screenshot so you can SEE what actually rendered before you answer or refine a box. ' +
    'Use it whenever you need to verify placement, styling, or how a change looks on the ' +
    'real page. `page` is an optional page-name hint (e.g. "Home", "Product", "Collection", ' +
    '"Cart"); omit it to look at the page the merchant is currently viewing.',
  input_schema: {
    type: 'object',
    properties: {
      page: {
        type: 'string',
        description:
          'Optional page-name hint to look at (e.g. "Home", "Product", "Collection", "Cart"). ' +
          'Omit to look at the page the merchant is currently on.',
      },
    },
  },
};
