# SSF Internal Dogfood + Production Simulation Report

**Milestone:** Internal dogfood + production simulation (post assurance audit `9a34e90`)
**Status line:** `DOGFOOD STATUS: YELLOW — expand internal usage WITH CONDITIONS`
**Date:** 2026-09-06

---

## 1. Executive Summary

Sixteen dogfood scenarios (15 mandated + 1 crash/restart deep-dive) were executed against the
real SSF implementation using only public APIs/SDK surfaces, in-memory providers, a controlled
HTTP server with RFC 9110 If-Match semantics, and the live GitHub Contents API. The campaign
produced **five defects (DF-1 … DF-4 + DF-F1, all fixed and regression-pinned)**, **zero false
positives**, **zero false negatives** (no unsafe execution was observed where a guarantee
applies), and **two confirmed, documented provider trust boundaries** that the firewall cannot
and does not paper over.

The headline result is that SSF's enforcement core held up under every real-world attack it
was given: stale conditional mutations were refused by the providers themselves (GitHub blob-sha
CAS, HTTP If-Match, in-memory CAS), replays were refused even under concurrency, argument and
target tampering were structurally refused, provider outages never produced a fuzzy ALLOW, and
unknown execution outcomes were recorded honestly as failures with an explicit
side-effect-may-have-occurred qualification. The defects found were integration and
observability defects — real and worth fixing, but none broke the enforcement boundary.

**Why YELLOW, not GREEN:** the two documented boundaries (§6) — the If-Match operator
verification duty and the write-only CAS scope (DF-F2) — plus one remaining friction finding
(refusal messages do not consistently answer "is a retry safe?") must be internalized by every
integrator before this firewall sits between agents and consequential operations at larger
scale. None is an unresolved code defect; all are operator-facing conditions.

**Core question (§36) answered: YES, WITH CONDITIONS** — see §12.

---

## 2. Dogfood Environment

