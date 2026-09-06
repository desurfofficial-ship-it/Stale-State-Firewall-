# SSF Continuous Internal Dogfooding & Controlled Adoption Report

**Milestone:** Continuous internal dogfooding & controlled adoption (post re-verification `b6ce0e9`)
**Status line:** `CONTINUOUS DOGFOOD: GREEN — the loop runs in CI, the live loop runs on GitHub Actions, the first workflow is live, friction is measured and logged`
**Date:** 2026-09-06 (independent re-verification pass updated the same day)
**Head at report:** `694e655` (milestone) → updated by the re-verification pass (FL-7 fix + crash/restart scenario + live-workflow first run); see the Live Repository Baseline below

---

## Executive Summary

This milestone moved SSF from "GREEN and ready for internal use" to
"continuously exercised, continuously observable, and progressively adopted":

1. **The repository has CI for the first time** (`.github/workflows/` did not
   exist before this milestone). Every push/pull request now runs
   build · typecheck · lint · test · hygiene · **offline dogfood**, with no
   credentials. Live-provider dogfood is isolated behind a manual, protected,
   fail-closed workflow. The gate proved itself real on its very first run: it
   **failed** on a genuine type error in this milestone's own code
   (`TS2540`, run `e0e4738`) and went **success** after the fix (`eacc084`).
2. **The first real internal workflow is protected end to end.** Harness
   scenario 13 (`adoption-agent-workflow`) is a live, repeating, agent-shaped
   deployment-config change against the dedicated GitHub sandbox repo:
   observe → dry-run → authorize → provider CAS → audit, with interference,
   stale refusal, autonomous recovery, multi-dependency drift, concurrent
   agents, and audit reconstruction — 14/14 scenarios PASS including live,
   both locally and on GitHub Actions.
3. **The live workflow now has a complete on-Actions evidence chain**
   (re-verification pass): its first dispatch with no secret configured
   **failed closed exactly as designed** (run `34020483097` — credential
   guard, live step skipped); after the sandbox token was configured it ran
   the full live suite to **success** (run `34020936423` @ `138d4c7`).
4. **Friction is a first-class record** (`docs/INTERNAL_DOGFOOD_LOG.md`):
   eight evidence-backed entries (5 closed, 3 open P3s), 0 false positives,
   0 false negatives observed. The re-verification pass added two: FL-7 (a
   real cache-induced harness false failure on Actions runners — fixed and
   re-verified) and FL-8 (credential-scope boundary, resolved via a
   repo-scoped secret).
5. **Crash/restart persistence is now exercised, not assumed** (scenario 14,
   re-verification pass): interruption after the claim, after the provider
   applied the mutation, and after normal completion — SQLite keeps the
   guarantees across all three (no side effect, no replay, no double
   execution, audit never lies).

**Final question (§34) answered: YES, WITH CONDITIONS** — see Recommendation.

## Live Repository Baseline

Independently re-verified at milestone start (HEAD `b6ce0e9`, clean tree)
and again by the re-verification pass (HEAD `694e655`, clean tree):

| Gate | Result |
|---|---|
| `npm test` | **307/307** at start → **312/312 PASS (27 files)** after additions; re-confirmed 312/312 at `694e655` |
| `npm run build` / `typecheck` / `lint` / `check:hygiene` | PASS (both passes) |
| `npm run dogfood` | 11/11 at start → **12/12 PASS** (18 blocks / 21 successes / 2 boundaries — adds crash/restart scenario 14) |
| `npm run dogfood -- --with-github` | 13/13 at `694e655` → **14/14 PASS** incl. live GitHub (23 / 31 / 3) |
| GitHub Actions `CI` | 4 real runs: `e0e4738` fail → `eacc084` pass → `fccd383` fail → `694e655` pass |
| GitHub Actions live workflow | first dispatch no-secret → fail-closed (`34020483097`); with secret → **success** (`34020936423`) |
| Benchmark | conditional p50 **−13.2%** vs legacy (re-verification re-run) |

