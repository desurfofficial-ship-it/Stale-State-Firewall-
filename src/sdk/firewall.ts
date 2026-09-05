/**
 * StaleStateFirewall SDK (spec §15, §55).
 *
 *   import { StaleStateFirewall } from 'stale-state-firewall';
 *   const firewall = await StaleStateFirewall.create({ configPath: './ssf.config.yaml' });
 *   const safeTool = firewall.protect({ name: 'github', run, toIntent });
 *   await safeTool.execute(input);
 *
 * Core operations:
 *   check()          dry-run validation; no side effects
 *   execute()        validated execution through the enforcement boundary
 *   protect()        wrap a tool behind the enforcement boundary
 *   inspectState()   fetch + classify current state
 *   resolveEscalation()  human approval for ESCALATE decisions
 *
 * The firewall is deterministic: no LLM is consulted anywhere in the
 * enforcement path (spec §42, §43).
 */

import type {
  ActionExecutor,
  ActionIntentInput,
  RiskLevel,
} from '../domain/action.js';
import type { DecisionRecord, FirewallMode } from '../domain/decision.js';
import type { StateDependency, StateSnapshot } from '../domain/state.js';
import type { AuditRecord } from '../domain/audit.js';
import type { EscalationRecord, EscalationStatus, FirewallStore } from '../storage/types.js';
import type { StateProvider } from '../providers/types.js';
import type { Clock } from '../engine/clock.js';
import { SystemClock } from '../engine/clock.js';
import type { Logger } from '../logging/logger.js';
import { JsonLogger, SilentLogger } from '../logging/logger.js';
import { SynchronousEventBus } from '../domain/events.js';
import { MetricsRegistry, type MetricsSnapshot } from '../telemetry/metrics.js';
import { AuditEngine, type AuditChainVerification } from '../audit/audit-engine.js';
import { PolicyValidationError, ConfigurationError } from '../domain/errors.js';
import { loadConfigFile } from '../config/loader.js';
import type { FirewallRootConfigFile } from '../config/schema.js';
import { validateConfig } from '../config/validation.js';
import { normalizeConfigFile } from '../config/normalize.js';
import { MemoryStore } from '../storage/memory/memory-store.js';
import { SqliteStore } from '../storage/sqlite/store.js';
import { InMemoryStateProvider } from '../providers/memory/in-memory-provider.js';
import { HttpStateProvider } from '../providers/http/http-provider.js';
import { GitHubStateProvider } from '../providers/github/github-provider.js';
import type { FirewallContext } from '../application/context.js';
import { validateAction, buildPolicyCore, type ValidationOutcome } from '../application/validate-action.js';
import { executeAction, executeApprovedAction, type ExecutionOutcome } from '../application/execute-action.js';
import { inspectState } from '../application/inspect-state.js';
import { newId, ID_PREFIXES } from '../domain/identifiers.js';
import { POLICY_SCHEMA_VERSION, VERSION } from '../version.js';
import { createProtectedTool, type ProtectedTool, type ProtectedToolSpec } from './protected-tool.js';
import { redactDeep } from '../redaction/redact.js';

export interface FirewallOptions {
  /** Inline configuration object (validated). */
  config?: FirewallRootConfigFile;
  /** Path to ssf.config.yaml (YAML or JSON). */
  configPath?: string;
  /** Injectable clock; defaults to the system clock. */
  clock?: Clock;
  /** Injectable store; overrides config.firewall.storage. */
  store?: FirewallStore;
  /** Extra providers; take precedence over config-assembled providers. */
  providers?: StateProvider[];
  logger?: Logger;
  /** Enable console JSON logging (default: silent in SDK, logs in CLI). */
  logging?: boolean;
}

export interface EscalationResolution {
  action_id: string;
  status: 'APPROVED' | 'REJECTED';
  resolved_by: string;
  resolved_at: string;
}

export class StaleStateFirewall {
  private ctx: FirewallContext | null = null;
  private readonly options: FirewallOptions;
  private readonly protectedToolNames = new Set<string>();
  private readonly clock: Clock;

  constructor(options: FirewallOptions = {}) {
    if (!options.config && !options.configPath) {
      throw new ConfigurationError(
        'StaleStateFirewall requires either `config` or `configPath` (see ssf init for a template)',
      );
    }
    this.options = options;
    this.clock = options.clock ?? new SystemClock();
  }

