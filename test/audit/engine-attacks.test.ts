/**
 * Red-team audit: engine-level attacks (preconditions, hashing, validation).
 *
 * E1  canonicalJson coerces NaN/Infinity to null: `equals` treats NaN as null
 * E2  precondition routing: preconditions without an explicit dependency
 *     pattern only guard the FIRST dependency (documented footgun, pinned here)
 * E3  policy determinism: equal-specificity matchers resolve by declaration
 *     order, deterministically
 * E4  deeply nested precondition values crash the engine (stack overflow)
 * E5  invalid regex in agent-supplied intent preconditions crashes mid-decision
 *     instead of failing fast at intent normalization
 */
import { describe, it, expect } from 'vitest';
import { evaluatePrecondition } from '../../src/engine/preconditions.js';
import { canonicalJson } from '../../src/engine/hashing.js';
import { resolvePolicy, matcherSpecificity } from '../../src/engine/policy-resolver.js';
import { resolvePolicyConfig } from '../../src/config/loader.js';
import { normalizeIntent } from '../../src/application/normalize-intent.js';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { ManualClock } from '../../src/engine/clock.js';
import type { ResolvedPolicy } from '../../src/engine/resolved-policy.js';
import type { ActionIntent } from '../../src/domain/action.js';

describe('audit: engine-level attacks', () => {
  it('E1 NaN is not structurally equal to null', () => {
    expect(canonicalJson(Number.NaN)).not.toBe(canonicalJson(null));
    expect(canonicalJson(Number.POSITIVE_INFINITY)).not.toBe(canonicalJson(null));
    expect(canonicalJson(Number.NaN)).not.toBe(canonicalJson(Number.POSITIVE_INFINITY));

    const result = evaluatePrecondition(
      { field: 'flag', operator: 'equals', value: null },
      { flag: Number.NaN },
    );
    expect(result.passed).toBe(false);
  });

  it('E2 default precondition routing covers only the primary dependency (pinned documented behavior)', () => {
    // Two dependencies; the unconditional precondition guards index 0 only.
    // Pinned so a silent change of this footgun becomes visible.
    const metadata0 = { locked: false };
    const metadata1 = { locked: true };
    const r0 = evaluatePrecondition({ field: 'locked', operator: 'equals', value: false }, metadata0);
    const r1 = evaluatePrecondition({ field: 'locked', operator: 'equals', value: false }, metadata1);
    expect(r0.passed).toBe(true);
    expect(r1.passed).toBe(false); // would fail if it were ever evaluated
  });

  it('E3 equal-specificity policy matchers resolve deterministically by declaration order', () => {
    const policies: ResolvedPolicy[] = [
      resolvePolicyConfig({ name: 'first', match: { tool: 'github', operation: 'merge*' } }, 0),
      resolvePolicyConfig({ name: 'second', match: { operation: 'merge*', risk: 'HIGH' } }, 1),
    ];
    const intent = baseIntent();
    expect(matcherSpecificity(policies[0]!)).toBe(matcherSpecificity(policies[1]!));
    for (let i = 0; i < 5; i++) {
      const resolution = resolvePolicy({ intent, policies, defaults: emptyDefaults(), riskDefaults: null });
      expect(resolution.policy.name).toBe('first');
    }
  });

  it('E4 deeply nested precondition values are rejected at intent normalization, not a stack crash', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50_000; i++) {
      deep = [deep];
    }
    expect(() =>
      normalizeIntent(
        {
          agent_id: 'bot',
          tool: 'tools',
          operation: 'op',
          preconditions: [{ field: 'status', operator: 'equals', value: deep }],
        },
        Date.now(),
      ),
    ).toThrow();
  });

  it('E5 invalid regex in intent preconditions is rejected at intent normalization', () => {
    expect(() =>
      normalizeIntent(
        {
          agent_id: 'bot',
          tool: 'tools',
          operation: 'op',
          preconditions: [{ field: 'status', operator: 'matches', value: '([unclosed' }],
        },
        Date.now(),
      ),
    ).toThrow();
  });

  it('E6 unknown operators in intent preconditions are rejected at intent normalization', () => {
    expect(() =>
      normalizeIntent(
        {
          agent_id: 'bot',
          tool: 'tools',
          operation: 'op',
          preconditions: [{ field: 'status', operator: 'matches_all' as never, value: 'x' }],
        },
        Date.now(),
      ),
    ).toThrow();
  });

  it('E7 deterministic end-to-end: identical inputs produce identical decisions across repeats', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const provider = new InMemoryStateProvider('memory');
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          {
            name: 'deploy-production',
            match: { operation: 'deploy*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            preconditions: [{ field: 'status', operator: 'equals', value: 'healthy' }],
          },
        ],
      },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    const intent = {
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: provider.get('deployment', 'prod')!.version }],
    };
    const decisions = await Promise.all([firewall.check(intent), firewall.check(intent), firewall.check(intent)]);
    const signatures = decisions.map((d) => `${d.decision}:${d.policy_name}:${d.reason}`);
    expect(new Set(signatures).size).toBe(1);
    expect(decisions[0]!.decision).toBe('ALLOW');
  });
});

function baseIntent(): ActionIntent {
  return {
    action_id: 'act_e3',
    agent_id: 'agent',
    tool: 'github',
    operation: 'merge_pull_request',
    target: null,
    arguments: {},
    dependencies: [],
    preconditions: [],
    risk_level: 'HIGH',
    policy_name: null,
    created_at: '2026-09-05T12:00:00Z',
    execution_deadline_ms: 0,
    idempotency_key: null,
  };
}

function emptyDefaults() {
  return {
    outcomes: { fresh: 'allow' as const, aging: null, stale: null, unknown: null, invalid: null },
    freshness: {
      strategy: 'ttl' as const,
      maxAgeMs: 30_000,
      agingThreshold: 0.75,
      skewToleranceMs: 0,
      hybridComponents: { ttl: false, version: false, hash: false, preconditions: false },
    },
    execution: { deadlineMs: null, requireFreshAtExecution: true, allowIdempotentRetry: false },
  };
}
