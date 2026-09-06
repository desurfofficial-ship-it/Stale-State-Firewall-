#!/usr/bin/env node
/**
 * WF-2 dependency-update workflow driver (sustained-dogfood milestone §9-10).
 *
 * Live, opt-in: `npm run dogfood:deps` (needs SSF_GITHUB_TOKEN; fails closed
 * without one — a missing credential is an environment condition, never a
 * silent pass and never a firewall failure). Uses ONLY the dedicated sandbox
 * repository. Not part of the default offline harness suite (test economy —
 * scenario 13 already covers the mechanism; this exercises the
 * dependency-update WORKFLOW CLASS for the internal workflow record).
 *
 * The workflow: an agent ships a dependency bump to the sandbox repo through
 * the PUBLIC SSF API while the world interferes the way real repositories do:
 *
 *   A. normal execution     package.json bump authorized+CAS-executed, then
 *                           the lockfile follow-up authorized+executed
 *   B. stale dependency     a dependabot-style actor moves the lockfile
 *                           BEFORE the agent's next authorization → the
 *                           declared dependency is re-read → DENY
 *   C. recovery             re-observe → recompute under the new lockfile →
 *                           NEW authorization → consistent pair lands
 *   D. CAS-window boundary  the lockfile drifts INSIDE the CAS window → the
 *                           package.json write executes from authorized
 *                           values (documented DF-F2 boundary: CAS on the
 *                           target does not cover read-only dependencies)
 *   E. auditability         an operator can reconstruct the incident from
 *                           audit records alone; no credential material in
 *                           any audit payload
 *   F. metrics              local counters reflect the run (nothing sent)
 *
 * Every consequential operation goes through the firewall. The only raw
 * GitHub calls are the second actor's interference, seeding, server-truth
 * verification, and cleanup — never the agent's mutation.
 */

import { StaleStateFirewall, MemoryStore, GitHubStateProvider } from 'stale-state-firewall';
import { STEP, SCENARIO_VERDICT, scenarioVerdict } from '../harness/verdicts.mjs';

const GH_REPO = 'desurfofficial-ship-it/ssf-dogfood-sandbox';
const RUN = Date.now().toString(36);
const PKG = `dogfood/deps-${RUN}/package.json`;
const LOCK = `dogfood/deps-${RUN}/package-lock.json`;
const PKG_REF = `github:file/${GH_REPO}@${PKG}`;
const LOCK_REF = `github:file/${GH_REPO}@${LOCK}`;
const TOKEN = process.env.SSF_GITHUB_TOKEN ?? '';

let cacheBustSeq = 0;
function ghApi(method, pathName, body) {
  const url = new URL(`https://api.github.com${pathName}`);
  if (method === 'GET') {
    // FL-7: GitHub's Contents API serves short-TTL URL-keyed caches; a unique
    // query param forces a cache miss so every harness read is served fresh.
    url.searchParams.set('cb', `${Date.now().toString(36)}${++cacheBustSeq}`);
  }
  return fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
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
  const json = await res.json().catch(() => {});
  return { status: res.status, sha: json?.content?.sha ?? null };
}

async function ghGetFile(pathName) {
  const res = await ghApi('GET', `/repos/${GH_REPO}/contents/${pathName}`);
  const json = await res.json().catch(() => ({}));
  return { sha: json?.sha ?? null, content: json?.content ? Buffer.from(json.content, 'base64').toString('utf8') : null };
}

async function ghDeleteFile(pathName) {
  const head = await ghApi('GET', `/repos/${GH_REPO}/contents/${pathName}`);
  const json = await head.json().catch(() => ({}));
  if (json?.sha) await ghApi('DELETE', `/repos/${GH_REPO}/contents/${pathName}`, { message: `deps cleanup ${RUN}`, sha: json.sha });
}

/** Bounded eventual-consistency readback — ONLY after the provider confirmed an outcome. */
async function readBackUntil(pathName, accept, { attempts = 6, delayMs = 900 } = {}) {
  let file = await ghGetFile(pathName);
  let reads = 1;
  while (!accept(file) && reads < attempts) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    file = await ghGetFile(pathName);
    reads += 1;
  }
  return { file, reads, ok: accept(file) };
}

const pkgContent = (deps) => JSON.stringify({ name: 'sandbox-service', version: '1.0.0', dependencies: deps }, null, 2) + '\n';
const lockContent = (deps) => JSON.stringify({ name: 'sandbox-service', lockfileVersion: 3, packages: { '': { dependencies: deps } } }, null, 2) + '\n';

