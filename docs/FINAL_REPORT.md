# Stale-State Firewall — MVP Final Report

Per build specification §77. Everything below reflects the implemented, tested state of the repository — no claimed-but-unbuilt functionality.

---

## 1. Executive Summary

**What was built:** a production-oriented, deterministic agent-safety layer that prevents AI agents from taking consequential actions based on stale, outdated, incomplete, or invalid state. It ships as a TypeScript SDK (`StaleStateFirewall`), a CLI (`ssf`), three provider adapters (in-memory, generic HTTP, GitHub), SQLite-backed persistence with a tamper-evident audit ledger, a full policy engine with five freshness strategies, and a hardened enforcement boundary with replay protection, escalation holds, and execution-time re-verification.

**Repository:** `github.com/desurfofficial-ship-it/Stale-State-Firewall-` (branch `main`), 82 tracked files, ~7,600 lines of source plus ~3,100 lines of tests.

**Quality gates:** `npm test` (186/186), `npm run build`, `npm run lint`, `npm run typecheck`, `npm run check:hygiene` — all pass. The tree is free of unfinished-work markers and secret-shaped strings, and no LLM exists anywhere in the enforcement path.

> Red-team audit (post-MVP hardening): 15 adversarial attacks were reproduced and fixed; each is now a permanent regression test under `test/audit/`. See the audit section of the repository and docs/limitations.md for the honest guarantee boundaries.

## 2. Architecture

Modular monolith with strict layering (docs/architecture.md):

- `domain/` — typed model (StateSnapshot, StateDependency, ActionIntent, Decision, Policy, AuditEvent) and a 15-class typed error hierarchy.
- `engine/` — staleness classification, freshness strategies, precondition operators, policy resolution, deterministic decision composition, dependency evaluation, injectable clock.
- `providers/` — StateProvider implementations; conditional (304) verification where supported.
- `storage/` — FirewallStore: SQLite (`node:sqlite`, migrations, FK/CHECK constraints, WAL) and memory; no mutation path exists for audit records.
- `application/` — use cases: validate, execute (replay guard + TOCTOU re-check), revalidate, inspect.
- `sdk/` + `cli/` — public surfaces.
- `audit/`, `telemetry/`, `redaction/`, `logging/`, `config/` — cross-cutting infrastructure.

Dependencies point strictly downward; infrastructure is injected (`Clock`, `FirewallStore`, `StateProvider[]`), which is what makes the whole engine testable with a manual clock.

## 3. Domain Model

Core entities and relationships:

```
Agent --proposes--> ActionIntent --declares--> StateDependency --> ResourceReference
ActionIntent --validated-by--> FirewallPolicy (freshness, preconditions, outcomes, execution)
DependencyVerdict (per dependency: staleness class, observed vs current signals, preconditions)
DecisionRecord --references--> ActionIntent, policy, verdicts; --may carry--> ExecutionResult
Authorization (single-use, deadline, state fingerprint) --- Escalation (PENDING/APPROVED/REJECTED)
AuditRecord (hash-chained, append-only) --- StateSnapshot (provenance-mandatory)
```

Staleness classes: `FRESH / AGING / STALE / INVALID / UNKNOWN` with severity ordering `FRESH < AGING < STALE < UNKNOWN < INVALID`.

## 4. Security Model

