# Independent Assurance Audit — Controlled-Beta Readiness Gate

Auditor: independent principal security engineer (adversarial assurance engagement)
Scope: full repository at commit `ddba83c` ("conditional execution (atomic effect assurance)"), plus fixes applied during this audit.
Method: no prior claim accepted. Every headline claim was re-derived from the implementation and re-attacked with an independently written suite (`test/assurance/`, 50 tests) that does not reuse the milestone's reference executors.

---

## Executive Verdict

**READY FOR CONTROLLED BETA**

One claim from the milestone was false as shipped (lint green) and was fixed; one claim (242 tests) was off by one (actual 243) and the docs were corrected. No P0. No P1 in the enforcement path. All GO/NO-GO criteria pass. The conditional-execution guarantee is real, provider-enforced where claimed, honestly bounded, and survives independent adversarial reproduction including kill-mutation sensitivity proofing.

---

## 1. Actual Architecture (what the code really does)

Execution flow of `firewall.execute(intent, executor, {actionId?})` (`src/application/execute-action.ts`):

1. **Pre-validation guards** — escalation state machine (PENDING → refuse, APPROVED → require `executeApproved`, REJECTED → replay error); expiry guard; live-authorization replay guard.
2. **validateAction** — normalize intent (server-assigned ids/timestamps; agent-supplied observation metadata is recorded as *claims*, never trusted) → resolve policy (explicit name must exist, else fail closed) → fetch CURRENT state per declared dependency → classify staleness (FRESH/AGING/STALE/UNKNOWN/INVALID) → evaluate preconditions against fresh state → deterministic decision (hard safety floor: CRITICAL never ALLOW on UNKNOWN/INVALID) → persist decision + audit.
3. **Consumed-authorization guard** — replay error unless policy explicitly allows idempotent retry for idempotent executors.
4. **REVALIDATE / ESCALATE / DENY routing** — recomputation from current state; escalation approval binds to the originally approved semantics (tool, operation, target, dependency set).
5. **Authorization** — builds per-dependency `expected_state` from the validation snapshots; availability = executor declares conditional support AND expected state is non-empty. Policy gate: `require_conditional_execution: true` + unavailable ⇒ DENY (default; REVALIDATE/ESCALATE configurable; contradictory `allow` rejected at config time). Atomic claim via `claimAuthorization` (SQLite `BEGIN IMMEDIATE` check-and-set / synchronous memory check-and-set).
6. **Conditional path** (available) — replaces the legacy TOCTOU re-check. Executor's `conditionalExecute(intent, expectedState)` must forward the AUTHORIZED versions to the provider's own CAS (`provider.conditionalExecute`); outcomes: `satisfied` (executed, `atomicity: guaranteed`), `failed` (provider refused stale operation: authorization consumed, no side effect, fresh decision recomputed from current state, never retried), `unavailable` (fail closed), thrown/timeout (failure with UNKNOWN condition outcome — never success).
7. **Legacy path** (no conditional capability) — pre-execution re-fetch + fingerprint compare; drift ⇒ DENY; all fetches fail ⇒ DENY (fail closed); execution proceeds with `atomicity: not_guaranteed` (unless the executor truthfully declares otherwise) and `conditional_execution: not_attempted` (added in this audit for audit-trail precision).

Trust boundaries (verified, and stated in docs/threat-model + limitations): the executor is the operator's code; a hostile executor that discards the authorized expected state or lies about enforcement is outside the guarantee (the firewall records what the executor reports; it cannot wiretap the executor→provider call). Dependency completeness is caller-declared (no independent resolver). Provider capability declarations are coarse-grained (per provider, not per resource) — see finding P3-1.

## 2. Independent Test Results

Baseline (as-cloned, before changes):

| Check | Result |
|---|---|
| `npm test` | **243 passed / 24 files / 0 skipped / 0 todo** (claim said 242) |
| `npm run build` | pass |
| `npm run typecheck` | pass |
| `npm run lint` | **FAIL — 3 `no-console` errors in `scripts/bench-conditional.ts`, exit 1** (claim said green) |
| `npm run check:hygiene` | pass |

Independent adversarial suite added during this audit — `test/assurance/`, 50 tests, all written from the brief without reusing milestone helpers:

