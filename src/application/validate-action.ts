/**
 * Validate-action use case: the dry-run core of the firewall (spec §6, §19).
 *
 * Flow:
 *   normalize intent -> resolve policy -> fetch CURRENT state per dependency
 *   -> classify staleness -> evaluate preconditions -> compose decision
 *   -> persist + audit.
 *
 * No side effects beyond local persistence/audit: nothing is executed, no
 * authorization is created, no escalation is requested.
 */

import type { ActionIntent, ActionIntentInput, Precondition, RiskLevel } from '../domain/action.js';
import type { DecisionRecord, FirewallMode } from '../domain/decision.js';
import type { StateSnapshot, StateDependency } from '../domain/state.js';
import type { ResolvedPolicy, GlobalDefaults } from '../engine/resolved-policy.js';
import { defaultDeadlineForRisk } from '../engine/resolved-policy.js';
import { PolicyNotFoundError } from '../domain/errors.js';
import { normalizeIntent } from './normalize-intent.js';
import type { FirewallContext } from './context.js';
import { resolvePolicy, resolveDependencyFreshness } from '../engine/policy-resolver.js';
import { evaluateDependencies } from '../engine/dependency-evaluator.js';
import { decide } from '../engine/decision-engine.js';
import { refKey } from '../domain/state.js';
import { contentHashOf } from '../engine/hashing.js';
import { newId, ID_PREFIXES } from '../domain/identifiers.js';
import { resolveGlobalDefaults } from '../config/loader.js';
import type { FirewallRootConfigFile } from '../config/schema.js';
import { resolvePolicyConfig } from '../config/loader.js';

export interface ValidationOutcome {
  intent: ActionIntent;
  decision: DecisionRecord;
  policy: ResolvedPolicy;
  /** Fresh snapshots captured during validation. */
  snapshots: StateSnapshot[];
  /** Hash over fetched version signals; basis for TOCTOU re-verification. */
  stateFingerprint: string;
  elapsedMs: number;
}

/** Builds the runtime policy set from a validated config file object. */
export function buildPolicyCore(file: FirewallRootConfigFile): {
  policies: ResolvedPolicy[];
  defaults: GlobalDefaults;
  mode: FirewallMode;
} {
  return {
    policies: (file.actions ?? []).map(resolvePolicyConfig),
    defaults: resolveGlobalDefaults(file),
    mode: file.firewall.mode.toUpperCase() as FirewallMode,
  };
}

