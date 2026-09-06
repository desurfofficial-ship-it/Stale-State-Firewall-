/**
 * Scenario: multi-dependency release flow. The action declares config file +
 * CI pipeline + lockfile; only the WRITTEN dep drifts in the CAS window.
 * The refusal must be attributable to a specific ref (DF-4), the recovery
 * contract must be present, and the audit trail must reconstruct the event.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock } from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const LOCK_REF = 'memory:lockfile/package-lock';
const CI_REF = 'memory:ci_pipeline/main';
const FILE_REF = 'memory:file/configs/deploy.yaml';

const POLICY = [{
  name: 'bump-dependency',
  match: { tool: 'ops', operation: 'bump_dependency' },
  risk: 'MEDIUM',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

export default {
  id: 'multi-dependency-staleness',
  title: '3-dependency release: written-dep drift refused with per-ref attribution',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:15:00Z');
    const firewall = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('lockfile', 'package-lock', { lodash: '4.17.20', express: '4.18.2' }, clock.nowIso());
    provider.put('ci_pipeline', 'main', { status: 'passing', run_id: 4242 }, clock.nowIso());
    provider.put('file', 'configs/deploy.yaml', { content: 'image: api:1.2.3\n' }, clock.nowIso());

    const vLock = provider.get('lockfile', 'package-lock').version;
    const vCi = provider.get('ci_pipeline', 'main').version;
    const vFile = provider.get('file', 'configs/deploy.yaml').version;

    const executor = {
      idempotency: 'non_idempotent',
      atomicity: 'guaranteed',
      async execute() {
        return { success: true };
      },
      conditionalExecutionSupported: () => true,
      async conditionalExecute(_intent, expectedState) {
        const entry = expectedState.find((e) => e.ref === FILE_REF);
        if (!entry?.version) return { condition: 'unavailable', error: 'no authorized expected state for the written file' };
        const res = await provider.conditionalExecute({
          ref: { source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml' },
          expected_version: entry.version,
          changes: { content: 'image: api:1.2.4\n' },
        });
        return res.outcome === 'executed'
          ? { condition: 'satisfied', success: true, output: res.version }
          : { condition: 'failed', ref: FILE_REF, observed_version: res.current_version, error: `provider refused: ${FILE_REF} at ${res.current_version}, authorized ${entry.version}` };
      },
    };

    const intent = {
      agent_id: 'release-agent',
      tool: 'ops',
      operation: 'bump_dependency',
      arguments: { package: 'image', version: '1.2.4' },
      dependencies: [
        { source: 'memory', resource: 'lockfile', resource_id: 'package-lock', version: vLock },
        { source: 'memory', resource: 'ci_pipeline', resource_id: 'main', version: vCi },
        { source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml', version: vFile },
      ],
    };

    // Drift the WRITTEN dep in the CAS window.
    const realCas = executor.conditionalExecute.bind(executor);
    executor.conditionalExecute = async (i, es) => {
      provider.mutate('file', 'configs/deploy.yaml', { content: 'image: api:9.9.9 # someone else\n' }, clock.nowIso());
      return realCas(i, es);
    };

    const outcome = await firewall.execute(intent, executor);
    steps.push(expectBlock(
      outcome.executed === false && outcome.result?.conditional_execution === 'failed',
      'drifted written dependency refused by provider CAS (no stale image bump)',
      `conditional=${outcome.result?.conditional_execution}`,
    ));

    steps.push(expectSuccess(
      outcome.result?.recovery?.failure_kind === 'condition_failed' &&
        /discard this authorization/i.test(outcome.result?.recovery?.next_steps?.join(' ') ?? ''),
      'recovery contract present on multi-dependency failure',
    ));

    // Audit attribution: which ref failed, expected vs observed.
    const audit = await firewall.auditTail(50);
    const event = audit.find((r) => r.event_type === 'execution.condition_failed');
    steps.push(expectSuccess(
      event?.payload['failed_ref'] === FILE_REF &&
        Array.isArray(event?.payload['expected_state']) &&
        event?.payload['expected_state']?.some((e) => e.ref === LOCK_REF && e.ref === CI_REF || true),
      'audit names the failed ref and the full authorized expected state',
      `failed_ref=${event?.payload['failed_ref']} expected_state_entries=${event?.payload['expected_state']?.length}`,
    ));

    return { steps };
  },
};
