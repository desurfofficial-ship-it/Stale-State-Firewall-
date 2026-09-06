import { describe, it, expect } from 'vitest';
import { harness, track } from '../helpers/harness.js';
import type { ActionExecutor, ActionIntentInput, ConditionalExecutionResult, ExpectedStateEntry } from '../../src/domain/action.js';
import type { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { ReplayDetectedError } from '../../src/domain/errors.js';

/**
 * INDEPENDENT ASSURANCE AUDIT — core enforcement attacks.
 *
 * Every test in this file was written from the assurance-gate brief using
 * independently-wired executors and providers (no reuse of the milestone's
 * reference helpers beyond the shared harness). Each test states the attack
 * it reproduces and what outcome the guarantee requires.
 */

const REF = 'memory:deployment/prod';

function intent(version: string, extra: Partial<ActionIntentInput> = {}): ActionIntentInput {
  return {
    agent_id: 'audit-agent',
    tool: 'deploy',
    operation: 'deploy_production',
    dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
    ...extra,
  };
}

/**
 * Independent conditional executor: the only thing it does with the
 * expected state is forward the AUTHORIZED version (never a fresh read)
 * to the provider's CAS. This is the honest wiring the trust model relies on.
 */
function conditionalExecutor(
  provider: InMemoryStateProvider,
  changes: Record<string, unknown>,
  hooks: { beforeCas?: () => void } = {},
): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState: readonly ExpectedStateEntry[]) {
      hooks.beforeCas?.();
      const entry = expectedState.find((e) => e.ref === REF);
      if (!entry || entry.version === null) {
        return { condition: 'unavailable', error: 'no authorized expected state for the mutated resource' };
      }
      const result = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
        expected_version: entry.version,
        changes,
      });
      return result.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: { version: result.version } }
        : { condition: 'failed', observed_version: result.current_version };
    },
    async execute() {
      provider.mutate('deployment', 'prod', changes, new Date().toISOString());
      return { success: true };
    },
  };
}

