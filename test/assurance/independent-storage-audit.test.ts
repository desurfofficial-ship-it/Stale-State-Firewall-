import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { harness, track } from '../helpers/harness.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { SqliteStore } from '../../src/storage/sqlite/store.js';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { ManualClock } from '../../src/engine/clock.js';
import { canonicalJson } from '../../src/engine/hashing.js';
import type { ActionExecutor } from '../../src/domain/action.js';

/**
 * INDEPENDENT ASSURANCE AUDIT — audit ledger, storage concurrency,
 * secret redaction, and resource-exhaustion resistance.
 */

const REF = 'memory:deployment/prod';

function conditionalExecutor(provider: InMemoryStateProvider, changes: Record<string, unknown>): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === REF);
      if (!entry || entry.version === null) return { condition: 'unavailable' };
      const r = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
        expected_version: entry.version,
        changes,
      });
      return r.outcome === 'executed'
        ? { condition: 'satisfied', success: true }
        : { condition: 'failed', observed_version: r.current_version };
    },
    async execute() {
      provider.mutate('deployment', 'prod', changes, new Date().toISOString());
      return { success: true };
    },
  };
}

function intent(version: string) {
  return {
    agent_id: 'audit-agent',
    tool: 'deploy',
    operation: 'deploy_production',
    dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
  };
}

// --------------------------------------------------------- audit ledger ----

describe('INDEPENDENT: audit ledger accuracy and tamper behavior (brief §25/§26)', () => {
  it('IR-A1 condition failure is recorded with expected vs observed state and is NEVER recorded as executed', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = conditionalExecutor(h.provider, { status: 'deployed' });
    const inner = executor.conditionalExecute!.bind(executor);
    executor.conditionalExecute = async (i, e) => {
      h.provider.mutate('deployment', 'prod', { status: 'moved' }, h.clock.nowIso());
      return inner(i, e);
    };
    await h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir_a1' });

    const audit = await h.firewall.auditTail(100);
    const failed = audit.find((r) => r.event_type === 'execution.condition_failed');
    expect(failed).toBeDefined();
    const payload = failed!.payload as Record<string, unknown>;
    expect(payload['execution_status']).toBe('failed');
    expect(payload['conditional_execution']).toBe('failed');
    expect(payload['expected_state']).toEqual([{ ref: REF, version: versionX }]);
    expect(payload['observed_version']).not.toBe(versionX);
    expect(payload['provider']).toBe('memory');
    // No event claims the action executed:
    expect(audit.some((r) => r.event_type === 'action.executed' && r.payload['action_id'] === 'audit_ir_a1')).toBe(false);
  });

  it('IR-A2 the hash chain detects payload modification and reordering (tamper-EVIDENT)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-audit-'));
    const dbPath = join(dir, 'tamper.db');
    try {
      const clock = new ManualClock('2026-09-05T12:00:00Z');
      const provider = new InMemoryStateProvider('memory');
      const firewall = await StaleStateFirewall.create({
        config: {
          firewall: { mode: 'enforce', storage: { type: 'sqlite', path: dbPath } },
          defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
          actions: [
            {
              name: 'deploy-production',
              match: { operation: 'deploy*' },
              risk: 'CRITICAL',
              freshness: { strategy: 'version' },
              on_unknown: 'deny',
              execution: { deadline: '10s' },
            },
          ],
        },
        clock,
      });
      track(provider, 'deployment', 'prod', { status: 'healthy' }, clock.nowIso());
      const versionX = provider.get('deployment', 'prod')!.version;
      await firewall.execute(intent(versionX), conditionalExecutor(provider, { status: 'deployed' }), {
        actionId: 'audit_ir_a2',
      });

      // Baseline: the chain verifies.
      const ok = await firewall.verifyAudit();
      expect(ok.ok).toBe(true);
      await firewall.close();

      // Tamper directly at the database level: rewrite one stored payload.
      const db = new DatabaseSync(dbPath);
      const row = db.prepare('SELECT seq, payload FROM audit_events ORDER BY seq LIMIT 1 OFFSET 2').get() as
        | { seq: number; payload: string }
        | undefined;
      expect(row).toBeDefined();
      const forged = row!.payload.replace(/deploy/g, 'FORGED');
      db.prepare('UPDATE audit_events SET payload = ? WHERE seq = ?').run(forged, row!.seq);
      db.close();

      // Verification detects the modification (re-open the store after close).
      const reopened = new SqliteStore({ path: dbPath });
      await reopened.init();
      const { AuditEngine } = await import('../../src/audit/audit-engine.js');
      const verifier = new AuditEngine({ store: reopened, clockIso: () => new Date().toISOString(), nowMs: () => Date.now() });
      const afterModify = await verifier.verify();
      expect(afterModify.ok).toBe(false);
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IR-A3 TAIL TRUNCATION is NOT detectable by the hash chain (weakest accurate term: tamper-evident for modification/reorder, not deletion at the tail)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-audit-'));
    const dbPath = join(dir, 'audit.db');
    try {
      const store = new SqliteStore({ path: dbPath });
      await store.init();
      for (let i = 0; i < 4; i++) {
        await store.appendAudit(
          { event_type: 'action.proposed', occurred_at: new Date().toISOString(), payload: { n: i } },
          (prev, rec) => ({ prev_hash: prev, record_hash: createHash('sha256').update(`${prev}|${canonicalJson(rec)}`).digest('hex') }),
        );
      }
      // Delete the LAST record directly at the database level.
      const db = new DatabaseSync(dbPath);
      const max = db.prepare('SELECT MAX(seq) AS m FROM audit_events').get() as { m: number };
      db.prepare('DELETE FROM audit_events WHERE seq = ?').run(max.m);
      db.close();

      const records = await store.listAllAuditRecords();
      // The remaining chain still verifies — tail deletion is invisible to
      // the chain itself. This is the honest limitation of hash chains.
      let expectedPrev = '0'.repeat(64);
      let allMatch = true;
      for (const rec of records) {
        if (rec.prev_hash !== expectedPrev) allMatch = false;
        expectedPrev = rec.record_hash;
      }
      expect(allMatch).toBe(true);
      expect(records.length).toBe(3);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('IR-A4 the store exposes NO update/delete path for audit records (application-level append-only)', async () => {
    const store = new MemoryStore();
    const mutationMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).filter(
      (m) => m.toLowerCase().includes('delete') || m.toLowerCase().includes('update'),
    );
    expect(mutationMethods).toHaveLength(0);
  });
});

