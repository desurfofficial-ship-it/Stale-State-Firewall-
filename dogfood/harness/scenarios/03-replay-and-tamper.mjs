/**
 * Scenario: replay + tampering. After a successful authorization-execution,
 * the same action id is refused; an authorization for target A cannot be
 * used to drive a mutation on target B.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock, ReplayDetectedError } from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const POLICY = [{
  name: 'update-ci-workflow',
  match: { tool: 'ops', operation: 'update_ci_workflow' },
  risk: 'HIGH',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

function conditionalExecutor(provider, targetId, changes) {
  const REF = `memory:file/${targetId}`;
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    async execute() {
      return { success: true };
    },
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === REF);
      if (!entry?.version) {
        return { condition: 'unavailable', error: `no authorized expected state for ${REF}` };
      }
      const res = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'file', resource_id: targetId },
        expected_version: entry.version,
        changes,
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: REF, observed_version: res.current_version };
    },
  };
}

export default {
  id: 'replay-and-tamper',
  title: 'Replay is refused; an authorization for one target cannot mutate another',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:10:00Z');
    const firewall = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('file', '.github/workflows/ci.yml', { content: 'jobs: build\n' }, clock.nowIso());
    provider.put('file', '.github/workflows/release.yml', { content: 'jobs: release\n' }, clock.nowIso());
    const observed = provider.get('file', '.github/workflows/ci.yml').version;

    const ciIntent = (version) => ({
      agent_id: 'ci-agent',
      tool: 'ops',
      operation: 'update_ci_workflow',
      arguments: { file: 'ci.yml' },
      dependencies: [{ source: 'memory', resource: 'file', resource_id: '.github/workflows/ci.yml', version }],
    });

    // Legitimate execution succeeds once.
    const first = await firewall.execute(
      ciIntent(observed),
      conditionalExecutor(provider, '.github/workflows/ci.yml', { content: 'jobs: build+test\n' }),
      { actionId: 'act_ci_1' },
    );
    steps.push(expectSuccess(
      first.executed && first.result?.conditional_execution === 'satisfied',
      'legitimate CI workflow edit executes once',
    ));

    // Sequential replay refused.
    let replayRefused = false;
    try {
      await firewall.execute(ciIntent(observed), conditionalExecutor(provider, '.github/workflows/ci.yml', { content: 'jobs: evil\n' }), { actionId: 'act_ci_1' });
    } catch (e) {
      replayRefused = e instanceof ReplayDetectedError;
    }
    steps.push(expectBlock(replayRefused, 'sequential replay of the consumed authorization is refused'));

    // Target tampering: authorization validated ci.yml, executor points at release.yml.
    const tampered = await firewall.execute(
      ciIntent(provider.get('file', '.github/workflows/release.yml').version === observed ? observed : provider.get('file', '.github/workflows/release.yml').version),
      conditionalExecutor(provider, '.github/workflows/release.yml', { content: 'jobs: evil\n' }),
      { actionId: 'act_ci_2' },
    );
    const releaseUntouched = String(provider.get('file', '.github/workflows/release.yml').metadata['content']).includes('release');
    steps.push(expectBlock(
      tampered.executed === false && releaseUntouched,
      'authorization for target A cannot drive a CAS on target B (ref-scoped expected state)',
      `executed=${tampered.executed} conditional=${tampered.result?.conditional_execution ?? tampered.decision?.decision}`,
    ));

    return { steps };
  },
};
