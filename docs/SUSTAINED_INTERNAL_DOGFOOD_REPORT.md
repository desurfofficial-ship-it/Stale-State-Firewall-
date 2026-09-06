# Sustained Internal Dogfood Report

Milestone: sustained internal productionization & evidence-driven hardening
(2026-09-06). Mission: turn SSF from a validated internal security control
into a sustained, boring, continuously exercised internal infrastructure
primitive — real workflows, real evidence, targeted changes only.

## Executive Summary

SSF held. The milestone ran as a verification-heavy, change-light pass: the
baseline was independently re-established at `0956ec5` (all six gates green),
the credential boundary was audited end to end (working tree, full git
history, Actions logs, secret configuration — all clean), rotation of the
campaign credentials was ATTEMPTED and honestly recorded as an owner action
after both revocation paths refused API-only completion, a recurring dogfood
cadence was added (daily offline + weekly protected live, ordinary CI still
credential-free), and a new real internal workflow class (agent-driven
dependency update) was exercised live against the sandbox on its first run.

Two friction signals were discovered and recorded (FL-9, FL-10) — neither is
an enforcement defect. One auditability gap was found through a real
operator-only incident investigation and closed with the smallest possible
change (expose the already-persisted, redacted request arguments via
`firewall.getAction()` / `ssf action inspect`), regression-pinned.

No P0/P1 security findings. No false positives, no false negatives. The
enforcement core was not modified.

**Final status: GREEN. Final answer: YES, WITH CONDITIONS** (credential
rotation; per-endpoint HTTP verification duty; cadence observation over time).

## Repository Baseline

Verified, not assumed (§3). HEAD == origin/main == `0956ec5`, working tree
clean at session start.

| Gate | Claimed | Measured this session | Verdict |
|---|---|---|---|
| npm test | 312/312 | **312/312 PASS** (27 files) | match |
| build | PASS | PASS | match |
| typecheck | PASS | PASS | match |
| lint | PASS | PASS | match |
| check:hygiene | PASS | PASS ("no forbidden markers, no secret-shaped strings") | match |
| offline dogfood | 12/12 | **12/12 PASS** (18 blocks / 21 successes / 2 documented boundaries) | match |
| live dogfood | 14/14 | **14/14 PASS** (23 / 31 / 3) with the current credential | match |

No discrepancy between the brief's baseline and the repository — nothing to
investigate, everything reproduced. After the milestone's changes the suite
is **314/314 (28 files)**; all gates re-run green (see Evidence Summary).

## Credential Hygiene

State of the campaign credentials, verified by use — not printed anywhere:

- **GitHub fine-grained PAT** (`github_pat_11CMJW…`): STILL ACTIVE
  (`GET /user` → 200). Auto-expires **2026-10-01 04:26:22 UTC** (25 days).
  GitHub's API has no revocation endpoint for PATs; minting a replacement
  requires the owner UI. Embedded ONLY in the local `.git/config` remote URL
  (push authentication) — never committed (history scan below).
- **npm token** (`npm_dWVf…`): STILL ACTIVE. Rotation was attempted for real:
  the token can LIST tokens (`GET /-/npm/v1/tokens` → 200) but revocation
  returns **403** — npm automation tokens are not token managers. Recorded as
  FL-10; owner action with exact steps (below). The account also holds two
  sibling tokens (metadata only: keys `4f045c1d…`, `d35a9d02…`, both
  `package:write` + `org:write` + bypass_2fa) that the owner should
  least-privilege-review; they were deliberately untouched.
- **Repository secret** `SSF_GITHUB_TOKEN`: repo-scoped, updated
  2026-09-06T07:58:46Z, inherited by the protected `dogfood-live`
  environment. Exactly ONE secret configured; the environment has no
  environment-scoped secrets (API confirmed).

Owner rotation runbook (never pretend completion — this is the explicit
remaining condition):

1. GitHub → Settings → Developer settings → Fine-grained tokens: revoke the
   campaign token; mint a replacement scoped to the SANDBOX repo only
   (`ssf-dogfood-sandbox`, Contents: Read & Write) — no administration scope.
2. Update the repo secret `SSF_GITHUB_TOKEN` with the replacement.
3. Update the local remote URL (currently embeds the old PAT) or switch to a
   credential helper.
