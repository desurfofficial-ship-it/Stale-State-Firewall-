# Policies

Policies are declarative, deterministic, inspectable, versioned, testable, and auditable (spec §10). Business logic lives in policies, never in provider adapters.

## File layout

Everything can live in `ssf.config.yaml` (key `actions:` — named policies), or in an external file referenced by `policies_file:` with `{ schema_version: "1", policies: [...] }`.

## Anatomy

```yaml
actions:
  - name: production-deploy          # required, unique
    description: optional human text
    match:                           # required; at least one dimension
      tool: "github"                 # glob against the tool name
      operation: "deploy*"           # glob against the operation
      target: "*production*"         # glob against the primary target
      risk: CRITICAL                 # floor: applies at or above this risk
    risk: CRITICAL                   # risk assigned to matched actions
    freshness:
      strategy: version              # ttl | version | hash | preconditions | hybrid
      # ttl:      max_age: 10s  (required)
      # optional: aging_threshold: 0.75, clock_skew_tolerance: 0ms
      # hybrid:   hybrid: { ttl: true, version: true, hash: false, preconditions: true }
    preconditions:                   # evaluated against CURRENT state
      - field: deployment.status     # dot path into dependency metadata
        operator: equals             # see operator table
        value: healthy
      - field: ci.state              # route to a specific dependency (glob on
        operator: equals             # "<source>:<resource>/<resource_id>")
        value: success
        dependency: "github:ci_status/*"
    require_dependencies: true       # document that this policy needs declared deps
    dependency_freshness:            # per-dependency overrides (first match wins)
      - source: github
        resource: ci_status
        freshness: { strategy: ttl, max_age: 30s }
    on_fresh: allow                  # outcome mapping (defaults below)
    on_aging: null                   # null = derive from risk
    on_stale: revalidate
    on_unknown: revalidate
    on_invalid: deny
    execution:
      deadline: 10s                  # ALLOW validity window
      require_fresh_at_execution: true
      allow_idempotent_retry: false
```

## Outcome semantics (spec §6)

| Outcome | Meaning |
|---|---|
| `allow` | Safe to execute now; an authorization is issued with a deadline. |
| `deny` | Unsafe; nothing executes; the reason is recorded. |
| `revalidate` | Fetch current state and recompute the decision (see [revalidation.md](revalidation.md)). |
| `escalate` | Hold for explicit human approval; freshness is still re-verified before execution. |

Defaults: `on_fresh: allow`, `on_stale: revalidate`, `on_unknown: revalidate`, `on_invalid: deny`, `on_aging` derived from risk (allow for LOW/MEDIUM, revalidate for HIGH/CRITICAL).

## Precondition operators (spec §11)

| Operator | Subject | Notes |
|---|---|---|
| `equals` / `not_equals` | any | Structural (canonical JSON) equality; no type coercion. |
| `contains` / `not_contains` | string or array | Substring or element membership. |
| `exists` / `not_exists` | path | Presence test; JSON null counts as present; takes no `value`. |
| `greater_than` / `less_than` | number | Non-numeric subject/value **fails closed**. |
| `in` / `not_in` | any | Array membership via structural equality. |
| `matches` | string | Regex (`s` flag); invalid patterns rejected at validation. |

## Precedence (spec §32)

1. **Explicit action policy** — the intent names a policy (`policy:` field). A missing name is a hard `PolicyNotFoundError`, never a silent fallback.
2. **Matcher specificity** — most matching dimensions wins (operation counts 2, tool/target/risk 1 each). Ties break by declaration order; structurally identical matchers are rejected by `ssf policy validate` because they make resolution ambiguous.
3. **Risk defaults** — operation glob → risk level (first match wins, then `default`).
4. **Global default** — synthetic policy from `defaults:`.

Risk derivation: intent-declared risk > matched policy's `risk` > risk defaults; the final risk is the maximum of the base and the policy's declared risk.

## Validation (spec §30)

`ssf policy validate` (and every startup path) rejects:

- unknown fields at every level
- invalid enums (mode, risk, outcomes, operators, strategies, decision types)
- `ttl` without `max_age`; `max_age` on pure `version`/`hash`/`preconditions` strategies
- hybrid with `ttl: true` but no `max_age`; hybrid enabling no components
- `aging_threshold` outside (0, 1]; malformed durations; invalid regexes
- preconditions with impossible types (string compared with `greater_than`), `exists` carrying a value
- duplicate policy names; structurally identical matchers
- empty matchers (would silently match everything)

Enum spellings are case-insensitive (`critical` ≡ `CRITICAL`) and normalized at load.

## Dangerous defaults (spec §31)

- `on_unknown: allow` (or `defaults.on_unknown: allow`) requires explicit acknowledgment: `firewall.acknowledge_unknown_allow: true`. Even then, the decision engine's safety floor forbids `UNKNOWN → ALLOW` for CRITICAL actions (invariant 2).
- `on_invalid: allow` is **forbidden everywhere**. Proven state changes must never authorize the original action.

## Modes (spec §34)

| Mode | Behavior |
|---|---|
| `observe` | Decisions are computed and recorded; actions proceed. The would-be decision is preserved in `would_have_decided` and drives `ssf check` exit codes — adoption without risk. |
| `enforce` | Decisions block unsafe actions. Production mode. |
| `strict` | Uncertainty denies: `UNKNOWN → deny`, `AGING → revalidate` minimum. For critical environments. |

## Policy tests (spec §66)

Deterministic scenarios run offline against the in-memory provider:

```yaml
policy_tests:
  - name: ci failing blocks deploy
    action:
      agent_id: test-bot
      operation: deploy_production
      dependencies:
        - source: memory
          resource: deployment
          resource_id: prod
          version: v1
    state:
      - resource: deployment
        resource_id: prod
        version: v1
        metadata: { status: degraded }
    expect_decision: DENY
```

`ssf policy test` exits 0 only when every scenario passes. Fixtures pin explicit versions, so tests are time-independent.