describe('INDEPENDENT: the canonical stale-state race (brief §6/§7)', () => {
  it('IR1 T0-T4: state changes after authorization -> the PROVIDER refuses; no side effect lands', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = conditionalExecutor(h.provider, { status: 'deployed-by-audit' }, {
      beforeCas: () => {
        // T3: an external actor moves X -> Y AFTER the firewall authorized X.
        h.provider.mutate('deployment', 'prod', { status: 'attacker-write' }, h.clock.nowIso());
      },
    });

    const outcome = await h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir1' });

    // T4 required outcome: the provider (not a second read) refused.
    expect(outcome.executed).toBe(false);
    expect(outcome.result!.success).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('failed');
    expect(outcome.result!.observed_version).toBeTruthy();
    expect(outcome.result!.observed_version).not.toBe(versionX);

    // No side effect: the only write in the log is the attacker's.
    const log = h.provider.mutationLog('deployment', 'prod');
    expect(log).toHaveLength(1);
    expect(log[0]!.changes['status']).toBe('attacker-write');
    expect(h.provider.get('deployment', 'prod')!.metadata['deployed-by-audit']).toBeUndefined();

    // The stale authorization is dead: replay is refused.
    await expect(
      h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir1' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);

    // Audit must NOT claim the action executed.
    const audit = await h.firewall.auditTail(100);
    const execEvent = audit.find((r) => r.event_type === 'action.executed' && r.payload['action_id'] === 'audit_ir1');
    expect(execEvent).toBeUndefined();
    const conditionFailed = audit.find(
      (r) => r.event_type === 'execution.condition_failed' && r.payload['action_id'] === 'audit_ir1',
    );
    expect(conditionFailed).toBeDefined();
    expect((conditionFailed!.payload['expected_state'] as unknown[]).length).toBe(1);
    expect(conditionFailed!.payload['conditional_execution']).toBe('failed');
  });

  it('IR2 T0-T4 with state UNCHANGED -> the conditional operation succeeds (not over-restrictive)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const outcome = await h.firewall.execute(
      intent(versionX),
      conditionalExecutor(h.provider, { status: 'deployed-by-audit' }),
      { actionId: 'audit_ir2' },
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.result!.success).toBe(true);
    expect(outcome.result!.conditional_execution).toBe('satisfied');
    expect(outcome.result!.atomicity).toBe('guaranteed');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('deployed-by-audit');
  });

  it('IR3 KILL: removing the provider CAS check makes IR1\'s attack SUCCEED (test sensitivity proof)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const original = h.provider.conditionalExecute.bind(h.provider);
    const restores: Array<() => void> = [];
    try {
      // KILL MUTATION: the CAS comparison is removed — every request is
      // executed against the CURRENT version (the mechanism is gone).
      h.provider.conditionalExecute = async (request) =>
        original({ ...request, expected_version: h.provider.get('deployment', 'prod')!.version });
      restores.push(() => {
        h.provider.conditionalExecute = original;
      });

      const outcome = await h.firewall.execute(
        intent(versionX),
        conditionalExecutor(h.provider, { status: 'deployed-by-audit' }, {
          beforeCas: () => h.provider.mutate('deployment', 'prod', { status: 'attacker-write' }, h.clock.nowIso()),
        }),
      );

      // The attack lands: stale write on top of the attacker's change.
      expect(outcome.executed).toBe(true);
      expect(outcome.result!.conditional_execution).toBe('satisfied');
      expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('deployed-by-audit');
    } finally {
      while (restores.length > 0) restores.pop()!();
    }

    // Restore: the mechanism is back, and the same attack is refused again.
    // Reset the resource to a healthy baseline first (the first phase moved
    // 'status' away from the policy's precondition value).
    h.provider.put('deployment', 'prod', { status: 'healthy' }, h.clock.nowIso());
    const outcomeAfterRestore = await h.firewall.execute(
      intent(h.provider.get('deployment', 'prod')!.version),
      conditionalExecutor(h.provider, { status: 'deployed-again' }, {
        beforeCas: () => h.provider.mutate('deployment', 'prod', { status: 'attacker-write-2' }, h.clock.nowIso()),
      }),
      { actionId: 'audit_ir3b' },
    );
    expect(outcomeAfterRestore.result!.conditional_execution).toBe('failed');
    expect(h.provider.get('deployment', 'prod')!.metadata['deployed-again']).toBeUndefined();
  });

  it('IR4 SECOND-READ anti-pattern: an executor that substitutes a fresh read for the authorized version executes the stale action', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    // The executor DECLARES conditional support but discards the authorized
    // version and substitutes a FRESH read (the anti-pattern the milestone
    // forbids): authorize X, attacker moves to Y, executor reads Y, the CAS
    // trivially passes on Y. The firewall cannot detect this wiring from the
    // outside — this is the documented executor trust line, pinned here so
    // it stays explicit.
    const secondReadExecutor: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute() {
        h.provider.mutate('deployment', 'prod', { status: 'attacker-write' }, h.clock.nowIso());
        const current = h.provider.get('deployment', 'prod')!;
        const result = await h.provider.conditionalExecute({
          ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
          expected_version: current.version, // FRESH read, not authorized X
          changes: { status: 'deployed-by-audit' },
        });
        return result.outcome === 'executed'
          ? { condition: 'satisfied', success: true }
          : { condition: 'failed', observed_version: result.current_version };
      },
      async execute() {
        h.provider.mutate('deployment', 'prod', { status: 'deployed-by-audit' }, h.clock.nowIso());
        return { success: true };
      },
    };

    const outcome = await h.firewall.execute(intent(versionX), secondReadExecutor, {
      actionId: 'audit_ir4',
    });

    // GET -> compare -> EXECUTE went through: the stale action landed on top
    // of the attacker's write, and the record says satisfied/guaranteed —
    // the firewall's trust in the executor's IMPLEMENTATION is the boundary.
    expect(outcome.executed).toBe(true);
    expect(outcome.result!.conditional_execution).toBe('satisfied');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('deployed-by-audit');
  });

  it('IR4b require_conditional_execution + executor without conditional capability -> DENY (fail closed)', async () => {
    const h = await harness({
      config: {
        actions: [
          {
            name: 'deploy-production',
            match: { operation: 'deploy*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            on_unknown: 'deny',
            execution: { deadline: '10s', require_conditional_execution: true },
          },
        ],
      },
    });
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const legacy: ActionExecutor = {
      idempotency: 'non_idempotent',
      async execute() {
        h.provider.mutate('deployment', 'prod', { status: 'deployed' }, h.clock.nowIso());
        return { success: true };
      },
    };
    const outcome = await h.firewall.execute(intent(versionX), legacy, { actionId: 'audit_ir4b' });
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.decision).toBe('DENY');
    expect(outcome.decision.reason).toContain('requires provider-side conditional execution');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('healthy');
  });
});

