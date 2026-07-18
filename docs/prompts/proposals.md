# Setup Proposals — Maintenance Doc

The design/maintenance record for the `proposals` per-store SETUP PROPOSAL prompt. The runtime file it documents lives at [`src/prompts/proposals.md`](../../src/prompts/proposals.md) (system prompt), registered as `proposals` in [`src/prompt-registry.ts`](../../src/prompt-registry.ts). The authoring/iteration process is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md).

## What it is

`proposals` produces the onboarding's per-store SETUP PROPOSAL — which recommendation boxes to place on which pages, which audience segments to activate, what cart progress-bar offer + threshold to use, and which bundle discounts to recommend. It drives lib's AI-driven onboarding recommendations (lib `admin/ai/brain/proposals.ts::fetchAiProposals`), which the setup / progress-bar / bundles / segments step seams consume. When the call is unreachable, lib falls back to its best-practice catalog — the proposal never breaks onboarding.

## Grounding — REAL PAGE EVIDENCE + REAL STORE DATA (tool-capable)

Two grounding sources, combined:

1. **Page evidence.** The prompt reasons over the merchant's OWN storefront pages, captured live: for each page a cleaned-HTML document + a screenshot image, uploaded via `POST /files` and sent as `document` / `image` content blocks on the first user message — the SAME muscle as `image-selection` and the Website-Analysis probes. Each page's evidence is preceded by a short `PAGE: <type>` text block. On the `/chat` transport, the page evidence is passed as `fileIds` (the handler's `normalizeMessages` prepends the file blocks to the first user turn).

2. **Real store data, pulled on demand.** `proposals` runs on the `/chat` tool-use loop (`usesTools: true`), so during reasoning the model can CALL the always-active personalizer toolset — `get_store_analytics` (real AOV / order count / revenue), `list_segments`, `list_campaigns`, `get_store_config` — which app-ai proxies server→server to Brain's `v2/ai-tools/*` endpoints, forwarding the merchant's context-ID. These are REAL endpoints (Brain `aidin/ai-tools-endpoints`: `store-analytics`, `segments`, `campaigns`, `store-config`). The AOV-derived progress-bar threshold comes from `get_store_analytics`; existing segments/campaigns are reflected via `list_*`.

The LimeSpot best-practice catalog (`context.grounding`) still rides along as the specifics playbook (page stacks, audience order, progress-bar ladder). The progress-bar threshold prefers the real AOV from `get_store_analytics`; only when that data isn't available does it fall back to a best-practice default for the store's currency + observed price points — the prompt states which basis it used in the rationale.

### Transport (`/chat`, not `/messages`)

`proposals` is selected via `X-Personalizer-System-Prompt: proposals` on `POST /chat` (the tool-use path — `handlers/chat.ts::runAgentLoop` dispatches the personalizer tools), NOT the single-shot `/messages` path. The lib client sends its message history + the page-evidence `fileIds`; the non-streaming JSON response (`{ text, stopReason, iterations, usage }`) carries the assistant's JSON proposal as `text` (or the SSE `done` payload when streaming). The best-practice catalog is passed as `context.grounding` (folded into the system array by `buildSystem`).

## Model

The `balanced` tier — registry-authoritative, `claude-sonnet-5`. A cost/quality-tuned page-evidence + tool-grounded JSON reasoner, deliberately DISTINCT from the default `frontier` tier (the agent-loop model). It runs a bounded tool-use loop (a few data pulls) then emits the structured proposal, so Sonnet is the right trade. No `temperature` / `top_p` / `top_k` — current models reject them. No `effort` (Sonnet's default output effort is fine here).

## Output contract (unchanged — the four consumer slices)

A single JSON object (no prose, no fences):

```
{ "reply": string,
  "setup": [{ "page": ..., "boxes": [{ "box": ..., "rationale": ... }] }],
  "segments": [{ "title": ..., "rationale": ... }],
  "progressBar": { "offerType": ..., "threshold": number, "rationale": ... },
  "bundles": [{ "title": ..., "audience": ..., "rationale": ... }] }
```

lib's `parseProposals` (tolerant: direct / fenced / embedded) sanitizes each slice into the typed shape the step seams consume. Keeping this schema stable is what lets the onboarding consumers work unchanged.

## Tests

- `test/proposals.test.ts` — registry resolution (`usesTools: true`, model = the `balanced` tier ≠ the default `frontier` tier (`ENV.MODEL_BALANCED` ≠ `ENV.MODEL_FRONTIER`)), the prompt reasons over page evidence AND instructs the model to pull real store data via the personalizer tools (AOV threshold), and `POST /chat` routing (personalizer tool surface sent + page-evidence file blocks prepended, and the tool loop: tool_call → Brain `v2/ai-tools` → tool_result → final JSON proposal).
- `test/config.test.ts` — the `resolveModel(env, 'balanced')` mapping + the wrangler `MODEL_BALANCED` `[vars]` pin.
