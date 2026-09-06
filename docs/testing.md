# Testing strategy

Testing is a first-class requirement (spec §44). The suite lives in `test/` and runs with `npm test` (vitest).

## Layers

### Unit (`test/unit/`)

Pure engines with injected clocks:

- **foundations** — clock monotonicity, staleness bands and boundaries, duration parsing (including malformed rejection), glob matching, canonical JSON/hashing, sortable ids, precondition path resolution.
- **freshness** — every strategy (ttl/version/hash/preconditions/hybrid): fresh, aging, stale boundaries; missing basis → UNKNOWN; future timestamps → UNKNOWN; conditional-304 freshness; drift → INVALID; provider failure → UNKNOWN; skew tolerance widening (and its absence by default).
- **decision engine** — composition (invalid > unknown > stale > aging > fresh), policy outcome overrides, AGING risk behavior, precondition failures forcing the invalid path, hard safety floor (CRITICAL+UNKNOWN never ALLOW; INVALID never silently authorizes; residual UNKNOWN after revalidation → deny), STRICT/OBSERVE transformations.
- **policy resolution** — specificity precedence, explicit-name shortcut, synthetic default, risk derivation order, tie handling.
- **config validation** — unknown fields, dangerous defaults, contradictions, impossible conditions, duplicate/ambiguous matchers, YAML loading, external policy files, schema versions.
- **audit/redaction/metrics** — chain append + verification, tamper detection, redaction of credential-shaped keys, counter/latency math — on **both** store backends (memory + SQLite) via `describe.each`.

### Integration (`test/integration/`)

End-to-end through the public SDK and CLI:

- The spec §73 success loop per scenario: fresh→allow, TTL expiry→revalidate→allow, version drift→deny, mixed dependency states, provider outage→fail closed, CRITICAL+unknown→deny, replay→blocked.
- Escalation lifecycle: ESCALATE → pending freeze → human approval → approved execution with freshness re-verified.
- Modes: observe preserves `would_have_decided` and does not block; strict denies uncertainty.
- SQLite persistence round-trip: reopen the database and verify actions, decisions, executions, snapshots, and audit chain integrity survive.
- Protected tool wrapper: blocked actions never reach the raw tool; duplicate tool names refused.
- CLI: deterministic exit codes (0/1/2), JSON output, observe-mode semantics, policy test pass/fail, audit verification, doctor, and a live end-to-end check against a local HTTP provider with ETag versioning.

### Contract (`test/contract/`)

Every provider implementation must satisfy the same behavioral contract: support detection, complete snapshots with provenance, mutation detection via version change, conditional verification semantics, and typed failures. Run against: the in-memory provider, the HTTP provider (against a live local server exercising 200/304/500/non-JSON paths), and the GitHub provider (against a simulated GitHub API covering PRs, reviews aggregation, CI status, rate limits, and If-None-Match).

### Kill tests (`test/kill/`)

The adversarial suite (spec §47, §67). The question is never "does the happy path work" but "can we force the firewall to allow an action it should reject?":

- K1 cached/stale state reuse — must always re-fetch
- K2 forged freshness (recent timestamp + old version)
- K3 fabricated future timestamps
- K4 missing versions on critical version-strategy policies
- K5 provider outage mid-flow — executor never runs
- K6/K7 replay and pending-escalation freezing
- K8 clock manipulation — no implicit widening
- K9/K10 dependency omission (implicit + `require_dependencies`)
- K11 partial state — preconditions on missing fields fail closed
- K12 direct-invocation/bypass — duplicate tool identity refused, raw tool unreachable
- K13/K14 configuration attacks (`on_invalid: allow`; critical + `on_unknown: allow`)
- K15 audit chain integrity
- K16 observe-mode bypass check — would-be decisions preserved
- K17 forged precondition satisfaction — re-checked against current state

### Race conditions (`test/race/`)

Time-of-check/time-of-use with controlled interleaving:

- mutation between validation and execution caught by the TOCTOU re-fetch (R2)
- mutation after the final fetch documented as `atomicity: not_guaranteed` — never hidden (R3)
- concurrent execution of one action id: exactly one wins (R4)
- hanging executor cut off by the deadline, authorization consumed, side-effect uncertainty recorded (R5)
- check() results never reused across executions (R6)
- independent firewalls keep independent authorization ledgers (R7)

### Conditional execution (`test/conditional/`)

The atomic-effect-assurance milestone suite (see [atomic-effect-assurance.md](atomic-effect-assurance.md)):

