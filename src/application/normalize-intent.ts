/**
 * Intent normalization: converts untrusted agent input into a well-formed
 * ActionIntent with server-assigned identifiers and timestamps.
 *
 * The agent's OWN observation metadata (versions, observed_at) is recorded
 * as claimed observations — it is later verified against fresh provider
 * state, never trusted (invariant 5).
 */

import type { ActionIntent, ActionIntentInput } from '../domain/action.js';
import { normalizeDependency } from '../domain/state.js';
import { newId, ID_PREFIXES } from '../domain/identifiers.js';
import { ConfigurationError } from '../domain/errors.js';

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