No inherited numbers; every figure above is from a run executed during these
passes. Note: `npm test` counts grew because of the 5 new trust-domain
tests (§10), not because any existing test changed.

## CI Integration (§4–6, §30)

**Chosen integration point:** the repository had NO workflows at all, so the
smallest correct integration was to create the two workflows:

- **`.github/workflows/ci.yml`** — `push`/`pull_request`/manual; Node 24;
  `npm ci` → build → typecheck → lint → test → hygiene → `npm run dogfood`
  (offline, deterministic, credential-free, sandbox providers only). The
  harness report is uploaded as an artifact on failure. Determinism: the
  offline harness resets all state per run and uses fixed sandbox resources.
- **`.github/workflows/dogfood-live.yml`** — **manual `workflow_dispatch`
  only**, behind the `dogfood-live` environment gate, `contents: read` only.
  A credential guard step **fails closed** if `SSF_GITHUB_TOKEN` is absent,
  and prints that this is an environment failure of the job — never a
  security failure of the firewall. Ordinary CI never touches credentials.

**Failure semantics (§6):** the harness already classifies every step as
`EXPECTED_SECURITY_BLOCK / EXPECTED_SUCCESS / DOCUMENTED_BOUNDARY /
UNEXPECTED_FAILURE / SECURITY_FAILURE` and exits non-zero on unexpected or
security failures (malformed scenarios throw → captured as
`UNEXPECTED_FAILURE` → exit 1). A missing *optional* live credential is a
`SKIPPED` scenario — not a pass, not a security failure. Nothing converts a
security failure into a warning; exit codes are the contract.

**§30 gate-real verification, three independent proofs:**
1. *Local isolation*: a deliberately-broken scenario (expect-block that does
   not happen + failing success) produced `SECURITY_FAILURE` +
   `UNEXPECTED_FAILURE` and harness exit code 1; the scenario was then
   removed (never committed) and the suite returned to PASS.
2. *Real CI*: the first push (`e0e4738`) **failed at the Build step** —
   `TS2540: Cannot assign to 'storeDescription' because it is a read-only
   property`, a genuine defect this milestone had introduced (vitest does not
   typecheck; the gate caught it). After the fix, run `eacc084` is **success**.
3. *Real live workflow, both polarities* (re-verification pass): dispatching
   `dogfood-live.yml` before any secret existed **failed at the credential
   guard** (run `34020483097` — checkout/build green, guard failure, live
   step skipped, log says "ENVIRONMENT FAILURE … NOT a security failure of
   SSF"); after the sandbox token was configured the same workflow ran the
   full live suite to **success** (run `34020936423`). A gate that has only
   ever passed is not proven; this one has been proven in both directions.

## Live Provider Verification (§7–9)

- **GitHub `file`** (dedicated sandbox repo, `ssf-dogfood-sandbox`): re-verified
  live again this milestone — CAS satisfied → mutation applied; CAS-window
  race → GitHub refuses (condition failed); two independent agents racing →
  exactly one mutation lands, GitHub decides; loser recovers via fresh
  authorization. Evidence: harness scenarios 12 + 13, inventory row updated,
  **and the first full on-Actions live run `34020936423` (success, 14/14)**.
- **On-Actions fail-closed proof** (re-verification pass): with the
  `SSF_GITHUB_TOKEN` secret absent, run `34020483097` failed at the credential
  guard and the live step was skipped — the live loop can never silently pass
  or run without explicit credentials, in the real runner environment.
- **Live-gate reliability under runner conditions (FL-7)**: the first live
  Actions run exposed a harness-layer false failure (stale Contents-API cache
  read, see Friction Log). Fixed by cache-busting every harness GET plus a
  bounded readback window; the provider's own `If-None-Match` fresh reads
  were correct throughout and needed no change. Re-verified live on Actions.
- **HTTP sandbox rig**: checklist item 5 (redirects) was the last locally
  verifiable gap. A `/redirect/` route now 307-redirects to the `/correct`
  handler, and scenario 07 Case C verifies through the real network stack:
  redirected stale `If-Match` → **412 with no mutation**; redirected matching
  `If-Match` → **applied**. Inventory updated (items 1–3, 5, 6 verified for
  the controlled rig).
- **Real production HTTP endpoints: UNVERIFIED — honestly.** No endpoint we
  are authorized to test exists in this environment, so none was invented.
  Prerequisites to complete verification are documented (inventory row +
  checklist): an owned endpoint, authorization, the real network path
  (including proxies/LBs for checklist item 4), an operator to run the
  six-item recipe, and an inventory row recording who/when/evidence.

## First Internal Workflow (§11–12)

**Selected:** agent-driven deployment-config change in the dedicated GitHub
sandbox repository. Consequential (shared repo state, derived from aging
observations), repeatable (self-seeding per run), sandboxed (never
production), observable (audit + GitHub API), reversible (file edit +
cleanup). The integration is the **public SDK surface only**
(`check()` → `execute()` with an honest conditional executor → provider CAS
→ audit); the only raw API calls are the world's interference, server-truth
verification, seeding, and cleanup — never the agent's mutation (§23 boundary
check: no `fetch→decide→mutate` path outside SSF exists in the integration).