4. npm → Access Tokens: revoke `a7b05050…`; nothing consumes npm credentials
   in any SSF workflow, so no reconfiguration is needed.
5. Re-run the live dogfood (dispatch the cadence workflow) and confirm green.

Boundary audits (§6), all clean, counts only — no values:

- Working tree incl. gitignored runtime/audit/telemetry state: **0** matches
  across 9 secret-shape classes.
- Full git history (every commit, every ref): **0** matches.
- All four Actions run logs downloaded and scanned (both failure polarities
  included): **0** matches.
- Workflow secrets inventory: `secrets.*` appears ONLY in
  `dogfood-live.yml` (guard + live step). `ci.yml` has zero references.

## CI Architecture

- **Ordinary CI** (`.github/workflows/ci.yml`, push/PR/dispatch):
  build · typecheck · lint · test · hygiene · offline dogfood.
  **Zero credentials** — verified by reading the workflow and by the
  secrets-usage scan. Security failures fail the run; the harness exits
  non-zero on any SECURITY/UNEXPECTED failure and can never downgrade one to
  a warning (harness verdicts + exit semantics regression-pinned).
- **Live provider dogfood** (`dogfood-live.yml`): `workflow_dispatch` +
  (new) `workflow_call`, protected `dogfood-live` environment, fail-closed
  credential guard, sandbox-only. Both polarities proven on real Actions
  runs (no secret → guard failure, live step skipped; secret → 14/14 PASS).
- **NEW sustained cadence** (`scheduled-dogfood.yml`): daily offline dogfood
  (03:17 UTC, credential-free) + weekly live sandbox dogfood (Monday 04:07
  UTC) via a reusable call to `dogfood-live.yml` — one implementation of the
  live contract, no duplicated guard logic. A missing credential at
  scheduled time fails the live job CLOSED (visible red, never a silent
  skip). No live credentials are required for any normal PR.

CI gate proof (§26): the gating workflow `ci.yml` was NOT modified this
milestone, so the historical failure→repair→success proof (runs e0e4738 /
eacc084 / fccd383 / 694e655) remains valid; adding an additive cadence
workflow does not change gate semantics. The cadence itself was proven by a
real dispatch (see Evidence Summary).

## Sustained Dogfood Cadence

The previous milestones proved the harness works. This milestone proves it
can KEEP working without anyone remembering to run it:

- daily: offline deterministic dogfood on the Actions runner (no secrets);
- weekly: live GitHub sandbox CAS exercise through the protected workflow;
- failures upload the harness report artifact; sustained-run records append
  to `docs/INTERNAL_DOGFOOD_LOG.md` (§8 run history table introduced).

Deliberately boring by design: no new infrastructure beyond one workflow
file, no external telemetry, no secret in any scheduled job.

## Internal Workflows

Documented per the §10 template in **`docs/INTERNAL_WORKFLOWS.md`** (new):

- **WF-1 agent-driven configuration change** — exercised live (scenario 13;
  14/14 today). Normal / stale / recovery all demonstrated; recovery is
  autonomous.
- **WF-2 agent-driven dependency update** — NEW this milestone
  (`dogfood/ops/dependency-update.mjs`, `npm run dogfood:deps`); live
  first-run PASS: dry-run ALLOW → bump CAS-satisfied → lockfile follow-up
  satisfied → dependabot-style drift DENIED at validation → autonomous
  recovery preserving the dependabot change → DF-F2 CAS-window boundary
  documented live → audit reconstruction + credential hygiene green.
- **WF-3 consequential action on unverifiable state (release publication)** —
  the fail-closed/escalation shape: no CAS at the provider ⇒ the firewall
  refuses (or escalates with argument binding), never best-effort.

All three are real change classes, sandboxed, reversible, observable, and
repeatable through committed drivers.

## Agent-Native Dogfood

The agent consumes SSF through the normal public interface only
(`check` / `execute` / result structures). Distinguishing evidence per
outcome, all from this session's live runs:

| Outcome | Agent-visible signal | Demonstrated |
|---|---|---|
| ALLOW | `decision=ALLOW`, conditional execution proceeds | WF-1 A/D, WF-2 A/C |
| DENY | `executed=false`, `decision.reason` names the stale/invalid dependency | WF-1 C/F1, WF-2 B |
| CONDITION_FAILED | `conditional_execution=failed` + `retry_safety: SAFE_ONLY_AFTER_FRESH_EVALUATION` + `side_effect_possible: false` + `failed_ref` | WF-1 E, incident exercise |
| UNKNOWN | explicit `unknown` execution state; policy `on_unknown` decides (revalidate/escalate); no blind retry path exists | preserved evidence (scenario 06; crash/restart honesty); 0 unknown events today |
| PROVIDER_FAILURE | typed provider errors classified (rate limit/outage/...) → fail closed | preserved evidence (OP-3 suite) |
| REPLAY | `ReplayDetectedError`; audit `action.replay_detected`; authorization stays dead across restart | scenario 14, incident exercise probe |

Expected agent behavior verified in real workflows: condition_failed →
refresh → recompute → reauthorize (WF-1 D, WF-2 C — zero developer
intervention); unknown → STOP and reconcile (enforced by absence of any
retry path for unknown outcomes; scenario 14 pins that the local record is
honestly silent when the provider acted but the firewall never saw it).

## Stale-State Recovery

Measured as recovery QUALITY, not just mechanics (§12):

- The refusal result is machine-readable: `failed_ref`, `expected_state`,
  `observed_version`, `retry_safety`, `side_effect_possible`. An agent can
  determine: why it failed (named dependency), whether retry is safe (retry
  safety enum), what to refresh (the failed ref), and that a NEW
  authorization is required (consumed authorizations stay dead).
- Live recovery events this session: WF-1 step D (hotfix preserved), WF-1
  step E (CAS-window loser recovers), WF-2 step C (dependabot drift
  recovered), incident exercise (CLI-verifiable recovery record).
- Improvement made from evidence: `ssf action inspect` now prints the
  requested arguments and declared dependencies (below) — the operator side
  of the same recovery-quality bar.

## Unknown Outcome Handling

Semantics unchanged from the operationalization milestone (explicit
`unknown` execution state; `executions_unknown_outcome` metric; no path from
unknown to success/failure guesses). This milestone's contribution:
persistence honesty re-verified by usage — scenario 14's mid-provider crash
boundary shows the audit record is SILENT about an execution the firewall
never observed (no false success, no false failure; reconciliation is the
recovery), and the replay probe stays refused across restart. 0 unknown
outcomes occurred in today's live runs.

## Operator Incident Exercise

Executed for real (§13): `dogfood/ops/incident-exercise.mjs` wrote a genuine
stale-state incident (legit change → CAS-window race → replay probe →
recovery) into a SQLite store; the operator phase then used ONLY the CLI
against the evidence directory.

Answerable from CLI output alone (13 records, chain verified OK):

1. What happened — `ssf audit`: proposed → validated ALLOW →
   `execution.condition_failed` → `action.blocked` → replay refused → new
   action validated and executed.
2. What was authorized — `ssf action inspect`: policy, risk, decision ALLOW
   with fresh-dependency verdicts at authorization time.
3. What changed — the later DENY verdict records observed v2 vs current v3
   with the interference's content hash.
4. Why execution failed — `execution.condition_failed`: "provider refused:
   the authorized state changed between authorization and execution".
5. Whether a mutation occurred — the refused mutation did not (CAS held);
   the concurrent actor's v3 did (visible via version + content hash).
6. Whether retry is safe — `action.replay_detected`: "authorization already
   consumed; action cannot be replayed"; verdicts carry the refresh
   contract.
7. What recovery occurred — records #11–13: fresh validation and execution
   under a NEW authorization.

Gap found and fixed: "what exactly was requested" (the intent arguments) was
persisted (redacted) but not surfaced. Smallest change: read-only
`firewall.getAction()` + `ssf action inspect` now prints `Action / Requested /
Dependencies`; regression-pinned in
`test/operationalization/audit-request-visibility.test.ts` (sensitive keys
 provably `[REDACTED]`).

## Provider Verification

Inventory reviewed and updated (`docs/providers.md`): every conditionally
trusted row carries status, operator, date, evidence, and known limitations.

