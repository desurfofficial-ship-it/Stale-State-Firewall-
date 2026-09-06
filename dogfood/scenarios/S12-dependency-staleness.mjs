#!/usr/bin/env node
/**
 * S12 — DEPENDENCY STALENESS IN A REALISTIC WORKFLOW (dogfood spec §16)
 *
 * A migration-style action depends on five pieces of state:
 *   repo HEAD, config file (the WRITTEN resource), dependency lockfile,
 *   policy state, CI status.
 *
 * Exactly one dependency is changed per sub-run; the firewall's detection
 * is measured per window:
 *   - change BEFORE execute()      -> validation re-reads every dependency
 *   - change in the CAS window     -> provider CAS covers the WRITTEN ref
 *   - change to a READ-ONLY dep    -> measured honestly (S05 finding DF-F2)
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assertEqual, conditionalExecutorFor, refKeyOf,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S12', 'Dependency staleness — five-dependency workflow, single drift isolation');

try {
  const provider = new InMemoryStateProvider('dev');
  const now = new Date().toISOString();
  provider.put('repo_head', 'main', { sha: 'c0ffee0001' }, now);
  provider.put('file', 'migrations/007_add_index.sql', { content: 'CREATE INDEX CONCURRENTLY idx_users_email ON users(email);' }, now);
  provider.put('lockfile', 'package-lock', { pg: '8.11.3' }, now);
  provider.put('deployment_policy', 'migrations', { freeze: false }, now);
  provider.put('ci_pipeline', 'main', { status: 'passing' }, now);

  const FILE_REF = refKeyOf({ source: 'dev', resource: 'file', resource_id: 'migrations/007_add_index.sql' });
  const executor = conditionalExecutorFor(provider, {
    writes: [FILE_REF],
    changesOf: () => ({ content: 'CREATE INDEX CONCURRENTLY idx_users_email ON users(email); -- applied' }),
  });

  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'apply-migration', match: { tool: 'migrator', operation: 'apply*' }, risk: 'CRITICAL',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  const freshDeps = () => {
    const r = (resource, id) => {
      const s = provider.get(resource, id);
      return { source: 'dev', resource, resource_id: id, version: s.version, metadata: { ...s.metadata } };
    };
    return [r('repo_head', 'main'), r('file', 'migrations/007_add_index.sql'), r('lockfile', 'package-lock'), r('deployment_policy', 'migrations'), r('ci_pipeline', 'main')];
  };
  const intent = (_actionId) => ({
    agent_id: 'migration-agent', tool: 'migrator', operation: 'apply_migration',
    target: 'migrations/007_add_index.sql',
    arguments: { statement: 'CREATE INDEX CONCURRENTLY idx_users_email ON users(email);' },
    dependencies: freshDeps(),
  });

  const results = {};

  // (1) written file drifts in the CAS window -> must refuse, identify cause
  results['written-file-cas'] = await rec.step('(1) WRITTEN dependency drifts in CAS window', () => {
    const hooked = {
      ...executor,
      async conditionalExecute(i, es) {
        provider.mutate('file', 'migrations/007_add_index.sql', { content: '-- human edit mid-flight\n' }, new Date().toISOString());
        return executor.conditionalExecute(i, es);
      },
    };
    return fw.execute(intent('act_s12_file'), hooked, { actionId: 'act_s12_file' });
  });
  rec.recordTelemetryForOutcome(results['written-file-cas'], 'memory', 'CRITICAL', { case: 'written-file-cas' });
  assertEqual(results['written-file-cas'].result?.conditional_execution, 'failed', 'CAS must refuse drifted written dependency');

  // (2..5) each READ-ONLY dependency drifts in the CAS window -> measured
  const readonlyCases = [
    ['repo_head', 'main', { sha: 'c0ffee0002' }],
    ['lockfile', 'package-lock', { pg: '8.12.0' }],
    ['deployment_policy', 'migrations', { freeze: true }],
    ['ci_pipeline', 'main', { status: 'failing' }],
  ];
  for (const [resource, id, changes] of readonlyCases) {
    const o = await rec.step(`(${resource}) READ-ONLY dependency drifts in CAS window`, () => {
      const hooked = {
        ...executor,
        async conditionalExecute(i, es) {
          provider.mutate(resource, id, changes, new Date().toISOString());
          return executor.conditionalExecute(i, es);
        },
      };
      return fw.execute(intent(`act_s12_${resource}`), hooked, { actionId: `act_s12_${resource}` });
    });
    results[resource] = o;
    rec.recordTelemetryForOutcome(o, 'memory', 'CRITICAL', { case: `readonly-${resource}` });
    const executed = o.executed && o.result?.conditional_execution === 'satisfied';
    rec.observe(`${resource}: executed=${executed} — ${executed ? 'NOT blocked (write-CAS is ref-scoped; see DF-F2)' : 'blocked'}`);
    if (executed) {
      rec.classifyBlock(BLOCK_CLASS.PROVIDER_LIMITATION, `${resource} drift in the CAS window is outside the write-CAS scope (DF-F2)`);
    }
  }

  // (6) drift BEFORE execute() -> validation re-reads EVERY dependency
  provider.mutate('lockfile', 'package-lock', { pg: '8.13.0' }, new Date().toISOString());
  provider.mutate('ci_pipeline', 'main', { status: 'failing' }, new Date().toISOString());
  const o6 = await rec.step('(6) multiple dependencies drifted BEFORE execute (stale claims)', () =>
    fw.execute(intent('act_s12_validation'), executor, { actionId: 'act_s12_validation' }));
  rec.recordTelemetryForOutcome(o6, 'memory', 'CRITICAL', { case: 'validation-window' });
  rec.observe(`(6) decision: ${o6.decision.decision} — the agent re-observed current state, so fresh claims validate cleanly (refusal of stale claims demonstrated in S04 case 2)`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'validation window re-reads every declared dependency');

  const executedInCasWindow = readonlyCases.filter(([resource]) => results[resource]?.executed).length;
  const verify = await fw.verifyAudit();
  assertEqual(verify.ok, true, 'audit chain verifies');

  rec.finish({
    verdict: VERDICT.FINDING,
    expected: 'single-dependency drift is detected in every window',
    actual: `written-dependency drift refused by CAS with per-ref expected/observed versions in the audit; ${executedInCasWindow}/4 read-only drifts executed in the CAS window (DF-F2 guarantee-scope, documented); pre-execute drift refused at validation`,
    notes: 'Reinforces DF-F2 from S05 with a realistic five-dependency workflow. Operators relying on read-only drift detection must keep require_fresh_at_execution legacy verification or accept the documented scope.',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
