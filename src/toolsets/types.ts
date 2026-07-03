/**
 * The toolset layer's shared contracts (docs/TOOLSETS.md): the descriptor every
 * toolset exports, the degrade-safe execution-result shape, and the composition
 * the registry hands to handlers. The Anthropic tool-definition schema itself
 * lives with the Anthropic client types (lib/anthropic.ts → `ToolDefinition`).
 */

import type { Env } from '../config';
import type { ToolDefinition } from '../lib/anthropic';
import type { EntityReference } from '../lib/references';
import type { IntegrationParty } from './integration-party';

/** The request auth material handed to each toolset's `resolveCredentials`. */
export interface ToolAuthContext {
  contextId: string;
  env: Env;
}

/** A successful tool execution — `result` is the JSON the model sees. */
export interface ToolExecutionSuccess {
  ok: true;
  name: string;
  result: unknown;
  summary: string;
}

/** A degraded tool execution — fed back to the model as an `is_error` tool_result. */
export interface ToolExecutionFailure {
  ok: false;
  name: string;
  result: { error: string; body?: string };
  summary: string;
}

export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure;

/** Per-call context the composition threads to the owning toolset. */
export interface ToolCallExtras {
  /** The request's surviving `context.refs` (get_entity_context analytics dispatch). */
  refs?: readonly EntityReference[];
}

/** What a toolset's `execute` receives from the registry. */
export interface ToolExecutionContext extends ToolCallExtras {
  /** Whatever this toolset's own `resolveCredentials` returned (opaque to the registry). */
  credentials: unknown;
  env: Env;
  /**
   * The subscriber party this toolset's executor targets — the intersection of
   * `descriptor.integrationParties` with the subscriber's available parties,
   * exactly one by the ≤1-commerce-party invariant. Present only for
   * party-gated toolsets; absent for always-active ones (empty
   * `integrationParties`, e.g. personalizer, which never reads it). The
   * platform toolsets use it as the integration-bridge URL party segment.
   */
  matchedParty?: IntegrationParty;
}

/**
 * The descriptor every toolset module exports — the ONE export of
 * `src/toolsets/<name>/index.ts` (contract details in docs/TOOLSETS.md):
 *
 *   name               — the registry key.
 *   integrationParties — the IntegrationParty set that gates this toolset.
 *                        Empty = always-active (no gate, e.g. personalizer);
 *                        otherwise the toolset is composed iff the subscriber
 *                        has one of these parties available (registry.ts).
 *   definitions        — Anthropic custom-tool schemas, stable order, frozen
 *                        model-visible contract (lib CONTRACTS.md §2).
 *   resolveCredentials — per-request credential seam; receives the auth
 *                        context, returns this toolset's opaque credentials.
 *   execute            — dispatch one owned tool; returns the degrade-safe
 *                        `{ ok, name, result, summary }` shape (never throws).
 */
export interface ToolsetDescriptor {
  readonly name: string;
  readonly integrationParties: readonly IntegrationParty[];
  readonly definitions: readonly ToolDefinition[];
  resolveCredentials(authContext: ToolAuthContext): unknown;
  execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

/** The per-request tool surface `composeToolsets` returns to an endpoint. */
export interface ToolsetComposition {
  names: string[];
  definitions: ToolDefinition[];
  execute(name: string, input: unknown, extras?: ToolCallExtras): Promise<ToolExecutionResult>;
}
