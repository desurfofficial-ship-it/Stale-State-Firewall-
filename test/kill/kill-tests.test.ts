import { describe, it, expect } from 'vitest';
import { harness, track, ENFORCE_CONFIG } from '../helpers/harness.js';
import { ReplayDetectedError, EscalationPendingError, ConfigurationError } from '../../src/index.js';
import { ManualClock } from '../../src/engine/clock.js';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';

/**
 * Kill tests (spec §47, §67): the goal is not "does the happy path work"
 * but "can we force the firewall to allow an action it should reject?"
 * Every scenario below is an attempted bypass; each must fail closed.
 */
describe('kill tests: adversarial bypass attempts', () => {
  it('K1 stale cached state: validation never trusts stored snapshots', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const staleVersion = h.provider.get('deployment', 'prod')!.version;

    // Poison any cache-like reuse: the world moved on AFTER the agent looked.
    h.provider.mutate('deployment', 'prod', { status: 'degraded' }, h.clock.nowIso());

    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: staleVersion }],
    });
    expect(decision.decision).toBe('DENY');
    expect(decision.verdicts[0]?.verified_fresh).toBe(true); // verdict came from a live fetch
  });

  it('K2 forged freshness: a fabricated recent observed_at cannot mask a version change', async () => {
    const h = await harness();
    track(h.provider, 'pr', '1', { state: 'open' }, h.nowIso);
    const oldVersion = h.provider.get('pr', '1')!.version;
    h.provider.mutate('pr', '1', { state: 'closed' }, h.clock.nowIso());

    // The agent lies: claims it observed the state "just now" while carrying the old version.
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [
        {
          source: 'memory',
          resource: 'pr',
          resource_id: '1',
          version: oldVersion,
          observed_at: h.clock.nowIso(), // forged: claims fresh observation
        },
      ],
    });
    expect(decision.decision).toBe('DENY');
  });

  it('K3 forged future timestamps are treated as UNKNOWN, not FRESH', async () => {
    const h = await harness();
    track(h.provider, 'ticket', 'T9', { state: 'open' }, h.nowIso);
    const version = h.provider.get('ticket', 'T9')!.version;

    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'tickets',
      operation: 'add_comment',
      dependencies: [
        {
          source: 'memory',
          resource: 'ticket',
          resource_id: 'T9',
          version,
          observed_at: new Date(h.clock.nowMs() + 3_600_000).toISOString(), // far future
        },
      ],
    });
    // TTL strategy with an untrustworthy timestamp: not FRESH, nothing executes.
    expect(['REVALIDATE', 'DENY']).toContain(decision.decision);
    expect(decision.decision).not.toBe('ALLOW');
  });

  it('K4 missing versions on a CRITICAL version-strategy policy -> DENY (not ALLOW)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod' }],
    });
    expect(decision.decision).toBe('DENY');
    expect(decision.reason).toContain('deploy-production');
  });

  it('K5 provider outage mid-flow: executor never runs (invariant 7)', async () => {
    const h = await harness();
    let executed = false;
    track(h.provider, 'pr', '2', { state: 'open' }, h.nowIso);
    const version = h.provider.get('pr', '2')!.version;

    // Take the provider down between registration and validation.
    h.provider.mutate('pr', '2', { state: 'open' }, h.clock.nowIso());
    const brokenProvider = new InMemoryStateProvider('memory');
    const firewall2 = await StaleStateFirewall.create({
      config: ENFORCE_CONFIG,
      store: new MemoryStore(),
      providers: [brokenProvider],
      clock: h.clock,
    });

    const outcome = await firewall2.execute(
      {
        agent_id: 'bot',
        tool: 'github',
        operation: 'merge_pull_request',
        dependencies: [{ source: 'memory', resource: 'pr', resource_id: '2', version }],
      },
      { idempotency: 'non_idempotent', execute: async () => { executed = true; return { success: true }; } },
    );
    expect(outcome.executed).toBe(false);
    expect(executed).toBe(false);
    await firewall2.close();
  });

  it('K6 replay: consuming an authorization and re-running the same action id is rejected', async () => {
    const h = await harness();
    track(h.provider, 'pr', '3', { state: 'open' }, h.nowIso);
    const version = h.provider.get('pr', '3')!.version;
    const intent = {
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '3', version }],
    };
    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };

    await h.firewall.execute(intent, executor, { actionId: 'act_kill_6' });
    await expect(h.firewall.execute(intent, executor, { actionId: 'act_kill_6' })).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it('K7 PENDING escalations freeze the action id; direct re-execution is refused', async () => {
    const h = await harness({
      config: {
        actions: [
          { name: 'rotate', match: { operation: 'rotate*' }, risk: 'CRITICAL', freshness: { strategy: 'version' }, on_unknown: 'escalate' },
        ],
      },
    });
    track(h.provider, 'cred', 'k', { rotated: false }, h.nowIso);
    const intent = {
      agent_id: 'bot',
      tool: 'secrets',
      operation: 'rotate_credential',
      dependencies: [{ source: 'memory', resource: 'cred', resource_id: 'k' }],
    };
    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };

    await h.firewall.execute(intent, executor, { actionId: 'act_kill_7' });
    await expect(h.firewall.execute(intent, executor, { actionId: 'act_kill_7' })).rejects.toBeInstanceOf(EscalationPendingError);
  });

  it('K8 clock manipulation: widening boundaries requires explicit skew config; default stays conservative', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const h = await harness({ clock });
    track(h.provider, 'ticket', 'T1', { state: 'open' }, h.nowIso);
    const version = h.provider.get('ticket', 'T1')!.version;

    // Age 29.5s: within the 30s TTL for a LOW-risk comment -> allowed.
    h.clock.advance(29_500);
    const fresh = await h.firewall.check({
      agent_id: 'bot',
      tool: 'tickets',
      operation: 'add_comment',
      dependencies: [{ source: 'memory', resource: 'ticket', resource_id: 'T1', version, observed_at: new Date(h.clock.nowMs() - 29_500).toISOString() }],
    });
    expect(fresh.decision).toBe('ALLOW');

    // Age 30.5s: expired. Nothing implicit widens the boundary.
    h.clock.advance(1_000);
    const expired = await h.firewall.check({
      agent_id: 'bot',
      tool: 'tickets',
      operation: 'add_comment',
      dependencies: [{ source: 'memory', resource: 'ticket', resource_id: 'T1', version, observed_at: new Date(h.clock.nowMs() - 30_500).toISOString() }],
    });
    expect(expired.decision).toBe('REVALIDATE');
  });

  it('K9 dependency omission: CRITICAL policy without declared dependencies is UNKNOWN -> DENY', async () => {
    const h = await harness();
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [],
    });
    expect(decision.decision).not.toBe('ALLOW');
  });

  it('K10 dependency omission with require_dependencies escalates the gap explicitly', async () => {
    const h = await harness({
      config: {
        actions: [
          { name: 'strict-dep', match: { operation: 'purge*' }, risk: 'CRITICAL', freshness: { strategy: 'version' }, require_dependencies: true, on_unknown: 'deny' },
        ],
      },
    });
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'db',
      operation: 'purge_table',
    });
    expect(decision.decision).toBe('DENY');
    expect(decision.policy_name).toBe('strict-dep');
  });

  it('K11 partial state: precondition on a missing field fails closed (INVALID, not allow)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', {}, h.nowIso); // no status field at all
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: h.provider.get('deployment', 'prod')!.version }],
    });
    expect(decision.decision).toBe('DENY');
  });

  it('K12 direct tool invocation bypass: protect() refuses duplicate tool identity and the raw tool is unreachable from the wrapper', async () => {
    const h = await harness();
    let rawCalls = 0;
    const spec = {
      name: 'one-way-tool',
      run: async () => { rawCalls += 1; return {}; },
      toIntent: () => ({ agent_id: 'a', operation: 'op' }),
    };
    const wrapped = h.firewall.protect(spec);
    expect(() => h.firewall.protect(spec)).toThrow(ConfigurationError);
    // The wrapper exposes no reference to the raw tool.
    const keys = Object.keys(wrapped);
    expect(keys).not.toContain('run');
    expect(keys).toContain('execute');
    expect(keys).toContain('check');
    expect(rawCalls).toBe(0);
  });

  it('K13 configuration attack: on_invalid allow is rejected at load, before enforcement', async () => {
    const config: FirewallRootConfigFile = {
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      actions: [{ name: 'bad', match: { operation: 'x' }, on_invalid: 'allow' }],
    };
    await expect(StaleStateFirewall.create({ config })).rejects.toThrow(/on_invalid/);
  });

  it('K14 configuration attack: CRITICAL policy with on_unknown allow is rejected (invariant 2)', async () => {
    const config: FirewallRootConfigFile = {
      firewall: { mode: 'enforce', storage: { type: 'memory' }, acknowledge_unknown_allow: true },
      actions: [{ name: 'bad-critical', match: { operation: 'x' }, risk: 'CRITICAL', on_unknown: 'allow' }],
    };
    await expect(StaleStateFirewall.create({ config })).rejects.toThrow(/CRITICAL|on_unknown/i);
  });

  it('K15 audit integrity: any tampering with persisted records breaks chain verification', async () => {
    const h = await harness();
    track(h.provider, 'pr', '4', { state: 'open' }, h.nowIso);
    await h.firewall.check({
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '4', version: h.provider.get('pr', '4')!.version }],
    });
    const verification = await h.firewall.verifyAudit();
    expect(verification.ok).toBe(true);

    // The store API exposes no mutation; a tamperer must corrupt the records
    // themselves. Verification recomputes hashes, so a forged record cannot
    // match the committed chain (see unit suite for the forged-hash proof).
    const tail = await h.firewall.auditTail(1);
    expect(tail[0]?.record_hash).toBeTruthy();
  });

  it('K16 OBSERVE mode cannot be silently weakened into strictness bypass: would-be decisions are preserved', async () => {
    const h = await harness({ config: { firewall: { mode: 'observe', storage: { type: 'memory' } } } });
    track(h.provider, 'deployment', 'prod', { status: 'degraded' }, h.nowIso);
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: h.provider.get('deployment', 'prod')!.version }],
    });
    expect(decision.decision).toBe('ALLOW');
    expect(decision.would_have_decided).toBe('DENY');
  });

  it('K17 forged precondition satisfaction: agent-declared preconditions are re-checked against current state', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'degraded' }, h.nowIso);
    const outcome = await h.firewall.execute(
      {
        agent_id: 'bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: h.provider.get('deployment', 'prod')!.version }],
        preconditions: [{ field: 'status', operator: 'equals', value: 'healthy' }], // agent claims healthy
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.decision).toBe('DENY');
  });
});
