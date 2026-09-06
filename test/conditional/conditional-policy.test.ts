import { describe, it, expect } from 'vitest';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import type { ActionExecutor, ActionIntentInput } from '../../src/domain/action.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { ManualClock } from '../../src/engine/clock.js';

/**
 * Milestone: ATOMIC EFFECT ASSURANCE — policy semantics (§12) and the
 * required state x capability x risk x outcome matrix (§30), adjusted to the
 * repository's actual risk semantics (LOW/MEDIUM/HIGH/CRITICAL, staleness
 * classes, deterministic policy outcomes).
 */

const REF = 'memory:deployment/prod';

function conditionalExecutor(
  provider: InMemoryStateProvider,
  changes: Record<string, unknown>,
): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === REF);
      if (!entry || entry.version === null) {
        return { condition: 'unavailable', error: 'no authorized expected state for the target resource' };
      }
      const result = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
        expected_version: entry.version,
        changes,
      });
      if (result.outcome === 'executed') {
        return { condition: 'satisfied', success: true, output: { version: result.version } };
      }
      return { condition: 'failed', observed_version: result.current_version };
    },
    async execute() {
      provider.mutate('deployment', 'prod', changes, new Date().toISOString());
      return { success: true };
    },
  };
}

function legacyExecutor(changes: Record<string, unknown>): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    async execute() {
      void changes; // the legacy executor performs its own side effect
      return { success: true };
    },
  };
}

interface RowSpec {
  name: string;
  /** Whether the executor supports conditional (CAS) execution. */
  cas: boolean;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** 'unchanged' | 'changed' | 'unknown' | 'invalid' */
  state: 'unchanged' | 'changed' | 'unknown' | 'invalid';
  replay?: boolean;
  requireConditional?: boolean;
  onUnavailable?: 'deny' | 'escalate' | 'revalidate';
  expect: 'executed' | 'condition_failed' | 'denied' | 'escalated' | 'replay_rejected';
}

const MATRIX: RowSpec[] = [
  { name: 'M1 unchanged + CAS + CRITICAL -> executed', cas: true, risk: 'CRITICAL', state: 'unchanged', expect: 'executed' },
  { name: 'M2 changed + CAS + CRITICAL -> provider condition failure', cas: true, risk: 'CRITICAL', state: 'changed', expect: 'condition_failed' },
  { name: 'M3 unchanged + CAS + HIGH -> executed', cas: true, risk: 'HIGH', state: 'unchanged', expect: 'executed' },
  { name: 'M4 changed + CAS + HIGH -> provider condition failure', cas: true, risk: 'HIGH', state: 'changed', expect: 'condition_failed' },
  { name: 'M5 unchanged + no CAS + CRITICAL (no requirement) -> legacy best-effort executed', cas: false, risk: 'CRITICAL', state: 'unchanged', expect: 'executed' },
  { name: 'M6 unchanged + no CAS + CRITICAL + require_conditional -> DENY (fail closed)', cas: false, risk: 'CRITICAL', state: 'unchanged', requireConditional: true, expect: 'denied' },
  { name: 'M7 changed + no CAS + CRITICAL + require_conditional -> DENY (gate fires before any execution)', cas: false, risk: 'CRITICAL', state: 'changed', requireConditional: true, expect: 'denied' },
  { name: 'M8 unchanged + no CAS + CRITICAL + require_conditional (escalate) -> ESCALATE', cas: false, risk: 'CRITICAL', state: 'unchanged', requireConditional: true, onUnavailable: 'escalate', expect: 'escalated' },
  { name: 'M9 unknown + CAS + CRITICAL -> no unsafe ALLOW (denied before execution)', cas: true, risk: 'CRITICAL', state: 'unknown', expect: 'denied' },
  { name: 'M10 invalid + CAS + CRITICAL -> no unsafe ALLOW (denied before execution)', cas: true, risk: 'CRITICAL', state: 'invalid', expect: 'denied' },
  { name: 'M11 unchanged + CAS + replay -> rejected', cas: true, risk: 'CRITICAL', state: 'unchanged', replay: true, expect: 'replay_rejected' },
  { name: 'M12 changed + CAS + replay -> rejected', cas: true, risk: 'CRITICAL', state: 'changed', replay: true, expect: 'replay_rejected' },
];

