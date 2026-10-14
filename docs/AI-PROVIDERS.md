# AI providers

**Parent:** [../CLAUDE.md](../CLAUDE.md)

Which AI providers app-ai may send content to, how the code holds it to that, what each provider
keeps, and the account settings the no-training and retention statements also depend on.

## The allow-list

The source of truth is the workspace's canonical `ai-providers.json`, in the `limespot/root`
repository's `_standards` directory beside the legal-alignment standard: every AI provider the DPA
lists, by a stable name, its name exactly as the DPA prints it, and its official API origin.
`AI_SUBPROCESSORS` in `src/lib/ai-providers.ts` is app-ai's copy of that list, holding for each
stable name (`ANTHROPIC`, `OPENAI`, `GEMINI` for the paid tier only, and `CLOUDFLARE_WORKERS_AI`)
the DPA name and the host of the HTTPS origin, from which the Anthropic, OpenAI and Gemini API bases
are built. Every provider the model catalog can resolve maps to one of them (`aiSubprocessorOf`),
except Moonshot (the metered platform account) and Kimi Code (the subscription account), which map to
none and are outside the file by design. A model id no catalog family claims names no provider on
the list, so a route or override naming one fails validation before serving.

`test/ai-providers.test.ts` pins `AI_SUBPROCESSORS` to the file rather than to names of its own: every
provider the file lists must be in `AI_SUBPROCESSORS` with the same DPA name and API origin, every
provider in `AI_SUBPROCESSORS` must be in the file, every catalogued provider must map to one the file
lists and reach it at that origin, and only Moonshot and Kimi Code may stay unlisted. It reads the
file from the directory `LIMESPOT_ROOT_STANDARDS` names, or from `../_standards` beside this
repository when that is unset, and fails, never skips, when it cannot; CI checks `limespot/root` out
for it ([TESTING.md → Running the offline suite](TESTING.md#running-the-offline-suite)). A provider
is added in this order: the root `ai-providers.json` first, then the website DPA, and the Privacy
Policy where its retention or training terms differ, then this list. No route carrying customer
content may select the provider before the DPA naming it is live, and CI holds that line: once the
root file names the provider, the published-DPA check below keeps this repository's `build` red
until the live DPA lists it.

CI holds the file to the DPA as published with the workspace's one published-DPA checker,
`limespot/root`'s `_enforcement/check-published-dpa.py`, which Brain runs too. It reads `ai-providers.json` from
`LIMESPOT_ROOT_STANDARDS`, or from the `_standards` directory beside it, fetches the page
`PUBLISHED_DPA_URL` names, the live DPA by default, and exits nonzero on any failure, such as a
provider the file names that the page's sub-processor list leaves out. How it reads the page, and
its self-test, live with it in root's `_enforcement` directory. CI's `test` job checks out root's
`_standards` and `_enforcement` and runs it right after that checkout and before the suite, logging
the root revision, so it and `test/ai-providers.test.ts` read one `ai-providers.json` from one
logged revision in every run; the suite still runs when the check alone failed. A provider added to
`ai-providers.json` therefore keeps this repository's required `build` check red until the website
DPA naming it is merged and deployed. The pin reads the file through `scripts/root-ai-providers.mjs`.

## Routes that carry customer content

Every prompt group declares `carriesCustomerContent`: whether its prompts receive merchant, shopper,
user or captured-page content. A provider the DPA lists may serve any group; Moonshot and Kimi Code
may serve only a group that carries no such content. Every group carries it today, so no production
route may use Moonshot or Kimi Code, and `test/ai-providers.test.ts` pins that set of routes, which
is empty. The Grader's capture, analysis and chat routes are content routes like every other.
Outside production every catalogued provider stays routable for the adapter tests and the opt-in
paid smoke matrices, where a paid call still needs `AI_CHANNEL=prod`.

## Validation before serving

Workers hand a script its configuration only with its first event, so the router runs
`validateProviderConfiguration` (`src/prompt-registry.ts`) before an isolate serves its first request
other than `/health`, and refuses every request with 503 `ServiceUnavailableException` while the
configuration is invalid. Production `/health` runs the same check, and `test/config.test.ts` runs it
over the committed `wrangler.toml`. It fails when any prompt, group or `MODEL_OVERRIDES` entry
resolves to a model id no catalog family owns or to a provider that may not serve that route, when a
prompt whose conversation carries earlier turns or browser-owned tools resolves to a model whose
family cannot carry them across requests (OpenAI's), or when any provider API base the deployment sets is not that provider's own. At request time, route
resolution refuses a disallowed provider again, with 503 `ProviderNotAllowedException`, before any
adapter reads a credential, and each provider base accessor refuses any base but the provider's own.

## Origins and redirects

In production each provider API base must be the provider's own, written exactly, with no trailing
slash, credentials, query or fragment:

| Variable             | Base                                               |
| -------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_BASE` | `https://api.anthropic.com`                        |
| `OPENAI_API_BASE`    | `https://api.openai.com`                           |
| `GEMINI_API_BASE`    | `https://generativelanguage.googleapis.com/v1beta` |
| `MOONSHOT_API_BASE`  | `https://api.moonshot.ai`                          |
| `KIMI_API_BASE`      | `https://api.kimi.com/coding`                      |

Every provider transport call goes through `fetchProvider` (`src/inference/adapters/provider-fetch.ts`),
which asks the runtime not to follow a redirect (`redirect: 'manual'`; workerd implements no `error`
mode) and refuses a 3xx answer, so no body, key or file id reaches the origin a redirect names.
Gemini's resumable upload endpoint, which arrives in a response header, must also stay on Gemini's
origin. Workers AI is reached through its binding, with no URL.

## Retention, per provider

| Provider   | What app-ai creates there                                                                                            | When it ends                                                                                                                                                                      | Proof                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Anthropic  | Files API uploads                                                                                                    | Deleted when a Grader session ends; every upload expires 30 days after it is made (`expires_in_seconds`)                                                                          | `test/audit-retention.test.ts`, `test/file-expiry.test.ts`                                |
| OpenAI     | `/v1/files` uploads; no stored responses (`store: false`); OpenAI's automatic prompt cache                           | Uploads are deleted when a Grader session ends and expire 30 days after they are made (`expires_after`, verified against the real API below); the prompt cache as described below | `test/audit-retention.test.ts`, `test/file-expiry.test.ts`, `test/openai-adapter.test.ts` |
| Gemini     | Files API uploads                                                                                                    | Deleted when a Grader session ends; Gemini deletes every upload 48 hours after it is made                                                                                         | `test/audit-retention.test.ts`                                                            |
| Workers AI | Nothing: one inline request, and a daily count in the quota authority                                                | Nothing to end                                                                                                                                                                    | `test/free-visual-verify.test.ts`                                                         |
| Kimi Code  | Nothing in production, where no route may use it; evidence an earlier route stored stays in LimeSpot's own R2 bucket | That evidence is deleted when its Grader session ends, whatever the current routing and with no Kimi key; the bucket rule removes it after 16 days                                | `test/ai-providers.test.ts`, `test/audit-retention.test.ts`                               |
| Moonshot   | Nothing in production, where no route may use it                                                                     | Nothing to end                                                                                                                                                                    | `test/ai-providers.test.ts`                                                               |

OpenAI keeps no stored Responses object: every Responses call sends `store: false` and no
`previous_response_id`, so OpenAI keeps no response object to continue from. Its automatic
prompt-cache state is described below. No stored Responses object, app-ai continuation state or output-item replay crosses a request boundary, while OpenAI's automatic prompt-cache state can persist across calls (in memory for minutes, or up to 24 hours without Zero Data Retention), so an OpenAI route serves one public turn: it offers no continuation, a request carrying
a continuation, any earlier assistant turn, a tool result, or caller tools is refused with 400
before any provider call, and no route whose conversation carries earlier turns (the Studio chats,
the billing assistant, the Grader chat) or browser-owned tools can route to it. A tool-call turn's reasoning comes back encrypted by OpenAI and goes back to OpenAI only
within the same request, on its next server-tool iteration. A Grader session's
OpenAI uploads are deleted when the session ends, and every OpenAI upload expires 30 days after it is
made. The expiry was verified against the real API on 2026-10-11: an upload to
`POST https://api.openai.com/v1/files` with app-ai's upload shape (`purpose: user_data`,
`expires_after[anchor]: created_at`, `expires_after[seconds]: 2592000`) came back with `expires_at`
exactly 2,592,000 seconds after its `created_at`, `GET /v1/files/{id}` read the same expiry back,
and `DELETE /v1/files/{id}` answered `deleted: true`. The redacted recording,
`test/fixtures/openai-file-expiry.ts`, drives the adapter's Files test.

OpenAI also caches prompt prefixes automatically for its supported models, and nothing in a request
switches that off. app-ai requests no explicit or extended cache retention: an OpenAI request carries
no `prompt_cache_options`, no cache breakpoint, no `prompt_cache_retention` and no
`prompt_cache_key`. What OpenAI then keeps depends on the organization, by its own documentation
([prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [your data](https://developers.openai.com/api/docs/guides/your-data)). With Zero Data Retention enabled, the cache is in
memory: its entries typically stay active for 5 to 10 minutes of inactivity and at most an hour, and
on GPT-5.6 and later at least 30 minutes. Without it, OpenAI applies extended prompt caching to every
query, storing encrypted key/value tensors in GPU-local storage as application state for at most 24
hours. Beyond the request, OpenAI therefore holds two copies: its abuse-monitoring logs, kept up to
30 days, and that prompt-cache state for its documented lifetime.

Retention deletion reaches an object through the provider that holds it, chosen by the object's own
file policy and account, never through the current routing. An object under a worker-managed policy
is in LimeSpot's own storage and is deleted there, with no request and no provider key; any other is
deleted only through the provider account that created it, at that provider's own API origin. A
Grader session's uploads are therefore deleted when it ends even after its routes moved to another
provider.

## Account confirmations

The no-training and retention statements also rest on account settings the code cannot read. The
operator checks each one in the provider's account and records who confirmed it and when. That is an
operator task, separate from any code change; a blank row is a confirmation still outstanding.

| #   | Provider              | Setting to confirm                                                                                                                                                                                                                                                                                                                                                                                                                                       | Confirmed by   | Date       |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- |
| 1   | OpenAI                | The organization has no data-sharing opt-in for API data                                                                                                                                                                                                                                                                                                                                                                                                 | Aidin Tavakkol | 2026-10-08 |
| 2   | Google Gemini         | The Google Cloud project behind `GEMINI_API_KEY` is on a paid tier with billing enabled; on the free tier Google may use inputs                                                                                                                                                                                                                                                                                                                          | Aidin Tavakkol | 2026-10-08 |
| 3   | Cloudflare Workers AI | The protected `visual-verify-free` route (group `free-render-verification`) stores nothing beyond the request; the code side is proven by `test/free-visual-verify.test.ts` (it writes no R2 or KV)                                                                                                                                                                                                                                                      | Aidin Tavakkol | 2026-10-08 |
| 4   | Anthropic             | API use is under Anthropic's Commercial Terms of Service, accepted by Aidin Tavakkol for LimeSpot Solutions Inc. as the Customer, in LimeSpot's Anthropic Console organization identified in LimeSpot's legal records; the organization's credits are funded through a Claude Max subscription in the name of LimeSpot Solutions Inc., which does not change the governing terms; no customer content goes to Anthropic through a Consumer-Terms surface | Aidin Tavakkol | 2026-10-19 |

A provider whose key app-ai will use for the first time has its account verified by the operator, and its row filled, before a production route selects it.
