/**
 * Operationalization milestone tests: recovery contract, retry semantics,
 * provider failure classification, refKey runtime export, and the protect()
 * conditional-unavailable path.
 *
 * Pins the recovery contract introduced to close the dogfood friction
 * findings ("refusal messages do not answer: is a retry safe?") and the
 * explicit UNKNOWN execution outcome (operationalization §8/§9/§10/§11/§12).
 */

import { describe, expect, it } from 'vitest';
import {
  refKey,
  RETRY_SEMANTICS,
  classifyProviderFailure,
  createProtectedTool,
  BlockedActionError,
  ReplayDetectedError,
  ActionExpiredError,
  ProviderUnavailableError,
  ProviderResponseError,
} from '../../src/index.js';
import { harness, track } from '../helpers/harness.js';
import type { ActionExecutor, ActionIntentInput } from '../../src/domain/action.js';
import type { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';

const FILE_REF = 'memory:file/configs/service.yaml';

function editIntent(version: string | null): ActionIntentInput {
  return {
    agent_id: 'config-agent',
    tool: 'edit-config',
    operation: 'edit_service_config',
    arguments: { content: 'replicas: 3' },
    dependencies: [{ source: 'memory', resource: 'file', resource_id: 'configs/service.yaml', version }],
  };
}

/** Honest conditional executor bound to the in-memory provider CAS. */
function conditionalExecutor(provider: InMemoryStateProvider): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    async execute() {
      return { success: true };
    },
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === FILE_REF);
      if (!entry?.version) {
        return { condition: 'unavailable', error: 'no authorized expected state for the written ref' };
      }
      const result = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'file', resource_id: 'configs/service.yaml' },
        expected_version: entry.version,
        changes: { content: 'replicas: 3' },
      });
      return result.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: { version: result.version } }
        : { condition: 'failed', ref: FILE_REF, observed_version: result.current_version };
    },
  };
}

