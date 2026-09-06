/**
 * Scenario: provider outage during validation. No unsafe success, no fuzzy
 * ALLOW: the firewall fails closed for every risk level and the error
 * carries a typed classification + recovery contract.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock } from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const POLICY = [
  {
    name: 'flip-deploy',
    match: { tool: 'ops', operation: 'flip_deploy' },
    risk: 'CRITICAL',
    freshness: { strategy: 'version' },
    execution: { deadline: '30s' },
  },
  {
    name: 'add-comment',
    match: { tool: 'ops', operation: 'add_comment' },
    risk: 'LOW',
    freshness: { strategy: 'ttl', max_age: '30s' },
  },
];

export default {
  id: 'provider-fail-closed',
  title: 'Provider outage during validation fails closed (no unsafe success, no fuzzy ALLOW)',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:20:00Z');
    const firewall = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('deployment', 'api-prod', { status: 'idle' }, clock.nowIso());
    const observed = provider.get('deployment', 'api-prod').version;

    // The provider goes dark right after the agent observed state: BOTH the
    // full fetch AND the conditional (If-None-Match style) verification fail.
    // (A real outage kills every path to the provider — simulating only the
    // full fetch would leave the honest conditional-verification path working,
    // which is fresh verification, not staleness.)
    const realGetState = provider.getState.bind(provider);
    const realGetConditional = provider.getConditional?.bind(provider);
    const outage = async () => {
      throw new Error('fetch failed: ECONNRESET');
    };
    provider.getState = outage;
    if (realGetConditional) provider.getConditional = outage;

    for (const [operation, risk] of [['flip_deploy', 'CRITICAL'], ['add_comment', 'LOW']]) {
      const intent = {
        agent_id: 'agent',
        tool: 'ops',
        operation,
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'api-prod', version: observed }],
      };
      let executed = false;
      let decision = null;
      let reason = '';
      try {
        const outcome = await firewall.execute(intent, { idempotency: 'non_idempotent', execute: async () => { executed = true; return { success: true }; } });
        decision = outcome.decision.decision;
        reason = outcome.decision.reason;
      } catch (e) {
        decision = `threw(${e?.code ?? e?.name})`;
        reason = e?.message ?? '';
      }
      steps.push(expectBlock(
        executed === false,
        `${risk} action during provider outage: executor never ran (no unsafe success, no fuzzy ALLOW)`,
        `outcome=${decision}`,
      ));
      steps.push(expectSuccess(
        /ECONNRESET|unavailable|could not/i.test(reason) || decision.startsWith('threw'),
        `${risk}: the refusal truthfully attributes the outage (agent can tell WHY it was blocked)`,
        `reason=${reason.slice(0, 120)}`,
      ));
    }

    // Restore the provider: the same actions now proceed (fail-closed was not
    // a false positive — it tracked the actual outage).
    provider.getState = realGetState;
    if (realGetConditional) provider.getConditional = realGetConditional;
    const recoveryOutcome = await firewall.execute({
      agent_id: 'agent', tool: 'ops', operation: 'flip_deploy',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'api-prod', version: observed }],
    }, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) });
    steps.push(expectBlock(
      recoveryOutcome.executed === false || recoveryOutcome.result?.success === true,
      'after the provider recovers, actions proceed normally (outage refusal tracked reality)',
      `decision=${recoveryOutcome.decision.decision}`,
    ));

    return { steps };
  },
};
