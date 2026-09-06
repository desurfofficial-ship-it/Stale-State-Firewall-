import { describe, it, expect } from 'vitest';
import { harness, track } from '../helpers/harness.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { ReplayDetectedError } from '../../src/domain/errors.js';
import type { ActionExecutor, ActionIntentInput, ExecutionResult } from '../../src/domain/action.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { ManualClock } from '../../src/engine/clock.js';

/**
 * Milestone: ATOMIC EFFECT ASSURANCE (conditional execution).
 *
 * The core proof of this milestone: once the firewall authorizes against a
 * state identity, a concurrent external mutation between authorization and
 * execution is rejected BY THE PROVIDER ITSELF (compare-and-swap), not by a
 * fresh read performed by the firewall. A fresh read is still TOCTOU; the
 * condition must be enforced inside the external system.
 */

const REF = 'memory:deployment/prod';

/**
 * Reference conditional executor: forwards the firewall-authorized expected
 * state to the in-memory provider's atomic CAS. This is the canonical wiring
 * the docs describe: the executor does NOT re-read state; it hands the
 * AUTHORIZED version to the provider and lets the provider decide.
 */
function memoryConditionalExecutor(
  provider: InMemoryStateProvider,
  target: { resource: string; resourceId: string },
  changes: Record<string, unknown>,
): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === `memory:${target.resource}/${target.resourceId}`);
      if (!entry || entry.version === null) {
        // No authorized state identity for the resource this effect touches:
        // refuse to act (fail closed) rather than execute unconditionally.
        return { condition: 'unavailable', error: 'no authorized expected state for the target resource' };
      }
      const result = await provider.conditionalExecute({
        ref: { source: 'memory', resource: target.resource, resource_id: target.resourceId },
        expected_version: entry.version,
        changes,
      });
      if (result.outcome === 'executed') {
        return { condition: 'satisfied', success: true, output: { version: result.version } };
      }
      return { condition: 'failed', observed_version: result.current_version };
    },
    async execute() {
      // Legacy fallback — only used when the firewall does not take the
      // conditional path (executor without conditional capability).
      provider.mutate(target.resource, target.resourceId, changes, new Date().toISOString());
      return { success: true };
    },
  };
}

function deployIntent(version: string, extra: Partial<ActionIntentInput> = {}, resourceId = 'prod'): ActionIntentInput {
  return {
    agent_id: 'release-bot',
    tool: 'deploy',
    operation: 'deploy_production',
    dependencies: [{ source: 'memory', resource: 'deployment', resource_id: resourceId, version }],
    ...extra,
  };
}

