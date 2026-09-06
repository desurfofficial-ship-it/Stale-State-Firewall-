# Operational Closure + Sustained Internal Dogfood Report

Independent verification, credential rotation, FL-9 hardening, and cadence
observation for the Stale-State Firewall (SSF). Written 2026-09-06 by an
independent assurance pass that reproduced every claim from the live
repository and real execution before deciding anything.

Predecessor reports (read, then independently re-verified rather than
trusted): `docs/SUSTAINED_INTERNAL_DOGFOOD_REPORT.md`,
`docs/CONTINUOUS_INTERNAL_DOGFOOD_REPORT.md`, `docs/ASSURANCE_REPORT.md`,
`docs/INTERNAL_DOGFOOD_LOG.md`, and the agent worklog.

---

## 1. Executive Summary

The operational-closure milestone set out to move SSF from
**GREEN — YES, WITH CONDITIONS** to **GREEN — OPERATIONALLY CLOSED / SUSTAINED
INTERNAL DOGFOOD**. Every claimed number from the previous milestone was
reproduced independently and every one held. Three findings were closed with
the smallest possible changes and the enforcement core untouched:

- **FL-9 (memory provider version trap)** — investigated to a verdict
  (deliberate fixture semantics + misleading doc comment, not an enforcement
  defect), fixed at the comment level, pinned by two regression tests, and
  reflected in the provider inventory.
- **FL-11 (new, found by this milestone)** — `npm run dogfood:github` without
  credentials exited 0 with `PASS` after loudly skipping the live scenarios.
  The fail-closed contract now holds at the harness layer too (exit 1), not
  only at the CI workflow guard. Both polarities verified.
- **HTTP assurance checklist** — one uncovered item (deadline-miss
  classification) closed with test HC6.

The credential boundary was re-verified end to end (tree, full git history,
six Actions logs, both workflow polarities). Credential rotation (FL-10)
remains an **owner action with a now semi-automated runbook**: the npm
self-revocation refusal was re-evidenced same-day, the GitHub self-revocation
API was confirmed nonexistent, and — new this session — the current PAT can
manage the repo secret via API, so the owner's part is UI-only.

The sustained cadence workflow is implemented, structurally verified, and its
full chain (offline leg → live leg via protected reusable call → credential
guard → live harness) executed successfully end to end on Actions. But the
first *scheduled* runs have not yet fired (the workflow was created today), so
the honest cadence verdict is **observation period not yet sufficient**.

Two conditions therefore remain, both routine operational maintenance:

1. Credential rotation by the owner (runbook in §6; deadline note: the PAT
   expires 2026-10-01, after which the weekly live cadence leg fails closed —
   visibly, by design — until the secret is updated).
2. Cadence observation: the daily/weekly scheduled runs must accumulate real
   history (first fire: 2026-09-07).

**Final decision: GREEN — YES, WITH CONDITIONS** (§26). No P0/P1 findings.
317/317 tests, all six gates green, live dogfood 14/14, FP=0, FN=0.

---

## 2. Baseline

First action of this milestone, before any change: reproduce the claimed
baseline against the live repository. Every number matched.

| Claim (previous milestone) | Independently reproduced | Match |
|---|---|---|
| HEAD `dc81e28` | `git rev-parse HEAD` → `dc81e28f8429…` | ✓ |
| origin/main `dc81e28` | `git rev-parse origin/main` and `git ls-remote origin main` → same SHA; `main...origin/main` in sync | ✓ |
| working tree clean | `git status --short` → empty | ✓ |
| tests 314/314 | `npm test` → 314 passed (28 files); JSON reporter: 0 failed, 0 skipped, 0 todo | ✓ |
| build / typecheck / lint / hygiene PASS | all four commands exit 0 | ✓ |
| offline dogfood 12/12 | `npm run dogfood` → 12/12 PASS (18 blocks / 21 successes / 2 boundaries), 8.3s | ✓ |

No discrepancy existed to investigate. The baseline was treated as untrusted
until this table was green.

