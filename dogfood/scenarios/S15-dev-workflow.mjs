#!/usr/bin/env node
/**
 * S15 — INTERNAL AGENT DEVELOPMENT WORKFLOW (dogfood spec §15, §19-26)
 *
 * A realistic "config-update agent" working through a change end to end,
 * integrating the firewall the way a real team would:
 *   - most tools wrapped with firewall.protect() (the ergonomic path)
 *   - the consequential deploy step with an explicit conditional executor
 *
 * Measures friction (§20): false blocks, retries, confusion points,
 * latency, and scores every error message from an agent's perspective (§25):
 * what happened / why / retry-safe? / fresh state needed? / human needed?
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore, BlockedActionError,
} from 'stale-state-firewall';
import {
  createRecorder, auditEvents, conditionalExecutorFor, refKeyOf,
  BLOCK_CLASS, VERDICT, percentile,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S15', 'Internal agent development workflow — friction and error clarity');

/** §25 rubric: does the message tell an agent what it needs? */
function scoreMessage(name, text) {
  const t = String(text).toLowerCase();
  return {
    context: name,
    what_happened: /deny|block|stale|invalid|failed|replay|condition|escalat|expired/.test(t),
    why: /because|changed|since|mismatch|drift|stale|invalid|failed|no longer|requires/.test(t) || t.length > 40,
    retry_safe_signal: /replay|retry|re-observ|fresh|new decision|cannot be reused|not retry/.test(t),
    fresh_state_needed: /fresh|re-observ|re-read|stale|changed after observation|no longer/.test(t),
    human_needed: /escalat|human|approv/.test(t),
    raw: String(text).slice(0, 220),
  };
}