describe('conditional execution: the critical race (milestone §17)', () => {
  it('CR1 T0-T4: state changes after authorization -> the PROVIDER rejects the operation', async () => {
    const h = await harness();
    // T0: state = X (healthy, version v1)
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, {
      status: 'deployed-by-action',
    });
    const realConditional = executor.conditionalExecute!.bind(executor);
    executor.conditionalExecute = async (intent, expectedState) => {
      // T2: a concurrent actor mutates X -> Y AFTER the firewall authorized
      // against X but BEFORE the conditional operation runs. This lands in
      // the exact window the fetch-compare re-check cannot close.
      h.provider.mutate('deployment', 'prod', { status: 'changed-by-attacker' }, h.clock.nowIso());
      // T3+T4: the conditional operation carries the AUTHORIZED version X;
      // the provider itself compares it against Y and refuses.
      return realConditional(intent, expectedState);
    };

    const outcome = await h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_cond_1' });

    // T4: the provider rejected the stale operation.
    expect(outcome.executed).toBe(false);
    expect(outcome.result).not.toBeNull();
    expect(outcome.result!.success).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('failed');
    expect(outcome.result!.observed_version).not.toBe(versionX);
    expect(outcome.result!.atomicity).toBe('guaranteed');
    expect(outcome.decision.decision).not.toBe('ALLOW');
    expect(outcome.decision.reason).toContain('conditional execution was rejected');

    // The action's side effect never landed: only the adversarial mutation exists.
    const state = h.provider.get('deployment', 'prod')!;
    expect(state.metadata['status']).toBe('changed-by-attacker');
    expect(state.metadata['deployed-by-action']).toBeUndefined();

    // The authorization was invalidated: the same action id cannot re-run.
    await expect(
      h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_cond_1' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it('CR2 same-state success: no mutation -> the condition holds and the action executes', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const outcome = await h.firewall.execute(
      deployIntent(versionX),
      memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, {
        status: 'deployed-by-action',
      }),
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.result!.success).toBe(true);
    expect(outcome.result!.conditional_execution).toBe('satisfied');
    expect(outcome.result!.atomicity).toBe('guaranteed');
    expect(outcome.result!.expected_state).toEqual([{ ref: REF, version: versionX }]);
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('deployed-by-action');
  });

  it('CR3 two authorizations race the same resource: exactly one conditional execution wins', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const makeExecutor = (marker: string): ActionExecutor =>
      memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: marker });

    // Both actions validate against X and authorize; the CAS calls are
    // serialized by the provider's atomic compare-and-swap, so the second
    // one MUST observe a moved version and be rejected by the provider.
    const [a, b] = await Promise.all([
      h.firewall.execute(deployIntent(versionX), makeExecutor('deployed-by-A')),
      h.firewall.execute(deployIntent(versionX), makeExecutor('deployed-by-B')),
    ]);

    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.executed && o.result!.success === true);
    const conditionFailed = outcomes.filter((o) => o.result?.conditional_execution === 'failed');
    expect(succeeded).toHaveLength(1);
    expect(conditionFailed).toHaveLength(1);
    expect(conditionFailed[0]!.result!.observed_version).not.toBe(versionX);
    // Exactly one of the two markers landed in the resource metadata.
    const finalStatus = h.provider.get('deployment', 'prod')!.metadata['status'];
    expect(finalStatus).toMatch(/^deployed-by-[AB]$/);
  });

  it('CR4 drift between validation and authorization is also caught by the CAS', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    // Mutate right after the validation fetch returns: the authorization is
    // then granted on already-drifted state, and the CAS must still refuse.
    const realGetState = h.provider.getState.bind(h.provider);
    let fetched = false;
    h.provider.getState = async (ref, nowIso) => {
      const snap = await realGetState(ref, nowIso);
      if (!fetched) {
        fetched = true;
        h.provider.mutate('deployment', 'prod', { status: 'changed-early' }, h.clock.nowIso());
      }
      return snap;
    };

    const outcome = await h.firewall.execute(
      deployIntent(versionX),
      memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' }),
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('failed');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('changed-early');
  });

  it('CR5 LEGACY LIMITATION (documented, not hidden): without conditional capability the compare->execute window stays open', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    // Mutation lands after the SECOND fetch (the TOCTOU re-check) returns
    // but before the executor runs — inside the residual race window that a
    // pre-execution read cannot close (milestone §35: a second read does
    // not create atomicity).
    const realGetState = h.provider.getState.bind(h.provider);
    let fetchCount = 0;
    h.provider.getState = async (ref, nowIso) => {
      const snap = await realGetState(ref, nowIso);
      fetchCount += 1;
      if (fetchCount === 2) {
        h.provider.mutate('deployment', 'prod', { status: 'changed-in-residual-window' }, h.clock.nowIso());
      }
      return snap;
    };

    const legacyExecutor: ActionExecutor = {
      idempotency: 'non_idempotent',
      async execute() {
        h.provider.mutate('deployment', 'prod', { status: 'deployed' }, h.clock.nowIso());
        return { success: true };
      },
    };

    const outcome = await h.firewall.execute(deployIntent(versionX), legacyExecutor);

    // This is the documented BEST-EFFORT guarantee of the legacy path: the
    // firewall cannot prevent this execution; it records atomicity
    // not_guaranteed and the conditional outcome as not_attempted.
    // Conditional execution (CR1) closes exactly this gap.
    expect(outcome.executed).toBe(true);
    expect(outcome.result!.atomicity).toBe('not_guaranteed');
    expect(outcome.result!.conditional_execution).toBe('not_attempted');
  });
});