- **critical race (CR1)** — the central proof: authorize against state X, a concurrent actor moves X→Y after authorization, the conditional operation carrying X is **rejected by the provider itself**; no side effect, authorization invalidated, replay refused, fresh decision recorded
- **same-state success (CR2)** — no mutation ⇒ condition satisfied ⇒ executed with `atomicity: guaranteed`
- **two-authorization race (CR3)** — two authorized actions CAS the same resource: exactly one executes
- **drift during validation→authorization (CR4)** — also caught by the CAS
- **legacy limitation, demonstrated not hidden (CR5)** — without conditional capability the compare→execute window stays open (`atomicity: not_guaranteed`)
- **binding (CB1/CB2)** — an authorization for resource A cannot drive a CAS on resource B; the provider CAS is ref-scoped
- **replay × conditional (RP1–RP3)** — condition failure, success, and concurrent claim all consume the single-use authorization
- **failure injection (FI1–FI4)** — provider crash ≠ condition failure ≠ unavailable; deadline semantics; fail-closed on declared-but-unenforceable capability
- **audit & observability (AU1–AU3)** — `execution.condition_failed` reconstructs the lifecycle; no ambiguous success; metrics split satisfied/failed
- **SQLite round-trip (SQ1)** — expected-state binding and condition outcomes survive close/reopen (migration v2)
- **policy matrix (M1–M12, P1–P6)** — state × capability × risk × outcome matrix and the `require_conditional_execution` gate (including OBSERVE mode and approved escalations)
- **provider contracts** — simulated GitHub Contents API (stale blob sha ⇒ 409 ⇒ no write; deleted file ⇒ 404; 500 ⇒ error not condition failure) and a live HTTP server (`If-Match` honored: stale ⇒ 412 ⇒ no write; 500 ⇒ provider error)
- **kill mutations (KM1–KM4)** — removing the CAS check, lying about the condition outcome, or discarding the authorized version for a fresh read each let the canonical attack succeed (proving the suite detects every removal); declared-but-unenforceable capability fails closed
- **property tests (P-A..P-D)** — randomized version histories: state moved ⇒ never executed; state unchanged ⇒ executed; CAS ref-scoping for arbitrary version pairs

### Property tests (`test/property/`)

`fast-check` invariants over generated inputs (spec §46):

- CRITICAL never ALLOWED with any INVALID dependency (500 cases)
- UNKNOWN never becomes ALLOW at any risk under enforcement
- determinism: identical inputs produce identical decisions (invariant 4)
- monotonicity: adding worse verdicts never upgrades toward ALLOW
- staleness classification monotonic in age; aggregation order-insensitive
- any version drift ⇒ INVALID
- preconditions type-strict; structural equality order-insensitive
- duration/glob primitives

### Dogfood (dogfood/ + `test/dogfood/regressions.test.ts`)

Real-usage scenarios using only the public SDK surface:

- **S01–S16 scenario scripts** (`dogfood/scenarios/`) — the deep dogfood campaign
  (stale edits, concurrency across processes, human intervention, replay,
  tampering, provider outage, unknown outcomes, live GitHub, live HTTP with
  correct/broken servers, crash/restart at the critical windows). Records and
  telemetry land in `dogfood/reports/`.
- **Continuous harness** (`npm run dogfood`, `dogfood/harness/`) — the fast,
  repeatable subset: 11 deterministic scenarios + opt-in live GitHub scenarios
  (`--with-github`, incl. the adoption agent workflow, scenario 13). Every step
  is classified as `EXPECTED_SECURITY_BLOCK / EXPECTED_SUCCESS /
  DOCUMENTED_BOUNDARY / UNEXPECTED_FAILURE / SECURITY_FAILURE`; non-zero exit
  on anything unexpected. Report: `dogfood/reports/harness-report.json`.
- **Regression pins** (`test/dogfood/regressions.test.ts`) — DF-1..DF-5: every
  defect found by dogfooding is pinned by a test.
- **CI enforcement** (`.github/workflows/`) — `ci.yml` runs build · typecheck ·
  lint · test · hygiene · offline dogfood on every push/PR (no credentials,
  deterministic; a security failure can never be downgraded to a warning).
  `dogfood-live.yml` isolates live-provider dogfood: manual `workflow_dispatch`
  only, behind the protected `dogfood-live` environment, fail-closed credential
  guard, sandbox repository only. Friction from dogfooding is logged in
  [INTERNAL_DOGFOOD_LOG.md](INTERNAL_DOGFOOD_LOG.md).

### Operationalization (`test/operationalization/`)

- **Recovery contract** — the closed retry-semantics table (`RETRY_SEMANTICS`),
  condition-failure actionability on results and audit events, replay/expiry/
  provider-error guidance, `BlockedActionError` recovery, explicit
  `conditional_execution: 'unknown'` outcomes, provider failure
  classification, `refKey` runtime export, and the `protect()`
  conditional-unavailable fail-closed path.
- **Trust-domain visibility** — `firewall.storeDescription` surfaces the
  resolved store identity (per-process memory vs resolved sqlite file path) so
  `ssf doctor` output alone reveals two deployments accidentally sharing a
  store (continuous-dogfood milestone §10).

## Quality gates (spec §75)

```bash
npm test             # vitest
npm run build        # tsc -> dist/
npm run lint         # eslint (typescript-eslint)
npm run typecheck    # tsc --noEmit, strict
npm run check:hygiene  # no unfinished-work markers, no secret-shaped strings
npm run dogfood      # continuous dogfood harness (offline scenarios)
```

All must pass before the build is considered complete. The hygiene gate enforces the spec §75 requirement that the repository contain no unfinished-work markers and no hardcoded secrets (CI token shapes are detected by pattern).