  /** Creates, validates, and initializes the firewall. */
  static async create(options: FirewallOptions = {}): Promise<StaleStateFirewall> {
    const firewall = new StaleStateFirewall(options);
    await firewall.init();
    return firewall;
  }

  async init(): Promise<void> {
    if (this.ctx) return;

    let file: FirewallRootConfigFile;
    if (this.options.config) {
      file = normalizeConfigFile(this.options.config);
      const violations = validateConfig(file);
      if (violations.length > 0) {
        throw new PolicyValidationError(violations);
      }
    } else {
      file = loadConfigFile(this.options.configPath!).file;
    }

    const core = buildPolicyCore(file);
    const mode: FirewallMode = core.mode;
    const logger = this.options.logger ?? (this.options.logging === true
      ? new JsonLogger({ level: file.logging?.level ?? 'info', redact: file.logging?.redact ?? true })
      : new SilentLogger());

    const store = this.options.store ?? (await buildStore(file));
    await store.init();

    const providers = await buildProviders(file, this.options.providers ?? []);
    const events = new SynchronousEventBus();
    const metrics = new MetricsRegistry();
    const audit = new AuditEngine({
      store,
      clockIso: () => this.clock.nowIso(),
      nowMs: () => this.clock.nowMs(),
    });

    this.ctx = {
      clock: this.clock,
      providers,
      store,
      audit,
      events,
      metrics,
      logger,
      policies: core.policies,
      defaults: core.defaults,
      riskDefaults: null,
      mode,
      policyVersion: POLICY_SCHEMA_VERSION,
    };
  }

  private requireCtx(): FirewallContext {
    if (this.ctx === null) {
      throw new ConfigurationError('firewall is not initialized; await StaleStateFirewall.create(...) first');
    }
    return this.ctx;
  }

  // ---- Core operations ----------------------------------------------------

  /** Dry-run validation: full decision pipeline, no side effects. */
  async check(intent: ActionIntentInput): Promise<DecisionRecord> {
    const ctx = this.requireCtx();
    const outcome: ValidationOutcome = await validateAction(ctx, intent);
    return outcome.decision;
  }

  /**
   * Validated execution. The executor runs only after an ALLOW decision,
   * with an immediate pre-execution freshness re-verification. Pass
   * `actionId` to pin the identity across attempts (replay protection).
   */
  async execute(
    intent: ActionIntentInput,
    executor: ActionExecutor,
    options: { actionId?: string } = {},
  ): Promise<ExecutionOutcome> {
    const ctx = this.requireCtx();
    return executeAction(ctx, intent, executor, options);
  }

  /** Executes an escalation that a human has approved; freshness is re-verified. */
  async executeApproved(actionId: string, intent: ActionIntentInput, executor: ActionExecutor): Promise<ExecutionOutcome> {
    const ctx = this.requireCtx();
    return executeApprovedAction(ctx, actionId, intent, executor);
  }

  /**
   * Wraps a tool behind the enforcement boundary (spec §14). The original
   * tool is only reachable through the firewall's executor closure.
   */
  protect<I, O>(spec: ProtectedToolSpec<I, O>): ProtectedTool<I, O> {
    this.requireCtx();
    return createProtectedTool(this, spec);
  }

  /** Fetches and classifies current state for a reference (read-only). */
  async inspectState(ref: Omit<StateDependency, 'metadata'> & { metadata?: Record<string, unknown> }): Promise<StateInspectionResult> {
    const ctx = this.requireCtx();
    const inspection = await inspectState(ctx, ref as StateDependency);
    return {
      snapshot: inspection.snapshot,
      age_ms: inspection.age_ms,
      note: inspection.note,
    };
  }

  // ---- Escalations ----------------------------------------------------------

  async listEscalations(status?: EscalationStatus): Promise<EscalationRecord[]> {
    const ctx = this.requireCtx();
    return ctx.store.listEscalations(status);
  }

