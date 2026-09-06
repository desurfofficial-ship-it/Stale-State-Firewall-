/**
 * Scenario: stale deploy-config edit (operationalization §14 — stale state).
 *
 * Realistic action: an agent updates `configs/deploy.yaml` (replicas bump)
 * after reading it. Another engineer (concurrent actor) changes the file
 * between the agent's observation and the mutation. The provider-enforced
 * CAS must refuse; the recovery contract must say what to do; a blind
 * replay must be refused; a fresh re-authorization must succeed.
 */

import {
  StaleStateFirewall,
  MemoryStore,
  InMemoryStateProvider,
  ManualClock,
  ReplayDetectedError,
  refKey,
} from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const FILE_REF = 'memory:file/configs/deploy.yaml';
const POLICY = [{
  name: 'update-deploy-config',
  match: { tool: 'ops', operation: 'update_deploy_config' },
  risk: 'HIGH',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

function intent(version, replicas) {
  return {
    agent_id: 'deploy-agent',
    tool: 'ops',
    operation: 'update_deploy_config',
    arguments: { replicas },
    dependencies: [{ source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml', version }],
  };
}

function executor(provider) {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    async execute() {
      return { success: true };
    },
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === FILE_REF);
      if (!entry?.version) return { condition: 'unavailable', error: 'no authorized expected state' };
      const res = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml' },
        expected_version: entry.version,
        changes: { content: `service: api\nreplicas: ${_intent.arguments['replicas']}\n` },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: FILE_REF, observed_version: res.current_version, error: `provider refused: file at ${res.current_version}, authorized ${entry.version}` };
    },
  };
}

export default {
  id: 'stale-config-edit',
  title: 'Stale deploy-config edit is refused by the provider CAS; recovery is actionable',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:00:00Z');
    const firewall = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('file', 'configs/deploy.yaml', { content: 'service: api\nreplicas: 2\n' }, clock.nowIso());
    const observed = provider.get('file', 'configs/deploy.yaml').version;

    // Concurrent actor changes the file AFTER authorization is issued but
    // BEFORE the conditional mutation reaches the provider.
    const ex = executor(provider);
    const realCas = ex.conditionalExecute.bind(ex);
    ex.conditionalExecute = async (i, expectedState) => {
      provider.mutate('file', 'configs/deploy.yaml', { content: 'service: api\nreplicas: 9 # hotfix by human\n' }, clock.nowIso());
      return realCas(i, expectedState);
    };

    const outcome = await firewall.execute(intent(observed, 3), ex);
    steps.push(expectBlock(
      outcome.executed === false && outcome.result?.conditional_execution === 'failed' &&
        provider.get('file', 'configs/deploy.yaml').metadata['content'].includes('hotfix'),
      'stale conditional edit refused by provider; human edit preserved',
      `executed=${outcome.executed} conditional=${outcome.result?.conditional_execution} failed_ref=${outcome.result?.recovery ? outcome.result.error.slice(0, 60) : 'n/a'}`,
    ));

    const recovery = outcome.result?.recovery;
    steps.push(expectSuccess(
      recovery?.failure_kind === 'condition_failed' &&
        recovery?.retry_safety === 'SAFE_ONLY_AFTER_FRESH_EVALUATION' &&
        recovery?.side_effect_possible === false &&
        /new authorization/i.test(recovery?.next_steps?.join(' ') ?? ''),
      'recovery contract answers: what happened, retry only after fresh evaluation',
      `kind=${recovery?.failure_kind} safety=${recovery?.retry_safety}`,
    ));

    // Same authorization cannot be replayed.
    let replayRefused = false;
    try {
      await firewall.execute(intent(observed, 3), executor(provider), { actionId: outcome.decision.action_id });
    } catch (e) {
      replayRefused = e instanceof ReplayDetectedError;
    }
    steps.push(expectBlock(replayRefused, 'blind replay of the refused authorization is refused (ReplayDetectedError)'));

    // Fresh observation -> new authorization -> the edit applies.
    const fresh = provider.get('file', 'configs/deploy.yaml').version;
    const freshOutcome = await firewall.execute(intent(fresh, 3), executor(provider), { actionId: 'act_stale_fresh' });
    steps.push(expectSuccess(
      freshOutcome.executed === true && freshOutcome.result?.conditional_execution === 'satisfied' &&
        String(provider.get('file', 'configs/deploy.yaml').metadata['content']).includes('replicas: 3'),
      'fresh re-evaluation produces a new authorization and the edit applies',
      `conditional=${freshOutcome.result?.conditional_execution} content=${String(provider.get('file', 'configs/deploy.yaml').metadata['content']).replace(/\n/g, ' ')}`,
    ));

    // refKey is now a runtime helper and matches expectedState entries.
    steps.push(expectSuccess(
      refKey({ source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml' }) === FILE_REF,
      'refKey runtime helper matches expectedState ref format',
    ));

    return { steps };
  },
};
