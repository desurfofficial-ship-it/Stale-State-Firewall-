#!/usr/bin/env node
/**
 * Dogfood GitHub racing worker (S13 step 3) — an independent agent process
 * using the public SDK against the real Contents API.
 *
 * argv[2] JSON: { token, repo, path, dbPath, agentId, replicas, actionId }
 * Protocol: {"event":"authorized"} then {"event":"done",...}
 */

import {
  StaleStateFirewall,
  GitHubStateProvider,
} from 'stale-state-firewall';

const spec = JSON.parse(process.argv[2] ?? '{}');
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const REF = `github:file/${spec.repo}@${spec.path}`;
const FILE_DEP = { source: 'github', resource: 'file', resource_id: `${spec.repo}@${spec.path}` };

const github = new GitHubStateProvider({ token: spec.token });
const fw = await StaleStateFirewall.create({
  config: {
    firewall: { mode: 'enforce', storage: { type: 'sqlite', path: spec.dbPath } },
    actions: [{
      name: 'update-github-file', match: { tool: 'github', operation: 'update_file' }, risk: 'HIGH',
      freshness: { strategy: 'version' },
      execution: { require_conditional_execution: true },
    }],
  },
  providers: [github],
});

const snap = await github.getState({ ...FILE_DEP, version: null, metadata: {} }, new Date().toISOString());

const executor = {
  idempotency: 'non_idempotent',
  atomicity: 'guaranteed',
  execute: async () => ({ success: true }),
  conditionalExecutionSupported: () => true,
  async conditionalExecute(intent, expectedState) {
    out({ event: 'authorized', expected: expectedState.find((e) => e.ref === REF)?.version });
    const entry = expectedState.find((e) => e.ref === REF);
    if (!entry) return { condition: 'unavailable', error: 'no authorized blob sha' };
    const res = await github.conditionalExecute({
      ref: FILE_DEP, expected_version: entry.version,
      changes: { content: `env: sandbox\nreplicas: ${spec.replicas}\n` },
    });
    return res.outcome === 'executed'
      ? { condition: 'satisfied', success: true, output: { sha: res.version } }
      : { condition: 'failed', observed_version: res.current_version, error: `GitHub refused: authorized ${entry.version?.slice(0, 10)}, reports ${res.current_version?.slice(0, 10) ?? 'unknown'}` };
  },
};

try {
  const o = await fw.execute({
    agent_id: spec.agentId, tool: 'github', operation: 'update_file',
    target: `${spec.repo}@${spec.path}`,
    arguments: { replicas: spec.replicas },
    dependencies: [{ ...FILE_DEP, version: snap.version }],
  }, executor, { actionId: spec.actionId });
  out({
    event: 'done', executed: o.executed, decision: o.decision?.decision,
    conditional: o.result?.conditional_execution ?? null,
    success: o.result?.success ?? false, error: o.result?.error ?? null,
  });
  process.exit(o.executed && o.result?.success ? 0 : 2);
} catch (error) {
  out({ event: 'done', error: error.message, name: error.name });
  process.exit(1);
}
