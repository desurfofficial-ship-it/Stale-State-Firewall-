import { describe, it, expect } from 'vitest';
import { decide } from '../../src/engine/decision-engine.js';
import { resolvePolicy, deriveRisk, matcherSpecificity } from '../../src/engine/policy-resolver.js';
import { resolvePolicyConfig, resolveGlobalDefaults } from '../../src/config/loader.js';
import { buildDefaultFreshness } from '../../src/engine/resolved-policy.js';
import type { ActionIntent, RiskLevel } from '../../src/domain/action.js';
import type { DependencyVerdict, FirewallMode } from '../../src/domain/decision.js';
import type { FirewallPolicyConfig } from '../../src/domain/policy.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';

function intent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    action_id: 'act_test',
    agent_id: 'agent_test',
    tool: 'github',
    operation: 'merge_pull_request',
    target: 'org/repo#42',
    arguments: {},
    dependencies: [],
    preconditions: [],
    risk_level: 'HIGH',
    policy_name: null,
    created_at: '2026-09-05T12:00:00Z',
    execution_deadline_ms: 0,
    idempotency_key: null,
    ...overrides,
  };
}

function verdict(staleness: DependencyVerdict['staleness'], ref = 'memory:thing/a'): DependencyVerdict {
  return {
    dependency: { source: 'memory', resource: 'thing', resource_id: ref.split('/').pop() ?? 'a' },
    staleness,
    reason: `test verdict: ${staleness}`,
    verified_fresh: staleness !== 'UNKNOWN',
    observed_version: 'v1',
    current_version: staleness === 'INVALID' ? 'v2' : 'v1',
    observed_content_hash: null,
    current_content_hash: null,
    observed_at: null,
    current_observed_at: null,
    age_ms: null,
    max_age_ms: null,
    strategy: 'ttl',
    preconditions: [],
  };
}

const baseConfig: FirewallRootConfigFile = {
  firewall: { mode: 'enforce' },
};

function core(config: FirewallRootConfigFile = baseConfig) {
  return {
    policies: (config.actions ?? []).map(resolvePolicyConfig),
    defaults: resolveGlobalDefaults(config),
    mode: config.firewall.mode.toUpperCase() as FirewallMode,
  };
}

function policyOf(config: FirewallPolicyConfig) {
  return resolvePolicyConfig(config, 0);
}

function defaultsWith(partial: FirewallRootConfigFile['defaults']): ReturnType<typeof resolveGlobalDefaults> {
  return resolveGlobalDefaults({ firewall: { mode: 'enforce' }, defaults: partial });
}