| Item | Value |
| --- | --- |
| Repo | `desurfofficial-ship-it/Stale-State-Firewall-` (local: `ssf-dogfood`) |
| Base commit | `9a34e90` (assurance audit) + dogfood working tree (this report's fixes) |
| Package version | `stale-state-firewall@0.1.0` |
| Runtime | Node v24.19.0, TypeScript 5.x, vitest, SQLite (better-sqlite3) + MemoryStore |
| Providers exercised | `InMemoryStateProvider` (atomic CAS), `HttpStateProvider` against a controlled local server (`dogfood/scripts/sandbox-http-server.mjs`), `GitHubStateProvider` against the **live** Contents API |
| GitHub sandbox | dedicated repo `desurfofficial-ship-it/ssf-dogfood-sandbox` (token `SSF_GITHUB_TOKEN`); no production repo was ever touched; all files created under `dogfood/` in the sandbox and deleted in cleanup steps |
| Dogfood layout | `dogfood/{scenarios,fixtures,scripts,reports}` — scenario scripts, shared harness (`fixtures/lib.mjs`), worker processes, telemetry + per-scenario records + state DBs |
| Reset | every scenario creates its own provider/state/resources and its own DBs under `dogfood/reports/state/`; deleting the directory fully resets the environment |
| Evidence | `dogfood/reports/records/S*.json` (one record per scenario), `dogfood/reports/telemetry.jsonl` (append-only local telemetry, **nothing is transmitted**) |

**Evidence note (honesty):** a mid-session re-run of S13 initially failed with a transient
network outage (`fetch failed`; external connectivity was temporarily down). Connectivity was
restored and S13 was **re-run to completion against the live API in the same campaign**
(verdict PASS, fresh record). During the outage window, the prior run's persisted evidence —
per-agent SQLite audit DBs (`dogfood/reports/state/s13-agent-{a,b}.db`) and append-only
telemetry — already demonstrated the same outcome: GitHub-provider `ALLOW → satisfied →
executed` (857 ms), a stale claim `DENY`, and the concurrent race where one agent's CAS was
`satisfied` (859 ms) and the other's was refused as `failed` (1264 ms), with the audit chain
`action.proposed → action.validated (ALLOW) → execution.condition_failed → action.blocked`
against the real API. The pre-DF-4 audit events in the older DBs lack `failed_ref`; the fresh
run (post-DF-4 build) plus the DF-4 unit regression verify the fixed attribution.

---

## 3. Scenario Results

| # | Scenario | Result | Expected | Actual (measured) | Severity |
| --- | --- | --- | --- | --- | --- |
| S01 | Stale file edit (§5) | **PASS** | provider refuses stale conditional mutation; no overwrite; auth unusable; audit truthful; fresh eval required | `condition_failed`, observed v2 vs authorized v1; file kept human edit; replay refused; audit recorded `execution.condition_failed` (never executed); fresh re-evaluation produced a new authorization and applied the edit | — |
| S02 | Concurrent agents (§6) | **PASS** | exactly one winner; loser gets explainable condition failure; audits agree with server truth | 1 winner / 1 loser across processes on shared state; server truth = 1 mutation; 8-way race: 1 satisfied, 7 `condition_failed`, provider log = 1 mutation | — |
| S03 | Human intervention (§7) | **PASS** | human-caused staleness detected in every window with a guarantee | validation-window drift → DENY (fresh eval); CAS-window drift → provider refused, zero side effect; dependency drift (lodash bump) → DENY at validation | — |
| S04 | Agent believes it is right (§8) | **PASS** | firewall separates agent belief from authoritative external state | unrecognized claimed version made the dependency INVALID → DENY; belief never executed on | — |
| S05 | Multi-dependency action (§9) | **FINDING** | refuse unsafe execution; audit isolates the drifted dependency | written-dep drift refused by CAS; **read-only dep drift executed in the CAS window** (DF-F2, documented); condition-failure audit now names the drifted ref (DF-4 fixed) | P2 (scope, documented), P3 (fixed) |
| S06 | Policy change (§10) | **PASS** | old authorizations cannot execute after a policy change; fresh attempts follow the new policy | authorizations are single-use inside one `execute()`; actionId reuse refused as `ReplayDetectedError` (audited); fresh attempt under CRITICAL policy allowed; refusing policy → DENY; **cross-deployment actionId reuse is store-scoped and not blocked** (documented scope, not a defect) | — |
| S07 | Provider outage (§11) | **PASS** | no unsafe success, no fuzzy ALLOW, no blind retry under hang/5xx/429/reset/garbage | all 6 validation faults → typed errors, `REVALIDATE`→`DENY` for every risk level; all 6 mutation faults → failure with UNKNOWN condition outcome (never satisfied/never executed); retry of faulted authorization refused | — |
| S08 | Unknown execution outcome (§12) | **PASS** | never claim SUCCESS, never claim NOT EXECUTED when the response is lost | timeout-after-apply: `success=false` + audit note "whether the provider evaluated the condition is unknown"; server truth confirmed the mutation landed — divergence surfaced honestly; blind retry refused; fresh read reconciles | — |
| S09 | Replay (§13) | **PASS** | one authorization, one execution; replays refused and audited | sequential replay refused; concurrent replay: 1 winner / 1 rejected; shared-store claim race: exactly one winner; post-condition-failure replay refused; every replay audited | — |
| S10 | Argument tampering (§14) | **PASS** (after fix) | authorization binds arguments, not just tool/target/deps | normal path structurally bound; cross-ref substitution refused by CAS; **escalation approval initially did not bind arguments (DF-3) — fixed and re-verified: tampered resubmission refused** | P1 (fixed) |
| S11 | Target tampering (§15) | **PASS** | authorized target A, execute B → DENY | same-operation/different-target refused; same-target/different-state refused; CAS is ref-scoped | — |
| S12 | Dependency staleness, 5 deps (§16) | **FINDING** | single drift isolated and detected | written-dep drift refused by CAS with per-ref expected/observed in audit; 4/4 **read-only** drifts executed in CAS window (DF-F2, documented); pre-execute drift refused at validation (every declared dependency re-read) | P2 (scope, documented) |
| S13 | GitHub real-world (§17) | **PASS** | real provider conditional behavior, side effects, audit, no credential leakage | live Contents API: file CAS (blob-sha) `satisfied → executed`; stale claim `DENY`; concurrent race → agent-a satisfied, agent-b refused `condition_failed` by GitHub (one mutation in server truth); non-file resource refused as NOT conditional (honest, not pretended); cleanup removed sandbox files; token absent from all audit records | — |
| S14 | HTTP real-world (§18) | **FINDING** | correct server enforces; changed state → 412 `condition_failed`; broken server demonstrates documented trust boundary | Case A applied; Case B-race refused (412) with `condition_failed`; **Case C: If-Match-ignoring server applied the stale write while the firewall honestly recorded `satisfied`/`guaranteed`** — the documented operator-verification boundary demonstrated end to end | P2-DOC (confirmed, documented) |
| S15 | Internal dev workflow (§19) | **PASS_WITH_FRICTION** | realistic multi-tool workflow integrates naturally; friction measured; errors agent-usable | workflow completes end to end; **DF-F1 resolved**: `protect()` now reaches the provider CAS via `conditionalRun` and the audit records provider-enforced execution; refusal messages name state/versions/policies; remaining friction: retry-signal not consistently explicit (§7) | friction (§7) |
| S16 | Crash/restart durability (§24–29 deep-dive) | **PASS** | §28 DB durability + §29 crash recovery at the 8 injection points | Case A (crash pre-apply): no side effect, orphaned claim durable, blind retry refused, chain verifies; Case B (crash post-apply pre-response): side effect occurred, firewall never recorded success, chain verifies, retry refused, fresh action id proceeds with no stuck state or double-claim | — |

Totals: **11 PASS, 3 FINDING (all documented provider limitations), 1 PASS_WITH_FRICTION,
1 PASS (deep-dive)** — 16/16 scenarios executed, 0 ERROR (after fixes; S06's initial ERROR was
a scenario-harness wiring bug — replay protection is per-store and the probe now runs against
the same store, with the cross-store scope recorded honestly).

---

## 4. Security Findings (P0–P3)

**P0 — none found.** No path produced an unsafe execution where a guarantee applies.

**P1 — DF-3: escalation approval binding did not cover arguments.**
`executeApprovedAction` compared tool, operation, target and dependency refs of a resubmitted
action against the approved escalation — but not the arguments payload. An approved escalation
("purge table users, single-row 42") could be executed with different arguments ("full-table").
Found by S10; fixed by binding the canonicalized **redacted** arguments (redaction keeps the
comparison honest without persisting secrets in the error path); pinned by regression test
`DF-3` plus a determinism companion test proving secret-value rotation alone cannot smuggle a
payload. Severity rationale: it is a real enforcement-path gap, but it required a human-approved
escalation as the carrier, which is why it is P1, not P0.

**P2 — DF-1: `GitHubStateProvider` constructed directly applied no defaults.**
The documented SDK path (direct construction) got no `apiBase`/`timeoutMs` defaults; an omitted
`timeoutMs` made every request fail (`AbortSignal.timeout(undefined)` → TypeError). Fixed:
constructor applies the config-path defaults; regression test asserts both the default URL and
the typed-unavailable error under a hanging fetch.

**P2 — DF-2: conditional fetches of GitHub `file` resources hit the repo root.**
`urlFor()` had no `file` case, so If-None-Match fetches compared the claimed blob sha against
the **repo object's weak etag** — every real file validation classified INVALID. Fail-closed,
but it made the file CAS guarantee unusable against the real API (simulated-response tests
missed the wrong URL). Fixed to route to the same URL `fetchFile()` uses; regression test
asserts the file contents URL is used and the etag comparison succeeds.

**P2 — DF-F2 (S05/S12): provider-enforced CAS covers only the resources the effect WRITES.**
A read-only dependency that drifts between authorization and execution is **not** re-verified in
the conditional path; action parameters derived from read-only deps can be applied from
authorization-time values. This is the providers' contract (per-resource CAS; no multi-resource
atomicity exists on any supported provider). Resolution: **documented explicitly** in
`docs/limitations.md` and `docs/atomic-effect-assurance.md` with operator guidance (restructure
the intent so the drifted resource is the conditioned one; verify via provider-vouched
preconditions; or re-observe and resubmit). No code change claimed.