describe('recovery contract: the retry-semantics table is closed and honest', () => {
  it('every failure kind has guidance with a valid retry-safety classification', () => {
    const VALID = new Set([
      'SAFE',
      'SAFE_ONLY_AFTER_FRESH_EVALUATION',
      'UNSAFE',
      'REQUIRES_HUMAN_REVIEW',
    ]);
    for (const [kind, guidance] of Object.entries(RETRY_SEMANTICS)) {
      expect(VALID.has(guidance.retry_safety), kind).toBe(true);
      expect(guidance.failure_kind, kind).toBe(kind);
      expect(guidance.next_steps.length, kind).toBeGreaterThan(0);
      // The dangerous classes must never claim the authorization is usable.
      if (kind === 'condition_failed' || kind === 'unknown_execution_outcome' || kind === 'replay') {
        expect(guidance.authorization_usable, kind).toBe(false);
      }
    }
    // Condition failures: safe only after fresh evaluation, no side effect.
    expect(RETRY_SEMANTICS['condition_failed']!.retry_safety).toBe('SAFE_ONLY_AFTER_FRESH_EVALUATION');
    expect(RETRY_SEMANTICS['condition_failed']!.side_effect_possible).toBe(false);
    expect(RETRY_SEMANTICS['condition_failed']!.next_steps.join(' ')).toMatch(/never retry/i);
    // Unknown outcomes: never blindly retried.
    expect(RETRY_SEMANTICS['unknown_execution_outcome']!.retry_safety).toBe('UNSAFE');
    expect(RETRY_SEMANTICS['unknown_execution_outcome']!.side_effect_possible).toBe(true);
  });

  it('condition_failed surfaces the full recovery contract on the execution result and audit event', async () => {
    const h = await harness();
    track(h.provider, 'file', 'configs/service.yaml', { content: 'v1' }, h.nowIso);
    const observed = h.provider.get('file', 'configs/service.yaml')!.version;

    const executor = conditionalExecutor(h.provider);
    const realCas = executor.conditionalExecute!.bind(executor);
    executor.conditionalExecute = async (intent, expectedState) => {
      // Concurrent mutation lands in the CAS window.
      h.provider.mutate('file', 'configs/service.yaml', { content: 'changed-by-other' }, h.clock.nowIso());
      return realCas(intent, expectedState);
    };

    const outcome = await h.firewall.execute(editIntent(observed), executor);
    expect(outcome.result!.conditional_execution).toBe('failed');

    // The caller can understand the recovery without reading source code.
    const recovery = outcome.result!.recovery!;
    expect(recovery.failure_kind).toBe('condition_failed');
    expect(recovery.retry_safety).toBe('SAFE_ONLY_AFTER_FRESH_EVALUATION');
    expect(recovery.authorization_usable).toBe(false);
    expect(recovery.side_effect_possible).toBe(false);
    expect(recovery.next_steps.join(' ')).toMatch(/fresh current state/i);
    expect(recovery.next_steps.join(' ')).toMatch(/NEW authorization/i);

    // The audit trail carries the same contract.
    const audit = await h.firewall.auditTail(50);
    const event = audit.find((r) => r.event_type === 'execution.condition_failed');
    expect(event).toBeDefined();
    expect(event!.payload['retry_safety']).toBe('SAFE_ONLY_AFTER_FRESH_EVALUATION');
    expect(event!.payload['failed_ref']).toBe(FILE_REF);
  });

  it('replay, expiry, and provider errors carry their recovery contracts', async () => {
    const h = await harness();
    track(h.provider, 'file', 'configs/service.yaml', { content: 'v1' }, h.nowIso);
    const observed = h.provider.get('file', 'configs/service.yaml')!.version;
    const executor = conditionalExecutor(h.provider);

    const first = await h.firewall.execute(editIntent(observed), executor, { actionId: 'act_rc1' });
    expect(first.executed).toBe(true);

    // Replay of a consumed authorization.
    let replay: unknown;
    try {
      await h.firewall.execute(editIntent(observed), executor, { actionId: 'act_rc1' });
      expect.unreachable();
    } catch (e) {
      replay = e;
    }
    expect(replay).toBeInstanceOf(ReplayDetectedError);
    expect((replay as ReplayDetectedError).recovery?.failure_kind).toBe('replay');
    expect((replay as ReplayDetectedError).recovery?.retry_safety).toBe('UNSAFE');
    expect((replay as ReplayDetectedError).recovery?.side_effect_possible).toBe(true);

    // Expiry.
    const expired = new ActionExpiredError('act_x', '2026-09-05T12:00:01Z');
    expect(expired.recovery?.failure_kind).toBe('authorization_expired');
    expect(expired.recovery?.retry_safety).toBe('SAFE');
    expect(expired.recovery?.side_effect_possible).toBe(false);

    // Provider transport fault classification + guidance.
    const rateLimited = new ProviderUnavailableError('github', 'rate limit exhausted; resets at 2026-09-05T13:00:00Z', { status: 403 });
    expect(rateLimited.kind).toBe('RATE_LIMITED');
    expect(rateLimited.recovery?.failure_kind).toBe('rate_limit');
    expect(rateLimited.recovery?.next_steps.join(' ')).toMatch(/back off/i);

    const serverError = new ProviderUnavailableError('http', 'GET failed with HTTP 503', { status: 503 });
    expect(serverError.kind).toBe('SERVER_ERROR');
    expect(serverError.recovery?.failure_kind).toBe('provider_failure');

    const notFound = new ProviderUnavailableError('http', 'GET failed with HTTP 404', { status: 404 });
    expect(notFound.kind).toBe('NOT_FOUND');

    const unsupported = new ProviderResponseError('http', 'resource "x" does not declare a conditional mutation endpoint');
    expect(unsupported.kind).toBe('UNSUPPORTED');
  });

  it('BlockedActionError carries recovery for decision blocks (dogfood S15 friction item)', async () => {
    const h = await harness();
    track(h.provider, 'file', 'configs/service.yaml', { content: 'v1' }, h.nowIso);
    const observed = h.provider.get('file', 'configs/service.yaml')!.version;

    // Decision block (stale claim): POLICY guidance -> fresh evaluation.
    h.provider.mutate('file', 'configs/service.yaml', { content: 'moved' }, h.clock.nowIso());
    const tool = createProtectedTool<{ version: string | null }, { ok: boolean }>(h.firewall, {
      name: 'edit-config-blocked',
      toIntent: (input) => editIntent(input.version),
      run: async () => ({ ok: true }),
      conditionalExecutionSupported: true,
      conditionalRun: async () => ({ applied: true, output: { ok: true } }),
    });
    try {
      await tool.execute({ version: observed });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BlockedActionError);
      const blocked = e as BlockedActionError;
      expect(blocked.decision.decision).toBe('DENY');
      expect(blocked.recovery?.failure_kind).toBe('policy_blocked');
      expect(blocked.recovery?.retry_safety).toBe('SAFE_ONLY_AFTER_FRESH_EVALUATION');
      expect(blocked.recovery?.side_effect_possible).toBe(false);
      expect(blocked.recovery?.next_steps.join(' ')).toMatch(/fresh current state/i);
    }
  });
});

