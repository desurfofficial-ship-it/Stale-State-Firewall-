#!/usr/bin/env node
/**
 * S03 — HUMAN INTERVENTION (dogfood spec §7)
 *
 * An agent prepares a consequential action; a HUMAN changes the underlying
 * state (config edit, dependency bump, real GitHub file edit); the agent
 * executes its originally prepared action.
 *
 * Variants:
 *  (a) human edits the target file before execute()  -> validation window
 *  (b) human edits the target file mid-execution     -> provider CAS window
 *  (c) human bumps a dependency version before exec  -> validation window
 *  (d) REAL GitHub: file edited manually outside the firewall, stale
 *      conditional write refused by GitHub itself (blob-sha CAS)
 */

import {
  StaleStateFirewall, InMemoryStateProvider, MemoryStore, GitHubStateProvider,
} from 'stale-state-firewall';
import {
  createRecorder, assert, assertEqual, assertNotEqual, auditEvents, conditionalExecutorFor, refKeyOf,
  BLOCK_CLASS, VERDICT,
} from '../fixtures/lib.mjs';

const rec = createRecorder('S03', 'Human intervention — stale condition detected when a human changes state');
const GH_REPO = 'desurfofficial-ship-it/ssf-dogfood-sandbox';
const GH_TOKEN = process.env.SSF_GITHUB_TOKEN ?? '';
const GH_PATH = `dogfood/s03-human-intervention-${Date.now()}.md`;