## 3. Repository State

- Branch `main`, HEAD = origin/main = GitHub `main` = `dc81e28` at session
  start; working tree clean; 23 commits of history scanned.
- Documentation read and mapped (requirement → implementation → test →
  operational workflow → evidence): the three CI workflows, the dogfood
  harness (14 scenarios + fixtures + verdict classifier), the ops drivers
  (`dependency-update.mjs`, `incident-exercise.mjs`), the friction log, the
  provider inventory, threat model, limitations, CLI docs, and the three
  predecessor milestone reports.
- Commits added by this milestone (small, categorized, security work not
  mixed with cleanup):

| Commit | Category | Content |
|---|---|---|
| `012ed3f` | fix | clarify memory provider version semantics (FL-9) — comment-only |
| `d9865fe` | test | pin memory put/mutate interference semantics (FL-9) |
| `220c9dc` | security | independent secret scanner (tree + full history, values never printed) |
| `f0c6a1f` | fix | live dogfood harness fails closed without credentials (FL-11) |
| `1b77f58` | docs | friction log FL-11/FL-10; provider inventory FL-9 resolution; run history |
| `de3a8b4` | test | HTTP deadline-miss classification (HC6, §11) |
| *(final)* | fix | union narrowing in FL-9 regression test (typecheck gate) |

## 4. Security Boundary

- **Ordinary CI is credential-free**: `ci.yml` contains no `env:`/`secrets:`
  anywhere; it runs build, typecheck, lint, tests, hygiene, and the offline
  dogfood on push/PR/dispatch. Nothing in the ordinary path can reach a live
  credential.
- **Live workflow is isolated and fail-closed**: `dogfood-live.yml` triggers
  only on `workflow_dispatch`/`workflow_call` (never push/PR), gates on the
  protected `dogfood-live` environment, least-privilege `permissions:
  contents: read`, and its credential guard exits 1 when `SSF_GITHUB_TOKEN`
  is absent ("This is NOT a security failure of SSF — configure the sandbox
  token and re-run"). Verified in real runs: the guard step executed and
  passed in run `34025069489`, and its fail-closed polarity is the same
  contract now enforced one layer deeper by the harness itself (FL-11 fix).
- **Scheduled cadence does not widen the boundary**: `scheduled-dogfood.yml`'s
  offline leg references no secrets at all; the live leg reuses
  `dogfood-live.yml` via `workflow_call` + `secrets: inherit`, so the same
  guard applies.
- **Secret scans (values never printed)**: a new independent scanner
  (`scripts/secret-scan.mjs`) checked 178 tracked files and all 23 commits on
  every ref with 9 credential-shaped patterns (GitHub PATs classic +
  fine-grained, npm tokens, AWS keys, private-key blocks, bearer literals,
  credentialed URLs, generic secret assignments, SSF token literals).
  Findings: **3 hits, all the same false positive** — the deliberately synthetic
  `api_key: 'sk-super-secret-value'` in `test/audit/storage-config.test.ts`
  ST2, whose entire purpose is to prove SSF redacts credential-shaped
  arguments before persistence. Plus one real but **local-only** item: the
  sandbox PAT embedded in `.git/config`'s remote URL (untracked, never
  pushed, absent from history) — remediation is part of the rotation runbook
  (§6). The repo's own hygiene gate (`check:hygiene`) also passed.
- **Actions logs**: six recent runs (both success and failure polarity,
  including the live workflow) fetched and scanned — **0 credential
  patterns** across ~80KB of logs.

## 5. Credential Status

Established with same-day metadata only (no secret values printed anywhere):