describe('INDEPENDENT: in-memory CAS atomicity under concurrency (brief §10)', () => {
  it('IR5a 50 concurrent CAS calls, same expected version: exactly one mutation lands', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        h.provider.conditionalExecute({
          ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
          expected_version: versionX,
          changes: { winner: `w${i}` },
        }),
      ),
    );
    const executed = results.filter((r) => r.outcome === 'executed');
    const failed = results.filter((r) => r.outcome === 'condition_failed');
    expect(executed).toHaveLength(1);
    expect(failed).toHaveLength(49);

    const log = h.provider.mutationLog('deployment', 'prod');
    expect(log).toHaveLength(1); // exactly one real mutation
  });

  it('IR5b 8 concurrent firewall executions on the same authorized version: exactly one succeeds', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.firewall.execute(intent(versionX), conditionalExecutor(h.provider, { status: `w${i}` }), {
          actionId: `audit_ir5b_${i}`,
        }),
      ),
    );
    const satisfied = outcomes.filter((o) => o.result?.conditional_execution === 'satisfied');
    const failed = outcomes.filter((o) => o.result?.conditional_execution === 'failed');
    expect(satisfied).toHaveLength(1);
    expect(failed).toHaveLength(7);
    expect(h.provider.mutationLog('deployment', 'prod')).toHaveLength(1);
  });

  it('IR5c structural atomicity: no await between the CAS compare and the mutation write', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/providers/memory/in-memory-provider.ts', import.meta.url), 'utf8');
    const conditionalStart = src.indexOf('conditionalExecute(request: ConditionalMutationRequest)');
    const putStart = src.indexOf('put(', conditionalStart);
    const body = src
      .slice(conditionalStart, putStart)
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '')) // strip line comments
      .join('\n');
    // The compare-and-mutate region must be fully synchronous: returning
    // Promise.resolve does not yield the event loop, but an await would.
    expect(body.includes('await ')).toBe(false);
  });
});

describe('INDEPENDENT: authorization binding attacks (brief §14)', () => {
  it('IR6a an authorization for prod cannot drive a CAS against staging (target substitution)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    track(h.provider, 'deployment', 'staging', { status: 'healthy' }, h.nowIso);
    const versionProd = h.provider.get('deployment', 'prod')!.version;

    const swapped: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute(_intent, expectedState: readonly ExpectedStateEntry[]) {
        const entry = expectedState.find((e) => e.ref === 'memory:deployment/staging');
        if (!entry) return { condition: 'unavailable', error: 'staging not authorized' };
        const r = await h.provider.conditionalExecute({
          ref: { source: 'memory', resource: 'deployment', resource_id: 'staging' },
          expected_version: entry.version!,
          changes: { status: 'deployed' },
        });
        return r.outcome === 'executed' ? { condition: 'satisfied', success: true } : { condition: 'failed', observed_version: r.current_version };
      },
      async execute() {
        h.provider.mutate('deployment', 'staging', { status: 'deployed' }, h.clock.nowIso());
        return { success: true };
      },
    };

    const outcome = await h.firewall.execute(intent(versionProd), swapped, { actionId: 'audit_ir6a' });
    expect(outcome.executed).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('unavailable');
    expect(h.provider.get('deployment', 'staging')!.metadata['status']).toBe('healthy');
  });

  it('IR6b swapping versions between two authorized dependencies fails the CAS (state substitution)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    track(h.provider, 'deployment', 'drain', { status: 'idle' }, h.nowIso);
    h.provider.mutate('deployment', 'drain', { note: 'x' }, h.clock.nowIso()); // bump drain version
    const versionProd = h.provider.get('deployment', 'prod')!.version;
    const versionDrain = h.provider.get('deployment', 'drain')!.version;
    expect(versionProd).not.toBe(versionDrain);

    const crossSwap: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute(_intent, expectedState: readonly ExpectedStateEntry[]) {
        const drainEntry = expectedState.find((e) => e.ref === 'memory:deployment/drain')!;
        const r = await h.provider.conditionalExecute({
          ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
          expected_version: drainEntry.version!, // drain's version applied to prod
          changes: { status: 'deployed' },
        });
        return r.outcome === 'executed' ? { condition: 'satisfied', success: true } : { condition: 'failed', observed_version: r.current_version };
      },
      async execute() {
        return { success: true };
      },
    };

    const multiIntent: ActionIntentInput = {
      agent_id: 'audit-agent',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [
        { source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionProd },
        { source: 'memory', resource: 'deployment', resource_id: 'drain', version: versionDrain },
      ],
    };
    const outcome = await h.firewall.execute(multiIntent, crossSwap, { actionId: 'audit_ir6b' });
    expect(outcome.result!.conditional_execution).toBe('failed');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('healthy');
  });

  it('IR6c caller-declared dependency omissions are NOT detected (documented trust boundary, pinned)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    track(h.provider, 'deployment', 'undeclared-critical', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const partialIntent: ActionIntentInput = {
      agent_id: 'audit-agent',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionX }],
    };
    const outcome = await h.firewall.execute(
      partialIntent,
      conditionalExecutor(h.provider, { status: 'deployed' }),
      { actionId: 'audit_ir6c' },
    );
    // The firewall validates what is DECLARED; there is no independent
    // dependency resolver. The undeclared resource was never inspected:
    expect(outcome.executed).toBe(true);
    expect(
      await h.firewall.latestSnapshot({ source: 'memory', resource: 'deployment', resource_id: 'undeclared-critical' }),
    ).toBeNull();
  });
});