  async resolveEscalation(
    actionId: string,
    resolution: { approved: boolean; by: string; note?: string },
  ): Promise<EscalationResolution> {
    const ctx = this.requireCtx();
    const escalation = await ctx.store.getEscalation(actionId);
    if (!escalation) {
      throw new ConfigurationError(`no pending escalation for action ${actionId}`);
    }
    if (escalation.status !== 'PENDING') {
      throw new ConfigurationError(`escalation for action ${actionId} is already ${escalation.status}`);
    }
    const at = this.clock.nowIso();
    const status = resolution.approved ? 'APPROVED' : 'REJECTED';
    await ctx.store.resolveEscalation(actionId, status, resolution.by, resolution.note ?? null, at);
    ctx.metrics.increment('escalations_resolved');
    ctx.audit.append('action.escalation_resolved', {
      action_id: actionId,
      decision: 'ESCALATE',
      reason: `escalation ${status.toLowerCase()} by ${resolution.by}${resolution.note ? `: ${resolution.note}` : ''}`,
    });
    return { action_id: actionId, status, resolved_by: resolution.by, resolved_at: at };
  }

  // ---- Introspection --------------------------------------------------------

  getMetrics(): MetricsSnapshot {
    return this.requireCtx().metrics.snapshot();
  }

  async auditTail(limit = 50): Promise<AuditRecord[]> {
    const ctx = this.requireCtx();
    return ctx.audit.tail(limit);
  }

  async verifyAudit(): Promise<AuditChainVerification> {
    const ctx = this.requireCtx();
    return ctx.audit.verify();
  }

  get version(): string {
    return VERSION;
  }

  get mode(): FirewallMode {
    return this.requireCtx().mode;
  }

  /** Latest stored snapshot for a reference, if any. */
  async latestSnapshot(ref: { source: string; resource: string; resource_id: string }): Promise<StateSnapshot | null> {
    const ctx = this.requireCtx();
    return ctx.store.getLatestSnapshot(ref);
  }

  async latestDecision(actionId: string): Promise<DecisionRecord | null> {
    const ctx = this.requireCtx();
    return ctx.store.getLatestDecision(actionId);
  }

  // ---- Internal hooks for ProtectedTool -------------------------------------

  assertToolNameAvailable(name: string): void {
    if (this.protectedToolNames.has(name)) {
      throw new ConfigurationError(
        `tool "${name}" is already protected; wrapping the same tool twice could create a bypass path`,
      );
    }
  }

  registerProtectedTool(name: string): void {
    this.protectedToolNames.add(name);
  }

  /** ProtectedTool execution path: identical guarantees to execute(). */
  async executeProtected(intent: ActionIntentInput, executor: ActionExecutor): Promise<ExecutionOutcome> {
    const ctx = this.requireCtx();
    return executeAction(ctx, intent, executor);
  }

  async auditAppendTestEvent(eventType: Parameters<FirewallContext['audit']['append']>[0], payload: Record<string, unknown>): Promise<void> {
    const ctx = this.requireCtx();
    await ctx.audit.append(eventType, redactDeep(payload));
  }

  /** Generates a server-side action id for flows that pre-allocate ids. */
  newActionId(): string {
    return newId(ID_PREFIXES.action, this.clock.nowMs());
  }

  async close(): Promise<void> {
    if (this.ctx) {
      await this.ctx.store.close();
      this.ctx = null;
    }
  }
}

export interface StateInspectionResult {
  snapshot: StateSnapshot;
  age_ms: number | null;
  note: string;
}

async function buildStore(file: FirewallRootConfigFile): Promise<FirewallStore> {
  const storage = file.firewall.storage ?? { type: 'sqlite' as const, path: './ssf-state.db' };
  if (storage.type === 'memory') {
    return new MemoryStore();
  }
  const path = storage.path ?? './ssf-state.db';
  return new SqliteStore({ path });
}

async function buildProviders(file: FirewallRootConfigFile, extra: StateProvider[]): Promise<StateProvider[]> {
  const providers: StateProvider[] = [...extra];
  const configured = file.providers ?? {};
  const enabledSources = new Set(providers.map((p) => p.name));

  if (configured.memory?.enabled === true) {
    const source = configured.memory.source ?? 'memory';
    if (!enabledSources.has(source)) {
      providers.push(new InMemoryStateProvider(source));
    }
  }
  if (configured.http?.enabled === true) {
    const resources = configured.http.resources ?? {};
    providers.push(new HttpStateProvider(resources));
  }
  if (configured.github?.enabled === true) {
    providers.push(
      new GitHubStateProvider({
        apiBase: configured.github.api_base ?? 'https://api.github.com',
        timeoutMs: configured.github.timeout_ms ?? 5000,
        includeReviews: configured.github.include_reviews ?? true,
      }),
    );
  }
  return providers;
}

export type { RiskLevel };
