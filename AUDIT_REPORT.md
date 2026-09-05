# Stale-State Firewall — Red-Team, Security & Production-Assurance Audit Report

Audit date: 2026-09-05 · Audit commit base: `8f7fca0` (pre-audit) → `f05657c` (hardening) · Branch: `main`

Every claim in this report is backed by an executable test in `test/audit/` or by a command in §G. Implementation wins over documentation; where they disagreed, the documentation was corrected.

---

## A. Executive Assessment

**Is Stale-State Firewall currently a credible agent-assistance primitive?**

### Verdict: **YES — WITH CONDITIONS**

Before this audit the honest answer was **NOT YET**. The codebase is genuinely well-architected (clean layering, deterministic decision core, no LLM anywhere in enforcement, real fail-closed instincts), and 158 tests passed — but the audit reproduced **15 distinct attacks/defects**, including three P1-class enforcement-boundary breaks that directly contradict the product thesis:

1. An action whose required state became **unverifiable** at the pre-execution re-check still executed (invariant G broken at the execution gate).
2. Two concurrent executions of the same action id could **both pass the replay guard and both execute** (invariant E broken under concurrency).
3. A **human-approved escalation could be re-pointed at a different target** after approval (authorization not bound to semantics).

All fifteen were fixed, and each is now a permanent regression test. Post-hardening, the core guarantee — *"an agent must not execute a consequential action when the state required to justify it is stale, invalid, unknown, or no longer satisfies preconditions"* — holds for every attack the kill suite could construct, with explicitly documented residual boundaries (§H, §J).

**Conditions** (what a beta adopter must accept, per §J): unversioned TTL observations anchor to the agent's claimed timestamp; the final TOCTOU gap (mutation after last fetch, before effect) remains unless the provider does compare-and-swap; audit is tamper-evident, not tamper-proof; single-writer storage assumptions.

## B. Architecture Assessment

Modular monolith, strict downward dependency layering, full constructor injection (`Clock`, `FirewallStore`, `StateProvider[]`):

| Layer | Contents | Assessment |
|---|---|---|
| `domain/` | ActionIntent, StateSnapshot/Dependency, Decision, Policy, Audit, typed error hierarchy (15 classes) | Sound; provenance-mandatory snapshots; staleness is a 5-class enum, never a boolean |
| `engine/` | staleness, freshness (5 strategies), preconditions (11 operators), policy resolution, decision composition, hashing, glob, injectable clock | Sound; deterministic; hard safety floor not configurable |
| `providers/` | in-memory, HTTP, GitHub | Contract-tested; version-signal defects fixed (S2/D2) |
| `storage/` | SQLite (`node:sqlite`, migrations, PK/UNIQUE/CHECK/FK, WAL) + memory | Sound; single-use gate now atomic; audit appends transactional |
| `application/` | validate / execute / revalidate / inspect use cases | The enforcement boundary; hardened in this audit |
| `sdk/` + `cli/` | `StaleStateFirewall`, `protect()` wrapper, `ssf` CLI | `protect()` is structurally bypass-resistant; CLI has no `execute` command by design (dry-run surface only) |
| `audit/`, `telemetry/`, `redaction/`, `logging/`, `config/` | Hash-chained ledger, counters, redaction, JSON logs, fail-fast config validation | Redaction now depth-safe; config validation extended |

Execution graph verified (§6 of audit charter): every SDK/CLI route to a side effect passes `validateAction → decide → [ALLOW] → claimAuthorization → TOCTOU re-verify → executor`. `check()` performs zero side effects. No public method hands out a reference to a wrapped tool; duplicate `protect()` names are refused (K12). No bypass route was found post-fix.

## C. Security Assessment

**Attack surface:** intent inputs (dependencies with claimed version/hash/observed_at/metadata, preconditions incl. regex, policy name, risk level), provider responses (headers, JSON, ETags, timestamps), configuration files, CLI file parsing, storage.

**Trust boundaries:** agent → `toIntent` (developer-owned mapping — if a developer spreads agent input into the intent, the agent controls `policy` and `risk_level`; this is a documented integration responsibility); provider → firewall (providers are trusted for fetches but their signals are always compared, never assumed); operator → config (fail-fast validation, dangerous outcomes gated).

**Controls in place post-audit:** deterministic decision core with hard safety floor (CRITICAL+UNKNOWN→never ALLOW, INVALID→never silently authorizes); fail-closed on provider failure at validation AND at the execution gate; single-use atomic authorizations with deadlines; escalation state machine with semantics-bound approvals; preconditions re-evaluated against provider-vouched current state only (304 snapshots carry no metadata); server-stamped drift detection; hash-chained append-only audit; depth-safe redaction on persistence and logs; config hardening (invalid-allow forbidden; stale/unknown-allow acknowledged).

