/**
 * State domain model (spec §4, §40).
 *
 * A StateSnapshot is the precise slice of external state an agent relied on
 * when it produced a decision — not necessarily the whole resource.
 * Provenance is mandatory: cached observations are never treated as fresh
 * verification (invariant 8).
 */

export type TimeSource = 'server' | 'client';

export type ValidationMethod =
  | 'full_fetch'
  | 'conditional_304'
  | 'provider_reported'
  | 'agent_reported'
  | 'static_fixture';

export interface StateProvenance {
  /** How this observation was obtained. */
  validation_method: ValidationMethod;
  /** Wall-clock instant the firewall (or agent) retrieved the state. */
  retrieved_at: string;
  /** Whether observed_at came from the provider's server clock or the local clock. */
  time_source: TimeSource;
  /** Provider implementation that produced the snapshot. */
  provider: string;
}

export interface ResourceReference {
  source: string;
  resource: string;
  resource_id: string;
}

export interface StateSnapshot extends ResourceReference {
  snapshot_id: string;
  /** Provider-server (preferred) or client timestamp of the underlying state. */
  observed_at: string;
  /** Provider-defined version signal: SHA, ETag, row version, revision, id... */
  version: string | null;
  /** Hash over the canonical content the decision relied on. */
  content_hash: string | null;
  /** Structured fields relevant to preconditions and explanations. */
  metadata: Record<string, unknown>;
  provenance: StateProvenance;
  /**
   * True when the provider affirmed via a conditional request (e.g. HTTP 304,
   * If-None-Match) that the resource is unchanged relative to a previously
   * observed version. This is fresh verification, not cache reuse.
   */
  unchanged_since_observed?: boolean;
}

/** What the agent declares it observed when forming its intent (spec §5). */
export interface StateDependencyInput extends ResourceReference {
  /** Version the agent saw. Absent => the firewall cannot verify freshness. */
  version?: string | null;
  /** Content hash the agent saw. */
  content_hash?: string | null;
  /** When the agent observed the state (ISO 8601). */
  observed_at?: string | null;
  /** The metadata fields the agent based its reasoning on. */
  metadata?: Record<string, unknown>;
}

/** Fully resolved dependency inside an ActionIntent. */
export interface StateDependency extends StateDependencyInput {
  version: string | null;
  content_hash: string | null;
  observed_at: string | null;
  metadata: Record<string, unknown>;
}

export function refKey(ref: ResourceReference): string {
  return `${ref.source}:${ref.resource}/${ref.resource_id}`;
}

export function normalizeDependency(input: StateDependencyInput): StateDependency {
  return {
    source: input.source,
    resource: input.resource,
    resource_id: input.resource_id,
    version: input.version ?? null,
    content_hash: input.content_hash ?? null,
    observed_at: input.observed_at ?? null,
    metadata: input.metadata ?? {},
  };
}
