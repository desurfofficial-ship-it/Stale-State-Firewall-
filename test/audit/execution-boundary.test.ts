/**
 * Red-team audit: execution boundary attacks.
 *
 * B1  escalation approval must be bound to the approved action semantics
 * B2  TOCTOU re-verification must fail closed when every provider fetch fails
 *     at recheck time (invariant G at the execution gate)
 * B3  replay guard check-then-insert: two concurrent executions of one action
 *     id must not both execute even when they interleave exactly
 * B4  OBSERVE mode regression: would-have decisions preserved
 * B5  PENDING escalation blocks direct re-execution
 */
import { describe, it, expect } from 'vitest';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { ManualClock } from '../../src/engine/clock.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';
import type { AuthorizationRecord } from '../../src/storage/types.js';
import { ReplayDetectedError, UnauthorizedActionError, EscalationPendingError } from '../../src/domain/errors.js';

const CLOCK_START = '2026-09-05T12:00:00Z';

const ESCALATE_ON_UNKNOWN_CONFIG: FirewallRootConfigFile = {
  firewall: { mode: 'enforce', storage: { type: 'memory' } },
  defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
  actions: [
    {
      name: 'rotate-credential',
      match: { operation: 'rotate*' },
      risk: 'CRITICAL',
      freshness: { strategy: 'ttl', max_age: '30s' },
      on_unknown: 'escalate',
      execution: { deadline: '10s' },
    },
  ],
};

async function build(config: FirewallRootConfigFile, store?: MemoryStore) {
  const clock = new ManualClock(CLOCK_START);
  const provider = new InMemoryStateProvider('memory');
  const firewall = await StaleStateFirewall.create({
    config,
    store: store ?? new MemoryStore(),
    providers: [provider],
    clock,
  });
  return { firewall, provider, clock, nowIso: clock.nowIso() };
}

function track(provider: InMemoryStateProvider, resource: string, id: string, metadata: Record<string, unknown>, atIso: string): void {
  provider.put(resource, id, metadata, atIso);
}