| Credential | State | Evidence |
|---|---|---|
| GitHub fine-grained PAT (repo secret `SSF_GITHUB_TOKEN` source) | **ACTIVE** | `GET /user` → 200; powers the live dogfood that passed 14/14 this session; repo secret last updated 2026-09-06T07:58:46Z; **expires 2026-10-01** |
| Campaign npm token | **ACTIVE, expires 2026-09-11** | registry token list (metadata): created 2026-09-04; self-revocation `DELETE` → **403** (automation tokens cannot manage tokens — re-evidenced this session) |
| Sibling npm tokens on the account | 2 more: one expires 2026-09-08, one **already past expiry (2026-09-05)** | same listing; least-privilege review remains an owner step |
| Previously recorded campaign token id `a7b05050…` | **no longer present** in the registry list | reason unknowable from metadata (possibly revoked by the owner); recorded honestly rather than claimed as completed rotation |
| Repo secret manageability | **the current PAT CAN manage repo secrets** | `GET /actions/secrets` → 200 — the rotation runbook is therefore semi-automated (owner supplies the new value; the secret update itself needs no UI) |

No repo workflow consumes an npm credential; the only load-bearing credential
is the GitHub PAT inside the protected live workflow.

## 6. Credential Rotation Result (FL-10)

**Status: owner action required; every automatable step has been taken, and
the automated-only blockers are precisely characterized — not claimed as done.**

What cannot be automated (verified with current evidence, not assumed):

