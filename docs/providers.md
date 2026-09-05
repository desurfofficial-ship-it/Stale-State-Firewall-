# Providers

Providers implement one small interface (spec §16, §55):

```ts
interface StateProvider {
  readonly name: string;
  supports(ref: { source: string; resource: string; resource_id: string }): boolean;
  getState(ref: StateDependency, nowIso: string): Promise<StateSnapshot>;
  getConditional?(ref: StateDependency, nowIso: string): Promise<StateSnapshot | null>;
  supportsConditionalVerification?(): boolean;
}
```

Contract rules:

- `getState` returns **current** state from the source of truth — never a cached copy (invariant 8).
- `getConditional` answers "is the resource still at version X?". Returning a snapshot means the provider **proved** the state unchanged (`unchanged_since_observed: true`, provenance `conditional_304`). Returning `null` means "do a full fetch".
- Failures throw typed errors (`ProviderUnavailableError`, `ProviderResponseError`) which become UNKNOWN verdicts — never silent ALLOW (invariant 7).

Every shipped provider passes the same contract suite (see `test/contract/providers.test.ts`).

## In-memory provider (`stale-state-firewall/adapters/memory`)

```ts
import { InMemoryStateProvider } from 'stale-state-firewall/adapters/memory';

const memory = new InMemoryStateProvider('memory');
memory.put('customer', 'c1', { status: 'active' }, nowIso);
memory.mutate('customer', 'c1', { status: 'suspended' }, nowIso); // bumps version
```

A real provider implementation for tests, examples, and `policy_tests` fixtures. It fully implements the contract, including version bumping and conditional verification. It is not wired into enforcement unless configured.

## Generic HTTP provider (`stale-state-firewall/adapters/http`)

```yaml
providers:
  http:
    enabled: true
    resources:
      deployment:
        url: https://ops.internal/api/deployments/{id}   # {id} <- resource_id
        headers:
          authorization: env(DEPLOY_API_TOKEN)           # env() indirection only
        version:
          source: header          # or json_path
          name: etag              # header name or dot path
        observed_at:
          source: json_path
          name: $.updated_at
          format: iso             # iso | epoch_s | epoch_ms
        metadata_paths:           # metadata key -> dot path into the body
          status: $.status
        content_hash: body        # sha256 of the response body ('off' to disable)
        timeout_ms: 5000
```

Version resolution order: configured extraction → `ETag` header → `Last-Modified` header. Content hashing covers the raw response body.

Conditional verification sends `If-None-Match: <version>`. A `304` proves the resource is unchanged — but a 304 has no body, so if `metadata_paths` are configured and the agent did not declare those fields, the provider falls back to a full fetch: preconditions must be verified against real current state.

`env(VARNAME)` header values are resolved from the environment at request time and never logged. URLs are sanitized (query strings stripped) in errors.

## GitHub provider (`stale-state-firewall/adapters/github`)

```yaml
providers:
  github:
    enabled: true
    api_base: https://api.github.com
    timeout_ms: 5000
    include_reviews: true
```

Authentication: `SSF_GITHUB_TOKEN` or `GITHUB_TOKEN` from the environment — never config files, never logs.

| Resource | resource_id | Version signal | Metadata highlights |
|---|---|---|---|
| `pull_request` | `owner/repo#42` | head SHA (fallback ETag) | state, draft, merged, mergeable_state, review_status |
| `issue` | `owner/repo#42` | ETag (fallback updated_at) | state, labels, updated_at |
| `branch` | `owner/repo@main` | commit SHA | protected |
| `ci_status` | `owner/repo@sha` | combined-status SHA | state (success/failure/pending), total_count |
| `deployment` | `owner/repo@production` | latest deployment id | latest status state, environment |
| `release` | `owner/repo@v1.2.3` | release id | tag, target_commitish |

`review_status` aggregates the PR's reviews deterministically: for each reviewer, only the latest review counts; `CHANGES_REQUESTED` (latest) wins over older approvals; otherwise `approved` requires at least one live approval; `pending` otherwise.

Conditional verification uses `If-None-Match` with the ETag; `304` responses prove the PR/issue is unchanged since the agent's version — fresh verification without re-pulling the body.

Rate limiting (`403` + `x-ratelimit-remaining: 0`) surfaces as `ProviderUnavailableError` with the reset time — it must fail closed downstream, never look like successful validation.

No single signal is assumed universally authoritative (spec §18): snapshots carry version, ETag, and content hash, and the freshness engine prefers the strongest applicable signal per policy.

## Custom providers

Implement `StateProvider` and pass instances via `providers:`:

```ts
const firewall = await StaleStateFirewall.create({
  configPath: './ssf.config.yaml',
  providers: [myPostgresProvider],   // takes precedence over config-assembled ones
});
```

Run your implementation against the shared contract suite to guarantee identical behavior (`getState` freshness, conditional semantics, typed failures).