describe('unknown execution outcome is explicit (operationalization §11)', () => {
  it('a faulted conditional operation records status unknown with UNSAFE guidance, and the authorization cannot be replayed', async () => {
    const h = await harness();
    track(h.provider, 'file', 'configs/service.yaml', { content: 'v1' }, h.nowIso);
    const observed = h.provider.get('file', 'configs/service.yaml')!.version;

    const executor = conditionalExecutor(h.provider);
    executor.conditionalExecute = async () => {
      throw new Error('connection reset by peer');
    };

    const outcome = await h.firewall.execute(editIntent(observed), executor, { actionId: 'act_unk1' });
    expect(outcome.result!.success).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('unknown');
    const recovery = outcome.result!.recovery!;
    expect(recovery.failure_kind).toBe('unknown_execution_outcome');
    expect(recovery.retry_safety).toBe('UNSAFE');
    expect(recovery.side_effect_possible).toBe(true);
    expect(recovery.next_steps.join(' ')).toMatch(/inspect the external system/i);
    expect(recovery.next_steps.join(' ')).toMatch(/do not retry/i);

    // Metrics expose the unknown-outcome rate locally.
    expect(h.firewall.getMetrics().counters['executions_unknown_outcome']).toBe(1);

    // Blind replay after the unknown outcome is refused.
    await expect(
      h.firewall.execute(editIntent(observed), executor, { actionId: 'act_unk1' }),
    ).rejects.toBeInstanceOf(ReplayDetectedError);
  });
});

describe('provider failure classification (operationalization §10)', () => {
  it('classifies statuses and transport faults without collapsing distinct kinds', () => {
    expect(classifyProviderFailure({ status: 404 })).toBe('NOT_FOUND');
    expect(classifyProviderFailure({ status: 401 })).toBe('UNAUTHORIZED');
    expect(classifyProviderFailure({ status: 403 })).toBe('FORBIDDEN');
    expect(classifyProviderFailure({ status: 429 })).toBe('RATE_LIMITED');
    expect(classifyProviderFailure({ status: 412 })).toBe('CONDITION_FAILED');
    expect(classifyProviderFailure({ status: 409 })).toBe('CONDITION_FAILED');
    expect(classifyProviderFailure({ status: 500 })).toBe('SERVER_ERROR');
    expect(classifyProviderFailure({ status: 503 })).toBe('SERVER_ERROR');
    expect(classifyProviderFailure({ error: new Error('TimeoutError: The operation was aborted due to timeout') })).toBe('TIMEOUT');
    expect(classifyProviderFailure({ error: new Error('fetch failed') })).toBe('NETWORK_ERROR');
    expect(classifyProviderFailure({ error: new Error('ECONNRESET') })).toBe('NETWORK_ERROR');
    expect(classifyProviderFailure({ error: 'something odd' })).toBe('UNKNOWN_OUTCOME');
  });
});

describe('refKey is a runtime export (operationalization §12)', () => {
  it('consumers can build expected-state ref keys without re-implementing the format', () => {
    expect(refKey({ source: 'memory', resource: 'file', resource_id: 'configs/service.yaml' })).toBe(
      'memory:file/configs/service.yaml',
    );
    // It agrees with the expectedState entries handed to conditional executors.
    expect(refKey({ source: 'github', resource: 'file', resource_id: 'o/r@p/x.txt' })).toBe('github:file/o/r@p/x.txt');
  });
});

describe('protect() path audit (operationalization §13)', () => {
  it('a tool WITHOUT conditional capability is blocked under require_conditional_execution — the convenience API cannot weaken the guarantee', async () => {
    const h = await harness({
      config: {
        firewall: { mode: 'enforce' },
        actions: [
          {
            name: 'edit-config',
            match: { tool: 'edit-config', operation: '*' },
            risk: 'HIGH',
            freshness: { strategy: 'version' },
            execution: { require_conditional_execution: true },
          },
        ],
      },
    });
    track(h.provider, 'file', 'configs/service.yaml', { content: 'v1' }, h.nowIso);
    const observed = h.provider.get('file', 'configs/service.yaml')!.version;

    const legacyTool = createProtectedTool<{ version: string | null }, unknown>(h.firewall, {
      name: 'edit-config',
      toIntent: (input) => editIntent(input.version),
      run: async () => {
        throw new Error('legacy run() must never be reached when the conditional gate fails closed');
      },
      // No conditionalExecutionSupported / conditionalRun: legacy path.
    });

    await expect(legacyTool.execute({ version: observed })).rejects.toThrow(/requires provider-side conditional execution/i);
    // Nothing was written.
    expect(h.provider.get('file', 'configs/service.yaml')!.metadata['content']).toBe('v1');
    // The gate failure is attributable in the audit trail.
    const audit = await h.firewall.auditTail(50);
    const blocked = audit.find((r) => r.event_type === 'action.blocked' && r.payload['stage'] === 'conditional_execution_unavailable');
    expect(blocked).toBeDefined();
  });
});
