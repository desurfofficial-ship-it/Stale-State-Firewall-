# Limitations

Stated precisely, because credibility depends on not overclaiming (spec §72).

## What the firewall guarantees

- No protected action executes before a decision is reached (structural, by construction of `protect()`/`execute()`).
- CRITICAL actions never proceed on UNKNOWN state, regardless of configuration.
- Proven state changes (INVALID) never silently authorize the original action.
- Revalidation recomputes the decision from current state; refreshing never auto-approves.
- Policy evaluation is deterministic and free of LLM calls.
- Authorizations are single-use and deadline-bounded; replay is detected.
- Audit records are append-only and tamper-evident (hash chain + verification).

## What is best-effort, and why

### The final TOCTOU gap — closed where providers support conditional execution, best-effort elsewhere

The firewall re-fetches state immediately before the side effect and blocks on drift. But a pre-execution read cannot close the **compare → execute** window: a mutation that lands after the final fetch and before the executor's effect is invisible to the re-check. Every execution record states `atomicity: guaranteed | not_guaranteed`.

Where the provider supports **conditional execution** (milestone: atomic effect assurance — see [atomic-effect-assurance.md](atomic-effect-assurance.md)), this gap is closed by the external system itself: the mutation carries the authorized version (GitHub Contents API blob sha, HTTP `If-Match`, the in-memory provider's atomic CAS) and the provider refuses the operation when its authoritative state no longer matches. The execution record then states `atomicity: guaranteed` with `conditional_execution: satisfied`, and a provider refusal is recorded as `execution.condition_failed` — never as success, never silently retried.

Where the provider does **not** support it (GitHub resources other than `file`, HTTP endpoints without a verified `If-Match` mutation), the residual window remains and is documented rather than hidden: those executions stay on the best-effort path with `atomicity: not_guaranteed`. Policies can require the stronger guarantee (`execution.require_conditional_execution: true`), which fails closed (default deny) when the capability is unavailable. The firewall does **not** claim universal atomicity across arbitrary external systems.

### Staleness detection quality is bounded by provider signals

- If a provider exposes no version/hash signal, only TTL and precondition semantics apply; a semantic change that bumps no version and shifts no mapped field cannot be detected.
- TTL freshness depends on timestamps. Providers that do not expose server timestamps leave the firewall with client-clock ages (recorded in provenance as `time_source: client`). When the agent declares NO version and NO content hash, the claimed `observed_at` cannot be verified at all: a fabricated "just now" claim on an unchanged resource is indistinguishable from an honest one. Server-stamped providers close the detectable half (state stamped newer than the claim → INVALID), but an unchanged world plus a lying agent with no comparable signal is out of guarantee boundary. Require `version`/`hash` strategies for untrusted agents.
- A conditional (304) verification attests "unchanged since ETag" only. It never carries server-vouched field values, so the firewall forces a full fetch whenever preconditions are routed to the dependency — preconditions are never evaluated against agent-supplied metadata.
- `review_status` aggregation for GitHub PRs follows the standard "latest review per reviewer" rule; org-specific approval policies (CODEOWNERS weightings, dismissals on new commits) are not modeled — model them with preconditions where the API exposes the inputs.

### Preconditions are only as good as the mapped metadata

Preconditions evaluate fields the provider surfaces in `metadata`. For the HTTP provider that means the fields operators map via `metadata_paths`. Fields that are absent fail closed (INVALID) — safe, but noisy if mappings are incomplete.

## Explicit non-guarantees

- **Not** "prevents every race condition". With provider-side conditional execution it eliminates the authorization→execution race for the conditioned resources; everywhere else it narrows the TOCTOU window and detects drift at execution time. See [atomic-effect-assurance.md](atomic-effect-assurance.md) for the exact guarantee boundary.
- **Not** "guarantees consistency across all external systems". The firewall enforces consistency exactly to the extent the underlying provider and execution mechanism expose it.
- **Not** protection against a compromised host or process (see threat-model assumptions).
- **Not** protection against a developer deliberately keeping and calling an unwrapped reference to a raw tool. `protect()` makes the safe path the easy path and refuses duplicate registrations, but it cannot delete other references in your code.
- **Not** protection against an executor that lies about conditional enforcement or discards the authorized expected state it was handed. The conditional path is fail-closed for declared-but-unenforceable capability, and the audit records what was enforced — but a hostile executor that ignores the binding and calls the API directly is outside the model (the executor is the operator's code; see threat-model assumptions).

## MVP boundaries (spec §61)

Deliberately not built yet: SaaS dashboard, billing/teams/SSO, additional SDKs (Python/Go), Kubernetes operator, multi-region control plane, AI-assisted policy generation. Storage is SQLite/embedded; a PostgreSQL adapter is a natural next milestone. Telemetry is local in-process; export (OTLP) is future work.

## Operational notes

- SQLite storage uses `node:sqlite` (Node >= 22.13). WAL mode is enabled for file-backed databases.
- The audit chain is tamper-**evident**, not tamper-**proof**: an attacker with raw database write access can forge records, but cannot forge a consistent chain without recomputing all subsequent hashes — which `ssf audit --verify` detects. For stronger guarantees, ship the ledger tail to append-only external storage. Appends are serialized inside a single immediate transaction; concurrent writers across processes on the same database file are serialized by SQLite write locking. Verification recomputes the entire chain (O(records)).
- The single-use execution gate is an atomic store-level claim: two concurrent executions of one action id cannot both pass, even when both reach the gate before either lands. After a pre-execution TOCTOU denial the authorization stays live until its deadline — retries with the same action id are refused (use a new action id to re-attempt); this is the conservative direction.
- Escalation approvals bind to the approved semantics (tool, operation, target, declared dependencies). Submitting a different action under an approved action id is refused.
- Escalations are held in local storage; there is no built-in notification channel. Integrate the SDK calls into your paging tooling.
