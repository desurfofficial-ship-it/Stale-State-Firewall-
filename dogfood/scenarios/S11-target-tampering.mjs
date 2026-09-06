#!/usr/bin/env node
/**
 * S11 — TARGET TAMPERING (dogfood spec §15)
 *
 * authorized target = A, execution target = B → DENY.
 * Both directions of the §15 matrix:
 *   - same state, different target
 *   - same target, different state
 *
 * The escalation approval path binds target + dependencies explicitly, so a
 * tampered resubmission is refused (UnauthorizedActionError). The normal
 * path is structurally bound (single normalized intent).
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, auditEvents,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S11', 'Target tampering — authorization binds the target');

try {
  const provider = new InMemoryStateProvider('db');
  provider.put('table', 'users', { rows: 100 }, new Date().toISOString());
  provider.put('table', 'archive_users', { rows: 500 }, new Date().toISOString());

  const fw = await StaleStateFirewall.create({
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

  const escIntent = {
    agent_id: 'agent', tool: 'db', operation: 'purge_table',
    target: 'db/tables/users',
    arguments: { mode: 'single-row', row: 42 },
    dependencies: [{ source: 'db', resource: 'table', resource_id: 'no-such-provider', version: null }],
  };
  const escOutcome = await fw.execute(escIntent, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: 'act_s11_esc' });
  assertEqual(escOutcome.decision.decision, 'ESCALATE', 'unknown state escalates');
  const escActionId = (await fw.listEscalations('PENDING'))[0].action_id;
  await fw.resolveEscalation(escActionId, { approved: true, by: 'human-operator' });
  rec.observe('escalation approved for target db/tables/users (single-row 42)');

  // ---- Case 1: same state, different target ----------------------------------
  let tamperTarget = null;
  try {
    await fw.executeApproved(escActionId, {
      ...escIntent,
      target: 'db/tables/archive_users', // different target, same claimed state
    }, { idempotency: 'non_idempotent', execute: async () => { rec.observe('TAMPERED executor ran on archive_users'); return { success: true }; } });
  } catch (e) { tamperTarget = e; }
  assert(tamperTarget && /does not match the approved escalation/i.test(tamperTarget.message ?? ''), 'target swap must be refused by the approval binding');
  rec.observe(`same state + different target -> REFUSED: ${String(tamperTarget?.message).slice(0, 130)}`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'approval binding covers the target');

  // ---- Case 2: same target, different state ----------------------------------
  let tamperState = null;
  try {
    await fw.executeApproved(escActionId, {
      ...escIntent,
      dependencies: [{ source: 'db', resource: 'table', resource_id: 'users', version: null }], // different dependency set
    }, { idempotency: 'non_idempotent', execute: async () => { rec.observe('TAMPERED executor ran with swapped dependency state'); return { success: true }; } });
  } catch (e) { tamperState = e; }
  assert(tamperState && /does not match the approved escalation/i.test(tamperState.message ?? ''), 'dependency-set swap must be refused by the approval binding');
  rec.observe(`same target + different state -> REFUSED: ${String(tamperState?.message).slice(0, 130)}`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'approval binding covers the authorized state (dependency refs)');

  const tail = await fw.auditTail(20);
  const blocked = auditEvents(tail, 'action.blocked').filter((e) => e.payload?.decision === 'ESCALATE');
  assert(blocked.length >= 2, 'both tampering attempts must be audited as blocked');
  rec.observe(`audit records ${blocked.length} blocked tampering attempts with reasons`);
  rec.sampleError('target tampering under approved escalation', tamperTarget);
  rec.sampleError('state tampering under approved escalation', tamperState);
  await fw.close();

  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'authorized target A / execution target B is DENIED in both matrix directions',
    actual: 'both tampering directions refused by the approval binding with audited reasons; the approved action id cannot be re-pointed',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
