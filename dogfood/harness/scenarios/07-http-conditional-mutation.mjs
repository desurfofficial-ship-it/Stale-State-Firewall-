/**
 * Scenario: real HTTP conditional mutation against a controlled local server
 * (dogfood/scripts/sandbox-http-server.mjs, /correct endpoint).
 * If-Match matching applies; stale If-Match gets a 412 and NO mutation.
 */

import { StaleStateFirewall, MemoryStore, HttpStateProvider } from 'stale-state-firewall';
import { expectBlock, expectSuccess } from '../verdicts.mjs';

function executorFor(provider, resource, id, contentOf) {
  const REF = `http:${resource}/${id}`;
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async (intent, expectedState) => {
      const entry = expectedState.find((e) => e.ref === REF);
      if (!entry?.version) return { condition: 'unavailable', error: `no authorized expected state for ${REF}` };
      const res = await provider.conditionalExecute({
        ref: { source: 'http', resource, resource_id: id },
        expected_version: entry.version,
        changes: { content: contentOf(intent) },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: REF, observed_version: res.current_version, error: `server refused (If-Match): authorized ${entry.version}, reports ${res.current_version}` };
    },
  };
}

export default {
  id: 'http-conditional-mutation',
  title: 'HTTP If-Match CAS end to end: matching state applies, stale state gets 412 with no mutation',
  kind: 'deterministic',
  async run({ sandboxPort }) {
    const steps = [];
    const base = `http://127.0.0.1:${sandboxPort}`;
    const provider = new HttpStateProvider({
      correct: {
        url: `${base}/correct/deploy-config`,
        version: { source: 'header', name: 'etag' },
        mutation: { method: 'PUT', condition_failed_status: [412, 409] },
      },
    });
    const firewall = await StaleStateFirewall.create({
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

    const snap = await provider.getState(
      { source: 'http', resource: 'correct', resource_id: 'deploy-config', version: null, metadata: {} },
      new Date().toISOString(),
    );

    // Case A: matching state -> mutation applies.
    const ok = await firewall.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { content: 'replicas: 3 # by agent' },
      dependencies: [{ source: 'http', resource: 'correct', resource_id: 'deploy-config', version: snap.version }],
    }, executorFor(provider, 'correct', 'deploy-config', (i) => i.arguments['content']), { actionId: `act_http_a_${Date.now()}` });
    steps.push(expectSuccess(
      ok.executed && ok.result?.conditional_execution === 'satisfied',
      'correct server, If-Match matches: mutation applied under provider-enforced CAS',
    ));

    // Case B: the agent re-observes (so validation passes against CURRENT
    // state), but a concurrent actor lands a mutation in the CAS window —
    // between authorization and the conditional mutation. The server's
    // If-Match check must refuse with 412 -> condition failure, no overwrite.
    const currentSnap = await provider.getState(
      { source: 'http', resource: 'correct', resource_id: 'deploy-config', version: null, metadata: {} },
      new Date().toISOString(),
    );
    const casWindowExecutor = executorFor(provider, 'correct', 'deploy-config', (i) => i.arguments['content']);
    const realCas = casWindowExecutor.conditionalExecute.bind(casWindowExecutor);
    casWindowExecutor.conditionalExecute = async (intent, expectedState) => {
      // "Another actor" performs an honest conditional PUT with the CURRENT
      // etag — outside the firewall, as any other client would.
      const other = await fetch(`${base}/correct/deploy-config`, { headers: { accept: 'application/json' } });
      const otherEtag = other.headers.get('etag');
      await fetch(`${base}/correct/deploy-config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': otherEtag },
        body: JSON.stringify({ content: 'replicas: 9 # concurrent actor' }),
      });
      return realCas(intent, expectedState);
    };
    const stale = await firewall.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { content: 'replicas: 3 # by agent' },
      dependencies: [{ source: 'http', resource: 'correct', resource_id: 'deploy-config', version: currentSnap.version }],
    }, casWindowExecutor, { actionId: `act_http_b_${Date.now()}` });
    steps.push(expectBlock(
      stale.executed === false && stale.result?.conditional_execution === 'failed',
      'concurrent mutation in the CAS window: 412 refused as condition failure, no stale overwrite',
      `executed=${stale.executed} conditional=${stale.result?.conditional_execution} observed=${stale.result?.observed_version}`,
    ));

    steps.push(expectSuccess(
      stale.result?.recovery?.failure_kind === 'condition_failed' &&
        /new authorization/i.test(stale.result?.recovery?.next_steps?.join(' ') ?? ''),
      'HTTP condition failure carries the recovery contract',
    ));

    // Case C (continuous-dogfood §8, checklist item 5 — redirect behavior):
    // a 307 redirect to the /correct handler. The redirected request must
    // still carry If-Match, and the target must still enforce it. Verified
    // through the real network stack (undici follows the redirect).
    const viaRedirect = async (ifMatch) => fetch(`${base}/redirect/deploy-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      body: JSON.stringify({ content: 'replicas: 5 # via redirect' }),
    });
    const currentEtag = (await fetch(`${base}/correct/deploy-config`, { headers: { accept: 'application/json' } })).headers.get('etag');
    const staleEtag = '"v1"';
    const rejected = await viaRedirect(staleEtag === currentEtag ? '"definitely-stale"' : staleEtag);
    const truth1 = await (await fetch(`${base}/__state/correct/deploy-config`)).json();
    steps.push(expectBlock(
      rejected.status === 412 && truth1.content === 'replicas: 9 # concurrent actor',
      'redirected stale If-Match: the target still enforces the precondition through the 307 (412, no mutation)',
      `status=${rejected.status} revision_after_stale_redirect=${truth1.revision}`,
    ));
    const accepted = await viaRedirect(currentEtag);
    const truth2 = await (await fetch(`${base}/__state/correct/deploy-config`)).json();
    steps.push(expectSuccess(
      accepted.status === 200 && truth2.content === 'replicas: 5 # via redirect',
      'redirected matching If-Match: mutation applied through the 307 (precondition preserved end to end)',
      `status=${accepted.status} revision_after_matching_redirect=${truth2.revision}`,
    ));

    return { steps };
  },
};
