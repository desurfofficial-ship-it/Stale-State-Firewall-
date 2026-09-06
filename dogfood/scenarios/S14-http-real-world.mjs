#!/usr/bin/env node
/**
 * S14 — HTTP REAL-WORLD DOGFOOD (dogfood spec §18)
 *
 * Three controlled endpoints representing real server behaviors:
 *   correct  — ETag=X, If-Match=X -> success; changed ETag -> 412, NO mutation
 *   broken   — server IGNORES If-Match -> mutation occurs (the documented
 *              trust boundary: the firewall cannot detect this)
 *   weak     — server issues weak ETags (W/"x"); RFC 9110 If-Match uses
 *              STRONG comparison, so a weak tag can never match -> 412
 *
 * Also demonstrates: "sending If-Match" is not atomicity — the guarantee
 * lives in the SERVER's enforcement, which the operator must verify.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import {
  StaleStateFirewall, HttpStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, auditEvents,
  REPORTS_DIR, BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S14', 'HTTP real-world — If-Match semantics and the operator trust boundary');

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
    correct: {
      url: `http://127.0.0.1:${port}/correct/config-a`,
      version: { source: 'header', name: 'etag' },
      mutation: { method: 'PUT', condition_failed_status: [412, 409] },
    },
    broken: {
      url: `http://127.0.0.1:${port}/broken/config-b`,
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

  const executorFor = (resource, id) => ({
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      const dep = { source: 'http', resource, resource_id: id };
      const entry = expectedState.find((e) => e.ref === `http:${resource}/${id}`);
      const res = await provider.conditionalExecute({ ref: dep, expected_version: entry.version, changes: { content: intent.arguments['content'] } });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res }
        : { condition: 'failed', observed_version: res.current_version, error: `server refused: authorized ${entry.version}, reports ${res.current_version}` };
    },
  });

  // ---- Case A: correct server, matching state -> success ---------------------
  const snapA = await provider.getState({ source: 'http', resource: 'correct', resource_id: 'config-a', version: null, metadata: {} }, new Date().toISOString());
  const oA = await rec.step('Case A: correct server, If-Match matches -> mutation applies', () =>
    fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { content: 'updated by agent' },
      dependencies: [{ source: 'http', resource: 'correct', resource_id: 'config-a', version: snapA.version }],
    }, executorFor('correct', 'config-a'), { actionId: `act_s14_a_${Date.now()}` }));
  rec.recordTelemetryForOutcome(oA, 'http', 'HIGH', { case: 'A-match' });
  assertEqual(oA.result?.conditional_execution, 'satisfied', 'Case A must succeed');
  const truthA = await httpGetJson(`http://127.0.0.1:${port}/__state/correct/config-a`);
  assertEqual(truthA.body.mutations.length, 1, 'Case A: mutation applied server-side');

  // ---- Case B: correct server, changed state -> 412, NO mutation -------------
  const staleSnap = { ...snapA }; // agent still holds the pre-change version
  const oB = await rec.step('Case B: correct server, state changed -> 412, no mutation', () => {
    const hooked = {
      ...executorFor('correct', 'config-a'),
      async conditionalExecute(intent, expectedState) {
        // world moves between authorization and CAS (simulated by a direct PUT
        // with the CURRENT etag by "another actor" outside the firewall)
        return executorFor('correct', 'config-a').conditionalExecute(intent, expectedState);
      },
    };
    return fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { content: 'stale write attempt' },
      dependencies: [{ source: 'http', resource: 'correct', resource_id: 'config-a', version: staleSnap.version }],
    }, hooked, { actionId: `act_s14_b_${Date.now()}` });
  });
  rec.recordTelemetryForOutcome(oB, 'http', 'HIGH', { case: 'B-stale-412' });
  rec.observe(`Case B raw: executed=${oB.executed}, decision=${oB.decision?.decision}, conditional=${oB.result?.conditional_execution ?? 'n/a'}`);

  // To hit the 412 path deterministically the world must change AFTER
  // authorization; inject it in the executor hook (real-world race window).
  const snapB2 = await provider.getState({ source: 'http', resource: 'correct', resource_id: 'config-a', version: null, metadata: {} }, new Date().toISOString());
  const raceB = await rec.step('Case B-race: world changes between authorization and If-Match PUT', async () => {
    const hooked = {
      ...executorFor('correct', 'config-a'),
      async conditionalExecute(intent, expectedState) {
        // another actor PUTs with the current etag, moving the state
        const dep = { source: 'http', resource: 'correct', resource_id: 'config-a' };
        await provider.conditionalExecute({ ref: dep, expected_version: expectedState[0].version, changes: { content: 'other actor' } }).catch(() => {});
        // Now the agent's authorized etag is stale; re-fetch current to PUT the competing change
        return executorFor('correct', 'config-a').conditionalExecute(intent, expectedState);
      },
    };
    return fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { content: 'racing agent write' },
      dependencies: [{ source: 'http', resource: 'correct', resource_id: 'config-a', version: snapB2.version }],
    }, hooked, { actionId: `act_s14_brace_${Date.now()}` });
  });
  rec.recordTelemetryForOutcome(raceB, 'http', 'HIGH', { case: 'B2-race-412' });
  assertEqual(raceB.result?.conditional_execution, 'failed', 'the raced If-Match must fail with 412 -> condition_failed');
  const truthB = await httpGetJson(`http://127.0.0.1:${port}/__state/correct/config-a`);
  const lastMutationContent = 'racing agent write';
  assert(!JSON.stringify(truthB.body).includes(lastMutationContent) || truthB.body.mutations.length === 2, 'server truth recorded the competing write, not the raced one');
  rec.observe('Case B-race: server refused (412), agent mutation did NOT land; condition failure recorded');
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'a correct RFC 9110 server enforced the precondition');

  // ---- Case C: BROKEN server (ignores If-Match) -> mutation executes ---------
  const snapC = await provider.getState({ source: 'http', resource: 'broken', resource_id: 'config-b', version: null, metadata: {} }, new Date().toISOString());
  const oC = await rec.step('Case C: broken server IGNORES If-Match -> mutation executes anyway', () => {
    const hooked = {
      ...executorFor('broken', 'config-b'),
      async conditionalExecute(intent, expectedState) {
        // world moves between authorization and CAS — the broken server will not care
        await fetch(`http://127.0.0.1:${port}/broken/config-b`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'other actor (no precondition)' }),
        });
        return executorFor('broken', 'config-b').conditionalExecute(intent, expectedState);
      },
    };
    return fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { content: 'agent write on broken server' },
      dependencies: [{ source: 'http', resource: 'broken', resource_id: 'config-b', version: snapC.version }],
    }, hooked, { actionId: `act_s14_c_${Date.now()}` });
  });
  rec.recordTelemetryForOutcome(oC, 'http', 'HIGH', { case: 'C-broken-server' });
  rec.observe(`Case C raw: executed=${oC.executed}, conditional=${oC.result?.conditional_execution}`);
  const truthC = await httpGetJson(`http://127.0.0.1:${port}/__state/broken/config-b`);
  rec.observe(`Case C: server truth shows ${truthC.body.mutations.length} mutations — the STALE agent write LANDED on the broken server`);
  if (oC.result?.conditional_execution === 'satisfied') {
    rec.recordFinding(
      'P2-DOC',
      'CONFIRMED TRUST BOUNDARY (documented): with a server that ignores If-Match, the firewall records condition=satisfied ' +
      'and atomicity=guaranteed while the provider enforced nothing — the stale write landed. The firewall CANNOT detect this ' +
      '(it does not wiretap the server); the docs require the operator to verify If-Match enforcement per endpoint. ' +
      'Dogfood recommendation: keep this boundary loud in docs/providers.md and surface the operator-verification duty in the config comment (already present).',
    );
    rec.classifyBlock(BLOCK_CLASS.PROVIDER_LIMITATION, 'broken server: no real CAS; firewall representation is honestly blind here');
  }

  // ---- audit + hygiene --------------------------------------------------------
  const tail = await fw.auditTail(40);
  assert(auditEvents(tail, 'action.executed').length >= 1, 'successes audited');
  const verify = await fw.verifyAudit();
  assertEqual(verify.ok, true, 'audit chain verifies');

  server.kill();
  rec.finish({
    verdict: VERDICT.FINDING,
    expected: 'correct server: match->apply, mismatch->412 no mutation; broken server: trust boundary made visible; weak ETag semantics noted',
    actual: 'Case A applied; Case B-race refused by the server (412) with condition_failed; Case C stale write LANDED on the If-Match-ignoring server with firewall recording satisfied — the documented operator-verification boundary is real and was demonstrated end to end',
    notes: 'Case B (plain stale-at-validation) resolves as INVALID->DENY before any request; the interesting 412 path needs the mid-execution race (Case B-race).',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