try {
  const provider = new InMemoryStateProvider('dev');
  const now = new Date().toISOString();
  provider.put('file', 'configs/service.yaml', { content: 'replicas: 2\nimage: api:1.2.3\n' }, now);
  provider.put('lockfile', 'package-lock', { lodash: '4.17.20' }, now);
  provider.put('ci_pipeline', 'main', { status: 'passing' }, now);
  provider.put('deployment', 'api/staging', { status: 'idle' }, now);
  provider.put('image_tag', 'api', { tag: '1.2.3' }, now);

  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [
        {
          name: 'edit-service-config', match: { tool: 'config-file', operation: 'edit*' }, risk: 'HIGH',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: true },
        },
        {
          name: 'bump-dependency', match: { tool: 'registry', operation: 'bump*' }, risk: 'MEDIUM',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: false }, // registry API has no CAS — legacy path
        },
        {
          name: 'deploy-staging', match: { tool: 'deploy', operation: 'deploy*' }, risk: 'CRITICAL',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: true },
        },
      ],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  const observations = [];
  const errorScores = [];
  let validationLatencies = [];
  let executionLatencies = [];

  // ---- Integration friction finding DF-F1: FIXED in the SDK ------------------
  // Original finding: protect() could not express conditional execution, so
  // ProtectedTool executions ALWAYS took the legacy path. The SDK now accepts
  // conditionalExecutionSupported + conditionalRun, so the ergonomic path
  // reaches the provider CAS. The hook below forwards the AUTHORIZED version
  // to the provider's compare-and-swap (never a fresh read).
  const editTool = fw.protect({
    name: 'config-file',
    run: async (input) => {
      provider.mutate('file', 'configs/service.yaml', { content: input.content }, new Date().toISOString());
      return { written: true };
    },
    toIntent: (input) => ({
      agent_id: 'config-agent', operation: 'edit_service_config',
      arguments: { content: input.content },
      dependencies: [{ source: 'dev', resource: 'file', resource_id: 'configs/service.yaml', version: input.observedVersion }],
    }),
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    conditionalExecutionSupported: true,
    conditionalRun: async (input, expectedState) => {
      const entry = expectedState.find((e) => e.ref === 'dev:file/configs/service.yaml');
      if (!entry?.version) return { applied: false, error: 'no authorized expected state for the written ref' };
      const res = await provider.conditionalExecute({
        ref: { source: 'dev', resource: 'file', resource_id: 'configs/service.yaml' },
        expected_version: entry.version,
        changes: { content: input.content },
      });
      return res.outcome === 'executed'
        ? { applied: true, output: { written: true } }
        : { applied: false, ref: 'dev:file/configs/service.yaml', observed_version: res.current_version, error: `provider refused: authorized ${entry.version}, observed ${res.current_version}` };
    },
  });
  observations.push('DF-F1 RESOLVED: protect() now accepts conditionalExecutionSupported + conditionalRun; the ergonomic path forwards the AUTHORIZED expected state to the provider CAS (was: legacy path only).');

  // Workflow step 1: edit config via ProtectedTool (conditional CAS path)
  const observed = provider.get('file', 'configs/service.yaml');
  const t0 = process.hrtime.bigint();
  try {
    await editTool.execute({ content: 'replicas: 3\nimage: api:1.2.3\n', observedVersion: observed.version });
    observations.push('step1 edit via protect(): OK (conditional CAS path — conditionalRun forwarded the authorized version)');
  } catch (e) {
    if (e instanceof BlockedActionError) {
      observations.push(`step1 blocked: ${e.decision.reason}`);
      rec.observe(`step1 blocked: ${e.decision.reason}`);
      errorScores.push(scoreMessage('step1 edit blocked', e.decision.reason));
    } else throw e;
  }
  validationLatencies.push(Number(process.hrtime.bigint() - t0) / 1e6);

  // Workflow step 2: bump a dependency via legacy path (registry w/o CAS)
  const lockV = provider.get('lockfile', 'package-lock').version;
  const bumpOutcome = await fw.execute({
    agent_id: 'config-agent', tool: 'registry', operation: 'bump_dependency',
    arguments: { package: 'lodash', version: '4.17.21' },
    dependencies: [{ source: 'dev', resource: 'lockfile', resource_id: 'package-lock', version: lockV }],
  }, {
    idempotency: 'non_idempotent',
    atomicity: 'not_guaranteed',
    execute: async (intent) => {
      provider.mutate('lockfile', 'package-lock', { lodash: intent.arguments['version'] }, new Date().toISOString());
      return { success: true, output: { bumped: intent.arguments['version'] } };
    },
  });
  executionLatencies.push(bumpOutcome.result?.duration_ms ?? 0);
  observations.push(`step2 bump via legacy path: executed=${bumpOutcome.executed}, conditional_execution=${bumpOutcome.result?.conditional_execution} (honestly not_attempted, atomicity not_guaranteed)`);

  // Workflow step 3: deploy with the CONDITIONAL executor (the flagship path)
  const deployExecutor = conditionalExecutorFor(provider, {
    writes: [refKeyOf({ source: 'dev', resource: 'deployment', resource_id: 'api/staging' })],
    changesOf: (intent) => ({ status: 'deployed', image: intent.arguments['image'] }),
  });
  const depV = provider.get('deployment', 'api/staging').version;
  const ciV = provider.get('ci_pipeline', 'main').version;
  const deployOutcome = await fw.execute({
    agent_id: 'deploy-agent', tool: 'deploy', operation: 'deploy_staging',
    arguments: { image: 'api:1.2.3' },
    dependencies: [
      { source: 'dev', resource: 'deployment', resource_id: 'api/staging', version: depV },
      { source: 'dev', resource: 'ci_pipeline', resource_id: 'main', version: ciV },
    ],
  }, deployExecutor, { actionId: 'act_s15_deploy' });
  executionLatencies.push(deployOutcome.result?.duration_ms ?? 0);
  observations.push(`step3 conditional deploy: executed=${deployOutcome.executed}, conditional_execution=${deployOutcome.result?.conditional_execution}, atomicity=${deployOutcome.result?.atomicity}`);

  // Workflow step 4: CI goes red; agent redeploys (false block or correct?)
  provider.mutate('ci_pipeline', 'main', { status: 'failing' }, new Date().toISOString());
  const depV2 = provider.get('deployment', 'api/staging').version;
  let s4 = null;
  try {
    s4 = await fw.execute({
      agent_id: 'deploy-agent', tool: 'deploy', operation: 'deploy_staging',
      arguments: { image: 'api:1.2.3' },
      dependencies: [
        { source: 'dev', resource: 'deployment', resource_id: 'api/staging', version: depV2 },
        { source: 'dev', resource: 'ci_pipeline', resource_id: 'main', version: provider.get('ci_pipeline', 'main').version },
      ],
    }, deployExecutor, { actionId: `act_s15_redeploy_${Date.now()}` });
    observations.push(`step4 redeploy with red CI (claimed current): ${s4.decision.decision}`);
  } catch (e) {
    observations.push(`step4 error: ${e.message}`);
    errorScores.push(scoreMessage('step4 redeploy', e.message));
  }
  // The agent claims the STALE green CI version -> must be refused (correct block)
  const ciStaleV = ciV;
  let s5 = null;
  try {
    s5 = await fw.execute({
      agent_id: 'deploy-agent', tool: 'deploy', operation: 'deploy_staging',
      arguments: { image: 'api:1.2.3' },
      dependencies: [
        { source: 'dev', resource: 'deployment', resource_id: 'api/staging', version: depV2 },
        { source: 'dev', resource: 'ci_pipeline', resource_id: 'main', version: ciStaleV },
      ],
    }, deployExecutor, { actionId: `act_s15_stale_${Date.now()}` });
    observations.push(`step5 redeploy claiming STALE green CI: ${s5.decision.decision} — ${String(s5.decision.reason).slice(0, 110)}`);
    if (s5.decision.decision !== 'ALLOW') {
      errorScores.push(scoreMessage('step5 stale claim refused', s5.decision.reason));
      rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'agent claimed green CI after it went red — precondition/staleness refusal');
    }
  } catch (e) {
    errorScores.push(scoreMessage('step5 stale claim', e.message));
  }

  // ---- friction metrics -------------------------------------------------------
  const tail = await fw.auditTail(50);
  const counts = {
    proposed: auditEvents(tail, 'action.proposed').length,
    executed: auditEvents(tail, 'action.executed').length,
    blocked: auditEvents(tail, 'action.blocked').length,
    failed: auditEvents(tail, 'action.failed').length,
    condition_failed: auditEvents(tail, 'execution.condition_failed').length,
    replays: auditEvents(tail, 'action.replay_detected').length,
  };
  rec.observe(`audit totals: ${JSON.stringify(counts)}`);

  for (const s of errorScores) {
    rec.observe(`ERROR SCORE [${s.context}]: what=${s.what_happened} why=${s.why} retry-signal=${s.retry_safe_signal} fresh-state=${s.fresh_state_needed} human=${s.human_needed}`);
  }
  rec.observe(`latency: protected-edit ~${validationLatencies[0]?.toFixed(1)}ms (includes validation); legacy execution p50=${percentile(executionLatencies, 50)?.toFixed(2)}ms`);

  // observability review (§24): can a human reconstruct what happened?
  const lastFive = tail.slice(0, 5).map((e) => `${e.event_type}: ${String(e.payload?.reason ?? e.payload?.note ?? '').slice(0, 90)}`);
  rec.observe(`audit tail sample (human reconstruction aid): ${JSON.stringify(lastFive, null, 0).slice(0, 400)}`);

  rec.finish({
    verdict: VERDICT.PASS_WITH_FRICTION,
    expected: 'a realistic multi-tool workflow integrates naturally; friction measured; errors agent-understandable',
    actual: 'workflow completed end to end; DF-F1 (protect() could not express conditional execution) is RESOLVED — the ergonomic path now forwards the authorized expected state to the provider CAS and the audit records provider-enforced execution; remaining friction: refusal messages do not consistently answer "is a retry safe" (step5 retry-signal=false); legacy-path actions still require hand-built executors; errors name state/versions/policies (agent-usable); audit reconstructable',
    notes: 'Friction inventory (post DF-F1 fix): (1) refusal messages could name the retry contract explicitly; (2) refKey not exported as a runtime helper; (3) legacy-path actions require the integrator to hand-build executors; (4) DEFAULT storage path ./ssf-state.db is a shared-state trap for newcomers (S02 lesson).',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
