/**
 * Inspect-state use case (spec §19 `ssf state inspect`): fetches current
 * state for a reference, persists a snapshot, and reports age/classification
 * against the global defaults. Read-only: no decisions, no authorizations.
 */

import type { StateDependency, StateSnapshot } from '../domain/state.js';
import type { FirewallContext } from './context.js';
import { normalizeDependency } from '../domain/state.js';
import { assessAge } from '../engine/staleness.js';

export interface StateInspection {
  snapshot: StateSnapshot;
  age_ms: number | null;
  /** Classification against global default freshness (informational). */
  note: string;
}

export async function inspectState(
  ctx: FirewallContext,
  ref: StateDependency,
): Promise<StateInspection> {
  const normalized = normalizeDependency(ref);
  let provider = null;
  for (const candidate of ctx.providers) {
    if (candidate.supports(normalized)) {
      provider = candidate;
      break;
    }
  }
  if (provider === null) {
    throw new Error(
      `no state provider is configured for source "${normalized.source}"; configure one in ssf.config.yaml under providers`,
    );
  }

  const nowIso = ctx.clock.nowIso();
  let snapshot: StateSnapshot;
  if (normalized.version !== null && provider.supportsConditionalVerification?.() === true) {
    const conditional = await provider.getConditional?.(normalized, nowIso);
    snapshot = conditional ?? (await provider.getState(normalized, nowIso));
  } else {
    snapshot = await provider.getState(normalized, nowIso);
  }

  await ctx.store.saveSnapshot(snapshot);
  const defaults = ctx.defaults.freshness;
  const age = assessAge(snapshot.observed_at, ctx.clock.nowMs(), defaults.skewToleranceMs);

  let note: string;
  if (age.anomaly === 'future_timestamp') {
    note = 'observation timestamp is in the future beyond the configured clock-skew tolerance';
  } else if (age.ageMs === null) {
    note = 'provider did not expose an observation timestamp; age cannot be established';
  } else if (defaults.maxAgeMs === null) {
    note = `observation is ${age.ageMs}ms old; the default freshness policy has no TTL boundary`;
  } else {
    note = `observation is ${age.ageMs}ms old (default freshness window ${defaults.maxAgeMs}ms)`;
  }

  return { snapshot, age_ms: age.ageMs, note };
}
