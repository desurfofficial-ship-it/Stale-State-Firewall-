/**
 * Scenario 13 — FIRST INTERNAL WORKFLOW (continuous-dogfood milestone §11-19).
 * Live, opt-in (--with-github + SSF_GITHUB_TOKEN). Uses ONLY the dedicated
 * sandbox repository (desurfofficial-ship-it/ssf-dogfood-sandbox).
 *
 * The workflow: an agent ships a deployment-config change to the sandbox repo
 * through the PUBLIC SSF API (check → execute → provider CAS → audit), while
 * the world interferes the way real development does:
 *
 *   A. legitimate change      observe → dry-run → authorize → CAS execute
 *   B. interference           a second actor hotfixes the file mid-flight
 *   C. stale refusal          the agent's stale claim is DENIED at validation
 *   D. autonomous recovery    the agent reads the recovery contract, re-observes,
 *                             recomputes (preserving the hotfix), re-authorizes
 *   E. CAS-window refusal     GitHub itself refuses a stale write (condition_failed)
 *   F. multi-dependency       A = written target, B = read-only dependency:
 *                             B drift BEFORE authorization → DENY (declared deps re-read);
 *                             B drift IN THE CAS WINDOW → executes (DF-F2 documented boundary)
 *   G. concurrent agents      two independent firewalls race; GitHub decides the winner
 *   H. audit reconstruction   an operator can answer "why allowed / why blocked"
 *                             from the audit trail alone
 *
 * Every consequential operation goes through the firewall (§23): the ONLY raw
 * GitHub calls are the second actor's interference, server-truth verification,
 * seeding, and cleanup — never the agent's mutation.
 */

import { StaleStateFirewall, MemoryStore, GitHubStateProvider } from 'stale-state-firewall';

const GH_REPO = 'desurfofficial-ship-it/ssf-dogfood-sandbox';
const RUN = Date.now().toString(36);
const TARGET = `dogfood/adoption-${RUN}/deploy.yaml`;
const DEP = `dogfood/adoption-${RUN}/app-settings.yaml`;
const TOKEN = process.env.SSF_GITHUB_TOKEN ?? '';
const TARGET_REF = `github:file/${GH_REPO}@${TARGET}`;