- `independent-core.test.ts` (25): canonical race T0–T4 (provider refuses; zero side effect; replay refused; audit says `execution.condition_failed`, never `action.executed`); same-state success; kill-mutation sensitivity (CAS removed ⇒ the attack lands ⇒ restored ⇒ refused again); second-read anti-pattern (executor substitutes a fresh read ⇒ stale action executes — documented executor trust line, pinned by test); `require_conditional_execution` gate (DENY with capability reason; contradictory policy rejected at config time); CAS concurrency (50 concurrent CAS ⇒ exactly 1 mutation; 8 concurrent firewall executions ⇒ exactly 1 success; structural check: no `await` between compare and write); binding attacks (target substitution, cross-dependency version swap both fail; caller-declared dependency omission is NOT detected — pinned as a documented trust boundary); condition-failure semantics (authorization consumed, fresh decision recorded, no blind retry, new action id still fails the CAS); failure-outcome classification (412 ⇒ condition_failed event; 500/crash ⇒ failed with UNKNOWN outcome, no `condition_failed` event, no `action.executed`; deadline ⇒ honest failure with side-effect-unknown note); unknown-state safety (no risk level silently ALLOWs UNKNOWN; `on_unknown: allow` on a named policy is a **config-time error**); executor trust boundary made explicit (a lying executor is recorded as a normal success — nothing at the provider happened; the limitation is kept visible by test).
- `independent-providers.test.ts` (13): GitHub blob-SHA CAS (authorized sha carried INSIDE the PUT; stale sha ⇒ condition_failed; deleted file ⇒ condition_failed; missing sha ⇒ typed error BEFORE any request; non-file resource ⇒ typed refusal; 403 rate limit / 500 ⇒ ProviderUnavailableError, NOT condition failures; capability granularity finding pinned: `supportsConditionalExecution()` is blanket-true although only `file` enforces). HTTP against a **real local node:http server**: Case A (matching ETag ⇒ If-Match sent ⇒ mutation applied); Case B (changed ETag ⇒ 412 ⇒ **no mutation**); Case C (server that IGNORES If-Match ⇒ mutation executes and the provider/firewall cannot detect it — the operator-verification boundary is real and honestly documented); 500 ⇒ provider error not condition failure; resources without mutation config offer no capability; connection refused ⇒ typed provider error.
- `independent-storage-audit.test.ts` (12): audit accuracy (condition failure records expected vs observed state, provider, and never `executed`); tamper-EVIDENCE (DB-level payload rewrite ⇒ `verify()` fails); tamper LIMITATION (tail-truncation of the last record is NOT detectable by the hash chain — the weakest accurate term is used in docs); no update/delete path on the store; **SQLite cross-process claim race** (two stores on one DB file, concurrent `claimAuthorization` ⇒ exactly one claim); redaction (secrets in arguments, outputs, and deep nesting are redacted in stored actions, decisions, and audit); resource-exhaustion (1 MB version string, 200 dependencies, 40 concurrent authorizations: no crash, linear behavior, 1 CAS winner); fuzzing (garbage/wildcard/padded/uppercase/path-like versions all refused by the CAS; nothing satisfies with invalid inputs).

Post-fix full gate: **293 passed (243 + 50) / build / typecheck / lint / hygiene all green.**

## 3. 242-Test Claim Verification

- Claimed: 242. Actual at the milestone commit: **243** (all passing, 0 skipped/todo/conditionally-executed; assertion quality spot-checked — security tests verify side effects, audit records, and provider state, not just function calls).
- Discrepancy is +1 (understated). Docs corrected.
- "lint green" was **false** (3 errors, exit 1). Root cause: eslint exemption for `scripts/` covered only `*.mjs`. Fixed by extending the exemption to `scripts/**/*.ts` (the evident intent; the benchmark script legitimately prints results). Lint is now genuinely green.

## 4. Conditional Execution Verdict

**YES — for the providers/resources where it is claimed, and honestly not claimed elsewhere.**

- In-memory provider: genuine synchronous compare-and-swap (no event-loop yield between compare and mutation; 50-way concurrency yields exactly one mutation). Enforced by the provider.
- GitHub `file`: genuine provider-enforced CAS — the authorized blob SHA is carried inside the Contents API PUT; GitHub itself refuses stale writes. Verified at the provider boundary (request carries the sha; stale ⇒ 409 ⇒ condition_failed; deleted ⇒ 404 ⇒ condition_failed).
- HTTP with a `mutation` config: genuine If-Match precondition *if and only if the operator verified the server honors RFC 9110 preconditions*. Case C (server ignores If-Match) executes despite a stale condition and is **undetectable by the firewall** — the docs state exactly this; the capability is opt-in per resource for this reason.
- The firewall's own re-check (GET → compare → execute) is never labeled atomic (`atomicity: not_guaranteed`, `conditional_execution: not_attempted`).

