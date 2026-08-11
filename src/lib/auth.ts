/**
 * Context-ID authentication.
 *
 * Every endpoint except /health requires an `X-Personalizer-Context-ID` header,
 * validated server→server against Personalizer's administrator-authentication endpoint.
 * Personalizer owns the subscriber/tenant mapping; this worker only checks that the
 * context-ID is currently valid before proxying to Anthropic.
 *
 * `validateContextId` throws a `WorkerError` on any failure. The router turns
 * the throw into the Brain-shaped error response:
 *   • missing header             → 401 `MissingContextIDException` (Brain's exact analog)
 *   • Personalizer rejects the ID → Personalizer's own status + body relayed UNCHANGED
 *   • Personalizer unreachable    → 500 `BrainUnreachableException`
 */

import { WorkerError } from './responses';
import { personalizerApiUrl, type Env } from '../config';
import { silentLogger, type Logger } from './logger';
import type { IntegrationParty } from '../toolsets/integration-party';

/**
 * Personalizer's validate-context-id payload — the members this worker consumes of
 * `AdministratorAuthenticationController.ValidateContextID`'s response (Brain
 * serializes PascalCase; the full record carries more members).
 */
export interface ContextValidation {
  SubscriberID?: number;
  SubscriberTitle?: string;
  /**
   * The subscriber's available `IntegrationParty` names (liveness-filtered by
   * Personalizer). Drives dynamic toolset composition (toolsets/registry.ts):
   * the router threads this into the chat handler. Absent/empty = no
   * third-party integrations (always-active toolsets like personalizer still
   * compose). Values are enum-name strings on the wire.
   */
  AvailableIntegrationParties?: IntegrationParty[];
  [member: string]: unknown;
}

/**
 * Validate a context-ID against Personalizer. Resolves with Personalizer's validation
 * payload on success; throws a `WorkerError` when the context-ID is missing or
 * Personalizer rejects it.
 */
export async function validateContextId(
  contextId: string | null,
  env: Env,
  log: Logger = silentLogger,
): Promise<ContextValidation> {
  if (!contextId) {
    throw new WorkerError('Missing Context ID.', {
      status: 401,
      exceptionType: 'MissingContextIDException',
    });
  }

  const validateUrl = `${personalizerApiUrl(env)}/v2/administrator-authentication/validate-context-id`;

  let response: Response;
  try {
    response = await fetch(validateUrl, {
      method: 'GET',
      headers: {
        'X-Personalizer-Context-ID': contextId,
        'Content-Type': 'application/json',
      },
    });
  } catch (fetchError) {
    const reason = fetchError instanceof Error ? fetchError.message : String(fetchError);
    log.error('Fetch to Personalizer failed', fetchError, { reason });
    throw new WorkerError(`Context validation is unreachable: ${reason}`, {
      status: 500,
      exceptionType: 'BrainUnreachableException',
    });
  }

  if (!response.ok) {
    // Personalizer already answered with its own Brain-shaped error body — relay
    // its status + body unchanged so the client sees exactly what Personalizer said.
    const errorText = await response.text();
    log.error(`Validation failed: ${response.status} ${response.statusText}`, undefined, {
      responseBody: errorText,
    });
    throw new WorkerError(`Context validation failed: ${response.status} ${response.statusText}`, {
      status: response.status,
      exceptionType: 'InvalidContextIDException',
      passthroughBody: errorText,
    });
  }

  const data = (await response.json()) as ContextValidation;
  log.info(`Validated subscriber ${data.SubscriberTitle} (ID: ${data.SubscriberID})`, data);
  return data;
}
