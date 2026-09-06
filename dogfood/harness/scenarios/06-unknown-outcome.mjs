/**
 * Scenario: unknown execution outcome. The conditional request is sent and
 * the side effect MAY have applied, but the response is lost (executor
 * throws mid-flight). The firewall must record an explicit UNKNOWN — never
 * success, never "not executed" — with UNSAFE retry guidance, and the
 * authorization must be unusable afterwards.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock, ReplayDetectedError } from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const POLICY = [{
  name: 'update-deploy-config',
  match: { tool: 'ops', operation: 'update_deploy_config' },
  risk: 'HIGH',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

export default {
  id: 'unknown-outcome',
  title: 'Lost response after send: explicit UNKNOWN outcome, unsafe retry, replay refused',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:25:00Z');
    const firewall = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('file', 'configs/deploy.yaml', { content: 'replicas: 2\n' }, clock.nowIso());
    const observed = provider.get('file', 'configs/deploy.yaml').version;

    // The executor applied the mutation, then the "response" was lost.
    const executor = {
      idempotency: 'non_idempotent',
      atomicity: 'guaranteed',
      async execute() {
        return { success: true };
      },
      conditionalExecutionSupported: () => true,
      async conditionalExecute(_i, expectedState) {
        const entry = expectedState.find((e) => e.ref === 'memory:file/configs/deploy.yaml');
        await provider.conditionalExecute({
          ref: { source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml' },
          expected_version: entry.version,
          changes: { content: 'replicas: 5\n' },
        });
        throw new Error('connection reset before response'); // the lost response
      },
    };

    const intent = {
      agent_id: 'deploy-agent',
      tool: 'ops',
      operation: 'update_deploy_config',
      arguments: { replicas: 5 },
      dependencies: [{ source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml', version: observed }],
    };

    const outcome = await firewall.execute(intent, executor);
    const sideEffectApplied = String(provider.get('file', 'configs/deploy.yaml').metadata['content']).includes('replicas: 5');

    steps.push(expectBlock(
      outcome.result?.success === false && outcome.result?.conditional_execution === 'unknown',
      'recorded as explicit UNKNOWN (never success, never "not executed")',
      `success=${outcome.result?.success} conditional=${outcome.result?.conditional_execution}`,
    ));

    steps.push(expectSuccess(
      sideEffectApplied === true && outcome.result?.recovery?.side_effect_possible === true,
      'divergence surfaced honestly: the effect landed but the firewall claims no success',
    ));

    const recovery = outcome.result?.recovery;
    steps.push(expectSuccess(
      recovery?.failure_kind === 'unknown_execution_outcome' &&
        recovery?.retry_safety === 'UNSAFE' &&
        /inspect the external system/i.test(recovery?.next_steps?.join(' ') ?? '') &&
        /do not retry/i.test(recovery?.next_steps?.join(' ') ?? ''),
      'recovery contract: do NOT retry, inspect external state, then new authorization',
      `kind=${recovery?.failure_kind} safety=${recovery?.retry_safety}`,
    ));

    let replayRefused = false;
    try {
      await firewall.execute(intent, executor, { actionId: outcome.decision.action_id });
    } catch (e) {
      replayRefused = e instanceof ReplayDetectedError;
    }
    steps.push(expectBlock(replayRefused, 'the unknown-outcome authorization cannot be replayed'));

    // Metrics expose the unknown-outcome rate locally (§25).
    steps.push(expectSuccess(
      firewall.getMetrics().counters['executions_unknown_outcome'] === 1,
      'unknown-outcome counter visible in local metrics',
    ));

    return { steps };
  },
};
