/**
 * Action domain model (spec §5, §9, §40).
 *
 * Every consequential agent action is represented as an ActionIntent. The
 * intent carries the state the agent relied on (dependencies), the invariants
 * that must hold (preconditions), and the risk of being wrong.
 */

import type { StateDependency, StateDependencyInput } from './state.js';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const RISK_SEVERITY: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_SEVERITY[a] >= RISK_SEVERITY[b] ? a : b;
}

export const PRECONDITION_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
  'greater_than',
  'less_than',
  'in',
  'not_in',
  'matches',
] as const;

export type PreconditionOperator = (typeof PRECONDITION_OPERATORS)[number];

/**
 * Preconditions are evaluated by the firewall against CURRENT fresh state
 * (spec §11) — never against the agent's claimed observation alone.
 * `field` is a dot-path into the dependency snapshot metadata
 * (e.g. "deployment.status").
 *
 * `dependency` optionally routes the precondition to a specific declared
 * dependency via glob match on "<source>:<resource>/<resource_id>"; when
 * omitted it is evaluated against the first (primary) dependency.
 */
export interface Precondition {
  field: string;
  operator: PreconditionOperator;
  value?: unknown;
  dependency?: string;
}

export interface ActionIntentInput {
  /** Stable identifier of the acting agent. */
  agent_id: string;
  /** Tool boundary the action targets, e.g. "github". */
  tool: string;
  /** Operation name, e.g. "merge_pull_request". */
  operation: string;
  /** Human-readable target, e.g. "org/repo#42". */
  target?: string;
  /** Tool arguments (will be redacted before persistence/logging). */
  arguments?: Record<string, unknown>;
  /** State the agent relied on. */
  dependencies?: StateDependencyInput[];
  /** Invariants the firewall must verify against fresh state. */
  preconditions?: Precondition[];
  /** Explicit risk; otherwise derived from policy or risk defaults. */
  risk_level?: RiskLevel;
  /** Explicit policy name; bypasses matcher-based resolution. */
  policy?: string;
  /** How long an ALLOW from this intent stays executable, in ms. */
  execution_deadline_ms?: number;
  /** Caller-supplied idempotency key for safe retry classification. */
  idempotency_key?: string;
}

export interface ActionIntent {
  action_id: string;
  agent_id: string;
  tool: string;
  operation: string;
  target: string | null;
  arguments: Record<string, unknown>;
  dependencies: StateDependency[];
  preconditions: Precondition[];
  risk_level: RiskLevel;
  policy_name: string | null;
  created_at: string;
  execution_deadline_ms: number;
  idempotency_key: string | null;
}

/**
 * Classification of an executor's retry safety (spec §25).
 */
export type IdempotencyKind = 'idempotent' | 'non_idempotent';

/**
 * The executor performs the actual side effect AFTER an ALLOW decision.
 * Executors declare their retry safety and (honestly) whether the
 * underlying operation is atomic with the preceding validation. The default
 * assumption is non-idempotent and NOT atomic — the conservative choice.
 */
export interface ActionExecutor {
  readonly idempotency: IdempotencyKind;
  /** Whether the provider enforces compare-and-swap semantics end to end. */
  readonly atomicity?: 'guaranteed' | 'not_guaranteed';
  execute(intent: ActionIntent): Promise<{ success: boolean; output?: unknown; error?: string }>;
}

export interface ExecutionResult {
  execution_id: string;
  action_id: string;
  /** Whether the executor completed successfully. */
  success: boolean;
  /** Executor-declared retry safety for this operation. */
  idempotency: IdempotencyKind;
  /** Arbitrary executor output (redacted before persistence). */
  output?: unknown;
  error?: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  /**
   * Explicit statement of whether the underlying execution is atomic with the
   * preceding validation. Providers without compare-and-swap semantics are
   * NOT atomic; the limitation is recorded here (spec §13, §45, §72).
   */
  atomicity: 'guaranteed' | 'not_guaranteed';
}
