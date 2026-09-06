/**
 * Recovery contract (milestone: internal operationalization, spec §8/§9/§11).
 *
 * Every failure the firewall surfaces to an agent or operator carries a
 * machine-readable recovery contract: WHAT failed (failure_kind), whether
 * retrying is safe (retry_safety), whether the side effect may have
 * occurred, whether the authorization can still be used, and the
 * deterministic next steps.
 *
 * The contract is a closed table, not a heuristic: the same failure kind
 * always produces the same guidance. This is the authoritative answer to
 * "when is retry safe?" — do not improvise per-call-site wording.
 */

/**
 * Retry-safety classification (milestone §8).
 *
 * - SAFE: the failure says nothing about the world or the effect; a new
 *   attempt (which always includes a mandatory fresh validation) may
 *   proceed immediately.
 * - SAFE_ONLY_AFTER_FRESH_EVALUATION: nothing unsafe happened, but the
 *   basis of the old authorization is gone or stale. Re-observe state,
 *   recompute the action, obtain a NEW authorization; never reuse the old
 *   one. A blind retry under the same authorization is refused by replay
 *   protection anyway.
 * - UNSAFE: the side effect may already have occurred (or the action
 *   already ran). Retrying without first inspecting external state risks
 *   a duplicate application. Inspect, reconcile, then re-attempt with a
 *   NEW action id and authorization if still needed.
 * - REQUIRES_HUMAN_REVIEW: a human must decide (pending/rejected
 *   escalation, approval-binding mismatch).
 */
export type RetrySafety =
  | 'SAFE'
  | 'SAFE_ONLY_AFTER_FRESH_EVALUATION'
  | 'UNSAFE'
  | 'REQUIRES_HUMAN_REVIEW';

/**
 * The failure kinds every recovery path is classified into (milestone §8).
 * Provider transport faults are refined by the provider failure
 * classification (see `classifyProviderFailure`), but the retry contract
 * is defined at this level.
 */
export type FailureKind =
  | 'condition_failed'
  | 'provider_failure'
  | 'timeout'
  | 'rate_limit'
  | 'unknown_execution_outcome'
  | 'authorization_expired'
  | 'replay'
  /**
   * The firewall made a deterministic DECISION not to proceed (DENY,
   * REVALIDATE-final, ESCALATE hold). This is not a provider fault and not a
   * runtime failure — it is policy enforcement. It is classified separately
   * so the retry contract stays truthful: the remedy is fresh evaluation
   * (or human review for escalations), never a blind re-run.
   */
  | 'policy_blocked';

/** Machine-readable recovery contract attached to failures and results. */
export interface RecoveryGuidance {
  failure_kind: FailureKind;
  retry_safety: RetrySafety;
  /** Whether the authorization that produced this failure can still be used. */
  authorization_usable: boolean;
  /** Whether the external side effect may have occurred. */
  side_effect_possible: boolean;
  /** Deterministic next steps, in order, for agents and humans. */
  next_steps: string[];
}

const CONDITION_FAILED: RecoveryGuidance = {
  failure_kind: 'condition_failed',
  retry_safety: 'SAFE_ONLY_AFTER_FRESH_EVALUATION',
  authorization_usable: false,
  side_effect_possible: false,
  next_steps: [
    'The provider refused the operation because its authoritative state no longer matches the authorized expected state; no side effect occurred.',
    'Discard this authorization (it is already consumed and cannot be reused).',
    'Fetch fresh current state for every declared dependency.',
    'Recompute the action from the fresh state and submit a NEW action for a NEW authorization.',
    'Never retry this action under the same authorization — blind retries are refused and unsafe.',
  ],
};

const PROVIDER_FAILURE: RecoveryGuidance = {
  failure_kind: 'provider_failure',
  retry_safety: 'SAFE_ONLY_AFTER_FRESH_EVALUATION',
  authorization_usable: false,
  side_effect_possible: false,
  next_steps: [
    'A provider fault occurred before any side effect was authorized to proceed.',
    'Re-run the action as a NEW attempt: the mandatory fresh-state validation will re-decide it.',
    'If the provider remains unavailable, the fresh validation fails closed (REVALIDATE/DENY) — this is correct, not a malfunction.',
    'Never convert a provider failure into a success or bypass the firewall to "get it done".',
  ],
};

const RATE_LIMITED: RecoveryGuidance = {
  failure_kind: 'rate_limit',
  retry_safety: 'SAFE_ONLY_AFTER_FRESH_EVALUATION',
  authorization_usable: false,
  side_effect_possible: false,
  next_steps: [
    'The provider rate-limited the request; no side effect occurred.',
    'Back off until the provider quota resets (see the error details for the reset time when available).',
    'Re-run the action as a NEW attempt; the fresh-state validation re-decides it against current state.',
  ],
};