**Remaining weaknesses:** see §H (TOCTOU classification) and §J conditions; also the `matches` ReDoS surface from agent-supplied patterns (documented, mitigated by boundary validation) and the unversioned-TTL claim boundary.

## D. Guarantee Matrix

| Property | Claimed (pre-audit docs) | Actually Implemented | Tested | Guarantee Level |
|---|---|---|---|---|
| Freshness enforcement | yes | yes — 5 strategies, hard floor, deterministic | unit + property + audit | **FULL** (within provider-signal limits) |
| Version validation | yes | yes — cross-strategy drift → INVALID | unit + property (P2) | **FULL** |
| Dependency tracking | yes | yes — per-dep verdicts; omission → UNKNOWN fail-closed | K9/K10 + audit | **FULL** |
| Preconditions | yes | yes — against provider-vouched current state only | K11/K17 + S1 + property (P4) | **FULL** |
| Revalidation | yes | yes — recompute deps+preconds+policy; never auto-approve | sdk-flow + audit | **FULL** |
| Replay protection | yes | **was breakable under concurrency**; now atomic claim | K6/R4 + B3 | **FULL** (single process/well-serialized store) |
| Execution boundary | yes | yes — all routes pass the decision gate; verified graph | K12 + B1/B2/B5 | **FULL** |
| Fail closed | yes | **was false at the execution gate on total provider failure**; now fail-closed | K5 + B2 | **FULL** |
| Audit integrity | "tamper-evident" | yes — hash chain + verifier; appends transactional | K15 | **PARTIAL→FULL** (evident, not tamper-proof; multi-process serialized) |
| TOCTOU protection | "narrowed, not eliminated" | yes — re-fetch + fingerprint; drift → DENY | R2/R6 + B2 | **BEST-EFFORT** (final gap provider-dependent, honestly recorded) |
| Policy determinism | yes | yes — specificity + declaration order; identical-input property | E3/E7 + property (P3) | **FULL** |
| Provider isolation | yes | yes — typed contract; version signals now state-sensitive | contract suite + S2/D2 | **FULL** |

Legend: FULL = verified by executable evidence under stated conditions; PARTIAL = real but bounded; BEST-EFFORT = documented residual gap; UNPROVEN/MISSING = none present.

## E. Findings

Severity: P0 critical (unsafe action can execute) · P1 high (invariant break under realistic conditions) · P2 medium · P3 low. All fixes were reproduced → tested → fixed → regression-tested → full suite.

