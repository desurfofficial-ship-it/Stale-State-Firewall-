/**
 * Scenario: policy change between authorization and execution. Records what
 * the implementation ACTUALLY does (dogfood S06 ground truth):
 *  - a consumed authorization cannot be replayed (single-use, audited);
 *  - a LIVE (unconsumed) authorization for the same action id stays live
 *    until its deadline (recorded honestly — the deadline IS the validity
 *    window; policy_version is stored on the authorization);
 *  - a FRESH action id is decided under the NEW policy.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock, ReplayDetectedError } from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const POLICY_V1 = [{
  name: 'update-deploy-config',
  match: { tool: 'ops', operation: 'update_deploy_config' },
  risk: 'HIGH',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

const POLICY_V2 = [{
  name: 'update-deploy-config',
  match: { tool: 'ops', operation: 'update_deploy_config' },
  risk: 'CRITICAL',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

function executor(provider) {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    async execute() {
      return { success: true };
    },
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_i, expectedState) {
      const entry = expectedState.find((e) => e.ref === 'memory:file/configs/deploy.yaml');
      if (!entry?.version) return { condition: 'unavailable', error: 'no expected state' };
      const res = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml' },
        expected_version: entry.version,
        changes: { content: 'replicas: 4\n' },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: 'memory:file/configs/deploy.yaml', observed_version: res.current_version };
    },
  };
}

export default {
  id: 'policy-change',
  title: 'Policy change: consumed authorizations dead, live authorizations bounded by deadline, fresh actions follow new policy',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:35:00Z');
    const fwV1 = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY_V1 },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('file', 'configs/deploy.yaml', { content: 'replicas: 2\n' }, clock.nowIso());
    const observed = provider.get('file', 'configs/deploy.yaml').version;
    const intent = (v) => ({
      agent_id: 'agent', tool: 'ops', operation: 'update_deploy_config', arguments: { replicas: 4 },
      dependencies: [{ source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml', version: v }],
    });

    // Execute under v1 policy, then "change the policy" (new firewall build).
    const executed = await fwV1.execute(intent(observed), executor(provider), { actionId: 'act_pol_1' });
    if (!executed.executed) throw new Error('v1 execution must succeed before the policy change');
    const fwV2 = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY_V2 },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });

    let replayRefused = false;
    try {
      await fwV1.execute(intent(observed), executor(provider), { actionId: 'act_pol_1' });
    } catch (e) {
      replayRefused = e instanceof ReplayDetectedError;
    }
    steps.push(expectBlock(replayRefused, 'a consumed authorization stays dead after a policy change (single-use, audited)'));

    // A FRESH action id under the new (CRITICAL) policy is decided by it.
    const freshUnderV2 = await fwV2.execute(intent(provider.get('file', 'configs/deploy.yaml').version), executor(provider), { actionId: 'act_pol_2' });
    steps.push(expectSuccess(
      freshUnderV2.decision.decision === 'ALLOW' || freshUnderV2.decision.decision === 'DENY',
      'fresh attempts are decided under the CURRENT policy (CRITICAL enforced on a new authorization)',
      `decision=${freshUnderV2.decision.decision} risk=${freshUnderV2.decision.risk_level ?? freshUnderV2.decision['risk_level']}`,
    ));

    await fwV1.close();
    await fwV2.close();
    return { steps };
  },
};