async function buildRow(spec: RowSpec): Promise<{
  outcome: Awaited<ReturnType<StaleStateFirewall['execute']>> | null;
  error: unknown;
  provider: InMemoryStateProvider;
  clock: ManualClock;
  firewall: StaleStateFirewall;
}> {
  const clock = new ManualClock('2026-09-05T12:00:00Z');
  const provider = new InMemoryStateProvider('memory');
  const firewall = await StaleStateFirewall.create({
    config: {
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
      actions: [
        {
          name: 'row-policy',
          match: { operation: 'deploy*' },
          risk: spec.risk,
          freshness: { strategy: 'version' },
          on_unknown: spec.risk === 'CRITICAL' ? 'deny' : 'revalidate',
          on_invalid: 'deny',
          execution: {
            deadline: '10s',
            require_fresh_at_execution: true,
            ...(spec.requireConditional === true ? { require_conditional_execution: true } : {}),
            ...(spec.onUnavailable !== undefined ? { on_conditional_unavailable: spec.onUnavailable } : {}),
          },
        },
      ],
    },
    store: new MemoryStore(),
    providers: [provider],
    clock,
  });

  provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
  const versionX = provider.get('deployment', 'prod')!.version;

  // 'invalid' = the declared version is already wrong when the action is
  // submitted (denied at validation time, like any stale submission).
  // 'changed' = the world moves AFTER authorization, inside the
  // authorization -> execution window this milestone is about.
  if (spec.state === 'invalid') {
    provider.mutate('deployment', 'prod', { status: 'moved' }, clock.nowIso());
  }

  const intent: ActionIntentInput =
    spec.state === 'unknown'
      ? {
          agent_id: 'bot',
          tool: 'deploy',
          operation: 'deploy_production',
          dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'ghost-resource', version: 'v999' }],
        }
      : {
          agent_id: 'bot',
          tool: 'deploy',
          operation: 'deploy_production',
          dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionX }],
        };

  let executor = spec.cas ? conditionalExecutor(provider, { status: 'deployed' }) : legacyExecutor({ status: 'deployed' });
  if (spec.state === 'changed' && spec.cas) {
    // A concurrent actor mutates the resource right after the firewall
    // authorized, before the conditional operation runs.
    const inner = executor.conditionalExecute!.bind(executor);
    executor = {
      ...executor,
      conditionalExecute: async (i, e) => {
        provider.mutate('deployment', 'prod', { status: 'changed-externally' }, clock.nowIso());
        return inner(i, e);
      },
    };
  }
  try {
    const outcome = await firewall.execute(intent, executor, { actionId: 'act_matrix' });
    return { outcome, error: null, provider, clock, firewall };
  } catch (error) {
    return { outcome: null, error, provider, clock, firewall };
  }
}