let cacheBustSeq = 0;
function ghApi(method, pathName, body) {
  const url = new URL(`https://api.github.com${pathName}`);
  if (method === 'GET') {
    // GitHub's Contents API answers from short-TTL caches keyed by URL: a
    // successful write followed immediately by a bare GET can read a stale
    // copy (observed for real on Actions runners — CI run 34020575403,
    // friction log FL-7; local runs never hit it). A unique query parameter
    // forces a cache miss so every harness read is served fresh.
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

/**
 * Server-truth readback with a bounded eventual-consistency window.
 * Used ONLY after the provider has already confirmed the outcome of a
 * mutation (satisfied or refused) — never to retry a mutation and never to
 * decide one. If the first fresh read does not yet match the confirmed
 * truth, it re-reads briefly; a persistent mismatch still fails the step.
 */
async function readBackUntil(accept, { attempts = 6, delayMs = 900 } = {}) {
  let file = await ghGetFile(TARGET);
  let reads = 1;
  while (!accept(file) && reads < attempts) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    file = await ghGetFile(TARGET);
    reads += 1;
  }
  return { file, reads, ok: accept(file) };
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

/** Honest conditional executor: the write carries the authorized blob sha to GitHub. */
function makeExecutor(provider, argsOf) {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      const entry = expectedState.find((e) => e.ref === TARGET_REF);
      const res = await provider.conditionalExecute({
        ref: { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${TARGET}` },
        expected_version: entry.version,
        changes: { content: argsOf(intent), message: `adoption workflow edit ${RUN}` },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: TARGET_REF, observed_version: res.current_version };
    },
  };
}

function makeFirewall(provider) {
  return StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce' },
      actions: [{
        name: 'agent-deploy-config-change', match: { tool: 'github', operation: 'update_file' }, risk: 'HIGH',
        freshness: { strategy: 'version' },
        execution: { require_conditional_execution: true },
      }],
    },
    store: new MemoryStore(), // one store per trust domain: each agent context is independent
    providers: [provider],
  });
}

export default {
  id: 'adoption-agent-workflow',
  title: 'FIRST INTERNAL WORKFLOW: agent config change end to end — interference, stale refusal, autonomous recovery, multi-dependency, concurrent agents (sandbox repo)',
  kind: 'live-github',
  async run() {
    if (!TOKEN) {
      return { steps: [], skipped: 'SSF_GITHUB_TOKEN not set (live adoption workflow needs explicit credentials)' };
    }
    const steps = [];
    const provider = new GitHubStateProvider({ token: TOKEN });
    const agent = await makeFirewall(provider);      // the adopting agent's context
    let agentB = null;                                // the racing second agent (closed in finally)

    const contentOf = (replicas, extra) =>
      `env: sandbox\nservice: api\nreplicas: ${replicas}\n${extra ?? ''}`;

    try {
      // ---- Seed: the workflow's before-state ------------------------------
      const seeded = await ghPutFile(TARGET, contentOf(1), `adoption seed ${RUN}`);
      await ghPutFile(DEP, 'feature_flags: v1\nlog_level: info\n', `adoption seed dep ${RUN}`);
      const before = await ghGetFile(TARGET);
      const observedSha = seeded.sha || before.sha;

      // The intent the agent formulates from its observation (§12: declare
      // action, target, arguments, dependencies, expected state).
      const intentOf = (sha) => ({
        agent_id: 'adoption-agent',
        tool: 'github',
        operation: 'update_file',
        arguments: { path: TARGET, replicas: 3 },
        dependencies: [{ source: 'github', resource: 'file', resource_id: `${GH_REPO}@${TARGET}`, version: sha }],
      });
      const executor = makeExecutor(provider, (intent) => contentOf(intent.arguments['replicas']));
      let actionSeq = 0;
      const nextActionId = () => `adoption_${RUN}_${++actionSeq}`;

      // ---- A. Legitimate change (before → during → after) -----------------
      const dryRun = await agent.check(intentOf(observedSha));
      steps.push({
        name: 'A: agent dry-runs the change before touching anything (declared state, no side effects)',
        verdict: dryRun.decision === 'ALLOW' ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `decision=${dryRun.decision}`,
      });

      const outcome = await agent.execute(intentOf(observedSha), executor, { actionId: nextActionId() });
      const satisfiedA = outcome.executed && outcome.result?.conditional_execution === 'satisfied';
      const readA = await readBackUntil((f) => f.content?.includes('replicas: 3'));
      steps.push({
        name: 'A: authorize + provider-CAS execute: the change lands exactly as authorized (during/after)',
        verdict: satisfiedA && readA.ok
          ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `conditional=${outcome.result?.conditional_execution} server_truth_replicas=${/replicas: (\d+)/.exec(readA.file.content ?? '')?.[1]} reads=${readA.reads}`,
      });

      // ---- Metrics (§20) ---------------------------------------------------
      const m = agent.getMetrics().counters;
      steps.push({
        name: 'metrics: local counters reflect the workflow so far (nothing transmitted)',
        verdict: m.actions_allowed >= 1 && m.conditional_executions_satisfied >= 1 ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `allowed=${m.actions_allowed} denied=${m.actions_denied} cond_ok=${m.conditional_executions_satisfied} cond_failed=${m.conditional_executions_failed} unknown=${m.executions_unknown_outcome} replays=${m.replays_detected}`,
      });

      // ---- B. Interference: a second actor hotfixes the file ---------------
      await ghPutFile(TARGET, contentOf(9, '# hotfix by human: bumped replicas under load\n'),
        `adoption hotfix ${RUN}`, (await ghGetFile(TARGET)).sha);

      // ---- C. Stale refusal (§13): the agent still holds its OLD sha -------
      const stale = await agent.execute(intentOf(observedSha), executor, { actionId: nextActionId() });
      steps.push({
        name: 'C: interference happened; the agent\'s stale claim is DENIED at validation (declared dependency re-read)',
        verdict: stale.executed === false && stale.decision.decision === 'DENY' ? 'EXPECTED_SECURITY_BLOCK' : 'SECURITY_FAILURE',
        detail: `decision=${stale.decision.decision} reason=${stale.decision.reason.slice(0, 100)}`,
      });

      // ---- D. Autonomous recovery (§15): NO developer intervention ---------
      // The agent reads the decision (why blocked), re-observes, recomputes
      // PRESERVING the human's hotfix, and re-authorizes as a NEW action.
      const fresh = await ghGetFile(TARGET);
      const recovered = await agent.execute(
        intentOf(fresh.sha),
        makeExecutor(provider, () => contentOf(3, '# hotfix by human: bumped replicas under load\n')),
        { actionId: nextActionId() },
      );
      const afterRecovery = await readBackUntil(
        (f) => f.content?.includes('replicas: 3') && f.content?.includes('hotfix by human'),
      );
      steps.push({
        name: 'D: recovery WITHOUT developer help: re-observe → recompute (hotfix preserved) → NEW authorization → execute',
        verdict: recovered.executed && recovered.result?.conditional_execution === 'satisfied' && afterRecovery.ok
          ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `conditional=${recovered.result?.conditional_execution} hotfix_preserved=${afterRecovery.file.content?.includes('hotfix by human')} reads=${afterRecovery.reads}`,
      });

      // ---- E. CAS-window refusal + recovery contract (§17) ------------------
      const currentSha = (await ghGetFile(TARGET)).sha;
      const racing = makeExecutor(provider, (intent) => contentOf(intent.arguments['replicas']));
      const realCas = racing.conditionalExecute.bind(racing);
      racing.conditionalExecute = async (i, es) => {
        // a concurrent actor lands a commit in the CAS window
        await ghPutFile(TARGET, contentOf(9, '# concurrent actor\n'), `adoption CAS-window actor ${RUN}`, (await ghGetFile(TARGET)).sha);
        return realCas(i, es);
      };
      const windowed = await agent.execute(intentOf(currentSha), racing, { actionId: nextActionId() });
      const readE = await readBackUntil(
        (f) => (f.content ?? '').includes('# concurrent actor') && (f.content ?? '').includes('replicas: 9'),
      );
      const truthAfterRefusal = readE.file.content ?? '';
      // The concurrent actor's marker must still be there (last write won); the
      // refused stale write (replicas: 3, no marker) must NOT have replaced it.
      const noStaleLanding = truthAfterRefusal.includes('# concurrent actor') && truthAfterRefusal.includes('replicas: 9');
      steps.push({
        name: 'E: CAS-window race: GitHub itself refuses the stale write; no side effect; recovery contract is machine-readable',
        verdict: windowed.executed === false && windowed.result?.conditional_execution === 'failed'
          && windowed.result?.recovery?.retry_safety === 'SAFE_ONLY_AFTER_FRESH_EVALUATION'
          && windowed.result?.recovery?.side_effect_possible === false
          ? 'EXPECTED_SECURITY_BLOCK' : 'SECURITY_FAILURE',
        detail: `conditional=${windowed.result?.conditional_execution} retry_safety=${windowed.result?.recovery?.retry_safety} no_stale_landing=${noStaleLanding} reads=${readE.reads}`,
      });

      // recovery from the condition failure: fresh observation → new action
      const recovered2 = await agent.execute(intentOf((await ghGetFile(TARGET)).sha), executor, { actionId: nextActionId() });
      steps.push({
        name: 'E: recovery after condition_failed: new authorization executes under the current sha',
        verdict: recovered2.executed && recovered2.result?.conditional_execution === 'satisfied' ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `conditional=${recovered2.result?.conditional_execution}`,
      });

      // ---- F. Multi-dependency (§18) ----------------------------------------
      // A = TARGET (written, CAS-protected), B = DEP (read-only dependency).
      const depSha1 = (await ghGetFile(DEP)).sha;
      const targetShaNow = (await ghGetFile(TARGET)).sha;
      const bothDeps = (tSha, dSha) => ({
        agent_id: 'adoption-agent', tool: 'github', operation: 'update_file',
        arguments: { path: TARGET, replicas: 5 },
        dependencies: [
          { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${TARGET}`, version: tSha },
          { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${DEP}`, version: dSha },
        ],
      });

      // F1: B drifts BEFORE authorization → the declared dependency is re-read → DENY.
      await ghPutFile(DEP, 'feature_flags: v2 # changed\nlog_level: info\n', `adoption dep drift ${RUN}`, depSha1);
      const depDrift = await agent.execute(bothDeps(targetShaNow, depSha1), executor, { actionId: nextActionId() });
      steps.push({
        name: 'F1: read-only dependency B drifts BEFORE authorization → DENY (declared deps are re-read)',
        verdict: depDrift.executed === false && depDrift.decision.decision === 'DENY' ? 'EXPECTED_SECURITY_BLOCK' : 'SECURITY_FAILURE',
        detail: `decision=${depDrift.decision.decision}`,
      });

      // F2: B drifts IN THE CAS WINDOW (after authorization) → the action executes.
      // This is the documented DF-F2 boundary: CAS on A does not protect B.
      const depSha2 = (await ghGetFile(DEP)).sha;
      const tSha2 = (await ghGetFile(TARGET)).sha;
      const casWindowDrift = makeExecutor(provider, (intent) => contentOf(intent.arguments['replicas']));
      const realCas2 = casWindowDrift.conditionalExecute.bind(casWindowDrift);
      casWindowDrift.conditionalExecute = async (i, es) => {
        await ghPutFile(DEP, 'feature_flags: v3 # drifted in CAS window\nlog_level: info\n', `adoption CAS-window dep drift ${RUN}`, (await ghGetFile(DEP)).sha);
        return realCas2(i, es);
      };
      const f2 = await agent.execute(bothDeps(tSha2, depSha2), casWindowDrift, { actionId: nextActionId() });
      steps.push({
        name: 'F2: B drifts IN THE CAS WINDOW → action executes from authorized values (documented DF-F2 boundary: CAS on A does not protect read-only B; restructure the intent if B drift matters)',
        verdict: f2.executed === true && f2.result?.conditional_execution === 'satisfied' ? 'DOCUMENTED_BOUNDARY' : 'UNEXPECTED_FAILURE',
        detail: `executed=${f2.executed} conditional=${f2.result?.conditional_execution} atomicity=${f2.result?.atomicity}`,
      });

      // ---- G. Concurrent agents (§19) ----------------------------------------
      // Two INDEPENDENT firewall contexts (separate stores), same observed
      // state, conflicting mutations. GitHub's CAS is the final authority.
      const providerB = new GitHubStateProvider({ token: TOKEN });
      agentB = await makeFirewall(providerB);
      const raceSha = (await ghGetFile(TARGET)).sha;
      const raceIntent = (winnerReplicas) => ({
        agent_id: winnerReplicas === 7 ? 'agent-a' : 'agent-b',
        tool: 'github', operation: 'update_file',
        arguments: { path: TARGET, replicas: winnerReplicas },
        dependencies: [{ source: 'github', resource: 'file', resource_id: `${GH_REPO}@${TARGET}`, version: raceSha }],
      });
      const execA = makeExecutor(provider, (i) => contentOf(i.arguments['replicas'], '# agent A\n'));
      const execB = makeExecutor(providerB, (i) => contentOf(i.arguments['replicas'], '# agent B\n'));
      const [resA, resB] = await Promise.all([
        agent.execute(raceIntent(7), execA, { actionId: nextActionId() }),
        agentB.execute(raceIntent(11), execB, { actionId: `adoption_b_${RUN}_1` }),
      ]);
      const satisfied = [resA, resB].filter((r) => r.executed && r.result?.conditional_execution === 'satisfied');
      const refused = [resA, resB].filter((r) => r.executed === false && r.result?.conditional_execution === 'failed');
      const readG = await readBackUntil(
        (f) => (f.content ?? '').includes('# agent A') || (f.content ?? '').includes('# agent B'),
      );
      const serverTruth = readG.file;
      const truth = serverTruth.content ?? '';
      const winnerMarker = truth.includes('# agent A') ? 'A' : truth.includes('# agent B') ? 'B' : null;
      const exactlyOne = satisfied.length === 1 && refused.length === 1
        && winnerMarker !== null
        && truth.includes(`replicas: ${winnerMarker === 'A' ? 7 : 11}`);
      steps.push({
        name: 'G: two independent agents race conflicting mutations → exactly one lands; GitHub (not local coordination) decides the winner',
        verdict: exactlyOne ? 'EXPECTED_SECURITY_BLOCK' : 'SECURITY_FAILURE',
        detail: `satisfied=${satisfied.length} refused=${refused.length} winner=agent-${winnerMarker} loser_observed=${(refused[0]?.result?.observed_version ?? 'n/a').slice(0, 12)}… reads=${readG.reads}`,
      });
      // recovery for the racing loser: fresh observation → new authorization
      const postRaceSha = (await ghGetFile(TARGET)).sha;
      const loserRecovery = await agent.execute(
        {
          agent_id: 'adoption-agent', tool: 'github', operation: 'update_file',
          arguments: { path: TARGET, replicas: 3 },
          dependencies: [{ source: 'github', resource: 'file', resource_id: `${GH_REPO}@${TARGET}`, version: postRaceSha }],
        },
        execA, { actionId: `adoption_${RUN}_recovery` },
      );
      steps.push({
        name: 'G: the racing loser recovers: fresh observation → new authorization → executes',
        verdict: loserRecovery.executed && loserRecovery.result?.conditional_execution === 'satisfied' ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `conditional=${loserRecovery.result?.conditional_execution}`,
      });

      // ---- H. Audit reconstruction (§24) --------------------------------------
      const tail = await agent.auditTail(300);
      const hasExecuted = tail.some((r) => r.event_type === 'action.executed'
        && r.payload?.['expected_state'] !== undefined && JSON.stringify(r.payload).includes(TARGET_REF));
      const condFailed = tail.find((r) => r.event_type === 'execution.condition_failed');
      const blocked = tail.find((r) => r.event_type === 'action.blocked');
      const reconstructable = hasExecuted && Boolean(condFailed) && Boolean(blocked)
        && condFailed?.payload?.['failed_ref'] === TARGET_REF
        && condFailed?.payload?.['retry_safety'] === 'SAFE_ONLY_AFTER_FRESH_EVALUATION'
        && condFailed?.payload?.['expected_state'] !== undefined
        && condFailed?.payload?.['observed_version'] !== undefined;
      steps.push({
        name: 'H: an operator can reconstruct the incident from audit records alone (action/target/authorized vs observed state/decision/condition/retry safety)',
        verdict: reconstructable ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `executed_records=${hasExecuted} condition_failed_record=${Boolean(condFailed)} blocked_record=${Boolean(blocked)} failed_ref=${condFailed?.payload?.['failed_ref'] ?? 'n/a'}`,
      });

      // ---- Credential hygiene (§26) --------------------------------------------
      const leaked = tail.some((r) => JSON.stringify(r).includes(TOKEN));
      steps.push({
        name: 'credentials never appear in audit records',
        verdict: leaked ? 'SECURITY_FAILURE' : 'EXPECTED_SUCCESS',
      });
    } finally {
      // Cleanup: remove the seeded files (keeps the sandbox tidy).
      try {
        for (const p of [TARGET, DEP]) {
          const head = await ghApi('GET', `/repos/${GH_REPO}/contents/${p}`);
          const json = await head.json().catch(() => ({}));
          if (json?.sha) await ghApi('DELETE', `/repos/${GH_REPO}/contents/${p}`, { message: `adoption cleanup ${RUN}`, sha: json.sha });
        }
      } catch {
        /* cleanup best-effort; sandbox-only resources */
      }
      if (agentB) await agentB.close().catch(() => {});
      await agent.close();
    }

    return { steps };
  },
};
