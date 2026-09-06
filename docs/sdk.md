# SDK reference

## Creating a firewall

```ts
import { StaleStateFirewall } from 'stale-state-firewall';

// From ssf.config.yaml (recommended; validated at startup)
const firewall = await StaleStateFirewall.create({ configPath: './ssf.config.yaml' });

// Or inline (also fully validated)
const fw2 = await StaleStateFirewall.create({
  config: {
    firewall: { mode: 'enforce', storage: { type: 'memory' } },
    actions: [/* policies */],
  },
  clock: myInjectableClock,     // optional; ManualClock for tests
  store: myStore,               // optional; overrides storage config
  providers: [myProvider],      // optional; precedence over config-assembled
});
```

Startup is fail-fast: an invalid configuration throws `PolicyValidationError` with the full violation list before any enforcement begins.

## check(intent) — dry run

```ts
const decision = await firewall.check({
  agent_id: 'release-agent',
  tool: 'deploy',
  operation: 'deploy_production',
  target: 'production',
  dependencies: [
    { source: 'http', resource: 'deployment', resource_id: 'production', version: 'v41' },
  ],
  preconditions: [{ field: 'status', operator: 'equals', value: 'healthy' }],
});
```

Returns a `DecisionRecord` (decision, reason, per-dependency verdicts, policy, expiry). No execution, no authorization. Actions, decisions, snapshots, and audit records are persisted.

## execute(intent, executor) — the enforcement boundary

```ts
const outcome = await firewall.execute(
  intent,
  {
    idempotency: 'non_idempotent',       // retry safety (spec §25)
    atomicity: 'not_guaranteed',         // honest atomicity statement (default)
    execute: async (intent) => ({ success: true, output: { deployed: true } }),
  },
  { actionId: 'act_pinned_identity' },   // optional; enables replay protection
);

if (outcome.decision.decision === 'ALLOW' && outcome.executed) {
  console.log('ran:', outcome.result?.output);
}
```

Guarantees: the executor runs only after an ALLOW, with a pre-execution freshness re-verification; the authorization is consumed exactly once; every step is audited.

Pinning `actionId` across attempts enables replay detection: a second execute with the same id raises `ReplayDetectedError` (or `ActionExpiredError` past the deadline).

## protect(spec) — wrapping a tool

> **Dogfood finding DF-F1 — RESOLVED:** `protect()` originally wrapped tools in a legacy-path executor only, leaving provider-enforced conditional execution unreachable through the most ergonomic API. The spec now accepts `conditionalExecutionSupported` and `conditionalRun`, so a protected tool CAN take the provider-enforced CAS path. Tools that declare no conditional hooks keep the legacy path (`conditional_execution: 'not_attempted'`) and are blocked under `require_conditional_execution: true` policies (fail closed), exactly as before.

```ts
const deploy = firewall.protect({
  name: 'deployer',                       // unique within the firewall
  run: async (input) => deployToProduction(input),
  toIntent: (input) => ({ /* ActionIntentInput */ }),
  idempotency: 'non_idempotent',
  atomicity: 'not_guaranteed',
});
```

To reach the provider-enforced guarantee through `protect()`, declare how the
tool performs its side effect CONDITIONED on the authorized expected state.
The hook receives the authorized versions captured at validation time and
MUST forward them to the external system (ETag / expected SHA / CAS) — never
a fresh read:

```ts
const editFile = firewall.protect({
  name: 'github-file-edit',
  run: async (input) => { /* legacy best-effort fallback */ },
  toIntent: (input) => ({ /* ...dependencies: [{ source: 'github', resource: 'file', ..., version: input.observedSha }] */ }),
  atomicity: 'guaranteed',
  conditionalExecutionSupported: true,
  conditionalRun: async (input, expectedState) => {
    const entry = expectedState.find((e) => e.ref === `github:file/${input.repo}@${input.path}`);
    if (!entry?.version) return { applied: false, error: 'no authorized expected state' };
    const res = await githubCasWrite(input.repo, input.path, entry.version, input.content);
    return res.applied
      ? { applied: true, output: res.commit }
      : { applied: false, ref: entry.ref, observed_version: res.currentSha, error: res.message };
  },
});
```

Return `{ applied: true }` when the provider's condition held and the operation
was applied; `{ applied: false, ... }` when the provider refused (recorded as a
condition failure, the authorization is invalidated, and a fresh evaluation is
required — never a blind retry).

## The recovery contract (retry semantics)

Every failure the firewall surfaces — typed errors, `ExecutionResult` failures,
and `BlockedActionError` — carries a machine-readable **recovery contract**
(operationalization milestone §8/§9/§11). The authoritative table is exported:

