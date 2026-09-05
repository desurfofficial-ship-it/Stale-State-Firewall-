/**
 * Audit engine (spec §21, §70 invariant 6).
 *
 * Appends tamper-evident, hash-chained audit records. The chain:
 *   record_hash_n = SHA256(prev_hash_n || canonical(record body))
 * where prev_hash_0 = 0x00*64. Verification recomputes the chain from the
 * genesis hash; any modified payload, deletion, or reordering breaks it.
 */

import type { FirewallStore } from '../storage/types.js';
import type { AuditEventInput, AuditEventPayload, AuditRecord, AuditEventType } from '../domain/audit.js';
import { canonicalJson, sha256Hex } from '../engine/hashing.js';
import { newId, ID_PREFIXES } from '../domain/identifiers.js';
import { redactDeep } from '../redaction/redact.js';

export interface AuditEngineOptions {
  store: FirewallStore;
  clockIso: () => string;
  nowMs: () => number;
}

export interface AuditChainVerification {
  ok: boolean;
  checked: number;
  broken_at_seq: number | null;
  reason: string | null;
}

export class AuditEngine {
  private readonly options: AuditEngineOptions;

  constructor(options: AuditEngineOptions) {
    this.options = options;
  }

  async append(eventType: AuditEventType, payload: AuditEventPayload): Promise<AuditRecord> {
    const input: AuditEventInput = {
      event_type: eventType,
      occurred_at: this.options.clockIso(),
      payload: redactDeep(payload) as AuditEventPayload,
    };
    return this.options.store.appendAudit(input, computeAuditHashes);
  }

  async verify(): Promise<AuditChainVerification> {
    const records = await this.options.store.listAllAuditRecords();
    let expectedPrev = '0'.repeat(64);
    for (const record of records) {
      if (record.prev_hash !== expectedPrev) {
        return {
          ok: false,
          checked: record.seq - 1,
          broken_at_seq: record.seq,
          reason: `record ${record.seq} links to ${record.prev_hash.slice(0, 12)} but chain expects ${expectedPrev.slice(0, 12)}`,
        };
      }
      const recomputed = computeAuditHashes(record.prev_hash, record);
      if (recomputed.record_hash !== record.record_hash) {
        return {
          ok: false,
          checked: record.seq - 1,
          broken_at_seq: record.seq,
          reason: `record ${record.seq} payload does not match its committed hash`,
        };
      }
      expectedPrev = record.record_hash;
    }
    return { ok: true, checked: records.length, broken_at_seq: null, reason: null };
  }

  async tail(limit: number, beforeSeq?: number): Promise<AuditRecord[]> {
    return this.options.store.listAuditRecords(limit, beforeSeq);
  }
}

/**
 * Computes the prev/record hashes for an audit record. Exported so both
 * stores hash identically.
 */
export function computeAuditHashes(
  prevHash: string,
  record: Omit<AuditRecord, 'seq' | 'prev_hash' | 'record_hash'>,
): { prev_hash: string; record_hash: string } {
  const body = canonicalJson({
    event_id: record.event_id,
    event_type: record.event_type,
    occurred_at: record.occurred_at,
    payload: record.payload,
    audit_schema_version: record.audit_schema_version,
  });
  return {
    prev_hash: prevHash,
    record_hash: sha256Hex(`${prevHash}|${body}`),
  };
}

export function newAuditEventId(nowMs: number): string {
  return newId(ID_PREFIXES.audit, nowMs);
}
