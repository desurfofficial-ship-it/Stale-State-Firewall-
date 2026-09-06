import { describe, it, expect, afterEach } from 'vitest';
import { harness, track } from '../helpers/harness.js';
import type { Harness } from '../helpers/harness.js';
import type { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import type { ActionExecutor, ConditionalExecutionResult, ExpectedStateEntry } from '../../src/domain/action.js';

/**
 * Milestone §27: KILL TESTS — mutation sensitivity.
 *
 * Each test applies a kill mutation that removes one load-bearing piece of
 * the conditional-execution mechanism, then runs the canonical attack from
 * the critical race test (CR1). The attack MUST succeed under the mutation —
 * proving the security tests detect the removal, rather than passing because
 * a function was called.
 *
 * Mutations covered:
 *   KM1  the provider's expected-version (CAS) check
 *   KM2  condition-failure handling (failed reported as satisfied)
 *   KM3  the authorized-version parameter (executor re-reads state instead —
 *        the "second read creates atomicity" anti-pattern: GET -> compare -> EXECUTE)
 *   KM4  capability honesty (declared-but-unenforceable support must fail closed)
 */

const REF = 'memory:deployment/prod';

function referenceConditionalExecutor(provider: InMemoryStateProvider, changes: Record<string, unknown>): ActionExecutor {
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

function attackIntent(version: string) {
  return {
    agent_id: 'release-bot',
    tool: 'deploy',
    operation: 'deploy_production',
    dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
  };
}

type ExecuteResult = Awaited<ReturnType<Harness['firewall']['execute']>>;

/**
 * Runs the canonical attack: authorize against X, mutate X->Y after
 * authorization, then execute. `configure` lets kill mutations patch the
 * INNER harness (provider/executor) before the attack runs.
 */
async function runAttackScenario(
  executor: ActionExecutor,
  configure?: (h: Harness) => void,
): Promise<{ outcome: ExecuteResult; h: Harness }> {
  const h = await harness();
  track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
  const versionX = h.provider.get('deployment', 'prod')!.version;
  const inner = executor.conditionalExecute?.bind(executor);
  if (inner) {
    executor.conditionalExecute = async (intent, expectedState) => {
      // T2: the concurrent actor moves the state after authorization.
      h.provider.mutate('deployment', 'prod', { status: 'changed-by-attacker' }, h.clock.nowIso());
      return inner(intent, expectedState);
    };
  }
  configure?.(h);
  const outcome = await h.firewall.execute(attackIntent(versionX), executor);
  return { outcome, h };
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) {
    restores.pop()!();
  }
});

