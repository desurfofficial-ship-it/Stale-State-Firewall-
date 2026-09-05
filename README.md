# Stale-State Firewall

**A deterministic safety boundary that stops AI agents from acting on stale, outdated, incomplete, or invalid state.**

AI agents read external systems (GitHub, Jira, databases, cloud APIs), reason about what they saw, and then act. Between the read (T1) and the action (T2), the world can change. The agent's reasoning may have been internally correct — the action is still unsafe.

Stale-State Firewall sits between the agent and its tools and enforces one rule:

> An agent may reason using old state, but it must not blindly act on old state when the freshness requirements of the action have been violated.

```
AI Agent
   ↓
Intent / Proposed Action
   ↓
STALE-STATE FIREWALL
   ↓  freshness + identity + version + preconditions
   ↓  revalidation
   ↓  policy decision
ALLOW / DENY / REVALIDATE / ESCALATE
   ↓
External System
```

Enforcement is **deterministic**: no LLM is consulted anywhere in the decision path. Same policy + same state + same action ⇒ same decision, every time.

---

## The problem, in one minute

1. Agent reads issue #123 — it is open and assigned.
2. Agent decides the issue should be closed.
3. Another engineer reopens work on it and changes the assignee.
4. Agent closes the issue using its old understanding.

Nothing in a typical agent stack catches this. Stale-State Firewall does:

- The agent **declares what it observed** (a *State Snapshot*: versions, hashes, timestamps).
- The firewall **fetches current state** from the source of truth.
- It **classifies** every dependency: `FRESH / AGING / STALE / INVALID / UNKNOWN`.
- It applies your **policy**: allow, deny, force revalidation, or escalate to a human.
- It records a **tamper-evident audit record** explaining exactly why.

## Architecture

- **TypeScript SDK** (`StaleStateFirewall`, `protect()`, `check()`, `execute()`) — wrap any tool.
- **CLI** (`ssf`) — dry-run actions, validate policies, inspect state, verify the audit ledger.
- **Providers** — in-memory (tests/examples), generic HTTP (ETag/Last-Modified/custom), GitHub (PRs, issues, branches, CI status, deployments, releases).
- **Storage** — SQLite (embedded, via `node:sqlite`) or in-memory; snapshots, actions, decisions, authorizations, escalations, and the append-only audit ledger.
- **Audit** — every decision produces a hash-chained, append-only record; `ssf audit --verify` detects tampering.

See [docs/architecture.md](docs/architecture.md).

## Installation

```bash
npm install stale-state-firewall
```

Requires Node.js >= 22.13 (uses the built-in `node:sqlite`).

## Quick start

### 1. Configure

```bash
npx ssf init        # writes ssf.config.yaml (starts in safe observe mode)
```

```yaml
firewall:
  mode: enforce            # observe | enforce | strict
  storage:
    type: sqlite
    path: ./ssf-state.db

defaults:
  on_unknown: revalidate   # never silently allow uncertainty
  on_stale: revalidate
  on_invalid: deny

actions:
  - name: production-deploy
    match:
      operation: "deploy*"
      target: "*production*"
    risk: critical
    freshness:
      strategy: version      # observed version must equal current version
    preconditions:
      - field: deployment.status
        operator: equals
        value: healthy
    on_unknown: deny
    execution:
      deadline: 10s
      require_fresh_at_execution: true
```

### 2. Wrap a tool

```ts
import { StaleStateFirewall } from 'stale-state-firewall';

const firewall = await StaleStateFirewall.create({ configPath: './ssf.config.yaml' });

const deploy = firewall.protect({
  name: 'deployer',
  run: async (input) => deployToProduction(input.env),
  toIntent: (input) => ({
    agent_id: 'release-agent',
    operation: 'deploy_production',
    target: input.env,
    dependencies: [
      {
        source: 'http',
        resource: 'deployment',
        resource_id: input.env,
        version: input.observedVersion,     // what the agent saw
      },
    ],
  }),
});

// Throws BlockedActionError (with the full decision) if state is not fresh.
await deploy.execute({ env: 'production', observedVersion: 'v41' });
```

The original tool is only reachable inside the firewall's executor closure — it never runs before a decision.

### 3. Dry-run from the CLI