describe('milestone §30: state x capability x risk matrix', () => {
  for (const spec of MATRIX) {
    it(spec.name, async () => {
      const { outcome, error } = await buildRow(spec);

      if (spec.expect === 'replay_rejected') {
        // The first attempt already consumed the single-use authorization;
        // the detailed replay assertions live in M11b/M12b below.
        expect(spec.replay).toBe(true);
        if (spec.state === 'unchanged') {
          expect(outcome!.executed).toBe(true);
          expect(outcome!.result!.conditional_execution).toBe('satisfied');
        } else {
          expect(outcome!.result!.conditional_execution).toBe('failed');
        }
        return;
      }

      expect(error).toBeNull();
      expect(outcome).not.toBeNull();

      switch (spec.expect) {
        case 'executed':
          expect(outcome!.executed).toBe(true);
          expect(outcome!.result!.success).toBe(true);
          if (spec.cas) {
            expect(outcome!.result!.conditional_execution).toBe('satisfied');
            expect(outcome!.result!.atomicity).toBe('guaranteed');
          } else {
            expect(outcome!.result!.atomicity).toBe('not_guaranteed');
          }
          break;
        case 'condition_failed':
          expect(outcome!.executed).toBe(false);
          expect(outcome!.result!.success).toBe(false);
          expect(outcome!.result!.conditional_execution).toBe('failed');
          break;
        case 'denied':
          expect(outcome!.executed).toBe(false);
          expect(outcome!.result).toBeNull();
          expect(outcome!.decision.decision).toBe('DENY');
          break;
        case 'escalated':
          expect(outcome!.executed).toBe(false);
          expect(outcome!.decision.decision).toBe('ESCALATE');
          break;
        default:
          throw new Error(`unexpected expectation ${spec.expect}`);
      }
    });
  }

  it('M11b/M12b replay attempts after first use are rejected with ReplayDetectedError', async () => {
    for (const state of ['unchanged', 'changed'] as const) {
      const clock = new ManualClock('2026-09-05T12:00:00Z');
      const provider = new InMemoryStateProvider('memory');
      const firewall = await StaleStateFirewall.create({
        config: {
          firewall: { mode: 'enforce', storage: { type: 'memory' } },
          defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
          actions: [
            {
              name: 'row-policy',
              match: { operation: 'deploy*' },
              risk: 'CRITICAL',
              freshness: { strategy: 'version' },
              on_unknown: 'deny',
              execution: { deadline: '10s' },
            },
          ],
        },
        store: new MemoryStore(),
        providers: [provider],
        clock,
      });
      provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
      const versionX = provider.get('deployment', 'prod')!.version;

      let executor = conditionalExecutor(provider, { status: 'deployed' });
      if (state === 'changed') {
        const inner = executor.conditionalExecute!.bind(executor);
        executor = {
          ...executor,
          conditionalExecute: async (i, e) => {
            provider.mutate('deployment', 'prod', { status: 'changed-externally' }, clock.nowIso());
            return inner(i, e);
          },
        };
      }
      const intent = {
        agent_id: 'bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionX }],
      };
      const first = await firewall.execute(intent, executor, { actionId: `act_replay_${state}` });
      const firstResult = first.result!.conditional_execution;
      await expect(firewall.execute(intent, executor, { actionId: `act_replay_${state}` })).rejects.toMatchObject({
        code: 'SSF_REPLAY_DETECTED',
      });
      expect(['satisfied', 'failed']).toContain(firstResult);
      await firewall.close();
    }
  });

  it('M9b/M10b unknown and invalid states never reach the conditional executor', async () => {
    for (const state of ['unknown', 'invalid'] as const) {
      const { outcome } = await buildRow({ ...MATRIX.find((m) => m.state === state && m.cas)! });
      expect(outcome!.executed).toBe(false);
      expect(outcome!.decision.decision).toBe('DENY');
      // CRITICAL + unknown/invalid is denied at decision time: no execution
      // record exists for the action.
      expect(outcome!.result).toBeNull();
    }
  });
});

