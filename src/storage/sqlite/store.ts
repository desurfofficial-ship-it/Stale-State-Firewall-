/**
 * SQLite-backed store (spec §37, §57, §58) built on node:sqlite.
 *
 * Integrity guarantees:
 * - schema migrations with version tracking
 * - PRIMARY KEY / UNIQUE / NOT NULL / CHECK constraints at the database level
 * - foreign keys enforced via PRAGMA foreign_keys = ON
 * - indexes on hot lookup paths
 * - transactions around logically atomic operations
 * - audit records are append-only: no update or delete path exists
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FirewallStore, AuthorizationRecord, EscalationRecord, EscalationStatus } from '../types.js';
import type { ActionIntent, ExecutionResult } from '../../domain/action.js';
import type { DecisionRecord } from '../../domain/decision.js';
import type { StateSnapshot } from '../../domain/state.js';
import type { AuditEventInput, AuditRecord } from '../../domain/audit.js';
import { StorageError } from '../../domain/errors.js';
import { newId, ID_PREFIXES } from '../../domain/identifiers.js';
import { AUDIT_SCHEMA_VERSION } from '../../version.js';

const MIGRATIONS: Array<{ version: number; statements: string[] }> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        resource TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        retrieved_at TEXT NOT NULL,
        version TEXT,
        content_hash TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        provenance TEXT NOT NULL,
        UNIQUE(snapshot_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_snapshots_ref ON snapshots(source, resource, resource_id, observed_at)`,
      `CREATE TABLE IF NOT EXISTS actions (
        action_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        operation TEXT NOT NULL,
        target TEXT,
        arguments TEXT NOT NULL,
        dependencies TEXT NOT NULL,
        preconditions TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        policy_name TEXT,
        created_at TEXT NOT NULL,
        execution_deadline_ms INTEGER NOT NULL,
        idempotency_key TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES actions(action_id),
        agent_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        operation TEXT NOT NULL,
        target TEXT,
        risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
        decision TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY','REVALIDATE','ESCALATE')),
        would_have_decided TEXT CHECK (would_have_decided IS NULL OR would_have_decided IN ('ALLOW','DENY','REVALIDATE','ESCALATE')),
        reason TEXT NOT NULL,
        policy_name TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('OBSERVE','ENFORCE','STRICT')),
        verdicts TEXT NOT NULL,
        stale_dependencies TEXT NOT NULL DEFAULT '[]',
        invalid_dependencies TEXT NOT NULL DEFAULT '[]',
        unknown_dependencies TEXT NOT NULL DEFAULT '[]',
        preconditions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revalidated INTEGER NOT NULL DEFAULT 0,
        execution TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_decisions_action ON decisions(action_id, created_at)`,
      `CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL,
        success INTEGER NOT NULL CHECK (success IN (0,1)),
        idempotency TEXT NOT NULL CHECK (idempotency IN ('idempotent','non_idempotent')),
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        atomicity TEXT NOT NULL CHECK (atomicity IN ('guaranteed','not_guaranteed'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_executions_action ON executions(action_id)`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        audit_schema_version TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS authorizations (
        action_id TEXT PRIMARY KEY REFERENCES actions(action_id),
        decision_id TEXT NOT NULL,
        authorized_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state_fingerprint TEXT NOT NULL,
        consumed_at TEXT,
        policy_version TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS escalations (
        action_id TEXT PRIMARY KEY REFERENCES actions(action_id),
        decision_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT
      )`,
    ],
  },
];

export interface SqliteStoreOptions {
  /** File path or ":memory:" for an in-RAM database. */
  path: string;
}

