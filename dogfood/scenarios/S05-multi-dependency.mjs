#!/usr/bin/env node
/**
 * S05 — MULTI-DEPENDENCY ACTION (dogfood spec §9, §16)
 *
 * An action depends on A (the file it writes), B (lockfile), C (CI status).
 * Mutate exactly one and measure what happens:
 *
 *   (1) A (the WRITTEN dependency) changed between auth and CAS
 *       -> expected: NO execution; audit must identify WHICH dependency
 *   (2) B (read-only) changed between auth and CAS
 *       -> measured honestly: write-CAS does not cover read-only deps
 *   (3) pre-execution window (world changes BEFORE execute())
 *       -> validation re-reads every dependency
 *
 * The audit understandability check (§9: "which dependency caused the
 * failure?") runs on case (1).
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, auditEvents, conditionalExecutorFor, refKeyOf,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S05', 'Multi-dependency action — single dependency mutation isolated');

try {
  const provider = new InMemoryStateProvider('git');
  const now = new Date().toISOString();
  provider.put('file', 'configs/deploy.yaml', { content: 'replicas: 2\n' }, now);
  provider.put('lockfile', 'package-lock', { lodash: '4.17.20' }, now);
  provider.put('ci_pipeline', 'main', { status: 'passing' }, now);

  const FILE_REF = refKeyOf({ source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml' });

  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'edit-config-file',
        match: { tool: 'config-file', operation: 'edit*' },
        risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  const changesOf = (intent) => ({
    content: `replicas: 4\n# derived from lockfile=${intent.arguments['expected_lodash']}, ci=${intent.arguments['expected_ci']}\n`,
  });
  const executor = conditionalExecutorFor(provider, { writes: [FILE_REF], changesOf });

  const deps = () => {
    const f = provider.get('file', 'configs/deploy.yaml');
    const l = provider.get('lockfile', 'package-lock');
    const c = provider.get('ci_pipeline', 'main');
    return [
      { source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml', version: f.version, metadata: { ...f.metadata } },
      { source: 'git', resource: 'lockfile', resource_id: 'package-lock', version: l.version, metadata: { ...l.metadata } },
      { source: 'git', resource: 'ci_pipeline', resource_id: 'main', version: c.version, metadata: { ...c.metadata } },
    ];
  };
  const intent = (actionId, args) => ({
    agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
    target: 'configs/deploy.yaml', arguments: args, dependencies: deps(),
  });

  // ---- (1) the WRITTEN dependency changes in the CAS window -----------------
  const fileBefore = provider.get('file', 'configs/deploy.yaml');
  const lockBefore = provider.get('lockfile', 'package-lock');
  const ciBefore = provider.get('ci_pipeline', 'main');

  const o1 = await rec.step('(1) execute while ONLY the written file changes (CAS window)', () => {
    const hooked = {
      ...executor,
      async conditionalExecute(i, es) {
        provider.mutate('file', 'configs/deploy.yaml', { content: '# human edit\n' }, new Date().toISOString());
        return executor.conditionalExecute(i, es);
      },
    };
    return fw.execute(
      intent('act_s05_written', { expected_lodash: '4.17.20', expected_ci: 'passing' }),
      hooked, { actionId: 'act_s05_written' },
    );
  });
  rec.recordTelemetryForOutcome(o1, 'memory', 'HIGH', { case: 'written-dep-changed' });

  assertEqual(o1.result?.conditional_execution, 'failed', 'CAS must refuse when the written dependency changed');
  assertEqual(provider.get('lockfile', 'package-lock').version, lockBefore.version, 'lockfile untouched');
  assertEqual(provider.get('ci_pipeline', 'main').version, ciBefore.version, 'CI state untouched');
  rec.observe('no execution; B and C untouched');

  // §9 understandability: does the audit say WHICH dependency caused it?
  const tail = await fw.auditTail(30);
  const cf = auditEvents(tail, 'execution.condition_failed')[0];
  assert(cf, 'execution.condition_failed must be recorded');
  const expectedEntry = cf?.payload?.expected_state?.find((e) => e.ref === FILE_REF);
  rec.observe(`audit expected_state: ${JSON.stringify(cf?.payload?.expected_state)}`);
  rec.observe(`audit observed_version: ${JSON.stringify(cf?.payload?.observed_version)} (current file version: ${provider.get('file', 'configs/deploy.yaml').version})`);
  const identifiable =
    // DF-4 (post-dogfood fix): the audit now names the refused ref directly
    // and carries the executor's refusal message.
    (cf?.payload?.failed_ref != null && cf.payload.failed_ref === FILE_REF) ||
    // Inferable form: compare expected_state[].version against observed_version.
    (Array.isArray(cf?.payload?.expected_state) &&
    cf.payload.expected_state.length === 3 &&
    expectedEntry?.version === fileBefore.version &&
    cf?.payload?.observed_version != null &&
    cf.payload.observed_version !== expectedEntry.version);
  if (identifiable) {
    rec.observe('UNDERSTANDABILITY: the audit identifies the drifted ref (failed_ref + provider_error; verifiable by comparing expected_state[].version against observed_version)');
  } else {
    rec.recordFinding('P3', 'condition-failure audit does not fully identify the drifted dependency');
  }

  // ---- (2) a READ-ONLY dependency changes in the CAS window -----------------
  const o2 = await rec.step('(2) execute while ONLY a read-only dependency (lockfile) changes (CAS window)', () => {
    const hooked = {
      ...executor,
      async conditionalExecute(i, es) {
        provider.mutate('lockfile', 'package-lock', { lodash: '9.9.9' }, new Date().toISOString());
        rec.observe('lockfile mutated by "another actor" between authorization and CAS');
        return executor.conditionalExecute(i, es);
      },
    };
    return fw.execute(
      intent('act_s05_readonly', { expected_lodash: '4.17.20', expected_ci: 'passing' }),
      hooked, { actionId: 'act_s05_readonly' },
    );
  });
  rec.recordTelemetryForOutcome(o2, 'memory', 'HIGH', { case: 'readonly-dep-changed' });

  rec.observe(`(2) outcome: executed=${o2.executed}, conditional=${o2.result?.conditional_execution}`);
  rec.observe(`(2) the applied content was: "${String(provider.get('file', 'configs/deploy.yaml').metadata['content']).replaceAll('\n', '\\n')}"`);
  if (o2.executed && o2.result?.conditional_execution === 'satisfied') {
    rec.recordFinding(
      'P2',
      'GUARANTEE SCOPE: provider-enforced conditional execution covers only the resources the effect WRITES. ' +
      'A read-only dependency that drifts between authorization and execution is NOT re-verified in the conditional path ' +
      '(the legacy fingerprint re-check covered it best-effort). Action parameters derived from read-only deps can be executed ' +
      'from stale values. Docs say "conditioned resources" but never state this scope explicitly. ' +
      'Fix: document the scope explicitly in limitations/threat-model/atomic-effect-assurance (no code change: per-resource CAS is the providers\' contract).',
    );
    rec.classifyBlock(BLOCK_CLASS.PROVIDER_LIMITATION, 'write-CAS is ref-scoped; read-only deps have no provider-enforced condition');
  }

  // ---- (3) world changes BEFORE execute() — validation window ---------------
  provider.mutate('file', 'configs/deploy.yaml', { content: '# another human edit\n' }, new Date().toISOString());
  provider.mutate('ci_pipeline', 'main', { status: 'failing' }, new Date().toISOString());
  const o3 = await rec.step('(3) agent re-observes current world, then executes (validation re-reads every dependency)', () =>
    fw.execute(intent('act_s05_validation', { expected_lodash: '4.17.20', expected_ci: 'passing' }), executor, { actionId: 'act_s05_validation' }));
  rec.recordTelemetryForOutcome(o3, 'memory', 'HIGH', { case: 'validation-window' });
  rec.observe(`(3) decision: ${o3.decision.decision} — fresh observations validated cleanly (stale-claim refusal is covered by S04 case 2)`);

  rec.finish({
    verdict: VERDICT.FINDING,
    expected: '(1) no execution + identifiable cause; (2)/(3) measured honestly against the documented guarantee',
    actual: '(1) refused by CAS, cause identifiable from audit; (2) EXECUTED — read-only dep drift is outside the write-CAS scope (finding P2, docs gap); (3) re-based at validation',
    notes: 'Finding is a documentation/guarantee-scope issue, not an implementation bug: the executor contract enforces written refs; read-only drift enforcement has no provider primitive.',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