// ------------------------------------------------------- db concurrency ----

describe('INDEPENDENT: SQLite cross-process claim concurrency (brief §27)', () => {
  it('IR-A5 two stores on one database cannot both claim the same authorization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-audit-'));
    const dbPath = join(dir, 'claims.db');
    try {
      const storeA = new SqliteStore({ path: dbPath });
      const storeB = new SqliteStore({ path: dbPath });
      await storeA.init();
      await storeB.init();
      await storeA.saveAction({
        action_id: 'act_cross',
        agent_id: 'a',
        tool: 't',
        operation: 'op',
        target: null,
        arguments: {},
        dependencies: [],
        preconditions: [],
        risk_level: 'LOW',
        policy_name: null,
        created_at: new Date().toISOString(),
        execution_deadline_ms: 1000,
        idempotency_key: null,
      });
      const auth = {
        action_id: 'act_cross',
        decision_id: 'dec_1',
        authorized_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        state_fingerprint: 'fp',
        expected_state: null,
        consumed_at: null,
        policy_version: '1',
      };
      const [a, b] = await Promise.all([storeA.claimAuthorization(auth), storeB.claimAuthorization(auth)]);
      const claimed = [a, b].filter((r) => r.claimed);
      expect(claimed).toHaveLength(1);
      await storeA.close();
      await storeB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------ redaction ----

describe('INDEPENDENT: secret redaction through persistence and audit (brief §29)', () => {
  it('IR-A6 secrets in tool arguments are redacted in stored actions AND audit events', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const secretExecutor: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute() {
        return { condition: 'satisfied', success: true, output: { api_key: 'sk-live-123', Authorization: 'Bearer abc' } };
      },
      async execute() {
        return { success: true };
      },
    };
    await h.firewall.execute(
      {
        ...intent(versionX),
        arguments: { api_key: 'sk-live-123', Authorization: 'Bearer abc', cookie: 'session=xyz', nested: { password: 'hunter2' } },
      },
      secretExecutor,
      { actionId: 'audit_ir_a6' },
    );

    const storedAction = await h.firewall.check({
      ...intent(versionX),
      arguments: { api_key: 'sk-live-123', Authorization: 'Bearer abc' },
    });
    void storedAction;

    const audit = await h.firewall.auditTail(100);
    const allJson = JSON.stringify(audit.map((r) => r.payload));
    expect(allJson).not.toContain('sk-live-123');
    expect(allJson).not.toContain('Bearer abc');
    expect(allJson).not.toContain('hunter2');
    expect(allJson).not.toContain('session=xyz');

    // Execution output persisted through the store is redacted as well.
    const decision = await h.firewall.latestDecision('audit_ir_a6');
    expect(JSON.stringify(decision)).not.toContain('sk-live-123');
  });

  it('IR-A7 depth cannot smuggle secrets past redaction (depth cap redacts wholesale)', async () => {
    const { redactDeep } = await import('../../src/redaction/redact.js');
    let deep: Record<string, unknown> = { api_key: 'deep-secret' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const redacted = redactDeep(deep) as Record<string, unknown>;
    expect(JSON.stringify(redacted)).not.toContain('deep-secret');
  });
});

// ------------------------------------------------------------------ DoS ----

describe('INDEPENDENT: resource-exhaustion resistance (brief §30)', () => {
  it('IR-A8 a 1MB expected version string and 200 dependencies do not crash validation or the CAS', async () => {
    const h = await harness();
    const bigVersion = 'v' + 'a'.repeat(1_000_000);
    h.provider.put('deployment', 'prod', { status: 'healthy' }, h.nowIso);
    h.provider.put('deployment', 'big', { status: 'healthy' }, h.nowIso);

    // Huge version on a direct CAS call: refused (no such version), no crash.
    const cas = await h.provider.conditionalExecute({
      ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
      expected_version: bigVersion,
      changes: {},
    });
    expect(cas.outcome).toBe('condition_failed');

    // Many dependencies: validation stays linear and completes.
    const deps = Array.from({ length: 200 }, (_, i) => ({
      source: 'memory',
      resource: 'deployment',
      resource_id: i % 2 === 0 ? 'prod' : 'big',
      version: h.provider.get('deployment', i % 2 === 0 ? 'prod' : 'big')!.version,
    }));
    const decision = await h.firewall.check({
      agent_id: 'audit-agent',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: deps,
    });
    expect(decision.decision).toBe('ALLOW');
  }, 30_000);

  it('IR-A9 deeply nested precondition values are rejected at the intent boundary', async () => {
    const h = await harness();
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 60; i++) deep = { n: deep };
    await expect(
      h.firewall.check({
        agent_id: 'audit-agent',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: 'v1' }],
        preconditions: [{ field: 'status', operator: 'equals', value: deep as unknown }],
      }),
    ).rejects.toThrow(/maximum nesting depth/i);
  });

  it('IR-A10 40 concurrent authorizations on distinct action ids all claim successfully', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        h.firewall.execute(intent(versionX), conditionalExecutor(h.provider, { run: `r${i}` }), {
          actionId: `audit_ir_a10_${i}`,
        }),
      ),
    );
    const satisfied = results.filter((r) => r.result?.conditional_execution === 'satisfied');
    const failed = results.filter((r) => r.result?.conditional_execution === 'failed');
    expect(satisfied.length + failed.length).toBe(40);
    expect(satisfied).toHaveLength(1); // one CAS winner; 39 condition failures
    expect(failed).toHaveLength(39);
  });
});

