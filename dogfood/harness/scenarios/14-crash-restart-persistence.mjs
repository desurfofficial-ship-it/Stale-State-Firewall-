/**
 * Scenario 14 — CRASH/RESTART PERSISTENCE (continuous-dogfood §14).
 * Offline, deterministic. Exercises interruption at meaningful boundaries
 * of execute() against a REAL SQLite store, then verifies the restart.
 *
 * execute() internals: replay guards → validation → SQLite atomic claim →
 * executor → audit. A child process runs the flow and is SIGKILLed at the
 * requested boundary; the parent reopens the SAME database (real crash
 * recovery, WAL/journal included) and checks what survived:
 *
 *   mode = before-exec      claim persisted, provider NEVER called
 *                           → no side effect, replay refused across restart
 *   mode = after-provider   provider applied the mutation, firewall never
 *                           saw the response, audit never completed
 *                           → no false success, no false failure, replay
 *                             refused, external truth unknowable locally
 *                             (reconciliation is the recovery — by design)
 *   mode = completed        normal completion; the consumed authorization
 *                           stays dead across restart (no double execution)
 *
 * Public API only: the child imports the package entry, the parent uses
 * firewall/audit/metrics surfaces. No internal helpers, no db surgery.
 */

import {
  StaleStateFirewall,
  InMemoryStateProvider,
  ReplayDetectedError,
} from 'stale-state-firewall';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const STATE_DIR = join(HERE, '..', '..', 'reports', 'state');
const CHILD_PATH = join(STATE_DIR, 'crash-child.mjs');
const PKG = 'stale-state-firewall';

const POLICY = [{
  name: 'update-deploy-config',
  match: { tool: 'ops', operation: 'update_deploy_config' },
  risk: 'HIGH',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

function childSource() {
  // The child runs as its own process (so it can be killed) and reaches SSF
  // through the same public entry the scenarios use.
  return `
import { StaleStateFirewall, InMemoryStateProvider } from '${PKG}';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dbPath = process.env.SSF_CRASH_DB;
const sentinelDir = process.env.SSF_CRASH_DIR;
const mode = process.env.SSF_CRASH_MODE;
const actionId = process.env.SSF_CRASH_ACTION;

const provider = new InMemoryStateProvider('memory');
provider.put('file', 'crash/probe.yaml', { content: 'service: api\\nreplicas: 2\\n' }, new Date().toISOString());
const version = provider.get('file', 'crash/probe.yaml').version;
const REF = 'memory:file/crash/probe.yaml';

const executor = {
  idempotency: 'non_idempotent',
  atomicity: 'guaranteed',
  async execute() { return { success: true }; },
  conditionalExecutionSupported: () => true,
  async conditionalExecute(_intent, expectedState) {
    writeFileSync(join(sentinelDir, 'executor_entered'), mode);
    if (mode === 'after-provider' || mode === 'completed') {
      const entry = expectedState.find((e) => e.ref === REF);
      await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'file', resource_id: 'crash/probe.yaml' },
        expected_version: entry.version,
        changes: { content: 'service: api\\nreplicas: 3\\n' },
      });
      writeFileSync(join(sentinelDir, 'provider_mutated'), '1');
    }
    if (mode === 'completed') return { condition: 'satisfied', success: true };
    // Simulate the process dying before the firewall can observe the
    // executor result and finish its audit records. A bare pending promise
    // does NOT keep the event loop alive (Node exits with "unsettled
    // top-level await" once the loop drains), so hold the loop open with a
    // long-interval timer until the parent's SIGKILL arrives.
    const holdLoop = setInterval(() => {}, 1 << 30); // ref'd: keeps the loop (and the process) alive
    void holdLoop;
    await new Promise(() => {});
  },
};

const firewall = await StaleStateFirewall.create({
  config: { firewall: { mode: 'enforce', storage: { type: 'sqlite', path: dbPath } }, actions: ${JSON.stringify(POLICY)} },
  providers: [provider],
});

const intent = {
  agent_id: 'crash-agent',
  tool: 'ops',
  operation: 'update_deploy_config',
  arguments: { replicas: 3 },
  dependencies: [{ source: 'memory', resource: 'file', resource_id: 'crash/probe.yaml', version }],
};

try {
  const outcome = await firewall.execute(intent, executor, { actionId });
  writeFileSync(join(sentinelDir, 'child_done'), JSON.stringify({ executed: outcome.executed }));
  await firewall.close?.();
  process.exit(0);
} catch (err) {
  writeFileSync(join(sentinelDir, 'child_error'), String(err && err.message ? err.message : err));
  await firewall.close?.();
  process.exit(1);
}
`;
}

async function runChild(mode, dbPath, sentinelDir, actionId) {
  for (const f of ['executor_entered', 'provider_mutated', 'child_done', 'child_error']) {
    try { rmSync(join(sentinelDir, f)); } catch { /* absent */ }
  }
  const child = spawn(process.execPath, [CHILD_PATH], {
    env: {
      ...process.env,
      SSF_CRASH_DB: dbPath,
      SSF_CRASH_DIR: sentinelDir,
      SSF_CRASH_MODE: mode,
      SSF_CRASH_ACTION: actionId,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString(); });
  // Register the exit listener BEFORE anything can kill or lose the child.
  const exited = new Promise((resolve) => {
    child.on('exit', (c) => resolve(c));
  });

  if (mode !== 'completed') {
    // Wait until the executor is inside the crash window, then SIGKILL.
    const entered = join(sentinelDir, 'executor_entered');
    const deadline = Date.now() + 20000;
    while (!existsSync(entered)) {
      if (Date.now() > deadline || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`child never reached the crash window; stderr: ${stderr.slice(0, 300)}`);
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  const code = await Promise.race([
    exited,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`child did not exit (kill delivered=${child.signalCode ?? 'no'}) ; stderr: ${stderr.slice(0, 300)}`)), 20000);
    }),
  ]);
  return {
    code,
    executorEntered: existsSync(join(sentinelDir, 'executor_entered')),
    providerMutated: existsSync(join(sentinelDir, 'provider_mutated')),
    childDone: existsSync(join(sentinelDir, 'child_done')),
    childError: existsSync(join(sentinelDir, 'child_error')) ? 'present' : 'absent',
  };
}

