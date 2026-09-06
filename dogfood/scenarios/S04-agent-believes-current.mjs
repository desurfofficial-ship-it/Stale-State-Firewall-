#!/usr/bin/env node
/**
 * S04 — AGENT THINKS IT IS STILL RIGHT (dogfood spec §8)
 *
 * The agent observes X, reasons from X, the world changes to Y, and the
 * agent still believes X is current. The firewall must be the boundary
 * between agent BELIEF and AUTHORITATIVE external state.
 *
 * Sub-cases:
 *  (1) pure belief: the agent's claimed VERSION is still correct (no drift)
 *      but its claimed field values are wrong (it believes canary is off).
 *      Only the precondition route can catch this: the firewall must evaluate
 *      the precondition against FETCHED state, never the agent's metadata.
 *  (2) stale belief: the world changed (version drifted) before execute()
 *      -> the firewall refuses the stale observation outright.
 *  (3) belief held into execution: the world changes between authorization
 *      and the provider CAS — the provider refuses.
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, auditEvents, conditionalExecutorFor, refKeyOf,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S04', 'Agent believes it is still right — firewall separates belief from authoritative state');

try {
  const provider = new InMemoryStateProvider('ops');
  provider.put('deployment_policy', 'default', { canary_required: false, window: 'business-hours' }, new Date().toISOString());
  provider.put('image_tag', 'api', { tag: '1.2.3' }, new Date().toISOString());
  provider.put('deployment', 'api/staging', { status: 'idle' }, new Date().toISOString());

  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'deploy-to-staging',
        match: { tool: 'deploy', operation: 'deploy*' },
        risk: 'CRITICAL',
        freshness: { strategy: 'version' },
        preconditions: [
          { field: 'canary_required', operator: 'equals', value: false, dependency: 'ops:deployment_policy/default' },
        ],
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  const deployExecutor = conditionalExecutorFor(provider, {
    writes: [refKeyOf({ source: 'ops', resource: 'deployment', resource_id: 'api/staging' })],
    changesOf: (intent) => ({ status: 'deploying', image: intent.arguments['image'] }),
  });

  // ---- (1) pure belief: correct version, wrong field belief -----------------
  // World truth: canary_required = true (already flipped BEFORE the agent even
  // observed — the agent simply mis-read the flag and now "believes" false).
  provider.mutate('deployment_policy', 'default', { canary_required: true }, new Date().toISOString());
  const policyTruth = provider.get('deployment_policy', 'default');
  const deploymentTruth = provider.get('deployment', 'api/staging');

  const o1 = await rec.step('(1) agent executes believing canary_required=false (version claimed is CURRENT)', () =>
    fw.execute(
      {
        agent_id: 'deploy-agent', tool: 'deploy', operation: 'deploy_staging',
        target: 'api/staging',
        arguments: { image: 'registry/api:1.2.3', believed_canary: false },
        dependencies: [
          // agent claims the CURRENT version but LYING field metadata
          { source: 'ops', resource: 'deployment_policy', resource_id: 'default', version: policyTruth.version, metadata: { canary_required: false } },
          { source: 'ops', resource: 'deployment', resource_id: 'api/staging', version: deploymentTruth.version, metadata: { ...deploymentTruth.metadata } },
        ],
      },
      deployExecutor,
      { actionId: 'act_s04_belief' },
    ));
  rec.recordTelemetryForOutcome(o1, 'memory', 'CRITICAL', { case: 'pure-belief' });

  assertEqual(o1.executed, false, 'deploy must not execute against flipped policy');
  assertEqual(o1.decision.decision, 'DENY', 'decision must be DENY');
  const reason = String(o1.decision.reason);
  assert(reason.toLowerCase().includes('canary') || reason.toLowerCase().includes('precondition'), `reason must name the failed invariant, got: ${reason}`);
  rec.observe(`decision reason: ${reason.slice(0, 170)}`);
  rec.observe('the agent’s CLAIMED metadata (canary_required=false) was ignored; the precondition was evaluated against fetched state');
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'precondition evaluated against authoritative state, not the agent’s claim');

  const tail1 = await fw.auditTail(20);
  assertEqual(auditEvents(tail1, 'action.executed').length, 0, 'no executed event for the blocked deploy');
  rec.sampleError('agent believed canary not required', new Error(o1.decision.reason));

  // ---- (2) stale belief: world changes BEFORE execute -----------------------
  const policyAt = provider.get('deployment_policy', 'default');
  const imgBefore = provider.get('image_tag', 'api');
  provider.mutate('deployment_policy', 'default', { window: 'frozen' }, new Date().toISOString());
  provider.mutate('image_tag', 'api', { tag: '1.2.4' }, new Date().toISOString());
  rec.observe('world changed: policy frozen, image tag moved 1.2.3 -> 1.2.4 — agent still acts on its old observations');

  const o2 = await rec.step('(2) agent executes with pre-change observations', () =>
    fw.execute(
      {
        agent_id: 'deploy-agent', tool: 'deploy', operation: 'deploy_staging',
        target: 'api/staging',
        arguments: { image: 'registry/api:1.2.3' },
        dependencies: [
          { source: 'ops', resource: 'deployment_policy', resource_id: 'default', version: policyAt.version, metadata: { canary_required: false } },
          { source: 'ops', resource: 'image_tag', resource_id: 'api', version: imgBefore.version, metadata: { tag: '1.2.3' } },
          { source: 'ops', resource: 'deployment', resource_id: 'api/staging', version: deploymentTruth.version, metadata: { ...deploymentTruth.metadata } },
        ],
      },
      deployExecutor,
      { actionId: 'act_s04_version' },
    ));
  rec.recordTelemetryForOutcome(o2, 'memory', 'CRITICAL', { case: 'stale-belief' });
  assertEqual(o2.executed, false, 'stale-observation deploy must not execute');
  rec.observe(`decision: ${o2.decision.decision} — ${String(o2.decision.reason).slice(0, 150)}`);
  const imageVerdict = o2.decision.verdicts.find((v) => v.dependency.resource === 'image_tag');
  rec.observe(`image_tag verdict: ${imageVerdict?.staleness} — the stale observation was refused, fresh evaluation required`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'stale observations are refused at validation; no silent re-base, no execution');

  // ---- (3) belief held into the CAS window ----------------------------------
  provider.mutate('deployment_policy', 'default', { canary_required: false }, new Date().toISOString()); // policy back to deployable
  const obs = provider.get('deployment', 'api/staging');
  const hooked = {
    ...deployExecutor,
    async conditionalExecute(intent, expectedState) {
      provider.mutate('deployment', 'api/staging', { status: 'external-rollback' }, new Date().toISOString());
      rec.observe('world changed (external rollback) between authorization and CAS');
      return deployExecutor.conditionalExecute(intent, expectedState);
    },
  };
  const o3 = await rec.step('(3) agent executes while the world flips mid-flight', () =>
    fw.execute(
      {
        agent_id: 'deploy-agent', tool: 'deploy', operation: 'deploy_staging',
        arguments: { image: 'registry/api:1.2.4' },
        dependencies: [{ source: 'ops', resource: 'deployment', resource_id: 'api/staging', version: obs.version }],
      },
      hooked,
      { actionId: 'act_s04_cas' },
    ));
  rec.recordTelemetryForOutcome(o3, 'memory', 'CRITICAL', { case: 'cas-window' });
  assertEqual(o3.result?.conditional_execution, 'failed', 'provider must refuse the mid-flight stale deploy');
  assertEqual(provider.get('deployment', 'api/staging').metadata['status'], 'external-rollback', 'external rollback survives');
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'provider CAS refused; the rollback state was preserved');

  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'the firewall blocks every action built on belief rather than authoritative state, in all three windows',
    actual: 'precondition DENY on wrong field belief (claim ignored), stale-observation refusal, provider CAS refused the mid-flight deploy',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
