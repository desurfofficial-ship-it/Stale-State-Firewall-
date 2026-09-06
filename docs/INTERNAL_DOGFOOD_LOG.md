# Internal Dogfood Friction Log

Evidence-first friction record for continuous internal dogfooding
(continuous-dogfood milestone §21). Every entry comes from an actual
dogfood/adoption/integration session — nothing speculative. Severity:
P0 security / P1 correctness / P2 operational / P3 developer experience.
P3s are collected here and prioritized by frequency and impact; they are
NOT auto-fixed, so the evidence can accumulate first.

| ID | Date | Workflow | Operation | What happened | Friction | Root cause | Severity | Workaround | Recommended fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| FL-1 | 2026-09-06 | Incident drill (§25) | `inspectState` on a fresh in-memory provider | `no state provider is configured for source "memory"; configure one in ssf.config.yaml under providers` even though the provider WAS registered | The operator is sent to fix the config when the actual cause is that the resource was never seeded — the in-memory provider only `supports()` resources that exist | `InMemoryStateProvider.supports()` checks `resources.has(...)`; the error message in `inspectState()` is generic and blames configuration | P3 | Seed with `provider.put(...)` before inspecting (canonical example does this) | Distinguish "no provider for source" from "provider present but resource unknown" in the error text | open |
| FL-2 | 2026-09-06 | Incident drill (§25) | seeding a memory resource | `provider.mutate(...)` refuses with `cannot mutate unknown resource` — `put()` must be called first | Two-step seeding is not obvious from the API names | `mutate` intentionally only updates existing resources (it bumps versions); creation is `put` | P3 | Follow the canonical example (`put` → `mutate`) | Document the put/mutate split on the provider surface or fold creation into `mutate` behind an explicit flag | open |
| FL-3 | 2026-09-06 | CI integration (§4) | setting up the dogfood CI gate | The repository had NO `.github/workflows/` at all — the "continuous" loop had no enforcement point before this milestone | Every gate previously depended on discipline (local runs); nothing prevented a regressing push | CI had never been created for this internal-only tool | P2 (operational) | — (fixed this milestone) | CLOSED: `ci.yml` (offline gates + offline dogfood on push/PR) + `dogfood-live.yml` (manual, protected, sandbox-only) | closed 2026-09-06 |
| FL-4 | 2026-09-06 | Adoption workflow (§13, scenario 13 step G) | CAS-window race loser on live GitHub | The refused condition-failure result carries `observed_version: null` — GitHub's 409 response does not include the current blob sha | The loser's recovery says "re-observe fresh state" but cannot say what the winner's version IS; an extra GET is needed | GitHub Contents API 409 body does not carry the current sha | P3 | Re-observe (which the recovery contract mandates anyway) | If a future GitHub API revision exposes the current sha on conflict, map it into `observed_version` | open |
| FL-5 | 2026-09-06 | Trust-domain review (§10) | `ssf doctor` before this milestone | The storage check said only "store opened and migrated" — two deployments accidentally pointing at the same `ssf-state.db` were undetectable from doctor output | Store identity invisible; cross-environment sharing would mix audit trails silently | No resolved-path surfacing existed | P2 (operational) | — (fixed this milestone) | CLOSED: `firewall.storeDescription` + doctor now prints the resolved absolute store path and the one-store-per-trust-domain rule | closed 2026-09-06 |
| FL-6 | 2026-09-06 | HTTP checklist (§8) | redirect behavior verification | Checklist item 5 (redirects) had no local verification — the sandbox rig covered ETag/If-Match/412 but not 3xx | An operator could not see the transport-level precondition preservation demonstrated anywhere | The sandbox server had no redirect route | P3 | — (fixed this milestone) | CLOSED: `/redirect/` route added; scenario 07 Case C verifies stale→412/no-mutation and matching→applied through a real 307 | closed 2026-09-06 |

False-positive / false-negative tracking (§25/§26 of the operationalization
milestone, continued): this milestone recorded **0 false positives** (every
block was a correct stale/CAS/dependency rejection) and **0 false negatives**
(no action that should have been blocked ever executed — verified live on
GitHub by scenarios 12 and 13). Two scenario-authoring errors during scenario
13 development were caught by review before first run and fixed; no firewall
defect was found.
