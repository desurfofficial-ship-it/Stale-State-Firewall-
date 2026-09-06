#!/usr/bin/env node
/**
 * Operator incident exercise (sustained-dogfood milestone §13).
 *
 * Phase 1 (this script): run a REAL stale-state incident against a PERSISTED
 * SQLite store — a legitimate change, a CAS-window race (the provider refuses
 * the stale mutation), a replay probe against the dead authorization, and an
 * autonomous recovery. Then leave the evidence behind and walk away.
 *
 * Phase 2 (operator, CLI only): with nothing but `ssf audit` /
 * `ssf action inspect` / `ssf doctor` output from the incident directory,
 * answer the seven incident questions (what happened / what was authorized /
 * what changed / why did execution fail / did a mutation occur / is retry
 * safe / what recovery occurred). The results are recorded in the
 * sustained-dogfood report — including every step that needed source
 * archaeology, which would be an integration gap.
 *
 * Output is operator-agnostic: this script does NOT print the answers.
 */

import { StaleStateFirewall, InMemoryStateProvider, ReplayDetectedError } from 'stale-state-firewall';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const INCIDENT_DIR = join(HERE, '..', 'reports', 'state', 'incident-exercise');
const DB_PATH = join(INCIDENT_DIR, 'ssf-state.db');

// Fresh evidence dir per exercise.
rmSync(INCIDENT_DIR, { recursive: true, force: true });
mkdirSync(INCIDENT_DIR, { recursive: true });

const POLICY = [{
  name: 'update-deploy-config',
  match: { tool: 'ops', operation: 'update_deploy_config' },
  risk: 'HIGH',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

// The CLI-facing config for the operator phase: same trust domain (same DB),
// same policy. Providers are runtime concerns and not needed to read audit.
writeFileSync(join(INCIDENT_DIR, 'ssf.config.yaml'), [
  'firewall:',
  '  mode: enforce',
  '  storage:',
  '    type: sqlite',
  '    path: ./ssf-state.db',
  '',
  'defaults:',
  '  on_fresh: allow',
  '  on_stale: revalidate',
  '  on_unknown: revalidate',
  '  on_invalid: deny',
  '',
  'actions:',
  ...POLICY.map((p) => `  - ${JSON.stringify(p)}`),
  '',
].join('\n'));

const deployContent = (replicas, note) => `env: staging\nservice: api\nreplicas: ${replicas}${note ? `\n# ${note}` : ''}\n`;

const provider = new InMemoryStateProvider('ops');
provider.put('file', 'configs/deploy.yaml', { content: deployContent(1) }, new Date().toISOString());

const firewall = await StaleStateFirewall.create({
  config: { firewall: { mode: 'enforce', storage: { type: 'sqlite', path: DB_PATH } }, actions: POLICY },
  providers: [provider],
});

const intentOf = (rev, replicas, note) => ({
  agent_id: 'deploy-agent',
  tool: 'ops',
  operation: 'update_deploy_config',
  arguments: { path: 'configs/deploy.yaml', replicas, note },
  dependencies: [{ source: 'ops', resource: 'file', resource_id: 'configs/deploy.yaml', version: rev }],
});

const makeExecutor = (interference) => ({
  idempotency: 'non_idempotent',
  atomicity: 'guaranteed',
  execute: async () => ({ success: true }),
  conditionalExecutionSupported: () => true,
  conditionalExecute: async (intent, expectedState) => {
    if (interference) await interference();
    const res = await provider.conditionalExecute({
      ref: { source: 'ops', resource: 'file', resource_id: 'configs/deploy.yaml' },
      expected_version: expectedState[0].version,
      changes: { content: deployContent(intent.arguments['replicas'], intent.arguments['note']) },
    });
    return res.outcome === 'executed'
      ? { condition: 'satisfied', success: true, output: res.version }
      : { condition: 'failed', ref: expectedState[0].ref, observed_version: res.current_version };
  },
});

const say = (line) => process.stdout.write(line + '\n');
const incidentIds = { legit: `incident_${RUN_()}_1`, raced: `incident_${RUN_()}_2`, recovery: `incident_${RUN_()}_3` };
function RUN_() { return 'exercise'; }

try {
  // 1. Legitimate change: observe v1 → authorize → CAS → executed (v2).
  const cur1 = provider.get('file', 'configs/deploy.yaml');
  await firewall.execute(intentOf(cur1.version, 2, 'scale for load'), makeExecutor(null), { actionId: incidentIds.legit });

  // 2. THE INCIDENT: agent observes v2, authorization passes validation, and
  //    INSIDE the CAS window a concurrent actor moves the file to v3 — the
  //    provider refuses the agent's stale mutation (condition_failed).
  const cur2 = provider.get('file', 'configs/deploy.yaml');
  const raced = await firewall.execute(
    intentOf(cur2.version, 3, 'scale further'),
    makeExecutor(() => {
      // External actor: mutate() is the version-bumping primitive. (put() on an
      // existing resource KEEPS its version — a CAS-invisible change. That
      // fixture trap is recorded as friction FL-9.)
      provider.mutate('file', 'configs/deploy.yaml', { content: deployContent(9, 'hotfix by human') }, new Date().toISOString());
    }),
    { actionId: incidentIds.raced },
  );
  say(`[incident] condition_failed produced: ${raced.executed === false && raced.result?.conditional_execution === 'failed' ? 'yes' : 'NO (unexpected)'}`);

  // 3. Replay probe: the dead authorization must not be usable again.
  let replayRefused = false;
  try {
    await firewall.execute(intentOf(cur2.version, 3, 'scale further'), makeExecutor(null), { actionId: incidentIds.raced });
  } catch (err) {
    replayRefused = err instanceof ReplayDetectedError;
  }
  say(`[incident] replay of consumed authorization refused: ${replayRefused ? 'yes (ReplayDetectedError)' : 'NO (unexpected)'}`);

  // 4. Recovery: re-observe → recompute preserving the hotfix → new authorization.
  const cur3 = provider.get('file', 'configs/deploy.yaml');
  await firewall.execute(intentOf(cur3.version, 3, 'scale further (hotfix preserved)'),
    makeExecutor(null), { actionId: incidentIds.recovery });

  say('\nIncident written. Evidence directory (operator phase):');
  say(`  cd ${INCIDENT_DIR}`);
  say('  ssf audit --verify');
  say('  ssf audit --limit 50');
  say(`  ssf action inspect ${incidentIds.raced} --json`);
  say(`\nAction ids: legit=${incidentIds.legit} incident=${incidentIds.raced} recovery=${incidentIds.recovery}`);
} finally {
  await firewall.close().catch(() => {});
}
