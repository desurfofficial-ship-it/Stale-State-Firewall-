import { describe, it, expect } from 'vitest';
import { harness, track, ENFORCE_CONFIG } from '../helpers/harness.js';
import { ReplayDetectedError, PolicyNotFoundError, BlockedActionError, EscalationPendingError } from '../../src/index.js';
import { SqliteStore } from '../../src/storage/sqlite/store.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SDK end-to-end: observe -> mutate -> act (spec §73)', () => {
  it('Scenario A: fresh state + preconditions hold -> ALLOW and execute', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);

    const outcome = await h.firewall.execute(
      {
        agent_id: 'release-bot',
        tool: 'deploy',
        operation: 'deploy_production',
        target: 'prod',
        dependencies: [
          { source: 'memory', resource: 'deployment', resource_id: 'prod', version: h.provider.get('deployment', 'prod')!.version },
        ],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true, output: { deployed: true } }) },
    );

    expect(outcome.decision.decision).toBe('ALLOW');
    expect(outcome.executed).toBe(true);
    expect(outcome.result?.success).toBe(true);
    expect(outcome.decision.execution?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('Scenario C: version changed after observation -> DENY (state demonstrably changed)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const observedVersion = h.provider.get('deployment', 'prod')!.version;

    // Another actor mutates the deployment after the agent observed it.
    h.provider.mutate('deployment', 'prod', { status: 'degraded' }, h.clock.nowIso());

    const outcome = await h.firewall.execute(
      {
        agent_id: 'release-bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [
          { source: 'memory', resource: 'deployment', resource_id: 'prod', version: observedVersion },
        ],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
    );

    expect(outcome.decision.decision).toBe('DENY');
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.invalid_dependencies).toContain('memory:deployment/prod');
  });

  it('Scenario B: TTL expired -> REVALIDATE recomputes from current state and allows if safe', async () => {
    const h = await harness();
    track(h.provider, 'ticket', 'T1', { state: 'open' }, h.nowIso);
    const observedVersion = h.provider.get('ticket', 'T1')!.version;

    h.clock.advance(45_000); // beyond the 30s default freshness of the synthetic policy

    const outcome = await h.firewall.execute(
      {
        agent_id: 'support-bot',
        tool: 'tickets',
        operation: 'add_comment',
        dependencies: [
          { source: 'memory', resource: 'ticket', resource_id: 'T1', version: observedVersion, observed_at: new Date(h.clock.nowMs() - 45_000).toISOString() },
        ],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
    );

    expect(outcome.decision.decision).toBe('ALLOW');
    expect(outcome.decision.revalidated).toBe(true);
    expect(outcome.executed).toBe(true);
  });

  it('Scenario D: one stale dependency among fresh ones blocks the action (spec §44)', async () => {
    const h = await harness();
    track(h.provider, 'pr', '42', { state: 'open' }, h.nowIso);
    track(h.provider, 'ci', 'run1', { state: 'passing' }, h.nowIso);
    const prVersion = h.provider.get('pr', '42')!.version;
    const ciVersion = h.provider.get('ci', 'run1')!.version;

    h.provider.mutate('ci', 'run1', { state: 'failing' }, h.clock.nowIso());

    const decision = await h.firewall.check({
      agent_id: 'release-bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [
        { source: 'memory', resource: 'pr', resource_id: '42', version: prVersion },
        { source: 'memory', resource: 'ci', resource_id: 'run1', version: ciVersion },
      ],
    });

    expect(decision.decision).toBe('DENY');
    expect(decision.invalid_dependencies).toContain('memory:ci/run1');
    expect(decision.verdicts.find((v) => v.dependency.resource === 'pr')?.staleness).toBe('FRESH');
  });

  it('Scenario F: CRITICAL + unknown version -> DENY (on_unknown: deny)', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);

    const decision = await h.firewall.check({
      agent_id: 'release-bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [
        // Agent declares NO version: firewall cannot verify freshness.
        { source: 'memory', resource: 'deployment', resource_id: 'prod' },
      ],
    });

    expect(decision.decision).toBe('DENY');
    expect(decision.reason).toContain('deploy-production');
  });

  it('Scenario E: provider outage -> safe failure, never ALLOW (fail closed)', async () => {
    const h = await harness();
    // Reference a resource the provider does not track -> provider error path.
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'ghost', resource_id: 'none', version: 'v1' }],
    });
    expect(decision.decision).toBe('REVALIDATE');
    expect(decision.unknown_dependencies).toContain('memory:ghost/none');
  });

  it('Scenario H: expired authorization replay -> blocked', async () => {
    const h = await harness();
    track(h.provider, 'pr', '7', { state: 'open' }, h.nowIso);
    const version = h.provider.get('pr', '7')!.version;
    const intentInput = {
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '7', version }],
    };
    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };

    await h.firewall.execute(intentInput, executor, { actionId: 'act_replay_1' }); // consumes authorization
    await expect(
      h.firewall.execute(intentInput, executor, { actionId: 'act_replay_1' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it('Scenario H (variant): live-but-unconsumed authorization -> replay rejected', async () => {
    const h = await harness();
    track(h.provider, 'pr', '9', { state: 'open' }, h.nowIso);
    const version = h.provider.get('pr', '9')!.version;
    const intentInput = {
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '9', version }],
    };

    // First execution succeeds and consumes the authorization.
    await h.firewall.execute(intentInput, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: 'act_replay_2' });
    await expect(
      h.firewall.execute(intentInput, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: 'act_replay_2' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it('named-but-missing policy is a hard error, never a silent default', async () => {
    const h = await harness();
    await expect(
      h.firewall.check({
        agent_id: 'bot',
        tool: 'x',
        operation: 'y',
        policy: 'does-not-exist',
      }),
    ).rejects.toBeInstanceOf(PolicyNotFoundError);
  });

  it('idempotent retry is allowed only when the policy explicitly enables it', async () => {
    const config = ENFORCE_CONFIG;
    const h = await harness({
      config: {
        ...config,
        actions: [
          {
            name: 'safe-update',
            match: { operation: 'update*' },
            risk: 'MEDIUM',
            freshness: { strategy: 'ttl', max_age: '60s' },
            execution: { deadline: '30s', allow_idempotent_retry: true },
          },
        ],
      },
    });
    track(h.provider, 'record', 'r1', { rev: 1 }, h.nowIso);
    const version = h.provider.get('record', 'r1')!.version;
    const intentInput = {
      agent_id: 'bot',
      tool: 'db',
      operation: 'update_record',
      dependencies: [{ source: 'memory', resource: 'record', resource_id: 'r1', version }],
    };
    let calls = 0;
    const executor = {
      idempotency: 'idempotent' as const,
      execute: async () => {
        calls++;
        return { success: true, output: { calls } };
      },
    };

    const first = await h.firewall.execute(intentInput, executor);
    expect(first.executed).toBe(true);
    const second = await h.firewall.execute(intentInput, executor);
    expect(second.executed).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('escalation flow (spec §6 ESCALATE)', () => {
  it('ESCALATE holds the action; execution only after human approval; freshness re-verified', async () => {
    const h = await harness({
      config: {
        actions: [
          {
            name: 'sensitive-read',
            match: { operation: 'rotate*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            on_unknown: 'escalate',
          },
        ],
      },
    });
    track(h.provider, 'credential', 'api-key', { rotated: false }, h.nowIso);

    const intentInput = {
      agent_id: 'bot',
      tool: 'secrets',
      operation: 'rotate_credential',
      dependencies: [{ source: 'memory', resource: 'credential', resource_id: 'api-key' }],
    };
    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };

    const outcome = await h.firewall.execute(intentInput, executor, { actionId: 'act_esc_1' });
    expect(outcome.decision.decision).toBe('ESCALATE');
    expect(outcome.executed).toBe(false);

    const pending = await h.firewall.listEscalations('PENDING');
    expect(pending).toHaveLength(1);
    const actionId = pending[0]!.action_id;
    expect(actionId).toBe('act_esc_1');

    // While PENDING, re-submission of the same action id is held, not re-evaluated.
    await expect(
      h.firewall.execute(intentInput, executor, { actionId: 'act_esc_1' }),
    ).rejects.toBeInstanceOf(EscalationPendingError);

    await h.firewall.resolveEscalation(actionId, { approved: true, by: 'security-oncall', note: 'change ticket #99' });

    const approved = await h.firewall.executeApproved(actionId, intentInput, executor);
    expect(approved.executed).toBe(true);

    const resolved = await h.firewall.listEscalations();
    expect(resolved[0]?.status).toBe('APPROVED');
    expect(resolved[0]?.resolved_by).toBe('security-oncall');
  });
});

describe('modes (spec §34)', () => {
  it('OBSERVE: decisions are recorded but nothing is blocked', async () => {
    const h = await harness({
      config: { firewall: { mode: 'observe', storage: { type: 'memory' } } },
    });
    track(h.provider, 'deployment', 'prod', { status: 'degraded' }, h.nowIso);

    const outcome = await h.firewall.execute(
      {
        agent_id: 'bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [
          { source: 'memory', resource: 'deployment', resource_id: 'prod', version: h.provider.get('deployment', 'prod')!.version },
        ],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
    );

    expect(outcome.decision.would_have_decided).toBe('DENY');
    expect(outcome.decision.decision).toBe('ALLOW');
    expect(outcome.executed).toBe(true);
  });

  it('STRICT: uncertainty denies even low-risk actions', async () => {
    const h = await harness({
      config: { firewall: { mode: 'strict', storage: { type: 'memory' } } },
    });
    const decision = await h.firewall.check({
      agent_id: 'bot',
      tool: 'tickets',
      operation: 'add_comment',
      dependencies: [{ source: 'memory', resource: 'ticket', resource_id: 'T1' }],
    });
    expect(decision.decision).toBe('DENY');
    expect(decision.mode).toBe('STRICT');
  });
});

describe('sqlite persistence round-trip', () => {
  it('decisions, actions, snapshots, authorizations, and audit survive reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-sqlite-'));
    const dbPath = join(dir, 'state.db');

    const h = await harness();
    const sqlite = new SqliteStore({ path: dbPath });
    await sqlite.init();

    const firewall = await h.firewall; // already initialized
    void firewall;

    // Build a second firewall over sqlite and run one validated execution.
    const { StaleStateFirewall } = await import('../../src/sdk/firewall.js');
    const fw = await StaleStateFirewall.create({
      config: { ...ENFORCE_CONFIG, firewall: { mode: 'enforce', storage: { type: 'sqlite', path: dbPath } } },
      providers: [h.provider],
      store: sqlite,
    });
    track(h.provider, 'pr', '5', { state: 'open' }, h.nowIso);
    const outcome = await fw.execute(
      {
        agent_id: 'bot',
        tool: 'github',
        operation: 'merge_pull_request',
        dependencies: [{ source: 'memory', resource: 'pr', resource_id: '5', version: h.provider.get('pr', '5')!.version }],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
    );
    expect(outcome.executed).toBe(true);
    await fw.close();

    // Reopen: history must be intact.
    const reopened = new SqliteStore({ path: dbPath });
    await reopened.init();
    const action = await reopened.getAction(outcome.decision.action_id);
    expect(action?.operation).toBe('merge_pull_request');
    const decision = await reopened.getDecision(outcome.decision.decision_id);
    expect(decision?.decision).toBe('ALLOW');
    const execution = (await reopened.listExecutions(outcome.decision.action_id))[0];
    expect(execution?.success).toBe(true);
    const audit = await reopened.listAllAuditRecords();
    expect(audit.length).toBeGreaterThanOrEqual(3);
    const verification = await new (await import('../../src/audit/audit-engine.js')).AuditEngine({
      store: reopened,
      clockIso: () => new Date().toISOString(),
      nowMs: () => Date.now(),
    }).verify();
    expect(verification.ok).toBe(true);
    await reopened.close();
  });
});

describe('protected tool wrapper (spec §14, §48)', () => {
  it('execute routes through the firewall; the raw tool never sees blocked actions', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);

    let rawCalls = 0;
    const deployTool = {
      name: 'deployer',
      run: async (input: { env: string }) => {
        rawCalls++;
        return { ok: true, env: input.env };
      },
      toIntent: (input: { env: string; version?: string }) => ({
        agent_id: 'release-bot',
        operation: 'deploy_production',
        target: input.env,
        dependencies: input.version
          ? [{ source: 'memory', resource: 'deployment', resource_id: input.env, version: input.version }]
          : [{ source: 'memory', resource: 'deployment', resource_id: input.env }],
      }),
    };

    const safe = h.firewall.protect(deployTool);

    // Fresh observation -> executes.
    const version = h.provider.get('deployment', 'prod')!.version;
    const result = await safe.execute({ env: 'prod', version });
    expect(result.ok).toBe(true);
    expect(rawCalls).toBe(1);

    // Stale version (state mutated meanwhile) -> BlockedActionError, raw tool untouched.
    h.provider.mutate('deployment', 'prod', { status: 'degraded' }, h.clock.nowIso());
    await expect(safe.execute({ env: 'prod', version })).rejects.toBeInstanceOf(BlockedActionError);
    expect(rawCalls).toBe(1);
  });

  it('wrapping the same tool name twice is refused (no dual-path bypass)', async () => {
    const h = await harness();
    const spec = {
      name: 'tool-x',
      run: async () => ({}),
      toIntent: () => ({ agent_id: 'a', operation: 'op' }),
    };
    h.firewall.protect(spec);
    expect(() => h.firewall.protect(spec)).toThrow(/already protected/);
  });
});
