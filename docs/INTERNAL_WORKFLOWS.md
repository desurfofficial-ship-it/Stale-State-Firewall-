# Internal Workflows Protected by SSF

Sustained internal dogfood (§9–10): the real, repeatable, sandboxed,
reversible, observable workflows where SSF provides meaningful protection.
Nothing here is invented for testing — each workflow is a rehearsal of a
change class our agents actually perform, executed against the dedicated
sandbox repository (or offline fixtures) through the PUBLIC SDK surface only.

Protection invariants for every workflow:

- every consequential operation passes the firewall (`observe → declare →
  authorize → conditional execution → provider CAS → audit`);
- the ONLY raw provider calls are interference, seeding, server-truth
  verification, and cleanup — never the agent's mutation;
- recovery follows the machine-readable contract (`retry_safety`), never a
  blind retry;
- one store per trust domain; separate agent contexts never share a store.

---

## WF-1 — Agent-driven configuration change

| Field | Value |
|---|---|
| Workflow | Agent ships a deployment-config change (`deploy.yaml`) |
| Owner | Platform team (SSF internal dogfood program) |
| Resource | `github:file/desurfofficial-ship-it/ssf-dogfood-sandbox@dogfood/adoption-<run>/deploy.yaml` |
| Provider | GitHub Contents API (blob-SHA compare-and-swap) |
| Declared dependencies | the target file's blob SHA observed by the agent; an app-settings file for dependency-drift checks |
| Authorization mechanism | policy `agent-deploy-config-change` (HIGH risk, version freshness, `require_conditional_execution`) |
| Conditional mechanism | GitHub itself refuses the PUT when the current blob SHA differs from the authorized one (409/422); deleted file ⇒ 404 |
| Recovery mechanism | machine-readable contract: `condition_failed` → `retry_safety: SAFE_ONLY_AFTER_FRESH_EVALUATION` → re-observe → recompute (preserving concurrent changes) → NEW authorization |
| Audit location | firewall audit ledger (SQLite / memory), reconstructable via `ssf audit` / `ssf action inspect` |
| Rollback mechanism | the sandbox is disposable; a reverted change is itself a new SSF-authorized mutation (CAS-protected like any other) |

Demonstrated (all live, `dogfood/harness/scenarios/13-adoption-agent-workflow.mjs`,
14/14 PASS on 2026-09-06 including a GitHub Actions run `34020936423`):

- **normal execution** — dry-run ALLOW → authorize → CAS satisfied → server
  truth matches the authorized content (`reads=1`);
- **stale-state execution** — a human hotfix lands mid-flight; the agent's
  stale claim is DENIED at validation (declared dependency re-read); a CAS-window
  race is refused by GitHub itself with no side effect;
- **recovery** — the agent re-observes, recomputes PRESERVING the hotfix, and
  lands the change under a NEW authorization with zero developer help.

---

## WF-2 — Agent-driven dependency update

| Field | Value |
|---|---|
| Workflow | Agent bumps a dependency (`package.json`) with the lockfile following (`package-lock.json`) |
| Owner | Platform team (SSF internal dogfood program) |
| Resource | `github:file/desurfofficial-ship-it/ssf-dogfood-sandbox@dogfood/deps-<run>/package.json` (+ lockfile as declared dependency and follow-up mutation) |
| Provider | GitHub Contents API (blob-SHA compare-and-swap) |
| Declared dependencies | package.json blob SHA AND package-lock.json blob SHA (both re-read at validation) |
| Authorization mechanism | policy `agent-dependency-update` (HIGH risk, version freshness, `require_conditional_execution`) |
| Conditional mechanism | GitHub blob-SHA CAS on each mutated file |
| Recovery mechanism | `condition_failed` / DENY → re-observe both files → recompute under the new lockfile (dependabot's change preserved) → new authorization |
| Audit location | firewall audit ledger; the refused validation carries the drifted lockfile ref |
| Rollback mechanism | per-file git-level revert in the sandbox; any revert is itself an SSF-authorized mutation |

Demonstrated (live first run 2026-09-06, `dogfood/ops/dependency-update.mjs`,
`npm run dogfood:deps`, PASS on the first attempt — 8 steps):

- **normal execution** — dry-run ALLOW → package.json bump CAS-satisfied →
  lockfile follow-up authorized and CAS-satisfied (consistent pair);
- **stale-state execution** — a dependabot-style actor moves the lockfile
  BEFORE the agent's next authorization → the declared dependency is re-read →
  **DENY** (the agent's held SHA is stale);
- **recovery** — re-observe → recompute under the new lockfile → NEW
  authorization → executes with the dependabot change preserved;
- **documented boundary (DF-F2, live)** — lockfile drift INSIDE the CAS window
  does not block the package.json write: CAS protects the TARGET, not
  read-only dependencies. Recorded as `DOCUMENTED_BOUNDARY`, never hidden.

---

## WF-3 — Consequential action on unverifiable state (release publication)

| Field | Value |
|---|---|
| Workflow | Agent publishes a release (or any HIGH/CRITICAL action whose state cannot be CAS-verified) |
| Owner | Platform team (SSF internal dogfood program) |
| Resource | GitHub `release` / `pull_request` merge — resources WITHOUT an expected-revision mutation parameter |
| Provider | GitHub (conditional execution **UNSUPPORTED** on these resources) |
| Declared dependencies | PR head SHA / release tag observed before the action |
| Authorization mechanism | policy evaluation with `require_conditional_execution` → **deny when the provider cannot enforce the condition** (fail closed); CRITICAL policies escalate to human approval instead |
| Conditional mechanism | none available at the provider — SSF refuses to pretend (the "If-Match sent ≠ enforced" discipline) |
| Recovery mechanism | the block is terminal for that authorization: refresh → recompute → a NEW decision, or a human approves via the escalation path (approval binds the canonicalized arguments — swapped arguments are refused) |
| Audit location | firewall audit ledger (`action.blocked` with reason; escalation record) |
| Rollback mechanism | not applicable — no side effect ever occurred (that is the guarantee being demonstrated) |

Demonstrated (offline, deterministic):

- `dogfood/harness/scenarios/11-escalation-argument-binding.mjs` — human
  approval binds the approved arguments; executing with swapped arguments is
  refused; identical resubmission still fails closed on unverifiable state;
- `examples/github-release-agent/agent.ts` — merge blocked when the head SHA
  drifted between observation and action;
- the live analog: scenario 13's "non-file resource honestly refused" class
  (GitHub resources without CAS support deny under
  `require_conditional_execution`).

The SSF role for WF-3 is deliberately NOT conditional execution: it is
**honest refusal** — the firewall never executes a consequential action it
cannot conditionally enforce, and never converts a provider limitation into a
silent best-effort pass.