function intentOf(version) {
  return {
    agent_id: 'crash-agent',
    tool: 'ops',
    operation: 'update_deploy_config',
    arguments: { replicas: 3 },
    dependencies: [{ source: 'memory', resource: 'file', resource_id: 'crash/probe.yaml', version }],
  };
}

const goodExecutor = {
  idempotency: 'non_idempotent',
  atomicity: 'guaranteed',
  async execute() { return { success: true }; },
  conditionalExecutionSupported: () => true,
  async conditionalExecute() { return { condition: 'satisfied', success: true }; },
};

async function replayIsRefused(dbPath, actionId) {
  // Restart: a NEW firewall on the SAME database (real crash recovery path —
  // the killed child left SQLite to recover its own journal/WAL).
  const restarted = await StaleStateFirewall.create({
    config: { firewall: { mode: 'enforce', storage: { type: 'sqlite', path: dbPath } }, actions: POLICY },
    providers: [new InMemoryStateProvider('memory')],
  });
  let refused = false;
  let errorName = '';
  let auditEvents = [];
  try {
    await restarted.execute(intentOf('v-arbitrary'), goodExecutor, { actionId });
  } catch (err) {
    refused = err instanceof ReplayDetectedError || /replay/i.test(String(err?.message ?? err));
    errorName = err?.name ?? err?.constructor?.name ?? 'unknown';
  }
  const tail = await restarted.auditTail(300);
  auditEvents = tail
    .filter((r) => r.payload?.['action_id'] === actionId)
    .map((r) => r.event_type);
  await restarted.close?.();
  return { refused, errorName, auditEvents };
}

export default {
  id: 'crash-restart-persistence',
  title: 'Crash/restart: interruption at claim, after provider response, and after completion — SQLite persistence keeps the guarantees',
  kind: 'deterministic',
  async run() {
    writeFileSync(CHILD_PATH, childSource());
    const run = Date.now().toString(36);
    const workRoot = join(STATE_DIR, `crash-${run}`);
    mkdirSync(workRoot, { recursive: true });
    const steps = [];

    try {
      // ---- Crash 1: interruption AFTER the claim, BEFORE provider call ----
      const db1 = join(workRoot, 'crash-before-exec.db');
      const a1 = await runChild('before-exec', db1, workRoot, `crash_${run}_1`);
      const noSideEffect = !a1.providerMutated && a1.executorEntered;
      const r1 = await replayIsRefused(db1, `crash_${run}_1`);
      const noExecutionRecorded = !r1.auditEvents.includes('action.executed');
      steps.push(expectSuccess(
        noSideEffect && r1.refused && noExecutionRecorded,
        'crash after authorization, before execution: NO side effect; replay refused across restart; audit records no execution',
        `executor_entered=${a1.executorEntered} provider_mutated=${a1.providerMutated} replay_refused=${r1.refused} (${r1.errorName}) audit=${r1.auditEvents.join(',') || '∅'}`,
      ));

      // ---- Crash 2: provider applied the mutation, firewall never saw it --
      const db2 = join(workRoot, 'crash-after-provider.db');
      const a2 = await runChild('after-provider', db2, workRoot, `crash_${run}_2`);
      const applied = a2.executorEntered && a2.providerMutated;
      const r2 = await replayIsRefused(db2, `crash_${run}_2`);
      const honestAbsence = !r2.auditEvents.includes('action.executed');
      steps.push(expectSuccess(
        applied && r2.refused && honestAbsence,
        'crash after the provider applied the mutation but before the firewall observed it: no false success, no false failure, replay refused — the local record is honestly silent and reconciliation is the recovery',
        `provider_mutated=${a2.providerMutated} replay_refused=${r2.refused} (${r2.errorName}) audit=${r2.auditEvents.join(',') || '∅'}`,
      ));

      // ---- Control: normal completion; consumed authorization stays dead --
      const db3 = join(workRoot, 'completed.db');
      const a3 = await runChild('completed', db3, workRoot, `crash_${run}_3`);
      const completed = a3.childDone && a3.providerMutated;
      const r3 = await replayIsRefused(db3, `crash_${run}_3`);
      steps.push(expectBlock(
        completed && r3.refused,
        'restart control: a COMPLETED authorization stays consumed across restart — the same action id cannot run twice (no double execution)',
        `child_done=${a3.childDone} replay_refused=${r3.refused} (${r3.errorName}) audit=${r3.auditEvents.join(',') || '∅'}`,
      ));
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }

    return { steps };
  },
};
