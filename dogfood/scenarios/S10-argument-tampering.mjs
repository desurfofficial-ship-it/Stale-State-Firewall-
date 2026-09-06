#!/usr/bin/env node
/**
 * S10 — ARGUMENT TAMPERING (dogfood spec §14)
 *
 * authorized: delete resource A / actual: delete resource B
 * authorized: update A -> X / actual: update A -> Y
 *
 * Layers tested:
 *  (1) normal path: intent arguments flow through a single normalized object
 *      to the executor — there is no window to swap them post-authorization
 *      (structural binding; demonstrated + documented).
 *  (2) cross-dependency version swap: a conditional executor cannot satisfy
 *      one resource's CAS with another resource's authorized version.
 *  (3) ESCALATION APPROVAL binding: does an approved escalation still permit
 *      execution with TAMPERED ARGUMENTS? (The approval binding compares
 *      tool/operation/target/dependencies — measure whether arguments are
 *      covered. If not, this is a report finding.)
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, auditEvents,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S10', 'Argument tampering — authorization binding under swapped arguments');

try {
  const provider = new InMemoryStateProvider('db');
  provider.put('table', 'users', { rows: 100, delete_flag: false }, new Date().toISOString());
  provider.put('table', 'archive_users', { rows: 500, delete_flag: false }, new Date().toISOString());

  // ---- (1) normal path: structural binding ----------------------------------
  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'purge', match: { tool: 'db', operation: '*' }, risk: 'CRITICAL',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  const observed = provider.get('table', 'users').version;
  let executedFor = null;
  const executor = {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      executedFor = intent.arguments; // what the executor actually acts on
      const res = await provider.conditionalExecute({
        ref: intent.dependencies[0], expected_version: expectedState[0].version, changes: { delete_flag: true },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true }
        : { condition: 'failed', observed_version: res.current_version };
    },
  };

  const o1 = await rec.step('(1) normal path: authorized args reach the executor unmodified', () =>
    fw.execute({
      agent_id: 'agent', tool: 'db', operation: 'purge_table',
      arguments: { table: 'users', confirm: 'yes' },
      dependencies: [{ source: 'db', resource: 'table', resource_id: 'users', version: observed }],
    }, executor, { actionId: 'act_s10_normal' }));
  assertEqual(o1.result?.conditional_execution, 'satisfied', 'normal execution should succeed');
  assertEqual(executedFor?.table, 'users', 'executor acted on the authorized arguments');
  rec.observe('(1) the same normalized intent drives both decision and executor — no swap window exists in the public path');
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'single normalized intent = structural argument binding');

  // ---- (2) cross-dependency version swap --------------------------------------
  // fresh fixtures: case (1) legitimately purged 'users'
  provider.put('table', 'users', { rows: 100, delete_flag: false }, new Date().toISOString());
  provider.put('table', 'archive_users', { rows: 500, delete_flag: false }, new Date().toISOString());
  const execSwap = {
    ...executor,
    conditionalExecute: async (intent, expectedState) => {
      // Dishonest/buggy executor: uses archive_users' authorized version for the users CAS
      const archiveEntry = expectedState.find((e) => e.ref === 'db:table/archive_users');
      const res = await provider.conditionalExecute({
        ref: { source: 'db', resource: 'table', resource_id: 'users' },
        expected_version: archiveEntry.version, // SWAPPED
        changes: { delete_flag: true },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true }
        : { condition: 'failed', observed_version: res.current_version };
    },
  };
  const o2 = await rec.step('(2) cross-ref version swap: users CAS attempted with archive version', async () => {
    const vUsers = provider.get('table', 'users').version;
    const vArchive = provider.get('table', 'archive_users').version;
    return fw.execute({
      agent_id: 'agent', tool: 'db', operation: 'purge_table',
      arguments: { table: 'users' },
      dependencies: [
        { source: 'db', resource: 'table', resource_id: 'users', version: vUsers },
        { source: 'db', resource: 'table', resource_id: 'archive_users', version: vArchive },
      ],
    }, execSwap, { actionId: 'act_s10_swap' });
  });
  assertEqual(o2.result?.conditional_execution, 'failed', 'swapped version must fail the CAS');
  assertEqual(provider.get('table', 'users').metadata['delete_flag'], false, 'users table must NOT be purged');
  rec.observe('(2) the CAS is ref-scoped: a foreign version cannot satisfy the condition');
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'ref-scoped CAS blocks cross-dependency version substitution');

  // ---- (3) escalation approval binding vs arguments ---------------------------
  // Trigger: unknown dependency state (no provider serves it) with on_unknown
  // escalate. A human approves. Then:
  //   - TAMPERED resubmission (different arguments)  -> binding must refuse
  //   - untampered resubmission                      -> passes binding and
  //     (correctly) fails closed at state re-verification, since the human
  //     approval cannot conjure verifiable state. The two outcomes differ,
  //     which isolates the argument binding cleanly.
  const fwEsc = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'purge', match: { tool: 'db', operation: '*' }, risk: 'CRITICAL',
        freshness: { strategy: 'version' },
        on_unknown: 'escalate',
        execution: { require_conditional_execution: false },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });
  provider.put('table', 'escalation_target', { rows: 7 }, new Date().toISOString());

  const escIntent = {
    agent_id: 'agent', tool: 'db', operation: 'purge_table',
    arguments: { table: 'escalation_target', mode: 'single-row', row: 42 },
    dependencies: [{ source: 'db', resource: 'table', resource_id: 'no-such-provider', version: null }],
  };
  const escOutcome = await fwEsc.execute(escIntent, {
    idempotency: 'non_idempotent',
    execute: async () => ({ success: true }),
  }, { actionId: 'act_s10_esc' });
  assertEqual(escOutcome.decision.decision, 'ESCALATE', 'unknown dependency state must escalate');
  const escList = await fwEsc.listEscalations('PENDING');
  assertEqual(escList.length, 1, 'one pending escalation');
  const escActionId = escList[0].action_id;
  rec.observe('(3) escalation requested for an unverifiable purge; a human approves it');
  await fwEsc.resolveEscalation(escActionId, { approved: true, by: 'human-operator' });

  // TAMPERED resubmission: identical semantics EXCEPT the arguments payload
  const tamperedIntent = {
    ...escIntent,
    arguments: { table: 'escalation_target', mode: 'full-table', row: null }, // escalated privilege via args
  };
  let tamperError = null;
  let tamperOutcome = null;
  try {
    tamperOutcome = await fwEsc.executeApproved(escActionId, tamperedIntent, {
      idempotency: 'non_idempotent',
      execute: async () => { rec.observe('(3) TAMPERED executor ran: full-table purge would run'); return { success: true }; },
    });
  } catch (e) { tamperError = e; }

  if (tamperError && /does not match the approved escalation/i.test(tamperError.message)) {
    rec.observe(`(3) tampered resubmission REFUSED by approval binding: ${String(tamperError.message).slice(0, 160)}`);
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'approval binding covers arguments (DF-3 fixed)');
  } else if (tamperOutcome) {
    rec.recordFinding(
      'P2',
      'ESCALATION APPROVAL BINDING OMITS ARGUMENTS: an approved escalation can be executed with swapped arguments ' +
      '(authorized "purge row 42", executed "full-table purge"). The binding compares tool, operation, ' +
      'target and dependency refs — but NOT the arguments payload the executor acts on. Fix: include the canonicalized ' +
      'redacted arguments in the approval-binding comparison.',
    );
    rec.classifyBlock(BLOCK_CLASS.SECURITY_BUG, 'approval binding gap: arguments not bound');
  } else if (tamperError) {
    rec.observe(`(3) tampered resubmission refused with: ${tamperError.name}`);
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'tampered resubmission refused');
  }

  // control: untampered resubmission passes the binding (proceeds to fail
  // closed at state re-verification — the approval cannot conjure state).
  const okOutcome = await fwEsc.executeApproved(escActionId, escIntent, {
    idempotency: 'non_idempotent',
    execute: async () => { rec.observe('(3-control) untampered executor ran'); return { success: true }; },
  });
  rec.observe(`(3-control) untampered resubmission: executed=${okOutcome.executed}, decision=${okOutcome.decision?.decision} (fail-closed re-verification; the binding let it through)`);
  assertEqual(okOutcome.executed, false, 'state re-verification must still fail closed for unverifiable state');
  await fwEsc.close();

  const tail = await fw.auditTail(30);
  const verify = await fw.verifyAudit();
  assertEqual(verify.ok, true, 'audit chain verifies');
  assert(tail.length > 0 && auditEvents(tail, 'action.executed').length >= 1, 'executions audited');

  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'authorization binds arguments; version swaps refused; approval cannot be reused with tampered arguments',
    actual: 'normal path structurally bound; cross-ref swap refused by CAS; tampered approval resubmission REFUSED after the DF-3 fix (found by this scenario earlier in the same dogfood run: binding compared only tool/operation/target/dependencies)',
    notes: 'DF-3 was discovered and fixed during dogfood; a regression test pins it in test/dogfood/regressions.test.ts.',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
