# Visual Verification — Maintenance Doc

The design/maintenance record for the `visual-verify` prompt — the UNIFIED quality-gate reasoner used by BOTH the internal test harness (through the FREE Claude-Code channel) and the product's own customer-side self-verify-and-fix loop. The runtime file it documents lives at [`src/prompts/visual-verify/prompt.md`](../../src/prompts/visual-verify/prompt.md) (system prompt), registered as `visual-verify` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md).

It is registered like a probe (header-selected on `POST /messages`, JSON-only, no tools, Sonnet) but is deliberately NOT a `probe-<id>` name: a probe is a Website-Analysis capability; `visual-verify` is a cross-side quality gate. The lib-side design contract is `packages/storefront/src/admin/docs/AI-VISUAL-VERIFICATION-PLAN.md` and the wire contract is lib `ai/CONTRACTS.md` → Visual Verification.

## `visual-verify`

- **Purpose:** Decide whether a plain-language `intent` (a claim about what the merchant should see) is ACTUALLY TRUE of what rendered — reasoning over a MULTI-MODAL snapshot (screenshot + DOM/HTML + console + element-inspection) TOGETHER. Pixels are the source of truth; DOM presence is not proof of paint. Returns pass/fail + reason + an optional concrete fix.
- **Model:** the `balanced` tier (currently `claude-sonnet-5`). The multi-modal reasoning is on par with the visual/behavioral probes.
- **Tools:** none (one-shot JSON).
- **Attachments:** none. The caller uploads the rendered snapshot's screenshot + HTML per request.

### Input

A single `intent` plus a multi-modal snapshot of the ACTUAL rendered result:

- **screenshot** (image, uploaded via `/files`) — the rendered pixels. THE primary evidence.
- **html** (document, uploaded via `/files`) — a cleaned excerpt of the relevant DOM.
- **consoleLog** (text block) — recent `console.error` / `console.warn` + `window.onerror` lines.
- **inspection** (text block) — computed facts about the target: its `getBoundingClientRect`, key `getComputedStyle` values, and the `document.elementFromPoint` hit-test at its center (is the TOP element there the target/a descendant, or is it covered by a scrim/overlay?).
- **intent** (text block) — the plain-language claim to confirm.

Any field may be partial or missing — the judge never fails, it reasons from what remains.

### Frozen output contract

The assistant text is a single JSON object, exactly:

```json
{
  "pass": false,
  "reason": "string — factual, cites the deciding evidence",
  "fix": { "action": "string", "args": {} }
}
```

- `pass` — the honest verdict on whether the `intent` is TRUE of the rendered result.
- `reason` — a short, factual explanation citing the evidence (screenshot, rect, hit-test, console).
- `fix` — `{ action, args }` OR `null`. A concrete correction the client applies through its existing edit path, then RE-VERIFIES; `null` when none can be reasoned out. The client skips an action it doesn't recognize, so an unknown action degrades to "no auto-fix" safely.

No extra keys, no missing keys. The lib consumer (`ai/analysis/render-verify.ts`) builds to this shape — do not deviate without updating both sides.

### Request/response contract (frozen)

- `POST {base}/messages`, header `X-Personalizer-System-Prompt: visual-verify`.
- Body: a standard Anthropic messages payload. User content = the screenshot (image) + HTML (document) blocks (uploaded via `POST /files`) plus a text block carrying the console lines + inspection facts + the `intent`. Body omits `model` so the registry (the `balanced` tier = `claude-sonnet-5`) is authoritative.
- Response: the Anthropic messages envelope; the assistant text block is the JSON above.
- **Cost:** dev/test route through the FREE Claude-Code channel (the shim); prod through app-ai; never the paid API except a prod smoke. See lib `docs/LOCAL-AI-DEV.md`.
