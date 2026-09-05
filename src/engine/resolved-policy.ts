/**
 * Runtime-resolved policy structures: durations parsed to milliseconds,
 * defaults applied, ready for deterministic evaluation. Building these is
 * fail-fast: any malformed policy value throws before enforcement begins.
 */

import type { FreshnessStrategy, FirewallPolicyConfig } from '../domain/policy.js';
import type { Precondition, RiskLevel } from '../domain/action.js';
import type { OutcomeDecision } from '../domain/policy.js';
import { ConfigurationError } from '../domain/errors.js';
import { parseDurationMs } from './duration.js';

export interface ResolvedFreshness {
  strategy: FreshnessStrategy;
  maxAgeMs: number | null;
  agingThreshold: number;
  skewToleranceMs: number;
  hybridComponents: { ttl: boolean; version: boolean; hash: boolean; preconditions: boolean };
}

export interface ResolvedExecutionPolicy {
  deadlineMs: number | null;
  requireFreshAtExecution: boolean;
  allowIdempotentRetry: boolean;
}

export interface ResolvedPolicy {
  name: string;
  description: string | null;
  /** Declaration index; deterministic tie-break for equal-specificity matches. */
  declarationIndex: number;
  matcher: FirewallPolicyConfig['match'];
  declaredRisk: RiskLevel | null;
  freshness: ResolvedFreshness;
  preconditions: Precondition[];
  requireDependencies: boolean;
  dependencyRules: ResolvedDependencyRule[];
  outcomes: {
    fresh: OutcomeDecision | null;
    aging: OutcomeDecision | null;
    stale: OutcomeDecision | null;
    unknown: OutcomeDecision | null;
    invalid: OutcomeDecision | null;
  };
  execution: ResolvedExecutionPolicy;
}

export interface ResolvedDependencyRule {
  source: string | null;
  resource: string | null;
  resourceId: string | null;
  freshness: ResolvedFreshness;
}

export interface GlobalDefaults {
  outcomes: {
    fresh: OutcomeDecision;
    aging: OutcomeDecision | null;
    stale: OutcomeDecision | null;
    unknown: OutcomeDecision | null;
    invalid: OutcomeDecision | null;
  };
  freshness: ResolvedFreshness;
  execution: ResolvedExecutionPolicy;
}

export const DEFAULT_AGING_THRESHOLD = 0.75;
export const DEFAULT_MAX_AGE_MS = 30_000;
export const DEFAULT_DEADLINE_HIGH_RISK_MS = 10_000;
export const DEFAULT_DEADLINE_MS = 60_000;

export function resolveFreshness(
  config: FirewallPolicyConfig['freshness'] | undefined,
  fallbackAgingThreshold: number | undefined,
  fallbackSkewMs: string | number | undefined,
  field: string,
): ResolvedFreshness {
  const strategy: FreshnessStrategy = config?.strategy ?? 'ttl';
  const agingThreshold = config?.aging_threshold ?? fallbackAgingThreshold ?? DEFAULT_AGING_THRESHOLD;
  const skewToleranceMs = parseDurationMs(
    config?.clock_skew_tolerance ?? fallbackSkewMs ?? 0,
    `${field}.clock_skew_tolerance`,
  );

  let maxAgeMs: number | null = null;
  if (strategy === 'ttl') {
    if (config?.max_age === undefined) {
      throw new ConfigurationError(`${field}: strategy "ttl" requires max_age`);
    }
    maxAgeMs = parseDurationMs(config.max_age, `${field}.max_age`);
    if (maxAgeMs <= 0) {
      throw new ConfigurationError(`${field}: max_age must be positive`);
    }
  } else if (config?.max_age !== undefined) {
    maxAgeMs = parseDurationMs(config.max_age, `${field}.max_age`);
  }

  let hybridComponents = { ttl: false, version: false, hash: false, preconditions: false };
  if (strategy === 'hybrid') {
    const h = config?.hybrid;
    const explicit = {
      ttl: h?.ttl === true,
      version: h?.version === true,
      hash: h?.hash === true,
      preconditions: h?.preconditions === true,
    };
    const anyExplicit = explicit.ttl || explicit.version || explicit.hash || explicit.preconditions;
    if (!anyExplicit) {
      // Sensible default hybrid: version equality + TTL.
      hybridComponents = { ttl: true, version: true, hash: false, preconditions: true };
    } else {
      hybridComponents = explicit;
      if (hybridComponents.ttl && maxAgeMs === null) {
        throw new ConfigurationError(
          `${field}: hybrid strategy with ttl component requires max_age`,
        );
      }
    }
  }

  if (agingThreshold <= 0 || agingThreshold > 1) {
    throw new ConfigurationError(`${field}: aging_threshold must be in (0, 1]`);
  }

  return { strategy, maxAgeMs, agingThreshold, skewToleranceMs, hybridComponents };
}

export function resolveExecutionPolicy(
  config: FirewallPolicyConfig['execution'],
  field: string,
): ResolvedExecutionPolicy {
  const deadlineMs =
    config?.deadline !== undefined ? parseDurationMs(config.deadline, `${field}.deadline`) : null;
  return {
    deadlineMs,
    requireFreshAtExecution: config?.require_fresh_at_execution ?? true,
    allowIdempotentRetry: config?.allow_idempotent_retry ?? false,
  };
}

export function defaultDeadlineForRisk(risk: RiskLevel): number {
  return risk === 'HIGH' || risk === 'CRITICAL'
    ? DEFAULT_DEADLINE_HIGH_RISK_MS
    : DEFAULT_DEADLINE_MS;
}

export function buildDefaultFreshness(
  freshness: ResolvedFreshness | undefined,
  execution: ResolvedExecutionPolicy | undefined,
): { freshness: ResolvedFreshness; execution: ResolvedExecutionPolicy } {
  return {
    freshness:
      freshness ??
      resolveFreshness({ strategy: 'ttl', max_age: DEFAULT_MAX_AGE_MS }, undefined, undefined, 'defaults'),
    execution:
      execution ??
      resolveExecutionPolicy({ require_fresh_at_execution: true }, 'defaults.execution'),
  };
}
