/**
 * Dependency evaluation: fetches CURRENT state for every declared dependency
 * and produces per-dependency verdicts.
 *
 * Critical design rules:
 * - Validation NEVER uses cached observations; every verdict is backed by a
 *   fresh provider fetch (invariant 8).
 * - Provider failures yield UNKNOWN verdicts, never ALLOW (invariant 7).
 * - Unmatched references (no provider supports them) yield UNKNOWN.
 * - Preconditions are routed to their target dependency: a precondition
 *   without an explicit `dependency` pattern applies to the first (primary)
 *   dependency; otherwise it applies to every dependency whose reference key
 *   matches the glob "<source>:<resource>/<resource_id>".
 */

import type { Precondition } from '../domain/action.js';
import type { StateDependency, StateSnapshot, StateProvenance } from '../domain/state.js';
import type { DependencyVerdict } from '../domain/decision.js';
import type { StateProvider } from '../providers/types.js';
import type { ResolvedFreshness } from './resolved-policy.js';
import { evaluateFreshness, UnavailableCurrentState, type CurrentState } from './freshness.js';
import { refKey } from '../domain/state.js';
import type { EventBus } from '../domain/events.js';

export interface DependencyEvaluationResult {
  verdicts: DependencyVerdict[];
  /** Fresh snapshots fetched during evaluation (for persistence + drift detection). */
  fetched: StateSnapshot[];
  providerErrors: Array<{ ref: string; message: string }>;
  /** Preconditions routed per dependency, aligned with verdicts by index. */
  routedPreconditions: Precondition[][];
}

export function routePreconditions(
  preconditions: readonly Precondition[],
  dependencyIndex: number,
  dependency: StateDependency,
): Precondition[] {
  return preconditions.filter((p) => {
    if (p.dependency === undefined) {
      return dependencyIndex === 0;
    }
    return globMatchSafe(p.dependency, refKey(dependency));
  });
}

function globMatchSafe(pattern: string, value: string): boolean {
  // Minimal inline glob to avoid a cycle with the policy layer.
  const regex = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : `\\${ch}`))}$`,
    's',
  );
  return regex.test(value);
}

export async function evaluateDependencies(params: {
  dependencies: readonly StateDependency[];
  policyFreshness: ResolvedFreshness;
  resolveDependencyFreshness: (dep: StateDependency) => ResolvedFreshness;
  preconditions: readonly Precondition[];
  providers: readonly StateProvider[];
  nowMs: number;
  nowIso: string;
  events?: EventBus;
}): Promise<DependencyEvaluationResult> {
  const verdicts: DependencyVerdict[] = [];
  const fetched: StateSnapshot[] = [];
  const providerErrors: Array<{ ref: string; message: string }> = [];
  const routedPreconditions: Precondition[][] = [];

  for (let index = 0; index < params.dependencies.length; index++) {
    const dependency = params.dependencies[index]!;
    const freshness = params.resolveDependencyFreshness(dependency);
    const ref = refKey(dependency);
    const routed = routePreconditions(params.preconditions, index, dependency);
    routedPreconditions.push(routed);

    let provider: StateProvider | null = null;
    for (const candidate of params.providers) {
      if (candidate.supports(dependency)) {
        provider = candidate;
        break;
      }
    }

    let current: CurrentState;
    if (provider === null) {
      current = new UnavailableCurrentState(
        `no state provider is configured for source "${dependency.source}"`,
      );
    } else {
      try {
        // Preconditions must be evaluated against state the PROVIDER vouches
        // for. A conditional "unchanged" response carries no server-side
        // content, so when any precondition is routed to this dependency we
        // force a full fetch instead of trusting the agent-supplied metadata
        // that a 304 snapshot would have to echo.
        const snapshot = await fetchCurrent(provider, dependency, params.nowIso, routed.length > 0);
        fetched.push(snapshot);
        current = snapshot;
        params.events?.emit({
          type: 'StateObserved',
          occurred_at: params.nowIso,
          data: { ref, version: snapshot.version, validation_method: snapshot.provenance.validation_method },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        providerErrors.push({ ref, message });
        params.events?.emit({
          type: 'ProviderError',
          occurred_at: params.nowIso,
          data: { ref, provider: provider.name, message },
        });
        current = new UnavailableCurrentState(message);
      }
    }

    const evaluation = evaluateFreshness({
      dependency,
      current,
      freshness,
      preconditions: routed,
      nowMs: params.nowMs,
    });

    verdicts.push({
      dependency: {
        source: dependency.source,
        resource: dependency.resource,
        resource_id: dependency.resource_id,
      },
      staleness: evaluation.staleness,
      reason: evaluation.reason,
      verified_fresh: !(current instanceof UnavailableCurrentState),
      observed_version: dependency.version,
      current_version: current instanceof UnavailableCurrentState ? null : current.version,
      observed_content_hash: dependency.content_hash,
      current_content_hash: current instanceof UnavailableCurrentState ? null : current.content_hash,
      observed_at: dependency.observed_at,
      current_observed_at: current instanceof UnavailableCurrentState ? null : current.observed_at,
      age_ms: evaluation.ageMs,
      max_age_ms: evaluation.maxAgeMs,
      strategy: freshness.strategy,
      preconditions: evaluation.preconditions,
    });
  }

  return { verdicts, fetched, providerErrors, routedPreconditions };
}

/**
 * Fetches current state. If the agent declared a version and no preconditions
 * need server-vouched metadata, a conditional verification is attempted first:
 * a "not modified" response is fresh verification that the world is unchanged
 * (provenance: conditional_304).
 */
async function fetchCurrent(
  provider: StateProvider,
  dependency: StateDependency,
  nowIso: string,
  requiresServerVouchedMetadata: boolean,
): Promise<StateSnapshot> {
  if (
    !requiresServerVouchedMetadata &&
    dependency.version !== null &&
    provider.supportsConditionalVerification?.() === true
  ) {
    const conditional = await provider.getConditional?.(dependency, nowIso);
    if (conditional) {
      return conditional;
    }
  }
  return provider.getState(dependency, nowIso);
}

export function emptyProvenance(provider: string, nowIso: string, method: StateProvenance['validation_method']): StateProvenance {
  return { provider, retrieved_at: nowIso, time_source: 'client', validation_method: method };
}
