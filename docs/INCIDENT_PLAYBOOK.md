# Internal Incident Playbook

Operational runbook for SSF failures. Keep it next to the pager. Machine
guidance for agents lives in the recovery contract (`RETRY_SEMANTICS`,
`docs/OPERATING_MODEL.md` §7); this file is for humans.
(Operationalization milestone §23.)

Every incident: **classify, contain, preserve evidence, reproduce, regression
test, fix, re-run the full suite.** Never rationalize a false negative — an
unsafe action that was expected to be blocked and succeeded is a security
incident by definition, no matter how plausible the explanation.

Incident record fields (copy into the issue):

```
INCIDENT ID:     INC-YYYYMMDD-NN
TIMESTAMP:       <UTC>
ACTION:          <action_id / operation / target>
PROVIDER:        <provider name + resource>
AUTH STATE:      <expected_state (per-ref versions)>
OBSERVED STATE:  <what the provider actually reported>
EXPECTED RESULT: <what should have happened>
ACTUAL RESULT:   <what happened, with audit event ids>
EXECUTION:       <executed? condition result? side effect?>
ROOT CAUSE:      <filled after reproduction>
```

---

## 1. Condition failure (`execution.condition_failed`)

**Meaning:** the provider refused a stale mutation. The firewall worked; the
world moved. **No side effect occurred.**

**Do:**
1. Read `failed_ref`, `expected_state`, `observed_version` from the audit event —
   which dependency drifted and from what to what.
2. Have the agent discard the authorization (already consumed) and re-observe.
3. If drifts are frequent, investigate WHO is mutating the resource
   concurrently — a hot resource may need a different lock/ordering discipline.

**Never:** retry the same authorization (refused by design), or relax the
policy to "reduce noise" — the block was correct. Verify `retry_safety`
on the record says `SAFE_ONLY_AFTER_FRESH_EVALUATION`.

## 2. Provider outage (validation or execution faults)

**Meaning:** the provider could not be reached. The firewall fails closed.

**Do:**
1. Confirm the outage is real (provider status, network) — the firewall
   reporting unavailability while the provider is healthy is a different
   incident (see §6).
2. Nothing converts failure to success: blocked actions stay blocked. Agents
   re-attempt AFTER the provider recovers (fresh validation re-decides).
3. Check `provider_failures` counter and typed error kinds
   (`TIMEOUT / NETWORK_ERROR / SERVER_ERROR / RATE_LIMITED`) to characterize
   the outage pattern.

**Never:** bypass the firewall to "finish during the outage". The state basis
is gone; that is exactly what the firewall is for.

## 3. Unknown execution outcome (`conditional_execution: 'unknown'`)

**Meaning:** the request was sent; whether the provider applied the effect is
NOT OBSERVABLE from here. The side effect may have occurred. Retry is UNSAFE.

**Do:**
1. **Stop automated retries** for that action (they are refused anyway — do not
   try new action ids until reconciled).
2. Inspect the external system directly (server truth, provider console, logs)
   and determine whether the effect landed.
3. Record the reconciliation outcome (this closes the incident).
4. If the effect did not land and the action is still wanted: fresh observation
   → NEW action id → normal authorization flow.

**Never:** treat "no response" as success OR as not-executed. The firewall
never guesses; neither must the operator.

## 4. Suspected unsafe execution (possible false negative)

**Meaning:** an action executed that a guarantee should have blocked, or an
audit record contradicts external reality. **This is a security incident.**

**Do, in order:**
1. **Stop**: disable the affected tool/integration (`observe` mode is NOT a
   containment for an active bypass — remove the agent's access to the raw
   operation).
2. **Preserve evidence**: copy the SQLite audit DB(s) and telemetry files
   before anything else touches them; note `ssf audit --verify` output.
3. **Reproduce**: build the minimal scenario that executed unsafely (the
   dogfood harness scenarios are templates).
4. **Regression test**: pin the scenario in `test/` BEFORE fixing — it must
   fail first.
5. **Patch** the smallest possible surface; do not redesign solved security
   work without evidence (see the operationalization milestone §4).
6. **Re-run everything**: `npm test`, `npm run build`, `npm run typecheck`,
   `npm run lint`, `npm run check:hygiene`, `npm run dogfood` (plus the
   assurance/race/kill/provider suites).
7. **Document**: fill the incident record; update `limitations.md` if a
   boundary moved.

## 5. Provider violating conditional semantics (silent CAS failure)

**Meaning:** a provider that declared (or was assumed to enforce) conditions is
letting stale writes through — e.g. a server that ignores `If-Match`
(demonstrated end-to-end by dogfood S14 Case C).

**Do:**
1. **Disable the provider/resource** for conditional execution immediately
   (remove the resource mapping or set the executor to return `unavailable`).
2. **Classify the guarantee as UNAVAILABLE** for that resource — actions on it
   will fail closed under `require_conditional_execution` (correct).
3. **Investigate**: run the S14 verification recipe against the endpoint
   (see [providers.md](providers.md) §"Operator verification checklist").
4. Re-enable only after the endpoint demonstrably enforces preconditions, and
   record the verification (who/when/how) in the provider inventory.

**Never:** keep the capability declaration "because it mostly works". A silent
CAS failure voids the guarantee the whole firewall is built on.

---

## Escalation contacts and containment hooks

- Containment switch: remove the resource from the provider config, or set the
  policy's `on_conditional_unavailable: deny` with
  `require_conditional_execution: true` (fail closed).
- Firewalls are per-deployment stores: an incident in one deployment does not
  auto-propagate, but the same executor/provider wiring elsewhere must be
  audited immediately.
- `ssf audit --verify` and `ssf doctor --json` are the first two commands on
  any suspected integrity issue.
