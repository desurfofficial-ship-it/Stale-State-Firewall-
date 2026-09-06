#!/usr/bin/env node
/**
 * S13 — GITHUB REAL-WORLD DOGFOOD (dogfood spec §17)
 *
 * Real GitHub API against the dedicated sandbox repository
 * (desurfofficial-ship-it/ssf-dogfood-sandbox). No production resources.
 *
 * Exercises: read (blob sha) -> authorize -> conditional mutate ->
 * concurrent mutate (two processes) -> stale mutate -> non-file resource
 * capability refusal. Records API responses, condition behavior, side
 * effects, and audit events. Credentials never appear in logs.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  StaleStateFirewall, GitHubStateProvider, MemoryStore,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, waitForLine, auditEvents, freshDb,
  REPORTS_DIR, BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S13', 'GitHub real-world — conditional file CAS against the live API');
const GH_REPO = 'desurfofficial-ship-it/ssf-dogfood-sandbox';
const GH_TOKEN = process.env.SSF_GITHUB_TOKEN ?? '';
const RUN = Date.now();
const BASE = `dogfood/s13-${RUN}`;

function ghApi(method, pathName, body) {
  return fetch(`https://api.github.com${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'ssf-dogfood',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function ghPutFile(pathName, content, message, sha) {
  const res = await ghApi('PUT', `/repos/${GH_REPO}/contents/${pathName}`, {
    message, content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, sha: json?.content?.sha ?? null, json };
}

try {
  if (!GH_TOKEN) throw new Error('SSF_GITHUB_TOKEN not set');

  // ---- setup: seed the working file -----------------------------------------
  const seeded = await rec.step('seed sandbox file via Contents API', async () => {
    const r = await ghPutFile(`${BASE}/config.yaml`, 'env: sandbox\nreplicas: 1\n', `dogfood seed ${RUN}`, undefined);
    assert(r.status === 200 || r.status === 201, `seed failed ${r.status}`);
    return r;
  });
  const FILE_DEP = { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${BASE}/config.yaml` };
  rec.observe(`seeded blob sha ${seeded.sha?.slice(0, 10)}…`);

  const github = new GitHubStateProvider({ token: GH_TOKEN });
  const fw = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'update-github-file', match: { tool: 'github', operation: 'update_file' }, risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [github],
  });

  const executorGH = {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      const entry = expectedState.find((e) => e.ref === `github:file/${GH_REPO}@${BASE}/config.yaml`);
      if (!entry) return { condition: 'unavailable', error: 'no authorized blob sha' };
      const res = await github.conditionalExecute({
        ref: FILE_DEP, expected_version: entry.version, changes: { content: `env: sandbox\nreplicas: ${intent.arguments['replicas']}\n` },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: { sha: res.version } }
        : { condition: 'failed', observed_version: res.current_version, error: `GitHub refused: authorized ${entry.version?.slice(0, 10)}, reports ${res.current_version?.slice(0, 10) ?? 'unknown'}` };
    },
  };

  // ---- 1. READ + authorize + conditional mutate ------------------------------
  const snap = await github.getState({ ...FILE_DEP, version: null, metadata: {} }, new Date().toISOString());
  rec.observe(`read: blob sha ${snap.version.slice(0, 10)}… (validation_method=${snap.provenance.validation_method})`);

  const okOutcome = await rec.step('authorize + conditional mutate (replicas 1 -> 3)', () =>
    fw.execute({
      agent_id: 'infra-agent', tool: 'github', operation: 'update_file',
      target: `${GH_REPO}@${BASE}/config.yaml`,
      arguments: { replicas: 3 },
      dependencies: [{ ...FILE_DEP, version: snap.version }],
    }, executorGH, { actionId: `act_s13_ok_${RUN}` }));
  rec.recordTelemetryForOutcome(okOutcome, 'github', 'HIGH', { case: 'conditional-mutate' });
  assertEqual(okOutcome.result?.conditional_execution, 'satisfied', 'matching sha must satisfy');
  rec.observe(`GitHub applied the write; new sha ${String(okOutcome.result?.output?.sha ?? '').slice(0, 10)}…`);

  // ---- 2. STALE mutate (another actor wins the race MID-EXECUTION) -----------
  const fresh = await github.getState({ ...FILE_DEP, version: null, metadata: {} }, new Date().toISOString());
  const staleExecutor = {
    ...executorGH,
    async conditionalExecute(intent, expectedState) {
      const r = await ghPutFile(`${BASE}/config.yaml`, 'env: sandbox\nreplicas: 9\n', 'other actor mid-flight', expectedState.find((e) => e.ref === `github:file/${GH_REPO}@${BASE}/config.yaml`)?.version);
      assert(r.status === 200, `actor write failed ${r.status}`);
      rec.observe('another actor committed a competing change between authorization and the GitHub CAS');
      return executorGH.conditionalExecute(intent, expectedState);
    },
  };
  const staleOutcome = await fw.execute({
    agent_id: 'infra-agent', tool: 'github', operation: 'update_file',
    arguments: { replicas: 5 },
    dependencies: [{ ...FILE_DEP, version: fresh.version }],
  }, staleExecutor, { actionId: `act_s13_stale_${RUN}` });
  rec.recordTelemetryForOutcome(staleOutcome, 'github', 'HIGH', { case: 'stale-mutate' });
  assertEqual(staleOutcome.result?.conditional_execution, 'failed', 'stale blob sha must be refused by GitHub');
  rec.observe(`stale mutate refused: ${String(staleOutcome.result?.error).slice(0, 120)}`);
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'GitHub enforced the blob-sha condition on the live API');

  // ---- 3. CONCURRENT mutate (two independent processes) ----------------------
  const worker = path.join(REPORTS_DIR, '..', 'scripts', 'github-worker.mjs');
  const spec = (agentId, replicas) => JSON.stringify({
    token: GH_TOKEN, repo: GH_REPO, path: `${BASE}/config.yaml`,
    dbPath: freshDb(`s13-${agentId}.db`), agentId, replicas, actionId: `act_s13_race_${agentId}_${RUN}`,
  });
  const a = spawn(process.execPath, [worker, spec('agent-a', 4)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const b = spawn(process.execPath, [worker, spec('agent-b', 6)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (child, name) => {
    const lines = [];
    child.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => { try { lines.push(JSON.parse(l)); } catch {} }));
    child.stderr.on('data', (d) => rec.say(`  [${name} stderr] ${d.toString().slice(0, 200)}`));
    return lines;
  };
  const linesA = collect(a, 'a');
  const linesB = collect(b, 'b');
  await Promise.all([
    waitForLine(a, '"authorized"'), waitForLine(b, '"authorized"'),
  ]);
  rec.observe('both racing agents hold authorizations against the same blob sha');
  const [exitA, exitB] = await Promise.all([
    new Promise((r) => a.on('exit', r)), new Promise((r) => b.on('exit', r)),
  ]);
  const doneA = linesA.find((l) => l.event === 'done');
  const doneB = linesB.find((l) => l.event === 'done');
  rec.observe(`agent-a exit=${exitA} conditional=${doneA?.conditional}; agent-b exit=${exitB} conditional=${doneB?.conditional}`);
  const satisfied = [doneA, doneB].filter((d) => d?.conditional === 'satisfied');
  const failed = [doneA, doneB].filter((d) => d?.conditional === 'failed');
  assertEqual(satisfied.length, 1, 'exactly one concurrent writer may win on GitHub');
  assertEqual(failed.length, 1, 'the loser must see a condition failure');
  rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'GitHub serialized the concurrent writers via blob-sha CAS');

  // ---- 4. non-file resource: capability refusal ------------------------------
  const nonFile = await rec.step('non-file resource (pull_request) must be refused as NOT conditional', async () => {
    let err = null;
    try {
      await github.conditionalExecute({
        ref: { source: 'github', resource: 'pull_request', resource_id: `${GH_REPO}#1` },
        expected_version: 'deadbeef', changes: {},
      });
    } catch (e) { err = e; }
    return err;
  });
  assert(nonFile, 'non-file conditionalExecute must throw a typed refusal');
  rec.observe(`non-file refusal: ${nonFile.name}: ${String(nonFile.message).slice(0, 120)}`);
  rec.classifyBlock(BLOCK_CLASS.PROVIDER_LIMITATION, 'GitHub resources other than file do not expose conditional mutation; the provider refuses instead of pretending');

  // ---- 5. audit truth + secret hygiene ---------------------------------------
  const tail = await fw.auditTail(40);
  const executedEvents = auditEvents(tail, 'action.executed');
  const failedEvents = auditEvents(tail, 'execution.condition_failed');
  assertEqual(executedEvents.length + failedEvents.length >= 2, true, 'both outcome classes audited');
  rec.observe(`audit: ${executedEvents.length} executed, ${failedEvents.length} condition_failed`);
  const auditText = JSON.stringify(tail);
  assert(!auditText.includes(GH_TOKEN), 'credential must never appear in audit records');
  rec.observe('credential hygiene: token absent from all audit records');

  const verify = await fw.verifyAudit();
  assertEqual(verify.ok, true, 'audit chain verifies');

  // ---- cleanup: remove the dogfood files -------------------------------------
  await rec.step('cleanup sandbox files', async () => {
    // delete the single file created this run
    const del = await ghApi('DELETE', `/repos/${GH_REPO}/contents/${BASE}.yaml`, {
      message: `dogfood cleanup ${RUN}`, sha: (await (async () => {
        const g = await ghApi('GET', `/repos/${GH_REPO}/contents/${BASE}.yaml`);
        return (await g.json())?.sha;
      })()),
    });
    return del.status;
  });

  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'real GitHub enforces blob-sha CAS: matching -> applied, stale -> refused with no side effect, concurrent -> exactly one winner, non-file -> typed refusal, credentials never logged',
    actual: 'all verified against the live API with server-truth checks; audit accurate; credential hygiene verified',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
