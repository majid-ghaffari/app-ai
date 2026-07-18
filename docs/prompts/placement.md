# Placement Prompt — Maintenance Doc

The design/maintenance record for the `placement` prompt — the live, standalone placement proposer. The runtime file it documents lives at [`src/prompts/placement.md`](../../src/prompts/placement.md) (system prompt), registered as `placement` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). The authoring/iteration process — artifact conventions, length enforcement, how this doc is kept — is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md).

## What it is

`placement` is the fast, one-shot placement proposer: given ONE storefront page (its type, a cleaned-HTML document, a screenshot, and a list of VALIDATED CANDIDATE anchor elements) it returns a single structured JSON proposal for WHERE to insert a recommendation box — which box strategy, which candidate anchor (by index), and whether the box goes `before` or `after` it. No prose, no markdown, no tools. It is the interactive/live placement path — the merchant is waiting on the reply — which is why it runs on the faster model and emits a small JSON object in one turn rather than reasoning through a multi-page plan.

## Single-file prompt

This is a SINGLE-FILE prompt: the entire system text is [`src/prompts/placement.md`](../../src/prompts/placement.md). It is NOT composed from `onboarding-shared/` blocks and has no attachments or sample file. Editing `src/prompts/placement.md` affects ONLY this prompt — nothing else imports it, and it imports nothing. There is no shared-block snapshot to re-baseline (unlike the composed onboarding/cart-drawer prompts).

## Model

The `fast` tier — registry-authoritative, resolved via `resolveModel(env, 'fast')` ([`src/config.ts`](../../src/config.ts)), pinned to `claude-haiku-4-5` in [`wrangler.toml`](../../wrangler.toml) `[vars]` (`MODEL_FAST`). Haiku 4.5 is the FASTER model, deliberately distinct from the default `frontier` tier (Opus, the chat/onboarding agent loop) and the `balanced` tier (Sonnet, the page-evidence setup reasoner) — placement is latency-sensitive, single-turn, and structurally simple, so the fast model is the right trade.

No `temperature` / `top_p` / `top_k` — current models reject them. Critically, **no `effort`**: Haiku 4.5 does not support `output_config.effort` and rejects the field. The registry entry documents this and omits it deliberately; the handler also guards on model capability and would omit it regardless, so setting it here would be dead config. If placement ever moves to an effort-supporting model, add `effort: 'low'` at that point (see the comment on the `placement` entry in [`src/prompt-registry.ts`](../../src/prompt-registry.ts)).

## Tools