describe('conditional execution: argument and target binding (milestone §19)', () => {
  it('CB1 an authorization for resource A cannot drive a CAS on resource B', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    track(h.provider, 'deployment', 'staging', { status: 'healthy' }, h.nowIso);
    const versionProd = h.provider.get('deployment', 'prod')!.version;

    // The executor was pointed at staging, but the authorization validated
    // prod: no expected-state entry exists for staging -> must refuse.
    const outcome = await h.firewall.execute(
      deployIntent(versionProd),
      memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'staging' }, { status: 'deployed' }),
    );

    expect(outcome.executed).toBe(false);
    expect(outcome.result!.success).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('unavailable');
    expect(h.provider.get('deployment', 'staging')!.metadata['status']).toBe('healthy');
  });

  it('CB2 the provider CAS is ref-scoped: a version from another resource cannot satisfy the condition', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    track(h.provider, 'deployment', 'staging', { status: 'healthy' }, h.nowIso);
    const versionProd = h.provider.get('deployment', 'prod')!.version;

    const result = await h.provider.conditionalExecute({
      ref: { source: 'memory', resource: 'deployment', resource_id: 'staging' },
      expected_version: versionProd, // authorized for prod, applied to staging
      changes: { status: 'deployed' },
    });
    expect(result.outcome).toBe('condition_failed');
    expect(h.provider.get('deployment', 'staging')!.metadata['status']).toBe('healthy');
  });
});

describe('conditional execution x replay protection (milestone §20)', () => {
  it('RP1 a condition failure consumes the authorization: replay is rejected', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    const realConditional = executor.conditionalExecute!.bind(executor);
    executor.conditionalExecute = async (intent, expectedState) => {
      h.provider.mutate('deployment', 'prod', { status: 'changed-by-attacker' }, h.clock.nowIso());
      return realConditional(intent, expectedState);
    };

    const first = await h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_rp1' });
    expect(first.result!.conditional_execution).toBe('failed');

    // Even with the state left as the attacker left it, the SAME action id
    // must not re-execute: the authorization was consumed by the failure.
    await expect(
      h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_rp1' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it('RP2 two concurrent executions of the same action id: exactly one claim wins', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    const [winner, loser] = await Promise.allSettled([
      h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_rp2' }),
      h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_rp2' }),
    ]);

    const settled = [winner, loser];
    const rejected = settled.filter((r) => r.status === 'rejected');
    const fulfilled = settled.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<StaleStateFirewall['execute']>>> => r.status === 'fulfilled',
    );
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ReplayDetectedError);
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.result!.conditional_execution).toBe('satisfied');
  });

  it('RP3 conditional success consumes the authorization: replay is rejected', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    const first = await h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_rp3' });
    expect(first.executed).toBe(true);
    await expect(
      h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_rp3' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });
});