describe('decision composition (spec §6, §10)', () => {
  const defaults = core().defaults;
  const defaultPolicy = policyOf({
    name: 'default',
    match: { operation: '*' },
  });

  it('all FRESH -> ALLOW by default', () => {
    const output = decide({
      intent: intent(),
      policy: defaultPolicy,
      defaults,
      verdicts: [verdict('FRESH'), verdict('FRESH')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(output.decision).toBe('ALLOW');
  });

  it('any STALE -> REVALIDATE by default', () => {
    const output = decide({
      intent: intent(),
      policy: defaultPolicy,
      defaults,
      verdicts: [verdict('FRESH'), verdict('STALE')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(output.decision).toBe('REVALIDATE');
    expect(output.staleDependencies).toHaveLength(1);
  });

  it('any INVALID -> DENY by default (on_invalid default)', () => {
    const output = decide({
      intent: intent(),
      policy: defaultPolicy,
      defaults,
      verdicts: [verdict('INVALID')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(output.decision).toBe('DENY');
    expect(output.invalidDependencies).toHaveLength(1);
  });

  it('any UNKNOWN -> REVALIDATE by default', () => {
    const output = decide({
      intent: intent(),
      policy: defaultPolicy,
      defaults,
      verdicts: [verdict('UNKNOWN')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(output.decision).toBe('REVALIDATE');
  });

  it('AGING allows low-risk actions but forces revalidation for high risk (spec §8, §9)', () => {
    const low = decide({
      intent: intent({ risk_level: 'LOW' }),
      policy: defaultPolicy,
      defaults,
      verdicts: [verdict('AGING')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(low.decision).toBe('ALLOW');

    const critical = decide({
      intent: intent({ risk_level: 'CRITICAL' }),
      policy: defaultPolicy,
      defaults,
      verdicts: [verdict('AGING')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(critical.decision).toBe('REVALIDATE');
  });

  it('failed preconditions on fresh state force the INVALID path', () => {
    const v = { ...verdict('FRESH'), preconditions: [{ field: 'status', operator: 'equals' as const, expected: 'healthy', actual: 'degraded', passed: false, reason: 'mismatch' }] };
    const output = decide({
      intent: intent(),
      policy: defaultPolicy,
      defaults,
      verdicts: [v],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(output.decision).toBe('DENY');
  });

  it('policy overrides map stale to deny or escalate deterministically', () => {
    const strictPolicy = policyOf({
      name: 'strict-stale',
      match: { operation: '*' },
      on_stale: 'deny',
      on_unknown: 'escalate',
    });
    expect(
      decide({ intent: intent(), policy: strictPolicy, defaults, verdicts: [verdict('STALE')], mode: 'ENFORCE', revalidated: false }).decision,
    ).toBe('DENY');
    expect(
      decide({ intent: intent(), policy: strictPolicy, defaults, verdicts: [verdict('UNKNOWN')], mode: 'ENFORCE', revalidated: false }).decision,
    ).toBe('ESCALATE');
  });
});

describe('hard safety floor (spec §70 invariants 2 and 3)', () => {
  const defaults = core().defaults;

  it('CRITICAL + UNKNOWN can never ALLOW, even with on_unknown: allow', () => {
    const permissive = policyOf({ name: 'permissive', match: { operation: '*' }, on_unknown: 'allow' });
    const output = decide({
      intent: intent({ risk_level: 'CRITICAL' }),
      policy: permissive,
      defaults,
      verdicts: [verdict('UNKNOWN')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(output.decision).not.toBe('ALLOW');
  });

  it('INVALID can never silently authorize the original action, even with on_invalid: allow', () => {
    const permissive = policyOf({ name: 'permissive', match: { operation: '*' }, on_invalid: 'allow' });
    const output = decide({
      intent: intent({ risk_level: 'LOW' }),
      policy: permissive,
      defaults,
      verdicts: [verdict('INVALID')],
      mode: 'ENFORCE',
      revalidated: false,
    });
    expect(output.decision).not.toBe('ALLOW');
  });

  it('after revalidation, residual UNKNOWN fails closed (deny), not loop (invariant 10)', () => {
    const output = decide({
      intent: intent({ risk_level: 'MEDIUM' }),
      policy: policyOf({ name: 'd', match: { operation: '*' } }),
      defaults,
      verdicts: [verdict('UNKNOWN')],
      mode: 'ENFORCE',
      revalidated: true,
    });
    expect(output.decision).toBe('DENY');
  });
});

describe('mode transformations (spec §34)', () => {
  const defaultsEnforce = core({ firewall: { mode: 'enforce' } }).defaults;

  it('STRICT maps unknown to deny and aging to revalidate', () => {
    const strictDefaults = core({ firewall: { mode: 'strict' } }).defaults;
    const p = policyOf({ name: 'p', match: { operation: '*' } });
    expect(
      decide({ intent: intent({ risk_level: 'MEDIUM' }), policy: p, defaults: strictDefaults, verdicts: [verdict('UNKNOWN')], mode: 'STRICT', revalidated: false }).decision,
    ).toBe('DENY');
    expect(
      decide({ intent: intent({ risk_level: 'MEDIUM' }), policy: p, defaults: strictDefaults, verdicts: [verdict('AGING')], mode: 'STRICT', revalidated: false }).decision,
    ).not.toBe('ALLOW');
  });

  it('policy-level overrides still apply under ENFORCE', () => {
    const p = policyOf({ name: 'p', match: { operation: '*' }, on_unknown: 'deny' });
    expect(
      decide({ intent: intent(), policy: p, defaults: defaultsEnforce, verdicts: [verdict('UNKNOWN')], mode: 'ENFORCE', revalidated: false }).decision,
    ).toBe('DENY');
  });
});

describe('policy resolution precedence (spec §32)', () => {
  const config: FirewallRootConfigFile = {
    firewall: { mode: 'enforce' },
    actions: [
      { name: 'broad', match: { tool: 'github' }, risk: 'MEDIUM' },
      { name: 'specific', match: { tool: 'github', operation: 'merge*' }, risk: 'HIGH' },
      { name: 'targeted', match: { tool: 'github', operation: 'merge*', target: 'org/repo#42' }, risk: 'CRITICAL' },
      { name: 'risk-based', match: { risk: 'CRITICAL' }, risk: 'CRITICAL' },
    ],
  };
  const policies = config.actions!.map((p, i) => resolvePolicyConfig(p, i));
  const defaults = resolveGlobalDefaults(config);

  it('most specific matcher wins over broader ones and policy risk raises the action risk', () => {
    const resolution = resolvePolicy({ intent: intent({ risk_level: null }), policies, defaults, riskDefaults: null });
    expect(resolution.policy.name).toBe('targeted');
    expect(resolution.risk).toBe('CRITICAL');
    expect(matcherSpecificity(resolution.policy)).toBeGreaterThan(matcherSpecificity(policies[0]!));
  });

  it('explicit action policy beats all matchers', () => {
    const resolution = resolvePolicy({
      intent: intent({ policy_name: 'broad', risk_level: null }),
      policies,
      defaults,
      riskDefaults: null,
    });
    expect(resolution.policy.name).toBe('broad');
    expect(resolution.resolution).toBe('explicit');
  });

  it('falls back to the synthetic global default when nothing matches', () => {
    const resolution = resolvePolicy({
      intent: intent({ tool: 'unknown-tool', operation: 'other', risk_level: null }),
      policies,
      defaults,
      riskDefaults: null,
    });
    expect(resolution.policy.name).toBe('global-default');
  });

  it('risk derives from intent > policy > risk-defaults (spec §9)', () => {
    const riskDefaults = { rules: [{ match: 'deploy*', risk: 'CRITICAL' as RiskLevel }], default: 'MEDIUM' as RiskLevel };
    expect(deriveRisk(intent({ risk_level: 'LOW' }), riskDefaults).risk).toBe('LOW');
    expect(deriveRisk(intent({ risk_level: null }), riskDefaults).source).toBe('risk_defaults');
    expect(deriveRisk(intent({ operation: 'deploy_x', risk_level: null }), riskDefaults)).toEqual({ risk: 'CRITICAL', source: 'risk_defaults' });
    expect(deriveRisk(intent({ operation: 'poke', risk_level: null }), riskDefaults).risk).toBe('MEDIUM');
  });
});

describe('defaults plumbing', () => {
  it('global defaults provide on_* fallbacks (spec §33)', () => {
    const d = defaultsWith({ on_unknown: 'deny', stale: 'revalidate' });
    expect(d.outcomes.unknown).toBe('deny');
    expect(d.outcomes.stale).toBe('revalidate');
    expect(d.outcomes.fresh).toBe('allow');
  });

  it('default freshness is a sane conservative TTL', () => {
    const { freshness } = buildDefaultFreshness(undefined, undefined);
    expect(freshness.strategy).toBe('ttl');
    expect(freshness.maxAgeMs).toBe(30_000);
    expect(freshness.agingThreshold).toBeCloseTo(0.75);
  });
});
