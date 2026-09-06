/**
 * ProtectedTool (spec §14, §48).
 *
 * Wraps a tool so that every execution passes through the firewall decision
 * boundary. By construction:
 *   Agent -> ProtectedTool -> Firewall -> [ALLOW] -> original tool
 * The original tool is reachable ONLY inside the executor closure, which the
 * firewall invokes exclusively after a fresh-state ALLOW. No reference to
 * the raw tool is exposed on the wrapper, and the firewall refuses to wrap
 * the same tool name twice, closing accidental dual-path bypasses.
 */

import type { ActionIntentInput, ActionExecutor, ExpectedStateEntry, ExecutionResult, IdempotencyKind } from '../domain/action.js';
import type { DecisionRecord } from '../domain/decision.js';
import type { StateDependencyInput } from '../domain/state.js';
import { FirewallError } from '../domain/errors.js';
import { HUMAN_REVIEW_GUIDANCE, POLICY_BLOCKED, type RecoveryGuidance } from '../domain/recovery.js';
import type { StaleStateFirewall } from './firewall.js';

/** Raised when the firewall did not authorize the protected execution. */
export class BlockedActionError extends FirewallError {
  readonly decision: DecisionRecord;
  /**
   * The recorded execution result when the action was authorized but the
   * side effect failed (e.g. a provider condition failure). Agents can read
   * `conditional_execution`, `observed_version`, and `error` to decide the
   * next step (fresh re-evaluation — never a blind retry).
   */
  readonly execution?: ExecutionResult;
  /**
   * Machine-readable recovery contract (operationalization milestone):
   * what failed, whether retrying is safe, and the deterministic next
   * steps. Drawn from the execution result when one exists, otherwise
   * derived from the decision (DENY/REVALIDATE -> fresh evaluation;
   * ESCALATE -> human review).
   */
  override readonly recovery?: RecoveryGuidance;

  constructor(decision: DecisionRecord, execution?: ExecutionResult) {
    const recovery: RecoveryGuidance =
      execution?.recovery ??
      (decision.decision === 'ESCALATE' ? HUMAN_REVIEW_GUIDANCE : POLICY_BLOCKED);
    super({
      code: 'SSF_ACTION_BLOCKED',
      message: `action blocked by Stale-State Firewall: ${decision.decision} (${decision.reason})`,
      details: {
        decision_id: decision.decision_id,
        action_id: decision.action_id,
        ...(execution?.conditional_execution
          ? { conditional_execution: execution.conditional_execution }
          : {}),
      },
      recovery,
    });
    this.name = 'BlockedActionError';
    this.decision = decision;
    this.execution = execution;
    this.recovery = recovery;
  }
}

/** Outcome of a ProtectedTool conditional run (dogfood finding DF-F1). */
export type ConditionalRunOutcome<O> =
  | { applied: true; output: O }
  | {
      applied: false;
      /** The provider's refusal message (recorded in the audit trail). */
      error?: string;
      /** The ref whose authorized expected state did not hold (DF-4). */
      ref?: string | null;
      /** The version the external system reported at conditional time. */
      observed_version?: string | null;
    };

export interface ProtectedToolSpec<I, O> {
  /** Unique tool identity inside this firewall instance. */
  name: string;
  /** The raw tool implementation. NEVER exposed on the wrapper. */
  run: (input: I) => Promise<O>;
  /** Maps the tool input to an action intent (dependencies, preconditions, risk). */
  toIntent: (input: I) => ActionIntentInput;
  /** Optional per-call idempotency classification (default: non_idempotent). */
  idempotency?: IdempotencyKind | ((input: I) => IdempotencyKind);
  /** Whether the underlying system enforces compare-and-swap semantics. */
  atomicity?: 'guaranteed' | 'not_guaranteed';
  /**
   * Declares that this tool performs its side effect through a provider
   * compare-and-swap when given the authorized expected state. Default:
   * false (legacy best-effort path).
   */
  conditionalExecutionSupported?: boolean | ((input: I) => boolean);
  /**
   * Performs the side effect CONDITIONED on the authorized expected state
   * (dogfood finding DF-F1: without this hook the most ergonomic integration
   * API could not reach the provider-enforced CAS guarantee). The hook MUST
   * forward the authorized versions to the external system — never re-read
   * current state. Return `applied: false` when the provider refused.
   */
  conditionalRun?: (
    input: I,
    expectedState: readonly ExpectedStateEntry[],
  ) => Promise<ConditionalRunOutcome<O>>;
}

export interface ProtectedTool<I, O> {
  readonly toolName: string;
  /** Dry-run: full validation, no side effects. */
  check(input: I): Promise<DecisionRecord>;
  /** Validated execution; throws BlockedActionError when not allowed. */
  execute(input: I): Promise<O>;
}

export function createProtectedTool<I, O>(
  firewall: StaleStateFirewall,
  spec: ProtectedToolSpec<I, O>,
): ProtectedTool<I, O> {
  firewall.assertToolNameAvailable(spec.name);
  firewall.registerProtectedTool(spec.name);

  const idempotencyOf = (input: I): IdempotencyKind =>
    typeof spec.idempotency === 'function' ? spec.idempotency(input) : (spec.idempotency ?? 'non_idempotent');

  const buildIntentInput = (input: I): ActionIntentInput => {
    const intent = spec.toIntent(input);
    return { ...intent, tool: intent.tool ?? spec.name };
  };


  const executorFor = (input: I): ActionExecutor => ({
    idempotency: idempotencyOf(input),
    atomicity: spec.atomicity,
    execute: async () => {
      const output = await spec.run(input);
      return { success: true, output };
    },
    ...(spec.conditionalRun
      ? {
          conditionalExecutionSupported: () =>
            typeof spec.conditionalExecutionSupported === 'function'
              ? spec.conditionalExecutionSupported(input)
              : (spec.conditionalExecutionSupported ?? true),
          conditionalExecute: async (_intent, expectedState) => {
            const run = await spec.conditionalRun!(input, expectedState);
            return run.applied
              ? { condition: 'satisfied' as const, success: true, output: run.output }
              : {
                  condition: 'failed' as const,
                  ref: run.ref ?? null,
                  observed_version: run.observed_version ?? null,
                  error: run.error,
                };
          },
        }
      : {}),
  });

  return {
    toolName: spec.name,

    async check(input: I): Promise<DecisionRecord> {
      const outcome = await firewall.check(buildIntentInput(input));
      return outcome;
    },

    async execute(input: I): Promise<O> {
      const outcome = await firewall.executeProtected(buildIntentInput(input), executorFor(input));
      if (!outcome.executed || !outcome.result || !outcome.result.success) {
        throw new BlockedActionError(outcome.decision, outcome.result ?? undefined);
      }
      return outcome.result.output as O;
    },
  };
}

export type { StateDependencyInput };