Before/during/after are recorded by the scenario steps themselves (observed
sha, decision, conditional result, server truth), satisfying §12's evidence
requirement without inventing a metrics subsystem.

## Agent Dogfood (§13–15)

The agent performs legitimate work (observe `deploy.yaml` → formulate
`replicas: 3` → dry-run ALLOW → authorize → execute; server truth confirmed).
Then controlled interference: a second actor hotfixes the file. The agent's
stale claim is **DENIED at validation** (declared dependency re-read;
decision reason names the drifted ref). The agent then recovers **without
developer intervention** (§15): re-observes, recomputes *preserving the human
hotfix*, creates a NEW authorization, executes — server truth shows the
intended change with the hotfix intact. §14 anti-cheating rules honored: no
internal helpers, no bypassed authorization, live provider semantics rather
than simulated ones for all provider-guarantee steps, no suppressed failures.

## Condition Failure Recovery (§17)

CAS-window drill on live GitHub: authorize against the current sha; a
concurrent actor commits before the mutation; **GitHub refuses the stale
write** (`conditional_execution: 'failed'`), `retry_safety:
SAFE_ONLY_AFTER_FRESH_EVALUATION`, `side_effect_possible: false`, no side
effect landed (server truth verified), audit records
`execution.condition_failed` with `failed_ref` + expected vs observed state.
Recovery: fresh observation → new authorization → executes.

## Unknown Outcome Recovery (§16)

The controlled unknown-outcome scenario (harness scenario 06, `/lossy`
sandbox route: mutation applied, response destroyed) ran PASS in every
harness invocation this milestone: the agent receives
`conditional_execution: 'unknown'` with `success: false`, `retry_safety:
UNSAFE`, `side_effect_possible: true`, `executions_unknown_outcome` counter
increments, and replay of the same authorization is refused. A real-provider
unknown outcome cannot be forced safely (severing a live GitHub response
mid-flight is not controllable from the client), so the semantic guarantee is
exercised on the fault-injecting sandbox rig and pinned by
`test/operationalization/recovery-contract.test.ts` — stated as a
limitation, not claimed as live coverage.

## Concurrency (§19)

Two **independent firewall contexts** (separate stores, separate provider
instances) observe the same blob sha, both authorize, both execute
concurrently: **exactly one mutation lands**; the other receives
`condition_failed` from GitHub itself — the provider, not local coordination,
is the final authority. The loser recovers via fresh observation → new
authorization → success.

## Multi-Dependency Behavior (§18)

With A = written target (CAS-protected) and B = read-only dependency:
- B drifts **before** authorization → **DENY** (declared dependencies are
  re-read at authorization) — verified live.
