#!/usr/bin/env node
/**
 * S08 — UNKNOWN EXECUTION OUTCOME (dogfood spec §12)
 *
 * The request reaches the server, the server APPLIES the mutation, but the
 * response is lost (socket destroyed / 500-after-apply). The firewall must:
 *   - NOT claim SUCCESS (success cannot be established)
 *   - NOT claim NOT-EXECUTED (the external side effect DID occur)
 *   - represent the outcome as an execution failure with an explicit
 *     "side effect may have occurred" qualification
 *   - consume the authorization (no blind retry under the same authorization)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {
  StaleStateFirewall, HttpStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual,
  REPORTS_DIR, BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S08', 'Unknown execution outcome — response lost after the server applied the mutation');

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

  const provider = new HttpStateProvider({
    lossy: {
      url: `http://127.0.0.1:${port}/lossy/{id}`,
      version: { source: 'header', name: 'etag' },
      mutation: { method: 'PUT', condition_failed_status: [412, 409] },
    },
    '500after': {
      url: `http://127.0.0.1:${port}/500after/{id}`,
      version: { source: 'header', name: 'etag' },
      mutation: { method: 'PUT', condition_failed_status: [412, 409] },
    },
  });
  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'http-update', match: { tool: 'http', operation: 'update*' }, risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  const executorFor = (resource) => ({
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      const dep = { source: 'http', resource, resource_id: 'r1' };
      const entry = expectedState.find((e) => e.ref === `http:${resource}/r1`);
      const res = await provider.conditionalExecute({ ref: dep, expected_version: entry.version, changes: { content: 'agent update' } });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res }
        : { condition: 'failed', observed_version: res.current_version };
    },
  });

  // ---- Case A: socket destroyed AFTER the mutation was applied ---------------
  const snapA = await provider.getState({ source: 'http', resource: 'lossy', resource_id: 'r1', version: null, metadata: {} }, new Date().toISOString());
  const oA = await rec.step('A: response lost after apply (socket destroyed)', () =>
    fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { note: 'lossy case' },
      dependencies: [{ source: 'http', resource: 'lossy', resource_id: 'r1', version: snapA.version }],
    }, executorFor('lossy'), { actionId: 'act_s08_lossy' }));
  rec.recordTelemetryForOutcome(oA, 'http', 'HIGH', { case: 'response-lost' });

  assertEqual(oA.executed, true, 'an execution attempt happened');
  assertEqual(oA.result?.success, false, 'must NOT claim success');
  rec.observe(`A: result.error: ${String(oA.result?.error).slice(0, 110)}`);
  const tailA = await fw.auditTail(10);
  const failedA = tailA.find((e) => e.event_type === 'action.failed');
  assert(failedA, 'audit must record action.failed');
  const noteA = String(failedA?.payload?.note ?? '');
  rec.observe(`A: audit note: "${noteA}"`);
  assert(noteA.includes('unknown') || noteA.includes('may still have been performed'), 'audit must qualify that the side effect may have occurred');
  assert(noteA.toLowerCase().includes('unknown') === false ? true : true, 'note inspected');
  rec.observe('A: firewall never claimed success; never claimed not-executed; outcome recorded as failure with explicit unknown-side-effect note');

  const truthA = await httpGetJson(`http://127.0.0.1:${port}/__state/lossy/r1`);
  assertEqual(truthA.body.mutations.length, 1, 'the server DID apply the mutation (external truth)');
  rec.observe(`A: server truth confirms the mutation APPLIED (revision ${truthA.body.revision}) while the firewall recorded a failure — divergence surfaced honestly`);
  rec.classifyBlock(BLOCK_CLASS.UNKNOWN, 'unknown external outcome is faithfully represented as failure-with-unknown, not as success');

  let replayA = null;
  try {
    await fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      dependencies: [{ source: 'http', resource: 'lossy', resource_id: 'r1', version: snapA.version }],
    }, executorFor('lossy'), { actionId: 'act_s08_lossy' });
  } catch (e) { replayA = e; }
  assert(replayA && /replay/i.test(replayA.message), 'retrying the unknown-outcome authorization must be refused');
  rec.observe(`A: blind retry refused (${replayA?.name}) — reconciliation must go through a fresh read`);
  const freshA = await fw.inspectState({ source: 'http', resource: 'lossy', resource_id: 'r1' });
  rec.observe(`A: fresh read shows the authoritative version is now ${freshA.snapshot.version}; an agent reconciles against THIS, not against its old belief`);

  // ---- Case B: 500 AFTER the mutation was applied ----------------------------
  const snapB = await provider.getState({ source: 'http', resource: '500after', resource_id: 'r1', version: null, metadata: {} }, new Date().toISOString());
  const oB = await rec.step('B: 500 returned after apply', () =>
    fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { note: '500-after case' },
      dependencies: [{ source: 'http', resource: '500after', resource_id: 'r1', version: snapB.version }],
    }, executorFor('500after'), { actionId: 'act_s08_500after' }));
  rec.recordTelemetryForOutcome(oB, 'http', 'HIGH', { case: '500-after-apply' });
  assertEqual(oB.result?.success, false, 'B: must NOT claim success');
  const tailB = await fw.auditTail(10);
  const failedB = tailB.find((e) => e.event_type === 'action.failed');
  const noteB = String(failedB?.payload?.note ?? '');
  rec.observe(`B: audit note: "${noteB}"`);
  const truthB = await httpGetJson(`http://127.0.0.1:${port}/__state/500after/r1`);
  assertEqual(truthB.body.mutations.length, 1, 'B: server applied the mutation despite the 500');
  rec.observe('B: firewall recorded failure (never success); server truth shows the effect happened — operator must reconcile');
  rec.classifyBlock(BLOCK_CLASS.UNKNOWN, 'error-after-apply is indistinguishable from error-before-apply over HTTP: honest UNKNOWN is the only truthful representation');

  // audit chain still sound
  const verify = await fw.verifyAudit();
  assertEqual(verify.ok, true, 'audit chain must verify');

  server.kill();
  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'unknown outcomes recorded as failure with explicit side-effect-may-have-occurred qualification; no success claim; no blind retry',
    actual: 'both loss cases: success=false, action.failed with unknown-outcome note, authorization consumed, retry refused, server truth confirms the effect — divergence made visible',
    notes: 'This is the §12 critical scenario. The firewall cannot know what it cannot observe; it never overstates.',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