**P2-DOC — S14: If-Match operator verification duty confirmed live.**
Against a server that ignores `If-Match`, the firewall records `condition=satisfied` and
`atomicity=guaranteed` while the provider enforced nothing — the stale write landed, and the
firewall cannot detect it (it does not wiretap the server). This is the documented trust
boundary, demonstrated end to end. Docs require the operator to verify If-Match enforcement per
endpoint (Case C of the dogfood harness provides the verification recipe).

**P3 — DF-4: condition-failure audit did not fully identify the drifted dependency.**
With multiple dependencies, `execution.condition_failed` recorded the expected-state array and
a single `observed_version` — attribution was inferable but not explicit, and the executor's
refusal message was dropped entirely. Fixed: `ConditionalExecutionResult` failed-shape now
carries `ref`, and the audit event records `failed_ref` + `provider_error`; the fixture
executors name the refused ref. Pinned by regression test `DF-4`.

**P3 — DF-F1 (S15): `protect()` could not express conditional execution** — the flagship
guarantee was unreachable through the most ergonomic integration API (protected tools always
took the legacy path, and under `require_conditional_execution: true` were blocked outright).
**Fixed** (see §8); resolution verified by S15 re-run (step1 executes via the CAS path; audit
records "executed under provider-enforced conditional execution") and regression test `DF-5`.

