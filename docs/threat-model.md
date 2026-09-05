# Threat model

## Scope

Stale-State Firewall is a security boundary between an **untrusted or unreliable agent** and **trusted external systems**:

```
Untrusted / unreliable agent
        ↓
Firewall (policy, freshness, replay guard, audit)
        ↓
Trusted external systems (via providers)
```

Out of scope: host compromise (an attacker who controls the process or its memory wins), network attackers below TLS, and credential theft outside the firewall's boundary.

## Threats and defenses

### 1. Malicious agent — bypass validation

**Attack:** invoke the protected tool directly through a secondary path.
**Defense:** `protect()` wraps the tool so the raw implementation is reachable only inside the executor closure the firewall invokes after ALLOW. The wrapper exposes no reference to the underlying tool, and the firewall refuses to wrap the same tool name twice (no dual paths with divergent policies). Structural test: `test/kill/kill-tests.test.ts` K12.
**Residual:** nothing in-process can stop a developer from keeping a second, unwrapped reference and calling it — that is a code-review concern, stated honestly in [limitations.md](limitations.md).

### 2. Malicious agent — forge freshness

**Attack:** claim `observed_at: now` while carrying an old version, or fabricate a future timestamp.
**Defense:** freshness never trusts observation metadata alone: version/hash comparisons run against provider-fetched current state, and future timestamps beyond `clock_skew_tolerance` classify as UNKNOWN (kill tests K2, K3).

### 3. Malicious agent — replay authorization

**Attack:** reuse an authorized action id to execute again, or reuse an expired authorization.
**Defense:** single-use authorizations with deadlines; consumed, live, and expired authorizations all raise typed errors (`ReplayDetectedError`, `ActionExpiredError`); concurrent duplicate execution of one id yields exactly one execution (race test R4).

### 4. Malicious agent — forge preconditions

**Attack:** declare preconditions the world currently satisfies ("status = healthy").
**Defense:** preconditions are re-evaluated by the firewall against provider-fetched current state (kill test K17).

### 5. Malicious agent — omit dependencies

**Attack:** declare no dependencies so there is nothing to check.
**Defense:** zero declared dependencies classify as UNKNOWN → fail closed for consequential actions; `require_dependencies` makes the requirement explicit and `ssf policy test` can pin it (kill tests K9, K10).

### 6. Compromised tool

**Attack:** the wrapped tool executes directly, or returns misleading state.
**Defense:** the firewall controls invocation order; execution results are recorded with atomicity statements. Misleading *state* is the provider's domain — see threat 8.

### 7. Stale or lying provider

**Attack:** a provider returns outdated information as current.
**Defense:** the firewall's guarantees are exactly as strong as the provider's (spec §72). Conditional verification (`ETag`/304) and version signals reduce exposure; provenance (`validation_method`, `time_source`, `retrieved_at`) is recorded on every snapshot so forensic analysis can distinguish sources. This is a documented boundary, not a hidden weakness.

### 8. Network failure / provider outage

**Attack:** prevent validation, then pressure the action through.
**Defense:** provider failures are UNKNOWN verdicts; `on_unknown` defaults to revalidate and the execution path fails closed on residual UNKNOWN (invariant 7, invariant 10; kill tests K5, scenario E).

### 9. Concurrent actor

**Attack:** mutate state between observation and use.
**Defense:** execution-time re-fetch + state fingerprint comparison immediately before the side effect; mismatches block with a TOCTOU-specific reason (race tests R2, R6). Where the provider supports **conditional execution** (milestone: atomic effect assurance), the defense is strictly stronger: the mutation itself carries the authorized version and the **external system** refuses the operation when its state moved (kill-contrast tests CR1/KM1/KM3 in `test/conditional/`). The final gap (mutation after the last fetch, before the effect) remains only on providers without conditional execution and is recorded as `atomicity: not_guaranteed` — never claimed as safe. Condition failures invalidate the authorization and force a fresh decision; they are never retried under the old authorization (`execution.condition_failed` audit event; replay tests RP1–RP3).

**Attack (conditional-execution specific):** point the conditional mutation at a different resource than the one authorized, or satisfy the condition with a version borrowed from another resource.
**Defense:** the authorization carries the per-dependency expected state; executors without a matching entry must refuse (`condition: unavailable`, fail closed), and the provider's CAS is ref-scoped — a version from another resource cannot satisfy the condition (binding tests CB1, CB2; property test P-D).

### 10. Malicious configuration

**Attack:** weaken policy to let everything through.
**Defense:** total validation at load: `on_invalid: allow` forbidden; `on_unknown: allow` requires explicit acknowledgment and is impossible for CRITICAL; unknown fields, impossible conditions, contradictory rules, ambiguous matchers rejected (kill tests K13, K14; unit suite).

### 11. Insider — audit tampering

**Attack:** edit or delete audit records after the fact.
**Defense:** append-only ledger with a SHA-256 hash chain rooted at a fixed genesis hash; `ssf audit --verify` recomputes the chain and detects any modification, deletion, or reordering. The store exposes no mutation path for audit records (unit suite proves forged payloads cannot match committed hashes).

### 12. Clock manipulation

**Attack:** skewed or adversarial clocks widen freshness windows.
**Defense:** skew tolerance is explicit and defaults to zero; future timestamps are anomalies; versions/hashes are preferred over wall-clock comparisons; the injected `Clock` is operator-controlled, not agent-controlled (kill test K8).

## Assumptions

- The process running the firewall is trusted (compromise of the host defeats any in-process boundary).
- Provider credentials are managed by the operator (environment/secret managers) and are never handled by the agent.
- Providers expose at least one stable version signal for meaningful freshness guarantees; without one, only TTL/precondition semantics apply and the limits in [limitations.md](limitations.md) apply.
- Executors declare capabilities honestly (idempotency, atomicity, conditional-execution support) — the same trust model the executor contract has always used. Declared-but-unenforceable conditional capability fails closed (`condition: unavailable`); a hostile executor that discards the authorized expected state and calls the API directly is outside the boundary.

## Guarantees (summary)

**Strong:** no execution without a decision; critical actions never proceed on UNKNOWN or INVALID; refreshing state never auto-approves; deterministic evaluation; replay-proof authorizations; tamper-evident audit; **provider-enforced conditional execution where supported** — the external operation is conditioned on the exact authorized state, and a condition failure can never become a success or a blind retry.

**Best-effort:** TOCTOU window narrowing on providers without conditional execution; staleness detection quality bounded by the provider's version signals.

**Never claimed:** cross-system transactional consistency; prevention of every race condition on providers that lack conditional mutation mechanisms (see [atomic-effect-assurance.md](atomic-effect-assurance.md) for the capability matrix).
