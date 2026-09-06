/**
 * CANONICAL integration example: how an internal agent uses Stale-State
 * Firewall around a consequential operation (operationalization milestone §17).
 *
 * This is the reference integration for future internal consumers. It walks
 * the FULL lifecycle with only public API surface:
 *
 *   1. observe     — the agent reads current state (provider read)
 *   2. declare     — build an ActionIntent: what it wants to do, the state it
 *                    relied on, the invariants that must hold, the risk
 *   3. check       — optional dry-run decision
 *   4. authorize   — firewall validates against FRESH state and issues a
 *                    single-use, deadline-bounded authorization
 *   5. execute     — provider-enforced conditional execution (CAS): the
 *                    EXTERNAL system refuses the operation if its
 *                    authoritative state no longer matches the authorized one
 *   6. audit       — the hash-chained audit trail reconstructs the event
 *   7. recover     — the world changes: a stale attempt is refused
 *                    (condition failure), the recovery contract says exactly
 *                    what to do, and a fresh observation -> NEW authorization
 *                    -> retry succeeds
 *
 * Run: npm run build && npm run example:canonical
 * (Offline: the in-memory provider stands in for a real CAS-capable system;
 *  the same executor shape works against GitHub/HTTP — see examples/.)
 */

import {
  StaleStateFirewall,
  InMemoryStateProvider,
  MemoryStore,
  BlockedActionError,
  refKey,
  type ActionIntentInput,
  type ExpectedStateEntry,
} from 'stale-state-firewall';

// ---------------------------------------------------------------------------
// 0. Bootstrap: firewall + a CAS-capable world
// ---------------------------------------------------------------------------

const provider = new InMemoryStateProvider('deploy'); // any CAS-capable provider
provider.put('file', 'configs/deploy.yaml', {
  content: 'service: api\nreplicas: 2\nimage: registry/api:1.2.3\n',
}, new Date().toISOString());

const firewall = await StaleStateFirewall.create({
  config: {
    firewall: { mode: 'enforce', storage: { type: 'memory' } },
    actions: [
      {
        name: 'update-deploy-config',
        match: { tool: 'ops', operation: 'update_deploy_config' },
        risk: 'HIGH',
        freshness: { strategy: 'version' }, // the provider's version signal must still match
        execution: {
          deadline: '30s',                      // the authorization validity window
          require_conditional_execution: true,  // refuse best-effort: demand the provider CAS
        },
      },
    ],
  },
  store: new MemoryStore(),
  providers: [provider],
});

const say = (line: string) => process.stdout.write(line + '\n');
say('== SSF canonical integration example ==\n');

const FILE_REF = refKey({ source: 'deploy', resource: 'file', resource_id: 'configs/deploy.yaml' });

// ---------------------------------------------------------------------------
// 1. The protected tool (the ONLY way agents reach the operation)
// ---------------------------------------------------------------------------

/**
 * The executor is the honest integrator shape: it forwards the firewall-
 * authorized expected state to the provider's own compare-and-swap. It does
 * NOT re-read current state (a fresh read is not conditional execution).
 */
const editDeployConfig = firewall.protect<{ replicas: number; observedVersion: string }, { appliedVersion: string }>({
  name: 'ops',
  toIntent: (input): ActionIntentInput => ({
    agent_id: 'deploy-agent',
    operation: 'update_deploy_config',
    arguments: { replicas: input.replicas },
    // Declare EVERY dependency the reasoning relied on. The firewall re-reads
    // each one from the provider at authorization time.
    dependencies: [
      { source: 'deploy', resource: 'file', resource_id: 'configs/deploy.yaml', version: input.observedVersion },
    ],
    // Invariants the firewall verifies against CURRENT (not claimed) state
    // would be declared here (e.g. deployment.status == 'idle').
    preconditions: [],
  }),
  idempotency: 'non_idempotent',
  atomicity: 'guaranteed',
  conditionalExecutionSupported: true,
  conditionalRun: async (input, expectedState) => {
    const entry: ExpectedStateEntry | undefined = expectedState.find((e) => e.ref === FILE_REF);
    if (!entry?.version) {
      // Fail closed: no authorized expected state -> refuse to act.
      return { applied: false, error: 'no authorized expected state for the written ref' };
    }
    const result = await provider.conditionalExecute({
      ref: { source: 'deploy', resource: 'file', resource_id: 'configs/deploy.yaml' },
      expected_version: entry.version, // THE condition, evaluated by the provider
      changes: { content: `service: api\nreplicas: ${input.replicas}\nimage: registry/api:1.2.3\n` },
    });
    return result.outcome === 'executed'
      ? { applied: true, output: { appliedVersion: result.version ?? '' } }
      : {
          applied: false,
          ref: FILE_REF,
          observed_version: result.current_version,
          error: `provider refused: resource is at ${result.current_version}, authorized ${entry.version}`,
        };
  },
  // NOTE: the conditional hook IS the tool; the legacy run() is never taken.
  run: async () => {
    throw new Error('legacy path must never run when conditional capability is declared');
  },
});