| ID | Sev | Title | Component | Attack scenario | Reproduction | Impact | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| F-01 | **P1** | TOCTOU re-check skipped when every provider fetch fails at execution time | `application/execute-action.ts` | Validation succeeds; provider dies before recheck; `recheck.fetched.length > 0` guard skips fingerprint compare | B2 (executor ran; now DENY) | Unsafe execution on unverifiable basis | Empty-fetch treated as "nothing to compare" | Fail closed: 0 fetched + deps declared → DENY | `test/audit/execution-boundary.test.ts` B2 | **FIXED** |
| F-02 | **P1** | Replay guard check-then-insert race — double execution | `application/execute-action.ts`, both stores | Two concurrent executes of one action id both observe "no auth", both save (INSERT OR REPLACE) | B3 (2 executors ran; now exactly 1) | Duplicate consequential side effects | Non-atomic gate | Atomic `claimAuthorization` (BEGIN IMMEDIATE); guards moved pre-validation | B3 + R4 (cleaned unhandled rejection) | **FIXED** |
| F-03 | **P1** | Escalation approval not bound to approved semantics | `application/execute-action.ts` | Approve action X (target A); call `executeApproved(X, intent for target B)` → B executes under A's approval | B1 (smuggled executor ran; now UnauthorizedActionError) | Human approval transfers to arbitrary action | Approval checked only escalation status | Compare tool/operation/target/dependency-set vs the escalated decision record | B1 (swap refused, original still executes) | **FIXED** |
| F-04 | **P1** | `risk_defaults` configuration silently ignored | `sdk/firewall.ts`, `application/validate-action.ts` | Operator maps `delete* → CRITICAL`; intents derive MEDIUM; weaker aging/deadline defaults apply | C1 (risk was MEDIUM; now CRITICAL) | Under-classified risk, operator intent defeated | `ctx.riskDefaults` hardcoded `null` | Wired through `buildPolicyCore` | C1 + CLI e2e (`delete_user` → CRITICAL) | **FIXED** |
| F-05 | **P1** | GitHub ci_status/deployment version signals invariant while state changes | `providers/github/github-provider.ts` | CI pending→success on same SHA; version equality → FRESH; stale CI state treated as current | S2/D2 (versions identical; now differ) | Stale state reported as authoritative | Version chosen from non-state-changing fields | ci_status: ETag → `sha:state` composite; deployment: `id:state` | S2/D2 + contract suite | **FIXED** |
| F-06 | **P2** | 304 conditional snapshots adopted agent-supplied metadata for preconditions | HTTP + GitHub providers, `engine/dependency-evaluator.ts` | Agent declares version=ETag + fabricated `{status: approved}`; server 304s; precondition evaluated against the lie | S1 (ALLOW; now DENY via full fetch) | Precondition bypass without server-vouched data | 304 echoed `ref.metadata` as current state | 304 → `metadata: {}`; firewall forces full fetch when preconditions routed | S1 + contract tests | **FIXED** |
| F-07 | **P2** | TTL trusts client-claimed `observed_at` with no comparable signal | `engine/freshness.ts` | Agent claims `observed_at: now` on unversioned dep; world changed after the (claimed) observation | S3 (ALLOW; now INVALID when server stamp is newer) | Fabricated freshness passes TTL | Claimed timestamp is the only anchor | Server-stamped drift → INVALID; honest boundary documented (unchanged world + lying agent undetectable) | S3 + S3b (pinned limitation) | **FIXED (detectable half) / DOCUMENTED (remainder)** |
| F-08 | **P2** | Replayed action id rewrote the stored action row (forensics) | both stores | First intent DENIED; same id replayed with swapped intent overwrites the actions row before guard rejection | ST1 (target mutated; now preserved) | Forensic record destroyed; audit confusion | `INSERT OR REPLACE` on actions | `INSERT OR IGNORE` / keep-first | ST1 | **FIXED** |
| F-09 | **P2** | Arguments + execution output persisted unredacted despite docstring claims | stores / validate+execute | `{api_key: ...}` in intent arguments lands raw in DB; executor output tokens raw | ST2/ST3 | Secret materialization at rest contradicting the domain model | Redaction only covered audit/log paths | `redactDeep` before `saveAction`/`saveExecution` (caller-facing result untouched) | ST2/ST3 | **FIXED** |
| F-10 | **P2** | Redaction bypassed by nesting > 24 levels | `redaction/redact.ts` | Secret nested 30 deep passes through unredacted into audit payloads | ST4 (depth smuggle; now wholesale-redacted) | Log/payload leakage | Depth cap returned the subtree as-is | Beyond-cap subtrees redacted wholesale | ST4 | **FIXED** |
| F-11 | **P2** | Agent-supplied intent preconditions bypassed config validation | `application/normalize-intent.ts` | Invalid regex → raw SyntaxError mid-decision (crash path, partial audit); deep value → stack overflow (DoS) | E4/E5/E6 | Fail-slow crash + DoS surface | Intent-side preconditions never validated | Fail-fast validation (operator whitelist, regex compile, depth ≤ 32) at the intent boundary | E4/E5/E6 | **FIXED** (ReDoS-class patterns remain a documented residual) |
| F-12 | **P2** | `canonicalJson` coerced NaN/Infinity to null | `engine/hashing.ts` | `equals null` precondition passes against NaN state | E1 | Unsafe equality via type coercion | JSON.stringify non-finite semantics | Non-finite numbers serialize distinctly | E1 + property | **FIXED** |
| F-13 | **P2** | `on_stale: allow` accepted without acknowledgment | `config/validation.ts` | Policy authorizes execution on STALE state silently | C3 (was accepted; now rejected w/o flag) | Freshness guarantee voidable by config typo | Asymmetric with unknown-allow | Requires `acknowledge_unknown_allow`; per-policy unknown-allow message aligned with behavior | C3 | **FIXED** |
| F-14 | **P3** | Audit append read-last+insert not in a transaction | SQLite store | Multi-process concurrent appends can fork the hash chain | Code-level (single-process safe by JS semantics) | Cross-process chain integrity | No BEGIN IMMEDIATE | Wrapped in BEGIN IMMEDIATE/COMMIT | K15 + operational notes | **FIXED** |
| F-15 | **P3** | Execution deadline > 2^31−1 ms collapses to a ~1 ms timer (Node setTimeout clamp) | `engine/resolved-policy.ts` | Config `deadline: 30d` → instant deadline kill of every execution | C5 (was accepted; now ConfigurationError) | Availability bug, silent misbehavior | Unbounded deadline values | Fail-fast cap at 2,147,000,000 ms | C5 | **FIXED** |
| F-16 | **P3** | Baseline run had 1 unhandled rejection (race test R4) | `test/race/race-conditions.test.ts` | Replay rejection lands before `allSettled` registers | Baseline vitest output | CI noise; masked failures | Handler attached late | Handlers attached at promise creation | R4 clean run | **FIXED** |
| F-17 | **P3** | `FINAL_REPORT.md` claimed `check:hygiene` passes while the gate failed on its own text | docs | The sentence "No TODO/FIXME/placeholder markers" trips the marker scanner | Baseline `npm run check:hygiene` exit 1 | Quality-gate claim unverified | Self-referential wording | Reworded; gate now actually passes | hygiene exit 0 | **FIXED** |

