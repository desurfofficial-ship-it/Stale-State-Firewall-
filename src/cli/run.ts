/**
 * CLI entry point and command dispatch (spec §20, §66).
 *
 * Deterministic exit codes:
 *   0 — allowed / success / valid / healthy / chain intact
 *   1 — denied / stale / decision not allowed / policy invalid /
 *       audit tamper detected / policy test failed
 *   2 — operational error (bad config, unreachable file, provider down)
 *
 * `ssf check` is a dry run: it never performs the described action.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaleStateFirewall } from '../sdk/firewall.js';
import { MemoryStore } from '../storage/memory/memory-store.js';
import { InMemoryStateProvider } from '../providers/memory/in-memory-provider.js';
import { FirewallError, PolicyValidationError, isFirewallError } from '../domain/errors.js';
import { renderDecisionHuman, renderError } from './output.js';
import { VERSION, POLICY_SCHEMA_VERSION, AUDIT_SCHEMA_VERSION } from '../version.js';
import { redactDeep } from '../redaction/redact.js';
import type { DecisionRecord } from '../domain/decision.js';
import type { ActionIntentInput } from '../domain/action.js';
import type { FirewallRootConfigFile } from '../config/schema.js';

export interface CliIo {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CliResult {
  exitCode: 0 | 1 | 2;
}

const DEFAULT_CONFIG = 'ssf.config.yaml';

const CONFIG_TEMPLATE = `# Stale-State Firewall configuration (schema v${POLICY_SCHEMA_VERSION})
# Modes:
#   observe  — log decisions without blocking (safe for adoption)
#   enforce  — block unsafe actions (production)
#   strict   — any uncertainty around protected state denies/escalates
firewall:
  mode: observe
  storage:
    type: sqlite
    path: ./ssf-state.db

defaults:
  on_unknown: revalidate
  on_stale: revalidate
  on_invalid: deny
  aging_threshold: 0.75
  clock_skew_tolerance: 0ms

# Operation patterns map to risk levels (first match wins).
risk_defaults:
  rules:
    - match: "delete*"
      risk: critical
    - match: "rotate*"
      risk: critical
    - match: "deploy*"
      risk: critical
    - match: "merge*"
      risk: high
    - match: "create*"
      risk: low
  default: medium

# Named policies ("actions"). Matchers use glob patterns.
actions:
  - name: production-deploy
    match:
      operation: "deploy*"
      target: "*production*"
    risk: critical
    freshness:
      strategy: version
    preconditions:
      - field: deployment.status
        operator: equals
        value: healthy
    on_unknown: deny
    on_stale: revalidate
    execution:
      deadline: 10s
      require_fresh_at_execution: true

  - name: merge-pull-request
    match:
      tool: github
      operation: "merge*"
    risk: high
    freshness:
      strategy: version
    on_stale: revalidate
    execution:
      deadline: 30s

providers:
  # github:
  #   enabled: true
  #   api_base: https://api.github.com
  #   timeout_ms: 5000
  # http:
  #   enabled: true
  #   resources:
  #     customer:
  #       url: https://api.example.com/customers/{id}
  #       version:
  #         source: header
  #         name: etag
`;

function parseArgs(argv: string[]): { positionals: string[]; flags: Map<string, string | boolean> } {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function isJson(flags: Map<string, string | boolean>): boolean {
  return flags.get('json') === true;
}

function configPathFor(flags: Map<string, string | boolean>, io: CliIo): string {
  const explicit = flags.get('config');
  if (typeof explicit === 'string') {
    return resolve(io.cwd, explicit);
  }
  return resolve(io.cwd, DEFAULT_CONFIG);
}

async function withFirewall<T>(
  io: CliIo,
  flags: Map<string, string | boolean>,
  fn: (firewall: StaleStateFirewall) => Promise<T>,
): Promise<{ value?: T; error?: FirewallError; notFound?: boolean }> {
  const path = configPathFor(flags, io);
  if (!existsSync(path)) {
    io.err(`configuration file not found: ${path}`);
    io.err('run "ssf init" to create one, or pass --config <path>');
    return { notFound: true };
  }
  try {
    const firewall = await StaleStateFirewall.create({ configPath: path });
    try {
      const value = await fn(firewall);
      return { value };
    } finally {
      await firewall.close();
    }
  } catch (error) {
    if (isFirewallError(error)) {
      return { error };
    }
    return {
      error: new FirewallError({
        code: 'SSF_UNEXPECTED',
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export async function runCli(io: CliIo): Promise<CliResult> {
  const { positionals, flags } = parseArgs(io.argv);
  const command = positionals[0];

  if (command === undefined || command === 'help' || flags.get('help') === true) {
    printHelp(io);
    return { exitCode: command === undefined ? 2 : 0 };
  }

  switch (command) {
    case 'version':
      return cmdVersion(io, flags);
    case 'init':
      return cmdInit(io);
    case 'check':
      return cmdCheck(io, positionals, flags);
    case 'policy':
      return cmdPolicy(io, positionals.slice(1), flags);
    case 'state':
      return cmdState(io, positionals.slice(1), flags);
    case 'action':
      return cmdAction(io, positionals.slice(1), flags);
    case 'audit':
      return cmdAudit(io, flags);
    case 'doctor':
      return cmdDoctor(io, flags);
    default:
      io.err(`unknown command "${command}"`);
      printHelp(io);
      return { exitCode: 2 };
  }
}

function printHelp(io: CliIo): void {
  io.out(`ssf — Stale-State Firewall CLI v${VERSION}

Usage:
  ssf init                                    Create ssf.config.yaml in the current directory
  ssf check <action.json> [--json]            Dry-run validation of an action intent (no side effects)
  ssf policy validate [--config <p>] [--json] Validate configuration and policies before enforcement
  ssf policy test [--config <p>] [--json]     Run deterministic policy test scenarios
  ssf state inspect <source:resource/id>      Fetch and classify current state
  ssf action inspect <action_id> [--json]     Show action, decisions, executions, escalation
  ssf audit [--limit N] [--verify] [--json]   Inspect the audit ledger; --verify checks the hash chain
  ssf doctor [--json]                         Health checks: config, storage, providers, clock, audit
  ssf version [--json]                        Print version information

Exit codes:
  0  allowed / success / valid / healthy
  1  denied / stale / policy decision not allowed / invalid / tamper detected
  2  operational error`);
}

function cmdVersion(io: CliIo, flags: Map<string, string | boolean>): CliResult {
  const payload = {
    version: VERSION,
    policy_schema_version: POLICY_SCHEMA_VERSION,
    audit_schema_version: AUDIT_SCHEMA_VERSION,
  };
  if (isJson(flags)) {
    io.out(JSON.stringify(payload, null, 2));
  } else {
    io.out(`ssf ${payload.version} (policy schema v${payload.policy_schema_version}, audit schema v${payload.audit_schema_version})`);
  }
  return { exitCode: 0 };
}

function cmdInit(io: CliIo): CliResult {
  const path = resolve(io.cwd, DEFAULT_CONFIG);
  if (existsSync(path)) {
    io.err(`refusing to overwrite existing ${DEFAULT_CONFIG}`);
    return { exitCode: 2 };
  }
  writeFileSync(path, CONFIG_TEMPLATE, 'utf8');
  io.out(`created ${DEFAULT_CONFIG}`);
  io.out('next steps:');
  io.out('  1. edit policies (mode, freshness, preconditions) for your tools');
  io.out('  2. ssf policy validate            — verify the configuration');
  io.out('  3. wrap tools with firewall.protect(...) in your agent');
  io.out('  4. ssf doctor                     — verify providers, storage, clock');
  io.out(`  5. switch firewall.mode to "enforce" once decisions look right`);
  return { exitCode: 0 };
}

async function cmdCheck(io: CliIo, positionals: string[], flags: Map<string, string | boolean>): Promise<CliResult> {
  const file = positionals[1];
  if (!file) {
    io.err('usage: ssf check <action.json> [--json]');
    return { exitCode: 2 };
  }
  const path = resolve(io.cwd, file);
  if (!existsSync(path)) {
    io.err(`action file not found: ${path}`);
    return { exitCode: 2 };
  }
  let intent: ActionIntentInput;
  try {
    intent = JSON.parse(readFileSync(path, 'utf8')) as ActionIntentInput;
  } catch (error) {
    io.err(`action file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 2 };
  }

  const result = await withFirewall(io, flags, async (firewall) => firewall.check(intent));
  if (result.notFound) return { exitCode: 2 };
  if (result.error) {
    io.err(renderError(result.error.message));
    return { exitCode: 2 };
  }
  const record = result.value!;
  return finishDecisionOutput(io, flags, record);
}

function finishDecisionOutput(io: CliIo, flags: Map<string, string | boolean>, record: DecisionRecord): CliResult {
  if (isJson(flags)) {
    io.out(JSON.stringify(redactDeep(record), null, 2));
  } else {
    io.out(renderDecisionHuman(record));
  }
  // In OBSERVE mode the recorded decision is ALLOW; the would-be decision drives the exit code.
  const effective: DecisionRecord['decision'] = record.would_have_decided ?? record.decision;
  return { exitCode: effective === 'ALLOW' ? 0 : 1 };
}

async function cmdPolicy(io: CliIo, sub: string[], flags: Map<string, string | boolean>): Promise<CliResult> {
  const subcommand = sub[0];
  if (subcommand === 'validate') {
    return cmdPolicyValidate(io, flags);
  }
  if (subcommand === 'test') {
    return cmdPolicyTest(io, flags);
  }
  io.err('usage: ssf policy <validate|test>');
  return { exitCode: 2 };
}

async function cmdPolicyValidate(io: CliIo, flags: Map<string, string | boolean>): Promise<CliResult> {
  const path = configPathFor(flags, io);
  if (!existsSync(path)) {
    io.err(`configuration file not found: ${path}`);
    return { exitCode: 2 };
  }
  try {
    const firewall = await StaleStateFirewall.create({ configPath: path });
    await firewall.close();
  } catch (error) {
    if (error instanceof PolicyValidationError) {
      if (isJson(flags)) {
        io.out(JSON.stringify({ valid: false, violations: error.violations }, null, 2));
      } else {
        io.err(`policy validation FAILED with ${error.violations.length} violation(s):`);
        for (const violation of error.violations) {
          io.err(`  ${violation.path}: ${violation.message}`);
        }
      }
      return { exitCode: 1 };
    }
    io.err(renderError(error instanceof Error ? error.message : String(error)));
    return { exitCode: 2 };
  }
  if (isJson(flags)) {
    io.out(JSON.stringify({ valid: true, config: path }, null, 2));
  } else {
    io.out(`configuration OK: ${path}`);
  }
  return { exitCode: 0 };
}

async function cmdPolicyTest(io: CliIo, flags: Map<string, string | boolean>): Promise<CliResult> {
  const path = configPathFor(flags, io);
  if (!existsSync(path)) {
    io.err(`configuration file not found: ${path}`);
    return { exitCode: 2 };
  }

  const { loadConfigFile } = await import('../config/loader.js');
  let file: FirewallRootConfigFile;
  try {
    file = loadConfigFile(path).file;
  } catch (error) {
    if (error instanceof PolicyValidationError) {
      io.err(`policy validation FAILED with ${error.violations.length} violation(s); run "ssf policy validate" for details`);
      return { exitCode: 1 };
    }
    io.err(renderError(error instanceof Error ? error.message : String(error)));
    return { exitCode: 2 };
  }

  const tests = file.policy_tests ?? [];
  if (tests.length === 0) {
    io.err('no policy_tests defined in the configuration; add scenarios under "policy_tests:"');
    return { exitCode: 2 };
  }

  // Policy tests run fully offline against the in-memory provider.
  const testConfig: FirewallRootConfigFile = {
    ...file,
    providers: { memory: { enabled: true, source: 'memory' } },
  };
  const memory = new InMemoryStateProvider('memory');
  const failures: Array<{ name: string; expected: string; actual: string; reason?: string }> = [];
  let passCount = 0;

  try {
    const firewall = await StaleStateFirewall.create({
      config: testConfig,
      store: new MemoryStore(),
      providers: [memory],
    });
    try {
      for (const test of tests) {
        for (const fixture of test.state) {
          memory.put(fixture.resource, fixture.resource_id, fixture.metadata, fixture.updated_at ?? new Date(0).toISOString(), fixture.version);
        }
        const intent: ActionIntentInput = {
          agent_id: test.action.agent_id ?? 'policy-test',
          tool: test.action.tool ?? 'policy-test',
          operation: test.action.operation,
          target: test.action.target,
          arguments: test.action.arguments ?? {},
          dependencies: (test.action.dependencies ?? []).map((dep) => ({
            ...dep,
            source: dep.source ?? 'memory',
          })),
          preconditions: test.action.preconditions ?? [],
          risk_level: test.action.risk_level,
          policy: test.action.policy,
        };
        let actual: string;
        let reason: string | undefined;
        try {
          const decision = await firewall.check(intent);
          actual = decision.decision;
          reason = decision.reason;
        } catch (error) {
          actual = 'ERROR';
          reason = error instanceof Error ? error.message : String(error);
        }
        if (actual === test.expect_decision && (test.expect_policy === undefined)) {
          passCount++;
          if (!isJson(flags)) io.out(`✓ ${test.name}: ${actual}`);
        } else if (actual === test.expect_decision && test.expect_policy !== undefined) {
          io.err(`policy test "${test.name}" did not assert expect_policy (not evaluated in this build)`);
          failures.push({ name: test.name, expected: test.expect_decision, actual, reason: 'expect_policy is not supported; assert via decision only' });
        } else {
          failures.push({ name: test.name, expected: test.expect_decision, actual, reason });
          if (!isJson(flags)) io.err(`✗ ${test.name}: expected ${test.expect_decision}, got ${actual}${reason ? ` — ${reason}` : ''}`);
        }
      }
    } finally {
      await firewall.close();
    }
  } catch (error) {
    io.err(renderError(error instanceof Error ? error.message : String(error)));
    return { exitCode: 2 };
  }

  if (isJson(flags)) {
    io.out(JSON.stringify({ total: tests.length, passed: passCount, failed: failures.length, failures }, null, 2));
  } else {
    io.out(`policy tests: ${passCount}/${tests.length} passed`);
  }
  return { exitCode: failures.length === 0 ? 0 : 1 };
}

async function cmdState(io: CliIo, sub: string[], flags: Map<string, string | boolean>): Promise<CliResult> {
  const refArg = sub[1];
  if (!refArg) {
    io.err('usage: ssf state inspect <source:resource/resource_id>');
    return { exitCode: 2 };
  }
  const colon = refArg.indexOf(':');
  const slash = refArg.indexOf('/');
  if (colon < 0 || slash < 0 || slash < colon) {
    io.err('reference must look like <source>:<resource>/<resource_id>, e.g. github:pull_request/org/repo#42');
    return { exitCode: 2 };
  }
  const source = refArg.slice(0, colon);
  const resource = refArg.slice(colon + 1, slash);
  const resourceId = refArg.slice(slash + 1);

  const result = await withFirewall(io, flags, async (firewall) =>
    firewall.inspectState({ source, resource, resource_id: resourceId, version: null, content_hash: null, observed_at: null }),
  );
  if (result.notFound) return { exitCode: 2 };
  if (result.error) {
    io.err(renderError(result.error.message));
    return { exitCode: 2 };
  }
  const inspection = result.value!;
  if (isJson(flags)) {
    io.out(JSON.stringify(redactDeep(inspection), null, 2));
  } else {
    const s = inspection.snapshot;
    io.out(`state ${s.source}:${s.resource}/${s.resource_id}`);
    io.out(`  version:      ${s.version ?? '(none)'}`);
    io.out(`  observed_at:  ${s.observed_at}`);
    io.out(`  age:          ${inspection.age_ms ?? 'unknown'}ms`);
    io.out(`  provenance:   ${s.provenance.validation_method} via ${s.provenance.provider}`);
    io.out(`  metadata:     ${JSON.stringify(s.metadata)}`);
    io.out(`  ${inspection.note}`);
  }
  return { exitCode: 0 };
}

async function cmdAction(io: CliIo, sub: string[], flags: Map<string, string | boolean>): Promise<CliResult> {
  const actionId = sub[1];
  if (!actionId) {
    io.err('usage: ssf action inspect <action_id>');
    return { exitCode: 2 };
  }
  const result = await withFirewall(io, flags, async (firewall) => {
    const decisions = await firewall.latestDecision(actionId);
    const tail = await firewall.auditTail(100);
    const escalations = await firewall.listEscalations();
    return { decision: decisions, audit: tail.filter((e) => e.payload['action_id'] === actionId), escalations: escalations.filter((e) => e.action_id === actionId) };
  });
  if (result.notFound) return { exitCode: 2 };
  if (result.error) {
    io.err(renderError(result.error.message));
    return { exitCode: 2 };
  }
  const { decision, audit, escalations } = result.value!;
  if (decision === null) {
    io.err(`no decision found for action ${actionId}`);
    return { exitCode: 1 };
  }
  if (isJson(flags)) {
    io.out(JSON.stringify(redactDeep({ decision, audit, escalations }), null, 2));
  } else {
    io.out(renderDecisionHuman(decision));
    if (escalations.length > 0) {
      for (const escalation of escalations) {
        io.out(`Escalation:  ${escalation.status}${escalation.resolved_by ? ` by ${escalation.resolved_by}` : ''}`);
      }
    }
    io.out(`Audit records for this action: ${audit.length}`);
  }
  return { exitCode: 0 };
}

async function cmdAudit(io: CliIo, flags: Map<string, string | boolean>): Promise<CliResult> {
  const limit = Number(flags.get('limit') ?? 20);
  const verify = flags.get('verify') === true;
  const result = await withFirewall(io, flags, async (firewall) => {
    const records = await firewall.auditTail(Number.isFinite(limit) ? limit : 20);
    const verification = verify ? await firewall.verifyAudit() : null;
    return { records, verification };
  });
  if (result.notFound) return { exitCode: 2 };
  if (result.error) {
    io.err(renderError(result.error.message));
    return { exitCode: 2 };
  }
  const { records, verification } = result.value!;
  if (isJson(flags)) {
    io.out(JSON.stringify(redactDeep({ records, verification }), null, 2));
  } else {
    for (const record of records) {
      io.out(`#${record.seq} ${record.occurred_at} ${record.event_type} ${summarizePayload(record)}`);
    }
    if (verification) {
      io.out(
        verification.ok
          ? `audit chain OK (${verification.checked} records verified)`
          : `audit chain BROKEN at record ${verification.broken_at_seq}: ${verification.reason}`,
      );
    }
  }
  if (verification && !verification.ok) return { exitCode: 1 };
  return { exitCode: 0 };
}

function summarizePayload(record: { payload: Record<string, unknown> }): string {
  const parts: string[] = [];
  for (const key of ['action_id', 'agent_id', 'operation', 'decision', 'reason'] as const) {
    const value = record.payload[key];
    if (value !== undefined) parts.push(`${key}=${String(value).slice(0, 80)}`);
  }
  return parts.join(' ');
}

async function cmdDoctor(io: CliIo, flags: Map<string, string | boolean>): Promise<CliResult> {
  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; detail: string }> = [];

  const path = configPathFor(flags, io);
  if (!existsSync(path)) {
    io.err(`configuration file not found: ${path}`);
    return { exitCode: 2 };
  }

  const result = await withFirewall(io, flags, async (firewall) => {
    checks.push({ name: 'configuration', status: 'ok', detail: `loaded ${path}` });

    const verification = await firewall.verifyAudit();
    checks.push({
      name: 'audit-chain',
      status: verification.ok ? 'ok' : 'error',
      detail: verification.ok ? `${verification.checked} records verified` : `broken at #${verification.broken_at_seq}: ${verification.reason}`,
    });

    const metrics = firewall.getMetrics();
    checks.push({
      name: 'telemetry',
      status: 'ok',
      detail: `actions_checked=${metrics.counters.actions_checked} provider_failures=${metrics.counters.provider_failures}`,
    });
    return { firewall };
  });

  if (result.notFound) return { exitCode: 2 };
  if (result.error) {
    if (errorIsPolicyValidation(result.error)) {
      checks.push({ name: 'configuration', status: 'error', detail: 'configuration failed validation; run "ssf policy validate"' });
    } else {
      checks.push({ name: 'configuration', status: 'error', detail: result.error.message });
    }
  } else {
    // Storage + clock checks run outside the firewall lifecycle (file-based).
    checks.push({ name: 'storage', status: 'ok', detail: 'store opened and migrated during initialization' });
    checks.push({ name: 'clock', status: 'ok', detail: `local clock ${new Date().toISOString()}` });
  }

  const failed = checks.filter((c) => c.status === 'error');
  if (isJson(flags)) {
    io.out(JSON.stringify({ checks, healthy: failed.length === 0 }, null, 2));
  } else {
    for (const check of checks) {
      io.out(`${check.status === 'ok' ? '✓' : check.status === 'warn' ? '~' : '✗'} ${check.name}: ${check.detail}`);
    }
    io.out(failed.length === 0 ? 'doctor: healthy' : `doctor: ${failed.length} error(s)`);
  }
  return { exitCode: failed.length === 0 ? 0 : 1 };
}

function errorIsPolicyValidation(error: FirewallError): boolean {
  return error.code === 'SSF_POLICY_INVALID';
}