```ts
import { RETRY_SEMANTICS, type RecoveryGuidance } from 'stale-state-firewall';

// guidance.failure_kind:        'condition_failed' | 'provider_failure' | 'timeout'
//                               | 'rate_limit' | 'unknown_execution_outcome'
//                               | 'authorization_expired' | 'replay' | 'policy_blocked'
// guidance.retry_safety:        'SAFE' | 'SAFE_ONLY_AFTER_FRESH_EVALUATION'
//                               | 'UNSAFE' | 'REQUIRES_HUMAN_REVIEW'
// guidance.authorization_usable / side_effect_possible: boolean
// guidance.next_steps:          ordered, deterministic instructions
```

Highlights (full table in [OPERATING_MODEL.md](OPERATING_MODEL.md) §7):

- `condition_failed` → `SAFE_ONLY_AFTER_FRESH_EVALUATION` — no side effect;
  discard the authorization, fetch fresh state, NEW authorization; never the
  same authorization.
- `unknown_execution_outcome` → `UNSAFE` — the side effect MAY have occurred;
  inspect the external system first; never blind-retry.
- `replay` → `UNSAFE` — one action id gets exactly one authorization and one
  execution attempt.

`BlockedActionError.recovery` is drawn from the execution result when one
exists, otherwise derived from the decision (DENY → fresh evaluation;
ESCALATE → human review). Failure records carry `failure_kind` +
`retry_safety` in the audit payload as well, so the trail answers "is a retry
safe?" without reading source.

### Unknown execution outcomes are explicit

A faulted conditional operation (timeout, connection reset, lost response
after the request was sent) is recorded as `conditional_execution: 'unknown'`
with `success: false` — never success, never "not executed" — plus the
`unknown_execution_outcome` recovery contract and a local
`executions_unknown_outcome` metric.

## Provider failure classification

Provider errors keep their typed classes AND carry an internal `kind` so
callers branch deterministically instead of parsing messages:

```ts
import { classifyProviderFailure } from 'stale-state-firewall';
// 'CONDITION_FAILED' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'FORBIDDEN'
// | 'RATE_LIMITED' | 'TIMEOUT' | 'SERVER_ERROR' | 'NETWORK_ERROR'
// | 'UNKNOWN_OUTCOME' | 'UNSUPPORTED'

try {
  await provider.getState(ref, nowIso);
} catch (e) {
  if (e instanceof ProviderUnavailableError) {
    e.kind;        // e.g. 'RATE_LIMITED'
    e.recovery;    // the recovery contract
  }
}
```

## refKey — building expected-state ref strings

`refKey` is exported as a runtime helper (previously type-only — dogfood
friction finding) and matches the `ref` format of `expectedState` entries:

```ts
import { refKey } from 'stale-state-firewall';
refKey({ source: 'github', resource: 'file', resource_id: 'acme/api@config.yaml' });
// 'github:file/acme/api@config.yaml'
```

## Escalations

```ts
const pending = await firewall.listEscalations('PENDING');
await firewall.resolveEscalation(actionId, { approved: true, by: 'oncall', note: 'ticket #99' });
const outcome = await firewall.executeApproved(actionId, intent, executor);
```

Approval resolves the uncertainty that caused the escalation; freshness and preconditions are still enforced on the approved path.

## State inspection

```ts
const inspection = await firewall.inspectState({
  source: 'github', resource: 'pull_request', resource_id: 'acme/api#42',
  version: null, content_hash: null, observed_at: null,
});
// { snapshot, age_ms, note }
```

## Introspection

```ts
firewall.getMetrics();          // counters + latency aggregates (spec §35)
await firewall.auditTail(50);   // newest-first audit records
await firewall.verifyAudit();   // hash-chain verification
await firewall.latestDecision(actionId);
await firewall.latestSnapshot(ref);
firewall.mode;                  // OBSERVE | ENFORCE | STRICT
await firewall.close();
```

## Errors (spec §54)

All typed, all extending `FirewallError` with a stable `code` (and — where a
recovery contract applies — a `recovery` field; provider errors also carry a
`kind` classification):

`ConfigurationError` · `PolicyValidationError` (carries `violations[]`) · `PolicyNotFoundError` · `ProviderUnavailableError` (kind: `ProviderFailureKind`) · `ProviderResponseError` · `StateUnavailableError` · `StateVersionMismatchError` · `PreconditionFailedError` · `ActionExpiredError` · `ReplayDetectedError` · `EscalationPendingError` · `UnauthorizedActionError` · `StorageError` · `BlockedActionError` (protected tools; carries the decision, the execution result, and `recovery`).

## Subpath exports

- `stale-state-firewall/adapters/memory`
- `stale-state-firewall/adapters/http`
- `stale-state-firewall/adapters/github`

Engines, storage, and config utilities are also exported from the root for custom integrations (see `src/index.ts`).