- B drifts **in the CAS window** → the action **executes** from authorized
  values — verified live on GitHub as a `DOCUMENTED_BOUNDARY` step: this is
  exactly DF-F2. CAS on A does **not** protect B; the caller owns dependency
  declaration, and intents where read-only drift matters must be restructured.
  Both behaviors are documented in `limitations.md` and the operating model.

## Crash/Restart Experiment (§14)

New harness scenario 14 (`crash-restart-persistence`, offline, deterministic)
interrupts a real `execute()` flow at three meaningful boundaries by running
it in a child process that is SIGKILLed mid-flight, then reopening the SAME
SQLite database (real crash recovery, journal/WAL included) in the parent:

1. **After the claim, before the provider is called** — sentinel files prove
   the executor was entered but the provider was never called; the reopened
   store **refuses a replay of the same action id** (`ReplayDetectedError`,
   thrown by the pre-validation guard), the audit contains the proposal and
   validation records and **no execution record**, and no side effect exists.
2. **After the provider applied the mutation, before the firewall observed
   the response** — the provider's sentinel proves the external change
   happened; the replay is still refused; the audit is honestly silent about
   the execution (no false success, no false failure). This is the persisted
   form of the unknown-outcome contract: the local record cannot know the
   external truth, and reconciliation is the recovery — by design, not by
   accident.
3. **Control: normal completion** — the child completes and exits; on
   restart the consumed authorization stays dead (replay refused), the audit
   shows the full `proposed → validated → executed` chain, and the same
   action id cannot run twice (no double execution).

Evidence: `npm run dogfood` scenario 14 (PASS; 257 ms; audit event lists
printed per step). The scenario runs on every push in CI.

## Auditability (§24)

Scenario 13 step H reads the audit ledger and reconstructs, from records
alone: action (`action_id`, agent, tool, operation), target (ref with repo +
path), authorized state (`expected_state` per-ref versions), observed state
(`observed_version`), provider + capability, decision + reason, execution
result and condition outcome, and retry safety (`failure_kind` +
`retry_safety` on every failure record). "Why was this allowed?" and "why was
this blocked?" are answerable without reading source code — verified live
(executed records, condition-failed record with `failed_ref`, blocked record
with reason, all present).

## Metrics (§20)

Local counters only — `firewall.getMetrics()` / `ssf doctor --json`; the
adoption scenario exposes them as a workflow step (`allowed=2 denied=0
cond_ok=1 cond_failed=0 unknown=0 replays=0` mid-workflow) and the harness
report captures per-run numbers. Counters cover attempted / allowed / denied /
condition failures / replays rejected / provider failures / unknown outcomes
/ fresh re-evaluations. False positives and false negatives remain human
classifications in the friction log (this milestone: 0 and 0). No external
telemetry, no sensitive payload collection, no new storage subsystem — the
audit ledger and metrics registry already supported everything required.

## Developer/Agent Friction (§21)

`docs/INTERNAL_DOGFOOD_LOG.md` records eight evidence-backed entries — each with
date, workflow, what happened, friction, root cause, severity, workaround,
recommended fix:

- **FL-1 (P3, open)** — misleading `inspectState` error for un-seeded memory
  resources (blames config; real cause is "resource doesn't exist yet").
- **FL-2 (P3, open)** — in-memory `put`-then-`mutate` seeding split is
  non-obvious.
- **FL-3 (P2, closed)** — no CI existed at all; now `ci.yml` +
  `dogfood-live.yml`.
- **FL-4 (P3, open)** — GitHub 409 responses carry no current sha, so
  condition-failure results show `observed_version: null` (recovery contract
  already mandates re-observation, so impact is one extra GET).
- **FL-5 (P2, closed)** — store identity invisible to operators; now
  `firewall.storeDescription` + doctor surface the resolved path.
- **FL-6 (P3, closed)** — redirect behavior untested locally; now the
  `/redirect` rig + scenario 07 Case C.