`usesTools: false`, no `clientTools`. This is a one-shot structured emitter, NOT an agent loop — it neither pulls store data (like `proposals` / `chat`) nor drives the browser (like `onboarding-chat`'s `look_at_page`). It receives everything it needs on the first turn and answers immediately.

## Transport (`/chat`, single-shot — no tool loop)

`placement` is selected via `X-Personalizer-System-Prompt: placement` on `POST /chat` ([`src/handlers/chat.ts`](../../src/handlers/chat.ts)). It rides the `/chat` handler for its file-block + candidate-context plumbing, but because `usesTools: false` there is NO tool-use loop — the model emits its JSON in the first (and only) assistant turn and the non-streaming JSON response carries it as `text`.

`maxTokens: 2048` — the output is a small object, so the ceiling is generous.

## Input contract — what the lib sends

- **Page evidence** (via `fileIds`, prepended to the first user turn by `normalizeMessages` in [`src/handlers/chat.ts`](../../src/handlers/chat.ts)): the page's SCREENSHOT (an `image` block — Anthropic rejects an image inside a `document` block) plus the CLEANED HTML (a `document` block), each uploaded via `POST /files` with SHA-256 dedup.
- **Validated candidates** (via `context.candidates`): the enumerated anchor list — each with an `index` and a human label — folded into the system array by `buildSystem` as `Validated placement candidates (pick by index):` followed by the JSON. The model picks by INDEX; it never invents a CSS selector.
- **Page type / current page** (via `context.hostPage`): rendered as `Current page: <type>.` so the model knows the page kind (Home / Product / Cart / Collection / Search / Blog / 404) and can apply the best-practice box-per-page mapping.

## Output contract

A single JSON object — no prose, no fences, nothing else:

```
{
  "reply": "<one short merchant-facing sentence explaining the placement>",
  "proposals": [
    {
      "box": "<box strategy label, e.g. 'Most Popular', 'Frequently Bought Together', 'Related', 'Recently Viewed'>",
      "page": "<the page type given to the model>",
      "candidateIndex": <integer index into the candidate list, or -1 to append to the page container>,
      "position": "before" | "after"
    }
  ]
}
```

Rules baked into the prompt:

- **Box-per-page best practice:** Home → Most Popular; Product → Frequently Bought Together; Cart → Upsell; Collection → Most Popular in Collection; Search/Blog/404 → You May Like.
- `candidateIndex` MUST be a valid index into the provided candidate list, or `-1` (append to the page container). Never a CSS selector.
- `before` / `after` is chosen so the box lands in a natural reading position (after the hero, before the footer).
- `reply` is one sentence; output the JSON object and nothing else.

## Relationship to sibling prompts

`placement` is the STANDALONE, faster placement decider. Several other prompts ALSO decide placement, but only as one slice of a larger plan:

- **`onboarding-batch` / `onboarding-batch-all`** (the batch PROPOSE prompts, Sonnet) place boxes as part of a whole-page / whole-store plan — for each page they return boxes with `{ boxType, anchorId, appearancePatch, reasoning }` plus an optional Cart progress bar, and the conductor applies them box-by-box. `placement` does the same core "which anchor, before/after" decision but stripped to ONE fast JSON object with no appearance patches, no reasoning fields, and no multi-page envelope.
- **`proposals`** (Sonnet) is the tool-grounded per-store SETUP PROPOSAL — it decides boxes-per-page AND segments AND progress-bar AND bundles, pulling real store data via the personalizer tools. `placement` is the opposite end: no tools, no data pulls, one page, one call.

Think of it as: the batch/proposals prompts are the deliberate planners; `placement` is the live, single-page, fast responder.

### failureClass note (downstream, in the review twins)

The batch flow's REVIEW prompts (`onboarding-review` / `-all`, `cartdrawer-review-all`) emit a `failureClass` on their verdicts, documented in the [`src/prompt-registry.ts`](../../src/prompt-registry.ts) comments: `null` on pass, `'placement'` for a NON-CRITICAL wrong-slot issue (the box landed in the wrong position but works), and `'styling'` for a CRITICAL visual break. `placement` itself does NOT emit `failureClass` — it is the proposer, not the reviewer. But its output feeds the same placement decision those reviewers grade, so a wrong `candidateIndex` / `position` from `placement` is exactly what a downstream review classifies as the NON-CRITICAL `'placement'` failure (as opposed to CRITICAL `'styling'`).

## Caching

The base system prompt is a stable reused prefix → 1h extended prompt cache (the `EXTENDED_CACHE_CONTROL` breakpoint on the base block in `buildSystem`). It is small (~370 tokens); the real per-request cost is the file prefix (screenshot + cleaned HTML). Those file blocks are ALSO cached: the same page's bytes dedup to the same `file_id`, and `normalizeMessages` marks the LAST file block with the 1h extended breakpoint, so repeated placement calls on one page read the whole file prefix at 0.1× on the second call. The volatile candidate-context block is intentionally UNCACHED (it changes per call), keeping the cached prefix byte-stable. Breakpoint budget stays ≤4 (file prefix 1 + system base 1). See the caching notes in [`src/handlers/chat.ts`](../../src/handlers/chat.ts) and the token-saving levers in the root [CLAUDE.md](../../CLAUDE.md).

## Tests

- `test/config.test.ts` — asserts `resolveModel(env, 'fast')` resolves to `claude-haiku-4-5`, throws on a missing `MODEL_FAST`, and the wrangler `[vars]` pin (`MODEL_FAST = "claude-haiku-4-5"`) is present in `productionVars()`.

## Constraints

- **Single JSON object, no prose/fences.** The output is machine-parsed; any wrapping text breaks the consumer.
- **`candidateIndex` is an index or `-1`, never a selector.**
- **No `effort` in the registry entry** — Haiku 4.5 rejects it (see Model above).
- Keep the prompt small — it is on the interactive path and every token is paid per call. Current size ~1,406 characters (~370 tokens); check with `wc -c src/prompts/placement.md` after any edit.

## Next steps

- Gather live edge cases (pages with no good candidate → `-1` append behavior; multi-box pages) and tighten the box-per-page mapping if production reveals misses.
- If placement moves off Haiku 4.5, revisit the `effort` omission.
