# Internal Operating Model

How Stale-State Firewall (SSF) is meant to be used around our own consequential
agent operations. This document is grounded in the actual implementation — every
claim here is enforced by code and pinned by tests. Do not extend it without
extending the enforcement. (Operationalization milestone §5, §21, §22, §24, §25, §26.)

## 1. When does an agent invoke SSF?

**Before every consequential action** — any operation that, if executed against
stale state, would overwrite someone's work, change shared infrastructure, spend
resources, or be difficult to reverse. The agent does NOT decide whether to go
through the firewall; the integration does. `firewall.protect()` wraps the tool
so the raw operation is only reachable through the enforcement boundary
(duplicate registrations of the same tool name are refused — this closes the
accidental dual-path bypass).

Read-only observation does not need the firewall (`firewall.inspectState()` is
provided for building fresh observations). Everything that mutates external
state goes through `protect()` or `execute()`.

## 2. What constitutes a consequential action?

| Criterion | Examples |
|---|---|
| Mutates a shared resource | editing a config file, updating a CI workflow, changing an infra definition |
| Derived from observations that can age | "deploy because CI passed" (CI state can flip), "merge because review approved" (new commits can land) |
| Non-idempotent or hard to reverse | database migration, deployment flip, cache purge, secret rotation |
| Concurrency-exposed | any resource two agents (or an agent and a human) can touch |

If at least one applies, the action must be wrapped. If none applies (pure read,
pure computation, sandbox-only resources), SSF is unnecessary friction.

## 3. What the agent must declare

The `ActionIntent` is the contract. Garbage in, safe-but-blocked out:

- **`dependencies`** — every piece of external state the agent's reasoning (and
  the action's parameters) relied on, each with the `version` the agent observed.
  The firewall re-reads each dependency from the provider at authorization time;
  a claim that no longer matches is STALE/INVALID and blocks. Declaring nothing
  means the firewall verifies nothing — that is a policy violation for anything
  consequential (`require_dependencies`).
- **`preconditions`** — invariants that must hold against **current** state
  (`ci.state == success`, `deployment.status == healthy`). Never evaluated
  against agent-supplied metadata.
- **`risk_level`** or a matching policy — see [POLICY_BASELINE.md](POLICY_BASELINE.md).
- **`arguments`** — they are bound into the authorization and (for approved
  escalations) into the human approval; swapping them after the fact is refused.

**Honesty requirement:** the version fields must come from actual observations
(provider reads), never from imagination. An unrecognized claimed version makes
the dependency INVALID (fail closed) — see the S04 dogfood scenario.

## 4. When must conditional execution be required?

Whenever the action mutates a resource whose provider offers compare-and-swap
semantics (GitHub file blob-sha, HTTP endpoints with verified If-Match, the
in-memory provider). Set in policy:

```yaml
execution:
  require_conditional_execution: true   # fail closed when the capability is missing
```

This is the difference between narrowing the TOCTOU window (best-effort
re-check) and eliminating it for the written resource (the external system
itself refuses the stale operation). Providers without CAS support cannot
honestly offer this guarantee — see [providers.md](providers.md) for the
capability matrix and [limitations.md](limitations.md) for the boundary
(DF-F2: the CAS covers what the effect WRITES; read-only dependency drift in
the CAS window is outside the guarantee).

## 5. What happens after `condition_failed`?

The provider refused the operation because its authoritative state no longer
matches the authorized expected state. **No side effect occurred.** The
firewall:

1. records `execution.condition_failed` (with `failed_ref`, expected vs
   observed versions, provider refusal message — DF-4);
2. consumes the authorization (it can never be reused);
3. computes a fresh decision from current state for the audit trail;
4. returns a failure result carrying the **recovery contract**:
   `retry_safety: SAFE_ONLY_AFTER_FRESH_EVALUATION`.

The agent's job: discard the action, fetch fresh state, recompute, submit a NEW
action. The same authorization is never retried — replay protection refuses it
anyway.

## 6. What happens after an unknown execution outcome?

The request was sent; whether the provider evaluated the condition — and whether
the side effect landed — is **not observable**. The firewall records
`conditional_execution: 'unknown'` with `success: false` (never success, never
"not executed"), consumes the authorization, refuses blind replay, and increments
the local `executions_unknown_outcome` counter. The recovery contract is
`retry_safety: UNSAFE` with explicit next steps:

1. do NOT retry and do NOT replay the same authorization;
2. inspect the external system directly to determine whether the effect occurred;
3. if the effect did not occur and the action is still wanted, create a NEW
   action (fresh observation, new authorization) and execute again.

## 7. When is retry safe? (the authoritative table)

Machine-readable source of truth: `RETRY_SEMANTICS` in the SDK
(`import { RETRY_SEMANTICS } from 'stale-state-firewall'`). Every failure
surface (typed errors, `ExecutionResult.recovery`, `BlockedActionError.recovery`)
carries this contract.