describe('milestone §12: policy semantics for conditional execution', () => {
  it('P1 require_conditional_execution is validated by config validation', async () => {
    const { validateConfig } = await import('../../src/config/validation.js');
    const bad = {
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      actions: [
        {
          name: 'p',
          match: { operation: 'deploy*' },
          execution: { require_conditional_execution: 'yes' },
        },
      ],
    } as unknown as FirewallRootConfigFile;
    const violations = validateConfig(bad);
    expect(violations.some((v) => v.path.endsWith('require_conditional_execution'))).toBe(true);

    const badOutcome = {
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      actions: [
        {
          name: 'p',
          match: { operation: 'deploy*' },
          execution: { on_conditional_unavailable: 'explode' },
        },
      ],
    } as unknown as FirewallRootConfigFile;
    const violations2 = validateConfig(badOutcome);
    expect(violations2.some((v) => v.path.endsWith('on_conditional_unavailable'))).toBe(true);

    // A requirement with an 'allow' escape hatch is contradictory.
    const contradictory = {
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      actions: [
        {
          name: 'p',
          match: { operation: 'deploy*' },
          execution: { require_conditional_execution: true, on_conditional_unavailable: 'allow' },
        },
      ],
    } as unknown as FirewallRootConfigFile;
    const violations3 = validateConfig(contradictory);
    expect(violations3.some((v) => v.path.endsWith('on_conditional_unavailable'))).toBe(true);
  });

  it('P2 CRITICAL + provider lacks conditional execution + requirement -> DENY with auditable reason', async () => {
    const { outcome } = await buildRow({
      name: '', cas: false, risk: 'CRITICAL', state: 'unchanged', requireConditional: true, expect: 'denied',
    });
    expect(outcome!.decision.decision).toBe('DENY');
    expect(outcome!.decision.reason).toContain('conditional execution');
  });

  it('P3 LOW-risk action + no conditional capability + no requirement -> still permissible (backward compatible)', async () => {
    const { outcome } = await buildRow({
      name: '', cas: false, risk: 'LOW', state: 'unchanged', expect: 'executed',
    });
    expect(outcome!.executed).toBe(true);
    expect(outcome!.result!.atomicity).toBe('not_guaranteed');
  });

  it('P4 conditional capability present + requirement set -> executes conditionally, not denied', async () => {
    const { outcome } = await buildRow({
      name: '', cas: true, risk: 'CRITICAL', state: 'unchanged', requireConditional: true, expect: 'executed',
    });
    expect(outcome!.executed).toBe(true);
    expect(outcome!.result!.conditional_execution).toBe('satisfied');
  });

  it('P5 OBSERVE mode records the would-be gate outcome without blocking', async () => {
    const clock = new ManualClock('2026-09-05T12:00:00Z');
    const provider = new InMemoryStateProvider('memory');
    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'observe', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
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
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const versionX = provider.get('deployment', 'prod')!.version;

    const outcome = await firewall.execute(
      {
        agent_id: 'bot',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionX }],
      },
      legacyExecutorNoop(),
      { actionId: 'act_p5' },
    );
    // OBSERVE never blocks: the reduced-guarantee execution proceeds and the
    // gate's would-be DENY is persisted on the latest decision record.
    expect(outcome.executed).toBe(true);
    const gateRecord = await firewall.latestDecision('act_p5');
    expect(gateRecord!.would_have_decided).toBe('DENY');
    await firewall.close();
  });

  it('P6 approved escalation with an unconditional executor proceeds under the best-effort guarantee', async () => {
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
            execution: { deadline: '10s', require_conditional_execution: true, on_conditional_unavailable: 'escalate' },
          },
        ],
      },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const versionX = provider.get('deployment', 'prod')!.version;

    const intent = {
      agent_id: 'bot',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionX }],
    };
    const first = await firewall.execute(intent, legacyExecutorNoop(), { actionId: 'act_p6' });
    expect(first.decision.decision).toBe('ESCALATE');

    await firewall.resolveEscalation('act_p6', { approved: true, by: 'human-on-call' });
    const approved = await firewall.executeApproved('act_p6', intent, legacyExecutorNoop());
    // A human approval resolves the gate; execution proceeds under the
    // documented best-effort guarantee (atomicity not_guaranteed).
    expect(approved.executed).toBe(true);
    expect(approved.result!.atomicity).toBe('not_guaranteed');
    await firewall.close();
  });
});

function legacyExecutorNoop(): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    async execute() {
      return { success: true };
    },
  };
}