function makeExecutor(provider, argsOf, targetRef, targetPath) {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      const entry = expectedState.find((e) => e.ref === targetRef);
      const res = await provider.conditionalExecute({
        ref: { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${targetPath}` },
        expected_version: entry.version,
        changes: { content: argsOf(intent), message: `dependency update ${RUN}` },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: targetRef, observed_version: res.current_version };
    },
  };
}

function makeFirewall(provider) {
  return StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'agent-dependency-update', match: { tool: 'github', operation: 'update_file' }, risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(), // one store per trust domain: this agent context is independent
    providers: [provider],
  });
}

const say = (line) => process.stdout.write(line + '\n');

async function main() {
  if (!TOKEN) {
    say('SKIP: SSF_GITHUB_TOKEN not set — the live dependency-update workflow needs explicit credentials (fail closed).');
    process.exit(0);
  }

  const steps = [];
  const push = (name, verdict, detail) => steps.push({ name, verdict, detail });
  const provider = new GitHubStateProvider({ token: TOKEN });
  const agent = await makeFirewall(provider);
  let actionSeq = 0;
  const nextActionId = () => `deps_${RUN}_${++actionSeq}`;

  try {
    // ---- Seed: the repo's before-state (dependency pair v1) ---------------
    await ghPutFile(PKG, pkgContent({ left_pad: '1.2.0' }), `deps seed pkg ${RUN}`);
    await ghPutFile(LOCK, lockContent({ left_pad: '1.2.0' }), `deps seed lock ${RUN}`);

    const observe = async () => ({
      pkg: await ghGetFile(PKG),
      lock: await ghGetFile(LOCK),
    });

    // The intent declares the CAS target AND the lockfile as dependencies.
    const intentOf = (pkgSha, lockSha, version) => ({
      agent_id: 'deps-agent',
      tool: 'github',
      operation: 'update_file',
      arguments: { path: PKG, version, lock_path: LOCK },
      dependencies: [
        { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${PKG}`, version: pkgSha },
        { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${LOCK}`, version: lockSha },
      ],
    });

    // ---- A. Normal execution: bump + lockfile follow-up -------------------
    let snap = await observe();
    const checkA = await agent.check(intentOf(snap.pkg.sha, snap.lock.sha, '1.3.0'));
    push(
      'A: dry-run the dependency bump (declared pkg+lock state, no side effects)',
      checkA.decision === 'ALLOW' ? STEP.EXPECTED_SUCCESS : STEP.UNEXPECTED_FAILURE,
      `decision=${checkA.decision}`,
    );

    const execPkg = makeExecutor(provider, () => pkgContent({ left_pad: '1.3.0' }), PKG_REF, PKG);
    const outA = await agent.execute(intentOf(snap.pkg.sha, snap.lock.sha, '1.3.0'), execPkg, { actionId: nextActionId() });
    const readA = await readBackUntil(PKG, (f) => (f.content ?? '').includes('"left_pad": "1.3.0"'));
    push(
      'A: package.json bump authorized + CAS-executed',
      outA.executed && outA.result?.conditional_execution === 'satisfied' && readA.ok
        ? STEP.EXPECTED_SUCCESS : STEP.UNEXPECTED_FAILURE,
      `conditional=${outA.result?.conditional_execution} reads=${readA.reads}`,
    );

    // The lockfile follow-up is its own authorized change (separate action id).
    snap = await observe();
    const execLock = makeExecutor(provider, () => lockContent({ left_pad: '1.3.0' }), LOCK_REF, LOCK);
    const outA2 = await agent.execute(
      {
        agent_id: 'deps-agent', tool: 'github', operation: 'update_file',
        arguments: { path: LOCK, version: '1.3.0' },
        dependencies: [
          { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${LOCK}`, version: snap.lock.sha },
        ],
      },
      execLock, { actionId: nextActionId() },
    );
    const readA2 = await readBackUntil(LOCK, (f) => (f.content ?? '').includes('"left_pad": "1.3.0"'));
    push(
      'A: lockfile follow-up authorized + CAS-executed (consistent pair)',
      outA2.executed && outA2.result?.conditional_execution === 'satisfied' && readA2.ok
        ? STEP.EXPECTED_SUCCESS : STEP.UNEXPECTED_FAILURE,
      `conditional=${outA2.result?.conditional_execution} reads=${readA2.reads}`,
    );

    // ---- B. Stale dependency: dependabot moves the lockfile first ---------
    snap = await observe(); // the agent now HOLDS these shas...
    await ghPutFile(LOCK, lockContent({ left_pad: '1.3.0', right_pad: '2.0.1' }) + '// dependabot: right_pad added\n',
      `deps dependabot drift ${RUN}`, snap.lock.sha);
    const staleB = await agent.execute(intentOf(snap.pkg.sha, snap.lock.sha, '1.3.1'), execPkg, { actionId: nextActionId() });
    push(
      'B: lockfile moved by dependabot BEFORE authorization → the declared dependency is re-read → DENY',
      staleB.executed === false && staleB.decision.decision === 'DENY' ? STEP.EXPECTED_SECURITY_BLOCK : STEP.SECURITY_FAILURE,
      `decision=${staleB.decision.decision} reason=${staleB.decision.reason.slice(0, 90)}`,
    );

    // ---- C. Recovery: re-observe → recompute under the new lockfile -------
    snap = await observe();
    const recovered = await agent.execute(intentOf(snap.pkg.sha, snap.lock.sha, '1.3.1'),
      makeExecutor(provider, () => pkgContent({ left_pad: '1.3.1', right_pad: '2.0.1' }), PKG_REF, PKG),
      { actionId: nextActionId() });
    const readC = await readBackUntil(PKG, (f) => (f.content ?? '').includes('"left_pad": "1.3.1"') && (f.content ?? '').includes('"right_pad": "2.0.1"'));
    push(
      'C: recovery WITHOUT developer help: re-observe → recompute (dependabot change preserved) → NEW authorization → execute',
      recovered.executed && recovered.result?.conditional_execution === 'satisfied' && readC.ok
        ? STEP.EXPECTED_SUCCESS : STEP.UNEXPECTED_FAILURE,
      `conditional=${recovered.result?.conditional_execution} dependabot_preserved=${(readC.file.content ?? '').includes('"right_pad": "2.0.1"')} reads=${readC.reads}`,
    );

    // ---- D. CAS-window boundary: lockfile drifts IN the CAS window --------
    snap = await observe();
    const windowDrift = makeExecutor(provider, () => pkgContent({ left_pad: '1.4.0', right_pad: '2.0.1' }), PKG_REF, PKG);
    const realCas = windowDrift.conditionalExecute.bind(windowDrift);
    windowDrift.conditionalExecute = async (i, es) => {
      await ghPutFile(LOCK, lockContent({ left_pad: '1.4.0', right_pad: '9.9.9' }) + '// drifted INSIDE the CAS window\n',
        `deps CAS-window drift ${RUN}`, (await ghGetFile(LOCK)).sha);
      return realCas(i, es);
    };
    const outD = await agent.execute(intentOf(snap.pkg.sha, snap.lock.sha, '1.4.0'), windowDrift, { actionId: nextActionId() });
    push(
      'D: lockfile drifts IN THE CAS WINDOW → target executes from authorized values (documented DF-F2 boundary: CAS on the target does not cover read-only dependencies; restructure the intent or drive both files through one review)',
      outD.executed === true && outD.result?.conditional_execution === 'satisfied' ? STEP.DOCUMENTED_BOUNDARY : STEP.UNEXPECTED_FAILURE,
      `executed=${outD.executed} conditional=${outD.result?.conditional_execution} atomicity=${outD.result?.atomicity}`,
    );

    // ---- E. Auditability + credential hygiene ------------------------------
    const tail = await agent.auditTail(300);
    const deniedRecord = tail.some((r) => r.event_type === 'action.blocked' && JSON.stringify(r.payload).includes(LOCK_REF));
    const executedRecord = tail.some((r) => r.event_type === 'action.executed' && JSON.stringify(r.payload).includes(PKG_REF));
    const leaked = tail.some((r) => JSON.stringify(r).includes(TOKEN) || JSON.stringify(r).includes('github_pat_') || JSON.stringify(r).includes('Bearer '));
    push(
      'E: an operator can reconstruct the run from audit records alone (denied target-ref + executed target-ref + no credential material)',
      deniedRecord && executedRecord && !leaked ? STEP.EXPECTED_SUCCESS : leaked ? STEP.SECURITY_FAILURE : STEP.UNEXPECTED_FAILURE,
      `denied_record=${deniedRecord} executed_record=${executedRecord} credential_leak=${leaked}`,
    );

    // ---- F. Metrics --------------------------------------------------------
    const m = agent.getMetrics().counters;
    push(
      'F: local counters reflect the workflow (nothing transmitted)',
      m.actions_allowed >= 4 && m.actions_denied >= 1 && m.conditional_executions_satisfied >= 4
        ? STEP.EXPECTED_SUCCESS : STEP.UNEXPECTED_FAILURE,
      `allowed=${m.actions_allowed} denied=${m.actions_denied} cond_ok=${m.conditional_executions_satisfied} cond_failed=${m.conditional_executions_failed} unknown=${m.executions_unknown_outcome} replays=${m.replays_detected}`,
    );
  } finally {
    try {
      await ghDeleteFile(PKG);
      await ghDeleteFile(LOCK);
    } catch {
      /* cleanup best-effort; sandbox-only resources */
    }
    await agent.close().catch(() => {});
  }

  const verdict = scenarioVerdict(steps);
  say('\n== dependency-update workflow (WF-2) ==');
  for (const s of steps) say(`  ${s.verdict.padEnd(22)} ${s.name}\n${' '.repeat(26)}${s.detail}`);
  say(`\n  == ${verdict} ==`);
  if (verdict !== SCENARIO_VERDICT.PASS) process.exit(1);
}

main().catch((err) => {
  say(`ERROR: ${err?.message ?? err}`);
  process.exit(1);
});