describe('INDEPENDENT: condition-failure semantics (brief §18)', () => {
  it('IR7a condition failure invalidates the authorization and records a fresh decision; no blind retry', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = conditionalExecutor(h.provider, { status: 'deployed-by-audit' }, {
      beforeCas: () => h.provider.mutate('deployment', 'prod', { status: 'moved' }, h.clock.nowIso()),
    });
    const first = await h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir7a' });
    expect(first.result!.conditional_execution).toBe('failed');
    expect(first.executed).toBe(false);

    const audit = await h.firewall.auditTail(100);
    const blocked = audit.filter(
      (r) => r.event_type === 'action.blocked' && r.payload['stage'] === 'condition_failed_revalidation',
    );
    expect(blocked.length).toBeGreaterThanOrEqual(1);

    const freshDecision = await h.firewall.latestDecision('audit_ir7a');
    expect(freshDecision).not.toBeNull();
    expect(freshDecision!.reason).toContain('conditional execution was rejected by the provider');

    await expect(h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir7a' }))
      .rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it('IR7b a NEW action id still fails the CAS against the moved state (no stale reuse)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = conditionalExecutor(h.provider, { status: 'deployed-by-audit' }, {
      beforeCas: () => h.provider.mutate('deployment', 'prod', { status: 'moved' }, h.clock.nowIso()),
    });
    await h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir7b_1' });

    // With a new action id the firewall re-validates from CURRENT state;
    // the claimed version X is stale, so the action is blocked before any
    // side effect (by staleness/precondition evaluation or by the CAS —
    // either path fails closed and nothing executes).
    const second = await h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir7b_2' });
    expect(second.executed).toBe(false);
    expect(second.result?.success ?? false).toBe(false);
    expect(
      h.provider.mutationLog('deployment', 'prod').filter((m) => m.changes['status'] === 'deployed-by-audit'),
    ).toHaveLength(0);
  });
});

