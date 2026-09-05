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
  /** Tool boundary the action targets; ProtectedTool fills this from the tool name. */
  tool?: string;
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
  /** Null until the resolver assigns it: intent > policy > risk-defaults. */
  risk_level: RiskLevel | null;
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
 * The authorized state identity the firewall hands to a conditional
 * executor: one entry per dependency validated at authorization time.
 * The executor MUST forward these to the external system (ETag / expected
 * SHA / compare-and-swap) rather than re-reading the current state itself.
 */
export interface ExpectedStateEntry {
  /** Reference key "<source>:<resource>/<resource_id>". */
  ref: string;
  /** The provider's authoritative version signal at authorization time. */
  version: string | null;
  /** Content hash captured at authorization time. */
  content_hash: string | null;
}

/**
 * Outcome of a conditional execution attempt (milestone: atomic effect
 * assurance).
 *
 * - 'satisfied': the external system enforced the condition, the condition
 *   held, and the operation was applied. `success` reports whether the
 *   operation itself completed without application-level error.
 * - 'failed': the external system REJECTED the operation because its
 *   authoritative state no longer matches the authorized expected state.
 *   No side effect occurred. This is NOT an internal error and MUST NOT be
 *   retried under the same authorization.
 * - 'unavailable': the executor could not enforce the expected state for
 *   every resource its effect touches, so it refused to act. No side effect
 *   occurred.
 */
export type ConditionalExecutionResult =
  | { condition: 'satisfied'; success: boolean; output?: unknown; error?: string }
  | { condition: 'failed'; observed_version: string | null; error?: string }
  | { condition: 'unavailable'; error?: string };

/**
 * The executor performs the actual side effect AFTER an ALLOW decision.
 * Executors declare their retry safety and (honestly) whether the
 * underlying operation is atomic with the preceding validation. The default
 * assumption is non-idempotent and NOT atomic — the conservative choice.
 *
 * Conditional execution capability (optional): an executor that forwards the
 * firewall-authorized expected state to the external system so that the
 * EXTERNAL SYSTEM itself refuses the operation when its authoritative state
 * no longer matches. A fresh read immediately before the mutation is NOT
 * conditional execution. If the executor cannot enforce the expected state
 * for every resource its effect touches, it MUST return 'unavailable'
 * without performing the side effect.
 */
export interface ActionExecutor {
  readonly idempotency: IdempotencyKind;
  /** Whether the provider enforces compare-and-swap semantics end to end. */
  readonly atomicity?: 'guaranteed' | 'not_guaranteed';
  execute(intent: ActionIntent): Promise<{ success: boolean; output?: unknown; error?: string }>;
  /** Declares that conditionalExecute genuinely enforces the expected state at the external system. */
  conditionalExecutionSupported?(): boolean;
  /**
   * Executes the action conditioned on the authorized expected state. Only
   * called by the firewall after an ALLOW decision and an atomic claim of
   * the authorization.
   */
  conditionalExecute?(
    intent: ActionIntent,
    expectedState: readonly ExpectedStateEntry[],
  ): Promise<ConditionalExecutionResult>;
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
  /**
   * Conditional-execution outcome for this attempt (milestone: atomic effect
   * assurance). 'not_attempted' when the legacy pre-execution re-check path
   * was used (best-effort verification, no provider-enforced condition).
   */
  conditional_execution?: 'satisfied' | 'failed' | 'unavailable' | 'not_attempted';
  /** The authorized expected state handed to the conditional executor. */
  expected_state?: Array<{ ref: string; version: string | null }>;
  /** The version the external system reported at conditional-execution time. */
  observed_version?: string | null;
}
