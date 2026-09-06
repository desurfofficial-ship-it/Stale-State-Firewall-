/**
 * Scenario: dependency completeness boundary (dogfood finding DF-F2,
 * operationalization §20). A = mutation target (CAS-protected),
 * B = read-only dependency whose value the action PARAMETERS were derived
 * from. Asserts BOTH documented behaviors:
 *   1. B drifts BEFORE authorization  -> DENY (fresh validation catches it).
 *   2. B drifts in the CAS window     -> the action executes from the
 *      authorized B value (per-resource CAS does not re-verify read-only
 *      deps). Documented PROVIDER LIMITATION — an operator who needs B
 *      covered must restructure the intent so B is the conditioned ref.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock } from 'stale-state-firewall';
import { documentedBoundary, expectBlock } from '../verdicts.mjs';

const FILE_REF = 'memory:file/configs/deploy.yaml';

const POLICY = [{
  name: 'update-deploy-config',
  match: { tool: 'ops', operation: 'update_deploy_config' },
  risk: 'HIGH',
  freshness: { strategy: 'version' },
  execution: { deadline: '30s' },
}];

function executor(provider, contentFromImage) {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    async execute() {
      return { success: true };
    },
    conditionalExecutionSupported: () => true,
    async conditionalExecute(intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === FILE_REF);
      if (!entry?.version) return { condition: 'unavailable', error: 'no authorized expected state for the written file' };
      const res = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml' },
        expected_version: entry.version,
        // Parameters derived from the READ-ONLY image_tag dependency at
        // authorization time — the CAS cannot re-verify that derivation.
        changes: { content: contentFromImage ?? `image: ${intent.arguments['image']}\n` },
      });
      return res.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: res.version }
        : { condition: 'failed', ref: FILE_REF, observed_version: res.current_version };
    },
  };
}

function intent(vFile, vImage, image) {
  return {
    agent_id: 'deploy-agent',
    tool: 'ops',
    operation: 'update_deploy_config',
    arguments: { image },
    dependencies: [
      { source: 'memory', resource: 'file', resource_id: 'configs/deploy.yaml', version: vFile },
      { source: 'memory', resource: 'image_tag', resource_id: 'api', version: vImage },
    ],
  };
}

export default {
  id: 'dependency-completeness-boundary',
  title: 'DF-F2 boundary: written dep is CAS-protected; read-only dep drift in the CAS window is not',
  kind: 'deterministic',
  async run() {
    const steps = [];
    const provider = new InMemoryStateProvider('memory');
    const clock = new ManualClock('2026-09-06T09:30:00Z');
    const firewall = await StaleStateFirewall.create({
      config: { firewall: { mode: 'enforce', storage: { type: 'memory' } }, actions: POLICY },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('file', 'configs/deploy.yaml', { content: 'image: api:1.2.3\n' }, clock.nowIso());
    provider.put('image_tag', 'api', { tag: '1.2.3', digest: 'sha256:aaaa' }, clock.nowIso());
    const vFile = provider.get('file', 'configs/deploy.yaml').version;
    const vImage = provider.get('image_tag', 'api').version;

    // (1) B drifts BEFORE authorization: full fresh validation catches it.
    provider.mutate('image_tag', 'api', { tag: '2.0.0', digest: 'sha256:bbbb' }, clock.nowIso());
    const early = await firewall.execute(intent(vFile, vImage, 'api:1.2.3'), executor(provider));
    steps.push(expectBlock(
      early.executed === false && early.decision.decision === 'DENY',
      'read-only dependency drift BEFORE authorization -> DENY at validation (declared deps are re-read)',
      `decision=${early.decision.decision}`,
    ));

    // (2) B drifts in the CAS window (after authorization, before mutation):
    // the per-resource CAS protects the WRITTEN ref only; the action applies
    // with the authorized B value. This is the documented DF-F2 scope.
    provider.mutate('image_tag', 'api', { tag: '1.2.3', digest: 'sha256:aaaa' }, clock.nowIso()); // re-align for a clean ALLOW
    const vFileNow = provider.get('file', 'configs/deploy.yaml').version;
    const vImageNow = provider.get('image_tag', 'api').version;
    const ex = executor(provider);
    const realCas = ex.conditionalExecute.bind(ex);
    ex.conditionalExecute = async (i, es) => {
      provider.mutate('image_tag', 'api', { tag: '9.9.9', digest: 'sha256:dead' }, clock.nowIso()); // B moves mid-flight
      return realCas(i, es);
    };
    const late = await firewall.execute(intent(vFileNow, vImageNow, 'api:1.2.3'), ex, { actionId: 'act_dff2' });
    steps.push(documentedBoundary(
      late.executed === true && late.result?.conditional_execution === 'satisfied',
      'read-only dependency drift IN THE CAS WINDOW -> action executed from authorized values (documented provider limitation: no multi-resource CAS exists; restructure the intent if read-only drift matters)',
      `executed=${late.executed} conditional=${late.result?.conditional_execution} atomicity=${late.result?.atomicity}`,
    ));

    return { steps };
  },
};
