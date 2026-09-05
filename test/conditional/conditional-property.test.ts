import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { harness, track } from '../helpers/harness.js';
import type { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import type { ActionExecutor } from '../../src/domain/action.js';

/**
 * Milestone §26: PROPERTY TESTS for conditional execution.
 *
 * Core properties (deterministic enforcement, randomized inputs):
 *   P-A  if current_state != authorized_state and the provider enforces
 *        conditional execution -> consequential execution MUST NOT succeed.
 *   P-B  if current_state == authorized_state and all other authorization
 *        requirements remain valid -> conditional execution MAY succeed
 *        (and, with the reference executor, does).
 *   P-C  every condition failure invalidates the authorization: the same
 *        action id can never execute twice, in any random interleaving.
 */

const REF = 'memory:deployment/prod';

function conditionalExecutorFor(provider: InMemoryStateProvider, changes: Record<string, unknown>): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === REF);
      if (!entry || entry.version === null) {
        return { condition: 'unavailable', error: 'no authorized expected state' };
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

describe('conditional execution properties (§26)', () => {
  it('P-A/P-B: outcome is a pure function of (authorized state == current state)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }), // number of external mutations AFTER authorization
        fc.integer({ min: 1, max: 4 }), // number of pre-authorization observations (state identity)
        async (postAuthMutations, preAuthVersion) => {
          const h = await harness();
          // Build a version history; the authorization binds to the LAST
          // version observed before the action was submitted.
          track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
          let version = h.provider.get('deployment', 'prod')!.version;
          for (let i = 0; i < preAuthVersion; i++) {
            version = h.provider.mutate('deployment', 'prod', { note: `pre-${i}` }, h.clock.nowIso());
          }
          const authorizedVersion = version;

          const executor = conditionalExecutorFor(h.provider, { status: 'deployed-by-action' });
          const inner = executor.conditionalExecute!.bind(executor);
          executor.conditionalExecute = async (intent, expectedState) => {
            for (let i = 0; i < postAuthMutations; i++) {
              h.provider.mutate('deployment', 'prod', { note: `post-${i}` }, h.clock.nowIso());
            }
            return inner(intent, expectedState);
          };

          const outcome = await h.firewall.execute(
            {
              agent_id: 'bot',
              tool: 'deploy',
              operation: 'deploy_production',
              dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: authorizedVersion }],
            },
            executor,
          );

          if (postAuthMutations > 0) {
            // P-A: the state moved after authorization -> the provider must
            // reject; execution MUST NOT succeed, whatever the inputs.
            expect(outcome.executed).toBe(false);
            expect(outcome.result!.success).toBe(false);
            expect(outcome.result!.conditional_execution).toBe('failed');
          } else {
            // P-B: state unchanged -> the condition holds and the action runs.
            expect(outcome.executed).toBe(true);
            expect(outcome.result!.success).toBe(true);
            expect(outcome.result!.conditional_execution).toBe('satisfied');
          }
          await h.firewall.close();
        },
      ),
      { numRuns: 40 },
    );
  });

  it('P-C: condition failures always invalidate the authorization (no replay path in any interleaving)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }), // mutations before the first attempt
        fc.integer({ min: 0, max: 3 }), // mutations between the attempts
        async (preMutations, betweenMutations) => {
          const h = await harness();
          track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
          let version = h.provider.get('deployment', 'prod')!.version;
          for (let i = 0; i < preMutations; i++) {
            version = h.provider.mutate('deployment', 'prod', { note: `pre-${i}` }, h.clock.nowIso());
          }

          const executor = conditionalExecutorFor(h.provider, { status: 'deployed' });
          const inner = executor.conditionalExecute!.bind(executor);
          let attempt = 0;
          executor.conditionalExecute = async (intent, expectedState) => {
            if (attempt === 0) {
              // First attempt: mutate 50%-deterministically via postMutations
              // handled by the caller below; here nothing extra.
            }
            void attempt;
            return inner(intent, expectedState);
          };

          const intent = {
            agent_id: 'bot',
            tool: 'deploy',
            operation: 'deploy_production',
            dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
          };
          const first = await h.firewall.execute(intent, executor, { actionId: 'act_pc' });
          attempt = 1;

          for (let i = 0; i < betweenMutations; i++) {
            h.provider.mutate('deployment', 'prod', { note: `between-${i}` }, h.clock.nowIso());
          }

          // Whatever the first attempt's outcome (satisfied, failed, or the
          // action was blocked before authorization), the same action id must
          // never be granted a second live authorization while replay
          // protection holds.
          if (first.result !== null) {
            await expect(
              h.firewall.execute(intent, executor, { actionId: 'act_pc' }),
            ).rejects.toMatchObject({ code: 'SSF_REPLAY_DETECTED' });
          }
          await h.firewall.close();
        },
      ),
      { numRuns: 40 },
    );
  });

  it('P-D: provider CAS is ref-scoped for arbitrary version pairs (no cross-resource substitution)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }), // prod version counter
        fc.integer({ min: 1, max: 50 }), // staging version counter
        async (prodN, stagingN) => {
          const h = await harness();
          track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
          track(h.provider, 'deployment', 'staging', { status: 'healthy' }, h.nowIso);
          let prodVersion = h.provider.get('deployment', 'prod')!.version;
          let stagingVersion = h.provider.get('deployment', 'staging')!.version;
          for (let i = 1; i < prodN; i++) prodVersion = h.provider.mutate('deployment', 'prod', { i }, h.clock.nowIso());
          for (let i = 1; i < stagingN; i++) stagingVersion = h.provider.mutate('deployment', 'staging', { i }, h.clock.nowIso());

          // A version authorized for prod must never satisfy a CAS on staging
          // (versions are globally unique in the reference provider; any
          // cross-application must fail closed).
          const result = await h.provider.conditionalExecute({
            ref: { source: 'memory', resource: 'deployment', resource_id: 'staging' },
            expected_version: prodVersion,
            changes: { hijacked: true },
          });
          if (prodVersion !== stagingVersion) {
            expect(result.outcome).toBe('condition_failed');
            expect(h.provider.get('deployment', 'staging')!.metadata['hijacked']).toBeUndefined();
          }
          void stagingVersion;
        },
      ),
      { numRuns: 40 },
    );
  });
});
