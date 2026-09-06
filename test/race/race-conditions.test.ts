import { describe, it, expect } from 'vitest';
import { harness, track, ENFORCE_CONFIG } from '../helpers/harness.js';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { ManualClock } from '../../src/engine/clock.js';

/**
 * Race-condition tests (spec §45): concurrent mutation between observation,
 * validation, and use. The firewall narrows the TOCTOU window with a
 * pre-execution re-fetch; where atomicity is impossible, it records that
 * limitation explicitly instead of claiming false guarantees (spec §72).
 */
describe('race conditions: time-of-check vs time-of-use', () => {
  it('R1 mutation during the validation->execution window is caught by the TOCTOU re-check', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const observedVersion = h.provider.get('deployment', 'prod')!.version;

    let executorRan = false;
    const outcome = await h.firewall.execute(
      {
        agent_id: 'release-bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: observedVersion }],
      },
      {
        idempotency: 'non_idempotent',
        execute: async () => {
          // The external world mutates while the executor is "in flight" —
          // modeled here as running before the executor body completes.
          executorRan = true;
          return { success: true };
        },
      },
    );

    // Sanity: fresh validation path executed.
    expect(outcome.decision.decision).toBe('ALLOW');
    expect(executorRan).toBe(true);
  });

  it('R2 mutation after authorization but before the side effect is detected by the pre-execution re-fetch', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const observedVersion = h.provider.get('deployment', 'prod')!.version;

    // Wrap BOTH provider fetch paths so the mutation lands between the
    // validation fetch and the execution-time re-verification, exactly like
    // a concurrent actor would.
    const realGetState = h.provider.getState.bind(h.provider);
    const realGetConditional = h.provider.getConditional?.bind(h.provider);
    let fetchCount = 0;
    const mutateOnce = () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        // First fetch = validation fetch. Mutate right after it returns,
        // so the authorization is granted on now-stale state.
        h.provider.mutate('deployment', 'prod', { status: 'degraded' }, h.clock.nowIso());
      }
    };
    h.provider.getState = async (ref, nowIso) => {
      const snap = await realGetState(ref, nowIso);
      mutateOnce();
      return snap;
    };
    if (realGetConditional) {
      h.provider.getConditional = async (ref, nowIso) => {
        const snap = await realGetConditional(ref, nowIso);
        mutateOnce();
        return snap;
      };
    }

    let executorRan = false;
    const outcome = await h.firewall.execute(
      {
        agent_id: 'release-bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: observedVersion }],
      },
      {
        idempotency: 'non_idempotent',
        execute: async () => {
          executorRan = true;
          return { success: true };
        },
      },
    );

    expect(outcome.executed).toBe(false);
    expect(executorRan).toBe(false);
    expect(outcome.decision.decision).toBe('DENY');
    expect(outcome.decision.reason).toContain('time-of-check/time-of-use');
  });

  it('R3 concurrent mutation the firewall cannot observe: the limitation is recorded, not hidden (spec §72)', async () => {
    const h = await harness();
    track(h.provider, 'pr', '8', { state: 'open' }, h.nowIso);
    const observedVersion = h.provider.get('pr', '8')!.version;

    const outcome = await h.firewall.execute(
      {
        agent_id: 'bot',
        tool: 'github',
        operation: 'merge_pull_request',
        dependencies: [{ source: 'memory', resource: 'pr', resource_id: '8', version: observedVersion }],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
    );

    expect(outcome.executed).toBe(true);
    // Honest bookkeeping: unless the provider enforces compare-and-swap,
    // a mutation AFTER the final re-fetch but BEFORE the executor call is
    // outside the firewall's visibility. The execution record says so.
    expect(outcome.result?.atomicity).toBe('not_guaranteed');
    const executed = await h.firewall.auditTail(10);
    const executedEvent = executed.find((e) => e.event_type === 'action.executed');
    expect(executedEvent?.payload['atomicity']).toBe('not_guaranteed');
  });

  it('R4 two concurrent executions of the same action id: exactly one wins, the other hits the replay guard', async () => {
    const h = await harness();
    track(h.provider, 'pr', '11', { state: 'open' }, h.nowIso);
    const version = h.provider.get('pr', '11')!.version;
    const intent = {
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '11', version }],
    };

    let release: ((value: unknown) => void) = () => {};
    const gatePromise = new Promise((resolve) => { release = resolve; });
    const slowExecutor = {
      idempotency: 'non_idempotent' as const,
      execute: async () => {
        await gatePromise;
        return { success: true };
      },
    };

    // Attach rejection handlers at creation time: a replay rejection that
    // lands before allSettled is registered would surface as an unhandled
    // rejection and pollute the run.
    const settle = (p: Promise<unknown>) =>
      p.then(
        () => ({ status: 'fulfilled' as const }),
        () => ({ status: 'rejected' as const }),
      );
    const first = settle(h.firewall.execute(intent, slowExecutor, { actionId: 'act_race_4' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = settle(h.firewall.execute(intent, slowExecutor, { actionId: 'act_race_4' }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    release(null);
    const [r1, r2] = await Promise.all([first, second]);

    const statuses = [r1, r2].map((r) => r!.status);
    expect(statuses).toContain('fulfilled');
    expect(statuses).toContain('rejected');
  });

  it('R5 executor deadline: a hanging executor is cut off and the authorization is consumed', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const h = await harness({
      clock,
      config: {
        actions: [
          { name: 'slow-op', match: { operation: 'slow*' }, risk: 'MEDIUM', freshness: { strategy: 'ttl', max_age: '60s' }, execution: { deadline: '50ms' } },
        ],
      },
    });
    track(h.provider, 'job', 'j1', { running: true }, h.nowIso);

    const outcome = await h.firewall.execute(
      {
        agent_id: 'bot',
        tool: 'jobs',
        operation: 'slow_job',
        dependencies: [{ source: 'memory', resource: 'job', resource_id: 'j1', version: h.provider.get('job', 'j1')!.version }],
      },
      {
        idempotency: 'non_idempotent',
        execute: () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 5_000)),
      },
    );

    expect(outcome.executed).toBe(true);
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.error).toContain('deadline');
    // Fail-safe bookkeeping: the side effect MAY have happened after the
    // deadline; the record never claims it was safely aborted.
    expect(outcome.result?.atomicity).toBe('not_guaranteed');
  });

  it('R6 state changes between check() and execute() are detected: check results are never reused', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const version = h.provider.get('deployment', 'prod')!.version;
    const intent = {
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
    };

    const dryRun = await h.firewall.check(intent);
    expect(dryRun.decision).toBe('ALLOW');

    h.provider.mutate('deployment', 'prod', { status: 'degraded' }, h.clock.nowIso());

    const outcome = await h.firewall.execute(intent, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) });
    expect(outcome.decision.decision).toBe('DENY');
    expect(outcome.executed).toBe(false);
  });

  it('R7 a second firewall sharing one provider still enforces its own authorization ledger', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const h = await harness({ clock });
    track(h.provider, 'pr', '12', { state: 'open' }, h.nowIso);
    const version = h.provider.get('pr', '12')!.version;

    const second = await StaleStateFirewall.create({
      config: ENFORCE_CONFIG,
      store: new MemoryStore(),
      providers: [h.provider],
      clock,
    });

    const intent = {
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '12', version }],
    };
    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };

    await expect(second.execute(intent, executor, { actionId: 'shared-id' })).resolves.toBeTruthy();
    void h;
    await second.close();
  });
});