## 5. Provider Matrix

| Provider | Resource | Conditional Execution | Actual Mechanism | Guarantee |
|---|---|---|---|---|
| In-memory | any tracked resource | YES | synchronous CAS in the provider (`conditionalExecute`), ref-scoped | FULL (provider-enforced) |
| GitHub | file | YES | Contents API PUT carrying the authorized blob SHA; GitHub refuses stale (409/422) or missing (404) | FULL (provider-enforced) |
| GitHub | other (PR, issue, branch, ci_status, deployment, release) | NO | `conditionalExecute` throws a typed refusal | Best-effort pre-execution verification only |
| HTTP | resource with `mutation` config | CONDITIONAL | `If-Match: <authorized version>`; 412/409 (configurable) ⇒ condition failed | FULL **only if the operator verified the server honors If-Match**; otherwise no atomicity and the firewall cannot know |
| HTTP | resource without `mutation` config | NO | typed refusal | Best-effort pre-execution verification only |

## 6. Critical Race Evidence

`test/assurance/independent-core.test.ts` — IR1 (independently wired):

- T0: resource at version X. T1/T2: firewall fetches X, authorizes, claims atomically. T3 (injected between authorization and CAS): external actor mutates X → Y. T4: executor forwards the AUTHORIZED X to `provider.conditionalExecute` — the provider compares against Y and returns `condition_failed` with `observed_version: Y`.
- Asserted: `executed === false`, `conditional_execution === 'failed'`, `observed_version !== X`, mutation log contains ONLY the attacker's write, the audit contains `execution.condition_failed` and NO `action.executed`, and a replay of the same action id is refused with `ReplayDetectedError`.
- Sensitivity proof: IR3 removes the provider's CAS comparison ⇒ the identical attack now lands (stale write succeeds) ⇒ mechanism restored ⇒ attack refused again. The test genuinely detects the vulnerability.

## 7. Remaining TOCTOU Boundary (impossible to guarantee)

- The residual window for actions WITHOUT provider conditional support (fetch-compare-execute can always be raced).
- Executors that lie (discard expected state, re-read current state, fabricate `satisfied`) — the firewall records what is reported; it does not observe the executor→provider call.
- Servers that ignore `If-Match` (HTTP provider cannot distinguish "enforced" from "header accepted and ignored").
- Caller-declared dependency completeness — no independent resolver; an omitted safety-critical dependency is invisible.
- Audit tail truncation by an attacker with raw DB write access (hash chain detects modification/reorder, not tail deletion).
- Provider version-signal quality: conditional execution enforces the VERSION the provider authorized; if a provider's version signal does not track content (misconfigured HTTP resource), the CAS is vacuous — GitHub file blob SHAs are content-addressed, so this is safe there.

## 8. Trust Boundary (what an operator must still trust)