describe('conditional execution: failure injection (milestone §21)', () => {
  it('FI1 a provider crash during conditional execution is a failure, never a success, and never a condition failure', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    executor.conditionalExecute = async () => {
      throw new Error('simulated provider 500');
    };

    const outcome = await h.firewall.execute(deployIntent(versionX), executor);

    expect(outcome.result!.success).toBe(false);
    // Operationalization milestone: recorded explicitly as 'unknown'
    // (outcome not observable — not 'failed', never success).
    expect(outcome.result!.conditional_execution).toBe('unknown');
    expect(outcome.result!.recovery?.retry_safety).toBe('UNSAFE');
    expect(outcome.result!.error).toContain('simulated provider 500');
    // Crash != condition failure: no execution.condition_failed event.
    const audit = await h.firewall.auditTail(50);
    const conditionFailedEvents = audit.filter(
      (r) => r.event_type === 'execution.condition_failed' && r.payload['action_id'] === outcome.decision.action_id,
    );
    expect(conditionFailedEvents).toHaveLength(0);
  });

  it('FI2 a deadline exceeded during conditional execution records an honest failure', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const provider = new InMemoryStateProvider('memory');
    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          {
            name: 'deploy-production',
            match: { operation: 'deploy*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            on_unknown: 'deny',
            execution: { deadline: 20, require_fresh_at_execution: true },
          },
        ],
      },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const versionX = provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    executor.conditionalExecute = async () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('action act_fi2 exceeded its 20ms execution deadline')), 60);
      });

    const outcome = await firewall.execute(deployIntent(versionX), executor, { actionId: 'act_fi2' });
    expect(outcome.result!.success).toBe(false);
    expect(outcome.result!.error).toContain('deadline');
    await firewall.close();
  });

  it('FI3 condition "unavailable" fails closed: no side effect, no silent fallback to unconditional execution', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute() {
        return { condition: 'unavailable', error: 'cannot enforce the expected state for this effect' };
      },
      async execute() {
        throw new Error('the legacy path must NOT be used as a fallback after the conditional path was taken');
      },
    };

    const outcome = await h.firewall.execute(deployIntent(versionX), executor);

    expect(outcome.executed).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('unavailable');
    expect(outcome.result!.success).toBe(false);
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('healthy');
  });

  it('FI4 condition failure and provider crash produce distinct, truthful audit trails', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    // Path 1: provider-enforced condition failure.
    const failingExecutor = memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    const realConditional = failingExecutor.conditionalExecute!.bind(failingExecutor);
    failingExecutor.conditionalExecute = async (intent, expectedState) => {
      h.provider.mutate('deployment', 'prod', { status: 'moved' }, h.clock.nowIso());
      return realConditional(intent, expectedState);
    };
    const outcome1 = await h.firewall.execute(deployIntent(versionX), failingExecutor, { actionId: 'act_fi4_a' });
    expect(outcome1.result!.conditional_execution).toBe('failed');

    // Path 2: provider crash on a fresh action (different resource).
    track(h.provider, 'deployment', 'prod2', { status: 'healthy' }, h.nowIso);
    const versionP2 = h.provider.get('deployment', 'prod2')!.version;
    const crashingExecutor: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute() {
        throw new Error('connection reset');
      },
      async execute() {
        return { success: true };
      },
    };
    const outcome2 = await h.firewall.execute(deployIntent(versionP2, {}, 'prod2'), crashingExecutor, { actionId: 'act_fi4_b' });
    expect(outcome2.result!.success).toBe(false);
    // Operationalization milestone: the faulted conditional operation is
    // recorded EXPLICITLY as unknown (previously absent), with recovery
    // guidance saying retry is unsafe until external state is inspected.
    expect(outcome2.result!.conditional_execution).toBe('unknown');
    expect(outcome2.result!.recovery?.failure_kind).toBe('unknown_execution_outcome');
    expect(outcome2.result!.recovery?.retry_safety).toBe('UNSAFE');
    expect(outcome2.result!.recovery?.side_effect_possible).toBe(true);

    const audit = await h.firewall.auditTail(100);
    const failed = audit.find(
      (r) => r.event_type === 'execution.condition_failed' && r.payload['action_id'] === 'act_fi4_a',
    );
    expect(failed).toBeDefined();
    expect(failed!.payload['conditional_execution']).toBe('failed');
    expect(Array.isArray(failed!.payload['expected_state'])).toBe(true);
    const crashRecord = audit.find(
      (r) => r.event_type === 'action.failed' && r.payload['action_id'] === 'act_fi4_b',
    );
    expect(crashRecord).toBeDefined();
    expect(crashRecord!.payload['conditional_execution']).toBe('unknown');
  });
});

describe('conditional execution: audit and observability (milestone §22, §23)', () => {
  it('AU1 the audit trail reconstructs the conditional lifecycle without ambiguous success', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const provider = new InMemoryStateProvider('memory');
    const store = new MemoryStore();
    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          {
            name: 'deploy-production',
            match: { operation: 'deploy*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            on_unknown: 'deny',
            execution: { deadline: '10s', require_fresh_at_execution: true },
          },
        ],
      },
      store,
      providers: [provider],
      clock,
    });
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const versionX = provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    const realConditional = executor.conditionalExecute!.bind(executor);
    executor.conditionalExecute = async (intent, expectedState) => {
      provider.mutate('deployment', 'prod', { status: 'moved' }, clock.nowIso());
      return realConditional(intent, expectedState);
    };
    const outcome = await firewall.execute(deployIntent(versionX), executor, { actionId: 'act_au1' });
    expect(outcome.executed).toBe(false); // the provider refused: nothing executed

    const audit = await firewall.auditTail(100);
    const types = audit.filter((r) => r.payload['action_id'] === 'act_au1').map((r) => r.event_type);
    expect(types).toContain('execution.condition_failed');
    expect(types).not.toContain('action.executed'); // provider refused: never claim success

    const conditionFailed = audit.find(
      (r) => r.event_type === 'execution.condition_failed' && r.payload['action_id'] === 'act_au1',
    )!;
    expect(conditionFailed.payload['expected_state']).toEqual([{ ref: REF, version: versionX }]);
    expect(conditionFailed.payload['observed_version']).not.toBe(versionX);
    // The event references the decision that authorized the operation.
    const auth = await store.getAuthorization('act_au1');
    expect(conditionFailed.payload['decision_ref']).toBe(auth!.decision_id);
    expect(conditionFailed.payload['provider']).toBe('memory');

    // The chained audit ledger still verifies.
    const verification = await firewall.verifyAudit();
    expect(verification.ok).toBe(true);

    // Metrics distinguish satisfied from failed.
    const metrics = firewall.getMetrics();
    expect(metrics.counters.conditional_executions_failed).toBe(1);
    expect(metrics.counters.conditional_executions_satisfied).toBe(0);
    await firewall.close();
  });

  it('AU2 the authorization record binds the authorized expected state', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const provider = new InMemoryStateProvider('memory');
    const store = new MemoryStore();
    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          {
            name: 'deploy-production',
            match: { operation: 'deploy*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            on_unknown: 'deny',
            execution: { deadline: '10s', require_fresh_at_execution: true },
          },
        ],
      },
      store,
      providers: [provider],
      clock,
    });
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const versionX = provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    await firewall.execute(deployIntent(versionX), executor, { actionId: 'act_au2' });

    const auth = await store.getAuthorization('act_au2');
    expect(auth).not.toBeNull();
    expect(auth!.expected_state).toEqual([
      { ref: REF, version: versionX, content_hash: expect.any(String) },
    ]);
    await firewall.close();
  });

  it('AU3 persisted execution records distinguish condition failure from execution failure', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = memoryConditionalExecutor(h.provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
    const realConditional = executor.conditionalExecute!.bind(executor);
    executor.conditionalExecute = async (intent, expectedState) => {
      h.provider.mutate('deployment', 'prod', { status: 'moved' }, h.clock.nowIso());
      return realConditional(intent, expectedState);
    };
    const outcome = await h.firewall.execute(deployIntent(versionX), executor, { actionId: 'act_au3' });
    const persisted: ExecutionResult | null = outcome.result;
    expect(persisted!.conditional_execution).toBe('failed');
    expect(persisted!.success).toBe(false);
    expect(persisted!.atomicity).toBe('guaranteed');
  });
});

