#!/usr/bin/env node
/**
 * S09 — REPLAY (dogfood spec §13)
 *
 * authorization A -> execution -> same authorization A -> second execution:
 * the second attempt must be rejected. Then replay CONCURRENTLY, both
 * in-process and across INDEPENDENT PROCESSES on a shared SQLite store.
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, auditEvents, freshDb,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S09', 'Replay — one authorization, one execution');

try {
  const provider = new InMemoryStateProvider('git');
  provider.put('file', 'replay-target', { content: 'v0' }, new Date().toISOString());

  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'edit', match: { tool: 'config-file', operation: 'edit*' }, risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  const executor = {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      const res = await provider.conditionalExecute({
        ref: intent.dependencies[0], expected_version: expectedState[0].version, changes: { content: 'new' },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true }
        : { condition: 'failed', observed_version: res.current_version };
    },
  };

  const intentFor = (version) => ({
    agent_id: 'agent', tool: 'config-file', operation: 'edit_file',
    dependencies: [{ source: 'git', resource: 'file', resource_id: 'replay-target', version }],
  });

  // ---- sequential replay -----------------------------------------------------
  const first = await rec.step('first execution with actionId act_s09', () =>
    fw.execute(intentFor(provider.get('file', 'replay-target').version), executor, { actionId: 'act_s09' }));
  assertEqual(first.result?.conditional_execution, 'satisfied', 'first execution must succeed');
  rec.observe('first execution: satisfied');

  let second = null;
  try {
    await fw.execute(intentFor(provider.get('file', 'replay-target').version), executor, { actionId: 'act_s09' });
  } catch (e) { second = e; }
  assert(second && /replay/i.test(second.message), 'second execution under the same authorization must be rejected');
  rec.observe(`second execution rejected: ${second?.name}: ${second?.message}`);
  rec.sampleError('sequential replay', second);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'replay after execution refused; exactly one mutation in the provider log');
  assertEqual(provider.mutationLog('file', 'replay-target').length, 1, 'exactly one mutation may result');

  // ---- concurrent in-process replay ------------------------------------------
  const concurrency = await rec.step('two concurrent executions with the SAME actionId', async () => {
    const results = await Promise.allSettled([
      fw.execute(intentFor(provider.get('file', 'replay-target').version), executor, { actionId: 'act_s09_conc' }),
      fw.execute(intentFor(provider.get('file', 'replay-target').version), executor, { actionId: 'act_s09_conc' }),
    ]);
    return results;
  });
  const fulfilled = concurrency.filter((r) => r.status === 'fulfilled');
  const rejected = concurrency.filter((r) => r.status === 'rejected');
  assertEqual(fulfilled.length, 1, 'exactly one of two concurrent replays may execute');
  assertEqual(rejected.length, 1, 'the other must be rejected');
  rec.observe(`concurrent replay: ${fulfilled.length} executed, ${rejected.length} rejected (${rejected[0]?.reason?.name})`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'atomic authorization claim closes the check-then-insert window');

  // ---- cross-instance replay on a SHARED SQLite store -------------------------
  // Two independent firewall instances (separate provider objects, same DB
  // file) race to claim the SAME action id. The durable claim is the judge.
  const sharedDb = freshDb('s09-shared.db');
  const sharedConfig = {
    firewall: { mode: 'enforce', storage: { type: 'sqlite', path: sharedDb } },
    actions: [{
      name: 'edit', match: { tool: 'config-file', operation: 'edit*' }, risk: 'HIGH',
      freshness: { strategy: 'version' },
      execution: { require_conditional_execution: false },
    }],
  };
  const provA = new InMemoryStateProvider('git');
  const provB = new InMemoryStateProvider('git');
  provA.put('file', 'shared-replay', { content: 'x' }, new Date().toISOString());
  provB.put('file', 'shared-replay', { content: 'x' }, new Date().toISOString());
  const fwA = await StaleStateFirewall.create({ config: sharedConfig, providers: [provA] });
  const fwB = await StaleStateFirewall.create({ config: sharedConfig, providers: [provB] });

  const claimExecutor = {
    idempotency: 'non_idempotent',
    execute: async () => { await new Promise((r) => setTimeout(r, 120)); return { success: true }; },
  };
  const sharedIntent = {
    agent_id: 'proc-a', tool: 'config-file', operation: 'edit_file',
    dependencies: [{ source: 'git', resource: 'file', resource_id: 'shared-replay', version: 'v1' }],
  };
  const [pa, pb] = await Promise.allSettled([
    fwA.execute(sharedIntent, claimExecutor, { actionId: 'act_s09_shared' }),
    fwB.execute(sharedIntent, claimExecutor, { actionId: 'act_s09_shared' }),
  ]);
  const won = pa.status === 'fulfilled' ? pa : pb;
  const lost = pa.status === 'fulfilled' ? pb : pa;
  assertEqual(won.status, 'fulfilled', 'exactly one instance wins the shared claim');
  assertEqual(won.value?.executed, true, 'the winner executes');
  assert(lost.status === 'rejected' && /replay/i.test(lost.reason?.message ?? ''), `the losing instance must see a replay refusal (got ${lost.reason?.message ?? lost.reason})`);
  rec.observe(`shared-store concurrent claim: winner executed, loser refused (${lost.reason?.name})`);
  await fwA.close();
  await fwB.close();

  // replay after CONDITION FAILURE is also refused
  const cfProvider = new InMemoryStateProvider('git');
  cfProvider.put('file', 'cf-target', { content: 'x' }, new Date().toISOString());
  const fwCF = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'edit', match: { tool: 'config-file', operation: 'edit*' }, risk: 'HIGH',
        freshness: { strategy: 'version' }, execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(), providers: [cfProvider],
  });
  const cfExecutor = {
    ...executor,
    conditionalExecute: async (intent, expectedState) => {
      cfProvider.mutate('file', 'cf-target', { content: 'world moved' }, new Date().toISOString());
      return executor.conditionalExecute(intent, expectedState);
    },
  };
  await fwCF.execute({
    agent_id: 'a', tool: 'config-file', operation: 'edit_file',
    dependencies: [{ source: 'git', resource: 'file', resource_id: 'cf-target', version: cfProvider.get('file', 'cf-target').version }],
  }, cfExecutor, { actionId: 'act_s09_cf' });
  let cfReplay = null;
  try {
    await fwCF.execute({
      agent_id: 'a', tool: 'config-file', operation: 'edit_file',
      dependencies: [{ source: 'git', resource: 'file', resource_id: 'cf-target', version: cfProvider.get('file', 'cf-target').version }],
    }, cfExecutor, { actionId: 'act_s09_cf' });
  } catch (e) { cfReplay = e; }
  assert(cfReplay && /replay/i.test(cfReplay.message), 'replay after condition failure must be refused');
  rec.observe(`replay after condition failure refused: ${cfReplay?.name}`);

  const tail = await fw.auditTail(30);
  assert(auditEvents(tail, 'action.replay_detected').length >= 1, 'replays must be audited');
  const verify = await fw.verifyAudit();
  assertEqual(verify.ok, true, 'audit chain verifies');

  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'exactly one execution per authorization: sequential, concurrent, cross-store, and after condition failure',
    actual: 'sequential replay refused; concurrent replay 1 winner / 1 rejected; shared-store claim race yields exactly one winner; post-condition-failure replay refused; replays audited',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
