# Freshness model

## Principle (spec §7)

Freshness is **not a global TTL**. Different state has different volatility, different version signals, and different failure modes. Stale-State Firewall supports five strategies, combinable via `hybrid`.

## Staleness classification (spec §8)

Every dependency verdict is one of:

| Class | Meaning | Default outcome |
|---|---|---|
| `FRESH` | Comfortably within policy | allow |
| `AGING` | Approaching the TTL boundary (beyond `aging_threshold`, default 0.75) | allow for LOW/MEDIUM risk, revalidate for HIGH/CRITICAL |
| `STALE` | Exceeded the freshness requirement | revalidate |
| `INVALID` | Demonstrably changed, or an invariant failed against current state | deny |
| `UNKNOWN` | Validity cannot be established (missing observation basis, provider failure, malformed state, future-dated timestamp) | revalidate |

Severity ordering used for aggregation: `FRESH < AGING < STALE < UNKNOWN < INVALID`. A proven state change (INVALID) outranks an inability to verify (UNKNOWN) because it is stronger evidence; both fail closed.

## Cross-strategy drift detection

Regardless of the configured strategy, two checks always apply when the signals exist:

- The agent declared a **version** and the provider exposes a **current version**, and they differ → `INVALID` (the state the agent reasoned about no longer exists).
- The agent declared a **content hash** and the current hash differs → `INVALID`.

This is what catches "the PR moved under the agent" even when a TTL would still be comfortable.

## Strategies

### ttl

Age of the agent's observation (`now - observed_at`) against `max_age`.

- `age <= aging_threshold * max_age` → FRESH
- `age < max_age` → AGING
- `age >= max_age` → STALE
- missing/unparseable `observed_at` → UNKNOWN
- `observed_at` in the future beyond `clock_skew_tolerance` → UNKNOWN (fabricated or broken clock; never FRESH)

### version

The observed version must equal the current version (commit SHA, ETag, row revision, deployment id...).

- equal → FRESH (no age component; if the world is exactly as observed, the observation cannot be stale)
- differ → INVALID (also caught by cross-strategy drift)
- agent declared none → UNKNOWN
- provider exposes none → UNKNOWN
- provider affirmed **unchanged** via conditional request (`unchanged_since_observed`) → FRESH

### hash

Same shape as version, over content hashes.

### preconditions

Invariants evaluated against **current** state metadata (never the agent's claim alone):

- all pass → FRESH; any fail → INVALID.
- An operator on a missing field fails closed (INVALID), except `exists`/`not_exists` which test presence (JSON null counts as present).
- Numeric operators (`greater_than`, `less_than`) require numbers; anything else fails with an explicit "requires numeric values" reason.
- `matches` requires a string pattern and string subject; invalid regexes are rejected at policy-validation time.

### hybrid

ALL enabled components must pass; the verdict is the worst component result. Default components when unspecified: `ttl + version + preconditions`.

```yaml
freshness:
  strategy: hybrid
  max_age: 5s
  hybrid: { ttl: true, version: true, hash: true, preconditions: true }
```

## Risk-aware freshness (spec §9)

Risk comes from (in order): the action intent, the matched policy, the `risk_defaults` operation patterns. AGING behavior depends on risk: low-risk actions may proceed, high-risk actions are forced through revalidation. The safety floor additionally forbids `UNKNOWN → allow` for CRITICAL actions regardless of configuration.

## Clock handling (spec §27)

- Provider **server timestamps** are preferred for `observed_at` (GitHub `updated_at`, configured HTTP fields); the provenance records `time_source`.
- All durations are computed from the injected `Clock` — `ManualClock` in tests/fixtures, `SystemClock` in production.
- `clock_skew_tolerance` (default **0**, i.e. conservative) explicitly widens TTL boundaries: `effective_age = age - skew`, floored at zero. Widening never happens implicitly.
- Version/hash equality is preferred over wall-clock comparisons wherever the provider exposes a stable signal.

## Where freshness is verified

1. **Validation** (`check`/`execute`): fresh provider fetch per dependency.
2. **Revalidation** (`REVALIDATE` → recompute): the fetched snapshots become the new basis; see [revalidation.md](revalidation.md).
3. **Execution time** (`require_fresh_at_execution`, default on): re-fetch + fingerprint compare immediately before the side effect; see [revalidation.md](revalidation.md#execution-time-verification-toctou).

Cached observations are never treated as fresh verification (invariant 8).