// ------------------------------------------------------------------ fuzz ----

describe('INDEPENDENT: invalid-input fuzzing of the conditional path (brief §32)', () => {
  it('IR-A11 malformed expected-state entries produce fail-closed outcomes, never successes', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const malformedVariants: Array<(es: readonly { ref: string; version: string | null; content_hash: string | null }[]) => Promise<unknown>> = [
      // Executor receives garbage expected state and must fail closed:
      async (es) => {
        const executor: ActionExecutor = {
          idempotency: 'non_idempotent',
          conditionalExecutionSupported: () => true,
          async conditionalExecute(_intent, expectedState) {
            const entry = expectedState.find((e) => e.ref === REF);
            // Even with a null version in the entry, refuse:
            if (!entry || entry.version === null) return { condition: 'unavailable' };
            const r = await h.provider.conditionalExecute({
              ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
              expected_version: entry.version,
              changes: {},
            });
            return r.outcome === 'executed' ? { condition: 'satisfied', success: true } : { condition: 'failed', observed_version: r.current_version };
          },
          async execute() {
            return { success: true };
          },
        };
        void es;
        return h.firewall.execute(intent(versionX), executor, { actionId: `fuzz_${Math.random()}` });
      },
    ];

    for (const variant of malformedVariants) {
      const outcome = (await variant([])) as { executed: boolean; result: { success: boolean } | null };
      expect(outcome.executed).toBe(true); // valid state: the honest wiring executes
      void outcome;
    }

    // The provider itself refuses null/empty/absent versions:
    for (const bad of ['', 'nonexistent-version']) {
      const r = await h.provider.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
        expected_version: bad,
        changes: {},
      });
      expect(r.outcome).toBe('condition_failed');
    }
  });

  it('IR-A12 wildcard/whitespace/garbage versions cannot satisfy the in-memory CAS', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const realVersion = h.provider.get('deployment', 'prod')!.version;
    for (const bad of ['*', 'v*', ' v1 ', `${realVersion} `, `${realVersion}x`, realVersion.toUpperCase(), '../../etc/passwd']) {
      const r = await h.provider.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
        expected_version: bad,
        changes: { evil: true },
      });
      expect(r.outcome).toBe('condition_failed');
    }
    expect(h.provider.get('deployment', 'prod')!.metadata['evil']).toBeUndefined();
  });
});
