/**
 * Scenario: the BROKEN server (ignores If-Match). This is the documented
 * operator-verification trust boundary (dogfood S14 Case C, P2-DOC): the
 * firewall sends the condition, the server ignores it, the stale write
 * lands, and the firewall — which cannot wiretap the server — records what
 * it can honestly see (condition sent + satisfied from its vantage point).
 *
 * The scenario ASSERTS this documented behavior: if the firewall started
 * silently claiming enforcement here, that would be a SECURITY_FAILURE.
 */

import { StaleStateFirewall, MemoryStore, HttpStateProvider } from 'stale-state-firewall';
import { documentedBoundary, expectSuccess } from '../verdicts.mjs';

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
        : { condition: 'failed', ref: REF, observed_version: res.current_version };
    },
  };
}

export default {
  id: 'http-broken-server-boundary',
  title: 'Documented boundary: an If-Match-ignoring server voids the CAS — the firewall records what it can see',
  kind: 'deterministic',
  async run({ sandboxPort }) {
    const steps = [];
    const base = `http://127.0.0.1:${sandboxPort}`;
    const provider = new HttpStateProvider({
      broken: {
        url: `${base}/broken/legacy-config`,
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
      { source: 'http', resource: 'broken', resource_id: 'legacy-config', version: null, metadata: {} },
      new Date().toISOString(),
    );

    // The world moves; the broken server applies the stale write anyway.
    const outcome = await firewall.execute({
      agent_id: 'agent', tool: 'http', operation: 'update_resource',
      arguments: { content: 'stale write against broken server' },
      dependencies: [{ source: 'http', resource: 'broken', resource_id: 'legacy-config', version: snap.version }],
    }, executorFor(provider, 'broken', 'legacy-config', (i) => i.arguments['content']), { actionId: `act_http_c_${Date.now()}` });

    const truth = await fetch(`${base}/__state/broken/legacy-config`).then((r) => r.json());

    // Documented boundary: the write LANDED; the firewall recorded
    // condition sent + satisfied (its vantage point), atomicity 'guaranteed'
    // is the EXECUTOR's declaration, and the audit carries the full expected
    // state so an operator comparing server truth vs expected state detects
    // the violation. If the firewall had pretended the server enforced
    // nothing happened, or claimed refusal, that would be dishonest.
    steps.push(documentedBoundary(
      outcome.executed === true && outcome.result?.conditional_execution === 'satisfied' &&
        String(truth.content).includes('stale write'),
      'broken server applied the stale write; firewall records its own vantage honestly (documented trust boundary — operator MUST verify If-Match per endpoint)',
      `executed=${outcome.executed} conditional=${outcome.result?.conditional_execution} server_revisions=${truth.mutations?.length}`,
    ));

    steps.push(expectSuccess(
      Array.isArray(outcome.result?.expected_state) && outcome.result?.expected_state?.length === 1 &&
        outcome.auditTailAccessible !== false,
      'the audit carries the exact expected state the condition was sent against (verification duty evidence)',
      `expected_state=${JSON.stringify(outcome.result?.expected_state)}`,
    ));

    await firewall.close();
    return { steps };
  },
};