- In-memory: VERIFIED (every CI run) — evidence extended with the
  SQLite-persisted incident exercise; known limitation added for the
  FL-9 `put()` version-keeping trap (documented, not hidden).
- GitHub `file`: VERIFIED (live, sandbox-only) — evidence extended with this
  session's 14/14 re-run and the WF-2 first-run PASS; other GitHub resources
  remain UNSUPPORTED.
- HTTP: the two sandbox-server rows keep their explicit scope caveats; **any
  real production HTTP endpoint remains NOT VERIFIED** — no endpoint was
  available, so none was fabricated (§15). The checklist and the
  "If-Match sent ≠ server-enforced" discipline are intact.

## Trust-Domain Isolation

Verified by existing, still-green evidence plus today's live runs: `action_id`
is the primary key in every store table, so the store IS the trust domain;
separate agent contexts in the live races used independent stores (scenario
13 G); `ssf doctor` surfaces the resolved store path and the
one-store-per-trust-domain rule (5 trust-domain tests green in the 314).
No shared authorization state, audit chain, or provider identity across
domains was observed. No new tests needed (§22).

## Persistence

Existing SQLite behavior verified during real usage, not redesigned: the
incident exercise ran against a persistent SQLite store (chain verified via
`ssf audit --verify`: 13/13 records OK); scenario 14 continues to pin
crash/restart guarantees (replay refused across restart in all three crash
boundaries; consumed authorizations stay dead; no double execution).
No persistence defect surfaced; no persistence change made.

## Performance

`scripts/bench-conditional.ts`, 2000 iterations, in-memory provider:

| Metric | legacy | conditional | delta |
|---|---|---|---|
| p50 | 0.140 ms | 0.124 ms | **−11.5%** |
| p95 | 0.258 ms | 0.194 ms | −24.8% |
| p99 | 0.680 ms | 0.301 ms | −55.7% |

Consistent with the recorded family across sessions (−9.4%, −12.6%, −13.2%):
conditional execution is not a tax — it removes a redundant fetch. No
material regression; per §21 no optimization work is triggered.

## Friction Log

New entries (evidence-first; nothing auto-fixed):

- **FL-9 (P3, fixture DX)** — `InMemoryStateProvider.put()` on an EXISTING
  resource keeps its version: a content change without a version bump is
  CAS-invisible, and the doc comment says otherwise. Found while authoring
  the incident exercise; the enforcement core is unaffected (the provider's
  own CAS bookkeeping was honored; real providers hash content).
  Recommendation: align the comment; consider a debug warning on
  version-preserving replace.
- **FL-10 (P2, operational)** — npm automation tokens can list but not
  revoke tokens (DELETE → 403): rotation is blocked to the web UI; recorded
  with exact metadata for the owner runbook.

Prior open items re-triaged: FL-1/FL-2/FL-4 remain open P3s — none was hit
repeatedly or materially enough this milestone to promote (FL-4 was worked
around by the recovery contract exactly as designed). FL-7 stays closed
(cache-bust holding: `reads=1` across all live readbacks today).

## Security Findings

**None.** No P0/P1 findings this milestone. No unsafe execution, stale
mutation, authorization replay, unknown-as-success, condition bypass, audit
falsification, credential leakage, or cross-trust-domain contamination was
observed in any run. FL-9 is a fixture-authoring trap (DX), explicitly not a
false negative — the firewall enforced exactly the CAS contract the provider
reported. False-positive/false-negative tally for the milestone: **0 / 0**.

## Changes Made

Each change states why / evidence / security impact / coverage / rollback
(§24):

1. `ci:` **scheduled-dogfood.yml** (new) + `workflow_call` trigger on
   dogfood-live.yml — recurring evidence over time. Rollback: delete the
   file / revert the trigger. No gate semantics touched.
2. `ops:` **dogfood/ops/dependency-update.mjs** + `dogfood:deps` script —
   WF-2 workflow class as a repeatable live driver (fails closed without
   credentials; not part of the offline suite).
3. `ops:` **dogfood/ops/incident-exercise.mjs** — the §13 operator exercise
   as a re-runnable evidence generator (SQLite-backed, fresh per run).
