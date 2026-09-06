/**
 * Staleness classification (spec §8).
 *
 * Staleness is explicitly classified, never reduced to a boolean:
 *   FRESH  — comfortably within policy
 *   AGING  — approaching the freshness boundary
 *   STALE  — exceeded the freshness requirement
 *   INVALID— demonstrably changed or invariant failed
 *   UNKNOWN— validity cannot be established (fail toward safety)
 *
 * Severity ordering used for aggregation (worst last):
 *   FRESH < AGING < STALE < UNKNOWN < INVALID
 * INVALID outranks UNKNOWN because a proven state change is stronger
 * evidence than an inability to verify.
 */

import type { StalenessClass } from '../domain/decision.js';

export const STALENESS_SEVERITY: Record<StalenessClass, number> = {
  FRESH: 0,
  AGING: 1,
  STALE: 2,
  UNKNOWN: 3,
  INVALID: 4,
};

export function worstOf(a: StalenessClass, b: StalenessClass): StalenessClass {
  return STALENESS_SEVERITY[a] >= STALENESS_SEVERITY[b] ? a : b;
}

export function worstOfAll(classes: StalenessClass[]): StalenessClass {
  let worst: StalenessClass = 'FRESH';
  for (const c of classes) {
    worst = worstOf(worst, c);
  }
  return worst;
}

export interface AgeAssessment {
  /** Age in ms, or null when the observation timestamp is unusable. */
  ageMs: number | null;
  /**
   * 'future_timestamp' when observed_at is beyond now + skew tolerance —
   * a clock problem or fabricated metadata; treat as UNKNOWN.
   */
  anomaly: 'future_timestamp' | null;
}

/**
 * Computes the age of an observation. Skew tolerance widens the acceptable
 * window (spec §27): a state observed slightly "in the future" relative to a
 * skewed local clock is tolerated up to skewToleranceMs.
 */
export function assessAge(
  observedAtIso: string | null,
  nowMs: number,
  skewToleranceMs: number,
): AgeAssessment {
  if (observedAtIso === null || observedAtIso === undefined || observedAtIso === '') {
    return { ageMs: null, anomaly: null };
  }
  const observedMs = Date.parse(observedAtIso);
  if (!Number.isFinite(observedMs)) {
    return { ageMs: null, anomaly: null };
  }
  if (observedMs > nowMs + skewToleranceMs) {
    return { ageMs: null, anomaly: 'future_timestamp' };
  }
  return { ageMs: Math.max(0, nowMs - observedMs), anomaly: null };
}

/**
 * TTL classification. Boundaries:
 *   age <= agingThreshold * maxAge           -> FRESH
 *   age <= maxAge                            -> AGING
 *   age  > maxAge                            -> STALE
 * A null age (missing/unusable timestamp) must be handled by the caller as
 * UNKNOWN; this function only classifies known ages.
 */
export function classifyByAge(ageMs: number, maxAgeMs: number, agingThreshold: number): StalenessClass {
  if (ageMs >= maxAgeMs) {
    return 'STALE';
  }
  if (ageMs > agingThreshold * maxAgeMs) {
    return 'AGING';
  }
  return 'FRESH';
}
