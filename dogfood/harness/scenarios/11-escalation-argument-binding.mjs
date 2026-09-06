/**
 * Scenario: escalation approval binding (dogfood DF-3). A human approves an
 * escalated destructive action; resubmitting it with DIFFERENT arguments
 * must not inherit the approval.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock } from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const POLICY = [{
  name: 'purge-table',
  match: { tool: 'db', operation: 'purge_table' },
  risk: 'CRITICAL',
  freshness: { strategy: 'version' },
  on_unknown: 'escalate',
}];

export default {
  id: 'escalation-argument-binding',
  title: 'Human approval binds to the approved arguments; swapped arguments are refused (DF-3)',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:40:00Z');
    const firewall = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    // An unverifiable dependency forces the ESCALATE path the public way.
    const escIntent = {
      agent_id: 'db-agent',
      tool: 'db',
      operation: 'purge_table',
      arguments: { table: 'users', mode: 'single-row', row: 42 },
      dependencies: [{ source: 'unreachable', resource: 'x', resource_id: 'y' }],
    };
    const plainExecutor = { idempotency: 'non_idempotent', execute: async () => ({ success: true }) };

    const outcome = await firewall.execute(escIntent, plainExecutor, { actionId: 'act_purge' });
    const pending = await firewall.listEscalations('PENDING');
    const actionId = pending[0]?.action_id;
    steps.push(expectSuccess(
      outcome.decision.decision === 'ESCALATE' && Boolean(actionId),
      'destructive action on unverifiable state is held for human approval',
    ));

    await firewall.resolveEscalation(actionId, { approved: true, by: 'human-on-call', note: 'row 42 only' });

    // Tampered arguments must NOT inherit the approval.
    let smuggled = false;
    let refused = false;
    try {
      await firewall.executeApproved(
        actionId,
        { ...escIntent, arguments: { table: 'users', mode: 'full-table', row: null } },
        { idempotency: 'non_idempotent', execute: async () => { smuggled = true; return { success: true }; } },
      );
    } catch {
      refused = true;
    }
    steps.push(expectBlock(
      refused && !smuggled,
      'approved escalation cannot be executed with swapped arguments (approval binds the payload)',
    ));

    // The identical resubmission passes the binding (then fails closed at
    // state re-verification — an approval cannot conjure state).
    const legit = await firewall.executeApproved(actionId, escIntent, plainExecutor);
    steps.push(expectBlock(
      legit.executed === false && legit.decision.decision === 'DENY',
      'identical resubmission passes the binding but STILL fails closed on unverifiable state',
      `decision=${legit.decision.decision}`,
    ));

    await firewall.close();
    return { steps };
  },
};