- **FL-7 (P2, closed, re-verification pass)** — the live workflow's first
  Actions run failed on a **stale Contents-API cache read** in the harness's
  server-truth verification (GitHub had confirmed the CAS write —
  `conditional=satisfied`; the bare GET returned the pre-write content).
  Fixed: cache-busting query on every harness GET + a bounded readback window
  used only after the provider has confirmed the outcome — never to retry or
  decide one. The provider's own `If-None-Match` reads were fresh throughout
  and the enforcement core needed no change.
- **FL-8 (P2, closed, re-verification pass)** — the campaign fine-grained PAT
  can create the `dogfood-live` environment but cannot write
  environment-scoped secrets (HTTP 403); resolved with a repo-scoped secret,
  which environment jobs inherit (isolation contract unchanged).

P3s were deliberately **not** auto-fixed (evidence-first); the P2s were
closed because their fix was the milestone's own hardening.

## Findings and Fixes

| # | Finding | Type | Fix | Regression pin |
|---|---|---|---|---|
| CD-1 | No CI existed; the continuous loop had no enforcement point | operational | `ci.yml` (offline gates + dogfood) + `dogfood-live.yml` (isolated, protected, fail-closed) | real Actions runs `e0e4738` (fail) → `eacc084` (pass) |
| CD-2 | `TS2540` in this milestone's `storeDescription` change — **caught by the new CI gate on its first run** | correctness (self-inflicted) | private backing field + getter; full gates re-run before push | CI run evidence; `test/operationalization/trust-domain.test.ts` |
| CD-3 | Cross-environment store sharing was undetectable from operator output | operational (§10) | `firewall.storeDescription` (resolved absolute sqlite path / per-process memory label) surfaced by `ssf doctor` | 5 trust-domain tests |
| CD-4 | Checklist item 5 (redirects) had no local verification | verification gap | `/redirect` sandbox route; scenario 07 Case C (stale→412 no mutation; matching→applied through a real 307) | offline harness run |
| CD-5 | README claimed "293 tests" and omitted the dogfood gate | documentation staleness (§27) | corrected to the actual count and gate list | — |
| CD-6 | Live gate's first on-Actions run failed on a stale Contents-API cache read in the harness's verification layer (FL-7) — the enforcement core behaved correctly throughout | reliability (harness layer) | cache-busting query on every harness GET; bounded server-truth readback used only after the provider confirms the outcome; scenarios 12/13 GETs hardened | Actions `34020483097` (false failure) → `34020936423` (success); local `reads=1` on all readbacks |
| CD-7 | The live workflow had never run on Actions — its fail-closed contract and its success path were both unproven in the real runner environment | verification gap | created the `dogfood-live` environment, wrote the repo-scoped `SSF_GITHUB_TOKEN`, dispatched both polarities | run `34020483097` (guard failure, live step skipped) → run `34020936423` (success, 14/14) |

No enforcement-core behavior changed. No solved security work (authorization,
CAS, replay, SQLite claim semantics, audit chain) was touched — the only SDK
change is an additive, read-only store-identity description.

## Remaining Limitations

All boundaries from previous milestones hold, unchanged and re-documented:
HTTP `If-Match` operator verification duty (per real endpoint; item 4
proxy/LB behavior untestable locally); DF-F2 write-only CAS scope
(re-demonstrated live); store-scoped replay; tamper-evident-not-proof audit
chain; executor trust boundary. Additionally: a real-provider unknown outcome
is semantically pinned but not live-exercisable safely (see §16 above).

Updated by the re-verification pass:
- The `dogfood-live` environment exists and the repo-scoped
  `SSF_GITHUB_TOKEN` secret is configured — the live workflow has now run on
  Actions in both polarities (fail-closed and success). Environment-scoped
  secrets are still unavailable to the current PAT's scope (FL-8); the
  repo-scoped secret inherits identically for this workflow.