/** Full validation pipeline shared by check() and execute(). */
export async function validateAction(
  ctx: FirewallContext,
  intentInput: ActionIntentInput,
  options: { actionId?: string } = {},
): Promise<ValidationOutcome> {
  const startedMs = ctx.clock.nowMs();

  const intent = normalizeIntent(intentInput, ctx.clock.nowMs());
  if (options.actionId) {
    intent.action_id = options.actionId;
  }

  // Explicitly named policy must exist — fail closed, never silently default.
  if (intent.policy_name && !ctx.policies.some((p) => p.name === intent.policy_name)) {
    throw new PolicyNotFoundError(intent.policy_name);
  }

  const resolution = resolvePolicy({
    intent,
    policies: ctx.policies,
    defaults: ctx.defaults,
    riskDefaults: ctx.riskDefaults,
  });
  const policy = resolution.policy;
  intent.risk_level = resolution.risk;

  await ctx.store.saveAction(intent);

  ctx.audit.append('action.proposed', {
    action_id: intent.action_id,
    agent_id: intent.agent_id,
    tool: intent.tool,
    operation: intent.operation,
    target: intent.target,
    risk_level: intent.risk_level,
    dependencies: intent.dependencies.map(refKey),
  });

  const evaluation = await evaluateDependencies({
    dependencies: intent.dependencies,
    policyFreshness: policy.freshness,
    resolveDependencyFreshness: (dep) => resolveDependencyFreshness(policy, dep, policy.freshness),
    preconditions: collectPreconditions(policy, intent),
    providers: ctx.providers,
    nowMs: ctx.clock.nowMs(),
    nowIso: ctx.clock.nowIso(),
    events: ctx.events,
  });

  for (const snapshot of evaluation.fetched) {
    await ctx.store.saveSnapshot(snapshot);
  }

  const decisionOutput = decide({
    intent,
    policy,
    defaults: ctx.defaults,
    verdicts: evaluation.verdicts,
    mode: ctx.mode,
    revalidated: false,
  });

  const computedAt = ctx.clock.nowMs();
  const deadlineMs = policy.execution.deadlineMs ?? defaultDeadlineForRisk(intent.risk_level ?? 'MEDIUM');
  const record = buildDecisionRecord({
    ctx,
    intent,
    policy,
    decision: decisionOutput.decision,
    reason: decisionOutput.reason,
    verdicts: evaluation.verdicts,
    deadlineMs,
    revalidated: false,
    computedAt,
  });

  // OBSERVE mode: nothing is blocked; the would-be decision is preserved.
  if (ctx.mode === 'OBSERVE' && record.decision !== 'ALLOW') {
    record.would_have_decided = record.decision;
    record.decision = 'ALLOW';
    record.reason = `OBSERVE mode: decision recorded without blocking. ${record.reason}`;
  }

  await ctx.store.saveDecision(record);

  ctx.audit.append('action.validated', {
    action_id: intent.action_id,
    agent_id: intent.agent_id,
    tool: intent.tool,
    operation: intent.operation,
    target: intent.target,
    decision: record.decision,
    would_have: record.would_have_decided,
    policy: policy.name,
    policy_version: ctx.policyVersion,
    mode: ctx.mode,
    risk_level: intent.risk_level,
    dependency_verdicts: evaluation.verdicts.map((verdict) => ({
      dependency: refKey(verdict.dependency),
      staleness: verdict.staleness,
      observed_version: verdict.observed_version,
      current_version: verdict.current_version,
    })),
    reason: record.reason,
    execution_status: 'not_executed',
    latency_ms: computedAt - startedMs,
  });

  ctx.metrics.increment('actions_checked');
  if (record.decision === 'ALLOW') ctx.metrics.increment('actions_allowed');
  else if (record.decision === 'DENY') ctx.metrics.increment('actions_denied');
  else if (record.decision === 'REVALIDATE') ctx.metrics.increment('actions_revalidated');
  else if (record.decision === 'ESCALATE') ctx.metrics.increment('actions_escalated');

  for (const verdict of evaluation.verdicts) {
    if (verdict.staleness === 'STALE' || verdict.staleness === 'AGING') {
      ctx.metrics.increment('stale_state_events');
    }
    if (verdict.staleness === 'UNKNOWN') {
      ctx.metrics.increment('provider_failures');
    }
  }

  return {
    intent,
    decision: record,
    policy,
    snapshots: evaluation.fetched,
    stateFingerprint: fingerprintOf(evaluation.fetched),
    elapsedMs: ctx.clock.nowMs() - startedMs,
  };
}

export function collectPreconditions(policy: ResolvedPolicy, intent: ActionIntent): Precondition[] {
  return [...policy.preconditions, ...intent.preconditions];
}

export function buildDecisionRecord(params: {
  ctx: FirewallContext;
  intent: ActionIntent;
  policy: ResolvedPolicy;
  decision: DecisionRecord['decision'];
  reason: string;
  verdicts: DecisionRecord['verdicts'];
  deadlineMs: number;
  revalidated: boolean;
  computedAt: number;
  execution?: DecisionRecord['execution'];
}): DecisionRecord {
  const { ctx, intent, policy } = params;
  return {
    decision_id: newId(ID_PREFIXES.decision, params.computedAt),
    action_id: intent.action_id,
    agent_id: intent.agent_id,
    tool: intent.tool,
    operation: intent.operation,
    target: intent.target,
    risk_level: (intent.risk_level ?? 'MEDIUM') as RiskLevel,
    decision: params.decision,
    would_have_decided: null,
    reason: params.reason,
    policy_name: policy.name,
    policy_version: ctx.policyVersion,
    mode: ctx.mode,
    verdicts: params.verdicts,
    stale_dependencies: params.verdicts.filter((v) => v.staleness === 'STALE').map((v) => refKey(v.dependency)),
    invalid_dependencies: params.verdicts.filter((v) => v.staleness === 'INVALID').map((v) => refKey(v.dependency)),
    unknown_dependencies: params.verdicts.filter((v) => v.staleness === 'UNKNOWN').map((v) => refKey(v.dependency)),
    preconditions: params.verdicts.flatMap((v) => v.preconditions),
    created_at: new Date(params.computedAt).toISOString(),
    expires_at:
      params.decision === 'ALLOW'
        ? new Date(params.computedAt + params.deadlineMs).toISOString()
        : null,
    revalidated: params.revalidated,
    execution: params.execution ?? null,
  };
}

export function fingerprintOf(snapshots: readonly StateSnapshot[]): string {
  return contentHashOf(
    snapshots.map((s) => ({
      ref: `${s.source}:${s.resource}/${s.resource_id}`,
      version: s.version,
      content_hash: s.content_hash,
    })),
  );
}

export type { StateDependency };