4. `security:` (visibility, fail-safe direction) `firewall.getAction()` +
   `ssf action inspect` request-visibility — §19 gap; read-only exposure of
   already-persisted redacted arguments; pinned by
   `test/operationalization/audit-request-visibility.test.ts` (2 tests).
   Rollback: revert the commit.
5. `docs:` INTERNAL_DOGFOOD_LOG (FL-9/FL-10 + run history §8),
   INTERNAL_WORKFLOWS.md (new), providers.md evidence rows, README
   (314 tests, dogfood:deps, doc links). This report.

The enforcement core (authorization, freshness, conditional execution,
provider CAS, replay protection, audit engine) received **zero** changes —
the evidence did not justify any.

## Remaining Conditions

1. **Credential rotation (owner action)** — campaign PAT (expires
   2026-10-01) and npm token `a7b05050…` per the runbook above; then update
   the repo secret and re-verify the live workflow.
2. **Per-endpoint HTTP verification (operator duty)** — no real internal
   HTTP endpoint exists; every real endpoint stays NOT VERIFIED (deny) until
   the six-item checklist is run and recorded.
3. **Cadence observation** — the scheduled workflow must accumulate
   sustained runs (and the log must be appended) before "continuously
   exercised" is claimed as ongoing fact rather than established capability.
4. **Open P3s** — FL-1/FL-2/FL-4/FL-9 triaged by frequency/impact; fix only
   on evidence.

## Evidence Summary

| Claim | Evidence |
|---|---|
| Baseline green at 0956ec5 | six gates re-run this session (312/312, 12/12 offline) |
| Live workflow operational with current credential | `npm run dogfood:github` 14/14 PASS |
| CI green at HEAD | Actions run #6 (0956ec5, success) |
| Secret boundary clean | tree/history/Actions-log scans: 0 matches; single repo secret; `ci.yml` credential-free |
| Rotation attempted, blocked by provider models | `GET /user` 200 + expiry header; npm DELETE 403; FL-10 + runbook |
| Cadence established | scheduled-dogfood.yml committed; verified by dispatch (see CI status below) |
| 3 real workflows, one agent-native | docs/INTERNAL_WORKFLOWS.md; WF-1/WF-2 live runs |
| Agent distinguishes all six outcomes | outcome table above; live refusal/recovery events |
| Recovery understandable | machine-readable contract fields; autonomous recoveries; CLI reconstruction |
| Operator investigation works | incident exercise + CLI-only 7-question reconstruction |
| Provider inventory accurate | providers.md rows updated; HTTP NOT VERIFIED kept honest |
| Isolation + persistence hold | trust-domain tests green; scenario 14; incident exercise SQLite chain verified |
| Performance healthy | conditional p50 −11.5%, p95 −24.8% |
| Post-change regression | 314/314 (28 files), build/typecheck/lint/hygiene PASS, offline dogfood 12/12 |

## Final Decision

**Status: GREEN.**
**Answer: YES, WITH CONDITIONS.**

SSF is reliable enough to be treated as a normal internal infrastructure
primitive that our own AI agents and development systems can depend on for
stale-state protection — demonstrated, not asserted: live provider-enforced
CAS under real interference, autonomous agent recovery without developer
help, CLI-only incident reconstruction, replay-dead authorizations across
restart, honest unknown semantics, and a now-recurring evidence cadence.

The conditions are operational, not architectural: (1) complete the
credential rotation per the runbook; (2) keep unverified HTTP endpoints
denied until per-endpoint verification; (3) let the scheduled cadence
accumulate its evidence trail; (4) keep the P3s evidence-triaged. The
absence of new enforcement work IS the successful outcome of this milestone.

## Next Milestone

Derived from evidence, deliberately small:

1. **Rotation completion + least-privilege replacement** (owner action this
   report specifies) — then one cadence re-verification run.
2. **Observe the cadence** for a sustained period; append run history; react
   only to real failures (the harness classifies them; no new tooling).
3. **FL-9 documentation fix** (align the `put()` comment; optional
   version-preserving-replace warning) if it recurs or blocks an integrator.

Explicitly NOT started (no evidence demand): control planes, dashboards,
policy languages, telemetry platforms, SSF v2.
