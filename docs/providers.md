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

Capability levels, in plain terms (operationalization milestone §18 — do not
use "secure", "protected", or "atomic" without the scope):

- **FULL conditional guarantee** — the external system itself refuses the
  mutation when its authoritative state no longer matches the authorized
  version. `atomicity: guaranteed` on the execution record is honest.
- **BEST-EFFORT** — the firewall re-verifies state immediately before the side
  effect and blocks on drift, but the compare→execute window stays open
  (recorded as `atomicity: not_guaranteed`).
- **UNSUPPORTED** — no conditional capability exists; policies requiring it
  deny (fail closed).
- **REQUIRES OPERATOR VERIFICATION** — the capability exists on the wire but
  its enforcement depends on the remote server actually honoring preconditions
  (see the checklist below). Until verified, treat as UNSUPPORTED.

| Provider / resource | Conditional execution | Mechanism | Condition evaluated by | Guarantee level |
|---|---|---|---|---|
| In-memory | SUPPORTED | `conditionalExecute()` — synchronous check-and-mutate, atomic in the event loop | the provider, inside the mutation | **FULL** (provider-enforced CAS) |
| GitHub `file` | SUPPORTED | Contents API update with the authorized blob `sha` (stale sha ⇒ 409/422, deleted ⇒ 404) | GitHub, inside the PUT | **FULL** (provider-enforced CAS) |
| GitHub other resources | UNSUPPORTED | no expected-revision parameter exists on those mutation endpoints | — | **UNSUPPORTED** (best-effort re-check only) |
| HTTP resource with `mutation` config | SUPPORTED | `If-Match: <authorized version>` on the configured mutation (412/409 by default ⇒ condition failed) | the HTTP server, inside the mutation request | **REQUIRES OPERATOR VERIFICATION** — FULL only after the checklist below passes; a server that ignores If-Match silently voids the CAS (demonstrated end to end by dogfood scenario 08 / S14 Case C) |
| HTTP resource without `mutation` config | UNSUPPORTED | — | — | **UNSUPPORTED** (best-effort re-check only) |

### Internal verification record (§27)

The matrix above is the *claim*; this table is the *evidence*. Anything not
listed here as verified is NOT verified — treat it as UNSUPPORTED until an
operator runs the checklist and appends a row.

| Provider / resource | Guarantee claimed | Verification status | Operator | Last verified | Evidence | Known limitations |
|---|---|---|---|---|---|---|
| In-memory | FULL | **VERIFIED** (automated, every CI run) | contract suite + continuous harness | 2026-09-06 | `test/contract/providers.test.ts`; harness scenarios 01–11 | reference provider; single-process event-loop atomicity |
| GitHub `file` | FULL | **VERIFIED** (live API, dedicated sandbox repo only) | dogfood harness scenarios 12 + 13 (live runs) | 2026-09-06 | CAS satisfied → mutation applied; blob-sha moved in CAS window → GitHub refused the stale write (409-class); two independent agents racing → exactly one lands (GitHub decides); no credentials in audit records. Deep campaign: dogfood S13. Continuous-dogfood adoption workflow runs the full agent loop (interference → stale refusal → autonomous recovery) against the same sandbox | GitHub other resources: UNSUPPORTED (no expected-revision parameter); 409 responses carry no current sha (`observed_version: null` — see INTERNAL_DOGFOOD_LOG FL-4) |
| HTTP sandbox server (`/broken` route) | — | **VERIFIED AS BOUNDARY DEMO** (controlled negative rig) | harness scenario 08 / dogfood S14 Case C | 2026-09-06 | server ignores If-Match → stale write lands while `atomicity=guaranteed` is recorded from the client vantage; audit carries the exact expected state (verification-duty evidence) | demonstrates why unverified endpoints void the CAS silently |
| HTTP sandbox server (correct ETag route) | FULL (for that server) | **VERIFIED** (controlled local server; checklist items 1–3, 5, 6) | harness scenario 07 / dogfood S14 | 2026-09-06 | If-Match match → applied; concurrent mutation → 412, no mutation; **redirected (307) requests still carry If-Match and the target still enforces it** (stale → 412 + no mutation, matching → applied — scenario 07 Case C) | applies ONLY to this server, not to arbitrary endpoints; item 4 (proxies/LBs stripping or normalizing preconditions) remains untestable locally and stays an operator duty for real network paths |
| Any real production HTTP endpoint | REQUIRES OPERATOR VERIFICATION | **NOT VERIFIED** (per-endpoint duty) | deploying operator | — | run the checklist below; append a row here with who/when/endpoint/evidence | unverified endpoint = treat as UNSUPPORTED, policy fails closed |

Executors plug into this via the optional `conditionalExecutionSupported()` / `conditionalExecute(intent, expectedState)` hooks on `ActionExecutor`; the firewall hands them the per-dependency authorized state captured at authorization time. See [atomic-effect-assurance.md](atomic-effect-assurance.md) for the full security model.

Every shipped provider passes the same contract suite (see `test/contract/providers.test.ts`).

## HTTP operator verification checklist (§19)

**`If-Match` sent ≠ server guaranteed to enforce it.** Sending the header is
the client's half of RFC 9110 preconditions; enforcing it is the server's
half, and a server that ignores the header provides NO atomicity — the stale
write lands while the client believes the condition was checked. Do not claim
RFC compliance merely because the header exists. Verify EVERY endpoint before
pointing an agent at it (the harness scenario `08-http-broken-server-boundary`
and `dogfood/scripts/sandbox-http-server.mjs` `/broken` endpoint provide the
negative test rig):

1. **ETag behavior** — GET returns a strong ETag (`"..."`, not `W/"..."`);
   the ETag changes whenever the semantic state you depend on changes; two
   consecutive GETs without mutation return the same ETag.
2. **If-Match enforcement** — PUT with `If-Match: <current ETag>` succeeds;
   PUT with `If-Match: "stale"` (an ETag you just invalidated by a prior PUT)
   is refused with **412** (or the configured `condition_failed_status`) and
   the resource is UNCHANGED (re-GET to confirm no side effect).
3. **Missing If-Match** — know what the server does with a PUT that carries
   no If-Match at all (RFC: apply unconditionally). If that is how humans edit
   the resource too, the ETag you authorized can be invalidated outside the
   firewall — that is fine; the CAS still protects YOUR mutation.
4. **Proxy behavior** — intermediaries must not strip `If-Match`/`ETag` or
   normalize representations so the ETag no longer matches; verify end to end
   through the REAL network path (load balancers, API gateways, caches).
5. **Redirect behavior** — 3xx responses must not lose the precondition on
   replay (the provider follows redirects; confirm the redirected request
   still carries `If-Match` and the target still enforces it).
6. **Application semantics** — the ETag must represent the state the
   CONDITION is about (mutating a different field must bump it), and a 412
   must be distinguishable from validation errors the server returns for
   other reasons.

Record the verification (who, when, endpoint, evidence) in your provider
inventory. Re-verify after any server/framework upgrade. If verification is
impossible, treat the resource as UNSUPPORTED and let the policy deny.

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