const TIMEOUT: RecoveryGuidance = {
  failure_kind: 'timeout',
  retry_safety: 'SAFE_ONLY_AFTER_FRESH_EVALUATION',
  authorization_usable: false,
  side_effect_possible: false,
  next_steps: [
    'A provider request timed out during validation; no side effect occurred.',
    'Re-run the action as a NEW attempt; the fresh-state validation re-decides it.',
    'A timeout during EXECUTION is different: the firewall records an unknown execution outcome — inspect external state before any retry.',
  ],
};

const UNKNOWN_OUTCOME: RecoveryGuidance = {
  failure_kind: 'unknown_execution_outcome',
  retry_safety: 'UNSAFE',
  authorization_usable: false,
  side_effect_possible: true,
  next_steps: [
    'The request was sent to the provider, but the outcome of the conditional operation is UNKNOWN: the side effect may or may not have been applied.',
    'Do NOT retry and do NOT replay the same authorization — a blind retry risks a duplicate application.',
    'Inspect the external system directly to determine whether the side effect occurred.',
    'If the effect did not occur and the action is still wanted, create a NEW action (fresh observation, new authorization) and execute again.',
    'The firewall deliberately never guesses: success is claimed only when the provider affirmed it.',
  ],
};

const AUTHORIZATION_EXPIRED: RecoveryGuidance = {
  failure_kind: 'authorization_expired',
  retry_safety: 'SAFE',
  authorization_usable: false,
  side_effect_possible: false,
  next_steps: [
    'The authorization window closed before execution; nothing was executed and no side effect occurred.',
    'Re-attempt the action as a NEW action: the mandatory fresh-state validation makes this safe.',
    'The expired authorization cannot be extended or reused.',
  ],
};

const REPLAY: RecoveryGuidance = {
  failure_kind: 'replay',
  retry_safety: 'UNSAFE',
  authorization_usable: false,
  side_effect_possible: true,
  next_steps: [
    'This action id was already authorized and consumed (or holds a live authorization elsewhere): one action id gets exactly one authorization and one execution attempt.',
    'Do NOT repeat the action under the same authorization.',
    'If you do not know whether the original attempt executed, inspect the external system first.',
    'Re-attempt only as a NEW action id with a fresh authorization.',
  ],
};

const HUMAN_REVIEW: RecoveryGuidance = {
  failure_kind: 'policy_blocked',
  retry_safety: 'REQUIRES_HUMAN_REVIEW',
  authorization_usable: false,
  side_effect_possible: false,
  next_steps: [
    'A human decision is required before this action can proceed (or the action is permanently held).',
    'Read the escalation record and the decision reason; do not attempt to work around the hold.',
  ],
};

/**
 * Guidance for deterministic decision blocks (DENY / final REVALIDATE):
 * nothing executed; a new attempt re-decides from fresh state.
 */
export const POLICY_BLOCKED: RecoveryGuidance = {
  failure_kind: 'policy_blocked',
  retry_safety: 'SAFE_ONLY_AFTER_FRESH_EVALUATION',
  authorization_usable: false,
  side_effect_possible: false,
  next_steps: [
    'The firewall made a deterministic decision not to proceed; nothing executed and no side effect occurred.',
    'Read the decision reason: it names the dependency versions, staleness class, failed preconditions, or policy requirement that drove the decision.',
    'Fetch fresh current state for every declared dependency and recompute the action.',
    'Submit a NEW action for a NEW authorization; if the state genuinely moved you will be re-decided accordingly.',
    'Do not modify the declared state, risk, or policy to evade the decision — that is a policy violation, not a recovery.',
  ],
};

/**
 * The authoritative failure-kind → guidance table. Exported for tests and
 * documentation; every failure surface must draw its guidance from here.
 */
export const RETRY_SEMANTICS: Readonly<Record<FailureKind, RecoveryGuidance>> = {
  condition_failed: CONDITION_FAILED,
  provider_failure: PROVIDER_FAILURE,
  rate_limit: RATE_LIMITED,
  timeout: TIMEOUT,
  unknown_execution_outcome: UNKNOWN_OUTCOME,
  authorization_expired: AUTHORIZATION_EXPIRED,
  replay: REPLAY,
  policy_blocked: POLICY_BLOCKED,
};

/** Guidance for failures that require a human decision (escalation holds). */
export const HUMAN_REVIEW_GUIDANCE: RecoveryGuidance = HUMAN_REVIEW;

/** Returns the guidance for a failure kind (same object every time — do not mutate). */
export function guidanceFor(kind: FailureKind): RecoveryGuidance {
  return RETRY_SEMANTICS[kind];
}
