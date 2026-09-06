# SSF Continuous Internal Dogfooding & Controlled Adoption Report

**Milestone:** Continuous internal dogfooding & controlled adoption (post re-verification `b6ce0e9`)
**Status line:** `CONTINUOUS DOGFOOD: GREEN — the loop runs in CI, the first workflow is live, friction is measured and logged`
**Date:** 2026-09-06
**Head at report:** `eacc084`

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
   agents, and audit reconstruction — 13/13 scenarios PASS including live.
3. **Friction is now a first-class record** (`docs/INTERNAL_DOGFOOD_LOG.md`):
   six evidence-backed entries (3 closed by this milestone, 3 open P3s),
   0 false positives, 0 false negatives observed.

**Final question (§34) answered: YES, WITH CONDITIONS** — see Recommendation.

## Current Baseline

Independently re-verified at milestone start (HEAD `b6ce0e9`, clean tree):

| Gate | Result (this milestone's own runs) |
|---|---|
| `npm test` | **307/307 PASS** at start → **312/312 PASS (27 files)** after additions |
| `npm run build` / `typecheck` / `lint` / `check:hygiene` | PASS |
| `npm run dogfood` | 11/11 PASS (16 blocks / 18 successes / 2 boundaries) |
| `npm run dogfood -- --with-github` | 13/13 PASS incl. live GitHub (21 / 28 / 3) |

No inherited numbers; every figure above is from a run executed during this
milestone. Note: `npm test` counts grew because of the 5 new trust-domain
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

**§30 gate-real verification, two independent proofs:**
1. *Local isolation*: a deliberately-broken scenario (expect-block that does
   not happen + failing success) produced `SECURITY_FAILURE` +
   `UNEXPECTED_FAILURE` and harness exit code 1; the scenario was then
   removed (never committed) and the suite returned to PASS.
2. *Real CI*: the first push (`e0e4738`) **failed at the Build step** —
   `TS2540: Cannot assign to 'storeDescription' because it is a read-only
   property`, a genuine defect this milestone had introduced (vitest does not
   typecheck; the gate caught it). After the fix, run `eacc084` is **success**.
   The gate is demonstrably real: it failed on a broken state and passed on
   the restored state.

## Live Provider Verification (§7–9)

- **GitHub `file`** (dedicated sandbox repo, `ssf-dogfood-sandbox`): re-verified
  live again this milestone — CAS satisfied → mutation applied; CAS-window
  race → GitHub refuses (condition failed); two independent agents racing →
  exactly one mutation lands, GitHub decides; loser recovers via fresh
  authorization. Evidence: harness scenarios 12 + 13, inventory row updated.
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
internal helpers, no bypassed authorization, live provider semantics (not
mocked) for all provider-guarantee steps, no suppressed failures.

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

`docs/INTERNAL_DOGFOOD_LOG.md` records six evidence-backed entries — each with
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

P3s were deliberately **not** auto-fixed (evidence-first); the two P2s were
closed because their fix was this milestone's own hardening.

## Findings and Fixes

| # | Finding | Type | Fix | Regression pin |
|---|---|---|---|---|
| CD-1 | No CI existed; the continuous loop had no enforcement point | operational | `ci.yml` (offline gates + dogfood) + `dogfood-live.yml` (isolated, protected, fail-closed) | real Actions runs `e0e4738` (fail) → `eacc084` (pass) |
| CD-2 | `TS2540` in this milestone's `storeDescription` change — **caught by the new CI gate on its first run** | correctness (self-inflicted) | private backing field + getter; full gates re-run before push | CI run evidence; `test/operationalization/trust-domain.test.ts` |
| CD-3 | Cross-environment store sharing was undetectable from operator output | operational (§10) | `firewall.storeDescription` (resolved absolute sqlite path / per-process memory label) surfaced by `ssf doctor` | 5 trust-domain tests |
| CD-4 | Checklist item 5 (redirects) had no local verification | verification gap | `/redirect` sandbox route; scenario 07 Case C (stale→412 no mutation; matching→applied through a real 307) | offline harness run |
| CD-5 | README claimed "293 tests" and omitted the dogfood gate | documentation staleness (§27) | corrected to the actual count and gate list | — |

No enforcement-core behavior changed. No solved security work (authorization,
CAS, replay, SQLite claim semantics, audit chain) was touched — the only SDK
change is an additive, read-only store-identity description.

## Remaining Limitations

All boundaries from previous milestones hold, unchanged and re-documented:
HTTP `If-Match` operator verification duty (per real endpoint; item 4
proxy/LB behavior untestable locally); DF-F2 write-only CAS scope
(re-demonstrated live); store-scoped replay; tamper-evident-not-proof audit
chain; executor trust boundary. Additionally: a real-provider unknown outcome
is semantically pinned but not live-exercisable safely (see §16 above), and
the live CI workflow needs the `dogfood-live` environment + sandbox secret
configured by a repository admin before its first real run.

## Credential Hygiene (§26)

- Git history scan (`git log --all -p`): GitHub PAT and npm token **absent**.
- Working tree / reports / audit records: **no credential-shaped strings**
  (the only regex match is the hygiene gate's own detector pattern). Both
  live scenarios assert "no credentials in audit records" — PASS.
- `.gitignore` covers `.env*`, `ssf-state.db*`, `dogfood/reports/state/`.
- Session usage: tokens were passed via environment variables to shell
  commands only; never written to repo files or artifacts.
- **Rotation: REQUIRED.** The PAT and npm token were used across campaign
  sessions and provided in task context in plaintext; they cannot be rotated
  via API by this agent. Owner must rotate both in the GitHub/npm UI after
  this report. Until then, treat them as campaign-scoped credentials.

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
prior runs: −12.3%, −12.6%; variance is environmental, the conditional path
remains faster (it removes the redundant re-check fetch). No duplicate state
fetches, extra validation, excessive DB operations, or logging amplification
were introduced (additive fields on existing records only).

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
   owner action, before further live dogfooding.
2. **Configure the `dogfood-live` environment and `SSF_GITHUB_TOKEN` secret**
   in repository settings so the isolated live workflow can run; keep it
   manual and protected.
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