describe('conditional execution: persistence round-trip (SQLite, migration v2)', () => {
  it('SQ1 expected-state binding and condition outcomes survive store close/reopen', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SqliteStore } = await import('../../src/storage/sqlite/store.js');

    const dir = mkdtempSync(join(tmpdir(), 'ssf-cond-'));
    const dbPath = join(dir, 'state.db');
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const provider = new InMemoryStateProvider('memory');

    // Phase 1: run a condition-failure flow against a file-backed store.
    {
      const store = new SqliteStore({ path: dbPath });
      const firewall = await StaleStateFirewall.create({
        config: {
          firewall: { mode: 'enforce', storage: { type: 'memory' } },
          defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
          actions: [
            {
              name: 'deploy-production',
              match: { operation: 'deploy*' },
              risk: 'CRITICAL',
              freshness: { strategy: 'version' },
              on_unknown: 'deny',
              execution: { deadline: '10s' },
            },
          ],
        },
        store,
        providers: [provider],
        clock,
      });
      provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
      const versionX = provider.get('deployment', 'prod')!.version;

      const executor = memoryConditionalExecutor(provider, { resource: 'deployment', resourceId: 'prod' }, { status: 'deployed' });
      const realConditional = executor.conditionalExecute!.bind(executor);
      executor.conditionalExecute = async (intent, expectedState) => {
        provider.mutate('deployment', 'prod', { status: 'moved' }, clock.nowIso());
        return realConditional(intent, expectedState);
      };
      const outcome = await firewall.execute(deployIntent(versionX), executor, { actionId: 'act_sq1' });
      expect(outcome.result!.conditional_execution).toBe('failed');
      await firewall.close();
    }

    // Phase 2: reopen and verify the persisted records are complete.
    {
      const store = new SqliteStore({ path: dbPath });
      await store.init();
      const auth = await store.getAuthorization('act_sq1');
      expect(auth).not.toBeNull();
      expect(auth!.expected_state).toEqual([
        { ref: REF, version: expect.any(String), content_hash: expect.any(String) },
      ]);
      expect(auth!.consumed_at).not.toBeNull();
      const executions = await store.listExecutions('act_sq1');
      expect(executions).toHaveLength(1);
      expect(executions[0]!.conditional_execution).toBe('failed');
      expect(executions[0]!.expected_state).toEqual(auth!.expected_state!.map(({ ref, version }) => ({ ref, version })));
      expect(executions[0]!.observed_version).not.toBeNull();
      await store.close();
    }

    rmSync(dir, { recursive: true, force: true });
  });
});
