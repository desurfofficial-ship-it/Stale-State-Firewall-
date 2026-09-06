# Revalidation

## Why revalidation exists (spec §23)

When state is STALE or the observation basis is insufficient, the firewall could simply say DENY. But many stale actions are still *safe* — the world just moved a little. Revalidation is the controlled path: fetch current state and **recompute the safety decision from it**.

The critical rule: revalidation must not simply refresh the state and automatically approve the original action. The firewall recomputes — preconditions are re-evaluated against current state, and the drift between what the agent observed and what is true now stays visible in the verdicts (`observed_version` vs `current_version`) and in the audit trail.

## Where it happens

### In `check()` — as an instruction

`check()` is a dry run. A `REVALIDATE` decision tells the caller (or a human reading the output) that fresh state must be established before the action can be judged safe. Nothing executes.

### In `execute()` — inline, automatically

```
initial decision = REVALIDATE
        ↓
adopt the fresh snapshots fetched during validation as the new basis
        ↓
re-evaluate preconditions against CURRENT metadata
        ↓
recompute: ALLOW / DENY / ESCALATE
        ↓
if still UNKNOWN → DENY (invariant 10: revalidation must resolve
uncertainty, not loop on it)
```

The recomputed decision is stored as a second `DecisionRecord` with `revalidated: true`, and an `action.revalidated` audit event links the two.

Examples:

- TTL expired but preconditions hold on current state → revalidate → **ALLOW** (fresh basis, invariants verified now).
- Version drifted (`v1` → `v2`) and the policy maps `on_invalid: revalidate` → recompute with the new version; if the current state satisfies preconditions → **ALLOW**, else **DENY**.
- CI moved from passing to failing and `ci.state == success` is a precondition → precondition fails against current state → **DENY** (the spec §49 release-agent scenario).
- Provider outage → state still UNKNOWN after revalidation → **DENY** (fail closed).

## Conditional execution replaces the re-check where providers support it

The pre-execution re-check described above is a best-effort fetch-compare: it narrows the TOCTOU window but cannot close the final compare → execute gap. Where the provider supports conditional execution (milestone: atomic effect assurance), the firewall replaces the redundant re-check with a stronger mechanism: the mutation itself carries the authorized expected state and the external system refuses the operation when its authoritative state no longer matches. See [atomic-effect-assurance.md](atomic-effect-assurance.md).

A provider refusal (`execution.condition_failed`) follows the same philosophy as revalidation, one step stricter:

- the authorization is invalidated immediately,
- dependencies, preconditions, and policy are recomputed against current state into a NEW decision record,
- nothing executes automatically, and the new state never inherits the old authorization — the caller must submit a fresh intent (new action id) that goes through the full pipeline again.

## Escalations

An `ESCALATE` decision holds the action:

1. The action id is recorded as `PENDING` in the escalations ledger.
2. Re-submitting the same action id while pending raises `EscalationPendingError` — the frozen identity cannot be used to sneak a re-evaluation.
3. A human resolves it:

```ts
await firewall.resolveEscalation(actionId, {
  approved: true,
  by: 'security-oncall',
  note: 'change ticket #99',
});
```

4. Execution happens only via `firewall.executeApproved(actionId, intent, executor)`, which **re-verifies freshness** — approval resolves the uncertainty that caused the escalation, but it does not bypass INVALID state or failed preconditions.

## Execution-time verification (TOCTOU)

Time-of-check/time-of-use (spec §13): between validation and the side effect, the world can change. For every execution (default `require_fresh_at_execution: true`):

1. After ALLOW, an **authorization** is recorded with a deadline (`execution.deadline`, 10s default for HIGH/CRITICAL, 60s otherwise), a **state fingerprint** (hash over each dependency's version + content hash at validation time), and the per-dependency **expected state** the authorization is bound to.
2. If the executor supports conditional execution (milestone: atomic effect assurance), the firewall takes the **conditional path**: the mutation carries the authorized expected state and the external system itself refuses a stale operation. The re-fetch below is skipped — the provider-enforced CAS is strictly stronger than another read, so the extra fetch would be redundant.
3. Otherwise (legacy best-effort path), immediately before the side effect the firewall **re-fetches** every dependency and recomputes the fingerprint. Fingerprint mismatch → the action is blocked with an explicit reason (`...state changed between validation and execution (time-of-check/time-of-use protection)...`), recorded as a second decision plus an `action.blocked` audit event with `stage: toctou_recheck`.
4. On the conditional path, a provider refusal (`condition failed`) consumes the authorization, records an `execution.condition_failed` audit event, and produces a fresh recomputed decision (`stage: condition_failed_revalidation`). It is never retried under the old authorization.

## Replay protection (spec §24, §25)

- One action id gets **one authorization and one execution attempt**.
- Re-executing a consumed authorization → `ReplayDetectedError`.
- Executing after the authorization window expired → `ActionExpiredError`.
- Re-submitting a live (unconsumed, unexpired) authorization → `ReplayDetectedError`.
- Executors declare `idempotency`; when the policy sets `execution.allow_idempotent_retry: true` and the executor is idempotent, a retry runs the **full fresh validation** again — it never reuses the old authorization.

## What is honestly NOT guaranteed (spec §45, §72)

On providers **without** conditional execution, a mutation that lands **after the final re-fetch but before the executor's effect** is outside the firewall's visibility. Every execution record states `atomicity: "guaranteed" | "not_guaranteed"`; the generic executor default is `not_guaranteed`, and the audit trail carries it. On providers **with** conditional execution the external system enforces the condition inside the mutation itself — that is the milestone guarantee described in [atomic-effect-assurance.md](atomic-effect-assurance.md). The firewall never claims transactional guarantees it cannot make.
