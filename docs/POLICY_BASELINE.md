# Internal Policy Baseline

Recommended reference configuration for running SSF around internal agent
operations. It uses the repository's existing policy model (risk levels
`LOW / MEDIUM / HIGH / CRITICAL`, outcome mapping `allow / deny / revalidate /
escalate`, and the `execution` block) — no new concepts. A ready-to-use copy
lives at [`dogfood/configs/internal-baseline.yaml`](../dogfood/configs/internal-baseline.yaml).
(Operationalization milestone §6–7.)

## Design rules

1. **Safety first, but usable**: unknown state revalidates rather than allowing;
   proven-changed state (INVALID) always denies; nothing is allowed blindly.
2. **Conditional execution wherever the provider offers CAS** — required, not
   optional, for HIGH/CRITICAL mutations of CAS-capable resources.
3. **CRITICAL implies human eyes**: escalations on unknown state, short
   deadlines, no idempotent retry.
4. **Deadlines are the authorization validity window**: keep them short enough
   that a stale authorization dies before a human notices.

## Baseline tiers (existing model terminology)

| Tier | Typical actions | Freshness | Unknown state | Stale state | Conditional execution | Deadline | Retry |
|---|---|---|---|---|---|---|---|
| **LOW** | comments, labels, read-derived notes | `ttl` 5m | `revalidate` | `revalidate` | not required | 5m | `allow_idempotent_retry: true` for idempotent tools |
| **MEDIUM** | config edits in non-prod, dependency bumps | `version` | `revalidate` | `revalidate` | required when CAS exists | 2m | default (no auto retry) |
| **HIGH** | prod config, CI modification, deploys, releases | `version` (+preconditions) | `revalidate` | `revalidate` | **required** | 30s | no |
| **CRITICAL** | migrations, destructive ops, security policy | `version` (+preconditions) | `escalate` | `revalidate` | **required** | 30s | no |

Baseline behavior for the operational edge cases (all tiers):

| Situation | Recommended behavior | Where configured |
|---|---|---|
| Fresh state | `allow` | `on_fresh` (default) |
| Unknown state (provider unreachable, no signal) | `revalidate` (LOW–HIGH), `escalate` for CRITICAL | `on_unknown` |
| Proven state change (INVALID) | `deny` — never `allow`; forbidden by validation | `on_invalid` |
| Condition failure (`execution.condition_failed`) | authorization consumed; fresh evaluation + new authorization; never same-authorization retry | automatic + recovery contract |
| Conditional execution unavailable | `deny` (fail closed) — `allow` is rejected at validation as contradictory | `execution.on_conditional_unavailable` |
| Replay | refused + audited (single-use authorizations; store-scoped) | automatic |
| Deadline expiry | authorization dies; re-attempt as a new action | `execution.deadline` |
| Provider failure | fail closed (`REVALIDATE`/`DENY`), typed error + recovery contract | automatic |
| Unknown execution outcome | recorded as `unknown`, retry UNSAFE, inspect external state | automatic |

## Reference policy examples (§7)

Each example shows: action → declared dependencies → risk → required state →
conditional-execution requirement → expected behavior. These map to the
policies in `dogfood/configs/internal-baseline.yaml` and are exercised by the
continuous dogfood harness.

### 1. Read-only action
- **Action**: `post_deployment_note` (writes a comment derived from state).
- **Dependencies**: `github:ci_status/main` (observed sha+state).
- **Risk**: LOW.
- **Required state**: none (comment may note state).
- **Conditional**: not required (no CAS on comments; legacy best-effort path).
- **Expected behavior**: allowed on fresh state; on drifted CI state the note
  content is stale → `revalidate` recomputes; the agent resubmits or abstains.

### 2. File modification (non-prod)
- **Action**: `update_deploy_config` on staging configs.
- **Dependencies**: the file's blob sha (agent's read).
- **Risk**: MEDIUM.
- **Required state**: file still at the observed version.
- **Conditional**: required (CAS-capable resource).
- **Expected behavior**: CAS satisfied → applied; CAS-window drift →
  `condition_failed`, human edit preserved, recovery says fresh-evaluate.

### 3. Configuration change (prod)
- **Action**: `update_deploy_config` on production configs.
- **Dependencies**: file sha + `deployment/api-prod` status.
- **Risk**: HIGH.
- **Required state**: file version matches AND precondition
  `deployment.status == idle`.
- **Conditional**: required.
- **Expected behavior**: precondition failure → DENY naming the field; version
  drift → DENY/condition_failed; only fresh+matching state executes.

### 4. CI modification
- **Action**: `update_ci_workflow` (edit `.github/workflows/*`).
- **Dependencies**: workflow file sha.
- **Risk**: HIGH (CI gates what may deploy).
- **Required state**: file version; (optionally) no running run on the branch.
- **Conditional**: required.
- **Expected behavior**: any concurrent workflow edit → provider refusal; replay
  after execution → refused.

### 5. Dependency update
- **Action**: `bump_dependency` (lockfile + manifest edits).
- **Dependencies**: lockfile sha, manifest sha, CI status.
- **Risk**: MEDIUM (prod-deployed artifacts: HIGH).
- **Required state**: all three deps at observed versions; precondition
  `ci.state == success` routed to the CI dependency.
- **Conditional**: required on the written refs.
- **Expected behavior**: multi-dependency condition failures name the failed
  ref (`failed_ref`, DF-4); recovery contract present on the result.

### 6. Database migration
- **Action**: `run_migration`.
- **Dependencies**: migration-table version (schema head), config sha.
- **Risk**: CRITICAL.
- **Required state**: schema head at the observed migration version.
- **Conditional**: required when the migration runner offers CAS; otherwise the
  policy denies (fail closed) and the operator restructures with a
  CAS-capable resource as the conditioned ref.
- **Expected behavior**: unknown state → ESCALATE (human confirms); two agents
  racing the same migration → one claim, one `condition_failed`; no double
  application.

### 7. Deployment change
- **Action**: `flip_deploy` (traffic/color switch).
- **Dependencies**: `deployment/api-prod` version + status.
- **Risk**: CRITICAL.
- **Required state**: `status == idle`, version matches.
- **Conditional**: required.
- **Expected behavior**: concurrent flips → exactly one winner (shared-store
  claim + provider CAS); precondition failure (already deploying) → DENY.

### 8. Security-policy change
- **Action**: `update_security_policy` (branch protection, audit config).
- **Dependencies**: policy document version.
- **Risk**: CRITICAL.
- **Required state**: document at observed version; unknown state → ESCALATE.
- **Conditional**: required.
- **Expected behavior**: held for human approval when state is unverifiable;
  approval binds the exact payload (arguments included, DF-3); tampered
  resubmission refused.

### 9. Destructive operation
- **Action**: `purge_table` / `purge_cache`.
- **Dependencies**: table/zone version signal, config sha.
- **Risk**: CRITICAL.
- **Required state**: version matches; scope preconditions (e.g.
  `row_count < N`) evaluated against current metadata.
- **Conditional**: required (or deny).
- **Expected behavior**: ESCALATE on any uncertainty; executed once — replays
  refused; arguments bound into the approval; every block classified and
  audited.

## Where the baseline is exercised

`npm run dogfood` runs realistic variants of examples 2–9 continuously (config
edits, CI workflow changes, dependency bumps, deploy flips, migrations-style
holds, purge approvals) against sandbox providers and the local HTTP sandbox.
Failures are classified by the harness verdict taxonomy; `SECURITY_FAILURE`
stops the milestone.
