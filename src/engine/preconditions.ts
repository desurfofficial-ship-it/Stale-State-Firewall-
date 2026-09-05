/**
 * Precondition system (spec §11).
 *
 * Preconditions are evaluated by the firewall against CURRENT fresh state —
 * never against the agent's claimed observation alone. Field paths resolve
 * into snapshot metadata via dot notation ("deployment.status", arrays by
 * numeric segment "checks.0.state").
 *
 * Operator semantics are strict:
 * - equals/not_equals use canonical structural equality, no type coercion
 * - greater_than/less_than require numbers; anything else fails (fail closed)
 * - matches requires a string subject and a valid regex
 * - exists/not_exists test path presence; JSON null counts as existing
 *
 * A failed precondition means the required invariant does not hold against
 * current state => the dependency is INVALID (spec §8).
 */

import type { Precondition } from '../domain/action.js';
import { PreconditionFailedError } from '../domain/errors.js';
import type { PreconditionResult } from '../domain/decision.js';
import { canonicalJson } from './hashing.js';

export function resolvePath(metadata: Record<string, unknown>, path: string): { found: boolean; value: unknown } {
  const segments = path.split('.');
  let current: unknown = metadata;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') {
      return { found: false, value: undefined };
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return { found: false, value: undefined };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function evaluatePrecondition(
  precondition: Precondition,
  metadata: Record<string, unknown>,
): PreconditionResult {
  const { found, value } = resolvePath(metadata, precondition.field);
  const base: Pick<PreconditionResult, 'field' | 'operator'> = {
    field: precondition.field,
    operator: precondition.operator,
  };

  switch (precondition.operator) {
    case 'exists': {
      const passed = found;
      return { ...base, expected: 'path exists', actual: found ? 'present' : 'absent', passed, reason: passed ? `field "${precondition.field}" exists` : `field "${precondition.field}" does not exist` };
    }
    case 'not_exists': {
      const passed = !found;
      return { ...base, expected: 'path absent', actual: found ? 'present' : 'absent', passed, reason: passed ? `field "${precondition.field}" does not exist` : `field "${precondition.field}" exists` };
    }
    default:
      break;
  }

  if (!found) {
    return {
      ...base,
      expected: precondition.value,
      passed: false,
      reason: `field "${precondition.field}" is absent from current state`,
    };
  }

  switch (precondition.operator) {
    case 'equals': {
      const passed = structurallyEqual(value, precondition.value);
      return { ...base, expected: precondition.value, actual: value, passed, reason: passed ? 'values equal' : `expected ${canonicalJson(precondition.value)}, found ${canonicalJson(value)}` };
    }
    case 'not_equals': {
      const passed = !structurallyEqual(value, precondition.value);
      return { ...base, expected: `!= ${canonicalJson(precondition.value)}`, actual: value, passed, reason: passed ? 'values differ as required' : `value equals the forbidden ${canonicalJson(precondition.value)}` };
    }
    case 'contains': {
      const expected = precondition.value;
      let passed = false;
      if (typeof value === 'string' && typeof expected === 'string') {
        passed = value.includes(expected);
      } else if (Array.isArray(value)) {
        passed = value.some((item) => structurallyEqual(item, expected));
      }
      return { ...base, expected, actual: value, passed, reason: passed ? 'subject contains expected element' : 'subject does not contain expected element' };
    }
    case 'not_contains': {
      const expected = precondition.value;
      let contains = false;
      if (typeof value === 'string' && typeof expected === 'string') {
        contains = value.includes(expected);
      } else if (Array.isArray(value)) {
        contains = value.some((item) => structurallyEqual(item, expected));
      }
      const passed = !contains;
      return { ...base, expected, actual: value, passed, reason: passed ? 'subject excludes forbidden element' : 'subject contains forbidden element' };
    }
    case 'greater_than':
    case 'less_than': {
      const expected = precondition.value;
      if (typeof value !== 'number' || typeof expected !== 'number') {
        return {
          ...base,
          expected,
          actual: value,
          passed: false,
          reason: `operator "${precondition.operator}" requires numeric values (got ${typeof value} vs ${typeof expected}); failing closed`,
        };
      }
      const passed = precondition.operator === 'greater_than' ? value > expected : value < expected;
      return { ...base, expected, actual: value, passed, reason: passed ? `${value} ${precondition.operator === 'greater_than' ? '>' : '<'} ${expected}` : `${value} not ${precondition.operator === 'greater_than' ? '>' : '<'} ${expected}` };
    }
    case 'in': {
      const expected = precondition.value;
      const passed = Array.isArray(expected) && expected.some((item) => structurallyEqual(item, value));
      return { ...base, expected, actual: value, passed, reason: passed ? 'value is in the allowed set' : 'value is not in the allowed set' };
    }
    case 'not_in': {
      const expected = precondition.value;
      const inSet = Array.isArray(expected) && expected.some((item) => structurallyEqual(item, value));
      const passed = !inSet;
      return { ...base, expected, actual: value, passed, reason: passed ? 'value is not in the forbidden set' : 'value is in the forbidden set' };
    }
    case 'matches': {
      const pattern = precondition.value;
      if (typeof pattern !== 'string' || typeof value !== 'string') {
        return {
          ...base,
          expected: pattern,
          actual: value,
          passed: false,
          reason: 'operator "matches" requires a string pattern and a string subject; failing closed',
        };
      }
      const passed = new RegExp(pattern, 's').test(value);
      return { ...base, expected: pattern, actual: value, passed, reason: passed ? `subject matches /${pattern}/` : `subject does not match /${pattern}/` };
    }
    default: {
      // Exhaustiveness guard: an unknown operator reaching runtime is a bug.
      throw new PreconditionFailedError(precondition.field, String((precondition as Precondition).operator), {
        reason: 'unknown operator',
      });
    }
  }
}

export function evaluatePreconditions(
  preconditions: readonly Precondition[],
  metadata: Record<string, unknown>,
): PreconditionResult[] {
  return preconditions.map((p) => evaluatePrecondition(p, metadata));
}

export function allPreconditionsPassed(results: readonly PreconditionResult[]): boolean {
  return results.every((r) => r.passed);
}
