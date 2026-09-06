# SSF Internal Operationalization + Continuous Dogfood Report

**Milestone:** Internal operationalization + continuous dogfood (post dogfood report `62a7ec3`)
**Status line:** `OPERATIONALIZATION STATUS: GREEN — cleared for continuous internal use as designed`
**Date:** 2026-09-06

---

## 1. Executive Summary

This milestone transformed SSF from *a proven security mechanism we can test*
into *an internal infrastructure component we can operate*. The enforcement
core was deliberately left untouched (milestone §4: no reopening solved
security work without evidence); the work went to the surfaces humans and
agents actually operate: recovery semantics, failure classification,
observability, policy guidance, and a continuous dogfood loop.

The headline results:

1. **Every failure now carries a machine-readable recovery contract** — what
   failed, whether retrying is safe (`SAFE` / `SAFE_ONLY_AFTER_FRESH_EVALUATION`
   / `UNSAFE` / `REQUIRES_HUMAN_REVIEW`), whether the side effect may have
   occurred, and ordered next steps. This closed the #1 dogfood friction
   finding (refusals not answering "is a retry safe?").
2. **Unknown execution outcomes are explicit.** A faulted conditional operation
   is recorded `conditional_execution: 'unknown'` — never success, never "not
   executed" — with `UNSAFE` retry guidance and a local metric.
3. **Provider failures are classified** (`NOT_FOUND`, `RATE_LIMITED`,
   `TIMEOUT`, `NETWORK_ERROR`, `SERVER_ERROR`, …) without collapsing typed
   errors or leaking credentials.
4. **A continuous dogfood harness exists** (`npm run dogfood`): 12 realistic
   scenarios (11 offline deterministic + live GitHub opt-in), every step
   classified as expected-block / expected-success / documented-boundary /
   unexpected / security-failure. Current run: **12/12 PASS including live
   GitHub** (17 expected security blocks, 20 expected successes, 2 documented
   boundaries, 0 unexpected, 0 security failures).
5. **Operational documentation set is complete**: operating model, policy
   baseline (CLI-validated), incident playbook, provider capability matrix +
   HTTP operator verification checklist, canonical integration example.

**Core question (§33) answered: YES, WITH CONDITIONS** — see §18.

---

## 2. Current Baseline

Independently verified against HEAD at milestone start (commit `62a7ec3`,
working tree clean):

| Gate | Claimed | Verified |
|---|---|---|
| `npm test` | 299/299 | **299/299 PASS** (25 files) |
| `npm run build` | PASS | **PASS** |
| `npm run typecheck` | PASS | **PASS** |
| `npm run lint` | PASS | **PASS** |
| `npm run check:hygiene` | PASS | **PASS** |

Additional suite inventory confirmed present and green: integration, contract,
kill, race, conditional, property, assurance, dogfood regressions. The previous
dogfood report was synchronized with HEAD (verified, not assumed). Runtime:
Node v24.19.0, TypeScript 5.x, vitest, SQLite (`node:sqlite`) + MemoryStore.

Final gate at milestone end: **307/307 tests (26 files)**, build/typecheck/
lint/hygiene all clean, `npm run dogfood` PASS, benchmark within guardrails.

## 3. Operating Model

**`docs/OPERATING_MODEL.md`** (new) — the normative document for internal
consumers. It answers, grounded in the implementation: when an agent invokes
SSF; what makes an action consequential; what must be declared (dependencies,
preconditions, arguments — and the honesty requirement on version claims);
when conditional execution must be required; the post-`condition_failed` and
post-unknown-outcome flows; the authoritative retry table; when a human must
intervene; the trust-boundary summary; the audit-event → operator-question map;
and the local metrics model. No invented guarantees: every section cites the
enforcing code, a dogfood scenario, or a regression test.

## 4. Policy Baseline

**`docs/POLICY_BASELINE.md`** (new) + **`dogfood/configs/internal-baseline.yaml`**
(new). Uses the repository's existing model (risk LOW/MEDIUM/HIGH/CRITICAL;
`on_fresh/on_stale/on_unknown/on_invalid`; `execution` block) — no new
categories were introduced. The baseline defines recommended behavior for
freshness, unknown state, condition failure, conditional-unavailable, replay,
escalation, deadline, provider failure, and unknown execution outcome, then
gives **nine reference policy examples** (read-only, file modification, config
change, CI modification, dependency update, database migration, deployment
change, security-policy change, destructive operation), each with action /
dependencies / risk / required state / conditional requirement / expected
behavior.

Verification: `ssf policy validate --config dogfood/configs/internal-baseline.yaml`
→ **configuration OK**; `ssf policy test` → **1/1 passed**.

