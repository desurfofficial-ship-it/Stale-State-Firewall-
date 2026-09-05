/**
 * Typed error hierarchy for Stale-State Firewall.
 *
 * Every failure mode is a distinct, catchable type (spec §54). Infrastructure
 * uncertainty must NEVER be silently converted into a successful validation
 * or an ALLOW decision (spec §26, invariant 7).
 */

export interface FirewallErrorOptions {
  code: string;
  message: string;
  details?: unknown;
  cause?: unknown;
}

export class FirewallError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(options: FirewallErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
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

/** A state provider could not be reached or timed out. */
export class ProviderUnavailableError extends FirewallError {
  constructor(provider: string, message: string, details?: unknown, cause?: unknown) {
    super({ code: 'SSF_PROVIDER_UNAVAILABLE', message: `provider "${provider}" unavailable: ${message}`, details, cause });
  }
}

/** A provider responded with malformed, partial, or unparseable state. */
export class ProviderResponseError extends FirewallError {
  constructor(provider: string, message: string, details?: unknown) {
    super({ code: 'SSF_PROVIDER_RESPONSE', message: `provider "${provider}" returned malformed state: ${message}`, details });
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
    });
  }
}

/** Caller is not permitted to perform this operation through this surface. */
export class UnauthorizedActionError extends FirewallError {
  constructor(message: string, details?: unknown) {
    super({ code: 'SSF_UNAUTHORIZED', message, details });
  }
}

/** A previously authorized or already-executed action was replayed. */
export class ReplayDetectedError extends FirewallError {
  constructor(actionId: string, details?: unknown) {
    super({
      code: 'SSF_REPLAY_DETECTED',
      message: `replay detected for action ${actionId}; authorization cannot be reused`,
      details,
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
