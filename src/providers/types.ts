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

import type { StateDependency, StateSnapshot } from '../domain/state.js';

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
}

/** Helper to build a provider-scoped error. */
export function providerNotConfigured(source: string): Error {
  return new Error(`no provider configured for source "${source}"`);
}