export class SqliteStore implements FirewallStore {
  private db: DatabaseSync | null = null;
  private readonly path: string;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
  }

  async init(): Promise<void> {
    try {
      if (this.path !== ':memory:') {
        mkdirSync(dirname(this.path), { recursive: true });
      }
      this.db = new DatabaseSync(this.path);
      this.db.exec(this.path !== ':memory:' ? 'PRAGMA journal_mode = WAL;' : 'PRAGMA journal_mode = MEMORY;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.migrate();
    } catch (error) {
      throw new StorageError(
        `failed to open sqlite store at ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private migrate(): void {
    const db = this.db!;
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((r) => r.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of migration.statements) {
          db.exec(statement);
        }
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          new Date().toISOString(),
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  private check(): DatabaseSync {
    if (this.db === null) {
      throw new StorageError('store is not initialized; call init() first');
    }
    return this.db;
  }

  async saveAction(action: ActionIntent): Promise<void> {
    const db = this.check();
    try {
      db.prepare(
        `INSERT OR REPLACE INTO actions (action_id, agent_id, tool, operation, target, arguments, dependencies,
          preconditions, risk_level, policy_name, created_at, execution_deadline_ms, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        action.action_id,
        action.agent_id,
        action.tool,
        action.operation,
        action.target,
        safeJson(action.arguments),
        safeJson(action.dependencies),
        safeJson(action.preconditions),
        action.risk_level,
        action.policy_name,
        action.created_at,
        action.execution_deadline_ms,
        action.idempotency_key,
      );
    } catch (error) {
      throw new StorageError(`failed to persist action ${action.action_id}`, undefined, error);
    }
  }

  async getAction(actionId: string): Promise<ActionIntent | null> {
    const row = this.check().prepare('SELECT * FROM actions WHERE action_id = ?').get(actionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      action_id: row['action_id'] as string,
      agent_id: row['agent_id'] as string,
      tool: row['tool'] as string,
      operation: row['operation'] as string,
      target: (row['target'] as string | null) ?? null,
      arguments: JSON.parse(row['arguments'] as string) as Record<string, unknown>,
      dependencies: JSON.parse(row['dependencies'] as string),
      preconditions: JSON.parse(row['preconditions'] as string),
      risk_level: row['risk_level'] as ActionIntent['risk_level'],
      policy_name: (row['policy_name'] as string | null) ?? null,
      created_at: row['created_at'] as string,
      execution_deadline_ms: row['execution_deadline_ms'] as number,
      idempotency_key: (row['idempotency_key'] as string | null) ?? null,
    };
  }

  async saveDecision(record: DecisionRecord): Promise<void> {
    const db = this.check();
    try {
      db.prepare(
        `INSERT INTO decisions (decision_id, action_id, agent_id, tool, operation, target, risk_level,
          decision, would_have_decided, reason, policy_name, policy_version, mode, verdicts,
          stale_dependencies, invalid_dependencies, unknown_dependencies, preconditions,
          created_at, expires_at, revalidated, execution)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.decision_id,
        record.action_id,
        record.agent_id,
        record.tool,
        record.operation,
        record.target,
        record.risk_level,
        record.decision,
        record.would_have_decided,
        record.reason,
        record.policy_name,
        record.policy_version,
        record.mode,
        safeJson(record.verdicts),
        safeJson(record.stale_dependencies),
        safeJson(record.invalid_dependencies),
        safeJson(record.unknown_dependencies),
        safeJson(record.preconditions),
        record.created_at,
        record.expires_at,
        record.revalidated ? 1 : 0,
        record.execution ? safeJson(record.execution) : null,
      );
    } catch (error) {
      throw new StorageError(`failed to persist decision ${record.decision_id}`, undefined, error);
    }
  }

  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    const row = this.check().prepare('SELECT * FROM decisions WHERE decision_id = ?').get(decisionId) as
      | Record<string, unknown>
      | undefined;
    return row ? decisionFromRow(row) : null;
  }

  async getLatestDecision(actionId: string): Promise<DecisionRecord | null> {
    const row = this.check()
      .prepare('SELECT * FROM decisions WHERE action_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(actionId) as Record<string, unknown> | undefined;
    return row ? decisionFromRow(row) : null;
  }

  async listDecisions(actionId: string): Promise<DecisionRecord[]> {
    const rows = this.check()
      .prepare('SELECT * FROM decisions WHERE action_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(actionId) as Array<Record<string, unknown>>;
    return rows.map(decisionFromRow);
  }

  async saveSnapshot(snapshot: StateSnapshot): Promise<void> {
    const db = this.check();
    try {
      db.prepare(
        `INSERT INTO snapshots (snapshot_id, source, resource, resource_id, observed_at, retrieved_at,
          version, content_hash, metadata, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        snapshot.snapshot_id,
        snapshot.source,
        snapshot.resource,
        snapshot.resource_id,
        snapshot.observed_at,
        snapshot.provenance.retrieved_at,
        snapshot.version,
        snapshot.content_hash,
        safeJson(snapshot.metadata),
        safeJson(snapshot.provenance),
      );
    } catch (error) {
      throw new StorageError(`failed to persist snapshot ${snapshot.snapshot_id}`, undefined, error);
    }
  }

  async getLatestSnapshot(ref: { source: string; resource: string; resource_id: string }): Promise<StateSnapshot | null> {
    const row = this.check()
      .prepare(
        'SELECT * FROM snapshots WHERE source = ? AND resource = ? AND resource_id = ? ORDER BY observed_at DESC LIMIT 1',
      )
      .get(ref.source, ref.resource, ref.resource_id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      snapshot_id: row['snapshot_id'] as string,
      source: row['source'] as string,
      resource: row['resource'] as string,
      resource_id: row['resource_id'] as string,
      observed_at: row['observed_at'] as string,
      version: (row['version'] as string | null) ?? null,
      content_hash: (row['content_hash'] as string | null) ?? null,
      metadata: JSON.parse(row['metadata'] as string),
      provenance: JSON.parse(row['provenance'] as string),
    };
  }

  async saveExecution(execution: ExecutionResult): Promise<void> {
    const db = this.check();
    try {
      db.prepare(
        `INSERT INTO executions (execution_id, action_id, success, idempotency, output, error,
          started_at, finished_at, duration_ms, atomicity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        execution.execution_id,
        execution.action_id,
        execution.success ? 1 : 0,
        execution.idempotency,
        execution.output !== undefined ? safeJson(execution.output) : null,
        execution.error ?? null,
        execution.started_at,
        execution.finished_at,
        execution.duration_ms,
        execution.atomicity,
      );
    } catch (error) {
      throw new StorageError(`failed to persist execution ${execution.execution_id}`, undefined, error);
    }
  }

  async getExecution(executionId: string): Promise<ExecutionResult | null> {
    const row = this.check().prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId) as
      | Record<string, unknown>
      | undefined;
    return row ? executionFromRow(row) : null;
  }

  async listExecutions(actionId: string): Promise<ExecutionResult[]> {
    const rows = this.check()
      .prepare('SELECT * FROM executions WHERE action_id = ? ORDER BY started_at ASC')
      .all(actionId) as Array<Record<string, unknown>>;
    return rows.map(executionFromRow);
  }

  async saveAuthorization(auth: AuthorizationRecord): Promise<void> {
    const db = this.check();
    try {
      db.prepare(
        `INSERT INTO authorizations (action_id, decision_id, authorized_at, expires_at, state_fingerprint, consumed_at, policy_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        auth.action_id,
        auth.decision_id,
        auth.authorized_at,
        auth.expires_at,
        auth.state_fingerprint,
        auth.consumed_at,
        auth.policy_version,
      );
    } catch (error) {
      throw new StorageError(`failed to persist authorization for ${auth.action_id}`, undefined, error);
    }
  }

  async getAuthorization(actionId: string): Promise<AuthorizationRecord | null> {
    const row = this.check().prepare('SELECT * FROM authorizations WHERE action_id = ?').get(actionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      action_id: row['action_id'] as string,
      decision_id: row['decision_id'] as string,
      authorized_at: row['authorized_at'] as string,
      expires_at: row['expires_at'] as string,
      state_fingerprint: row['state_fingerprint'] as string,
      consumed_at: (row['consumed_at'] as string | null) ?? null,
      policy_version: row['policy_version'] as string,
    };
  }

  async consumeAuthorization(actionId: string, consumedAtIso: string): Promise<void> {
    const db = this.check();
    db.prepare('UPDATE authorizations SET consumed_at = ? WHERE action_id = ?').run(consumedAtIso, actionId);
  }

  async saveEscalation(escalation: EscalationRecord): Promise<void> {
    const db = this.check();
    try {
      db.prepare(
        `INSERT INTO escalations (action_id, decision_id, status, requested_at, resolved_at, resolved_by, resolution_note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        escalation.action_id,
        escalation.decision_id,
        escalation.status,
        escalation.requested_at,
        escalation.resolved_at,
        escalation.resolved_by,
        escalation.resolution_note,
      );
    } catch (error) {
      throw new StorageError(`failed to persist escalation for ${escalation.action_id}`, undefined, error);
    }
  }

  async getEscalation(actionId: string): Promise<EscalationRecord | null> {
    const row = this.check().prepare('SELECT * FROM escalations WHERE action_id = ?').get(actionId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return escalationFromRow(row);
  }

  async listEscalations(status?: EscalationStatus): Promise<EscalationRecord[]> {
    const rows = (
      status
        ? this.check().prepare('SELECT * FROM escalations WHERE status = ? ORDER BY requested_at ASC').all(status)
        : this.check().prepare('SELECT * FROM escalations ORDER BY requested_at ASC').all()
    ) as Array<Record<string, unknown>>;
    return rows.map(escalationFromRow);
  }

  async resolveEscalation(
    actionId: string,
    status: 'APPROVED' | 'REJECTED',
    resolvedBy: string,
    note: string | null,
    atIso: string,
  ): Promise<void> {
    const db = this.check();
    db.prepare(
      'UPDATE escalations SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE action_id = ?',
    ).run(status, atIso, resolvedBy, note, actionId);
  }

  async appendAudit(
    input: AuditEventInput,
    computeHash: (prevHash: string, record: Omit<AuditRecord, 'seq' | 'prev_hash' | 'record_hash'>) => { prev_hash: string; record_hash: string },
  ): Promise<AuditRecord> {
    const db = this.check();

    const insert = (record: AuditRecord): void => {
      db.prepare(
        `INSERT INTO audit_events (event_id, event_type, occurred_at, payload, prev_hash, record_hash, audit_schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.event_id,
        record.event_type,
        record.occurred_at,
        safeJson(record.payload),
        record.prev_hash,
        record.record_hash,
        record.audit_schema_version,
      );
    };

    try {
      const last = db
        .prepare('SELECT seq, event_id, event_type, occurred_at, payload, prev_hash, record_hash, audit_schema_version FROM audit_events ORDER BY seq DESC LIMIT 1')
        .get() as Record<string, unknown> | undefined;
      const prevHash = last ? String(last['record_hash']) : GENESIS_HASH;

      // Assign the next seq inside the same synchronous turn (node:sqlite is
      // synchronous), which serializes concurrent appends on one connection.
      const base = {
        event_id: newId(ID_PREFIXES.audit, Date.parse(input.occurred_at) || Date.now()),
        event_type: input.event_type,
        occurred_at: input.occurred_at,
        payload: input.payload,
        audit_schema_version: AUDIT_SCHEMA_VERSION,
      };
      const { prev_hash, record_hash } = computeHash(prevHash, base);

      const maxRow = db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxseq FROM audit_events').get() as { maxseq: number };
      const record: AuditRecord = {
        seq: maxRow.maxseq + 1,
        event_id: base.event_id,
        event_type: base.event_type,
        occurred_at: base.occurred_at,
        payload: base.payload,
        prev_hash,
        record_hash,
        audit_schema_version: base.audit_schema_version,
      };
      insert(record);
      return record;
    } catch (error) {
      throw new StorageError('failed to append audit record', undefined, error);
    }
  }

  async getLastAuditRecord(): Promise<AuditRecord | null> {
    const row = this.check()
      .prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return row ? auditFromRow(row) : null;
  }

  async listAuditRecords(limit: number, beforeSeq?: number): Promise<AuditRecord[]> {
    const rows = (
      beforeSeq !== undefined
        ? this.check().prepare('SELECT * FROM audit_events WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(beforeSeq, limit)
        : this.check().prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT ?').all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(auditFromRow);
  }

  async listAllAuditRecords(): Promise<AuditRecord[]> {
    const rows = this.check()
      .prepare('SELECT * FROM audit_events ORDER BY seq ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(auditFromRow);
  }
}

export const GENESIS_HASH = '0'.repeat(64);

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function decisionFromRow(row: Record<string, unknown>): DecisionRecord {
  return {
    decision_id: row['decision_id'] as string,
    action_id: row['action_id'] as string,
    agent_id: row['agent_id'] as string,
    tool: row['tool'] as string,
    operation: row['operation'] as string,
    target: (row['target'] as string | null) ?? null,
    risk_level: row['risk_level'] as DecisionRecord['risk_level'],
    decision: row['decision'] as DecisionRecord['decision'],
    would_have_decided: (row['would_have_decided'] as DecisionRecord['would_have_decided'] | null) ?? null,
    reason: row['reason'] as string,
    policy_name: row['policy_name'] as string,
    policy_version: row['policy_version'] as string,
    mode: row['mode'] as DecisionRecord['mode'],
    verdicts: JSON.parse(row['verdicts'] as string),
    stale_dependencies: JSON.parse(row['stale_dependencies'] as string),
    invalid_dependencies: JSON.parse(row['invalid_dependencies'] as string),
    unknown_dependencies: JSON.parse(row['unknown_dependencies'] as string),
    preconditions: JSON.parse(row['preconditions'] as string),
    created_at: row['created_at'] as string,
    expires_at: (row['expires_at'] as string | null) ?? null,
    revalidated: row['revalidated'] === 1,
    execution: row['execution'] ? (JSON.parse(row['execution'] as string) as ExecutionResult) : null,
  };
}

function executionFromRow(row: Record<string, unknown>): ExecutionResult {
  return {
    execution_id: row['execution_id'] as string,
    action_id: row['action_id'] as string,
    success: row['success'] === 1,
    idempotency: row['idempotency'] as ExecutionResult['idempotency'],
    output: row['output'] !== null && row['output'] !== undefined ? JSON.parse(row['output'] as string) : undefined,
    error: (row['error'] as string | null) ?? undefined,
    started_at: row['started_at'] as string,
    finished_at: row['finished_at'] as string,
    duration_ms: row['duration_ms'] as number,
    atomicity: row['atomicity'] as ExecutionResult['atomicity'],
  };
}

function escalationFromRow(row: Record<string, unknown>): EscalationRecord {
  return {
    action_id: row['action_id'] as string,
    decision_id: row['decision_id'] as string,
    status: row['status'] as EscalationStatus,
    requested_at: row['requested_at'] as string,
    resolved_at: (row['resolved_at'] as string | null) ?? null,
    resolved_by: (row['resolved_by'] as string | null) ?? null,
    resolution_note: (row['resolution_note'] as string | null) ?? null,
  };
}

function auditFromRow(row: Record<string, unknown>): AuditRecord {
  return {
    seq: row['seq'] as number,
    event_id: row['event_id'] as string,
    event_type: row['event_type'] as AuditRecord['event_type'],
    occurred_at: row['occurred_at'] as string,
    payload: JSON.parse(row['payload'] as string),
    prev_hash: row['prev_hash'] as string,
    record_hash: row['record_hash'] as string,
    audit_schema_version: row['audit_schema_version'] as string,
  };
}
