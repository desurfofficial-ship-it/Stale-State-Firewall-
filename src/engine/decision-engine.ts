/**
 * Deterministic decision engine (spec §6, §42, §70).
 *
 * Composition rules, in priority order:
 *   any INVALID dependency   -> policy.on_invalid   (default: deny)
 *   any UNKNOWN dependency   -> policy.on_unknown   (default: revalidate)
 *   any STALE dependency     -> policy.on_stale     (default: revalidate)
 *   any AGING dependency     -> policy.on_aging     (default: allow for LOW/MEDIUM
 *                                                      risk, revalidate for HIGH/CRITICAL)
 *   all FRESH                -> policy.on_fresh     (default: allow)
 *
 * Hard invariants enforced here regardless of configuration:
 *   - A CRITICAL action is never ALLOWED on UNKNOWN state (invariant 2).
 *   - A CRITICAL action is never ALLOWED when a required dependency is INVALID.
 *   - In STRICT mode, uncertainty maps to denial/escalation.
 *   - In OBSERVE mode the action proceeds but the would-be decision is recorded.
 */

import type { ActionIntent, RiskLevel } from '../domain/action.js';
import type {
  DecisionType,
  DependencyVerdict,
  FirewallMode,
  PreconditionResult,
} from '../domain/decision.js';
import type { OutcomeDecision } from '../domain/policy.js';
import type { ResolvedPolicy, GlobalDefaults } from './resolved-policy.js';
import { STALENESS_SEVERITY } from './staleness.js';
import { RISK_SEVERITY } from '../domain/action.js';
import { refKey } from '../domain/state.js';

export interface DecisionInput {
  intent: ActionIntent;
  policy: ResolvedPolicy;
  defaults: GlobalDefaults;
  verdicts: readonly DependencyVerdict[];
  mode: FirewallMode;
  /** Outcome of an earlier attempt; revalidation recomputes from current state. */
  revalidated: boolean;
}

export interface DecisionOutput {
  decision: DecisionType;
  reason: string;
  staleDependencies: string[];
  invalidDependencies: string[];
  unknownDependencies: string[];
}

function outcomeFor(
  policy: ResolvedPolicy,
  defaults: GlobalDefaults,
  key: 'fresh' | 'aging' | 'stale' | 'unknown' | 'invalid',
): OutcomeDecision {
  const policyValue = policy.outcomes[key];
  if (policyValue !== null && policyValue !== undefined) return policyValue;
  const defaultValue = defaults.outcomes[key];
  if (defaultValue !== null && defaultValue !== undefined) return defaultValue;
  return DEFAULT_OUTCOMES[key];
}

const DEFAULT_OUTCOMES: Record<'fresh' | 'aging' | 'stale' | 'unknown' | 'invalid', OutcomeDecision> = {
  fresh: 'allow',
  aging: 'allow',
  stale: 'revalidate',
  unknown: 'revalidate',
  invalid: 'deny',
};

function defaultAgingOutcome(risk: RiskLevel): OutcomeDecision {
  return RISK_SEVERITY[risk] >= RISK_SEVERITY.HIGH ? 'revalidate' : 'allow';
}

function applyStrictMode(outcome: OutcomeDecision, basis: 'fresh' | 'aging' | 'stale' | 'unknown' | 'invalid'): OutcomeDecision {
  if (basis === 'unknown' && outcome === 'allow') return 'deny';
  if (basis === 'unknown' && outcome === 'revalidate') return 'deny';
  if (basis === 'aging' && outcome === 'allow') return 'revalidate';
  return outcome;
}

/** Hard safety floor that no configuration can override. */
function applySafetyFloor(
  outcome: OutcomeDecision,
  basis: 'fresh' | 'aging' | 'stale' | 'unknown' | 'invalid',
  risk: RiskLevel,
): OutcomeDecision {
  if (basis === 'unknown' && outcome === 'allow' && RISK_SEVERITY[risk] >= RISK_SEVERITY.CRITICAL) {
    return 'revalidate';
  }
  if (basis === 'invalid' && outcome === 'allow') {
    // A proven state change must never authorize the original action silently.
    return 'revalidate';
  }
  return outcome;
}

