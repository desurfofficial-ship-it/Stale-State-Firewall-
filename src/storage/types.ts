/**
 * Firewall storage contract (spec §37, §57, §58).
 *
 * Storage backs snapshots, actions, decisions, authorizations, escalations,
 * and the append-only audit ledger. Implementations MUST enforce database
 * integrity (unique ids, foreign keys, not-null constraints, indexes,
 * transaction boundaries) and MUST NOT expose any mutation path for audit
 * records — append and read only (invariant 6).
 */

import type { ActionIntent, ExecutionResult } from '../domain/action.js';
import type { DecisionRecord } from '../domain/decision.js';
import type { StateSnapshot } from '../domain/state.js';
import type { AuditEventInput, AuditRecord } from '../domain/audit.js';

export interface AuthorizationRecord {
  action_id: string;
  decision_id: string;
  authorized_at: string;
  expires_at: string;
  /** Hash over the dependency versions at authorization time. */
  state_fingerprint: string;
  consumed_at: string | null;
  policy_version: string;
}

export type EscalationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface EscalationRecord {
  action_id: string;
  decision_id: string;
  status: EscalationStatus;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface FirewallStore {
  /** Opens and migrates the store. */
  init(): Promise<void>;
  close(): Promise<void>;

  saveAction(action: ActionIntent): Promise<void>;
  getAction(actionId: string): Promise<ActionIntent | null>;

  saveDecision(record: DecisionRecord): Promise<void>;
  getDecision(decisionId: string): Promise<DecisionRecord | null>;
  getLatestDecision(actionId: string): Promise<DecisionRecord | null>;
  listDecisions(actionId: string): Promise<DecisionRecord[]>;

  saveSnapshot(snapshot: StateSnapshot): Promise<void>;
  getLatestSnapshot(ref: { source: string; resource: string; resource_id: string }): Promise<StateSnapshot | null>;

  saveExecution(execution: ExecutionResult): Promise<void>;
  getExecution(executionId: string): Promise<ExecutionResult | null>;
  listExecutions(actionId: string): Promise<ExecutionResult[]>;

  saveAuthorization(auth: AuthorizationRecord): Promise<void>;
  getAuthorization(actionId: string): Promise<AuthorizationRecord | null>;
  consumeAuthorization(actionId: string, consumedAtIso: string): Promise<void>;

  saveEscalation(escalation: EscalationRecord): Promise<void>;
  getEscalation(actionId: string): Promise<EscalationRecord | null>;
  listEscalations(status?: EscalationStatus): Promise<EscalationRecord[]>;
  resolveEscalation(actionId: string, status: 'APPROVED' | 'REJECTED', resolvedBy: string, note: string | null, atIso: string): Promise<void>;

  /** Appends one audit record; the store assigns seq inside a transaction. */
  appendAudit(input: AuditEventInput, computeHash: (prevHash: string, record: Omit<AuditRecord, 'seq' | 'prev_hash' | 'record_hash'>) => { prev_hash: string; record_hash: string }): Promise<AuditRecord>;
  getLastAuditRecord(): Promise<AuditRecord | null>;
  listAuditRecords(limit: number, beforeSeq?: number): Promise<AuditRecord[]>;
  listAllAuditRecords(): Promise<AuditRecord[]>;
}
