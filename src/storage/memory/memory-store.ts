/**
 * In-memory store — implements the full FirewallStore contract with Maps.
 * Used for unit/integration tests and storage.type "memory" configurations.
 * The audit ledger here is also append-only and hash-chained, matching the
 * SQLite store's guarantees.
 */

import type { ActionIntent, ExecutionResult } from '../../domain/action.js';
import type { DecisionRecord } from '../../domain/decision.js';
import type { StateSnapshot } from '../../domain/state.js';
import type { AuditEventInput, AuditRecord } from '../../domain/audit.js';
import { StorageError } from '../../domain/errors.js';
import { newId, ID_PREFIXES } from '../../domain/identifiers.js';
import { AUDIT_SCHEMA_VERSION } from '../../version.js';

import type {
  FirewallStore,
  AuthorizationRecord,
  AuthorizationClaimResult,
  EscalationRecord,
  EscalationStatus,
} from '../types.js';

export class MemoryStore implements FirewallStore {
  private readonly actions = new Map<string, ActionIntent>();
  private readonly decisions = new Map<string, DecisionRecord>();
  private readonly decisionsByAction = new Map<string, string[]>();
  private readonly snapshots: StateSnapshot[] = [];
  private readonly executions = new Map<string, ExecutionResult>();
  private readonly executionsByAction = new Map<string, string[]>();
  private readonly authorizations = new Map<string, AuthorizationRecord>();
  private readonly escalations = new Map<string, EscalationRecord>();
  private readonly audit: AuditRecord[] = [];
  private auditSeq = 0;
  private initialized = false;