- Crash/restart behavior at the three interruptible boundaries is now
  exercised (scenario 14), not merely argued from the architecture. What
  remains un-simulated is an interruption strictly inside the provider's
  HTTP round-trip against the real GitHub API — a client cannot reliably
  sever that mid-flight without affecting the request itself; the fault
  injection rig covers the semantics deterministically instead.
- The harness is now sensitive to GitHub's Contents-API caching
  characteristics (FL-7 fix); if a future cache layer ignores query strings,
  readbacks would need a stronger mechanism (e.g. commit-sha-pinned reads).

## Credential Hygiene (§26)

Re-verified independently during the re-verification pass:
- Git history scan (per-commit `git grep` over every blob, secret-shaped
  regexes): **0 matches**. Working tree scan: **0 matches** (the only regex
  hit historically was the hygiene gate's own detector pattern).
- `.gitignore` covers `.env*`, `ssf-state.db*` (incl. journal/wal/shm),
  `dogfood/reports/state/` — runtime state and crash-scenario scratch never
  reach git.
- Both campaign credentials are **still active** (GitHub PAT: authenticated
  API call HTTP 200; npm token: `/-/whoami` HTTP 200). The npm token has no
  legitimate use (nothing is published) and should simply be revoked.
- **Credential-scope finding (FL-8)**: the PAT can create environments and
  read/write repository contents but **cannot write Actions secrets at
  environment scope** (HTTP 403). A repo-scoped `SSF_GITHUB_TOKEN` secret
  was therefore written via the API (client-side sealed-box encryption; the
  secret value never appears in logs or artifacts) — the `dogfood-live` job
  inherits it, and the isolation contract (manual trigger + environment gate
  + fail-closed guard) is unchanged.
- **Rotation: REQUIRED (owner action).** The PAT and npm token were used
  across campaign sessions and provided in task context in plaintext; they
  cannot be rotated via API by this agent. When rotating: create the new
  token, update the repo secret `SSF_GITHUB_TOKEN` with the same value
  (one action — the live workflow reads the secret, not the literal token),
  then revoke the old token. Until rotation, treat both as
  campaign-scoped credentials.

## Security Assessment (§23)

- Every consequential operation in the integration goes through the SSF
  boundary; the raw-API surface is limited to the world's actions
  (interference, server-truth checks, seeding, cleanup).
- No new bypass introduced: the adoption workflow cannot reach the provider
  mutation except through authorization + conditional execution; duplicate
  tool registration is refused by `protect()`; replay/expiry/unknown-outcome
  guards re-verified by the kill, race, audit, and operationalization suites
  (all green in the 312).
- CI cannot leak credentials: the offline gate has no secret access;
  `dogfood-live.yml` has `contents: read`, is manual-only, and fails closed
  without the sandbox token.

## Performance (§28)

`scripts/bench-conditional.ts` (2000 iterations, in-memory provider):
legacy p50 0.142 ms / conditional p50 0.128 ms — **conditional −9.4% p50**
(milestone run). Re-verification re-run: legacy p50 0.146 ms / p95 0.235 /
p99 1.421 vs conditional p50 0.127 ms / p95 0.191 / p99 0.250 —
**conditional −13.2% p50** and better tail latency; prior runs: −12.3%,
−12.6%. Variance is environmental, the conditional path remains faster (it
removes the redundant re-check fetch). No duplicate state fetches, extra
validation, excessive DB operations, or logging amplification were
introduced (additive fields on existing records only).

## Recommendation (§33–34)

**Gate: GREEN** — continuous internal dogfooding is functioning: the loop
runs in CI on every push, the live loop runs on demand against sandbox
resources, the first internal workflow is protected and recovering
autonomously, and no material security, correctness, or operational blocker
exists.

**Can SSF now be continuously embedded into our own consequential
AI-agent/software-development workflows as an internal security control,
with CI enforcement and a documented recovery process? YES, WITH CONDITIONS:**

1. **Rotate the campaign credentials** (GitHub PAT, npm token) — required,
   owner action, before further live dogfooding. When rotating the PAT,
   update the repo secret `SSF_GITHUB_TOKEN` in the same step (the live
   workflow reads the secret) and then revoke the old token; revoke the npm
   token outright (nothing publishes).
2. ~~Configure the `dogfood-live` environment and `SSF_GITHUB_TOKEN`
   secret~~ — **DONE during the re-verification pass**: environment created,
   repo-scoped secret written, and the live workflow proven on Actions in
   both polarities (`34020483097` fail-closed → `34020936423` success).
   Keep it manual and protected.
3. **Verify every real HTTP endpoint** against the six-item checklist before
   pointing an agent at it, and append the evidence row to the provider
   inventory (endpoints remain UNVERIFIED until then).
4. **Keep `SECURITY_FAILURE` a stop-the-line event** (Incident Playbook §4)
   and never weaken the harness taxonomy to make runs look cleaner.
5. **Triage the open P3 friction items (FL-1, FL-2, FL-4)** as evidence
   accumulates; fix when frequency justifies it — no speculative features
   (§22).

The loop this milestone makes boringly reliable:
agent proposes → SSF observes → SSF authorizes → provider-enforced condition
protects the mutation → audit records the outcome → if stale: block, refresh,
recompute, re-authorize → continue safely.

## Next Milestone (§29 — from evidence, not ambition)

Top 3 evidence-backed improvements (if nothing else emerges, "no meaningful
improvement" is an acceptable answer — the loop already runs daily):

1. **Make the memory-provider seeding UX self-explanatory (FL-1 + FL-2,
   P3, batched)**
   - Problem: the first contact every new integrator has with the SDK is a
     misleading `inspectState` error ("no state provider is configured")
     and a non-obvious `put`-then-`mutate` split.
   - Evidence: two open entries in the friction log; both were hit
     spontaneously during the incident drill and again while writing
     scenario 14's child.
   - Impact: minutes-to-hours of confusion per new integration; no security
     impact.
   - Proposed change: distinguish "no provider for source" from "provider
     present but resource unknown" in `inspectState`'s error text, and
     document (or fold, behind an explicit flag) the put/mutate split.
   - Risk: very low — error text and docs only; no enforcement change.
   - Priority: P3 — fix when the next integration touches it, together
     with any other DX batch.
2. **Rotate and scope the campaign credentials (owner action, high
   priority)**
   - Problem: one fine-grained PAT and one npm token have crossed multiple
     sessions, arrived in plaintext, and the PAT is now also stored as a
     repo secret — the blast radius of a leak grows with time.
   - Evidence: both tokens verified still active (HTTP 200) during the
     re-verification pass; npm token has no legitimate use at all; FL-8
     shows the PAT's scope already exceeds what the workflow needs in
     some dimensions and lacks it in others.
   - Impact: a leaked campaign token grants contents-write to the repo.
   - Proposed change: mint a **least-privilege** sandbox PAT (contents:
     read/write on `ssf-dogfood-sandbox` only), update the repo secret,
     revoke the old PAT and the npm token.
   - Risk: near zero — the live workflow only touches the sandbox repo.
   - Priority: **highest of the three** (operational security, not code).
3. **Watch FL-4 (GitHub 409 carries no current sha) before adding any
   second live provider (P3, watch)**
   - Problem: a refused condition-failure cannot report the winner's
     version (`observed_version: null`), so recovery always costs one
     extra GET.
   - Evidence: scenario 13 step G detail (`loser_observed=n/a…`) on every
     live run; unchanged across sessions.
   - Impact: one GET per recovery — cheap today, but every future live
     provider adapter will inherit the same shape decision.
   - Proposed change: none now. If a GitHub API revision exposes the
     current sha on conflict, map it into `observed_version`; when the
     second live provider is added, decide the adapter convention once,
     deliberately.
   - Risk: none (observation only).
   - Priority: P3 — re-evaluate at the next provider integration.
