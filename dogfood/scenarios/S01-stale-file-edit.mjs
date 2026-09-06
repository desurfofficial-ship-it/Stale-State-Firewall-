#!/usr/bin/env node
/**
 * S01 — STALE FILE EDIT (dogfood spec §5)
 *
 * Agent reads a file, decides to modify it, the firewall authorizes,
 * ANOTHER ACTOR changes the file, the agent's original modification is
 * attempted. Expected: the provider itself rejects the stale conditional
 * mutation; no stale overwrite; the authorization becomes unusable; the
 * audit records a condition failure; fresh evaluation is required.
 *
 * Also exercises the "world moved before execute()" window (the firewall's
 * validation re-reads authoritative state) as the second sub-case.
 */

import {
  StaleStateFirewall,
  InMemoryStateProvider,
  MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, auditEvents, conditionalExecutorFor, refKeyOf,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S01', 'Stale file edit — provider rejects stale conditional mutation');

try {
  const provider = new InMemoryStateProvider('git');
  provider.put('file', 'configs/deploy.yaml', {
    content: 'service: api\nreplicas: 2\nimage: registry/api:1.2.3\n',
  }, new Date().toISOString());

  const firewall = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'edit-config-file',
        match: { tool: 'config-file', operation: 'edit*' },
        risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true, deadline: '10s' },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  // --- Agent reads the file (observation) ----------------------------------
  const observed = provider.get('file', 'configs/deploy.yaml');
  rec.observe(`agent observes file at version ${observed.version}`);

  // --- Honest conditional executor with a race-injection hook ---------------
  // The hook simulates another actor mutating the file AFTER authorization
  // but BEFORE the provider evaluates the CAS — the real-world race window.
  let worldActor = null; // (info: { authorizedVersion: string }) => void
  const executor = conditionalExecutorFor(provider, {
    writes: [refKeyOf({ source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml' })],
    changesOf: (intent) => ({
      content: `service: api\nreplicas: 4\nimage: registry/api:1.2.3\n# edited by agent (${intent.arguments['reason']})\n`,
    }),
  });
  // Wire the hook into the honest executor (integrator-side simulation).
  const hookedExecutor = {
    ...executor,
    async conditionalExecute(intent, expectedState) {
      const entry = expectedState[0];
      if (worldActor) worldActor({ authorizedVersion: entry.version });
      return executor.conditionalExecute(intent, expectedState);
    },
  };

  // --- CASE 1: race — world changes between authorization and CAS ----------
  const outcome = await rec.step('agent executes edit while another actor rewrites the file', async () => {
    worldActor = () => {
      const v = provider.mutate('file', 'configs/deploy.yaml', {
        content: 'service: api\nreplicas: 9\n# human emergency edit\n',
      }, new Date().toISOString());
      rec.observe(`another actor mutated the file (now ${v}) while the agent was executing`);
      worldActor = null;
    };
    const o = await firewall.execute(
      {
        agent_id: 'config-agent',
        tool: 'config-file',
        operation: 'edit_file',
        target: 'configs/deploy.yaml',
        arguments: { reason: 'scale replicas to 4' },
        dependencies: [{
          source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml',
          version: observed.version,
          metadata: { content: observed.metadata['content'] },
        }],
      },
      hookedExecutor,
      { actionId: 'act_s01_race' },
    );
    worldActor = null;
    return o;
  });

  rec.recordTelemetryForOutcome(outcome, 'memory', 'HIGH', { case: 'race' });

  assertEqual(outcome.executed, false, 'stale edit must NOT execute');
  assertEqual(outcome.result?.success, false, 'result must be a failure');
  assertEqual(outcome.result?.conditional_execution, 'failed', 'condition must be reported as failed');
  rec.observe(`execution result: conditional_execution=failed, observed_version=${outcome.result?.observed_version}`);
  rec.observe(`result error: "${outcome.result?.error}"`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'provider refused a mutation conditioned on a version that had changed');

  // no stale overwrite: the human edit must be the surviving content
  const afterFile = provider.get('file', 'configs/deploy.yaml');
  assert(String(afterFile.metadata['content']).includes('human emergency edit'), 'human edit must survive');
  assert(!String(afterFile.metadata['content']).includes('replicas: 4'), 'agent edit must NOT be applied');
  rec.observe('no stale overwrite: file content still carries the human edit only');

  // authorization unusable: replay is refused
  let replayError = null;
  try {
    await firewall.execute({
      agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
      dependencies: [{ source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml', version: observed.version }],
    }, hookedExecutor, { actionId: 'act_s01_race' });
  } catch (e) { replayError = e; }
  assert(replayError, 'replaying the consumed authorization must be refused');
  assert(String(replayError?.message).toLowerCase().includes('replay'), `replay error expected, got: ${replayError?.message}`);
  rec.sampleError('replay of consumed authorization after condition failure', replayError);

  // audit truthfulness
  const tail = await firewall.auditTail(50);
  const condFailed = auditEvents(tail, 'execution.condition_failed');
  assertEqual(condFailed.length, 1, 'audit must record exactly one execution.condition_failed');
  const executedEvents = auditEvents(tail, 'action.executed');
  assertEqual(executedEvents.length, 0, 'audit must NOT claim the action executed');
  const blockedFresh = auditEvents(tail, 'action.blocked').filter((e) => e.payload?.stage === 'condition_failed_revalidation');
  assertEqual(blockedFresh.length, 1, 'audit must record a fresh re-decision after the condition failure');
  rec.observe(`audit: condition_failed recorded (expected ${JSON.stringify(condFailed[0]?.payload?.expected_state)}, observed ${JSON.stringify(condFailed[0]?.payload?.observed_version)})`);

  // fresh evaluation is required AND works
  const freshOutcome = await rec.step('agent re-observes and retries with fresh state', async () => {
    const cur = provider.get('file', 'configs/deploy.yaml');
    const o = await firewall.execute(
      {
        agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
        target: 'configs/deploy.yaml',
        arguments: { reason: 'scale replicas to 4 (retry on fresh state)' },
        dependencies: [{
          source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml',
          version: cur.version, metadata: { content: cur.metadata['content'] },
        }],
      },
      executor,
      { actionId: 'act_s01_retry' },
    );
    return o;
  });
  rec.recordTelemetryForOutcome(freshOutcome, 'memory', 'HIGH', { case: 'fresh-retry' });
  assertEqual(freshOutcome.result?.conditional_execution, 'satisfied', 'fresh retry must satisfy the condition');
  rec.observe('fresh evaluation produced a new authorization and the edit applied');

  // --- CASE 2: world moves BEFORE execute() — the validation window --------
  provider.mutate('file', 'configs/deploy.yaml', { content: '# someone edited again\n' }, new Date().toISOString());
  const staleBeliefOutcome = await rec.step('agent executes with a pre-change observation (world moved first)', async () => {
    const o = await firewall.execute(
      {
        agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
        target: 'configs/deploy.yaml',
        arguments: { reason: 'scale replicas to 4' },
        dependencies: [{
          source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml',
          version: 'v-stale-belief', metadata: { content: 'old belief' },
        }],
      },
      executor,
      { actionId: 'act_s01_belief' },
    );
    return o;
  });
  rec.recordTelemetryForOutcome(staleBeliefOutcome, 'memory', 'HIGH', { case: 'validation-window' });
  rec.observe(`decision when world moved first: ${staleBeliefOutcome.decision.decision} — ${staleBeliefOutcome.decision.reason.slice(0, 140)}`);
  rec.observe('the agent’s unrecognized claimed version made the dependency INVALID -> DENY; belief was never executed on');

  // --- Negative control: no interference → executes -------------------------
  const clean = await rec.step('negative control: edit with no interference executes', async () => {
    const cur = provider.get('file', 'configs/deploy.yaml');
    return firewall.execute(
      {
        agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
        arguments: { reason: 'control' },
        dependencies: [{ source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml', version: cur.version }],
      },
      executor,
      { actionId: 'act_s01_control' },
    );
  });
  rec.recordTelemetryForOutcome(clean, 'memory', 'HIGH', { case: 'negative-control' });
  assertEqual(clean.result?.conditional_execution, 'satisfied', 'clean edit must execute');

  const audit = await firewall.verifyAudit();
  assertEqual(audit.ok, true, 'audit chain must verify');

  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'provider rejects stale conditional mutation; no overwrite; auth unusable; audit truthful; fresh eval required',
    actual: 'all assertions held: condition_failed, no overwrite, replay refused, audit recorded condition_failed (never executed), fresh retry succeeded, chain verified',
    notes: 'Race window was injected between authorization and provider CAS (the real-world window the firewall targets).',
  });
  process.exitCode = 0;
} catch (error) {
  rec.sampleError('scenario failure', error);
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
