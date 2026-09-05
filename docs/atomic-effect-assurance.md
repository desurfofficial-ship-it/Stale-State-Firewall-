# Atomic Effect Assurance — Conditional Execution

Milestone: make consequential external execution **conditional on the exact state the firewall authorized**, wherever the underlying provider supports that guarantee.

## The two guarantees (do not conflate them)

**Pre-execution verification guarantee (previously the only guarantee).**
The firewall can establish: *"the state was valid when I last verified it."* It fetches state, validates, authorizes, and re-fetches immediately before the side effect. A mutation that lands **after** the final fetch and **before** the executor's effect is invisible to the firewall. Best-effort; the residual window is structural.

**Conditional-execution guarantee (this milestone).**
Where the external provider supports it, the firewall establishes: *"the external system performed this operation only because the state still matched the state that was authorized."* The condition is evaluated **inside the external system, atomically with the mutation** — not by a fresh read performed by the firewall or the executor. A second read does not create atomicity; a provider-side compare-and-swap does.

```
FETCH
  ↓
VALIDATE
  ↓
REVALIDATE (when required)
  ↓
AUTHORIZE  (authorization binds the authorized expected state)
  ↓
CONDITIONAL EXECUTION  (the external system enforces: only if state == authorized)
  ↓     ├─ condition satisfied → SUCCESS
  │     └─ condition failed    → provider REFUSED, no side effect
  ↓
CONDITION FAILED handling:
  authorization invalidated → fresh state → recompute dependencies,
  preconditions, policy → NEW decision — never a blind retry
```

## Security model

The authorization now carries `expected_state`: one entry per validated dependency (`ref`, authoritative `version`, `content_hash`). This is the same evidence the `state_fingerprint` was computed over — the provider's own version signals, not agent claims.

