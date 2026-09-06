/**
 * Scenario: LIVE GitHub conditional mutation (opt-in: --with-github, needs
 * SSF_GITHUB_TOKEN). Uses ONLY the dedicated sandbox repository
 * (desurfofficial-ship-it/ssf-dogfood-sandbox) — never production resources.
 *
 * Flow: seed a file via the Contents API -> read its blob sha -> authorize a
 * config edit -> execute conditioned on the authorized sha (GitHub-enforced
 * CAS) -> verify server truth -> stale attempt refused -> cleanup.
 */

import { StaleStateFirewall, MemoryStore, GitHubStateProvider } from 'stale-state-firewall';

const GH_REPO = 'desurfofficial-ship-it/ssf-dogfood-sandbox';
const RUN = Date.now().toString(36);
const BASE = `dogfood/harness-${RUN}`;
const TOKEN = process.env.SSF_GITHUB_TOKEN ?? '';

let cacheBustSeq = 0;
function ghApi(method, pathName, body) {
  const url = new URL(`https://api.github.com${pathName}`);
  if (method === 'GET') {
    // Cache buster: GitHub's Contents API serves short-TTL URL-keyed copies;
    // a bare GET after a write can read stale content on some network paths
    // (observed on Actions runners — friction log FL-7). Unique query forces
    // a cache miss so seeding/cleanup reads are always fresh.
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
  const json = await res.json().catch(() => ({}));
  return { status: res.status, sha: json?.content?.sha ?? null };
}

export default {
  id: 'github-conditional-mutation',
  title: 'Live GitHub Contents API: blob-sha CAS satisfied + stale claim refused (sandbox repo only)',
  kind: 'live-github',
  async run() {
    if (!TOKEN) {
      return { steps: [], skipped: 'SSF_GITHUB_TOKEN not set (offline run — deterministic scenarios already cover the CAS semantics)' };
    }
    const steps = [];
    const provider = new GitHubStateProvider({ token: TOKEN });
    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce' },
        actions: [{
          name: 'update-github-file', match: { tool: 'github', operation: 'update_file' }, risk: 'HIGH',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: true },
        }],
      },
      store: new MemoryStore(),
      providers: [provider],
    });

    const path = `${BASE}/config.yaml`;
    const seeded = await ghPutFile(path, 'env: sandbox\nreplicas: 1\n', `harness seed ${RUN}`);
    const initialSha = seeded.sha;

    const executor = {
      idempotency: 'non_idempotent',
      atomicity: 'guaranteed',
      execute: async () => ({ success: true }),
      conditionalExecutionSupported: () => true,
      conditionalExecute: async (intent, expectedState) => {
        const entry = expectedState.find((e) => e.ref === `github:file/${GH_REPO}@${path}`);
        const res = await provider.conditionalExecute({
          ref: { source: 'github', resource: 'file', resource_id: `${GH_REPO}@${path}` },
          expected_version: entry.version,
          changes: { content: `env: sandbox\nreplicas: ${intent.arguments['replicas']}\n`, message: `harness CAS edit ${RUN}` },
        });
        return res.outcome === 'executed'
          ? { condition: 'satisfied', success: true, output: res.version }
          : { condition: 'failed', ref: `github:file/${GH_REPO}@${path}`, observed_version: res.current_version };
      },
    };

    const intent = (version) => ({
      agent_id: 'harness-agent',
      tool: 'github',
      operation: 'update_file',
      arguments: { path, replicas: 3 },
      dependencies: [{ source: 'github', resource: 'file', resource_id: `${GH_REPO}@${path}`, version }],
    });

    try {
      // Satisfied: the authorized blob sha still holds at GitHub.
      const ok = await firewall.execute(intent(initialSha), executor, { actionId: `act_gh_ok_${RUN}` });
      steps.push({
        name: 'live GitHub CAS: authorized blob sha still current -> mutation applied',
        verdict: ok.executed && ok.result?.conditional_execution === 'satisfied' ? 'EXPECTED_SUCCESS' : 'UNEXPECTED_FAILURE',
        detail: `conditional=${ok.result?.conditional_execution} latency=${ok.result?.duration_ms}ms`,
      });

      // Stale in the CAS window: authorize against the CURRENT sha, then a
      // concurrent actor lands a raw update before the CAS reaches GitHub.
      // (Declaring the OLD sha outright is caught earlier — at validation.)
      const current = await ghApi('GET', `/repos/${GH_REPO}/contents/${path}`);
      const currentSha = (await current.json())?.sha;
      const racing = executor;
      const realCas = racing.conditionalExecute.bind(racing);
      racing.conditionalExecute = async (i, es) => {
        await ghPutFile(path, 'env: sandbox\nreplicas: 9 # concurrent actor\n', `harness concurrent actor ${RUN}`, currentSha);
        return realCas(i, es);
      };
      const stale = await firewall.execute(intent(currentSha), racing, { actionId: `act_gh_stale_${RUN}` });
      steps.push({
        name: 'live GitHub CAS: blob sha moved in the CAS window -> GitHub refuses the stale write',
        verdict: stale.executed === false && stale.result?.conditional_execution === 'failed' ? 'EXPECTED_SECURITY_BLOCK' : 'SECURITY_FAILURE',
        detail: `executed=${stale.executed} conditional=${stale.result?.conditional_execution} observed=${stale.result?.observed_version}`,
      });

      // Credential hygiene: the token must not appear in the audit trail.
      const tail = await firewall.auditTail(100);
      const leaked = tail.some((r) => JSON.stringify(r).includes(TOKEN));
      steps.push({
        name: 'no credentials in audit records',
        verdict: leaked ? 'SECURITY_FAILURE' : 'EXPECTED_SUCCESS',
      });
    } finally {
      // Cleanup: remove the seeded file (keeps the sandbox tidy).
      try {
        const head = await ghApi('GET', `/repos/${GH_REPO}/contents/${path}`);
        const json = await head.json().catch(() => ({}));
        if (json?.sha) await ghApi('DELETE', `/repos/${GH_REPO}/contents/${path}`, { message: `harness cleanup ${RUN}`, sha: json.sha });
      } catch {
        /* cleanup best-effort; sandbox-only resources */
      }
      await firewall.close();
    }

    return { steps };
  },
};
