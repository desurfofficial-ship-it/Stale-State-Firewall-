/**
 * Audit domain model (spec §21, §39, §40).
 *
 * Every protected action generates an audit record. Audit logs are append-only
 * and hash-chained: each record commits to the previous record's hash, so any
 * tampering is detectable via `ssf audit --verify` (invariant 6).
 */

import type { DecisionType, DependencyVerdict, FirewallMode, PreconditionResult } from './decision.js';
import type { RiskLevel } from './action.js';

export const AUDIT_EVENT_TYPES = [
  'action.proposed',
  'action.validated',
  'action.blocked',
  'action.revalidated',
  'action.executed',
  'action.failed',
  'action.replay_detected',
  'action.expired',
  'action.escalation_requested',
  'action.escalation_resolved',
  'execution.condition_failed',
  'policy.evaluated',
  'policy.violation',
  'state.observed',
  'state.changed',
  'state.unavailable',
  'provider.error',
  'provider.recovered',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/** Core audit record fields (spec §21). */
export interface AuditEventPayload {
  action_id?: string;
  agent_id?: string;
  tool?: string;
  operation?: string;
  target?: string | null;
  decision?: DecisionType;
  policy?: string;
  policy_version?: string;
  /** Reference keys of the action's declared dependencies. */
  dependencies?: string[];
  /** Per-dependency staleness summaries. */
  dependency_verdicts?: Array<{
    dependency: string;
    staleness: string;
    observed_version: string | null;
    current_version: string | null;
  }>;
  verdicts?: DependencyVerdict[];
  preconditions?: PreconditionResult[];
  reason?: string;
  execution_status?: 'executed' | 'failed' | 'blocked' | 'not_executed';
  latency_ms?: number;
  risk_level?: RiskLevel;
  mode?: FirewallMode;
  /** Conditional-execution outcome (milestone: atomic effect assurance). */
  conditional_execution?: 'satisfied' | 'failed' | 'unavailable' | 'not_attempted';
  /** The authorized expected state the conditional operation was bound to. */
  expected_state?: Array<{ ref: string; version: string | null }>;
  /** The version the external system reported when the condition was evaluated. */
  observed_version?: string | null;
  /** Provider that enforced (or refused) the conditional operation. */
  provider?: string;
  /**
   * The decision that authorized this conditional operation. Named
   * `decision_ref` (not authorization_id) deliberately: the redaction
   * control redacts every key containing "auth*", and a decision id is not
   * a secret — it must remain observable to reconstruct the lifecycle.
   * The authorization itself is identified by action_id.
   */
  decision_ref?: string;
  [key: string]: unknown;
}

/** Immutable, hash-chained audit record as stored. */
export interface AuditRecord {
  /** Monotonic sequence assigned by storage. */
  seq: number;
  event_id: string;
  event_type: AuditEventType;
  occurred_at: string;
  payload: AuditEventPayload;
  prev_hash: string;
  record_hash: string;
  audit_schema_version: string;
}

/** Input when appending; seq and hashes are assigned by the audit engine. */
export interface AuditEventInput {
  event_type: AuditEventType;
  occurred_at: string;
  payload: AuditEventPayload;
}
