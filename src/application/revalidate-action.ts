/**
 * Revalidation flow (spec §23).
 *
 * When the initial decision is REVALIDATE, the firewall recomputes the safety
 * decision using CURRENT state. Revalidation never simply refreshes state and
 * auto-approves: preconditions are re-evaluated against the fresh snapshots,
 * and the drift between what the agent observed and what is true now stays
 * visible in the verdicts (observed_* vs current_*) and in the audit trail.
 */

import type { Precondition } from '../domain/action.js';
import type { DependencyVerdict } from '../domain/decision.js';
import type { StateSnapshot } from '../domain/state.js';
import type { ResolvedFreshness } from '../engine/resolved-policy.js';
import { evaluateFreshness } from '../engine/freshness.js';
import { refKey } from '../domain/state.js';

/**
 * Recomputes verdicts with the firewall's fresh observations adopted as the
 * new basis. Dependencies whose current state could not be fetched stay
 * UNKNOWN — a revalidation cannot heal a provider outage (invariant 10).
 *
 * `routedPreconditions` carries the precondition lists exactly as they were
 * routed during the initial evaluation (aligned with the verdicts by index),
 * so the recompute evaluates the same invariants against the new metadata.
 */
export function recomputeVerdictsFromCurrentState(params: {
  originalVerdicts: readonly DependencyVerdict[];
  fetched: readonly StateSnapshot[];
  routedPreconditions: readonly Precondition[][];
  resolveDependencyFreshness: (index: number, verdict: DependencyVerdict) => ResolvedFreshness;
  nowMs: number;
}): DependencyVerdict[] {
  const { originalVerdicts, fetched, routedPreconditions } = params;

  return originalVerdicts.map((verdict, index) => {
    const key = refKey(verdict.dependency);
    const snapshot = fetched.find((s) => refKey(s) === key);

    if (!snapshot) {
      // No fresh fetch available for this dependency: preserve the verdict.
      return { ...verdict };
    }

    // Adopt the firewall's fresh observation as the new decision basis.
    // For TTL purposes the relevant timestamp is the FETCH time (provenance),
    // because the firewall just verified the world looks like this now.
    const adopted = {
      source: verdict.dependency.source,
      resource: verdict.dependency.resource,
      resource_id: verdict.dependency.resource_id,
      version: snapshot.version,
      content_hash: snapshot.content_hash,
      observed_at: snapshot.provenance.retrieved_at,
      metadata: snapshot.metadata,
    };

    const evaluation = evaluateFreshness({
      dependency: adopted,
      current: snapshot,
      freshness: params.resolveDependencyFreshness(index, verdict),
      preconditions: routedPreconditions[index] ?? [],
      nowMs: params.nowMs,
    });

    return {
      ...verdict,
      staleness: evaluation.staleness,
      reason: `revalidated against current state: ${evaluation.reason}`,
      verified_fresh: true,
      preconditions: evaluation.preconditions,
    };
  });
}
