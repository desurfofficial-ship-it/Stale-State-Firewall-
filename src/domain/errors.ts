/**
 * Typed error hierarchy for Stale-State Firewall.
 *
 * Every failure mode is a distinct, catchable type (spec §54). Infrastructure
 * uncertainty must NEVER be silently converted into a successful validation
 * or an ALLOW decision (spec §26, invariant 7).
 *
 * Recovery contract (milestone: internal operationalization): every failure
 * that reaches an agent or operator carries `recovery` — the authoritative
 * answer to what failed, whether retrying is safe, and what to do next.
 */

import type { RecoveryGuidance } from './recovery.js';
import { guidanceFor, HUMAN_REVIEW_GUIDANCE } from './recovery.js';
import { classifyProviderFailure, type ProviderFailureKind } from '../providers/types.js';

export interface FirewallErrorOptions {
  code: string;
  message: string;
  details?: unknown;
  cause?: unknown;
  /** Machine-readable recovery contract (milestone §8/§9). */
  recovery?: RecoveryGuidance;
}

export class FirewallError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly recovery?: RecoveryGuidance;

  constructor(options: FirewallErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.recovery !== undefined) {
      this.recovery = options.recovery;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.recovery !== undefined ? { recovery: this.recovery } : {}),
    };
  }
}

/** Invalid or contradictory configuration; thrown before enforcement begins. */
export class ConfigurationError extends FirewallError {
  constructor(message: string, details?: unknown, cause?: unknown) {
    super({ code: 'SSF_CONFIGURATION', message, details, cause });
  }
}

/** Policy file failed schema or semantic validation. */
export class PolicyValidationError extends FirewallError {
  readonly violations: PolicyViolation[];

  constructor(violations: PolicyViolation[], cause?: unknown) {
    const summary = violations.length === 1
      ? violations[0]?.message
      : `${violations.length} policy violations`;
    super({ code: 'SSF_POLICY_INVALID', message: summary ?? 'policy invalid', details: { violations }, cause });
    this.name = 'PolicyValidationError';
    this.violations = violations;
  }
}

export interface PolicyViolation {
  path: string;
  message: string;
}

/** Referenced policy does not exist. */
export class PolicyNotFoundError extends ConfigurationError {
  constructor(policyName: string) {
    super(`policy not found: ${policyName}`, { policy: policyName });
  }
}

/**
 * A state provider could not be reached or timed out.
 *
 * Carries a `kind` from the internal provider-failure classification
 * (NOT_FOUND / RATE_LIMITED / TIMEOUT / NETWORK_ERROR / SERVER_ERROR / ...)
 * so callers branch deterministically instead of parsing messages, and the
 * provider-failure recovery contract (fail closed, then fresh evaluation).
 */
export class ProviderUnavailableError extends FirewallError {
  readonly kind: ProviderFailureKind;

  constructor(provider: string, message: string, details?: unknown, cause?: unknown) {
    const status = (details as { status?: number } | undefined)?.status ?? null;
    // The GitHub adapter reports quota exhaustion with status 403 plus an
    // explicit message marker; classify it as RATE_LIMITED, not FORBIDDEN.
    const kind = /rate limit exhausted/i.test(message)
      ? 'RATE_LIMITED' as ProviderFailureKind
      : classifyProviderFailure({ status, error: message });
    super({
      code: 'SSF_PROVIDER_UNAVAILABLE',
      message: `provider "${provider}" unavailable: ${message}`,
      details,
      cause,
      recovery: kind === 'RATE_LIMITED' ? guidanceFor('rate_limit') : guidanceFor('provider_failure'),
    });
    this.kind = kind;
  }
}

/**
 * A provider responded with malformed, partial, or unparseable state, or the
 * requested capability is not configured for the resource (kind: UNSUPPORTED).
 */
export class ProviderResponseError extends FirewallError {
  readonly kind: ProviderFailureKind;

  constructor(provider: string, message: string, details?: unknown, kind: ProviderFailureKind = 'UNSUPPORTED') {
    super({
      code: 'SSF_PROVIDER_RESPONSE',
      message: `provider "${provider}" returned malformed state: ${message}`,
      details,
      recovery: guidanceFor('provider_failure'),
    });
    this.kind = kind;
  }
}

/** Required state could not be established as valid. */
export class StateUnavailableError extends FirewallError {
  constructor(ref: string, message: string) {
    super({ code: 'SSF_STATE_UNAVAILABLE', message: `state unavailable for ${ref}: ${message}`, details: { ref } });
  }
}

/** Observed version no longer matches the current version. */
export class StateVersionMismatchError extends FirewallError {
  constructor(ref: string, observedVersion: string | null, currentVersion: string | null) {
    super({
      code: 'SSF_STATE_VERSION_MISMATCH',
      message: `state for ${ref} changed after it was observed`,
      details: { ref, observed_version: observedVersion, current_version: currentVersion },
    });
  }
}

/** A required precondition does not hold against current state. */
export class PreconditionFailedError extends FirewallError {
  constructor(field: string, operator: string, details?: unknown) {
    super({
      code: 'SSF_PRECONDITION_FAILED',
      message: `precondition failed: ${operator} on "${field}"`,
      details,
    });
  }
}

/** Execution attempted after the authorization window closed. */
export class ActionExpiredError extends FirewallError {
  constructor(actionId: string, expiredAt: string) {
    super({
      code: 'SSF_ACTION_EXPIRED',
      message: `action ${actionId} authorization expired at ${expiredAt}`,
      details: { action_id: actionId, expired_at: expiredAt },
      recovery: guidanceFor('authorization_expired'),
    });
  }
}

/** Caller is not permitted to perform this operation through this surface. */
export class UnauthorizedActionError extends FirewallError {
  constructor(message: string, details?: unknown) {
    super({ code: 'SSF_UNAUTHORIZED', message, details, recovery: HUMAN_REVIEW_GUIDANCE });
  }
}

/** A previously authorized or already-executed action was replayed. */
export class ReplayDetectedError extends FirewallError {
  constructor(actionId: string, details?: unknown) {
    super({
      code: 'SSF_REPLAY_DETECTED',
      message: `replay detected for action ${actionId}; authorization cannot be reused`,
      details,
      recovery: guidanceFor('replay'),
    });
  }
}

/** An action is awaiting human escalation and cannot proceed. */
export class EscalationPendingError extends FirewallError {
  constructor(actionId: string) {
    super({
      code: 'SSF_ESCALATION_PENDING',
      message: `action ${actionId} requires human approval before it can proceed`,
      details: { action_id: actionId },
      recovery: HUMAN_REVIEW_GUIDANCE,
    });
  }
}

/** Local storage failed to open, migrate, or persist. */
export class StorageError extends FirewallError {
  constructor(message: string, details?: unknown, cause?: unknown) {
    super({ code: 'SSF_STORAGE', message, details, cause });
  }
}

/** The execution deadline passed while the action was in flight. */
export class ActionDeadlineExceededError extends FirewallError {
  constructor(actionId: string, deadlineMs: number) {
    super({
      code: 'SSF_ACTION_DEADLINE_EXCEEDED',
      message: `action ${actionId} exceeded its execution deadline (${deadlineMs}ms)`,
      details: { action_id: actionId, deadline_ms: deadlineMs },
    });
  }
}

export function isFirewallError(error: unknown): error is FirewallError {
  return error instanceof FirewallError;
}