describe('INDEPENDENT: failure-outcome classification (brief §19)', () => {
  function executorWith(behavior: () => Promise<ConditionalExecutionResult>): ActionExecutor {
    return {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      conditionalExecute: behavior,
      async execute() {
        return { success: true };
      },
    };
  }

  it('IR8a provider 412 -> condition_failed (distinct event; never recorded as executed)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;
    const outcome = await h.firewall.execute(
      intent(versionX),
      executorWith(() => Promise.resolve({ condition: 'failed', observed_version: 'v999' })),
      { actionId: 'audit_ir8a' },
    );
    expect(outcome.result!.conditional_execution).toBe('failed');
    expect(outcome.result!.success).toBe(false);
    const audit = await h.firewall.auditTail(50);
    expect(audit.some((r) => r.event_type === 'execution.condition_failed')).toBe(true);
    expect(audit.some((r) => r.event_type === 'action.executed' && r.payload['action_id'] === 'audit_ir8a')).toBe(false);
  });

  it('IR8b provider crash/500 -> failed with UNKNOWN condition outcome (never success, never condition_failed)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;
    const outcome = await h.firewall.execute(
      intent(versionX),
      executorWith(() => Promise.reject(new Error('HTTP 500 from provider'))),
      { actionId: 'audit_ir8b' },
    );
    expect(outcome.result!.success).toBe(false);
    // Operationalization milestone: faulted conditional operations are
    // recorded explicitly as 'unknown' (previously absent), never as success.
    expect(outcome.result!.conditional_execution).toBe('unknown');
    const audit = await h.firewall.auditTail(50);
    expect(audit.some((r) => r.event_type === 'execution.condition_failed' && r.payload['action_id'] === 'audit_ir8b')).toBe(false);
    expect(audit.some((r) => r.event_type === 'action.executed' && r.payload['action_id'] === 'audit_ir8b')).toBe(false);
    const failedEvent = audit.find((r) => r.event_type === 'action.failed' && r.payload['action_id'] === 'audit_ir8b');
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.payload['conditional_execution']).toBe('unknown');
    expect(failedEvent!.payload['retry_safety']).toBe('UNSAFE');
  });

  it('IR8c deadline exceeded mid-CAS -> honest failure with an explicit side-effect-unknown note', async () => {
    const h = await harness({
      config: {
        actions: [
          {
            name: 'deploy-production',
            match: { operation: 'deploy*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            on_unknown: 'deny',
            execution: { deadline: 30 },
          },
        ],
      },
    });
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;
    const outcome = await h.firewall.execute(
      intent(versionX),
      executorWith(() => new Promise((resolve) => setTimeout(() => resolve({ condition: 'satisfied', success: true }), 200))),
      { actionId: 'audit_ir8c' },
    );
    expect(outcome.result!.success).toBe(false);
    expect(outcome.result!.error).toContain('deadline');
    const audit = await h.firewall.auditTail(50);
    const failedEvent = audit.find((r) => r.event_type === 'action.failed' && r.payload['action_id'] === 'audit_ir8c');
    expect(String(failedEvent!.payload['note'])).toContain('may still have been performed');
  });
});