```bash
ssf check action.json            # human-readable decision
ssf check action.json --json     # machine-readable
```

```text
STALE-STATE FIREWALL
Action:      deploy_production production
Risk:        CRITICAL
Dependencies:
  ✗ http:deployment/production
      observed version: v41
      current  version: v42
      state changed after observation: observed version "v41" but current version is "v42"
Decision:    DENY
Policy:      production-deploy
Reason:
  policy "production-deploy": required dependency is INVALID — ...
```

## What it looks like when it works

Run the shipped examples:

```bash
npm run example:github     # merge blocked after a new commit lands
npm run example:database   # delete blocked after a customer is suspended
npm run example:http       # ETag drift detected against a live local API
```

Each example prints the observation, the external mutation, the firewall decision, and the reasons — the core product loop from [spec §73]: observe → external change → stale reasoning → detect → block/revalidate → safe proceed.

## Core concepts

| Concept | Meaning |
|---|---|
| **State Snapshot** | The precise slice of external state an agent relied on (source, resource, id, version, hash, observed_at, provenance). |
| **Action Intent** | A consequential action plus its declared dependencies, preconditions, and risk. |
| **Freshness strategy** | `ttl`, `version`, `hash`, `preconditions`, or `hybrid` (all of the above). |
| **Staleness classes** | `FRESH`, `AGING`, `STALE`, `INVALID`, `UNKNOWN` — never a boolean. |
| **Decisions** | `ALLOW`, `DENY`, `REVALIDATE`, `ESCALATE` — never a silent execution. |
| **Modes** | `observe` (log only), `enforce` (block), `strict` (any uncertainty denies). |

## Policy example

```yaml
actions:
  - name: destructive-action
    match:
      operation: "delete*"
    risk: critical
    freshness:
      strategy: hybrid
      max_age: 5s
      hybrid: { ttl: true, version: true, preconditions: true }
    preconditions:
      - field: environment
        operator: equals
        value: staging
    on_stale: revalidate
    on_unknown: deny
    on_invalid: deny
```

Policies are validated before enforcement: unknown fields, dangerous defaults (`UNKNOWN → allow` needs explicit acknowledgment; `INVALID → allow` is forbidden), contradictory rules, and impossible conditions are all rejected by `ssf policy validate`. See [docs/policies.md](docs/policies.md) and [docs/freshness.md](docs/freshness.md).

## Security model

The firewall treats the agent as untrusted. It defends against forged observation metadata, replayed authorizations, dependency omission, direct tool bypass, provider outages disguised as success, and configuration weakening. Guarantees are stated precisely — including what the firewall *cannot* guarantee (see [docs/threat-model.md](docs/threat-model.md) and [docs/limitations.md](docs/limitations.md)).

## CLI

`ssf init` · `ssf check` · `ssf policy validate` · `ssf policy test` · `ssf state inspect` · `ssf action inspect` · `ssf audit [--verify]` · `ssf doctor` · `ssf version`

Exit codes are deterministic: `0` allowed/success, `1` denied/policy decision, `2` operational error. See [docs/cli.md](docs/cli.md).

## Testing

```bash
npm test           # 186 tests: unit, integration, contract, kill, race, property, red-team audit
npm run build
npm run lint
npm run typecheck
npm run check:hygiene
```

The kill suite (docs/testing.md) tries to force the firewall into allowing an action it should reject: forged versions, fabricated timestamps, replay, provider outages, dependency omission, audit tampering, configuration attacks. All fail closed.

## Documentation

- [Architecture](docs/architecture.md)
- [Freshness model](docs/freshness.md)
- [Policies](docs/policies.md)
- [Providers](docs/providers.md)
- [Revalidation](docs/revalidation.md)
- [Threat model](docs/threat-model.md)
- [CLI reference](docs/cli.md)
- [SDK reference](docs/sdk.md)
- [Testing strategy](docs/testing.md)
- [Limitations](docs/limitations.md)

## Roadmap

The MVP proves the core safety primitive end to end. Natural next steps, based on the current implementation (not invented features): PostgreSQL storage adapter, Python SDK, a hosted read-only dashboard over the local audit ledger, and an OTLP telemetry exporter. None of these are required for enforcement.

## License

MIT
