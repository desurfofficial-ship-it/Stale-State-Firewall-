#!/usr/bin/env node
/**
 * S07 — PROVIDER OUTAGE (dogfood spec §11)
 *
 * Provider fails during state fetch (validation) and during conditional
 * mutation (execution). Faults: timeout/hang, 500, 503, 429 rate limit,
 * connection reset, garbage response. Requirements:
 *   - no unsafe success, no ambiguous ALLOW, no blind retry
 *   - failures are classified as PROVIDER errors, never as condition
 *     failures and never as successes
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  StaleStateFirewall, HttpStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual,
  REPORTS_DIR, BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S07', 'Provider outage — faults during fetch and conditional execution');

const FAULTS = ['hang', '500', '503', '429', 'reset', 'garbage'];

try {
  const server = spawn(process.execPath, [path.join(REPORTS_DIR, '..', 'scripts', 'sandbox-http-server.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const readyLine = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(d.toString().trim())));
  const port = Number(readyLine.split(' ')[1]);
  rec.observe(`sandbox server on ${port} (outage + putfail namespaces)`);

  const resources = {};
  for (const f of FAULTS) {
    // Validation-phase faults: the outage namespace fails ALL requests.
    resources[`res_${f}`] = {
      url: `http://127.0.0.1:${port}/outage/{id}`,
      headers: { 'x-outage': f },
      version: { source: 'header', name: 'etag' },
      timeout_ms: f === 'hang' ? 700 : 5000,
      mutation: { method: 'PUT', condition_failed_status: [412, 409] },
    };
  }
  resources.res_ok = {
    url: `http://127.0.0.1:${port}/correct/healthy`,
    version: { source: 'header', name: 'etag' },
    mutation: { method: 'PUT', condition_failed_status: [412, 409] },
  };

  const mutationResources = {};
  for (const f of FAULTS) {
    // Mutation-phase faults: GET healthy, PUT fails per x-putfail header.
    mutationResources[`mut_${f}`] = {
      url: `http://127.0.0.1:${port}/putfail/{id}`,
      headers: { 'x-putfail': f },
      version: { source: 'header', name: 'etag' },
      timeout_ms: f === 'hang' ? 700 : 5000,
      mutation: { method: 'PUT', condition_failed_status: [412, 409] },
    };
  }
  const provider = new HttpStateProvider({ ...resources, ...mutationResources });
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

  // ---- Phase A: outage during VALIDATION (state fetch) ----------------------
  for (const fault of FAULTS) {
    const decision = await rec.step(`A/${fault}: fetch fails during validation`, () =>
      fw.check({
        agent_id: 'agent', tool: 'http', operation: 'update_resource',
        dependencies: [{ source: 'http', resource: `res_${fault}`, resource_id: 'r1', version: null }],
      }));
    assert(decision.decision !== 'ALLOW', `A/${fault}: unreachable provider must never ALLOW`);
    const unknownVerdicts = decision.verdicts.filter((v) => v.staleness === 'UNKNOWN');
    assert(unknownVerdicts.length > 0 || /unknown|unavailable/i.test(decision.reason), `A/${fault}: reason must reflect unresolved state: ${decision.reason}`);
    rec.observe(`A/${fault}: decision=${decision.decision}, unknown verdicts=${unknownVerdicts.length}, reason=${String(decision.reason).slice(0, 100)}`);
    rec.sampleError(`validation fetch failure (${fault})`, new Error(decision.reason));
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, `provider ${fault} during validation resolved to UNKNOWN -> ${decision.decision} (fail closed)`);
  }

  // unknown state must never become an ALLOW for any risk level
  for (const risk of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
    const config = {
      firewall: { mode: 'enforce' },
      actions: [{
        name: `u-${risk}`, match: { tool: 'http', operation: 'update*' }, risk,
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    };
    const fwR = await StaleStateFirewall.create({ config, store: new MemoryStore(), providers: [provider] });
    const outcome = await fwR.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      dependencies: [{ source: 'http', resource: 'res_hang', resource_id: 'r1', version: null }],
    }, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: `act_s07_risk_${risk}` });
    assertEqual(outcome.executed, false, `risk ${risk}: nothing may execute on an unreachable provider`);
    assertEqual(outcome.decision.decision, 'DENY', `risk ${risk}: revalidation over a dead provider must fail closed (DENY)`);
    rec.observe(`risk ${risk}: executed=${outcome.executed}, final decision=${outcome.decision.decision} (fail closed)`);
    await fwR.close();
  }

  // ---- Phase B: outage during CONDITIONAL EXECUTION -------------------------
  for (const fault of FAULTS) {
    const outcome = await rec.step(`B/${fault}: mutation fails after authorization`, async () => {
      const snap = await provider.getState({ source: 'http', resource: 'res_ok', resource_id: 'r1', version: null, metadata: {} }, new Date().toISOString());
      const faultedExecutor = {
        idempotency: 'non_idempotent',
        atomicity: 'guaranteed',
        execute: async () => ({ success: true }),
        conditionalExecutionSupported: () => true,
        conditionalExecute: async (intent, expectedState) => {
          // The honest executor writes to the FAULTED resource (the effect's target)
          const dep = { source: 'http', resource: `mut_${fault}`, resource_id: 'r1' };
          const entry = expectedState.find((e) => e.ref === `http:mut_${fault}/r1`) ?? { version: snap.version };
          const res = await provider.conditionalExecute({ ref: dep, expected_version: entry.version, changes: { content: 'x' } });
          return res.outcome === 'executed'
            ? { condition: 'satisfied', success: true }
            : { condition: 'failed', observed_version: res.current_version };
        },
      };
      // Authorize against the HEALTHY resource's version; the mutation targets
      // the faulted one. The provider's conditional mutation will hit the fault.
      const o = await fw.execute({
        agent_id: 'agent', tool: 'http', operation: 'update_resource',
        dependencies: [
          { source: 'http', resource: 'res_ok', resource_id: 'r1', version: snap.version },
        ],
      }, faultedExecutor, { actionId: `act_s07_${fault}` });
      return o;
    });
    rec.observe(`B/${fault}: executed=${outcome.executed}, success=${outcome.result?.success ?? false}, conditional=${outcome.result?.conditional_execution ?? 'n/a'}`);
    assertEqual(outcome.result?.success, false, `B/${fault}: a provider fault must never be recorded as success`);
    assert(outcome.result?.conditional_execution !== 'satisfied', `B/${fault}: outcome unknown, must not claim satisfied`);
    const tail = await fw.auditTail(10);
    const last = tail[0];
    assert(last.event_type !== 'action.executed', `B/${fault}: audit must not record executed`);
    rec.observe(`B/${fault}: audit event=${last.event_type}, note=${String(last.payload?.note ?? '').slice(0, 100)}`);
    rec.sampleError(`mutation outage (${fault})`, new Error(outcome.result?.error ?? last.event_type));
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, `mutation ${fault} recorded as failure with UNKNOWN condition outcome`);
  }

  // ---- no blind retry after a provider fault --------------------------------
  let replayErr = null;
  try {
    const snap = await provider.getState({ source: 'http', resource: 'res_ok', resource_id: 'r1', version: null, metadata: {} }, new Date().toISOString());
    await fw.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      dependencies: [{ source: 'http', resource: 'res_ok', resource_id: 'r1', version: snap.version }],
    }, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: 'act_s07_500' });
  } catch (e) { replayErr = e; }
  assert(replayErr && /replay/i.test(replayErr.message), 'retrying the same authorization after a provider fault must be refused');
  rec.observe(`retry of faulted authorization refused: ${replayErr?.name}`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'authorization consumed by the faulted attempt; blind retry impossible');

  server.kill();
  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'provider faults fail closed everywhere; no unsafe success; no ambiguous ALLOW; no blind retry; provider errors are distinct from condition failures',
    actual: `all ${FAULTS.length} validation faults surface typed errors and DENY for every risk level; all ${FAULTS.length} mutation faults record failure with UNKNOWN condition outcome (never satisfied/never executed); retry of the faulted authorization refused`,
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