Treated as a security boundary with an untrusted agent (docs/threat-model.md). Defenses implemented and tested: bypass-resistant `protect()` wrapper (duplicate tool identity refused; raw tool reachable only inside the executor closure), forged-freshness rejection (version/hash compared against provider truth; future timestamps → UNKNOWN), replay protection (single-use authorizations with deadlines; `ReplayDetectedError`/`ActionExpiredError`), dependency omission → UNKNOWN → fail closed, preconditions re-evaluated against current state (never the agent's claim), fail-closed provider failures, configuration hardening (`on_invalid: allow` forbidden; `UNKNOWN → allow` requires explicit acknowledgment and is impossible for CRITICAL), and a SHA-256 hash-chained audit ledger verified by `ssf audit --verify`.

## 5. Freshness Model

Five strategies (docs/freshness.md): `ttl` (with explicit AGING band and zero-default skew tolerance), `version` (equality against current; conditional-304 counts as fresh verification), `hash`, `preconditions` (11 strict operators against current metadata; missing fields fail closed), and `hybrid` (all components must pass; worst verdict wins). Cross-strategy drift detection: declared version/hash differing from current ⇒ INVALID regardless of strategy. Age uses provider server timestamps where available; future timestamps beyond skew tolerance are anomalies (UNKNOWN). All durations flow through an injected clock.

## 6. Decision Semantics

- **ALLOW** — safe to execute now; a single-use authorization is issued with a deadline (10s default for HIGH/CRITICAL, 60s otherwise).
- **DENY** — unsafe; nothing executes; the reason names the policy, the verdict evidence, and the risk.
- **REVALIDATE** — the observation basis is insufficient or expired; the firewall (inline in `execute()`) or the caller (in `check()`) must establish fresh state and recompute. Recomputation is a real re-evaluation, never auto-approval; residual UNKNOWN after revalidation fails closed (DENY).
- **ESCALATE** — held pending explicit human approval; approved execution still re-verifies freshness and preconditions.

Hard invariants enforced in the engine, unconfigurable: critical+UNKNOWN never ALLOW; INVALID never silently authorizes; OBSERVE mode preserves the would-be decision.

## 7. Provider Support

1. **In-memory** — full contract implementation for tests/examples/policy fixtures (version bumping, conditional verification, mutation log).
2. **Generic HTTP** — URL templates, `env()` header indirection, version extraction (header/JSON path; ETag/Last-Modified fallbacks), server-timestamp extraction (iso/epoch), metadata mapping, body hashing, If-None-Match 304 verification. A 304 attests "unchanged since ETag" only and never carries server-vouched metadata; the firewall forces a full fetch whenever preconditions are routed to the dependency, so preconditions are always evaluated against content the provider produced.
3. **GitHub** — pull_request (head SHA + review aggregation), issue, branch, ci_status (version signal = ETag, falling back to a `sha:state` composite so CI state transitions are detectable), deployment (version = `id:state` so status transitions are detectable), release; ETag conditional verification; rate-limit failures surfaced as typed errors.

Each provider passes the shared contract suite (run against a live local HTTP server and a simulated GitHub API).

## 8. CLI

`ssf init`, `ssf check` (dry-run; human output per §53 plus `--json`), `ssf policy validate`, `ssf policy test` (deterministic offline scenarios), `ssf state inspect`, `ssf action inspect`, `ssf audit [--verify]`, `ssf doctor`, `ssf version`. Deterministic exit codes: `0` allowed/success, `1` denied/policy decision, `2` operational error (verified by integration tests, including a live end-to-end check over a local HTTP provider).

## 9. SDK

```ts
const firewall = await StaleStateFirewall.create({ configPath: './ssf.config.yaml' });
const tool = firewall.protect({ name, run, toIntent, idempotency });
await tool.execute(input);                       // BlockedActionError carries the decision
await firewall.check(intent);                    // dry run
await firewall.execute(intent, executor, { actionId });
await firewall.resolveEscalation(id, { approved, by, note });
await firewall.executeApproved(id, intent, executor);
await firewall.inspectState(ref); firewall.getMetrics(); await firewall.verifyAudit();
```

Plus subpath exports for the three adapters and the full engine/config/storage surfaces for custom integrations. See docs/sdk.md.

## 10. Test Results

Exact commands and results on the final commit:

| Command | Result |
|---|---|
| `npm test` | **186/186 passed**, 16 files |
| `npm run build` | clean (tsc → `dist/`) |
| `npm run lint` | clean (typescript-eslint) |
| `npm run typecheck` | clean (strict, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`) |
| `npm run check:hygiene` | passed (no unfinished-work markers, no secret-shaped strings) |

Breakdown: unit (foundations, freshness, decision engine, policy resolution, config validation, audit/redaction/metrics on both stores) · integration (SDK flows incl. all §73 scenarios, escalation lifecycle, modes, SQLite persistence round-trip, protected tools, CLI incl. live HTTP end-to-end) · contract (memory/HTTP/GitHub) · kill (17 adversarial bypass attempts, §47) · race (TOCTOU interleavings, §45) · property (fast-check invariants, §46) · **red-team audit suite** (`test/audit/`: execution-boundary, state-spoofing, engine, storage/config attacks plus security properties).

## 11. Kill-Test Results

Every adversarial scenario fails closed: K1 stale cached state · K2 forged freshness · K3 fabricated future timestamps · K4 missing versions on CRITICAL · K5 provider outage mid-flow (executor never runs) · K6 replay of consumed authorization · K7 pending-escalation freeze · K8 clock manipulation (no implicit widening) · K9/K10 dependency omission · K11 partial state/preconditions on missing fields · K12 direct-invocation bypass (duplicate tool identity refused) · K13 `on_invalid: allow` rejected at load · K14 CRITICAL + `on_unknown: allow` rejected · K15 audit chain integrity (forged payload cannot match committed hash) · K16 observe-mode bypass (would-be decision preserved) · K17 forged precondition satisfaction.

## 12. Known Limitations

Honest boundaries (docs/limitations.md):

1. **Final TOCTOU gap** — unless the provider enforces compare-and-swap end to end, a mutation between the last re-fetch and the executor's effect is undetectable. Every execution records `atomicity: guaranteed | not_guaranteed` (generic default: not_guaranteed).
2. **Detection quality bounded by provider signals** — no version signal ⇒ TTL/preconditions only; unmapped semantic changes are invisible.
3. **GitHub review semantics** — standard latest-review-per-reviewer aggregation; org-specific approval policies are not modeled.
4. **Audit is tamper-evident, not tamper-proof** — an attacker with raw DB write access can forge records but not a consistent chain; verification detects divergence.
5. **Escalations are local** — no notification channel; integrate via SDK.
6. **`protect()` cannot delete other references** to a raw tool in application code; the safe path is enforced structurally, unwrapped references are a code-review concern.
7. **Unversioned TTL observations rely on the agent's claimed timestamp** — with no declared version/hash and an unchanged provider state, a fabricated recent `observed_at` is indistinguishable from a real one (out of guarantee boundary; server-stamped providers close the detectable half: state stamped newer than the claim is INVALID).
8. **The audit hash chain serializes writers through a single store transaction** — concurrent appends from one process are safe; concurrent appends from multiple OS processes on the same DB file are serialized by SQLite write locking, but verification is O(chain length).
9. **`matches` preconditions are compiled, not sandboxed** — malformed regexes are rejected at the intent boundary, but catastrophically backtracking patterns from an untrusted agent remain a denial-of-service surface; review agent-supplied patterns at the tool boundary.

## 13. Performance

The firewall sits on the hot path, so validation latency is measured continuously (`metrics.latency.validation`: count/avg/max) along with revalidation and execution latencies (spec §59). Measured against the in-memory provider (p50/p95/p99, 300 runs): `check()` with one version-strategy dependency 0.13/0.21/1.4 ms; `check()` with 10 dependencies 0.30/0.46/2.5 ms; full `execute()` (validate + authorization claim + TOCTOU re-fetch + executor) 0.17/0.25/0.6 ms. End-to-end latency is dominated by the provider fetch, which freshness semantics require and which the firewall never skips for the sake of speed (spec §60: safety wins). Policy evaluation involves no I/O and no LLM calls. `ssf audit --verify` recomputes the whole chain and is O(records) — 42 ms for ~3,000 records on a development machine.

## 14. Security Findings

- Secrets are accepted only from the environment (`env()` indirection for HTTP headers; `SSF_GITHUB_TOKEN`/`GITHUB_TOKEN` for GitHub); redaction runs before persistence/logging (arguments, execution output, audit payloads) and is depth-safe: subtrees beyond the traversal cap are redacted wholesale rather than passed through.
- Residual concerns, disclosed rather than hidden: the raw-DB-write attacker scenario (mitigated but not eliminated by the hash chain); the possibility of unwrapped tool references in application code; and reliance on provider-provided timestamps for TTL semantics when no server time is available (recorded in provenance).
- The `check:hygiene` gate scans the tree for unfinished-work markers and token-shaped strings on every run.
- Post-audit hardening (each with a permanent regression test): the execution gate now fails closed when every provider fetch fails during the pre-execution re-verification; the authorization single-use gate is an atomic store-level claim (concurrent executions of one action id cannot both pass); escalation approvals are bound to the originally approved operation/target/dependencies; replayed action ids can no longer rewrite the stored action record; `risk_defaults` configuration is actually wired into risk derivation; `on_stale: allow` now requires explicit acknowledgment like `on_unknown: allow`.

## 15. Recommended Next Milestone

Based on implementation evidence (not invented features): the single most valuable next step is **provider-side conditional execution support** — starting with the GitHub executor using the merge API's expected-head-SHA parameter — because the execution records and race tests show `atomicity: not_guaranteed` is the one remaining gap between "detect the drift" and "make the race impossible". Secondary, in order of evidence: a PostgreSQL store adapter (the `FirewallStore` interface and SQLite migrations already define the contract), and an OTLP telemetry exporter (counters and latency series already exist in-process).
