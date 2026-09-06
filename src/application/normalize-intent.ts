/**
 * Intent normalization: converts untrusted agent input into a well-formed
 * ActionIntent with server-assigned identifiers and timestamps.
 *
 * The agent's OWN observation metadata (versions, observed_at) is recorded
 * as claimed observations — it is later verified against fresh provider
 * state, never trusted (invariant 5).
 */

import type { ActionIntent, ActionIntentInput, Precondition } from '../domain/action.js';
import { PRECONDITION_OPERATORS } from '../domain/action.js';
import { normalizeDependency } from '../domain/state.js';
import { newId, ID_PREFIXES } from '../domain/identifiers.js';
import { ConfigurationError } from '../domain/errors.js';

/** Maximum depth accepted inside a precondition value before it is rejected. */
const MAX_PRECONDITION_VALUE_DEPTH = 32;

function assertValidPrecondition(precondition: Precondition, index: number): void {
  const where = `preconditions[${index}]`;
  if (precondition === null || typeof precondition !== 'object' || Array.isArray(precondition)) {
    throw new ConfigurationError(`${where} must be an object`);
  }
  if (typeof precondition.field !== 'string' || precondition.field.length === 0) {
    throw new ConfigurationError(`${where}.field is required and must be a non-empty string`);
  }
  if (
    precondition.dependency !== undefined &&
    (typeof precondition.dependency !== 'string' || precondition.dependency.length === 0)
  ) {
    throw new ConfigurationError(`${where}.dependency must be a non-empty string glob`);
  }
  if (typeof precondition.operator !== 'string' || !PRECONDITION_OPERATORS.includes(precondition.operator)) {
    throw new ConfigurationError(
      `${where}.operator must be one of ${PRECONDITION_OPERATORS.join('|')}`,
    );
  }
  if (precondition.operator === 'exists' || precondition.operator === 'not_exists') {
    if ('value' in precondition && precondition.value !== undefined) {
      throw new ConfigurationError(`${where}.value: operator "${precondition.operator}" takes no value`);
    }
    return;
  }
  if (!('value' in precondition)) {
    throw new ConfigurationError(`${where}.value is required for operator "${precondition.operator}"`);
  }
  const value = precondition.value;
  if (precondition.operator === 'greater_than' || precondition.operator === 'less_than') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ConfigurationError(`${where}.value: operator "${precondition.operator}" requires a finite number`);
    }
  }
  if (precondition.operator === 'matches') {
    if (typeof value !== 'string') {
      throw new ConfigurationError(`${where}.value: operator "matches" requires a string regex pattern`);
    }
    try {
      // Compilation is validated here so malformed patterns fail fast at the
      // intent boundary instead of crashing inside the decision pipeline.
      // Note: ReDoS-resistant matching remains the caller's responsibility;
      // patterns from untrusted agents should be reviewed at the tool boundary.
      new RegExp(value, 's');
    } catch (error) {
      throw new ConfigurationError(
        `${where}.value: invalid regex: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (precondition.operator === 'in' || precondition.operator === 'not_in') {
    if (!Array.isArray(value)) {
      throw new ConfigurationError(`${where}.value: operator "${precondition.operator}" requires an array`);
    }
  }
  assertDepthBelowLimit(value, where, 0);
}

function assertDepthBelowLimit(value: unknown, where: string, depth: number): void {
  if (depth > MAX_PRECONDITION_VALUE_DEPTH) {
    throw new ConfigurationError(
      `${where}.value exceeds the maximum nesting depth of ${MAX_PRECONDITION_VALUE_DEPTH}`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertDepthBelowLimit(item, where, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertDepthBelowLimit(item, where, depth + 1);
    }
  }
}

export function normalizeIntent(input: ActionIntentInput, nowMs: number): ActionIntent {
  const requireNonEmpty = (value: string | undefined, field: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ConfigurationError(`${field} is required and must be a non-empty string`);
    }
    return value.trim();
  };

  if (input.dependencies !== undefined && !Array.isArray(input.dependencies)) {
    throw new ConfigurationError('dependencies must be an array');
  }
  if (input.preconditions !== undefined && !Array.isArray(input.preconditions)) {
    throw new ConfigurationError('preconditions must be an array');
  }
  if (input.execution_deadline_ms !== undefined && (!Number.isFinite(input.execution_deadline_ms) || input.execution_deadline_ms <= 0)) {
    throw new ConfigurationError('execution_deadline_ms must be a positive number');
  }
  for (const dep of input.dependencies ?? []) {
    if (dep.observed_at !== undefined && dep.observed_at !== null && Number.isNaN(Date.parse(dep.observed_at))) {
      throw new ConfigurationError(`dependency ${dep.source}:${dep.resource}/${dep.resource_id} has an unparseable observed_at`);
    }
  }
  (input.preconditions ?? []).forEach((precondition, index) => assertValidPrecondition(precondition, index));

  return {
    action_id: newId(ID_PREFIXES.action, nowMs),
    agent_id: requireNonEmpty(input.agent_id, 'agent_id'),
    tool: requireNonEmpty(input.tool ?? '', 'tool'),
    operation: requireNonEmpty(input.operation, 'operation'),
    target: input.target ?? null,
    arguments: input.arguments ?? {},
    dependencies: (input.dependencies ?? []).map(normalizeDependency),
    preconditions: input.preconditions ?? [],
    risk_level: input.risk_level ?? null,
    policy_name: input.policy ?? null,
    created_at: new Date(nowMs).toISOString(),
    execution_deadline_ms: input.execution_deadline_ms ?? 0,
    idempotency_key: input.idempotency_key ?? null,
  };
}
