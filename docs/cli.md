# CLI reference

Binary: `ssf` (installed with the package). All commands accept `--json` for machine-readable output on stdout. Human output goes to stdout, errors and logs to stderr.

## Exit codes (spec §66, deterministic)

| Code | Meaning |
|---|---|
| `0` | allowed / success / valid / healthy / audit chain intact |
| `1` | denied / stale / decision not allowed / policy invalid / audit tamper detected / policy test failed |
| `2` | operational error (missing config, unreadable file, unknown command) |

Global flags: `--config <path>` (default `./ssf.config.yaml`), `--json`.

## ssf init

```bash
ssf init
```

Writes a commented `ssf.config.yaml` template (observe mode, safe defaults, risk patterns, example policies). Refuses to overwrite (exit 2).

## ssf check

```bash
ssf check action.json [--json]
```

Dry-run validation of an action intent (a JSON `ActionIntentInput`). **No side effects**: nothing is executed externally; local decision + audit records are written for the trail.

```json
{
  "agent_id": "release-agent",
  "tool": "deploy",
  "operation": "deploy_production",
  "target": "production",
  "dependencies": [
    { "source": "http", "resource": "deployment", "resource_id": "production", "version": "v41" }
  ]
}
```

Output (human) follows the spec §53 layout: action, risk, mode, per-dependency observed/current state with `✓ ~ ⚠ ✗ ?` markers, decision, policy, reason. Exit code: `0` ALLOW, `1` otherwise. In observe mode the recorded decision is ALLOW with `would_have_decided` preserved — the exit code reflects the would-be decision.

## ssf policy validate

```bash
ssf policy validate [--config path] [--json]
```

Full schema + semantic validation before enforcement. Lists every violation with its config path. Exit `0` valid, `1` violations, `2` operational.

## ssf policy test

```bash
ssf policy test [--config path] [--json]
```

Runs the `policy_tests:` scenarios offline against the in-memory provider (deterministic; fixtures pin explicit versions). Output lists per-scenario pass/fail and a summary. Exit `0` all pass, `1` failures, `2` setup error.

## ssf state inspect

```bash
ssf state inspect <source:resource/resource_id> [--json]
```

Fetches and classifies current state, e.g. `github:pull_request/acme/api#42`. Shows version, observed_at, age, provenance, and metadata. Read-only.

## ssf action inspect

```bash
ssf action inspect <action_id> [--json]
```

Shows the latest decision for an action (rendered like `ssf check`), its escalation status, and its audit records.

## ssf audit

```bash
ssf audit [--limit N] [--verify] [--json]
```

Lists the audit ledger (newest first). `--verify` recomputes the full hash chain; a broken chain exits `1` with the first broken sequence number.

## ssf doctor

```bash
ssf doctor [--json]
```

Health checks: configuration loads and validates; audit chain integrity; storage opened and migrated during init; telemetry counters readable. Exit `0` healthy, `1` errors found, `2` operational.

## ssf version

```bash
ssf version [--json]
```

Prints package version, policy schema version, audit schema version.
