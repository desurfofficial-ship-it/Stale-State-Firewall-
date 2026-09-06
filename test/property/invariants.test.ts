import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decide } from '../../src/engine/decision-engine.js';
import { classifyByAge, worstOfAll, STALENESS_SEVERITY } from '../../src/engine/staleness.js';
import { evaluatePrecondition } from '../../src/engine/preconditions.js';
import { parseDurationMs } from '../../src/engine/duration.js';
import { globMatch } from '../../src/engine/glob.js';
import { canonicalJson } from '../../src/engine/hashing.js';
import { resolveFreshness } from '../../src/engine/resolved-policy.js';
import type { ActionIntent, RiskLevel } from '../../src/domain/action.js';
import type { DependencyVerdict, FirewallMode } from '../../src/domain/decision.js';
import { resolvePolicyConfig } from '../../src/config/loader.js';
import { ManualClock } from '../../src/engine/clock.js';

/**
 * Property-based tests (spec §46): invariants that must hold for EVERY
 * input, not just curated examples.
 */

const riskLevels: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const stalenessClasses = ['FRESH', 'AGING', 'STALE', 'INVALID', 'UNKNOWN'] as const;
const modes: FirewallMode[] = ['OBSERVE', 'ENFORCE', 'STRICT'];

function intent(risk: RiskLevel | null, operation = 'merge_pull_request'): ActionIntent {
  return {
    action_id: 'act_prop',
    agent_id: 'agent',
    tool: 'github',
    operation,
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

function verdictOf(staleness: (typeof stalenessClasses)[number]): DependencyVerdict {
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
    strategy: 'ttl',
    preconditions: [],
  };
}

const defaultPolicy = resolvePolicyConfig({ name: 'prop', match: { operation: '*' } }, 0);
const defaults = {
  outcomes: { fresh: 'allow' as const, aging: null, stale: null, unknown: null, invalid: null },
  freshness: resolveFreshness({ strategy: 'ttl', max_age: '30s' }, undefined, undefined, 'prop'),
  execution: { deadlineMs: null, requireFreshAtExecution: true, allowIdempotentRetry: false },
};

describe('property: safety floor holds for every combination (spec §46)', () => {
  it('a CRITICAL action is never ALLOWED when any dependency is INVALID', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...stalenessClasses), { minLength: 1, maxLength: 6 }),
        fc.constantFrom(...modes),
        (classes, mode) => {
          const output = decide({
            intent: intent('CRITICAL'),
            policy: defaultPolicy,
            defaults,
            verdicts: classes.map(verdictOf),
            mode,
            revalidated: false,
          });
          if (classes.includes('INVALID')) {
            expect(output.decision).not.toBe('ALLOW');
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('UNKNOWN state can never become ALLOW by accident, at any risk, under enforcement', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...riskLevels),
        fc.constantFrom(...modes),
        (risk, mode) => {
          const output = decide({
            intent: intent(risk),
            policy: defaultPolicy,
            defaults,
            verdicts: [verdictOf('UNKNOWN')],
            mode,
            revalidated: false,
          });
          // The engine never returns ALLOW on UNKNOWN; under OBSERVE the
          // application layer additionally records the would-be decision.
          expect(output.decision).not.toBe('ALLOW');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('decision evaluation is deterministic: same inputs -> same decision (invariant 4)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...stalenessClasses), { minLength: 0, maxLength: 5 }),
        fc.constantFrom(...riskLevels),
        fc.constantFrom(...modes),
        (classes, risk, mode) => {
          const input = {
            intent: intent(risk),
            policy: defaultPolicy,
            defaults,
            verdicts: classes.map(verdictOf),
            mode,
            revalidated: false,
          };
          const a = decide(input);
          const b = decide(structuredClone(input));
          expect(a).toEqual(b);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('adding a worse dependency verdict never upgrades the decision toward ALLOW', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...stalenessClasses), { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...stalenessClasses),
        fc.constantFrom(...riskLevels),
        (classes, extra, risk) => {
          const base = decide({
            intent: intent(risk),
            policy: defaultPolicy,
            defaults,
            verdicts: classes.map(verdictOf),
            mode: 'ENFORCE',
            revalidated: false,
          });
          const withExtra = decide({
            intent: intent(risk),
            policy: defaultPolicy,
            defaults,
            verdicts: [...classes.map(verdictOf), verdictOf(extra)],
            mode: 'ENFORCE',
            revalidated: false,
          });
          const outcomeRank = (d: string): number => (d === 'ALLOW' ? 0 : d === 'REVALIDATE' || d === 'ESCALATE' ? 1 : 2);
          if (STALENESS_SEVERITY[extra] >= STALENESS_SEVERITY.STALE) {
            expect(outcomeRank(withExtra.decision)).toBeGreaterThanOrEqual(outcomeRank(base.decision));
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('property: staleness classification is monotonic in age (spec §8)', () => {
  it('older is never fresher', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3_600_000 }),
        fc.integer({ min: 1, max: 600_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (age, maxAge, permille) => {
          const threshold = permille / 1000;
          const a = classifyByAge(age, maxAge, threshold);
          const older = classifyByAge(age + 1, maxAge, threshold);
          expect(STALENESS_SEVERITY[older]).toBeGreaterThanOrEqual(STALENESS_SEVERITY[a]);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('aggregation picks the worst class regardless of order', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...stalenessClasses], { minLength: 1, maxLength: 5 }),
        (classes) => {
          const result = worstOfAll(classes);
          const worst = classes.reduce((acc, c) => (STALENESS_SEVERITY[c] > STALENESS_SEVERITY[acc] ? c : acc), 'FRESH' as (typeof stalenessClasses)[number]);
          expect(result).toBe(worst);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property: changing a required dependency version invalidates authorization (spec §46)', () => {
  it('for any observed->current version drift, the verdict is INVALID', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !s.includes('\u0000')),
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !s.includes('\u0000')),
        (observed, current) => {
          fc.pre(observed !== current);
          const clock = new ManualClock('2026-09-05T12:00:00Z');
          const { evaluateFreshness } = require_freshness();
          const result = evaluateFreshness({
            dependency: {
              source: 'memory', resource: 'r', resource_id: 'x',
              version: observed, content_hash: null,
              observed_at: clock.nowIso(), metadata: {},
            },
            current: {
              snapshot_id: 's', source: 'memory', resource: 'r', resource_id: 'x',
              observed_at: clock.nowIso(), version: current, content_hash: null,
              metadata: {},
              provenance: { provider: 'memory', retrieved_at: clock.nowIso(), time_source: 'client', validation_method: 'full_fetch' },
            },
            freshness: resolveFreshness({ strategy: 'ttl', max_age: '30s' }, undefined, undefined, 'p'),
            preconditions: [],
            nowMs: clock.nowMs(),
          });
          expect(result.staleness).toBe('INVALID');
        },
      ),
      { numRuns: 300 },
    );
  });

  function require_freshness() {
    // Local import to keep the property block self-contained.
    return { evaluateFreshness: evaluateFreshnessImpl };
  }

  function evaluateFreshnessImpl(...args: Parameters<typeof freshnessFn>) {
    return freshnessFn(...args);
  }
});

describe('property: preconditions are deterministic and type-strict', () => {
  it('numeric operators never pass on non-numeric subjects', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.constant(null), fc.constant(true), fc.constant([1, 2])),
        fc.integer(),
        (subject, bound) => {
          for (const op of ['greater_than', 'less_than'] as const) {
            const result = evaluatePrecondition({ field: 'x', operator: op, value: bound }, { x: subject });
            expect(result.passed).toBe(false);
            expect(result.reason).toContain('numeric');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('equals is structural: canonical JSON equality, order-insensitive', () => {
    fc.assert(
      fc.property(
        fc.record({ a: fc.integer(), b: fc.string() }),
        (value) => {
          const shuffled = { b: value['b'], a: value['a'] };
          expect(canonicalJson(value)).toBe(canonicalJson(shuffled));
          const r1 = evaluatePrecondition({ field: 'x', operator: 'equals', value: shuffled }, { x: value });
          expect(r1.passed).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: durations and globs', () => {
  it('duration parsing is monotonic in the numeric value', () => {
    fc.assert(
      fc.property(fc.nat(100_000), (n) => {
        expect(parseDurationMs(n)).toBeGreaterThanOrEqual(0);
        expect(parseDurationMs(`${n}ms`)).toBe(n);
      }),
      { numRuns: 300 },
    );
  });

  it('globMatch(prefix*, value) implies value.startsWith(prefix)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 6 }).filter((s) => !/[*?]/.test(s)),
        fc.string({ maxLength: 10 }),
        (prefix, rest) => {
          const value = `${prefix}${rest}`;
          expect(globMatch(`${prefix}*`, value)).toBe(value.startsWith(prefix));
        },
      ),
      { numRuns: 300 },
    );
  });
});

import { evaluateFreshness as freshnessFn } from '../../src/engine/freshness.js';