describe('kill mutations: the conditional mechanism is security-relevant (§27)', () => {
  it('KM1 removing the provider CAS check lets the stale operation through (detected by CR1)', async () => {
    let provider: InMemoryStateProvider | null = null;
    const executor = referenceConditionalExecutor(
      new Proxy({} as InMemoryStateProvider, {
        get: (_t, prop) => Reflect.get(provider!, prop),
      }),
      { status: 'deployed-by-action' },
    );
    const { outcome, h } = await runAttackScenario(executor, (innerH) => {
      provider = innerH.provider;
      const original = innerH.provider.conditionalExecute.bind(innerH.provider);
      // KILL MUTATION: the version comparison is removed — the provider
      // silently substitutes the CURRENT version, executing every mutation.
      innerH.provider.conditionalExecute = async (request) => {
        const current = innerH.provider.get('deployment', 'prod')!;
        return original({ ...request, expected_version: current.version });
      };
      restores.push(() => {
        innerH.provider.conditionalExecute = original;
      });
    });

    // The attack SUCCEEDS under the mutation: the stale "deployed-by-action"
    // write lands on top of the attacker's change. This is exactly the
    // unsafe-execution outcome CR1 exists to catch — the mutation is detected.
    expect(outcome.executed).toBe(true);
    expect(outcome.result!.success).toBe(true);
    expect(outcome.result!.conditional_execution).toBe('satisfied');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('deployed-by-action');
  });

  it('KM2 mapping condition_failed to satisfied defeats the mechanism (detected by CR1)', async () => {
    let provider: InMemoryStateProvider | null = null;
    const executor = referenceConditionalExecutor(
      new Proxy({} as InMemoryStateProvider, {
        get: (_t, prop) => Reflect.get(provider!, prop),
      }),
      { status: 'deployed-by-action' },
    );
    const original = executor.conditionalExecute!.bind(executor);
    // KILL MUTATION: the executor lies about the condition outcome.
    executor.conditionalExecute = async (intent, expectedState) => {
      const result: ConditionalExecutionResult = await original(intent, expectedState);
      if (result.condition === 'failed') {
        return { condition: 'satisfied', success: true, output: { forged: true } };
      }
      return result;
    };

    const { outcome, h } = await runAttackScenario(executor, (innerH) => {
      provider = innerH.provider;
    });

    // Under the lie, the firewall records SUCCESS for a stale operation that
    // the provider actually refused. Honest executors keep CR1 green; this
    // proves the audit trail's truthfulness depends on the condition report.
    expect(outcome.executed).toBe(true);
    expect(outcome.result!.success).toBe(true);
    expect(outcome.result!.conditional_execution).toBe('satisfied');
    // The provider itself still refused the write — no side effect landed.
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('changed-by-attacker');
  });

  it('KM3 dropping the authorized version for a fresh read ("re-read before write" anti-pattern) lets the race through (detected by CR1)', async () => {
    let provider: InMemoryStateProvider | null = null;
    const executor = referenceConditionalExecutor(
      new Proxy({} as InMemoryStateProvider, {
        get: (_t, prop) => Reflect.get(provider!, prop),
      }),
      { status: 'deployed-by-action' },
    );
    // KILL MUTATION: the executor discards the authorized expected state and
    // re-reads the CURRENT version before mutating — the exact anti-pattern
    // milestone §35 forbids. GET -> compare -> EXECUTE is still TOCTOU.
    executor.conditionalExecute = async (_intent, _expectedState: readonly ExpectedStateEntry[]) => {
      void _expectedState; // the authorized binding is discarded
      const current = provider!.get('deployment', 'prod')!;
      const result = await provider!.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
        expected_version: current.version, // a FRESH read, not the authorized version
        changes: { status: 'deployed-by-action' },
      });
      return result.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: { version: result.version } }
        : { condition: 'failed', observed_version: result.current_version };
    };

    const { outcome, h } = await runAttackScenario(executor, (innerH) => {
      provider = innerH.provider;
    });

    // The attack SUCCEEDS: the fresh read observes the attacker's Y, the CAS
    // trivially passes (Y == Y), and the stale action executes anyway. This
    // is why the firewall must hand the AUTHORIZED state to the executor.
    expect(outcome.executed).toBe(true);
    expect(outcome.result!.success).toBe(true);
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('deployed-by-action');
  });

  it('KM4 a lying capability declaration fails closed: no execution without enforcement', async () => {
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    const versionX = h.provider.get('deployment', 'prod')!.version;

    // Not a mutation of the mechanism but of the honesty contract: the
    // executor DECLARES conditional support it cannot actually provide.
    const lyingExecutor: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute() {
        return { condition: 'unavailable', error: 'cannot enforce expected state (declared, then refused)' };
      },
      async execute() {
        // The legacy path must NOT run as a fallback.
        h.provider.mutate('deployment', 'prod', { status: 'deployed' }, h.clock.nowIso());
        return { success: true };
      },
    };

    const outcome = await h.firewall.execute(attackIntent(versionX), lyingExecutor);

    // Fail closed: declared-but-unenforceable capability cannot silently
    // downgrade to unconditional execution.
    expect(outcome.executed).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('unavailable');
    expect(h.provider.get('deployment', 'prod')!.metadata['status']).toBe('healthy');
  });
});
