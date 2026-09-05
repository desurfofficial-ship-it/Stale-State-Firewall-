/**
 * Policy domain model (spec §10, §11, §32, §40).
 *
 * Policies are declarative, deterministic, inspectable, versioned, testable,
 * and auditable. Business logic must not be embedded in adapters.
 */

import type { Precondition, RiskLevel } from './action.js';

/**
 * Freshness strategies (spec §7):
 * - ttl            : age of the observation vs max_age
 * - version        : observed_version must equal current_version
 * - hash           : observed content hash must equal current content hash
 * - preconditions  : invariants evaluated against current state
 * - hybrid         : ALL enabled components must pass
 */
export type FreshnessStrategy = 'ttl' | 'version' | 'hash' | 'preconditions' | 'hybrid';

export const FRESHNESS_STRATEGIES: readonly FreshnessStrategy[] = [
  'ttl',
  'version',
  'hash',
  'preconditions',
  'hybrid',
];

export type OutcomeDecision = 'allow' | 'deny' | 'revalidate' | 'escalate';

export const OUTCOME_DECISIONS: readonly OutcomeDecision[] = [
  'allow',
  'deny',
  'revalidate',
  'escalate',
];

export interface FreshnessPolicyConfig {
  strategy: FreshnessStrategy;
  /** TTL boundary, e.g. "10s", "2m", 500 (ms). Required for ttl; optional for hybrid. */
  max_age?: string | number;
  /** Fraction of max_age after which state is AGING (default 0.75). */
  aging_threshold?: number;
  /** Clock-skew tolerance applied to age comparisons (default 0ms). */
  clock_skew_tolerance?: string | number;
  /** Components enabled for the hybrid strategy. */
  hybrid?: {
    ttl?: boolean;
    version?: boolean;
    hash?: boolean;
    preconditions?: boolean;
  };
}

export interface PolicyMatcher {
  /** Glob pattern against the tool name ("github", "http*", ...). */
  tool?: string;
  /** Glob pattern against the operation name ("deploy*", "merge_pull_request"). */
  operation?: string;
  /** Glob pattern against the primary target (dependency[0] resource id). */
  target?: string;
  /** Minimum risk this policy applies to. */
  risk?: RiskLevel;
}

/**
 * Per-dependency freshness override. `source` and `resource` are glob
 * patterns matched against each dependency reference.
 */
export interface DependencyFreshnessRule {
  source?: string;
  resource?: string;
  resource_id?: string;
  freshness: FreshnessPolicyConfig;
}

export interface ExecutionPolicyConfig {
  /** How long an ALLOW stays executable (default: 10s for HIGH/CRITICAL, 60s otherwise). */
  deadline?: string | number;
  /** Re-fetch state immediately before the side effect (default true for HIGH/CRITICAL). */
  require_fresh_at_execution?: boolean;
  /** Permit retry of an executor-declared idempotent operation under the same action id. */
  allow_idempotent_retry?: boolean;
  /**
   * Require provider-side conditional execution (the external system itself
   * rejects the operation when the authorized state is no longer true).
   * When true and the executor cannot enforce the condition, the action is
   * decided by `on_conditional_unavailable` (default deny) instead of
   * falling back to best-effort pre-execution verification.
   */
  require_conditional_execution?: boolean;
  /**
   * Outcome when conditional execution is required but the executor/provider
   * cannot enforce it. Default: deny. A human approval cannot give a
   * provider compare-and-swap semantics, so escalate is NOT the default.
   */
  on_conditional_unavailable?: OutcomeDecision;
}

export interface FirewallPolicyConfig {
  name: string;
  description?: string;
  match: PolicyMatcher;
  /** Risk assigned to matched actions when the intent does not declare one. */
  risk?: RiskLevel;
  /** Default freshness for this policy's dependencies. Default: strategy ttl, max_age 30s. */
  freshness?: FreshnessPolicyConfig;
  /** Invariants verified against current fresh state. */
  preconditions?: Precondition[];
  /** When true, an action without any dependency is treated as UNKNOWN -> on_unknown (spec §47 dependency omission). */
  require_dependencies?: boolean;
  /** Dependency-level freshness overrides, evaluated in declaration order (first match wins). */
  dependency_freshness?: DependencyFreshnessRule[];
  on_fresh?: OutcomeDecision;
  on_aging?: OutcomeDecision;
  on_stale?: OutcomeDecision;
  on_unknown?: OutcomeDecision;
  on_invalid?: OutcomeDecision;
  execution?: ExecutionPolicyConfig;
}

/**
 * Risk defaults map operation glob patterns to risk levels (spec §9).
 * First matching pattern wins; `default` applies when nothing matches.
 */
export interface RiskDefaultRule {
  match: string;
  risk: RiskLevel;
}

export interface RiskDefaultsConfig {
  rules: RiskDefaultRule[];
  default: RiskLevel;
}