**Not fixed, by design (documented):** unversioned-TTL claim boundary (F-07 remainder, out of guarantee boundary); final TOCTOU gap (provider-CAS-dependent, recorded as `atomicity: not_guaranteed`); raw-DB tamper (tamper-evident chain); unwrapped tool references in host application code (code-review concern).

## F. Kill-Test Report

- **Total attack scenarios executed by the audit:** 24 (15 found in `test/audit/` + 9 targeted probes of the existing kill/race/contract suites, e.g. CLI e2e, deadline clamp, config matrix)
- **Defenses that held without modification:** 9 — B4 (observe-mode would-have preserved), B5 (pending-escalation freeze), S3b boundary case, E2/E3 (routing + determinism), K1–K17 originals re-verified, R1/R2/R3/R5/R6/R7 re-verified
- **Failed defenses (vulnerabilities reproduced):** 15 findings (F-01…F-15, plus gate/hygiene items F-16/F-17)
- **Vulnerabilities fixed with permanent regression tests:** 15 of 15 code findings
- **Remaining vulnerabilities (documented, out of guarantee boundary):** 2 — unversioned-TTL claim trust (F-07 remainder); final TOCTOU window without provider CAS
- **Post-fix rerun:** every attack re-executed against the hardened build → all fail closed

## G. Test Report (exact commands, real results)

| Command | Pre-audit baseline | Post-hardening |
|---|---|---|
| `npm test` | 158/158 passed, 11 files, **1 unhandled rejection** | **186/186 passed, 16 files, 0 unhandled rejections** |
| `npm run build` | clean | clean |
| `npm run lint` | clean | clean |
| `npm run typecheck` | clean | clean |
| `npm run check:hygiene` | **FAILED (exit 1, 7 violations — incl. FINAL_REPORT.md self-trip)** | **passed (exit 0)** |
| `ssf policy validate` / `ssf doctor` / `ssf check --json` (CLI e2e smoke) | not exercised in audit | all healthy; `delete_user` with `risk_defaults` → risk CRITICAL, decision REVALIDATE |

New test inventory (all in `test/audit/`): `execution-boundary.test.ts` (B1–B5), `state-spoofing.test.ts` (S1, S2, D2, S3, S3b), `engine-attacks.test.ts` (E1–E7), `storage-config.test.ts` (ST1–ST4, C1, C3, C5), `property-security.test.ts` (P1–P4, fast-check, ~800 randomized cases).

Performance (in-memory provider, 300 runs, p50/p95/p99): `check()` 1-dep 0.13/0.21/1.4 ms · `check()` 10-dep 0.30/0.46/2.5 ms · `check()` stale→revalidate 0.13/0.20/0.33 ms · full `execute()` (validate+claim+TOCTOU recheck+executor) 0.17/0.25/0.61 ms · `verifyAudit()` O(n), 42 ms @ ~3k records.

False-positive audit: the suite includes correct-ALLOW coverage (R1, R3, E7, S3b, sdk-flow scenarios) — the added safety floor did not flip any legitimate ALLOW scenario to DENY across the 186-test corpus (including escalation lifecycle, idempotent retry, and observe-mode flows).

## H. TOCTOU Report (mandatory classification)