function toDecisionType(outcome: OutcomeDecision): DecisionType {
  switch (outcome) {
    case 'allow':
      return 'ALLOW';
    case 'deny':
      return 'DENY';
    case 'revalidate':
      return 'REVALIDATE';
    case 'escalate':
      return 'ESCALATE';
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unknown outcome: ${String(exhaustive)}`);
    }
  }
}

export function decide(input: DecisionInput): DecisionOutput {
  const { intent, policy, defaults, verdicts, mode, revalidated } = input;
  const risk = intent.risk_level;

  const stale = verdicts.filter((v) => v.staleness === 'STALE').map((v) => refKey(v.dependency));
  const invalid = verdicts.filter((v) => v.staleness === 'INVALID').map((v) => refKey(v.dependency));
  const unknown = verdicts.filter((v) => v.staleness === 'UNKNOWN').map((v) => refKey(v.dependency));
  const aging = verdicts.filter((v) => v.staleness === 'AGING');

  let basis: 'fresh' | 'aging' | 'stale' | 'unknown' | 'invalid';
  if (verdicts.length === 0 && policy.requireDependencies) {
    basis = 'unknown';
  } else if (invalid.length > 0) {
    basis = 'invalid';
  } else if (unknown.length > 0 || (verdicts.length === 0 && revalidated === false && policy.requireDependencies)) {
    basis = 'unknown';
  } else if (stale.length > 0) {
    basis = 'stale';
  } else if (aging.length > 0) {
    basis = 'aging';
  } else if (verdicts.length > 0 && verdicts.every((v) => v.staleness === 'FRESH')) {
    basis = 'fresh';
  } else {
    // No dependencies declared and policy does not require them: the decision
    // rests on preconditions only. Treat as fresh if policy has none.
    basis = 'fresh';
  }

  let outcome: OutcomeDecision;
  if (basis === 'aging') {
    const configured = policy.outcomes.aging ?? defaults.outcomes.aging;
    outcome = configured ?? defaultAgingOutcome(risk);
  } else {
    outcome = outcomeFor(policy, defaults, basis);
  }

  // Precondition failures on FRESH state are still invariant failures: any
  // failed precondition among fresh verdicts forces the invalid path.
  if (basis === 'fresh' || basis === 'aging') {
    const failedPreconditions = verdicts.flatMap((v) => v.preconditions).filter((p) => !p.passed);
    if (failedPreconditions.length > 0) {
      outcome = applySafetyFloor(outcomeFor(policy, defaults, 'invalid'), 'invalid', risk);
      basis = 'invalid';
    }
  }

  outcome = applySafetyFloor(outcome, basis, risk);
  // Revalidation must resolve uncertainty, not loop on it (invariant 10):
  // if state validity is still UNKNOWN after revalidation, fail closed.
  if (revalidated && basis === 'unknown' && outcome === 'revalidate') {
    outcome = 'deny';
  }
  if (mode === 'STRICT') {
    outcome = applyStrictMode(outcome, basis);
  }

  const decision = toDecisionType(outcome);
  const reason = explainDecision(basis, outcome, policy, intent, verdicts, risk);

  return {
    decision,
    reason,
    staleDependencies: stale,
    invalidDependencies: invalid,
    unknownDependencies: unknown,
  };
}

function explainDecision(
  basis: 'fresh' | 'aging' | 'stale' | 'unknown' | 'invalid',
  outcome: OutcomeDecision,
  policy: ResolvedPolicy,
  intent: ActionIntent,
  verdicts: readonly DependencyVerdict[],
  risk: RiskLevel,
): string {
  const policyNote = `policy "${policy.name}"`;
  const evidence = verdicts
    .filter((v) => STALENESS_SEVERITY[v.staleness] > 0)
    .map((v) => `${refKey(v.dependency)} is ${v.staleness} (${v.reason})`)
    .slice(0, 5)
    .join('; ');

  switch (basis) {
    case 'invalid':
      return `${policyNote}: required dependency is INVALID — ${evidence || 'a precondition failed against current state'}. Action risk ${risk}. Decision: ${outcome.toUpperCase()}.`;
    case 'unknown':
      return `${policyNote}: state validity could not be established — ${evidence || 'no observation basis was declared'}. Fail-safe behavior for risk ${risk}. Decision: ${outcome.toUpperCase()}.`;
    case 'stale':
      return `${policyNote}: freshness requirement violated — ${evidence}. Decision: ${outcome.toUpperCase()}.`;
    case 'aging':
      return `${policyNote}: state is AGING — ${evidence}. Risk ${risk}. Decision: ${outcome.toUpperCase()}.`;
    case 'fresh':
      return `${policyNote}: all ${verdicts.length} declared dependency(ies) are FRESH and preconditions hold${intent.preconditions.length ? ' (including intent preconditions)' : ''}. Decision: ${outcome.toUpperCase()}.`;
    default: {
      const exhaustive: never = basis;
      throw new Error(String(exhaustive));
    }
  }
}

/** Collects failed preconditions across verdicts for explanations/audit. */
export function failedPreconditions(verdicts: readonly DependencyVerdict[]): PreconditionResult[] {
  return verdicts.flatMap((v) => v.preconditions).filter((p) => !p.passed);
}