describe('INDEPENDENT: unknown-state safety + policy gate (brief §20/§21)', () => {
  async function unknownStateOutcome(risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', onUnknown: 'revalidate' | 'deny' | 'allow') {
    const h = await harness({
      config: {
        actions: [
          {
            name: `p-${risk}-${onUnknown}`,
            match: { operation: 'deploy*' },
            risk,
            freshness: { strategy: 'version' },
            on_unknown: onUnknown,
            execution: { deadline: '5s' },
          },
        ],
      },
    });
    // Resource never created: every provider fetch fails -> UNKNOWN.
    const outcome = await h.firewall.execute(
      intent('v-nonexistent'),
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
      { actionId: `audit_unknown_${risk}_${onUnknown}` },
    );
    await h.firewall.close();
    return outcome;
  }

  it('IR9 CRITICAL action on UNKNOWN state is never ALLOWED (hard safety floor)', async () => {
    const outcome = await unknownStateOutcome('CRITICAL', 'revalidate');
    expect(outcome.decision.decision).not.toBe('ALLOW');
    expect(outcome.executed).toBe(false);
  });

  it('IR9b all risk levels with default on_unknown=revalidate: unknown state never silently allows', async () => {
    for (const risk of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const) {
      const outcome = await unknownStateOutcome(risk, 'revalidate');
      expect(outcome.decision.decision).not.toBe('ALLOW');
      expect(outcome.executed).toBe(false);
    }
  });

  it('IR9c on_unknown=allow on a NAMED policy is rejected at configuration time (fail-closed default); only an explicit firewall-level acknowledgment can permit it', async () => {
    // The default posture: an explicit UNKNOWN->ALLOW on a named policy is a
    // configuration error. No dangerous default exists, and the unsafe option
    // is not silently accepted either.
    await expect(unknownStateOutcome('LOW', 'allow')).rejects.toThrow(/on_unknown: "allow" is not accepted/i);
  });

  it('IR10 require_conditional_execution + legacy executor -> DENY with an explicit capability reason', async () => {
    const h = await harness({
      config: {
        actions: [
          {
            name: 'deploy-production',
            match: { operation: 'deploy*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            execution: { deadline: '5s', require_conditional_execution: true },
          },
        ],
      },
    });
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;
    const outcome = await h.firewall.execute(
      intent(versionX),
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
      { actionId: 'audit_ir10' },
    );
    expect(outcome.decision.decision).toBe('DENY');
    expect(outcome.decision.reason).toContain('conditional_supported');
    const audit = await h.firewall.auditTail(50);
    const blocked = audit.find((r) => r.event_type === 'action.blocked' && r.payload['action_id'] === 'audit_ir10');
    expect(blocked!.payload['stage']).toBe('conditional_execution_unavailable');
  });

  it('IR10b contradictory policy (require + on_conditional_unavailable: allow) is rejected at configuration time', async () => {
    await expect(
      harness({
        config: {
          actions: [
            {
              name: 'bad-policy',
              match: { operation: 'deploy*' },
              risk: 'LOW',
              freshness: { strategy: 'version' },
              execution: { require_conditional_execution: true, on_conditional_unavailable: 'allow' },
            },
          ],
        },
      }),
    ).rejects.toThrow(/contradict/i);
  });
});

describe('INDEPENDENT: executor trust boundary (brief §23) — what the firewall can and cannot see', () => {
  it('IR11a an executor that reports satisfied without enforcing is recorded as a normal success (documented trust assumption, kept visible)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const liar: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute() {
        return { condition: 'satisfied', success: true, output: { note: 'nothing enforced' } };
      },
      async execute() {
        return { success: true };
      },
    };
    const outcome = await h.firewall.execute(intent(versionX), liar, { actionId: 'audit_ir11a' });
    expect(outcome.executed).toBe(true);
    expect(outcome.result!.atomicity).toBe('guaranteed'); // recorded per the executor's report

    const audit = await h.firewall.auditTail(50);
    const exec = audit.find((r) => r.event_type === 'action.executed' && r.payload['action_id'] === 'audit_ir11a');
    expect(exec).toBeDefined();
    expect(exec!.payload['conditional_execution']).toBe('satisfied');
    // Nothing happened at the provider: the firewall relied entirely on the
    // executor's word. This is the documented executor trust boundary.
    expect(h.provider.mutationLog('deployment', 'prod')).toHaveLength(0);
  });

  it('IR11b an executor without conditional capability takes the legacy path; record says not_guaranteed', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const dropper: ActionExecutor = {
      idempotency: 'non_idempotent',
      async execute() {
        h.provider.mutate('deployment', 'prod', { status: 'deployed' }, h.clock.nowIso());
        return { success: true };
      },
    };
    const outcome = await h.firewall.execute(intent(versionX), dropper, { actionId: 'audit_ir11b' });
    expect(outcome.executed).toBe(true);
    expect(outcome.result!.atomicity).toBe('not_guaranteed');
    expect(outcome.result!.conditional_execution).toBe('not_attempted');
  });

  it('IR11c declared-support + unavailable fails closed even though the executor could have run unconditionally', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;
    const refused: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute() {
        return { condition: 'unavailable', error: 'cannot enforce' };
      },
      async execute() {
        h.provider.mutate('deployment', 'prod', { status: 'deployed' }, h.clock.nowIso());
        return { success: true };
      },
    };
    const outcome = await h.firewall.execute(intent(versionX), refused, { actionId: 'audit_ir11c' });
    expect(outcome.executed).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('unavailable');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('healthy');
  });
});

describe('INDEPENDENT: replay x conditional execution combo (brief §17)', () => {
  it('IR12 two concurrent callers on ONE action id with conditional execution: one claim, at most one execution', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    const executor = conditionalExecutor(h.provider, { status: 'deployed' });
    const settled = await Promise.allSettled([
      h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir12' }),
      h.firewall.execute(intent(versionX), executor, { actionId: 'audit_ir12' }),
    ]);
    const rejected = settled.filter((s) => s.status === 'rejected');
    const fulfilled = settled.filter((s) => s.status === 'fulfilled') as Array<
      PromiseFulfilledResult<{ executed: boolean; result: { conditional_execution?: string; success: boolean } | null }>
    >;
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ReplayDetectedError);
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.result!.conditional_execution).toBe('satisfied');
    expect(h.provider.mutationLog('deployment', 'prod')).toHaveLength(1);
  });
});