## 5. Dogfood Harness

**`npm run dogfood`** (new, `dogfood/harness/`) — the continuous internal
dogfood command. 11 deterministic scenarios + `12-github-conditional-mutation`
(opt-in via `npm run dogfood:github`, gated on `SSF_GITHUB_TOKEN`, sandbox
repository only). Scenario coverage mirrors the mandated list: stale state,
CAS race (shared SQLite store), replay, target substitution, argument
substitution (escalation binding), multi-dependency staleness, provider
failure, unknown outcome, HTTP conditional mutation, broken-server boundary,
dependency-completeness boundary (DF-F2), policy change, live GitHub CAS.

Verdict taxonomy (§14): `EXPECTED_SECURITY_BLOCK` / `EXPECTED_SUCCESS` /
`DOCUMENTED_BOUNDARY` / `UNEXPECTED_FAILURE` / `SECURITY_FAILURE`. The harness
prints a per-step table, writes `dogfood/reports/harness-report.json`, exits
non-zero on anything unexpected, resets all state per run, and enforces a
per-scenario timeout so a hang cannot block the loop.

Current results:

| Run | Result |
|---|---|
| Offline (11 scenarios) | **PASS** — 16 expected security blocks, 18 expected successes, 2 documented boundaries |
| With live GitHub (12 scenarios) | **PASS** — +1 scenario: CAS satisfied (924 ms), CAS-window race refused by GitHub, no token in audit records |

**Watch mode was considered and deliberately not added** (§16): the harness is
batch-oriented and finishes in seconds; `npm run test:watch` already covers
iterative work. Complexity without value.

## 6. Realistic Scenarios (§15)

Scenarios use realistic development resources and actions — deploy configs,
CI workflows, lockfiles, deployment flips, migration-style escalations,
purge-table approvals — against sandbox providers (in-memory, local HTTP
sandbox server, dedicated GitHub sandbox repo). No destructive operation ever
touches production infrastructure; the GitHub scenario seeds and cleans its
own sandbox files. During development the harness itself caught three
scenario-authoring errors (a metadata-key mixup, an incomplete outage
simulation, and a stale-claim-vs-CAS-window confusion); each was investigated
against the decision-engine semantics and fixed — none was a firewall defect,
and none was hidden (§29).

## 7. Provider Behavior

- **Capability semantics are now explicit** (§18): `docs/providers.md` defines
  the four levels — FULL conditional guarantee / BEST-EFFORT / UNSUPPORTED /
  REQUIRES OPERATOR VERIFICATION — with the matrix per provider and resource.
  Ambiguous wording ("secure", "protected", "atomic" without scope) is banned
  by convention.
- **GitHub `file`**: blob-sha CAS verified live again this milestone
  (harness scenario 12: satisfied + CAS-window refusal).
- **HTTP**: the trust boundary is documented with an operator checklist (§19).

## 8. Retry Semantics (§8)

The closed, authoritative table (source: `src/domain/recovery.ts`, exported as
`RETRY_SEMANTICS`, pinned by tests):

| Failure kind | Retry safety | Side effect possible? |
|---|---|---|
| `condition_failed` | SAFE_ONLY_AFTER_FRESH_EVALUATION | No (provider refused) |
| `provider_failure` (validation) | SAFE_ONLY_AFTER_FRESH_EVALUATION | No |
| `timeout` (validation) | SAFE_ONLY_AFTER_FRESH_EVALUATION | No (execution-phase timeout → unknown outcome) |
| `rate_limit` | SAFE_ONLY_AFTER_FRESH_EVALUATION | No |
| `unknown_execution_outcome` | **UNSAFE** | **Yes** |
| `authorization_expired` | SAFE (new action) | No |
| `replay` | **UNSAFE** | Possibly |
| `policy_blocked` | SAFE_ONLY_AFTER_FRESH_EVALUATION (ESCALATE → REQUIRES_HUMAN_REVIEW) | No |

`policy_blocked` was added to the mandated taxonomy as a distinct kind because
a deterministic DENY is neither a provider fault nor a condition failure —
conflating them would make the contract lie. The seven mandated kinds remain
fully distinguished. Condition failures can never be blindly retried (same
authorization), and unknown outcomes can never be retried without external
inspection — both enforced by replay protection, not just documentation.

## 9. Unknown Outcomes (§11)

