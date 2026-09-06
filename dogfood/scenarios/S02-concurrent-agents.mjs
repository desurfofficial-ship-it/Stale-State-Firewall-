#!/usr/bin/env node
/**
 * S02 — CONCURRENT AGENTS (dogfood spec §6, §27)
 *
 * Two INDEPENDENT PROCESSES observe the same resource, authorize the same
 * mutation, and race. The shared state lives on a real HTTP server whose
 * If-Match semantics enforce the condition; each agent keeps its own
 * firewall state in its own SQLite database (real-life deployment shape).
 *
 * Questions answered: how many succeed? what does each agent observe? does
 * the audit trail explain why? A single-process N-way race on the in-memory
 * provider cross-checks the same guarantee.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assertEqual, waitForLine,
  REPORTS_DIR, STATE_DIR, BLOCK_CLASS, VERDICT, auditEvents, freshDb,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S02', 'Concurrent agents — two processes race on shared state');
const WORKER = path.join(REPORTS_DIR, '..', 'scripts', 'agent-worker.mjs');

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null, etag: res.headers.etag }));
    }).on('error', reject);
  });
}

try {
  // ---- start the sandbox server -------------------------------------------
  const server = spawn(process.execPath, [
    path.join(REPORTS_DIR, '..', 'scripts', 'sandbox-http-server.mjs'), '0',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const readyLine = await new Promise((resolve) => {
    server.stdout.once('data', (d) => resolve(d.toString().trim()));
  });
  const port = Number(readyLine.split(' ')[1]);
  rec.observe(`sandbox HTTP server on 127.0.0.1:${port} (correct If-Match semantics)`);
  const probe = await httpGetJson(`http://127.0.0.1:${port}/__state/correct/deploy-config`);
  rec.observe(`parent probe of server: status=${probe.status}`);

  const barrier = path.join(STATE_DIR, 's02-go');
  fs.rmSync(barrier, { force: true });

  const childSpec = (agentId, actionId, dbPath) => JSON.stringify({
    mode: 'http', port,
    dbPath,
    agentId, actionId,
    resource: { source: 'http', resource: 'shared', resource_id: 'deploy-config' },
    changes: { content: `updated by ${agentId}` },
    barrierFile: barrier,
    debugLog: path.join(STATE_DIR, 's02-worker-debug.log'),
  });

  const wire = (child, name) => {
    child.on('spawn', () => rec.say(`  [${name}] spawned pid=${child.pid}`));
    child.on('error', (e) => rec.say(`  [${name}] spawn error: ${e.message}`));
    child.on('exit', (code, sig) => rec.say(`  [${name}] exit code=${code} sig=${sig}`));
    child.stderr?.on('data', (d) => rec.say(`  [${name} stderr] ${d.toString().trim().slice(0, 300)}`));
  };
  rec.say(`  worker = ${WORKER}`);
  const dbPathA = freshDb('s02-agent-a.db');
  const dbPathB = freshDb('s02-agent-b.db');
  const a = spawn(process.execPath, [WORKER, childSpec('agent-a', 'act_s02_a', dbPathA)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const b = spawn(process.execPath, [WORKER, childSpec('agent-b', 'act_s02_b', dbPathB)], { stdio: ['ignore', 'pipe', 'pipe'] });
  wire(a, 'agent-a');
  wire(b, 'agent-b');

  const linesOf = (child) => {
    const lines = [];
    child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => {
      try { lines.push(JSON.parse(l)); } catch { /* non-JSON line */ }
    }));
    return lines;
  };
  const linesA = linesOf(a);
  const linesB = linesOf(b);

  // Both agents observe the same version, then authorize; the barrier holds
  // both at the CAS so the race is deterministic.
  await rec.step('both agents observe and authorize (barrier before CAS)', async () => {
    try {
      await waitForLine(a, '"authorized"');
      await waitForLine(b, '"authorized"');
    } catch (e) {
      rec.say(`  CHILD A LINES: ${JSON.stringify(linesA)}`);
      rec.say(`  CHILD B LINES: ${JSON.stringify(linesB)}`);
      throw e;
    }
    rec.observe('both agents hold an authorization against the same version');
    fs.writeFileSync(barrier, 'go');
  });

  const [exitA, exitB] = await Promise.all([
    new Promise((r) => a.on('exit', (c) => r(c))),
    new Promise((r) => b.on('exit', (c) => r(c))),
  ]);
  const doneA = linesA.find((l) => l.event === 'done');
  const doneB = linesB.find((l) => l.event === 'done');

  rec.observe(`agent-a exit=${exitA} conditional=${doneA?.conditional} applied=${doneA?.applied ?? null}`);
  rec.observe(`agent-b exit=${exitB} conditional=${doneB?.conditional} applied=${doneB?.applied ?? null}`);

  // ---- server-side truth: exactly one mutation ------------------------------
  const truth = await rec.step('verify server-side: exactly one mutation applied', async () => {
    const state = await httpGetJson(`http://127.0.0.1:${port}/__state/correct/deploy-config`);
    assertEqual(state.body.mutations.length, 1, `exactly one mutation must land (got ${state.body.mutations.length})`);
    return state.body;
  });
  rec.observe(`server truth: revision=${truth.revision}, last mutation=${truth.mutations[0]?.at}`);

  // ---- classification of outcomes ------------------------------------------
  const winners = [doneA, doneB].filter((d) => d?.conditional === 'satisfied');
  const losers = [doneA, doneB].filter((d) => d?.conditional === 'failed');
  assertEqual(winners.length, 1, 'exactly one agent may win the CAS');
  assertEqual(losers.length, 1, 'exactly one agent must lose the CAS');
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'the losing agent’s stale conditional mutation was refused by the provider (If-Match 412)');

  const winner = winners[0];
  const loser = losers[0];
  rec.observe(`winner saw: success, applied version ${winner.applied}`);
  rec.observe(`loser saw: "${(loser.error ?? '').slice(0, 120)}" — an explicit, retry-informative condition failure`);

  // ---- each agent's own audit explains what happened ------------------------
  for (const [agentId, dbPath] of [['agent-a', dbPathA], ['agent-b', dbPathB]]) {
    const fw = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'sqlite', path: dbPath } }, actions: [] },
    });
    const tail = await fw.auditTail(30);
    const cf = auditEvents(tail, 'execution.condition_failed').length;
    const ex = auditEvents(tail, 'action.executed').length;
    rec.observe(`audit of ${agentId}: action.executed=${ex}, execution.condition_failed=${cf} (exactly one of the two)`);
    assertEqual(ex + cf, 1, `${agentId} audit must record exactly one terminal execution outcome`);
    await fw.close();
  }

  // ---- cross-check: single-process N-way race on the in-memory provider ----
  await rec.step('cross-check: 8 concurrent firewall executions on one in-memory resource', async () => {
    const provider = new InMemoryStateProvider('git');
    provider.put('file', 'race-target', { v: 0 }, new Date().toISOString());
    const fw = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce' },
        actions: [{
          name: 'race', match: { tool: 't', operation: 'op' }, risk: 'HIGH',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: true },
        }],
      },
      store: new MemoryStore(), providers: [provider],
    });
    const snap = await provider.getState({ source: 'git', resource: 'file', resource_id: 'race-target', version: null, metadata: {} }, new Date().toISOString());
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      fw.execute(
        {
          agent_id: `racer-${i}`, tool: 't', operation: 'op',
          dependencies: [{ source: 'git', resource: 'file', resource_id: 'race-target', version: snap.version }],
        },
        {
          idempotency: 'non_idempotent',
          execute: async () => ({ success: true }),
          conditionalExecutionSupported: () => true,
          conditionalExecute: async (intent, expectedState) => {
            const res = await provider.conditionalExecute({
              ref: intent.dependencies[0], expected_version: expectedState[0].version, changes: { v: i },
            });
            return res.outcome === 'executed'
              ? { condition: 'satisfied', success: true }
              : { condition: 'failed', observed_version: res.current_version };
          },
        },
        { actionId: `act_race_${i}` },
      )));
    const satisfied = results.filter((r) => r.result?.conditional_execution === 'satisfied').length;
    const failed = results.filter((r) => r.result?.conditional_execution === 'failed').length;
    assertEqual(satisfied, 1, 'exactly 1 of 8 concurrent CAS executions succeeds');
    assertEqual(failed, 7, '7 of 8 must be refused with condition_failed');
    rec.observe(`8-way race: ${satisfied} satisfied, ${failed} condition_failed; provider log has ${provider.mutationLog('file', 'race-target').length} mutation(s)`);
  });

  server.kill();
  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'exactly one agent succeeds; the other receives an explainable condition failure; audits agree with server truth',
    actual: `1 winner (${winner === doneA ? 'agent-a' : 'agent-b'}), 1 loser with explicit condition failure; server truth = 1 mutation; per-agent audits consistent`,
    notes: 'Barrier held both agents at the CAS to make the race deterministic; server-side mutation count is the source of truth.',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
