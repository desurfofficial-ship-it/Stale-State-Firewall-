/**
 * Red-team audit: property-based security testing (fast-check).
 *
 * P1  full risk x staleness decision matrix: no unsafe ALLOW may appear for
 *     any (risk, staleness) combination under default outcomes
 * P2  for any declared version, a differing current version can never be
 *     classified FRESH (invariant C)
 * P3  determinism: identical policy + action + state produce identical
 *     decisions for randomized combinations (invariant I)
 * P4  any failed precondition on FRESH state can never yield ALLOW
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decide } from '../../src/engine/decision-engine.js';
import { evaluateFreshness } from '../../src/engine/freshness.js';
import { resolvePolicyConfig, resolveGlobalDefaults } from '../../src/config/loader.js';
import type { ActionIntent, RiskLevel } from '../../src/domain/action.js';
import type { DependencyVerdict, FirewallMode, StalenessClass } from '../../src/domain/decision.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';

const riskLevels: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const stalenessClasses: StalenessClass[] = ['FRESH', 'AGING', 'STALE', 'UNKNOWN', 'INVALID'];
const modes: FirewallMode[] = ['OBSERVE', 'ENFORCE', 'STRICT'];

const policy = resolvePolicyConfig({ name: 'prop-audit', match: { operation: '*' } }, 0);
const configFile: FirewallRootConfigFile = {
  firewall: { mode: 'enforce' },
  defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
};
const defaults = resolveGlobalDefaults(configFile);

function intentOf(risk: RiskLevel): ActionIntent {
  return {
    action_id: 'act_prop_audit',
    agent_id: 'agent',
    tool: 'github',
    operation: 'merge_pull_request',
    target: null,
    arguments: {},
    dependencies: [],
    preconditions: [],
    risk_level: risk,
    policy_name: null,
    created_at: '2026-09-05T12:00:00Z',
    execution_deadline_ms: 0,
    idempotency_key: null,
  };
}

function verdictOf(staleness: StalenessClass, preconditionsPassed = true): DependencyVerdict {
  return {
    dependency: { source: 'memory', resource: 'r', resource_id: 'x' },
    staleness,
    reason: 'generated',
    verified_fresh: staleness !== 'UNKNOWN',
    observed_version: 'v1',
    current_version: staleness === 'INVALID' ? 'v2' : 'v1',
    observed_content_hash: null,
    current_content_hash: null,
    observed_at: null,
    current_observed_at: null,
    age_ms: null,
    max_age_ms: null,
    strategy: 'version',
    preconditions: preconditionsPassed
      ? []
      : [{ field: 'status', operator: 'equals' as const, expected: 'healthy', actual: 'degraded', passed: false, reason: 'failed' }],
  };
}

describe('audit: property-based security', () => {
  it('P1 for every risk x staleness x mode combination, INVALID never allows and CRITICAL+UNKNOWN never allows', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...riskLevels),
        fc.constantFrom(...stalenessClasses),
        fc.constantFrom(...modes),
        (risk, staleness, mode) => {
          const output = decide({
            intent: intentOf(risk),
            policy,
            defaults,
            verdicts: [verdictOf(staleness)],
            mode,
            revalidated: false,
          });
          if (staleness === 'INVALID') {
            expect(output.decision).not.toBe('ALLOW');
          }
          if (risk === 'CRITICAL' && staleness === 'UNKNOWN') {
            expect(output.decision).not.toBe('ALLOW');
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('P2 a changed authoritative version is never FRESH for any declared version pair', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s !== 'v2'),
        fc.constantFrom('ttl', 'version', 'hash', 'hybrid', 'preconditions'),
        (declaredVersion, strategy) => {
          const evaluation = evaluateFreshness({
            dependency: {
              source: 'memory', resource: 'r', resource_id: 'x',
              version: declaredVersion, content_hash: null,
              observed_at: '2026-09-05T11:00:00Z', metadata: {},
            },
            current: {
              snapshot_id: 'snap', source: 'memory', resource: 'r', resource_id: 'x',
              observed_at: '2026-09-05T12:00:00Z', version: 'v2', content_hash: null,
              metadata: {}, provenance: { provider: 'memory', retrieved_at: '2026-09-05T12:00:00Z', time_source: 'client', validation_method: 'full_fetch' },
            },
            freshness: { strategy: strategy as 'ttl', maxAgeMs: 60_000, agingThreshold: 0.75, skewToleranceMs: 0, hybridComponents: { ttl: true, version: true, hash: false, preconditions: false } },
            preconditions: [],
            nowMs: Date.parse('2026-09-05T12:00:00Z'),
          });
          expect(evaluation.staleness).toBe('INVALID');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('P3 identical inputs produce identical decisions across randomized combinations', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...riskLevels),
        fc.array(fc.constantFrom(...stalenessClasses), { minLength: 0, maxLength: 4 }),
        fc.constantFrom(...modes),
        (risk, classes, mode) => {
          const verdicts = classes.map((c) => verdictOf(c));
          const run = () =>
            decide({
              intent: intentOf(risk),
              policy,
              defaults,
              verdicts,
              mode,
              revalidated: false,
            });
          const first = run();
          const second = run();
          expect(second.decision).toBe(first.decision);
          expect(second.reason).toBe(first.reason);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('P4 a failed precondition on FRESH state never yields ALLOW for any risk level', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...riskLevels),
        fc.constantFrom(...modes),
        (risk, mode) => {
          const output = decide({
            intent: intentOf(risk),
            policy,
            defaults,
            verdicts: [verdictOf('FRESH', false)],
            mode,
            revalidated: false,
          });
          expect(output.decision).not.toBe('ALLOW');
        },
      ),
      { numRuns: 100 },
    );
  });
});
