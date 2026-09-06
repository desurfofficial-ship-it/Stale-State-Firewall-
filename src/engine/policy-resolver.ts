/**
 * Policy resolution (spec §32).
 *
 * Deterministic precedence, highest first:
 *   1. explicit action policy   (intent names a policy)
 *   2. matched policy by specificity (tool/operation/target/risk matchers)
 *   3. risk defaults            (operation pattern -> risk level)
 *   4. global default           (synthetic policy from config defaults)
 *
 * Risk derivation (spec §9), resolved without circularity:
 *   base risk = intent-declared risk, else risk-defaults by operation
 *   final risk = max(base risk, matched policy's declared risk)
 *
 * Ties between equally specific matchers are broken by declaration order —
 * deterministic, documented, and rejected by `ssf policy validate` when the
 * matchers are structurally identical. Object iteration order is never
 * relied upon: matchers carry an explicit declaration index.
 */

import type { ActionIntent, RiskLevel } from '../domain/action.js';
import { maxRisk } from '../domain/action.js';
import type { RiskDefaultsConfig } from '../domain/policy.js';
import type { ResolvedPolicy, GlobalDefaults, ResolvedFreshness } from './resolved-policy.js';
import { globMatch } from './glob.js';

const RISK_RANK: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

function riskRank(risk: RiskLevel): number {
  return RISK_RANK[risk];
}

export interface ResolvedRisk {
  risk: RiskLevel;
  source: 'intent' | 'policy' | 'risk_defaults';
}

function matchesPolicy(policy: ResolvedPolicy, intent: ActionIntent, baseRisk: RiskLevel): boolean {
  const m = policy.matcher;
  if (m.tool !== undefined && !globMatch(m.tool, intent.tool)) return false;
  if (m.operation !== undefined && !globMatch(m.operation, intent.operation)) return false;
  if (m.target !== undefined && !globMatch(m.target, intent.target ?? '')) return false;
  // Risk matcher is a floor: the policy applies when the action is at least this risky.
  if (m.risk !== undefined && riskRank(baseRisk) < riskRank(m.risk)) return false;
  return true;
}

export function matcherSpecificity(policy: ResolvedPolicy): number {
  const m = policy.matcher;
  let score = 0;
  if (m.tool !== undefined) score += 1;
  if (m.operation !== undefined) score += 2;
  if (m.target !== undefined) score += 1;
  if (m.risk !== undefined) score += 1;
  return score;
}

/** Derives the base risk before any policy is selected (spec §9). */
export function deriveRisk(
  intent: ActionIntent,
  riskDefaults: RiskDefaultsConfig | null,
): ResolvedRisk {
  if (intent.risk_level) {
    return { risk: intent.risk_level, source: 'intent' };
  }
  if (riskDefaults) {
    for (const rule of riskDefaults.rules) {
      if (globMatch(rule.match, intent.operation)) {
        return { risk: rule.risk, source: 'risk_defaults' };
      }
    }
    return { risk: riskDefaults.default, source: 'risk_defaults' };
  }
  return { risk: 'MEDIUM', source: 'risk_defaults' };
}

export interface PolicyResolution {
  policy: ResolvedPolicy;
  risk: RiskLevel;
  riskSource: ResolvedRisk['source'];
  resolution: 'explicit' | 'matched' | 'default';
}

export function resolvePolicy(params: {
  intent: ActionIntent;
  policies: readonly ResolvedPolicy[];
  defaults: GlobalDefaults;
  riskDefaults: RiskDefaultsConfig | null;
}): PolicyResolution {
  const { intent, policies, defaults, riskDefaults } = params;
  const base = deriveRisk(intent, riskDefaults);

  // 1. Explicit action policy.
  if (intent.policy_name) {
    const explicit = policies.find((p) => p.name === intent.policy_name);
    if (explicit) {
      const risk = maxRisk(base.risk, explicit.declaredRisk ?? base.risk);
      return {
        policy: explicit,
        risk,
        riskSource: intent.risk_level ? 'intent' : explicit.declaredRisk ? 'policy' : base.source,
        resolution: 'explicit',
      };
    }
    // A named-but-missing policy is a hard configuration error; callers
    // (validate-action) check existence first and throw PolicyNotFoundError.
    const synthetic = syntheticDefaultPolicy(defaults);
    return { policy: synthetic, risk: base.risk, riskSource: base.source, resolution: 'default' };
  }

  // 2. Matcher-based resolution: highest specificity wins, declaration order breaks ties.
  let best: ResolvedPolicy | null = null;
  let bestScore = -1;
  for (const policy of policies) {
    if (!matchesPolicy(policy, intent, base.risk)) continue;
    const score = matcherSpecificity(policy);
    if (score > bestScore) {
      best = policy;
      bestScore = score;
    }
  }

  if (best) {
    const risk = maxRisk(base.risk, best.declaredRisk ?? base.risk);
    return {
      policy: best,
      risk,
      riskSource: intent.risk_level ? 'intent' : best.declaredRisk ? 'policy' : base.source,
      resolution: 'matched',
    };
  }

  // 3./4. Global default.
  const synthetic = syntheticDefaultPolicy(defaults);
  return { policy: synthetic, risk: base.risk, riskSource: base.source, resolution: 'default' };
}

/** True when two declared policies have structurally identical matchers. */
export function findAmbiguousMatchers(policies: readonly ResolvedPolicy[]): Array<[string, string]> {
  const conflicts: Array<[string, string]> = [];
  for (let i = 0; i < policies.length; i++) {
    for (let j = i + 1; j < policies.length; j++) {
      const a = JSON.stringify(policies[i]?.matcher ?? {});
      const b = JSON.stringify(policies[j]?.matcher ?? {});
      if (a === b) {
        conflicts.push([policies[i]!.name, policies[j]!.name]);
      }
    }
  }
  return conflicts;
}

export function syntheticDefaultPolicy(defaults: GlobalDefaults): ResolvedPolicy {
  return {
    name: 'global-default',
    description: 'Synthetic fallback policy built from configuration defaults',
    declarationIndex: Number.MAX_SAFE_INTEGER,
    matcher: {},
    declaredRisk: null,
    freshness: defaults.freshness,
    preconditions: [],
    requireDependencies: false,
    dependencyRules: [],
    outcomes: { ...defaults.outcomes },
    execution: defaults.execution,
  };
}

export function resolveDependencyFreshness(
  policy: ResolvedPolicy,
  dependencyRef: { source: string; resource: string; resource_id: string },
  fallback: ResolvedFreshness,
): ResolvedFreshness {
  for (const rule of policy.dependencyRules) {
    if (rule.source !== null && !globMatch(rule.source, dependencyRef.source)) continue;
    if (rule.resource !== null && !globMatch(rule.resource, dependencyRef.resource)) continue;
    if (rule.resourceId !== null && !globMatch(rule.resourceId, dependencyRef.resource_id)) continue;
    return rule.freshness;
  }
  return fallback;
}

export { resolveFreshness, resolveExecutionPolicy } from './resolved-policy.js';