// ---------------------------------------------------------------------------
// 2. Happy path: observe -> declare -> authorize -> provider CAS -> audit
// ---------------------------------------------------------------------------

const observedVersion = provider.get('file', 'configs/deploy.yaml')!.version;
say(`[1] agent observed configs/deploy.yaml at version ${observedVersion}`);

const dryRun = await editDeployConfig.check({ replicas: 3, observedVersion });
say(`[2] dry-run decision: ${dryRun.decision} (${dryRun.reason.slice(0, 70)}...)`);

const applied = await editDeployConfig.execute({ replicas: 3, observedVersion });
say(`[3] EXECUTED under provider-enforced CAS; new version ${applied.appliedVersion}`);

const tail = await firewall.auditTail(10);
const executedEvent = tail.find((r) => r.event_type === 'action.executed');
say(`[4] audit: ${executedEvent?.event_type} — ${String(executedEvent?.payload['reason']).slice(0, 80)}...`);
say(`    audit chain verifies: ${JSON.stringify((await firewall.verifyAudit()).ok)}\n`);

// ---------------------------------------------------------------------------
// 3. The world moves: a stale attempt is REFUSED, recovery is explicit
// ---------------------------------------------------------------------------

say('-- a concurrent actor edits the file (the world moves) --');
provider.mutate('file', 'configs/deploy.yaml', {
  content: 'service: api\nreplicas: 9 # hotfix by human\nimage: registry/api:1.2.3\n',
}, new Date().toISOString());

// The agent still holds the pre-hotfix version. The firewall re-reads CURRENT
// state at authorization time: the claim is STALE -> DENY before anything runs.
try {
  await editDeployConfig.execute({ replicas: 3, observedVersion });
  say('UNEXPECTED: the stale attempt executed');
} catch (error) {
  if (error instanceof BlockedActionError) {
    say(`[5] stale attempt BLOCKED: ${error.decision.decision}`);
    say(`    why: ${error.decision.reason.slice(0, 90)}...`);
    say(`    retry contract: ${error.recovery?.retry_safety}`);
    say(`    next step: ${error.recovery?.next_steps[2]?.slice(0, 80)}...`);
  } else {
    throw error;
  }
}

// A CAS-window attempt (claim current, world moves between authorization and
// mutation) is refused by the PROVIDER itself — surfaced as condition failure.
say('\n-- a CAS-window race: authorize, then the world moves before the mutation --');
const raceObserved = provider.get('file', 'configs/deploy.yaml')!.version;
const realCas = provider.conditionalExecute.bind(provider);
provider.conditionalExecute = async (request) => {
  provider.mutate('file', 'configs/deploy.yaml', {
    content: 'service: api\nreplicas: 9 # another concurrent change\nimage: registry/api:1.2.3\n',
  }, new Date().toISOString());
  return realCas(request);
};
try {
  await editDeployConfig.execute({ replicas: 3, observedVersion: raceObserved });
  say('UNEXPECTED: the CAS-window attempt executed');
} catch (error) {
  if (error instanceof BlockedActionError) {
    say(`[6] provider refused the stale mutation: ${error.execution?.conditional_execution}`);
    say(`    observed at the provider: ${error.execution?.observed_version}`);
    say(`    retry contract: ${error.recovery?.retry_safety} (${error.recovery?.failure_kind})`);
    say(`    authorization usable: ${error.recovery?.authorization_usable}`);
  } else {
    throw error;
  }
}
provider.conditionalExecute = realCas;

// ---------------------------------------------------------------------------
// 4. Recovery: fresh observation -> NEW authorization -> success
// ---------------------------------------------------------------------------

const freshVersion = provider.get('file', 'configs/deploy.yaml')!.version;
say(`\n[7] agent re-observes: fresh version ${freshVersion}`);
const recovered = await editDeployConfig.execute({ replicas: 3, observedVersion: freshVersion });
say(`[8] recovered: edit applied under CAS; version ${recovered.appliedVersion}`);

const metrics = firewall.getMetrics();
say('\n[9] local metrics (nothing transmitted):');
say(`    allowed=${metrics.counters.actions_allowed} denied=${metrics.counters.actions_denied} condition_failed=${metrics.counters.conditional_executions_failed} unknown_outcomes=${metrics.counters.executions_unknown_outcome}`);
say('\n== done ==');

await firewall.close();
process.exit(0);