  async init(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  private check(): void {
    if (!this.initialized) {
      throw new StorageError('store is not initialized; call init() first');
    }
  }

  async saveAction(action: ActionIntent): Promise<void> {
    this.check();
    // Keep-first: the FIRST intent recorded for an action id is preserved.
    // A later submission re-using the same id (including a replay attempt
    // with swapped semantics) must never rewrite the forensic record.
    if (!this.actions.has(action.action_id)) {
      this.actions.set(action.action_id, structuredClone(action));
    }
  }

  async getAction(actionId: string): Promise<ActionIntent | null> {
    this.check();
    const action = this.actions.get(actionId);
    return action ? structuredClone(action) : null;
  }

  async saveDecision(record: DecisionRecord): Promise<void> {
    this.check();
    if (this.decisions.has(record.decision_id)) {
      throw new StorageError(`decision ${record.decision_id} already exists (unique constraint)`);
    }
    this.decisions.set(record.decision_id, structuredClone(record));
    const list = this.decisionsByAction.get(record.action_id) ?? [];
    list.push(record.decision_id);
    this.decisionsByAction.set(record.action_id, list);
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    this.check();
    const record = this.decisions.get(decisionId);
    return record ? structuredClone(record) : null;
  }

  async getLatestDecision(actionId: string): Promise<DecisionRecord | null> {
    this.check();
    const list = this.decisionsByAction.get(actionId) ?? [];
    const latestId = list[list.length - 1];
    if (!latestId) return null;
    const record = this.decisions.get(latestId);
    return record ? structuredClone(record) : null;
  }

  async listDecisions(actionId: string): Promise<DecisionRecord[]> {
    this.check();
    return (this.decisionsByAction.get(actionId) ?? [])
      .map((id) => this.decisions.get(id))
      .filter((d): d is DecisionRecord => d !== undefined)
      .map((d) => structuredClone(d));
  }

  async saveSnapshot(snapshot: StateSnapshot): Promise<void> {
    this.check();
    this.snapshots.push(structuredClone(snapshot));
  }

  async getLatestSnapshot(ref: { source: string; resource: string; resource_id: string }): Promise<StateSnapshot | null> {
    this.check();
    const matches = this.snapshots.filter(
      (s) => s.source === ref.source && s.resource === ref.resource && s.resource_id === ref.resource_id,
    );
    const latest = matches[matches.length - 1];
    return latest ? structuredClone(latest) : null;
  }

  async saveExecution(execution: ExecutionResult): Promise<void> {
    this.check();
    this.executions.set(execution.execution_id, structuredClone(execution));
    const list = this.executionsByAction.get(execution.action_id) ?? [];
    list.push(execution.execution_id);
    this.executionsByAction.set(execution.action_id, list);
  }

  async getExecution(executionId: string): Promise<ExecutionResult | null> {
    this.check();
    const execution = this.executions.get(executionId);
    return execution ? structuredClone(execution) : null;
  }

  async listExecutions(actionId: string): Promise<ExecutionResult[]> {
    this.check();
    return (this.executionsByAction.get(actionId) ?? [])
      .map((id) => this.executions.get(id))
      .filter((e): e is ExecutionResult => e !== undefined)
      .map((e) => structuredClone(e));
  }

  async saveAuthorization(auth: AuthorizationRecord): Promise<void> {
    this.check();
    this.authorizations.set(auth.action_id, structuredClone(auth));
  }

  async claimAuthorization(auth: AuthorizationRecord): Promise<AuthorizationClaimResult> {
    this.check();
    // Single-threaded synchronous check-and-set: atomic within this store.
    const existing = this.authorizations.get(auth.action_id);
    if (existing && existing.consumed_at === null) {
      return { claimed: false, existing: structuredClone(existing) };
    }
    this.authorizations.set(auth.action_id, structuredClone(auth));
    return { claimed: true };
  }

  async getAuthorization(actionId: string): Promise<AuthorizationRecord | null> {
    this.check();
    const auth = this.authorizations.get(actionId);
    return auth ? structuredClone(auth) : null;
  }

  async consumeAuthorization(actionId: string, consumedAtIso: string): Promise<void> {
    this.check();
    const auth = this.authorizations.get(actionId);
    if (auth) {
      auth.consumed_at = consumedAtIso;
    }
  }

  async saveEscalation(escalation: EscalationRecord): Promise<void> {
    this.check();
    this.escalations.set(escalation.action_id, structuredClone(escalation));
  }

  async getEscalation(actionId: string): Promise<EscalationRecord | null> {
    this.check();
    const escalation = this.escalations.get(actionId);
    return escalation ? structuredClone(escalation) : null;
  }

  async listEscalations(status?: EscalationStatus): Promise<EscalationRecord[]> {
    this.check();
    const all = [...this.escalations.values()].sort((a, b) => a.requested_at.localeCompare(b.requested_at));
    return all.filter((e) => status === undefined || e.status === status).map((e) => structuredClone(e));
  }

  async resolveEscalation(
    actionId: string,
    status: 'APPROVED' | 'REJECTED',
    resolvedBy: string,
    note: string | null,
    atIso: string,
  ): Promise<void> {
    this.check();
    const escalation = this.escalations.get(actionId);
    if (escalation) {
      escalation.status = status;
      escalation.resolved_at = atIso;
      escalation.resolved_by = resolvedBy;
      escalation.resolution_note = note;
    }
  }

  async appendAudit(
    input: AuditEventInput,
    computeHash: (prevHash: string, record: Omit<AuditRecord, 'seq' | 'prev_hash' | 'record_hash'>) => { prev_hash: string; record_hash: string },
  ): Promise<AuditRecord> {
    this.check();
    const last = this.audit[this.audit.length - 1];
    const prevHash = last ? last.record_hash : '0'.repeat(64);
    const base = {
      event_id: newId(ID_PREFIXES.audit, Date.parse(input.occurred_at) || Date.now()),
      event_type: input.event_type,
      occurred_at: input.occurred_at,
      payload: structuredClone(input.payload),
      audit_schema_version: AUDIT_SCHEMA_VERSION,
    };
    const { prev_hash, record_hash } = computeHash(prevHash, base);
    this.auditSeq += 1;
    const record: AuditRecord = {
      seq: this.auditSeq,
      event_id: base.event_id,
      event_type: base.event_type,
      occurred_at: base.occurred_at,
      payload: base.payload,
      prev_hash,
      record_hash,
      audit_schema_version: base.audit_schema_version,
    };
    this.audit.push(record);
    return structuredClone(record);
  }

  async getLastAuditRecord(): Promise<AuditRecord | null> {
    this.check();
    const last = this.audit[this.audit.length - 1];
    return last ? structuredClone(last) : null;
  }

  async listAuditRecords(limit: number, beforeSeq?: number): Promise<AuditRecord[]> {
    this.check();
    const filtered = this.audit.filter((r) => beforeSeq === undefined || r.seq < beforeSeq);
    return filtered
      .slice(-limit)
      .reverse()
      .map((r) => structuredClone(r));
  }

  async listAllAuditRecords(): Promise<AuditRecord[]> {
    this.check();
    return this.audit.map((r) => structuredClone(r));
  }
}


