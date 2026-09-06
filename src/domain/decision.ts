/**
 * Decision domain model (spec §6, §8, §22, §40).
 *
 * The firewall always produces an explicit, explainable decision. Decisions
 * are deterministic: same policy + observed state + current state + action +
 * risk => same decision (invariant 4).
 */

import type { ResourceReference } from './state.js';
import type { ExecutionResult, Precondition, RiskLevel } from './action.js';

export type DecisionType = 'ALLOW' | 'DENY' | 'REVALIDATE' | 'ESCALATE';

export const DECISION_TYPES: readonly DecisionType[] = ['ALLOW', 'DENY', 'REVALIDATE', 'ESCALATE'];

export type StalenessClass = 'FRESH' | 'AGING' | 'STALE' | 'INVALID' | 'UNKNOWN';

export const STALENESS_CLASSES: readonly StalenessClass[] = [
  'FRESH',
  'AGING',
  'STALE',
  'INVALID',
  'UNKNOWN',
];

/** Outcome of a single precondition evaluated against current state. */
export interface PreconditionResult {
  field: string;
  operator: Precondition['operator'];
  expected?: unknown;
  actual?: unknown;
  passed: boolean;
  reason: string;
}

/** Verdict for one dependency of an action. */
export interface DependencyVerdict {
  dependency: ResourceReference;
  staleness: StalenessClass;
  reason: string;
  /** Whether the current state was fetched fresh by the firewall for this verdict. */
  verified_fresh: boolean;
  observed_version: string | null;
  current_version: string | null;
  observed_content_hash: string | null;
  current_content_hash: string | null;
  observed_at: string | null;
  current_observed_at: string | null;
  age_ms: number | null;
  max_age_ms: number | null;
  strategy: string;
  preconditions: PreconditionResult[];
}

export type FirewallMode = 'OBSERVE' | 'ENFORCE' | 'STRICT';

export interface DecisionRecord {
  decision_id: string;
  action_id: string;
  agent_id: string;
  tool: string;
  operation: string;
  target: string | null;
  risk_level: RiskLevel;
  decision: DecisionType;
  /** In OBSERVE mode the effective decision is always ALLOW, but the
   * decision the firewall would have made is recorded here. */
  would_have_decided: DecisionType | null;
  reason: string;
  policy_name: string;
  policy_version: string;
  mode: FirewallMode;
  verdicts: DependencyVerdict[];
  stale_dependencies: string[];
  invalid_dependencies: string[];
  unknown_dependencies: string[];
  preconditions: PreconditionResult[];
  created_at: string;
  /** Until when an ALLOW remains executable. */
  expires_at: string | null;
  revalidated: boolean;
  execution: ExecutionResult | null;
}