The firewall never says only "execute this action" to a conditional executor. It says: "execute this action **only if** the external state is still `{ref: version, ...}`" — and the external system (GitHub's blob-sha check, an HTTP server's `If-Match` precondition, the in-memory provider's CAS) refuses the operation itself when that is no longer true.

**Trust boundary (stated honestly):** the executor is the operator's code; it receives the authorized expected state and forwards it to the provider's conditional mechanism. A malicious executor can ignore it — the same way it could ignore the firewall and call the API directly. The guarantee is: the only supported conditional path carries the authorized state; the firewall records exactly what was enforced (`conditional_execution`, `expected_state`, `observed_version`); and executors that declare conditional support but cannot enforce it fail closed (`condition: unavailable`), never falling back to unconditional execution.

## Provider capability matrix

| Provider | Conditional execution | Mechanism | Condition evaluated by | Guarantee |
|---|---|---|---|---|
| In-memory | **SUPPORTED** | `conditionalExecute()` — synchronous check-and-mutate in one call (atomic in the JS event loop) | The provider, inside the mutation | **FULL** (provider-enforced CAS) |
| GitHub (`file` resource) | **SUPPORTED** | Contents API update (`PUT /repos/{o}/{r}/contents/{path}`) with the authorized blob `sha`; GitHub refuses with 409/422 on a stale sha and 404 when the file is gone | GitHub, inside the PUT | **FULL** (provider-enforced CAS) |
| GitHub (all other resources) | UNSUPPORTED | No expected-revision parameter exists on the merge/issue/deployment mutation endpoints | — | Best-effort pre-execution verification only |
| HTTP (resource with `mutation` config) | **SUPPORTED** | `If-Match: <authorized version>` on the configured mutation; 412/409 (configurable) ⇒ condition failed | The HTTP server, inside the mutation request | **FULL** — *provided the operator verified the server honors RFC 9110 preconditions* |
| HTTP (resource without `mutation` config) | UNSUPPORTED | — | — | Best-effort pre-execution verification only |

`supportsConditionalVerification()` (a read-side 304 check) and `supportsConditionalExecution()` (a mutation-side CAS) are different capabilities. Verification only reads; conditional execution makes the external system refuse stale mutations. Providers must not implement the second by doing more reads.

## Execution flow changes

`executeAction` now branches after the atomic authorization claim:

1. **Executor supports conditional execution and an expected state exists** → the conditional path runs and **replaces** the legacy TOCTOU re-check (the CAS is strictly stronger than a pre-execution read; §28 of the milestone requires dropping the redundant fetch).
   - `condition: satisfied` → executed, `atomicity: guaranteed`, audit `action.executed` with `conditional_execution: satisfied`.
   - `condition: failed` → the provider refused. The authorization is consumed; audit `execution.condition_failed`; a completely fresh evaluation recomputes dependencies, preconditions, and policy into a NEW decision record (reason prefixed `conditional execution was rejected by the provider`). Nothing executes; the caller must form a new intent (new action id) — the old authorization is gone.
   - `condition: unavailable` → fail closed. No side effect, no fallback to unconditional execution.
   - executor crash / deadline → execution failure with unknown condition outcome; never success.
2. **No conditional capability** → the legacy best-effort path (TOCTOU re-fetch + fingerprint compare) runs unchanged, and the execution record honestly states `atomicity: not_guaranteed` unless the executor declared otherwise.
3. **Policy requires conditional execution but it is unavailable** → gate: `on_conditional_unavailable` outcome (default **deny**; a human approval cannot give a provider CAS semantics). `escalate` and `revalidate` are configurable; `allow` is rejected at config validation as contradictory. In OBSERVE mode the gate records `would_have_decided` without blocking.

## Policy knobs

```yaml
actions:
  - name: deploy-production
    match: { operation: 'deploy*' }
    risk: CRITICAL
    execution:
      require_conditional_execution: true   # default false (backward compatible)
      on_conditional_unavailable: deny       # deny (default) | revalidate | escalate
```

## Audit and observability

- New audit event: `execution.condition_failed` (provider, expected_state, observed_version, decision_ref).
- `action.executed` / `action.failed` payloads carry `conditional_execution`, `expected_state`, `decision_ref`.
- `ExecutionResult` gains `conditional_execution: satisfied | failed | unavailable | not_attempted`, `expected_state`, `observed_version` — persisted (SQLite migration v2).
- The authorization record persists `expected_state` (the binding is reconstructible from the ledger).
- `decision_ref` is deliberately named to avoid the redaction control's `auth*` pattern: a decision id is not a secret, and the lifecycle must remain reconstructible. The authorization itself is identified by `action_id`.
- Metrics: `conditional_executions_satisfied`, `conditional_executions_failed`.

## Test evidence

- **Critical race test (§17)**: `test/conditional/conditional-execution.test.ts` CR1 — T0 state X → T1 authorize → T2 mutate X→Y → T3 conditional operation carrying X → T4 provider refuses. Deterministic; fails if the CAS check is removed (KM1).
- **Same-state success (§18)**: CR2. **Two-authorization race (§16)**: CR3 (exactly one CAS wins). **Drift between validation and authorization**: CR4.
- **Legacy limitation demonstrated, not hidden**: CR5 shows the residual compare→execute window that remains when no conditional capability exists.
- **Argument/target binding (§19)**: CB1 (authorization for A cannot drive CAS on B), CB2 (provider CAS is ref-scoped).
- **Replay × conditional (§20)**: RP1–RP3.
- **Failure injection (§21)**: FI1–FI4 (crash ≠ condition failure; unavailable fails closed; deadline semantics).
- **Matrix (§30)**: `test/conditional/conditional-policy.test.ts` M1–M12 + policy tests P1–P6.
- **Kill mutations (§27)**: `test/conditional/conditional-kill.test.ts` KM1 (CAS check removed → attack succeeds), KM2 (condition failure reported as satisfied), KM3 (authorized version replaced by a fresh read — the "second read" anti-pattern), KM4 (declared-but-unenforceable capability fails closed).
- **Property tests (§26)**: `test/conditional/conditional-property.test.ts` — randomized version histories; `state moved ⇒ never executed`, `state unchanged ⇒ executed`, ref-scoped CAS for arbitrary version pairs.
- **Provider contract**: `test/conditional/providers-conditional.test.ts` — simulated GitHub Contents API (stale sha ⇒ 409 ⇒ no write) and a live local HTTP server (stale `If-Match` ⇒ 412 ⇒ no write; 500 ⇒ error, not condition failure).
- **Persistence**: SQLite migration v2 round-trip (`SQ1`).

Full run: 242 tests green (186 pre-existing + 56 new); build, lint, typecheck, hygiene green.

## Performance

In-memory provider, 2000 iterations (`scripts/bench-conditional.ts`):

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Legacy (TOCTOU re-check fetch + execute) | 0.137 ms | 0.246 ms | 1.187 ms |
| Conditional (provider-enforced CAS, no extra fetch) | 0.128 ms | 0.190 ms | 0.287 ms |

Conditional execution is faster on every percentile — it removes a verification fetch whose result could be raced anyway.

## Remaining limitations (unchanged where stated)

- Providers without a conditional mutation mechanism keep the best-effort guarantee. The firewall does not pretend otherwise: `supportsConditionalExecution()` is per-provider (and per-resource for HTTP), and the capability summary is written into deny/audit reasons.
- The executor must forward the authorized expected state to the provider's conditional mechanism; see the trust boundary above.
- GitHub resources other than `file` have no expected-revision mutation parameter in the GitHub API; no conditional execution is claimed for them.
- For HTTP, atomicity requires the server to honor `If-Match` (RFC 9110). That is an operator-verified configuration act, documented per resource; a server that ignores the header provides no atomicity, which is why the capability is opt-in.