- npm: an automation token cannot manage tokens (`DELETE /-/npm/v1/tokens/…`
  → 403; npm's authorization model). Owner must revoke in npmjs.com →
  Access Tokens.
- GitHub: fine-grained PATs have **no self-revocation API** (`DELETE
  /user/token` → 404 — the endpoint does not exist). Owner must revoke in
  GitHub Settings → Fine-grained tokens.

The semi-automated owner runbook (exact sequence; ~10 minutes of owner UI
time):

1. **Owner (UI)**: create the replacement fine-grained PAT — repository
   access: `ssf-dogfood-sandbox` only; permissions: Contents read/write;
   expiry ≤ 90 days.
2. **Owner → operator hand-off** of the new value through the secret channel
   (never in repo files, logs, or this report).
3. **Operator (API)**: `PUT /repos/…/actions/secrets/SSF_GITHUB_TOKEN` with
   the new value encrypted via the repo public key (API verified reachable —
   §5), or owner pastes it in the UI if preferred.
4. **Operator**: run `npm run dogfood:github` → must be 14/14 with the new
   credential; CI push must go green.
5. **Owner (UI)**: revoke the OLD fine-grained PAT; revoke the campaign npm
   token and the expired/sibling npm tokens (npmjs.com → Access Tokens).
6. **Operator**: re-run `scripts/secret-scan.mjs` (tree + history) and the
   live dogfood; update the local `.git/config` remote URL (or switch to a
   credential helper) to drop the embedded old PAT; update FL-10 to closed.
7. **Deadline note**: if the PAT is not rotated before **2026-10-01**, the
   weekly live cadence leg fails closed (visible red, by design) after that
   date until step 3 is done. Nothing else breaks; ordinary CI has no
   credentials to expire.

## 7. CI Verification

- 11 total Actions runs exist; every push to `main` in history has a CI run,
  and `dc81e28`'s CI run (34025056579) is green.
- Historical failure polarity was previously proven (deliberate defect → CI
  red → fix → green); no CI-configuration change was made this milestone, so
  per change-control that proof remains valid and was NOT re-staged.
- The workflow YAML semantics were re-inspected line by line (§4/§8) rather
  than assumed from the previous report.

## 8. Cadence Verification

Implementation (`scheduled-dogfood.yml`), verified structurally:

- schedule exists: daily `17 3 * * *` (offline) + weekly `7 4 * * 1` Monday
  (live); manual dispatch with `run_live` input defaulting false;
- offline leg requires no credentials (no `secrets:` in that job);
- live leg is protected: it is a `workflow_call` into `dogfood-live.yml`, so
  the environment gate and the fail-closed credential guard apply unchanged;
- `needs: offline-dogfood` orders the legs; a failed leg fails the run (no
  silent success path).

Real execution: the full chain ran successfully end to end on Actions —
run `34025069489` (dispatch, `run_live=true`, on `dc81e28`): offline leg
PASS, live leg PASS with the credential-guard step executed, 14/14.

Scheduled history: **0 scheduled runs so far** (the workflow was created
2026-09-06; the first daily cron fires 2026-09-07 03:17 UTC and the first
weekly live cron 2026-09-07 04:07 UTC). Per the milestone's own rule, one
successful dispatched run does not constitute a sustained cadence:
**observation period not yet sufficient**. This is recorded in the run
history (docs/INTERNAL_DOGFOOD_LOG.md) and is condition 2 in §26.

## 9. Offline Dogfood

`npm run dogfood` at the final tree: **12/12 PASS** (18
EXPECTED_SECURITY_BLOCK / 21 EXPECTED_SUCCESS / 2 DOCUMENTED_BOUNDARY),
deterministic, credential-free, ~seconds. Scenarios cover stale config edit,
concurrent deploy flip, replay/tamper, multi-dependency staleness, provider
fail-closed, unknown outcome, HTTP If-Match end to end, the If-Match-ignoring
server boundary, the DF-F2 dependency-completeness boundary, policy change,
escalation argument binding, and crash/restart persistence.

## 10. Live Dogfood

`npm run dogfood:github` with the current credential (this session, post
FL-11 fix): **14/14 PASS** (23 / 31 / 3), exit 0, ~40s.

- GitHub blob-sha CAS: satisfied mutation applied; stale claim refused by
  GitHub inside the PUT (`conditional=failed`, `retry_safety=
  SAFE_ONLY_AFTER_FRESH_EVALUATION`, no stale landing);
- concurrent agents: exactly one winner, GitHub decides;
- multi-dependency behavior and autonomous recovery: hotfix preserved by the
  recomputed change, new authorization, zero developer help;
- harness verification-layer readbacks all `reads=1` (FL-7 fix holding);
- audit reconstruction and credential redaction checks pass
  (`credential_leak=false`);
- **fail-closed polarity re-verified after the FL-11 fix**: without
  `SSF_GITHUB_TOKEN` the harness exits 1 with the environment-failure banner;
  with it, 14/14.
- The provider stayed authoritative for conditional mutation throughout; no
  application-side CAS simulation was substituted and no test was weakened.

## 11. Provider Inventory

Re-audited `docs/providers.md` against implementation and evidence:

- In-memory: **VERIFIED** (automated, every CI run) — row now cites the FL-9
  regression pins and states the deliberate put/mutate version semantics.
- GitHub `file`: **VERIFIED** (live API, dedicated sandbox repo only) —
  evidence includes the on-Actions runs and this session's 14/14.
- GitHub other resources: **UNSUPPORTED** (no expected-revision parameter) —
  policies requiring conditional execution deny, fail closed.
- HTTP sandbox (correct ETag route): **VERIFIED for that server only**
  (checklist items 1–3, 5, 6).
- HTTP sandbox (`/broken` route): **VERIFIED AS BOUNDARY DEMO** — the
  If-Match-ignoring server is the negative rig, not a safety claim.
- Any real production HTTP endpoint: **NOT VERIFIED (per-endpoint operator
  duty)** — unchanged; the system does not imply HTTP conditional execution
  is universally safe. `If-Match` sent ≠ enforced remains the documented
  discipline.

## 12. HTTP Verification

Coverage confirmed against the assurance checklist, with evidence:

| Checklist item | Evidence |
|---|---|
| correct If-Match applies | HC2; scenario 07 Case A |
| stale If-Match refused, no mutation | HC3; scenario 07 Case B |
| server honoring the condition | HC2/HC3 (condition evaluated by the server inside the PUT) |
| server ignoring the condition | scenario 08 (`/broken` route) — documented trust boundary, end to end |
| redirects | scenario 07 Case C — 307 preserves `If-Match`; target still enforces (stale → 412/no mutation; matching → applied) |
| malformed responses | contract suite — non-JSON → `ProviderResponseError` |
| network errors | contract suite — server failure → `ProviderUnavailableError` |
| timeout/deadline | **HC6 (new)** — a server that never answers → `ProviderUnavailableError` after the deadline, never a condition failure, never silent success |
| ambiguous outcomes | HC4 — 500 is a provider error, not a condition failure (crash ≠ condition failure) |
| no blind mutation retry | IR-G2 (one PUT, refused, not retried); recovery contract tests |
| no false success | HC3/HC4/HC6 + scenario 07 |
| capability refusal when unavailable | HC1/HC5 — no mutation config ⇒ no conditional execution |

The documented trust boundary is preserved in every artifact: HTTP safety
requires operator verification that the endpoint honors If-Match.

## 13. Crash/Restart Verification

Scenario 14 re-executed in this session's live harness run (PASS, 258ms) and
in the offline run: a child process is SIGKILLed at three real boundaries and
the parent reopens the same SQLite database across the real process boundary
(no in-memory substitute):

- **A. crash after claim**: no side effect (`provider_mutated=false`);
  replay refused across restart (`ReplayDetectedError`); audit records no
  execution;
- **B. crash after the provider applied the mutation**: no false success, no
  false failure (`provider_mutated=true` and the local record honestly
  silent); replay refused; recovery is reconciliation;
- **C. normal completion**: execution recorded, authorization consumed, and
  the same action id replayed after restart stays dead (no double execution).

## 14. Audit Ledger Verification

- `ssf audit --verify` on the persisted incident ledger: **chain OK (13
  records verified)** — hashes/chaining behave as documented and tampering is
  detected by recomputation.
- Redaction before persistence: ST2/ST3 (credential-shaped action arguments
  and execution outputs stored as `[REDACTED]`), re-proven by the suite in
  this session's 317-test run; the incident exercise's stored request shows
  only clean fields, and live-scenario audit checks report
  `credential_leak=false`.
- Lifecycle reconstructability: proposed → validated →
  (blocked / condition_failed / executed) → replay_detected events, all
  persisted in order with the decision reasons.
- Wording discipline held: "tamper-**evident**, not tamper-**proof**" with
  the tail-truncation limitation documented in `docs/limitations.md`; no
  terminology was upgraded anywhere.

## 15. FL-9 Investigation (memory provider version trap)

**Verdict: (1) deliberate-but-undocumented fixture semantics combined with
(2) a misleading implementation comment — not a genuine enforcement-core
correctness problem.** The provider's own CAS (`conditionalExecute`) is an
atomic check-and-mutate in one synchronous operation; real providers hash
content (GitHub blob-sha); the firewall enforced exactly the CAS contract the
provider reported. The trap was real, though: `put()` on an EXISTING resource
preserves the version while replacing metadata (`version ?? (existing ?
existing.version : counter)`), while the doc comment claimed "when `version`
is omitted a monotonic v-counter is used" — true only for NEW resources. An
integrator simulating interference with `put()` changes content
CAS-invisibly.

Trace performed: `put()` / `mutate()` / version generation / CAS comparison /
every call site (all 40+ are single-seed on fresh providers; nothing depends
on version-preserving re-put) / tests / documentation.

Smallest change applied (no semantic change):

- `012ed3f` — the `put()` JSDoc now states all three cases explicitly
  (new-resource counter / existing-resource version PRESERVED as a
  re-seeding convenience that must never simulate an external actor /
  explicit version always wins) and directs interference simulation to
  `mutate()`.
- `d9865fe` — two regression tests pin the invariant: **the interference
  primitive `mutate()` always advances the version, so a CAS held at the
  pre-interference version refuses with `condition_failed`**; and **`put()`
  version-preservation on existing resources is explicit, documented
  semantics** (pinned so it can neither silently regress nor silently
  change).
- `1b77f58` — provider inventory and provider docs updated; FL-9 closed in
  the friction log.

## 16. Friction Log Status

| ID | Severity | Status this session | Decision rationale |
|---|---|---|---|
| FL-1, FL-2, FL-4 | P3 | open, unchanged | no new evidence of frequency × impact that would justify promotion (§20 discipline: not fixed on principle) |
| FL-3, FL-5, FL-6, FL-7, FL-8 | P2/P3 | closed (previous milestones) | — |
| FL-9 | P3 | **closed** | investigated (§15); comment + regression pins; enforcement core untouched |
| FL-10 | P2 | **open, owner action** | same-day 403/404 re-evidence; runbook semi-automated (§6); correctly not fabricated |
| FL-11 | P3 | **found → closed same session** | observed directly; smallest fix (harness fail-closed); both polarities verified |

FP/FN tracking: **0 false positives, 0 false negatives** again this milestone
— every block in every run was a correct stale/CAS/dependency rejection, and
no action that should have been blocked ever executed.

## 17. Bypass Testing

The adversarial surfaces were exercised through the standing suites rather
than duplicated ad hoc (test economy): kill mutations (17), conditional kill
(4), engine attacks (7), state spoofing (5), execution boundary (5),
property security (4), race conditions, replay, trust-domain isolation
(5), recovery contract (8), config validation (20).

- Direct-executor paths, legacy path, conditional path, policy
  configuration, unknown actions/dependencies, stale and multiple
  dependencies, replay, expired authorization, deadline races, concurrent
  claims, provider CAS races — all covered by the above and green.
- The recurring question — *can a stale authorized state produce an
  unauthorized mutation?* — answers **No where the provider genuinely
  enforces the conditional primitive** (GitHub blob-sha CAS verified live
  again this session), and *the honest boundary* is documented where it does
  not (If-Match-ignoring server = scenario 08's `atomicity=not_guaranteed`
  record; read-only dependency drift inside the CAS window = DF-F2).
- One independent bypass attempt beyond the suites — the §18 kill test —
  is described next; it was detected and failed the suite.

## 18. Test Quality

- **317/317 passing, 0 skipped, 0 todo; no `.skip`/`.only`/`.todo` markers**
  anywhere in `test/` (grepped); no critical paths replaced by stand-ins in the
  assurance suites (the GitHub negative-path tests inject `fetchImpl` only
  where a real refusal is the subject, and the live path runs against the
  real API).
- **Sensitivity/kill test performed independently this session** (beyond the
  built-in kill suite): the memory provider's CAS version comparison was
  temporarily removed (`existing.version !== expected_version` bypassed) —
  the suite **failed in exactly the right places**: the new FL-9 regression
  test ("stale CAS refuses") and the pre-existing KM2 conditional-kill test.
  Restored: 36/36 green again. This proves the tests detect the control, not
  merely its absence of failure.
- New tests added this milestone correspond one-to-one to new findings
  (FL-9 pins) and one assurance-checklist gap (HC6) — no volume inflation.

## 19. Performance

`scripts/bench-conditional.ts` (in-memory provider, 2000 iterations each):

| Metric | legacy (re-check fetch) | conditional (provider CAS) | Δ |
|---|---|---|---|
| p50 | 0.144 ms | 0.129 ms | **−10.5%** |
| p95 | 0.239 ms | 0.216 ms | −9.6% |
| p99 | 0.928 ms | 0.262 ms | −71.8% |

Consistent with the previous milestones' observations (−13.2%, −11.5%):
conditional is faster than legacy (it removes one verification fetch) and
much tighter at the tail. Environment caveat: single-process local runs,
Node 24, shared CI-less workstation; numbers are comparative, not SLAs.
No regression; no optimization work triggered.

## 20. Documentation Honesty

- Scanned README, docs/, and src/ for `guarantee / atomic / always /
  impossible / secure / prevents / tamper-proof / exactly-once`: every strong
  claim is scoped to its mechanism ("Provider-enforced CAS prevents the stale
  mutation when the provider honors the conditional primitive"; "HTTP safety
  requires operator verification that the endpoint honors If-Match").
- `tamper-evident` vs `tamper-proof` correctly distinguished; tail-truncation
  limitation documented; no marketing language found; no absolute claims
  added or left unscoped by this milestone's own doc changes (hygiene gate
  re-run after each docs commit).

## 21. Test Quality Audit Cross-Check

(Consolidated into §18 to keep the report honest to its own structure: one
section, one standard — sensitivity proven, economy respected, numbers
reproduced.)

## 22. Internal Adoption

Adoption was demonstrated against **real, repeatable, sandboxed, reversible,
observable workflows** (documented in `docs/INTERNAL_WORKFLOWS.md` with
owner/resource/dependencies/authorization/conditional/recovery/audit/rollback
fields each):

- **WF-1 — agent-driven configuration change** (live, scenario 13): normal
  execution, stale-state denial at validation, CAS-window refusal by GitHub,
  autonomous recovery preserving a concurrent hotfix — re-run this session,
  14/14.
- **WF-2 — agent-driven dependency update** (live driver
  `npm run dogfood:deps`): **re-run this session, PASS on all 8 steps** —
  dry-run ALLOW; package.json + lockfile CAS pair; dependabot-style lockfile
  drift → **DENY at validation**; recovery re-observes and recomputes with
  the dependabot change preserved; the DF-F2 CAS-window boundary honestly
  recorded as DOCUMENTED_BOUNDARY; audit reconstruction with
  `credential_leak=false`; local counters allowed=5 denied=1.
- **WF-3 — consequential action on unverifiable state** (offline,
  deterministic): fail-closed refusal + argument-bound human approval.

At least one realistic internal workflow safely using SSF: **demonstrated
twice over, live, including a genuine agent-shaped workflow class** (WF-2's
agent dependency bump driven through the public SDK only).

## 23. Remaining Limitations

Honest, evidence-backed, and none of them new:

1. **Credential rotation (FL-10) is an owner action** — automation is
   verifiably impossible for the revoke steps (npm 403; GitHub no API);
   everything else is ready (§6). PAT expiry 2026-10-01 gives the rotation a
   hard deadline after which the weekly live leg fails closed until rotated.
2. **Cadence observation period not yet sufficient** — the scheduled daily /
   weekly runs must accumulate real history (§8); the chain itself is proven
   end to end on Actions.
3. **HTTP conditional safety remains per-endpoint** — no production HTTP
   endpoint is verified; the operator checklist is the gate (§11/§12).
4. **Open P3 friction** (FL-1 misleading inspectState error, FL-2 put/mutate
   seeding split, FL-4 GitHub 409 without current sha) — evidence-first
   posture maintained; none is security-relevant and none justifies
   promotion on current frequency/impact data.
5. **Local-only credential in `.git/config`** (sandbox remote URL) — never
   tracked, never pushed; removed as part of the rotation runbook step 6.
6. **SQLite concurrency is single-writer by locking** — documented; not a
   defect; unchanged and intentionally not re-designed (§20 of the previous
   milestone's contract).

## 24. Evidence Index

| Claim | Evidence |
|---|---|
| Baseline gates | §2 table; commands run 2026-09-06 (vitest JSON: 314/0/0/0) |
| Secret scans | `scripts/secret-scan.mjs` output in session log: 178 files, 23 commits, 3 hits = 1 FP; `.git/config` local-only |
| Actions logs clean | `scripts/actions-inspect.mjs logs-clean`: 6 runs, 0 hits |
| Cadence chain | Actions run `34025069489` (both legs, job/step level) |
| Live dogfood | local run post-`f0c6a1f`: 14/14 (23/31/3), `reads=1`; exit-1 polarity without token |
| FL-9 verdict | §15 trace; commits `012ed3f`/`d9865fe`; tests in `test/contract/providers.test.ts` |
| Kill test | CAS-bypass mutation → 2 failures (FL-9 regression + KM2); restore → 36/36 |
| Incident exercise | `dogfood/reports/state/incident-exercise/` (ssf-state.db, ssf.config.yaml); `ssf audit --verify` → chain OK 13 records; CLI-only reconstruction |
| WF-2 adoption | local run `npm run dogfood:deps`: 8 steps PASS |
| Benchmark | `scripts/bench-conditional.ts`: p50 0.129 vs 0.144 ms (−10.5%) |
| Final gates | §25 |
| Run history | `docs/INTERNAL_DOGFOOD_LOG.md` run-history table rows added this session |

## 25. Final Gates

After the last code change (`fix: narrow the condition_failed union…`), the
complete suite was re-run:

| Gate | Result |
|---|---|
| `npm test` | **317/317** (28 files; 0 skipped, 0 todo) |
| `npm run build` | PASS (exit 0) |
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm run check:hygiene` | PASS ("no forbidden markers, no secret-shaped strings") |
| `npm run dogfood` | **12/12 PASS** (18 blocks / 21 successes / 2 boundaries) |
| `npm run dogfood:github` (live, current credential) | **14/14 PASS** (23 / 31 / 3) |
| CI on push | verified green immediately after push (§22 of the workflow verification) |

## 26. Final Decision

**GREEN — YES, WITH CONDITIONS.**

Why not OPERATIONALLY CLOSED (the target state): the milestone's own matrix
requires "cadence is genuinely operating". The cadence workflow is
implemented, protected, and proven end to end on Actions — but its first
*scheduled* execution has not yet happened, and one dispatched run is not a
sustained cadence. Declaring closure today would manufacture maturity from a
workflow created hours ago. Likewise, "credential situation closed" requires
the owner's two UI actions that no API can perform. Both are exactly the
matrix's definition of GREEN WITH CONDITIONS: "the core is sound but
operational evidence is still accumulating."

Why GREEN at all: every gate is green with independently reproduced numbers
(317/317; six gates; live 14/14; FP=0/FN=0); the security boundary is
verified across tree, history, workflows, and Actions logs; the provider
inventory is accurate and honestly bounded; two real findings (FL-9, FL-11)
were closed this session with the enforcement core untouched; the kill test
proves the tests detect the control; internal adoption is demonstrated with
a real agent workflow, twice, live; and there are **no P0/P1 findings** —
none was hidden, softened, or worked around. The §26 stop conditions were
never triggered.

Conditions (both routine operational maintenance, zero engineering):

1. **Owner completes credential rotation** per the §6 runbook (deadline
   2026-10-01 for the PAT).
2. **Cadence accumulates observation history** — first daily run 2026-09-07
   03:17 UTC, first weekly live run 2026-09-07 04:07 UTC; a subsequent
   assurance pass reviews 7+ daily and 1–2 weekly results, then this report's
   successor may declare **GREEN — OPERATIONALLY CLOSED**.

§30 answer (can our own AI agents rely on SSF as ordinary internal
infrastructure for stale-state protection?): **YES WITH CONDITIONS** — rely
today for GitHub-file-class resources where the provider enforces the
conditional primitive (proven live, repeatedly, including on Actions), treat
HTTP endpoints as unverified until the per-endpoint checklist is run, and
satisfy the two conditions above.

## 27. Next Milestone

Deliberately minimal — derived from evidence, not ambition:

1. **Observe** (no code): let the cadence run for one week; the scheduled
   runs append to `docs/INTERNAL_DOGFOOD_LOG.md` automatically in workflow
   terms; review for failures, flakiness, and credential-guard incidents.
2. **Rotate** (owner, ~10 min UI + operator API step): execute the §6
   runbook; close FL-10 with verification evidence.
3. **Close out** (one short assurance pass): re-verify gates, review the
   accumulated cadence history, decide GREEN — OPERATIONALLY CLOSED.

Explicitly **not** planned (per the no-speculative-work principle): new
features, provider additions, SSF v2, policy-language work, dashboards, or
test-volume growth. If the cadence is quiet and the rotation completes, the
correct outcome is *no new engineering work at all* — which is what a boring,
trustworthy internal primitive should look like.