| Failure kind | Retry safety | Authorization | Side effect possible? | What to do |
|---|---|---|---|---|
| `condition_failed` | SAFE_ONLY_AFTER_FRESH_EVALUATION | consumed, unusable | **No** (provider refused) | Fresh state → NEW authorization. Never same authorization. |
| `provider_failure` (validation phase) | SAFE_ONLY_AFTER_FRESH_EVALUATION | n/a — never issued | No | New attempt; fresh validation re-decides; stays blocked while provider is down (correct). |
| `timeout` (validation phase) | SAFE_ONLY_AFTER_FRESH_EVALUATION | n/a | No | New attempt; a timeout during EXECUTION is an unknown outcome instead. |
| `rate_limit` | SAFE_ONLY_AFTER_FRESH_EVALUATION | n/a | No | Back off until quota resets, then new attempt. |
| `unknown_execution_outcome` | **UNSAFE** | consumed, unusable | **Yes** | Inspect external state first; never blind-retry; new authorization only after reconciliation. |
| `authorization_expired` | SAFE (new action) | expired, unusable | No | Re-attempt as a NEW action; fresh validation is mandatory by construction. |
| `replay` | **UNSAFE** | consumed or live elsewhere | **Possibly** | Never repeat under the same action id; inspect if outcome unknown; new action id if needed. |
| `policy_blocked` (DENY / REVALIDATE-final) | SAFE_ONLY_AFTER_FRESH_EVALUATION | never issued / not usable | No | Read the decision reason (it names versions, staleness, failed preconditions); fresh state; NEW action. Do not weaken the declaration to evade. |
| ESCALATE hold / rejected escalation | REQUIRES_HUMAN_REVIEW | held | No | Human resolves via `resolveEscalation()`; do not work around. |

Provider faults are additionally classified as
`NOT_FOUND | UNAUTHORIZED | FORBIDDEN | RATE_LIMITED | TIMEOUT | SERVER_ERROR | NETWORK_ERROR | CONDITION_FAILED | UNSUPPORTED | UNKNOWN_OUTCOME`
(see `classifyProviderFailure`) without collapsing the underlying typed errors.

## 8. When must a human intervene?

- The decision is **ESCALATE** (policy) — approve/reject via `resolveEscalation()`.
  Approvals bind tool, operation, target, dependencies AND arguments (DF-3);
  anything else is refused.
- **Unknown execution outcome** whose external inspection a human must perform.
- **Suspected unsafe execution** (see [INCIDENT_PLAYBOOK.md](INCIDENT_PLAYBOOK.md)).
- A provider that is supposed to enforce conditions may not be (verification
  duty, §9 below).

## 9. What must be trusted (security boundary summary)

SSF's guarantees are exactly as strong as these inputs; overstating them is a
documentation bug (see [threat-model.md](threat-model.md) for the full model and
[limitations.md](limitations.md) for the precise non-guarantees):

| Trust input | Why |
|---|---|
| **The executor** | The firewall cannot see the executor's effects; a lying executor can record success for an unconditional write. Executors are operator code. |
| **Provider capability declarations** | `conditionalExecutionSupported: true` must be TRUE compare-and-swap, not a fresh read before writing. |
| **External provider semantics** | An HTTP server that ignores If-Match voids the CAS guarantee silently (S14 Case C). SSF reports its own vantage honestly but cannot wiretap the server. |
| **Caller-declared dependencies** | Undeclared dependencies are unprotected (DF-F2 scope). |
| **Provider state/version signals** | Providers with no version/hash signal only get TTL + precondition semantics. |
| **Audit storage** | The hash chain is tamper-EVIDENT; raw DB writers can forge records without an external anchor; tail truncation is not detected. |

## 10. Audit events → operator questions (§22)

The audit trail answers, from the records alone (no source reading):

| Operator question | Where |
|---|---|
| What happened, when, to which action? | `event_type`, `occurred_at`, `payload.action_id` on every record |
| Which target / tool / agent? | `payload.tool / operation / target / agent_id` |
| What state was authorized vs observed? | `payload.expected_state` (per-ref versions) and `payload.observed_version` |
| Which provider enforced the condition, and could it? | `payload.provider`, `payload.provider_capability` (per-ref) |
| Why did execution succeed/fail? | `payload.reason`, `provider_error`, `failed_ref` (DF-4) |
| Is a retry safe? | `payload.retry_safety` + `failure_kind` on every failure record |
| Was the record tampered with? | `ssf audit --verify` / `firewall.verifyAudit()` |

Event taxonomy (existing names; do not invent parallel ones):
`action.proposed / validated / blocked / revalidated / executed / failed /
replay_detected / expired / escalation_requested / escalation_resolved`,
`execution.condition_failed`, `policy.evaluated / violation`,
`state.observed / changed / unavailable`, `provider.error / recovered`.

## 11. Local metrics (§25)

`firewall.getMetrics()` (and `ssf doctor --json`) expose local counters —
**nothing is ever transmitted**:

`actions_checked` (attempted), `actions_allowed`, `actions_denied`,
`actions_revalidated` (fresh re-evaluations), `actions_escalated`,
`conditional_executions_satisfied`, `conditional_executions_failed`
(condition failures), `executions_unknown_outcome`, `replays_detected`,
`provider_failures`, `policy_failures`, `escalations_requested/resolved`,
`stale_state_events`, plus validation/revalidation/execution latency stats.

False positives and security incidents are **human classifications** made
during dogfood review (the harness records them per step); they are not
counters, because the firewall cannot judge its own correctness.

## 12. Continuous dogfood (§14–16, §26)

```bash
npm run dogfood            # 11 deterministic scenarios, offline, <5s
npm run dogfood -- --with-github   # + live GitHub sandbox scenario (SSF_GITHUB_TOKEN)
```

The harness (`dogfood/harness/`) classifies every step as
`EXPECTED_SECURITY_BLOCK` / `EXPECTED_SUCCESS` / `DOCUMENTED_BOUNDARY` /
`UNEXPECTED_FAILURE` / `SECURITY_FAILURE`, writes
`dogfood/reports/harness-report.json`, and exits non-zero on anything unexpected.
Run it after every SSF or policy change; it is the fast, repeatable answer to
"does the firewall still hold under realistic development actions?".

A `dogfood:watch` mode was considered and deliberately not added: the harness is
batch-oriented and cheap enough to run explicitly, and `npm run test:watch`
already covers iterative unit-level work. Complexity without value (milestone §16).