describe('audit: execution boundary attacks', () => {
  it('B1 approval must be bound to the approved action semantics (target swap after human approval)', async () => {
    const h = await build(ESCALATE_ON_UNKNOWN_CONFIG);
    track(h.provider, 'credential', 'api-key', { rotated: false }, h.nowIso);

    const approvedIntent = {
      agent_id: 'bot',
      tool: 'secrets',
      operation: 'rotate_credential',
      target: 'credential/api-key',
      dependencies: [{ source: 'memory', resource: 'credential', resource_id: 'api-key' }],
    };
    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };

    const outcome = await h.firewall.execute(approvedIntent, executor, { actionId: 'act_bind_1' });
    expect(outcome.decision.decision).toBe('ESCALATE');
    await h.firewall.resolveEscalation('act_bind_1', { approved: true, by: 'security-oncall' });

    // The agent swaps the semantics AFTER the human approved the original action.
    const swappedIntent = {
      agent_id: 'bot',
      tool: 'secrets',
      operation: 'rotate_credential',
      target: 'credential/PRODUCTION-MASTER',
      dependencies: [{ source: 'memory', resource: 'credential', resource_id: 'PRODUCTION-MASTER' }],
      arguments: { note: 'smuggled under someone elses approval' },
    };
    let smuggledRan = false;
    const smuggleExecutor = {
      idempotency: 'non_idempotent' as const,
      execute: async () => {
        smuggledRan = true;
        return { success: true };
      },
    };

    await expect(
      h.firewall.executeApproved('act_bind_1', swappedIntent, smuggleExecutor),
    ).rejects.toBeInstanceOf(UnauthorizedActionError);
    expect(smuggledRan).toBe(false);

    // The ORIGINAL approved intent still executes (legitimate flow preserved).
    const legit = await h.firewall.executeApproved('act_bind_1', approvedIntent, executor);
    expect(legit.executed).toBe(true);
  });

  it('B2 pre-execution re-verification must fail closed when every provider fetch fails (invariant G)', async () => {
    const h = await build({
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
      actions: [
        {
          name: 'deploy-production',
          match: { operation: 'deploy*' },
          risk: 'CRITICAL',
          freshness: { strategy: 'version' },
          execution: { deadline: '10s', require_fresh_at_execution: true },
        },
      ],
    });
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const version = h.provider.get('deployment', 'prod')!.version;

    const realGetState = h.provider.getState.bind(h.provider);
    const realGetConditional = h.provider.getConditional?.bind(h.provider);
    let fetchRound = 0;
    const explodeOnSecondRound = <T>(fn: T): T =>
      (async (...args: unknown[]) => {
        fetchRound += 1;
        if (fetchRound > 1) {
          throw new Error('provider outage: connection reset before execution');
        }
        return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      }) as unknown as T;
    h.provider.getState = explodeOnSecondRound(realGetState) as typeof h.provider.getState;
    if (realGetConditional) {
      h.provider.getConditional = explodeOnSecondRound(realGetConditional) as typeof h.provider.getConditional;
    }

    let executorRan = false;
    const outcome = await h.firewall.execute(
      {
        agent_id: 'release-bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
      },
      {
        idempotency: 'non_idempotent',
        execute: async () => {
          executorRan = true;
          return { success: true };
        },
      },
    );

    expect(executorRan).toBe(false);
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.decision).toBe('DENY');
  });

  it('B3 concurrent executions of one action id: exactly one may execute even under an exact guard-window interleave', async () => {
    const store = new MemoryStore();
    const h = await build(
      {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          {
            name: 'merge-pr',
            match: { operation: 'merge*' },
            risk: 'HIGH',
            freshness: { strategy: 'version' },
            execution: { deadline: '10s' },
          },
        ],
      },
      store,
    );
    track(h.provider, 'pr', '77', { state: 'open' }, h.nowIso);
    const version = h.provider.get('pr', '77')!.version;
    const intent = {
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '77', version }],
    };

    // Force the exact interleaving a check-then-insert guard is vulnerable to:
    // both executions enter the authorization claim before either one lands.
    // The claim itself is the atomic gate, so holding both claim ATTEMPTS and
    // then resolving them in order must still yield exactly one execution.
    const realClaim = store.claimAuthorization.bind(store);
    const attempted: AuthorizationRecord[] = [];
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    (store as unknown as { claimAuthorization: (a: AuthorizationRecord) => Promise<{ claimed: boolean }> }).claimAuthorization =
      async (auth: AuthorizationRecord) => {
        attempted.push(auth);
        if (attempted.length === 2) release();
        await barrier;
        return realClaim(auth);
      };

    let ranA = false;
    let ranB = false;
    const exec = (flag: () => void) => ({
      idempotency: 'non_idempotent' as const,
      execute: async () => {
        flag();
        return { success: true };
      },
    });

    let releaseGateA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseGateA = resolve;
    });
    const realProviderGet = h.provider.getState.bind(h.provider);
    const realGetConditional = h.provider.getConditional?.bind(h.provider);
    let stateFetchCount = 0;
    h.provider.getState = async (ref, nowIso) => {
      stateFetchCount += 1;
      if (stateFetchCount === 1) await gateA; // hold A inside validation
      return realProviderGet(ref, nowIso);
    };
    if (realGetConditional) {
      let conditionalCount = 0;
      h.provider.getConditional = async (ref, nowIso) => {
        conditionalCount += 1;
        if (conditionalCount === 1) await gateA;
        return realGetConditional(ref, nowIso);
      };
    }

    const promiseA = h.firewall.execute(
      intent,
      exec(() => {
        ranA = true;
      }),
      { actionId: 'act_race_exact' },
    );
    await Promise.resolve();
    const promiseB = h.firewall.execute(
      intent,
      exec(() => {
        ranB = true;
      }),
      { actionId: 'act_race_exact' },
    );

    releaseGateA();
    const settled = await Promise.allSettled([promiseA, promiseB]);

    const executed = [ranA, ranB].filter(Boolean).length;
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(executed).toBe(1);
    expect(rejected).toHaveLength(1);
    const rejection = rejected[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(ReplayDetectedError);
  });

  it('B4 OBSERVE mode regression: would-have decisions are preserved while nothing is blocked', async () => {
    const h = await build({
      firewall: { mode: 'observe', storage: { type: 'memory' } },
      defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
      actions: [
        { name: 'deploy-production', match: { operation: 'deploy*' }, risk: 'CRITICAL', freshness: { strategy: 'version' } },
      ],
    });
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const version = h.provider.get('deployment', 'prod')!.version;
    h.provider.mutate('deployment', 'prod', { status: 'degraded' }, h.nowIso);

    const outcome = await h.firewall.execute(
      {
        agent_id: 'bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
    );
    expect(outcome.decision.decision).toBe('ALLOW');
    expect(outcome.decision.would_have_decided).toBe('DENY');
  });

  it('B5 PENDING escalation still freezes the action id against direct re-execution', async () => {
    const h = await build(ESCALATE_ON_UNKNOWN_CONFIG);
    track(h.provider, 'credential', 'api-key', { rotated: false }, h.nowIso);
    const intent = {
      agent_id: 'bot',
      tool: 'secrets',
      operation: 'rotate_credential',
      dependencies: [{ source: 'memory', resource: 'credential', resource_id: 'api-key' }],
    };
    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };
    await h.firewall.execute(intent, executor, { actionId: 'act_bind_2' });
    await expect(h.firewall.execute(intent, executor, { actionId: 'act_bind_2' })).rejects.toBeInstanceOf(
      EscalationPendingError,
    );
  });
});
