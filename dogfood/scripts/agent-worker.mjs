#!/usr/bin/env node
/**
 * Dogfood agent worker — a realistic independent agent process.
 *
 * Uses ONLY the public SDK. Parameterized via argv[2] (JSON):
 * {
 *   mode: 'http' | 'memory-shared',
 *   port: number,                  // sandbox server port (mode http)
 *   dbPath: string,                // SQLite path for this agent's firewall
 *   agentId: string,
 *   actionId: string,              // pinned identity (replay protection)
 *   resource: { source, resource, resource_id },
 *   changes: object,               // mutation payload
 *   barrierFile?: string,          // wait for this file before CAS
 *   signalFile?: string,           // report "authorized" via this file
 *   policyName?: string,
 *   risk?: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL'
 * }
 *
 * Protocol (stdout, JSON lines):
 *   {"event":"observed","version":...}
 *   {"event":"authorized"}          // emitted inside the executor hook
 *   {"event":"done","outcome":{...}} // final
 * Exit code 0 = executed; 2 = blocked/condition-failed; 1 = error.
 */

import fs from 'node:fs';
import {
  StaleStateFirewall,
  InMemoryStateProvider,
  HttpStateProvider,
} from 'stale-state-firewall';

const refKey = (ref) => `${ref.source}:${ref.resource}/${ref.resource_id}`;

const spec = JSON.parse(process.argv[2] ?? '{}');
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
if (spec.debugLog) fs.appendFileSync(spec.debugLog, `${new Date().toISOString()} worker start pid=${process.pid} argv2=${process.argv[2]?.slice(0, 80)}\n`);


function waitBarrier(file) {
  if (!file) return Promise.resolve();
  const t0 = Date.now();
  return new Promise((resolve) => {
    (function poll() {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() - t0 > 30000) return resolve(); // do not hang forever
      setTimeout(poll, 15);
    })();
  });
}

let provider;
if (spec.mode === 'http') {
  provider = new HttpStateProvider({
    shared: {
      url: `http://127.0.0.1:${spec.port}/correct/{id}`,
      version: { source: 'header', name: 'etag' },
      mutation: { method: 'PUT', condition_failed_status: [412, 409] },
    },
  });
} else {
  provider = new InMemoryStateProvider(spec.memorySource ?? 'git');
}

const firewall = await StaleStateFirewall.create({
  config: {
    firewall: { mode: 'enforce', storage: { type: 'sqlite', path: spec.dbPath } },
    actions: [{
      name: spec.policyName ?? 'concurrent-edit',
      match: { tool: 'config-file', operation: 'edit*' },
      risk: spec.risk ?? 'HIGH',
      freshness: { strategy: 'version' },
      execution: { require_conditional_execution: true, deadline: '15s' },
    }],
  },
  providers: [provider],
});

const dep = {
  source: spec.resource.source,
  resource: spec.resource.resource,
  resource_id: spec.resource.resource_id,
};

// Observe (agent's belief about the world).
let observedVersion = spec.observedVersion;
if (!observedVersion) {
  try {
    const snap = await provider.getState({ ...dep, version: null, metadata: {} }, new Date().toISOString());
    observedVersion = snap.version;
  } catch (e) {
    throw e;
  }
}
out({ event: 'observed', version: observedVersion });

let changesApplied = null;
const executor = {
  idempotency: 'non_idempotent',
  atomicity: 'guaranteed',
  async execute() { throw new Error('legacy path must not be used in this scenario'); },
  conditionalExecutionSupported: () => true,
  async conditionalExecute(intent, expectedState) {
    out({ event: 'authorized', expected_state: expectedState });
    await waitBarrier(spec.barrierFile);
    const entry = expectedState.find((e) => e.ref === refKey(dep));
    if (!entry) return { condition: 'unavailable', error: 'no expected state' };
    const res = await provider.conditionalExecute({
      ref: dep, expected_version: entry.version, changes: spec.changes,
    });
    if (res.outcome === 'executed') {
      changesApplied = res.version;
      return { condition: 'satisfied', success: true, output: { version: res.version } };
    }
    return {
      condition: 'failed',
      observed_version: res.current_version,
      error: `provider refused: at ${res.current_version}, authorized ${entry.version}`,
    };
  },
};

try {
  const outcome = await firewall.execute(
    {
      agent_id: spec.agentId,
      tool: 'config-file',
      operation: 'edit_file',
      target: `${spec.resource.resource}/${spec.resource.resource_id}`,
      arguments: { agent: spec.agentId },
      dependencies: [{ ...dep, version: observedVersion, metadata: {} }],
    },
    executor,
    { actionId: spec.actionId },
  );
  out({
    event: 'done',
    executed: outcome.executed,
    decision: outcome.decision?.decision,
    conditional: outcome.result?.conditional_execution ?? null,
    success: outcome.result?.success ?? false,
    error: outcome.result?.error ?? null,
    observed_version: outcome.result?.observed_version ?? null,
    applied: changesApplied,
  });
  process.exit(outcome.executed && outcome.result?.success ? 0 : 2);
} catch (error) {
  out({ event: 'done', error: error.message, name: error.name });
  process.exit(1);
}