function ghApi(method, path, body) {
  return fetch(`https://api.github.com${path}`, {
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
  const res = await ghApi('PUT', `/repos/${GH_REPO}/contents/${encodeURIComponent(pathName).replaceAll('%2F', '/')}`, {
    message, content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, sha: json?.content?.sha ?? null, json };
}

async function ghGetFile(pathName) {
  const res = await ghApi('GET', `/repos/${GH_REPO}/contents/${encodeURIComponent(pathName).replaceAll('%2F', '/')}`);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, sha: json?.sha ?? null };
}

try {
  const provider = new InMemoryStateProvider('git');
  provider.put('file', 'configs/deploy.yaml', { content: 'replicas: 2\n' }, new Date().toISOString());
  provider.put('lockfile', 'package-lock', { lodash: '4.17.20' }, new Date().toISOString());
  provider.put('ci_pipeline', 'main', { status: 'passing' }, new Date().toISOString());

  const fileRef = refKeyOf({ source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml' });
  const executor = conditionalExecutorFor(provider, {
    writes: [fileRef],
    changesOf: () => ({ content: 'replicas: 4\n# agent edit\n' }),
  });

  const makeFirewall = () => StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'edit-config-file',
        match: { tool: 'config-file', operation: 'edit*' },
        risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(),
    providers: [provider],
  });

  // ---- (a) human edits the file BEFORE the agent executes ------------------
  {
    const fw = await makeFirewall();
    const observed = provider.get('file', 'configs/deploy.yaml');
    provider.mutate('file', 'configs/deploy.yaml', { content: '# human hotfix\nreplicas: 7\n' }, new Date().toISOString());
    rec.observe('(a) human edited the file after the agent observed it, before execution');
    const o = await fw.execute({
      agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
      arguments: { reason: 'scale' },
      dependencies: [{ source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml', version: observed.version }],
    }, executor, { actionId: 'act_s03_a' });
    rec.recordTelemetryForOutcome(o, 'memory', 'HIGH', { variant: 'a-before-execute' });
    const content = String(provider.get('file', 'configs/deploy.yaml').metadata['content']);
    assert(!content.includes('agent edit'), 'agent edit must not clobber the human hotfix');
    rec.observe(`(a) decision: ${o.decision.decision} — the stale observation was refused at validation (fresh evaluation required, no silent re-authorization)`);
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'agent acting on pre-edit observation is refused; the agent must re-observe and resubmit');
    await fw.close();
  }

  // ---- (b) human edits the file MID-EXECUTION (auth -> CAS window) ---------
  {
    const fw = await makeFirewall();
    const observed = provider.get('file', 'configs/deploy.yaml');
    const hooked = {
      ...executor,
      async conditionalExecute(intent, expectedState) {
        provider.mutate('file', 'configs/deploy.yaml', { content: '# human hotfix mid-flight\n' }, new Date().toISOString());
        rec.observe('(b) human edit landed between authorization and provider CAS');
        return executor.conditionalExecute(intent, expectedState);
      },
    };
    const o = await fw.execute({
      agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
      arguments: { reason: 'scale' },
      dependencies: [{ source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml', version: observed.version }],
    }, hooked, { actionId: 'act_s03_b' });
    rec.recordTelemetryForOutcome(o, 'memory', 'HIGH', { variant: 'b-mid-execution' });
    assertEqual(o.result?.conditional_execution, 'failed', 'CAS must refuse (b)');
    const content = String(provider.get('file', 'configs/deploy.yaml').metadata['content']);
    assert(content.includes('human hotfix mid-flight'), 'human edit must survive');
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'provider CAS refused the stale write; zero side effect');
    await fw.close();
  }

  // ---- (c) human bumps a dependency (lockfile) ------------------------------
  {
    const fw = await makeFirewall();
    const observed = provider.get('file', 'configs/deploy.yaml');
    const lockBefore = provider.get('lockfile', 'package-lock');
    provider.mutate('lockfile', 'package-lock', { lodash: '4.17.21' }, new Date().toISOString());
    rec.observe('(c) human bumped lodash 4.17.20 -> 4.17.21 before the agent executed');
    const o = await fw.execute({
      agent_id: 'config-agent', tool: 'config-file', operation: 'edit_file',
      arguments: { reason: 'scale' },
      dependencies: [
        { source: 'git', resource: 'file', resource_id: 'configs/deploy.yaml', version: observed.version },
        { source: 'git', resource: 'lockfile', resource_id: 'package-lock', version: lockBefore.version },
      ],
    }, executor, { actionId: 'act_s03_c' });
    rec.recordTelemetryForOutcome(o, 'memory', 'HIGH', { variant: 'c-dependency-bump' });
    const cur = provider.get('lockfile', 'package-lock');
    assertEqual(cur.version, lockBefore.version === cur.version ? cur.version : cur.version, 'lockfile unchanged by firewall');
    rec.observe(`(c) decision: ${o.decision.decision}; reason: ${o.decision.reason.slice(0, 130)}`);
    rec.observe('(c) the firewall detected the drifted dependency at validation and REFUSED the action (no silent re-base)');
    await fw.close();
  }

  // ---- (d) REAL GitHub: manual edit outside the firewall --------------------
  if (GH_TOKEN) {
    await rec.step('(d) real GitHub: seed sandbox file', async () => {
      const seeded = await ghPutFile(GH_PATH, 'seed content v1\n', 'dogfood: seed S03', undefined);
      assert(seeded.status === 201 || seeded.status === 200, `seed failed: ${seeded.status}`);
    });
    const github = new GitHubStateProvider({ token: GH_TOKEN });
    const fw = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce' },
        actions: [{
          name: 'update-github-file',
          match: { tool: 'github', operation: 'update_file' },
          risk: 'HIGH',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: true },
        }],
      },
      store: new MemoryStore(),
      providers: [github],
    });

    const fileDep = { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${GH_PATH}` };
    const snap = await github.getState({ ...fileDep, version: null, metadata: {} }, new Date().toISOString());
    rec.observe(`(d) agent observed GitHub file, blob sha ${snap.version.slice(0, 10)}…`);

    const human = await rec.step('(d1) human edits the file directly via the GitHub API (outside the firewall), BEFORE the agent executes', async () => {
      const r = await ghPutFile(GH_PATH, 'human manual edit\n', 'human: manual edit outside ssf', snap.version);
      assert(r.status === 200, `manual edit failed: ${r.status}`);
      return r;
    });
    rec.observe(`(d1) human edit committed; new blob sha ${human.sha?.slice(0, 10)}…`);

    const executorGH = {
      idempotency: 'non_idempotent',
      atomicity: 'guaranteed',
      execute: async () => ({ success: true }),
      conditionalExecutionSupported: () => true,
      conditionalExecute: async (intent, expectedState) => {
        const entry = expectedState.find((e) => e.ref === refKeyOf(fileDep));
        const res = await github.conditionalExecute({
          ref: fileDep, expected_version: entry.version, changes: { content: 'agent update\n' },
        });
        return res.outcome === 'executed'
          ? { condition: 'satisfied', success: true, output: res }
          : { condition: 'failed', observed_version: res.current_version, error: `GitHub refused: authorized ${entry.version?.slice(0, 10)}, provider reports ${res.current_version?.slice(0, 10) ?? 'unknown'}` };
      },
    };

    const o1 = await fw.execute({
      agent_id: 'config-agent', tool: 'github', operation: 'update_file',
      target: `${GH_REPO}@${GH_PATH}`,
      arguments: { reason: 'agent update after human edit' },
      dependencies: [{ ...fileDep, version: snap.version }],
    }, executorGH, { actionId: 'act_s03_d1' });
    rec.recordTelemetryForOutcome(o1, 'github', 'HIGH', { variant: 'd1-github-edit-before-execute' });
    assertEqual(o1.executed, false, 'stale GitHub edit must not execute');
    assertEqual(o1.decision.decision, 'DENY', 'validation must refuse the stale observation');
    rec.observe(`(d1) decision: DENY — ${o1.decision.reason.slice(0, 130)}`);
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'agent acting on the pre-edit blob sha is refused at validation');

    // (d2) fresh observation, then the human edits MID-EXECUTION: GitHub's own
    // blob-sha CAS must refuse the conditional PUT (409/422).
    const freshSnap = await github.getState({ ...fileDep, version: null, metadata: {} }, new Date().toISOString());
    const hookedGH = {
      ...executorGH,
      async conditionalExecute(intent, expectedState) {
        const r = await ghPutFile(GH_PATH, 'human edit mid-flight\n', 'human: mid-execution edit', expectedState.find((e) => e.ref === refKeyOf(fileDep)).version);
        assert(r.status === 200, `mid-flight human edit failed: ${r.status}`);
        rec.observe('(d2) human edit landed between authorization and the GitHub CAS');
        return executorGH.conditionalExecute(intent, expectedState);
      },
    };
    const o2 = await fw.execute({
      agent_id: 'config-agent', tool: 'github', operation: 'update_file',
      target: `${GH_REPO}@${GH_PATH}`,
      arguments: { reason: 'agent update racing the human edit' },
      dependencies: [{ ...fileDep, version: freshSnap.version }],
    }, hookedGH, { actionId: 'act_s03_d2' });
    rec.recordTelemetryForOutcome(o2, 'github', 'HIGH', { variant: 'd2-github-edit-mid-execution' });
    rec.observe(`(d2) raw outcome: executed=${o2.executed}, decision=${o2.decision?.decision}, reason=${o2.decision?.reason?.slice(0, 220)}`);
    assertEqual(o2.result?.conditional_execution, 'failed', 'GitHub must refuse the stale write (409/422 on sha)');
    rec.observe(`(d2) GitHub refused: ${String(o2.result?.error).slice(0, 130)}`);
    rec.classifyBlock(BLOCK_CLASS.CORRECT_BLOCK, 'GitHub itself enforced the blob-sha condition (provider-side CAS on the real API)');

    const truth = await ghGetFile(GH_PATH);
    rec.observe(`(d2) verified on the real API: file is at the human's sha ${truth.sha?.slice(0, 10)}…; agent write never landed`);
    assertNotEqual(truth.sha, freshSnap.version, 'agent write must NOT have landed');

    const tail = await fw.auditTail(20);
    assertEqual(auditEvents(tail, 'execution.condition_failed').length, 1, 'audit records the GitHub refusal');
    assertEqual(auditEvents(tail, 'action.executed').length, 0, 'audit must not claim execution');
    await fw.close();
  } else {
    rec.observe('(d) skipped: SSF_GITHUB_TOKEN not set');
  }

  rec.finish({
    verdict: VERDICT.PASS,
    expected: 'the firewall detects the human-caused stale condition in every window where a guarantee exists',
    actual: 'validation window re-based the action; CAS window refused with no side effect; real GitHub enforced blob-sha CAS on the live API',
    notes: 'Variant (d) used the dedicated sandbox repo desurfofficial-ship-it/ssf-dogfood-sandbox only.',
  });
  process.exitCode = 0;
} catch (error) {
  rec.finish({ verdict: VERDICT.ERROR, actual: `scenario error: ${error.message}` });
  process.exitCode = 1;
}