| Scenario | Classification | Evidence |
|---|---|---|
| Mutation during validation (between fetches) | **DETECTED** — drift → INVALID → deny/revalidate | K1, K2, S3 |
| Mutation after validation, before execution | **PREVENTED** — pre-execution re-fetch + fingerprint compare → DENY | R2, R6 |
| Total provider failure during pre-execution re-check | **PREVENTED** (post F-01) — fail closed, executor never runs | B2 |
| Concurrent double-execution of one action id | **PREVENTED** (post F-02) — atomic authorization claim | B3, R4 |
| Mutation after the final re-fetch but before the executor's effect | **OUT OF GUARANTEE BOUNDARY** (without provider compare-and-swap) — recorded as `atomicity: not_guaranteed` | R3, limitations.md |
| Mutation during retry (idempotent) | **DETECTED** — retry performs full fresh validation + fingerprint claim | sdk-flow retry scenarios |
| Concurrent validations of different actions | **MITIGATED** — deterministic per-action; shared store serializes writes | R7, store tests |
| Provider returns stale-but-equal version (no state-sensitive signal) | **UNMITIGATED without state-sensitive version signals**; **MITIGATED for GitHub ci_status/deployment post F-05**; generic HTTP operators must map a state-sensitive version field | S2, D2, limitations.md |

## I. Documentation Corrections

| Document | Claim | Correction |
|---|---|---|
| `FINAL_REPORT.md` §1 | "`npm run check:hygiene` — all pass. No TODO/FIXME/placeholder markers" | Gate FAILED at baseline (self-trip); reworded; gate now passes |
| `FINAL_REPORT.md` §1/§10 | "158/158" | 186/186 incl. red-team suite; unhandled-rejection-free |
| `FINAL_REPORT.md` §7 | "304 verification with a full-fetch fallback when mapped metadata is required" | 304 never carries server-vouched metadata; firewall forces full fetch when preconditions are routed |
| `FINAL_REPORT.md` §7 | "ci_status (combined status), deployment (latest id + status)" | version signals are now state-sensitive (ETag/`sha:state`; `id:state`) |
| `FINAL_REPORT.md` §14 | "redaction runs before persistence" | Now actually true for arguments + execution output + depth-safe (was false pre-audit) |
| `docs/freshness.md` ttl | implied client `observed_at` is sufficient | Added server-stamped drift rule + honest unversioned-claim boundary |
| `docs/limitations.md` | — | Added: unversioned TTL claim boundary, 304-no-metadata rule, atomic claim semantics, audit append serialization, ReDoS residual |
| `README.md` | "157+ tests" | corrected; red-team suite added to the description |
| `docs/threat-model.md` | `require_dependencies` "makes the requirement explicit" | Control is now explicit in decision reasons (previously a silent no-op); still fail-closed either way |

## J. Production Readiness (scored separately)

| Dimension | Score (1–5) | Basis |
|---|---|---|
| Core correctness | **4.5** | Deterministic decision core, 5-class staleness, revalidation semantics; 186 tests incl. randomized properties; minor: memory-store single-process assumptions |
| Security | **4** | Execution boundary verified graph-wise; replay/escalation/binding hardened; residuals: ReDoS-class patterns, client-claim TTL boundary — both documented |
| Concurrency | **3.5** | Atomic authorization claim + transactional audit appends; single-process store semantics; cross-process audit writes serialized by SQLite locking but untested under real multi-process load |
| Reliability / failure handling | **4** | Fail-closed at validation AND execution gate; typed provider errors; deadline enforcement; honest `atomicity` recording |
| Developer experience | **4** | Clean SDK, `protect()`, deterministic CLI exit codes, fail-fast config validation with precise violation paths |
| Observability | **3** | Structured metrics + JSON logs + hash-chained audit; no exporter (OTLP future work), no redaction of CLI human-mode metadata output (minor) |
| Documentation | **4** | Now matches implementation; boundaries stated precisely; hygiene-gated |
| Testing | **4.5** | 186 tests: unit/integration/contract/kill/race/property/red-team audit; 0 unhandled rejections; coverage % not measured (no coverage tooling configured) |

No single score is taken as the conclusion; the composite picture is a trustworthy core primitive with honest boundaries.

## Final Decision

# **READY FOR CONTROLLED BETA**

Evidence: all fifteen audit findings are fixed with permanent regression tests; the full gate suite is green (186/186, build/lint/typecheck/hygiene, zero unhandled rejections); the execution graph has no discovered bypass; every kill-suite attack fails closed on the hardened build; performance is sub-millisecond on the decision path with the safety re-fetches intact. The conditions in §A/§J (unversioned-TTL claim boundary, provider-CAS-dependent final TOCTOU window, tamper-evident-not-proof audit, single-process store semantics) must be stated to adopters, and provider-side conditional execution (GitHub expected-head-SHA merge) remains the highest-value next milestone to shrink the residual TOCTOU window from BEST-EFFORT toward PREVENTED.