`conditional_execution: 'unknown'` is now a first-class outcome (previously
the faulted path recorded nothing machine-readable). The caller receives:
`success: false` + `'unknown'` + recovery contract (`UNSAFE`,
`side_effect_possible: true`, ordered next steps: inspect → reconcile → new
authorization). The audit event carries the same fields, and the local
`executions_unknown_outcome` metric exposes the rate. Never success, never
"not executed", never blind replay — verified by S07/S08 semantics, the
operationalization test suite, and harness scenario 06.

## 10. Audit / Observability (§22, §25, §26)

- Audit payloads now carry `failure_kind` and `retry_safety` on every failure
  record; condition-failure records carry `failed_ref`, expected vs observed
  versions, provider refusal, provider capability (DF-4 lineage).
- `docs/OPERATING_MODEL.md` §10 maps each operator question to the audit field
  that answers it; §11 documents the metrics model (attempted / allowed /
  denied / condition failures / unknown outcomes / replays rejected / provider
  failures / fresh re-evaluations). False positives and security incidents
  remain human classifications recorded by the harness and dogfood process —
  the firewall cannot judge its own correctness.
- Event taxonomy: **existing names only** (§26) — `action.*`,
  `execution.condition_failed`, `policy.*`, `state.*`, `provider.*`. No
  duplicate taxonomy was introduced.
- Everything is local; **nothing is transmitted** (§25).

## 11. Developer Experience

- `refKey` is now a **runtime export** (was type-only — dogfood friction
  finding), documented and tested; the fixtures library consumes it from the
  SDK.
- The canonical integration example (**`examples/canonical-agent/agent.ts`**,
  `npm run example:canonical`) demonstrates the exact intended architecture
  end to end: observe → declare → dry-run → authorize → provider CAS → audit →
  stale refusal with recovery guidance → CAS-window provider refusal → fresh
  re-authorization → success. This is the reference for future internal
  consumers (§17).
- The harness gives a one-command answer to "does the firewall still hold?".

## 12. Metrics

Local counters (unchanged surface, one new counter): `actions_checked`,
`actions_allowed`, `actions_denied`, `actions_revalidated`,
`conditional_executions_satisfied`, `conditional_executions_failed`,
**`executions_unknown_outcome` (new)**, `replays_detected`,
`provider_failures`, `policy_failures`, escalations, `stale_state_events`,
latency percentiles. No external telemetry; no new infrastructure.

## 13. Findings and Fixes

All changes in this milestone were evidence-driven and regression-pinned
(`test/operationalization/recovery-contract.test.ts`, 8 tests):

| # | Finding (source) | Fix | Type |
|---|---|---|---|
| OP-1 | Refusals did not consistently answer "is a retry safe?" (dogfood §9.1) | Recovery contract (`RecoveryGuidance`) on all failure surfaces + audit payloads; authoritative `RETRY_SEMANTICS` table | DX/observability |
| OP-2 | Faulted conditional operations recorded no machine-readable condition outcome (S07/S08 lineage) | Explicit `conditional_execution: 'unknown'` + `UNSAFE` guidance + metric | semantics |
| OP-3 | Provider faults carried status strings but no classification | `classifyProviderFailure` + `kind` on provider errors (10 kinds), rate-limit message marker classified `RATE_LIMITED` | error normalization |
| OP-4 | `refKey` exported as type only (dogfood friction) | Runtime export + test + fixtures updated | API ergonomics |
| OP-5 | No closed policy/recovery documentation | OPERATING_MODEL, POLICY_BASELINE (+validated config), INCIDENT_PLAYBOOK, capability matrix + HTTP checklist | documentation |
| OP-6 | No repeatable dogfood entry point | `npm run dogfood` harness with verdict taxonomy | tooling |

No defects were found in the enforcement core; no solved security work
(authorization, CAS, replay, SQLite claim, audit chain) was modified (§4).
Three harness-authoring errors were caught by the harness itself during
development and fixed with rationale (§6, §29) — the harness works.

## 14. Security Boundaries (§24)

`docs/OPERATING_MODEL.md` §9 states what must be trusted (executor, capability
declarations, external provider semantics, HTTP server, caller-declared
dependencies, provider version signals, audit storage), and
`docs/limitations.md` remains the precise non-guarantee reference (DF-F2
write-only CAS scope; executor trust boundary; tamper-evident-not-proof audit;
store-scoped replay). Nothing in this milestone overstates a guarantee; the
S14 broken-server boundary is demonstrated, not explained away.

## 15. Performance (§27)

`scripts/bench-conditional.ts` (2000 iterations, in-memory provider):

| Path | p50 | p95 | p99 |
|---|---|---|---|
| legacy (re-check fetch) | 0.141 ms | 0.239 ms | 1.131 ms |
| conditional (provider CAS) | **0.124 ms (−12.3%)** | 0.189 ms | 0.272 ms |

