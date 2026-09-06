/**
 * StateProvider contract (spec §16, §55).
 *
 * Adapters translate external systems into StateSnapshots. The core firewall
 * knows nothing about GitHub, HTTP, or databases — only this interface.
 *
 * Contract rules:
 * - getState MUST return current state fetched from the source of truth,
 *   never a cached copy.
 * - getConditional, when supported, issues a conditional verification
 *   ("is the resource still at version X?"). Returning a snapshot means the
 *   provider PROVED the state unchanged; returning null means a full fetch
 *   is required.
 * - Failures are thrown as typed errors; they are never swallowed and never
 *   become successful validation (invariant 7).
 */

import type { StateDependency, StateSnapshot, ResourceReference } from '../domain/state.js';

/**
 * A mutation whose application is conditioned on the provider's OWN
 * authoritative state still matching an expected version (compare-and-swap).
 * The check and the mutation happen inside the provider, atomically.
 */
export interface ConditionalMutationRequest {
  /** The resource to mutate. */
  ref: ResourceReference;
  /**
   * The version the operation is conditioned on. This MUST be the version
   * captured when the state was authorized, not a re-read performed by the
   * caller immediately before mutating (a fresh read is not conditional
   * execution — it is still TOCTOU).
   */
  expected_version: string;
  /** Provider-specific mutation payload (e.g. file content, field changes). */
  changes: Record<string, unknown>;
}

/**
 * Result of a provider-side conditional mutation.
 * - "executed": the condition held and the mutation was applied atomically.
 * - "condition_failed": the provider's authoritative state was NOT at the
 *   expected version, so the provider REFUSED the operation. No side effect
 *   occurred. This is not an error — it is the external world rejecting a
 *   stale operation.
 */
export type ConditionalMutationResult =
  | { outcome: 'executed'; version: string | null; output?: unknown }
  | { outcome: 'condition_failed'; current_version: string | null };

export interface StateProvider {
  /** Provider implementation name, used in provenance. */
  readonly name: string;

  /** Whether this provider can serve the referenced resource. */
  supports(ref: { source: string; resource: string; resource_id: string }): boolean;

  /** Fetch the full current state for a resource. */
  getState(ref: StateDependency, nowIso: string): Promise<StateSnapshot>;

  /**
   * Optional conditional verification relative to the agent's observation.
   * Returns a snapshot with unchanged_since_observed=true when the provider
   * affirms the resource is unchanged; null when a full fetch is needed.
   */
  getConditional?(ref: StateDependency, nowIso: string): Promise<StateSnapshot | null>;

  /** Whether getConditional is implemented for this provider. */
  supportsConditionalVerification?(): boolean;

  /**
   * Whether this provider can perform mutations ATOMICALLY CONDITIONED on an
   * expected version (compare-and-swap). This is a strictly stronger
   * capability than supportsConditionalVerification: verification only reads,
   * conditional execution makes the external system itself reject an
   * operation whose authorized state is no longer true.
   */
  supportsConditionalExecution?(): boolean;

  /**
   * Applies a mutation only if the provider's current version for the
   * resource equals `expected_version`. The version check and the mutation
   * MUST be atomic within the provider (a separate get() then set() is NOT
   * a valid implementation). Providers that cannot guarantee this must not
   * implement the capability.
   */
  conditionalExecute?(request: ConditionalMutationRequest): Promise<ConditionalMutationResult>;
}

/**
 * Internal classification of provider failures (milestone: internal
 * operationalization, §10). Adapters keep their typed error classes —
 * semantically different failures are NEVER collapsed into one generic
 * error — but every provider error additionally carries one of these
 * kinds so callers can branch deterministically without parsing messages.
 */
export type ProviderFailureKind =
  | 'CONDITION_FAILED'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_OUTCOME'
  | 'UNSUPPORTED';

/**
 * Classifies a provider failure from its status code and error message.
 * Deterministic: the same inputs always yield the same kind.
 */
export function classifyProviderFailure(input: {
  status?: number | null;
  error?: unknown;
}): ProviderFailureKind {
  const status = input.status ?? null;
  if (status !== null) {
    if (status === 404) return 'NOT_FOUND';
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 429) return 'RATE_LIMITED';
    if (status === 412 || status === 409) return 'CONDITION_FAILED';
    if (status >= 500) return 'SERVER_ERROR';
  }
  const message = input.error instanceof Error ? `${input.error.name}: ${input.error.message}` : String(input.error ?? '');
  // AbortSignal.timeout surfaces as a TimeoutError DOMException; some runtimes
  // wrap it. Match the stable substrings before generic network patterns.
  if (/TimeoutError|timed out|The operation was aborted due to timeout/i.test(message)) return 'TIMEOUT';
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(message)) return 'NETWORK_ERROR';
  return 'UNKNOWN_OUTCOME';
}

/** Helper to build a provider-scoped error. */
export function providerNotConfigured(source: string): Error {
  return new Error(`no provider configured for source "${source}"`);
}
