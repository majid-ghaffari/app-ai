/**
 * GET /prompts — the operator's view of what the deployed configuration
 * actually routes each registered prompt to, and which required secrets are
 * still blank.
 *
 * Because the provider is inferred from a configured model id, "which model,
 * on which provider, and does it satisfy the prompt's contract" stops being
 * readable from the source alone: it is a property of this deployment. This is
 * where that is answered, without running an inference.
 *
 * MASTER-GATED. The router validates the context-ID exactly as it does for
 * every other authenticated route, and this handler then requires the resolved
 * `SubscriberID` to be the configured master — mirroring Brain's own master
 * check. A validated NON-master merchant gets the router's unknown-route answer
 * (404 `RecordNotFoundException`), identical byte for byte to a route that does
 * not exist, so the endpoint cannot even be confirmed to be there. The scoped
 * demo bearer never reaches this handler: its branch dispatches only
 * `POST /files` and `POST /messages`.
 *
 * This is also the ONE route whose context-ID may arrive in the URL instead of
 * the `X-Personalizer-Context-ID` header, so an operator can open the
 * diagnostics from a browser address bar. The header wins whenever both are
 * present, the master gate is identical either way, and no other route reads a
 * credential from a query string (pinned by test/architecture.test.ts). A URL
 * credential counts only while it authenticates as the master: a non-master one
 * — like a value Personalizer rejects, which the router turns back before this
 * handler runs — answers exactly as a request carrying no credential, so the
 * query form is indistinguishable from a path that reads none.
 */

import { jsonResponse, errorResponse, errorResponseFrom, type CorsHeaders } from '../lib/responses';
import { silentLoggingRuntime, type LoggingRuntime } from '../lib/logger';
import { masterSubscriberId, missingRequiredSecretNames, type Env } from '../config';
import { describePromptRoutes, providersInUse } from '../prompt-registry';
import { missingContextIdError, type ContextValidation } from '../lib/auth';

/**
 * The query parameter this route accepts the master context-ID in. A wire
 * contract name, so it lives in code beside the route that reads it.
 */
export const PROMPTS_CONTEXT_ID_PARAMETER = 'personalizerContextId';

/**
 * The context-ID carried by a `GET /prompts` URL, or `null` when the URL
 * carries none. The router calls this only for that route, and only after the
 * header came back empty — a credential in a URL is exposed to browser history
 * and intermediaries, so it is an operator convenience, never the form
 * automation should use.
 */
export function promptsDiagnosticsContextId(url: URL): string | null {
  const contextId = url.searchParams.get(PROMPTS_CONTEXT_ID_PARAMETER);
  return contextId === null || contextId === '' ? null : contextId;
}

export function handlePrompts(
  validation: ContextValidation,
  env: Env,
  corsHeaders: CorsHeaders,
  logging: LoggingRuntime = silentLoggingRuntime,
  options: { readonly credentialFromUrl?: boolean } = {},
): Response {
  const log = logging.logger('Prompts');
  if (validation.SubscriberID !== masterSubscriberId(env)) {
    log.warn('Prompt diagnostics requested by a non-master subscriber');
    // A header credential gets the router's unknown-route answer. A URL one gets
    // the credential-less answer instead, because only that form of the route
    // reads a query parameter at all: answering it differently from every other
    // path would confirm the parameter is read here.
    return options.credentialFromUrl
      ? errorResponseFrom(missingContextIdError(), corsHeaders)
      : errorResponse('Resource not found.', corsHeaders, 404, 'RecordNotFoundException');
  }
  const prompts = describePromptRoutes(env);
  // Names only — `missingRequiredSecretNames` never exposes a value, prefix, or
  // length — and a provider key counts only while a resolved route uses it.
  const missingSecrets = missingRequiredSecretNames(env, providersInUse(env));
  log.info('Prompt diagnostics served', {
    promptCount: prompts.length,
    invalidCount: prompts.filter((prompt) => !prompt.valid).length,
    missingSecretCount: missingSecrets.length,
  });
  return jsonResponse({ prompts, missingSecrets }, corsHeaders);
}
