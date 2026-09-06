/**
 * Freshness engine (spec §7).
 *
 * Evaluates a single dependency against the applicable freshness policy.
 * Supported strategies: ttl, version, hash, preconditions, hybrid.
 *
 * Cross-strategy rules (apply regardless of strategy):
 * - If the agent declared a version and the provider exposes a version and
 *   they differ, the state demonstrably changed => INVALID.
 * - Same for content hashes.
 * - A missing observation basis (no version/hash/observed_at, depending on
 *   strategy) => UNKNOWN, never FRESH.
 * - A fabricated future observation timestamp => UNKNOWN.
 */

import type { Precondition } from '../domain/action.js';
import type { StateDependency, StateSnapshot } from '../domain/state.js';
import type { PreconditionResult, StalenessClass } from '../domain/decision.js';
import { assessAge, classifyByAge } from './staleness.js';
import { evaluatePreconditions } from './preconditions.js';
import type { ResolvedFreshness } from './resolved-policy.js';
import { DEFAULT_MAX_AGE_MS } from './resolved-policy.js';

export interface FreshnessEvaluation {
  staleness: StalenessClass;
  reason: string;
  preconditions: PreconditionResult[];
  ageMs: number | null;
  maxAgeMs: number | null;
}

export class UnavailableCurrentState {
  readonly unavailable = true;
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

export type CurrentState = StateSnapshot | UnavailableCurrentState;

function isUnavailable(state: CurrentState): state is UnavailableCurrentState {
  return state instanceof UnavailableCurrentState;
}

function preconditionOutcome(results: readonly PreconditionResult[]): { passed: boolean; failed: PreconditionResult[] } {
  const failed = results.filter((r) => !r.passed);
  return { passed: failed.length === 0, failed };
}

export function evaluateFreshness(params: {
  dependency: StateDependency;
  current: CurrentState;
  freshness: ResolvedFreshness;
  preconditions: readonly Precondition[];
  nowMs: number;
}): FreshnessEvaluation {
  const { dependency, freshness } = params;

  const preconditionResults: PreconditionResult[] = params.preconditions.length
    ? evaluatePreconditions(params.preconditions, isUnavailable(params.current) ? {} : params.current.metadata)
    : [];

  if (isUnavailable(params.current)) {
    return {
      staleness: 'UNKNOWN',
      reason: `current state could not be established: ${params.current.reason}`,
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: freshness.maxAgeMs ?? null,
    };
  }

  const current = params.current;
  const age = assessAge(dependency.observed_at, params.nowMs, freshness.skewToleranceMs);

  if (age.anomaly === 'future_timestamp') {
    return {
      staleness: 'UNKNOWN',
      reason: 'observed_at is in the future beyond the configured clock-skew tolerance; observation is untrustworthy',
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: freshness.maxAgeMs ?? null,
    };
  }

  // Cross-strategy drift detection: proven change => INVALID.
  if (dependency.version !== null && current.version !== null && dependency.version !== current.version) {
    return {
      staleness: 'INVALID',
      reason: `state changed after observation: observed version "${dependency.version}" but current version is "${current.version}"`,
      preconditions: preconditionResults,
      ageMs: age.ageMs,
      maxAgeMs: freshness.maxAgeMs ?? null,
    };
  }
  if (
    dependency.content_hash !== null &&
    current.content_hash !== null &&
    dependency.content_hash !== current.content_hash
  ) {
    return {
      staleness: 'INVALID',
      reason: 'content hash changed after observation',
      preconditions: preconditionResults,
      ageMs: age.ageMs,
      maxAgeMs: freshness.maxAgeMs ?? null,
    };
  }

  // Server-stamped drift: when the provider's own server clock says the state
  // was produced/changed AFTER the agent's claimed observation, the agent's
  // claim is provably outdated — regardless of what TTL the policy allows.
  // Only server-stamped current state participates (a client-side fetch
  // timestamp would trivially be newer than any claim and would fire on every
  // action). The skew tolerance absorbs benign clock divergence.
  if (
    dependency.observed_at !== null &&
    current.provenance.time_source === 'server' &&
    current.observed_at !== null
  ) {
    const claimedMs = Date.parse(dependency.observed_at);
    const currentMs = Date.parse(current.observed_at);
    if (Number.isFinite(claimedMs) && Number.isFinite(currentMs) && currentMs > claimedMs + freshness.skewToleranceMs) {
      return {
        staleness: 'INVALID',
        reason:
          `authoritative state is newer than the claimed observation: state timestamp ${current.observed_at} is after ` +
          `claimed observed_at ${dependency.observed_at}; the observation cannot justify the action`,
        preconditions: preconditionResults,
        ageMs: age.ageMs,
        maxAgeMs: freshness.maxAgeMs ?? null,
      };
    }
  }

  switch (freshness.strategy) {
    case 'ttl':
      return evaluateTtl(dependency, age.ageMs, freshness, preconditionResults);
    case 'version':
      return evaluateVersion(dependency, current, preconditionResults);
    case 'hash':
      return evaluateHash(dependency, current, preconditionResults);
    case 'preconditions':
      return evaluatePreconditionsStrategy(preconditionResults);
    case 'hybrid':
      return evaluateHybrid(dependency, current, age.ageMs, freshness, preconditionResults);
    default: {
      const exhaustive: never = freshness.strategy;
      return {
        staleness: 'UNKNOWN',
        reason: `unknown freshness strategy: ${String(exhaustive)}`,
        preconditions: preconditionResults,
        ageMs: null,
        maxAgeMs: null,
      };
    }
  }
}

function evaluateTtl(
  dependency: StateDependency,
  ageMs: number | null,
  freshness: ResolvedFreshness,
  preconditionResults: PreconditionResult[],
): FreshnessEvaluation {
  if (ageMs === null) {
    return {
      staleness: 'UNKNOWN',
      reason: 'observation timestamp (observed_at) is missing or unusable for TTL evaluation',
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: freshness.maxAgeMs ?? null,
    };
  }
  const maxAge = freshness.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  // Clock-skew tolerance (spec §27) explicitly widens the age boundaries:
  // effectiveAge = age - skew, floored at zero. Default skew is 0 (conservative).
  const effectiveAge = Math.max(0, ageMs - freshness.skewToleranceMs);
  const staleness = classifyByAge(effectiveAge, maxAge, freshness.agingThreshold);
  const skewNote = freshness.skewToleranceMs > 0 ? ` (skew tolerance ${freshness.skewToleranceMs}ms applied)` : '';
  const reason =
    staleness === 'FRESH'
      ? `observation is ${ageMs}ms old, within the freshness window of ${maxAge}ms${skewNote}`
      : staleness === 'AGING'
        ? `observation is ${ageMs}ms old, approaching the freshness boundary of ${maxAge}ms${skewNote}`
        : `observation is ${ageMs}ms old, exceeding the freshness requirement of ${maxAge}ms${skewNote}`;
  return { staleness, reason, preconditions: preconditionResults, ageMs, maxAgeMs: maxAge };
}

function evaluateVersion(
  dependency: StateDependency,
  current: StateSnapshot,
  preconditionResults: PreconditionResult[],
): FreshnessEvaluation {
  if (current.unchanged_since_observed && dependency.version !== null) {
    return {
      staleness: 'FRESH',
      reason: `provider affirmed via conditional request that state is unchanged since version "${dependency.version}"`,
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: null,
    };
  }
  if (dependency.version === null) {
    return {
      staleness: 'UNKNOWN',
      reason: 'version strategy requires the agent to declare the version it observed, but none was provided',
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: null,
    };
  }
  if (current.version === null) {
    return {
      staleness: 'UNKNOWN',
      reason: 'provider does not expose a comparable version signal',
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: null,
    };
  }
  // Equal versions: the world is exactly as the agent saw it.
  return {
    staleness: 'FRESH',
    reason: `observed version matches current version "${current.version}"`,
    preconditions: preconditionResults,
    ageMs: null,
    maxAgeMs: null,
  };
}

function evaluateHash(
  dependency: StateDependency,
  current: StateSnapshot,
  preconditionResults: PreconditionResult[],
): FreshnessEvaluation {
  if (dependency.content_hash === null) {
    return {
      staleness: 'UNKNOWN',
      reason: 'hash strategy requires the agent to declare the content hash it observed, but none was provided',
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: null,
    };
  }
  if (current.content_hash === null) {
    return {
      staleness: 'UNKNOWN',
      reason: 'provider does not expose a comparable content hash',
      preconditions: preconditionResults,
      ageMs: null,
      maxAgeMs: null,
    };
  }
  return {
    staleness: 'FRESH',
    reason: 'observed content hash matches current content hash',
    preconditions: preconditionResults,
    ageMs: null,
    maxAgeMs: null,
  };
}

function evaluatePreconditionsStrategy(preconditionResults: PreconditionResult[]): FreshnessEvaluation {
  const { passed, failed } = preconditionOutcome(preconditionResults);
  return {
    staleness: passed ? 'FRESH' : 'INVALID',
    reason: passed
      ? `all ${preconditionResults.length} precondition(s) hold against current state`
      : `preconditions failed against current state: ${failed.map((f) => `${f.field} ${f.operator} (${f.reason})`).join('; ')}`,
    preconditions: preconditionResults,
    ageMs: null,
    maxAgeMs: null,
  };
}

function evaluateHybrid(
  dependency: StateDependency,
  current: StateSnapshot,
  ageMs: number | null,
  freshness: ResolvedFreshness,
  preconditionResults: PreconditionResult[],
): FreshnessEvaluation {
  const components = freshness.hybridComponents;
  const results: Array<{ component: string; staleness: StalenessClass; reason: string }> = [];

  if (components.ttl) {
    const r = evaluateTtl(dependency, ageMs, freshness, []);
    results.push({ component: 'ttl', staleness: r.staleness, reason: r.reason });
  }
  if (components.version) {
    const r = evaluateVersion(dependency, current, []);
    results.push({ component: 'version', staleness: r.staleness, reason: r.reason });
  }
  if (components.hash) {
    const r = evaluateHash(dependency, current, []);
    results.push({ component: 'hash', staleness: r.staleness, reason: r.reason });
  }
  if (components.preconditions) {
    const r = evaluatePreconditionsStrategy(preconditionResults);
    results.push({ component: 'preconditions', staleness: r.staleness, reason: r.reason });
  }

  const order: Record<StalenessClass, number> = {
    FRESH: 0,
    AGING: 1,
    STALE: 2,
    UNKNOWN: 3,
    INVALID: 4,
  };
  let worst = results[0];
  for (const r of results.slice(1)) {
    if (order[r.staleness] > order[worst!.staleness]) {
      worst = r;
    }
  }

  return {
    staleness: worst!.staleness,
    reason: `hybrid check (${results.map((r) => `${r.component}=${r.staleness}`).join(', ')}): ${worst!.reason}`,
    preconditions: preconditionResults,
    ageMs,
    maxAgeMs: freshness.maxAgeMs ?? null,
  };
}

export function ageOfSnapshot(snapshot: StateSnapshot, nowMs: number, skewToleranceMs: number): number | null {
  return assessAge(snapshot.observed_at, nowMs, skewToleranceMs).ageMs;
}

export type { Precondition };
