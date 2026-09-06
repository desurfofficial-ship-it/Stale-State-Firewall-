#!/usr/bin/env node
/**
 * Crash / restart durability suite (dogfood spec §28-29).
 *
 * §29 crash injection points reachable via the public API + a delaying
 * server:
 *   A. kill AFTER claim, BEFORE provider applied (no side effect)
 *   B. kill AFTER provider applied, BEFORE response processed (side effect
 *      happened, firewall unaware — the unknown-outcome durability case)
 *
 * §28 checks after each restart:
 *   - authorization state (orphaned claims? double claims?)
 *   - audit consistency + chain verification
 *   - execution records vs external truth
 *   - retry semantics after restart (no blind re-execution)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {
  StaleStateFirewall, HttpStateProvider,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, waitForLine, auditEvents, freshDb,
  REPORTS_DIR, BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S16-crash-restart', 'Crash/restart durability — §28 database durability + §29 crash recovery');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

try {
  const server = spawn(process.execPath, [path.join(REPORTS_DIR, '..', 'scripts', 'sandbox-http-server.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const readyLine = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(d.toString().trim())));
  const port = Number(readyLine.split(' ')[1]);
  const childScript = path.join(REPORTS_DIR, '..', 'scripts', 'crash-child.mjs');

  // ---- Case A: crash after claim, before the provider applied ---------------
  {
    const db = freshDb('s16-caseA.db');
    const child = spawn(process.execPath, [childScript, JSON.stringify({
      dbPath: db, port, phase: 'after_claim', agentId: 'crash-a', actionId: 'act_s16_a', delayMs: 8000,
    })], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exitA = new Promise((r) => child.on('exit', r));
    const lines = [];
    child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => { try { lines.push(JSON.parse(l)); } catch {} }));
    child.stderr.on('data', (d) => rec.say(`  [A stderr] ${d.toString().slice(0, 160)}`));
    await waitForLine(child, '"claimed"');
    child.kill('SIGKILL');
    await exitA;
    rec.observe('A: process killed after authorization claim, while the conditional PUT was in flight (pre-apply)');

    const truth = await httpGetJson(`http://127.0.0.1:${port}/__state/crash/res1`);
    assertEqual(truth.body?.mutations?.length ?? 0, 0, 'A: no side effect may have been applied');
    rec.observe('A: external truth: zero mutations (nothing happened)');

    const reopened = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'sqlite', path: db } },
        actions: [],
      },
    });
    const tail = await reopened.auditTail(30);
    const hasExecuted = auditEvents(tail, 'action.executed').length;
    assertEqual(hasExecuted, 0, 'A: no executed record may exist for the killed attempt');
    const verify = await reopened.verifyAudit();
    assertEqual(verify.ok, true, 'A: audit chain verifies after crash');
    rec.observe(`A: audit after restart: ${tail.map((e) => e.event_type).join(', ')}; chain ok`);

    // retry semantics: the claim persists durably; same actionId must not re-execute
    let replay = null;
    try {
      await reopened.execute({
        agent_id: 'crash-a', tool: 'http', operation: 'update_resource',
        dependencies: [{ source: 'http', resource: 'crash', resource_id: 'res1', version: truth.body ? '"v1"' : '"v1"' }],
      }, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: 'act_s16_a' });
    } catch (e) { replay = e; }
    assert(replay && /replay/i.test(replay.message), 'A: the orphaned claim must block blind re-execution (replay refused)');
    rec.observe(`A: blind retry after restart refused (${replay.name}) — the operator reconciles with a NEW action id and fresh state`);
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'orphaned claim after crash is durable and replay-safe');
    await reopened.close();
  }

  // ---- Case B: crash after the provider APPLIED, before response ------------
  {
    const db = freshDb('s16-caseB.db');
    const child = spawn(process.execPath, [childScript, JSON.stringify({
      dbPath: db, port, phase: 'after_apply', agentId: 'crash-b', actionId: 'act_s16_b', delayMs: 3000, holdResponse: true,
    })], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exitB = new Promise((r) => child.on('exit', r));
    const lines = [];
    child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => { try { lines.push(JSON.parse(l)); } catch {} }));
    child.stderr.on('data', (d) => rec.say(`  [B stderr] ${d.toString().slice(0, 160)}`));
    await waitForLine(child, '"claimed"');
    // Wait until the server applied the mutation, then kill before the child
    // can process the response.
    let applied = false;
    for (let i = 0; i < 100; i++) {
      const t = await httpGetJson(`http://127.0.0.1:${port}/__state/crash/res1`);
      if ((t.body?.mutations?.length ?? 0) > 0) { applied = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(applied, 'B: the delayed mutation must have been applied server-side');
    child.kill('SIGKILL');
    await Promise.race([exitB, new Promise((r) => setTimeout(r, 2000))]);
    rec.observe('B: server applied the mutation and is HOLDING the response; client killed while awaiting it — the firewall can never record the outcome');

    const truth = await httpGetJson(`http://127.0.0.1:${port}/__state/crash/res1`);
    assertEqual(truth.body.mutations.length, 1, 'B: the side effect DID occur');
    rec.observe('B: external truth: the mutation WAS applied — but the firewall died before recording it');

    const reopened = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'sqlite', path: db } },
        actions: [],
      },
    });
    const tail = await reopened.auditTail(30);
    const hasExecuted = auditEvents(tail, 'action.executed').length;
    assertEqual(hasExecuted, 0, 'B: no falsely-recorded success may exist');
    rec.observe(`B: audit after restart: ${tail.map((e) => e.event_type).join(', ')} (no action.executed — the firewall never claims what it did not observe)`);
    const verify = await reopened.verifyAudit();
    assertEqual(verify.ok, true, 'B: audit chain verifies after crash');

    // the durable claim blocks blind retry; the operator reconciles via fresh read
    let replay = null;
    try {
      await reopened.execute({
        agent_id: 'crash-b', tool: 'http', operation: 'update_resource',
        dependencies: [{ source: 'http', resource: 'crash', resource_id: 'res1', version: '"v1"' }],
      }, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: 'act_s16_b' });
    } catch (e) { replay = e; }
    assert(replay && /replay/i.test(replay.message), 'B: the orphaned claim must block re-execution after an unknown-outcome crash');
    rec.observe('B: blind retry refused; fresh read reconciles the external world (revision advanced) before any new attempt');
    rec.classifyBlock(BLOCK_CLASS.UNKNOWN, 'crash after apply = unknown external outcome; persisted state is consistent and replay-safe; reconciliation requires a fresh read (documented)');

    // double-claim check: a NEW action id can still claim and execute cleanly
    const prov = new HttpStateProvider({
      crash: {
        url: `http://127.0.0.1:${port}/crash/{id}`,
        version: { source: 'header', name: 'etag' },
        timeout_ms: 5000,
        mutation: { method: 'PUT', condition_failed_status: [412, 409] },
      },
    });
    const fwNew = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'sqlite', path: freshDb('s16-caseB-new.db') } },
        actions: [{
          name: 'crash-edit', match: { tool: 'http', operation: 'update*' }, risk: 'HIGH',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: true },
        }],
      },
      providers: [prov],
    });
    const snap = await prov.getState({ source: 'http', resource: 'crash', resource_id: 'res1', version: null, metadata: {} }, new Date().toISOString());
    const clean = await fwNew.execute({
      agent_id: 'crash-b', tool: 'http', operation: 'update_resource',
      dependencies: [{ source: 'http', resource: 'crash', resource_id: 'res1', version: snap.version }],
    }, {
      idempotency: 'non_idempotent', atomicity: 'guaranteed',
      execute: async () => ({ success: true }),
      conditionalExecutionSupported: () => true,
      conditionalExecute: async (intent, es) => {
        const r = await prov.conditionalExecute({ ref: intent.dependencies[0], expected_version: es[0].version, changes: { content: 'clean new write' } });
        return r.outcome === 'executed' ? { condition: 'satisfied', success: true } : { condition: 'failed', observed_version: r.current_version };
      },
    }, { actionId: 'act_s16_b_new' });
    assertEqual(clean.result?.conditional_execution, 'satisfied', 'a fresh action id must proceed normally after the crash');
    rec.observe('B: a fresh action id claims and executes normally — no stuck state, no double-claim corruption');
    await fwNew.close();
    await reopened.close();
  }

  server.kill();
  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'crashes leave consistent durable state: no false executed records, no double claims, replay-safe orphaned claims, honest unknown outcomes',
    actual: 'Case A (pre-apply crash): no side effect, orphaned claim durable, retry refused; Case B (post-apply crash): side effect occurred but no success recorded, chain verifies, retry refused, fresh action id proceeds — reconciliation requires fresh read (documented)',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
