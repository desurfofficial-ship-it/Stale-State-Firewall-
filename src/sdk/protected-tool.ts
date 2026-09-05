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

import type { ActionIntentInput, ActionExecutor, IdempotencyKind } from '../domain/action.js';
import type { DecisionRecord } from '../domain/decision.js';
import type { StateDependencyInput } from '../domain/state.js';
import { FirewallError } from '../domain/errors.js';
import type { StaleStateFirewall } from './firewall.js';

/** Raised when the firewall did not authorize the protected execution. */
export class BlockedActionError extends FirewallError {
  readonly decision: DecisionRecord;

  constructor(decision: DecisionRecord) {
    super({
      code: 'SSF_ACTION_BLOCKED',
      message: `action blocked by Stale-State Firewall: ${decision.decision} (${decision.reason})`,
      details: { decision_id: decision.decision_id, action_id: decision.action_id },
    });
    this.name = 'BlockedActionError';
    this.decision = decision;
  }
}

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
        throw new BlockedActionError(outcome.decision);
      }
      return outcome.result.output as O;
    },
  };
}

export type { StateDependencyInput };