---

## 5. False Positives

**0 false positives observed across all 16 scenarios** (measured: 32 blocks classified
`CORRECT_BLOCK`, 7 `PROVIDER_LIMITATION`, 3 `UNKNOWN` — the UNKNOWNs are honest
outcome-uncertainty records in S08, not misclassifications of safe actions as unsafe).

Friction counters accumulated across scenarios (`attempted / allowed / denied / revalidated /
condition_failed / provider_failed / unknown`): every denial traced to one of — a genuinely
stale claim (correct), a policy requirement the integration knowingly accepted (correct), a
provider limitation (documented), or an intentionally faulted environment (correct fail-closed).
No scenario recorded an agent being blocked on fresh, valid state.

Per-item FP table: **empty — no items met the definition** (expected-allow that was denied).
The closest friction analogues are recorded under §9 (developer friction), none of which
classified as false positives.

---

## 6. False Negatives

**None observed** in the scenarios executed: no unsafe or stale action expected to be blocked
succeeded anywhere in the campaign. Two executions occurred that a *deployer* might wish had
been blocked — the read-only-dependency drift cases (DF-F2, S05/S12) and the If-Match-ignoring
server case (S14) — but both are **outside the documented guarantee scope** (read-only deps are
not CAS-conditioned; the broken server enforces nothing), were classified
`PROVIDER_LIMITATION` at discovery time, and are documented as such. They are listed here for
completeness, not explained away: an operator who needs those cases covered must not rely on
SSF's conditional-execution guarantee.

This statement is scoped: it means none were **observed**. It does **not** claim none exist.

---

## 7. Provider Findings

**In-memory (reference):** fully synchronous atomic CAS; the critical-race window is closed by
construction. Serves as the ground truth the other providers were compared against.

**GitHub (live API):** blob-sha-in-PUT is a true compare-and-swap on file contents; observed
refusals are explicit and typed (404/409/422 → `condition_failed`). Latency measured in the
S13 race: successful conditional update ~0.86–1.26 s end to end (network-dominated). Weak
caveats found and fixed in dogfood: default-less direct construction (DF-1) and the `file`
conditional-fetch URL (DF-2). Conditional fetches use If-None-Match with strong etags on file
blobs; repo-root etags are weak and must never be used for file comparison.

**HTTP (controlled server):** If-Match semantics give a real CAS **only when the server
implements RFC 9110 preconditions correctly** — and there is no way for the firewall to verify
that from the client side (Case C proved the failure mode is silent). 412/409 map cleanly to
`condition_failed`. Operational assumptions: per-endpoint operator verification of If-Match
enforcement; `condition_failed_status` must be configured to match the server's actual refusal
code.

**Unknown-outcome semantics (all providers):** a lost response after the request was applied is
indistinguishable from a lost request. The firewall's answer — record failure with an explicit
"unknown whether the provider evaluated the condition" note, consume the authorization, refuse
blind retry, reconcile via fresh read — is the only honest representation, and it held in every
fault-injection case (S07/S08/S16).

---

## 8. Reliability Findings

- **Crash/restart (S16):** killing the process at the authorization-claim point (pre-apply)
  leaves a durable orphaned claim with zero external side effect; blind retry after restart is
  refused (`ReplayDetectedError`); the operator reconciles with a new action id and fresh state.
  Killing between provider-apply and response (post-apply) leaves the firewall — correctly —
  with no success record while the external world *did* change; the audit never claims what it
  did not observe; a fresh action id claims and executes normally with no stuck state and no
  double-claim corruption. Audit chains verify in both cases after restart.
