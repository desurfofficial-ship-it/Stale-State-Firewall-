/**
 * Scenario: two agents concurrently flip the same deployment through one
 * SHARED SQLite store (cross-connection claim race) — exactly one wins.
 */

import { StaleStateFirewall, InMemoryStateProvider, ManualClock } from 'stale-state-firewall';
import { freshDb } from '../lib.mjs';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const POLICY = [{
  name: 'flip-deploy',
  match: { tool: 'ops', operation: 'flip_deploy' },
  risk: 'CRITICAL',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

function buildExecutor(provider, color) {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    async execute() {
      return { success: true };
    },
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_i, expectedState) {
      const entry = expectedState.find((e) => e.ref === `memory:deployment/api-prod`);
      const res = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'api-prod' },
        expected_version: entry.version,
        changes: { active: color },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: 'memory:deployment/api-prod', observed_version: res.current_version };
    },
  };
}

export default {
  id: 'concurrent-deploy-flip',
  title: 'Two agents flipping one deployment on a shared store: exactly one executes',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const dbPath = freshDb('harness-concurrent.db');
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:05:00Z');
    const config = {
      firewall: { mode: 'enforce', storage: { type: 'sqlite', path: dbPath } },
      actions: POLICY,
    };
    const fwA = await StaleStateFirewall.create({ config, providers: [provider], clock });
    const fwB = await StaleStateFirewall.create({ config, providers: [provider], clock });

    provider.put('deployment', 'api-prod', { status: 'idle', active: 'blue' }, clock.nowIso());
    const observed = provider.get('deployment', 'api-prod').version;

    const intentA = {
      agent_id: 'agent-a', tool: 'ops', operation: 'flip_deploy', arguments: { color: 'green' },
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'api-prod', version: observed }],
    };
    const intentB = { ...intentA, agent_id: 'agent-b', arguments: { color: 'pink' } };

    const [a, b] = await Promise.all([
      fwA.execute(intentA, buildExecutor(provider, 'green'), { actionId: 'act_flip_a' }),
      fwB.execute(intentB, buildExecutor(provider, 'pink'), { actionId: 'act_flip_b' }),
    ]);

    const winners = [a, b].filter((o) => o.executed && o.result?.success);
    const losers = [a, b].filter((o) => !o.executed || o.result?.conditional_execution === 'failed');
    steps.push(expectSuccess(
      winners.length === 1 && losers.length === 1,
      'exactly one agent executed the flip; the other was refused',
      `winners=${winners.length} losers=${losers.length}`,
    ));

    const loser = losers[0];
    steps.push(expectBlock(
      loser?.result?.conditional_execution === 'failed' || loser?.decision?.decision === 'DENY' || loser?.decision?.decision === 'REVALIDATE',
      'the losing agent received an explainable refusal, not a silent success',
      `loser decision=${loser?.decision?.decision} conditional=${loser?.result?.conditional_execution}`,
    ));

    const serverTruth = provider.get('deployment', 'api-prod').metadata['active'];
    const winnerArg = winners[0]?.decision?.arguments?.['color'] ?? (a.executed ? 'green' : 'pink');
    steps.push(expectSuccess(
      serverTruth === winnerArg,
      'server truth matches exactly the winning claim (no double application)',
      `active=${serverTruth} winner=${winnerArg}`,
    ));

    await fwA.close();
    await fwB.close();
    return { steps };
  },
};
