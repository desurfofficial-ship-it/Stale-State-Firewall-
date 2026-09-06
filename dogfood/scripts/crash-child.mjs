#!/usr/bin/env node
/**
 * Crash-phase child (dogfood spec §29).
 *
 * Uses the PUBLIC SDK against a SQLite store + the sandbox HTTP server.
 * Performs an execution and is killed by the parent at a chosen phase:
 *
 *   phase=after_claim    — kill while the conditional PUT is in flight
 *                          (server delays the mutation; nothing applied yet)
 *   phase=after_apply    — kill after the server APPLIED the mutation but
 *                          before the response is processed (side effect
 *                          happened; firewall unaware)
 *
 * argv[2] JSON: { dbPath, port, phase, agentId, actionId }
 * Protocol: prints {"event":"phase","name":"..."} markers the parent waits for.
 */

import {
  StaleStateFirewall,
  HttpStateProvider,
} from 'stale-state-firewall';

const spec = JSON.parse(process.argv[2] ?? '{}');
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const provider = new HttpStateProvider({
  crash: {
    url: `http://127.0.0.1:${spec.port}/crash/{id}`,
    headers: { 'x-crash-delay': String(spec.delayMs ?? 8000), ...(spec.holdResponse ? { 'x-crash-hold': '1' } : {}) },
    version: { source: 'header', name: 'etag' },
    timeout_ms: 30000,
    mutation: { method: 'PUT', condition_failed_status: [412, 409] },
  },
});

const fw = await StaleStateFirewall.create({
  config: {
    firewall: { mode: 'enforce', storage: { type: 'sqlite', path: spec.dbPath } },
    actions: [{
      name: 'crash-edit', match: { tool: 'http', operation: 'update*' }, risk: 'HIGH',
      freshness: { strategy: 'version' },
      execution: { require_conditional_execution: true },
    }],
  },
  providers: [provider],
});

const dep = { source: 'http', resource: 'crash', resource_id: 'res1' };
const snap = await provider.getState({ ...dep, version: null, metadata: {} }, new Date().toISOString());

const executor = {
  idempotency: 'non_idempotent',
  atomicity: 'guaranteed',
  execute: async () => ({ success: true }),
  conditionalExecutionSupported: () => true,
  async conditionalExecute(intent, expectedState) {
    out({ event: 'phase', name: 'claimed' }); // authorization claimed, request in flight
    // Server is told to delay the PUT long enough for the parent to kill us.
    const res = await provider.conditionalExecute({
      ref: dep, expected_version: expectedState[0].version, changes: { content: 'crash-test write' },
    });
    out({ event: 'phase', name: 'provider-responded', outcome: res.outcome });
    return res.outcome === 'executed'
      ? { condition: 'satisfied', success: true }
      : { condition: 'failed', observed_version: res.current_version };
  },
};

try {
  const o = await fw.execute({
    agent_id: spec.agentId, tool: 'http', operation: 'update_resource',
    arguments: { phase: spec.phase },
    dependencies: [{ ...dep, version: snap.version }],
  }, executor, { actionId: spec.actionId });
  out({ event: 'done', executed: o.executed, decision: o.decision?.decision, conditional: o.result?.conditional_execution ?? null });
  process.exit(0);
} catch (error) {
  out({ event: 'done', error: error.message, name: error.name });
  process.exit(1);
}
