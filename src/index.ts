/**
 * Stale-State Firewall — public SDK surface.
 *
 * The firewall sits between an AI agent and the tools it acts with, and
 * blocks consequential actions that rely on stale, outdated, incomplete, or
 * invalid state. Enforcement is deterministic: no LLM participates in the
 * decision path.
 */

export { StaleStateFirewall } from './sdk/firewall.js';
export type { FirewallOptions, EscalationResolution, StateInspectionResult } from './sdk/firewall.js';
export { createProtectedTool, BlockedActionError } from './sdk/protected-tool.js';
export type { ProtectedTool, ProtectedToolSpec, ConditionalRunOutcome } from './sdk/protected-tool.js';

// Domain model
export type {
  ActionIntent,
  ActionIntentInput,
  ActionExecutor,
  ExecutionResult,
  ExpectedStateEntry,
  ConditionalExecutionResult,
  Precondition,
  PreconditionOperator,
  PRECONDITION_OPERATORS,
  RiskLevel,
  RISK_LEVELS,
  IdempotencyKind,
} from './domain/action.js';
export type { StateSnapshot, StateDependency, StateDependencyInput, ResourceReference, StateProvenance, refKey } from './domain/state.js';
export type { DecisionType, StalenessClass, DependencyVerdict, DecisionRecord, FirewallMode, PreconditionResult, DECISION_TYPES, STALENESS_CLASSES } from './domain/decision.js';
export type { FirewallPolicyConfig, FreshnessStrategy, OutcomeDecision, RiskDefaultsConfig, PolicyMatcher, ExecutionPolicyConfig, DependencyFreshnessRule, FRESHNESS_STRATEGIES, OUTCOME_DECISIONS } from './domain/policy.js';
export type { AuditRecord, AuditEventType, AuditEventPayload, AUDIT_EVENT_TYPES } from './domain/audit.js';
export type { FirewallEvent, FirewallEventType, EventBus } from './domain/events.js';

// Errors
export {
  FirewallError,
  ConfigurationError,
  PolicyValidationError,
  PolicyNotFoundError,
  ProviderUnavailableError,
  ProviderResponseError,
  StateUnavailableError,
  StateVersionMismatchError,
  PreconditionFailedError,
  ActionExpiredError,
  UnauthorizedActionError,
  ReplayDetectedError,
  EscalationPendingError,
  StorageError,
  isFirewallError,
} from './domain/errors.js';
export type { PolicyViolation } from './domain/errors.js';

// Providers
export { InMemoryStateProvider } from './providers/memory/in-memory-provider.js';
export type { InMemoryResource, InMemoryMutation } from './providers/memory/in-memory-provider.js';
export { HttpStateProvider } from './providers/http/http-provider.js';
export { GitHubStateProvider, aggregateReviews } from './providers/github/github-provider.js';
export type { GitHubProviderOptions } from './providers/github/github-provider.js';
export type {
  StateProvider,
  ConditionalMutationRequest,
  ConditionalMutationResult,
} from './providers/types.js';

// Configuration
export { loadConfigFile, resolveGlobalDefaults, resolvePolicyConfig } from './config/loader.js';
export { validateConfig } from './config/validation.js';
export type { FirewallRootConfigFile, PolicyTestCaseFile, HttpResourceConfig } from './config/schema.js';

// Engines (for custom integrations and testing)
export { decide } from './engine/decision-engine.js';
export { evaluateDependencies } from './engine/dependency-evaluator.js';
export { evaluateFreshness, UnavailableCurrentState } from './engine/freshness.js';
export { evaluatePrecondition, evaluatePreconditions, resolvePath } from './engine/preconditions.js';
export { assessAge, classifyByAge, worstOfAll, STALENESS_SEVERITY } from './engine/staleness.js';
export { resolvePolicy, resolveDependencyFreshness, matcherSpecificity, findAmbiguousMatchers } from './engine/policy-resolver.js';
export { resolveFreshness, resolveExecutionPolicy, buildDefaultFreshness, defaultDeadlineForRisk } from './engine/resolved-policy.js';
export type { ResolvedPolicy, ResolvedFreshness, GlobalDefaults } from './engine/resolved-policy.js';
export { SystemClock, ManualClock } from './engine/clock.js';
export type { Clock } from './engine/clock.js';
export { parseDurationMs, formatDurationMs } from './engine/duration.js';
export { globMatch } from './engine/glob.js';
export { canonicalJson, sha256Hex, contentHashOf } from './engine/hashing.js';

// Storage
export { MemoryStore } from './storage/memory/memory-store.js';
export { SqliteStore, GENESIS_HASH } from './storage/sqlite/store.js';
export type { FirewallStore, AuthorizationRecord, EscalationRecord, EscalationStatus } from './storage/types.js';

// Audit + telemetry + logging + redaction
export { AuditEngine, computeAuditHashes } from './audit/audit-engine.js';
export type { AuditChainVerification } from './audit/audit-engine.js';
export { MetricsRegistry } from './telemetry/metrics.js';
export type { MetricsSnapshot, MetricCounters } from './telemetry/metrics.js';
export { JsonLogger, SilentLogger } from './logging/logger.js';
export type { Logger, LogLevel } from './logging/logger.js';
export { redactDeep, REDACTED, isSensitiveKey } from './redaction/redact.js';
export { SynchronousEventBus } from './domain/events.js';

// Versioning
export { VERSION, POLICY_SCHEMA_VERSION, AUDIT_SCHEMA_VERSION } from './version.js';
