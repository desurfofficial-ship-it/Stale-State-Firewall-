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

```ts
const deploy = firewall.protect({
  name: 'deployer',                       // unique within the firewall
  run: async (input) => deployToProduction(input),
  toIntent: (input) => ({ /* ActionIntentInput */ }),
  idempotency: 'non_idempotent',
  atomicity: 'not_guaranteed',
});

try {
  await deploy.execute(input);            // BlockedActionError when not allowed
} catch (e) {
  if (e instanceof BlockedActionError) {
    console.log(e.decision.decision, e.decision.reason);
  }
}

await deploy.check(input);                // dry-run variant
```

`BlockedActionError` carries the full `DecisionRecord`. The raw tool is only reachable inside the firewall's executor closure.

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

All typed, all extending `FirewallError` with a stable `code`:

`ConfigurationError` · `PolicyValidationError` (carries `violations[]`) · `PolicyNotFoundError` · `ProviderUnavailableError` · `ProviderResponseError` · `StateUnavailableError` · `StateVersionMismatchError` · `PreconditionFailedError` · `ActionExpiredError` · `ReplayDetectedError` · `EscalationPendingError` · `UnauthorizedActionError` · `StorageError` · `BlockedActionError` (protected tools; carries the decision).

## Subpath exports

- `stale-state-firewall/adapters/memory`
- `stale-state-firewall/adapters/http`
- `stale-state-firewall/adapters/github`

Engines, storage, and config utilities are also exported from the root for custom integrations (see `src/index.ts`).
