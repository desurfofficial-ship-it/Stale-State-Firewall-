# Providers

Providers implement one small interface (spec §16, §55):

```ts
interface StateProvider {
  readonly name: string;
  supports(ref: { source: string; resource: string; resource_id: string }): boolean;
  getState(ref: StateDependency, nowIso: string): Promise<StateSnapshot>;
  getConditional?(ref: StateDependency, nowIso: string): Promise<StateSnapshot | null>;
  supportsConditionalVerification?(): boolean;

  // Conditional execution (milestone: atomic effect assurance)
  supportsConditionalExecution?(): boolean;
  conditionalExecute?(request: {
    ref: { source: string; resource: string; resource_id: string };
    expected_version: string;      // the AUTHORIZED version, not a fresh read
    changes: Record<string, unknown>;
  }): Promise<
    | { outcome: 'executed'; version: string | null; output?: unknown }
    | { outcome: 'condition_failed'; current_version: string | null }
  >;
}
```

Contract rules:

- `getState` returns **current** state from the source of truth — never a cached copy (invariant 8).
- `getConditional` answers "is the resource still at version X?". Returning a snapshot means the provider **proved** the state unchanged (`unchanged_since_observed: true`, provenance `conditional_304`). Returning `null` means "do a full fetch".
- `supportsConditionalVerification` (a read-side 304 check) and `supportsConditionalExecution` (a mutation-side compare-and-swap) are **different capabilities**. Verification only reads; conditional execution makes the external system refuse stale mutations.
- `conditionalExecute` applies a mutation only if the provider's current version equals `expected_version`, **atomically inside the provider**. A separate `get()` then `set()` is NOT a valid implementation. `condition_failed` means the provider refused a stale operation — no side effect occurred; it is not an internal error.
- Failures throw typed errors (`ProviderUnavailableError`, `ProviderResponseError`) which become UNKNOWN verdicts — never silent ALLOW (invariant 7).


## Conditional execution capability matrix

| Provider | Conditional execution | Mechanism | Condition evaluated by | Guarantee |
|---|---|---|---|---|
| In-memory | SUPPORTED | `conditionalExecute()` — synchronous check-and-mutate, atomic in the event loop | the provider, inside the mutation | FULL (provider-enforced CAS) |
| GitHub `file` | SUPPORTED | Contents API update with the authorized blob `sha` (stale sha ⇒ 409/422, deleted ⇒ 404) | GitHub, inside the PUT | FULL (provider-enforced CAS) |
| GitHub other resources | UNSUPPORTED | no expected-revision parameter exists on those mutation endpoints | — | best-effort pre-execution verification |
| HTTP resource with `mutation` config | SUPPORTED | `If-Match: <authorized version>` on the configured mutation (412/409 by default ⇒ condition failed) | the HTTP server, inside the mutation request | FULL — requires the operator to have verified the server honors RFC 9110 preconditions |
| HTTP resource without `mutation` config | UNSUPPORTED | — | — | best-effort pre-execution verification |

Executors plug into this via the optional `conditionalExecutionSupported()` / `conditionalExecute(intent, expectedState)` hooks on `ActionExecutor`; the firewall hands them the per-dependency authorized state captured at authorization time. See [atomic-effect-assurance.md](atomic-effect-assurance.md) for the full security model.

Every shipped provider passes the same contract suite (see `test/contract/providers.test.ts`).

## In-memory provider (`stale-state-firewall/adapters/memory`)

```ts
import { InMemoryStateProvider } from 'stale-state-firewall/adapters/memory';

const memory = new InMemoryStateProvider('memory');
memory.put('customer', 'c1', { status: 'active' }, nowIso);
memory.mutate('customer', 'c1', { status: 'suspended' }, nowIso); // bumps version
```

A real provider implementation for tests, examples, and `policy_tests` fixtures. It fully implements the contract, including version bumping, conditional verification, and a true atomic compare-and-swap (`conditionalExecute`): the version check and the mutation happen synchronously in one call, so no interleaving is possible.

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

Conditional **execution** is opt-in per resource: declare a `mutation` endpoint and the provider performs it with `If-Match: <authorized version>`. The server is responsible for refusing stale preconditions (412/409 by default; configure `condition_failed_status` if your API differs). **Operator assumption:** a generic HTTP endpoint provides no atomicity unless it honors `If-Match` (RFC 9110). That verification is an explicit configuration act — a server that silently ignores the header provides no atomicity, which is why the capability is not enabled by default.

```yaml
providers:
  http:
    enabled: true
    resources:
      deployment:
        url: https://ops.internal/api/deployments/{id}
        version: { source: header, name: etag }
        mutation:
          method: PUT                    # default PUT; PATCH/POST/DELETE allowed
          url: https://ops.internal/api/deployments/{id}   # optional; defaults to the read url
          body: { source: ssf }          # base body; request changes are merged over it
          condition_failed_status: [412, 409]
```

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
| `file` | `owner/repo@path/to/file` | **blob SHA** | path, sha, size, type |

The `file` resource is the conditional-execution resource: `conditionalExecute` sends the authorized blob SHA to the Contents API update (`PUT /repos/{o}/{r}/contents/{path}`), and **GitHub itself refuses the write** when the file's current blob SHA differs (HTTP 409/422) or the file is gone (404). That is genuine provider-enforced compare-and-swap: the condition is evaluated by GitHub inside the mutation call, not by a fresh GET. File contents are never copied into snapshot metadata (the blob SHA is the signal; content may be sensitive).

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