The conditional path remains faster than legacy (it removes the redundant
re-check fetch). No unexpected fetches, duplicate validations, excessive
transactions, or unbounded logging were introduced — the operationalization
changes are additive fields on existing records.

## 16. Remaining Limitations

1. **HTTP If-Match operator duty** — an unverified endpoint voids the CAS
   silently; mitigated by the checklist + harness negative test rig.
2. **DF-F2 write-only CAS scope** — read-only dependency drift in the CAS
   window is outside the guarantee; documented + demonstrated by harness
   scenario 09.
3. **Store-scoped replay** — per deployment; two stores do not share replay
   state.
4. **Audit tail-truncation detection** — unchanged (hash-chained, no anchor).
5. **Executor trust boundary** — unchanged; a lying executor is outside the
   model.
6. `dogfood:watch` intentionally not provided (§5 rationale).

## 17. Acceptance Criteria (§30)

| Criterion | Status |
|---|---|
| Current HEAD baseline independently verified | ✅ (299/299 at start; §2) |
| Internal operating model documented | ✅ OPERATING_MODEL.md |
| Recommended policy baseline documented | ✅ POLICY_BASELINE.md + validated YAML |
| Retry semantics are explicit | ✅ RETRY_SEMANTICS table + tests |
| Condition failures are actionable | ✅ recovery contract + failed_ref + audit fields |
| Unknown outcomes explicitly represented | ✅ `'unknown'` + UNSAFE guidance + metric |
| protect() path verified | ✅ DF-5 regression + new unsupported-capability fail-closed test |
| Public integration example works | ✅ `npm run example:canonical` (offline, deterministic) |
| Internal dogfood harness exists | ✅ `npm run dogfood` (+ `:github`) |
| Realistic development scenarios exist | ✅ §6 |
| Provider capability semantics are clear | ✅ four-level matrix |
| HTTP trust boundary documented | ✅ §19 checklist + boundary demo |
| Dependency-completeness boundary documented | ✅ limitations.md + harness scenario 09 |
| Incident playbook exists | ✅ INCIDENT_PLAYBOOK.md |
| Audit events are operationally useful | ✅ failure_kind/retry_safety in payloads; question→field map |
| No secrets appear in logs/reports | ✅ hygiene gate + harness no-leak check (live run) |
| No unsafe retry path introduced | ✅ replay protection untouched; guidance says UNSAFE where effect is possible; tests pin it |
| No documented guarantee overstated | ✅ boundaries restated verbatim; no new guarantees claimed |
| All regression/security tests pass | ✅ 307/307 (26 files) |
| Build passes | ✅ |
| Typecheck passes | ✅ |
| Lint passes | ✅ |
| Dogfood scenarios pass | ✅ 12/12 incl. live GitHub |
| Benchmark within reasonable expectations | ✅ conditional −12.3% p50 vs legacy |

**24/24 acceptance criteria met.**

## 18. Final Recommendation (§31) and Final Question (§33)

**Gate: GREEN** — SSF can be continuously used internally with no known
material operational blocker. The remaining limitations (§16) are documented
boundaries with operator mitigations, not operational blockers; every one of
them was already present and documented at milestone start, and none grew.

**Can we place SSF around our own consequential AI-agent development
operations as a continuously running internal control — YES, WITH CONDITIONS:**

**YES**, because this milestone closed the operational gap the dogfood report
identified: agents and humans can now determine what failed and whether a
retry is safe from the failure itself (recovery contract), unknown outcomes
are explicit and alarmed locally, provider faults are classified, the policy
baseline and operating model remove interpretation work, and a one-command
harness continuously proves the enforcement still holds against realistic
actions — including live, provider-enforced CAS refusals.

**WITH CONDITIONS**, because operating a firewall correctly is an ongoing duty,
not a one-time configuration:

1. Run `npm run dogfood` (and `dogfood:github` when the sandbox token is
   available) after every SSF, policy, or provider change; treat
   `SECURITY_FAILURE` as a stop-the-line event (INCIDENT_PLAYBOOK §4).
2. Verify every HTTP endpoint against the §19 checklist before pointing an
   agent at it; re-verify after server changes.
3. Keep one SSF store per trust domain and explicit storage paths.
4. Integrate the recovery contract into agent tooling — read
   `recovery.retry_safety` instead of parsing messages; never implement blind
   retries around the firewall.
5. Pick up the residual DX items (retry-signal wording inside executor-owned
   refusal strings, a legacy-executor helper) before non-author integrators
   arrive.

The progression is complete: security primitive → assured primitive →
dogfooded primitive → **operational internal infrastructure**.
