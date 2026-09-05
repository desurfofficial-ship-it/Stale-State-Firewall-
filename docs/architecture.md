# Architecture

## Layering (spec §41)

```
src/
  domain/          Pure typed model. No I/O, no infrastructure.
    state.ts         StateSnapshot, StateDependency, ResourceReference, provenance
    action.ts        ActionIntent, Precondition, RiskLevel, ActionExecutor, ExecutionResult
    decision.ts      DecisionRecord, DependencyVerdict, StalenessClass, FirewallMode
    policy.ts        FirewallPolicyConfig, freshness strategies, outcome decisions
    audit.ts         AuditRecord, event types
    events.ts        FirewallEvent + synchronous event bus
    errors.ts        Typed error hierarchy (spec §54)
    identifiers.ts   Sortable id generation

  engine/          Deterministic decision machinery.
    clock.ts         Clock interface: SystemClock + ManualClock (injectable, spec §27)
    staleness.ts     Age math + FRESH/AGING/STALE/INVALID/UNKNOWN classification
    freshness.ts     Per-dependency evaluation for ttl/version/hash/preconditions/hybrid
    preconditions.ts 11 operators, strict typing, dot-path resolution
    policy-resolver.ts  Precedence: explicit > matcher specificity > risk > default
    decision-engine.ts  Composition + hard safety floor (invariants)
    dependency-evaluator.ts  Fresh provider fetches + verdict construction
    resolved-policy.ts   Parsed, validated runtime policy structures
    duration.ts, glob.ts, hashing.ts  Parsing/matching/canonical primitives

  providers/       StateProvider implementations (spec §16-18).
    memory/          In-memory provider: tests, examples, policy fixtures
    http/            Generic HTTP: ETag/Last-Modified/JSON paths, env() headers
    github/          GitHub REST: PRs, issues, branches, CI status, deployments, releases, files (CAS)

  storage/         FirewallStore implementations (spec §37).
    sqlite/          node:sqlite, migrations, FKs, CHECK constraints, indexes
    memory/          Full in-memory implementation for tests

  application/     Use cases (orchestration).
    validate-action.ts    Dry-run decision pipeline
    execute-action.ts     Enforcement boundary + replay guard + TOCTOU re-check + conditional execution
    revalidate-action.ts  Recompute decisions from current state (spec §23)
    inspect-state.ts      Read-only state inspection

  sdk/             Public API.
    firewall.ts          StaleStateFirewall
    protected-tool.ts    protect() wrapper + BlockedActionError

  cli/             ssf binary: run.ts (dispatch), output.ts (rendering), main.ts (bin)

  config/          Loading, normalization, total validation (spec §30, §33)
  audit/           Hash-chained append-only ledger engine
  telemetry/       Local counters + latency aggregates (spec §35)
  redaction/       Recursive secret redaction (spec §29)
  logging/         JSON-lines structured logger
```

Dependencies point strictly downward: `sdk → application → engine/domain → (providers/storage as injected interfaces)`. Infrastructure never leaks into domain logic.

## The decision pipeline

```
check(intent)                              execute(intent, executor)
    │                                          │
    ├─ normalizeIntent                         ├─ normalizeIntent
    ├─ resolvePolicy (§32)                     ├─ resolvePolicy
    ├─ saveAction                              ├─ saveAction + audit action.proposed
    ├─ evaluateDependencies                    ├─ evaluateDependencies  (fresh fetches)
    │    ├─ fetch current state per dep        │    (conditional 304 where supported)
    │    ├─ classify staleness                 ├─ decide → DecisionRecord #1
    │    └─ evaluate preconditions             ├─ REVALIDATE? → recompute from current
    ├─ decide → DecisionRecord                 │    state (spec §23), fail closed on residual UNKNOWN
    │    (OBSERVE: record would-have)          ├─ ESCALATE? → hold for human approval
    ├─ saveDecision + audit                    ├─ DENY? → stop, audit action.blocked
    └─ return DecisionRecord                   ├─ ALLOW → claimAuthorization (deadline, expected-state binding)
                                               ├─ executor supports conditional execution?
                                               │    ├─ YES → conditionalExecute(intent, authorized expected state)
                                               │    │        ├─ condition satisfied → executed, atomicity guaranteed
                                               │    │        ├─ condition failed → provider REFUSED; authorization
                                               │    │        │   invalidated; fresh re-evaluation → new decision
                                               │    │        │   (audit: execution.condition_failed) — never a retry
                                               │    │        └─ unavailable → fail closed, nothing executes
                                               │    └─ NO  → TOCTOU re-fetch + fingerprint compare (§13)
                                               │             state drifted? → DENY, audit action.blocked
                                               ├─ executor() / conditionalExecute() under deadline
                                               └─ consume authorization + saveExecution + audit
```

Key properties:

1. **The executor is a closure.** `protect()` keeps the raw tool reachable only inside the closure the firewall invokes after ALLOW. There is no path from the agent to the tool that skips `executeAction` (spec §14, §48).
2. **Validation always fetches current state.** Stored snapshots are forensics, never a freshness source (invariant 8).
3. **Provider failures are UNKNOWN**, which fails closed per policy (invariant 7).
4. **Authorizations are single-use** and expire; replay is detected and typed (spec §24).
5. **Conditional execution closes the final TOCTOU window where providers support it.** The authorization binds the authorized expected state; the external system itself refuses the operation when that state is no longer true (milestone: atomic effect assurance, see [atomic-effect-assurance.md](atomic-effect-assurance.md)).

## Data model (SQLite)

```
snapshots        snapshot_id PK, (source, resource, resource_id, observed_at) index
actions          action_id PK, redacted arguments, dependencies JSON, risk CHECK
decisions        decision_id PK, action_id FK, decision CHECK, verdicts JSON,
                 would_have_decided, mode CHECK, expires_at
executions       execution_id PK, action_id, atomicity, idempotency CHECK
audit_events     seq AUTOINCREMENT PK, event_id UNIQUE, prev_hash, record_hash
                 (append-only: no update/delete path exists in the store API)
authorizations   action_id PK, expires_at, state_fingerprint, consumed_at
escalations      action_id PK, status CHECK (PENDING|APPROVED|REJECTED)
schema_migrations versioned migrations, applied transactionally
```

Integrity: `PRAGMA foreign_keys = ON`, NOT NULL + CHECK constraints, unique ids at the database level, transactions around migration and audit append (spec §57, §58).

## Audit hash chain

```
record_hash_n = SHA256(prev_hash_n | canonical_json({event_id, event_type, occurred_at, payload, audit_schema_version}))
prev_hash_0   = 0x00 * 64
```

`ssf audit --verify` recomputes the full chain. Any modified payload, deletion, or reordering breaks verification. Payloads are redacted before persistence (spec §29).

## Determinism

The decision engine is a pure function of `(policy, observed state, current state, action, risk)`. There are no LLM calls, no randomness, no wall-clock reads inside the engine — time comes from the injected `Clock`, which is a `ManualClock` in tests and policy-test fixtures. `fast-check` property tests assert determinism directly (spec §42, §46).