| Component | Trusted for |
|---|---|
| Executor (operator's code) | honest `conditionalExecute` implementation; honest capability declarations; truthful condition outcomes |
| Provider (GitHub / HTTP server) | enforcing its own documented CAS semantics (blob SHA, If-Match) and version-signal integrity |
| Configuration | per-resource `mutation` declarations mean the operator has verified the server's precondition behavior |
| Database | physical write protection (audit chain is tamper-evident, not tamper-proof) |
| Caller | stable `actionId`s for replay protection (unpinned ids generate fresh identities per call); complete dependency declarations |

## 9. Security Findings

| ID | Severity | Title | Status |
|---|---|---|---|
| P2-1 | P2 | `npm run lint` failed (3 errors) while the milestone claimed "lint green" — the repo's own quality gate was red | FIXED (eslint `scripts/**/*.ts` exemption; lint green) |
| P2-2 | P2 | Provider capability declarations are coarse-grained: `supportsConditionalExecution()` is blanket-true for GitHub (only `file` enforces) and true-if-ANY for HTTP. An executor that wires the blanket flag for a non-file GitHub action passes a `require_conditional_execution` gate, then fails at execution time with a typed refusal — fail-closed (no side effect) but late, with the condition outcome recorded as not-attempted/unknown rather than a clean pre-execution denial. Docs describe the per-resource reality accurately; the method surface does not. | ACCEPTED RISK, documented (recommendation: per-resource capability probe before gating) |
| P3-1 | P3 | GitHub 404/409/422 are all mapped to `condition_failed`; some 422/409 responses (e.g., invalid branch, branch protection) can arise for reasons unrelated to the blob SHA — fail-closed either way, but the audit cause can be over-attributed to state drift | ACCEPTED, documented here; GitHub error bodies do not expose a machine-readable discriminator |
| P3-2 | P3 | Legacy-path execution records did not set `conditional_execution`, though the type documentation reserved `not_attempted` for exactly that case — audit filtering could not distinguish the two execution paths by that field | FIXED (legacy path now records `not_attempted`; two assertions updated) |
| P3-3 | P3 | Conditional-path audit payloads lacked the per-dependency provider capability summary (`conditional_execution_supported`-class field required for observability) | FIXED (`provider_capability` now recorded on satisfied/failed/unavailable/crash audit events) |
| P3-4 | P3 | Docs/test-count claims: "242 tests" (actual 243) and "lint green" (was red) | FIXED (corrected in README + docs/atomic-effect-assurance.md) |
| INFO | — | Weak ETags (`W/"…"`) sent as `If-Match` never match under RFC 9110 strong comparison ⇒ mutations permanently 412 (fail-closed, safe, possibly surprising); documented as an operator consideration | DOCUMENTED |

No P0. No P1. None of the adversarial sequences required by §43 ("authorize X, world moves to Y, consequential operation still executes despite claimed conditional support") succeeded against a provider that genuinely enforces its condition.

## 10. Fixes Applied (complete list)

1. `eslint.config.js` — extended the existing `scripts/` no-console exemption to `scripts/**/*.ts` (P2-1).
2. `src/application/execute-action.ts` — legacy-path execution results and audit events now record `conditional_execution: 'not_attempted'` (P3-2); conditional-path audit events record `provider_capability` (P3-3). No behavioral change to decisions, authorization, or execution.
3. `README.md`, `docs/atomic-effect-assurance.md` — test count and lint-status claims corrected (P3-4).
4. `test/assurance/` — 50 independent assurance tests (the audit's own regression suite; also regression-tests P3-2/P3-3).
5. Two milestone assertions updated to the more precise legacy-path audit field (CR5, IR11b).

## 11. Documentation Corrections

- "242 tests green … lint green" → corrected (see P3-4).
- All other strong claims audited: "atomic", "provider-enforced", "TOCTOU", "tamper-evident" — classified PROVEN or correctly bounded (docs/limitations.md already uses "tamper-evident, not tamper-proof" and scopes the executor out of the model). No overclaim found in README/threat-model/limitations/atomic-effect-assurance beyond the two corrected facts.

## 12. Production/Beta Readiness

- Correctness: strong — decisions deterministic, fail-closed defaults, contradictory/unsafe configurations rejected at load time.
- Security: strong for the stated model; executor/caller/provider trust boundaries documented and test-pinned.
- Concurrency: strong — atomic authorization claims verified across processes (SQLite `BEGIN IMMEDIATE`) and 50-way CAS races; exactly-one outcomes everywhere.
- Reliability: strong — every failure mode tested maps to a truthful, distinct outcome; unknown outcome never becomes success.
- Provider integrity: honest capability matrix; per-resource limits stated (GitHub non-file; HTTP without mutation config).
- Auditability: hash-chained, tamper-evident, now path- and capability-complete; tail-truncation limitation documented.
- Developer experience: good — clear errors, policy gate reasons name the exact capability gap, examples run.
- Testing: 293 tests including kill mutations, races, properties, provider contracts, and this audit's independent suite.
- Documentation: accurate after corrections; claims match verified behavior.
- Performance: conditional path independently reproduced as equal-or-faster (p50 0.129 ms vs 0.137 ms legacy; p99 0.343 ms vs 1.138 ms) — it removes a redundant verification fetch rather than adding one.

## 42. GO/NO-GO Checklist

All criteria met: no P0; no P1 in the enforcement path; no documented-API bypass; replay protection survives concurrency; authorization bound to action semantics; conditional execution genuinely provider-enforced where claimed; critical race independently reproduced with no side effect; condition failure invalidates the authorization; no blind retry; provider failures never become success; unsupported conditional execution honestly represented; audit events accurate (now path-complete); database concurrency verified at the DB level; build/typecheck/lint/hygiene green; 293-test regression green; security claims match actual guarantees; remaining limitations explicit.
