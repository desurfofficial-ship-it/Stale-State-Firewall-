/**
 * Configuration normalization (spec §33).
 *
 * Accepts human-typed enum values in any case ("critical", "Deploy*", mode
 * "OBSERVE") and normalizes them to the canonical uppercase forms before
 * validation and runtime. Unknown values still fail validation — only the
 * spelling is forgiven, never the vocabulary.
 */

import type { FirewallRootConfigFile, PolicyTestCaseFile } from './schema.js';
import type { FirewallPolicyConfig } from '../domain/policy.js';
import type { RiskLevel, Precondition } from '../domain/action.js';
import type { OutcomeDecision } from '../domain/policy.js';

function upper(value: unknown): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

function lower(value: unknown): unknown {
  return typeof value === 'string' ? value.toLowerCase() : value;
}

function normalizePrecondition(p: Precondition): Precondition {
  return { ...p, operator: lower(p.operator) as Precondition['operator'] };
}

function normalizePolicy(policy: FirewallPolicyConfig): FirewallPolicyConfig {
  return {
    ...policy,
    risk: upper(policy.risk) as RiskLevel | undefined,
    match: {
      ...policy.match,
      risk: upper(policy.match?.risk) as RiskLevel | undefined,
    },
    on_fresh: lower(policy.on_fresh) as OutcomeDecision | undefined,
    on_aging: lower(policy.on_aging) as OutcomeDecision | undefined,
    on_stale: lower(policy.on_stale) as OutcomeDecision | undefined,
    on_unknown: lower(policy.on_unknown) as OutcomeDecision | undefined,
    on_invalid: lower(policy.on_invalid) as OutcomeDecision | undefined,
    preconditions: policy.preconditions?.map(normalizePrecondition),
  };
}

function normalizeTestCase(test: PolicyTestCaseFile): PolicyTestCaseFile {
  return {
    ...test,
    expect_decision: upper(test.expect_decision) as PolicyTestCaseFile['expect_decision'],
    action: {
      ...test.action,
      risk_level: upper(test.action.risk_level) as RiskLevel | undefined,
      preconditions: test.action.preconditions?.map(normalizePrecondition),
    },
  };
}

export function normalizePolicies(policies: FirewallPolicyConfig[]): FirewallPolicyConfig[] {
  return policies.map(normalizePolicy);
}

export function normalizeConfigFile(input: FirewallRootConfigFile): FirewallRootConfigFile {
  const mode = upper(input.firewall?.mode);
  return {
    ...input,
    firewall: {
      ...input.firewall,
      ...(mode === 'OBSERVE' || mode === 'ENFORCE' || mode === 'STRICT' ? { mode: mode.toLowerCase() as FirewallRootConfigFile['firewall']['mode'] } : { mode: input.firewall?.mode }),
    },
    defaults: input.defaults
      ? {
          ...input.defaults,
          on_unknown: lower(input.defaults.on_unknown) as OutcomeDecision | undefined,
          on_stale: lower(input.defaults.on_stale) as OutcomeDecision | undefined,
          on_invalid: lower(input.defaults.on_invalid) as OutcomeDecision | undefined,
          on_aging: lower(input.defaults.on_aging) as OutcomeDecision | undefined,
          on_fresh: lower(input.defaults.on_fresh) as OutcomeDecision | undefined,
          unknown: lower(input.defaults.unknown) as OutcomeDecision | undefined,
          stale: lower(input.defaults.stale) as OutcomeDecision | undefined,
          invalid: lower(input.defaults.invalid) as OutcomeDecision | undefined,
          aging: lower(input.defaults.aging) as OutcomeDecision | undefined,
          fresh: lower(input.defaults.fresh) as OutcomeDecision | undefined,
        }
      : input.defaults,
    actions: input.actions?.map(normalizePolicy),
    risk_defaults: input.risk_defaults
      ? {
          rules: input.risk_defaults.rules?.map((rule) => ({ ...rule, risk: upper(rule.risk) as RiskLevel })),
          default: upper(input.risk_defaults.default) as RiskLevel | undefined,
        }
      : input.risk_defaults,
    policy_tests: input.policy_tests?.map(normalizeTestCase),
  };
}