- **SQLite cross-process:** concurrent claim on shared state yields exactly one winner
  (verified in S09 shared-store race and the assurance suite's cross-process tests).
- **Concurrency:** 2-process and 8-way races produced exactly the expected winner/loser split
  with consistent per-agent audits and server truth (S02).
- **Outage semantics:** hang/500/503/429/reset/garbage during fetch → `REVALIDATE`/`DENY`
  fail-closed for every risk level; during mutation → failure with UNKNOWN condition outcome,
  never a satisfied or executed claim (S07).
- **Remaining reliability risk (documented):** reconciliation after a post-apply crash requires
  a human/agent fresh read; the firewall intentionally refuses to guess.

---

## 9. Developer & Agent Friction

Measured per §20–23 across S15 and the integration work:

1. **Refusal messages do not consistently answer "is a retry safe?"** — scored agent-perspective
   (what happened / why / retry-signal / fresh-state / human-needed): `what` and `why` are
   reliably present; `retry_safe_signal` was false on the stale-claim refusal and
   `fresh_state_needed` false on one block. The messages name state, versions and policies
   (agent-usable), but the retry contract should be explicit in the text. *Open friction item.*
2. **Legacy-path actions require hand-built executors** — tools whose providers lack CAS need a
   boilerplate executor object; a helper would reduce integration cost. *Open friction item.*
3. **`refKey` is not exported as a runtime helper** — integrators re-implement
   `<source>:<resource>/<resource_id>` string assembly to match expected-state entries.
   *Open friction item.*
4. **Default storage path `./ssf-state.db` is a shared-state trap for newcomers** — two agents
   started in the same directory silently share one DB (S02 lesson); visible in dogfood state
   directories. *Open friction item.*
5. **Resolved during dogfood:** `protect()` conditional-execution gap (DF-F1) — the ergonomic
   path now reaches the CAS guarantee; `GitHubStateProvider` defaults (DF-1); file CAS URL
   (DF-2); audit attribution (DF-4).

Latency: in-memory validation+execution ≈ 0–1 ms; protected edit through `protect()`
(includes validation) ≈ 4.4–6 ms; live GitHub conditional update ≈ 0.86–1.26 s
(network-dominated). No scenario showed latency-induced behavioral problems.

---

## 10. Fixes Made in This Milestone (all regression-pinned in `test/dogfood/regressions.test.ts`)

| ID | Fix | Type | Tests |
| --- | --- | --- | --- |
| DF-1 | `GitHubStateProvider` applies config-path defaults when constructed directly | integration bug (P2) | DF-1 |
| DF-2 | GitHub `file` conditional fetch targets the file contents URL, not the repo root | integration bug (P2) | DF-2 |
| DF-3 | Escalation approval binds the canonicalized redacted arguments | security (P1) | DF-3 + companion |
| DF-4 | `condition: 'failed'` carries `ref`; audit records `failed_ref` + `provider_error` | observability (P3) | DF-4 |
| DF-F1 | `protect()` spec accepts `conditionalExecutionSupported` + `conditionalRun`; `BlockedActionError` carries the execution result | integration blocker (P3) | DF-5 |

Docs updated: `docs/sdk.md` (protect() conditional path), `docs/limitations.md` +
`docs/atomic-effect-assurance.md` (DF-F2 guarantee scope, written during the campaign).

---

## 11. Remaining Risks

1. **If-Match operator duty (S14):** an unverified HTTP endpoint can silently void the CAS
   guarantee. Mitigation: the dogfood Case-C verification recipe; keep the boundary loud in
   `docs/providers.md`.
2. **Write-only CAS scope (DF-F2):** read-only dependency drift in the CAS window is outside
   the guarantee. Mitigation: intent restructuring guidance in the docs; per-action review of
   which deps are conditioned.
3. **Store-scoped action ids (S06-2b):** the replay guarantee is per deployment; two
   independent SSF deployments do not share replay state.
4. **Audit tail-truncation detection** (carried from the assurance audit): modification is
   detected, tail truncation is not — hash-chained without an anchor.
5. **Executor trust boundary** (carried): a lying executor can still record `success` for an
   unconditional write; pinned and documented, not solved.
6. **Open friction items** (§9.1–9.4): none is a safety issue; all are integration-quality
   debt that will generate support confusion if unaddressed.

---

## 12. Recommendation

**EXPAND INTERNAL USAGE — with conditions.**

Conditions, all operator-facing:
1. Every HTTP endpoint wrapped by SSF must pass the If-Match verification recipe (S14 Case C)
   before an agent is pointed at it.
2. Integrators must read the DF-F2 scope note and decide, per action, whether read-only
   dependency drift is acceptable or the intent must be restructured.
3. Deployment hygiene: one SSF store per trust domain (store-scoped action ids), explicit
   storage path (no default `./ssf-state.db` sharing).
4. The §9 friction items (retry-contract wording, `refKey` export, executor helper) should be
   picked up before non-author integrators arrive; they are cheap and prevent the most likely
   support escalations.

**Core question (§36): YES, WITH CONDITIONS** — if SSF were placed tomorrow between our agents
and consequential development operations, the evidence of this campaign says it would
significantly reduce stale-state execution risk without intolerable operational friction,
*provided* the conditions above are honored. The proof points: every stale conditional mutation
was refused by the provider itself under real concurrency and real APIs; replay, tampering,
outage, and unknown-outcome paths all failed closed with truthful audits; and the only
executions a deployer might regret are the two explicitly documented guarantee-scope
boundaries, which the firewall reports honestly rather than papering over.

---

## 13. Exit Criteria (§35) — Checklist

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Real development workflow, not a toy harness | ✅ | S15 multi-tool workflow (edit/bump/deploy/CI gate/stale re-check) |
| 2 | Real public APIs/SDK only | ✅ | scenarios import `stale-state-firewall` public surface; no internal test helpers |
| 3 | ≥1 real stale-state attack reproduced | ✅ | S01–S05, S10–S12 (CAS-window and validation-window attacks) |
| 4 | ≥1 real conditional provider operation | ✅ | S13 live GitHub CAS (857 ms satisfied, 1264 ms refused); S14 If-Match cases A/B |
| 5 | Concurrency tested | ✅ | S02 (2-process + 8-way), S09 concurrent replay, assurance cross-process claim |
| 6 | Replay tested | ✅ | S09 sequential/concurrent/post-condition-failure |
| 7 | Provider outage tested | ✅ | S07 (hang/500/503/429/reset/garbage × fetch/mutation × 4 risk levels) |
| 8 | Unknown execution outcome tested | ✅ | S08 (timeout-after-apply, connection loss), S16 Case B |
| 9 | Human/state-change intervention tested | ✅ | S03 (4 windows incl. live GitHub) |
| 10 | Multi-dependency action tested | ✅ | S05, S12 (3- and 5-dependency workflows) |
| 11 | False positives measured | ✅ | 0 FP; classification table §5 |
| 12 | False negatives investigated | ✅ | §6 (2 scope-boundary cases classified `PROVIDER_LIMITATION`, documented) |
| 13 | Audit log reviewed by a human for reconstructability | ✅ | §24 review pass on S01/S05/S15/S16 chains; DF-4 closed the attribution gap |
| 14 | Error messages reviewed from the agent perspective | ✅ | S15 error-score table (§9.1 records the remaining gap) |
| 15 | Retry behavior reviewed | ✅ | blind retry refused in every case (S01/S08/S09/S16); condition-failure retry contract verified |
| 16 | Crash/restart reviewed | ✅ | S16 both critical windows + orphaned-claim durability |
| 17 | No unresolved P0/P1 | ✅ | P1 DF-3 fixed+pinned; no P0 found |
| 18 | Full test suite green | ✅ | 299/299 (25 files) incl. 6 dogfood regressions |
| 19 | Build / typecheck / lint green | ✅ | `npm run build`, `npm run typecheck`, `npm run lint` all clean |
| 20 | Docs match reality | ✅ | sdk.md (protect conditional path), limitations.md + atomic-effect-assurance.md (DF-F2), this report |

---

## 14. Telemetry Statement

All metrics above were collected locally (`dogfood/reports/telemetry.jsonl`: scenario, provider,
risk, decision, conditional capability, execution outcome, condition result, latency, failure
classification). **Nothing is transmitted anywhere**; the telemetry file is a local artifact for
this report and can be deleted with the rest of `dogfood/reports/`.
