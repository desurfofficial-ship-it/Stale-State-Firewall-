import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { createServer, type Server } from 'node:http';
import { writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * CLI integration tests (spec §66): deterministic exit codes
 *   0 = allowed / success, 1 = denied / policy decision, 2 = operational error.
 * `ssf check` must never have side effects beyond local audit records.
 */
describe('CLI', () => {
  let dir: string;
  let captured: { out: string[]; err: string[] };

  function cli(argv: string[]) {
    captured = { out: [], err: [] };
    return runCli({
      argv,
      cwd: dir,
      env: process.env,
      out: (t) => captured.out.push(t),
      err: (t) => captured.err.push(t),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ssf-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('version prints version info with exit 0', async () => {
    const result = await cli(['version']);
    expect(result.exitCode).toBe(0);
    expect(captured.out.join('')).toMatch(/ssf \d+\.\d+\.\d+/);
  });

  it('init creates a config template and refuses to clobber (exit 2)', async () => {
    const first = await cli(['init']);
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(dir, 'ssf.config.yaml'))).toBe(true);
    const second = await cli(['init']);
    expect(second.exitCode).toBe(2);
  });

  it('policy validate: valid config exits 0; invalid exits 1 with violations', async () => {
    await cli(['init']);
    const ok = await cli(['policy', 'validate']);
    expect(ok.exitCode).toBe(0);

    writeFileSync(join(dir, 'bad.yaml'), 'firewall:\n  mode: banana\n');
    const bad = await cli(['policy', 'validate', '--config', 'bad.yaml']);
    expect(bad.exitCode).toBe(1);
  });

  it('policy validate on a missing config exits 2 (operational error)', async () => {
    const result = await cli(['policy', 'validate']);
    expect(result.exitCode).toBe(2);
  });

  it('check: ALLOW exits 0; DENY exits 1; malformed input exits 2; json output is machine-readable', async () => {
    await cli(['init']);
    // Template policy: production-deploy requires version + healthy precondition.
    // The observe-mode template config has no providers configured, so the
    // dependency would be UNKNOWN -> DENY (exit 1). Build an action that
    // names no dependencies at all: under the template's deploy policy
    // (on_unknown: deny) the decision is DENY, exit code 1.
    writeFileSync(join(dir, 'action.json'), JSON.stringify({
      agent_id: 'cli-test',
      tool: 'deploy',
      operation: 'deploy_production',
      target: 'production',
      dependencies: [],
    }));
    const denied = await cli(['check', 'action.json']);
    expect(denied.exitCode).toBe(1);

    const deniedJson = await cli(['check', 'action.json', '--json']);
    expect(deniedJson.exitCode).toBe(1);
    const parsed = JSON.parse(captured.out.join(''));
    // The template ships in OBSERVE mode: the action proceeds, but the
    // would-be decision is preserved and drives the exit code.
    expect(parsed.decision).toBe('ALLOW');
    expect(parsed.would_have_decided).toBe('DENY');
    expect(parsed.policy_name).toBe('production-deploy');

    writeFileSync(join(dir, 'broken.json'), '{not json');
    const broken = await cli(['check', 'broken.json']);
    expect(broken.exitCode).toBe(2);
  });

  it('check on a missing action file exits 2', async () => {
    await cli(['init']);
    const result = await cli(['check', 'nope.json']);
    expect(result.exitCode).toBe(2);
  });

  it('policy test runs deterministic scenarios and reports failures (exit 0/1)', async () => {
    writeFileSync(join(dir, 'ssf.config.yaml'), `
firewall:
  mode: enforce
  storage:
    type: memory
defaults:
  on_unknown: deny
actions:
  - name: deploy-guard
    match:
      operation: "deploy*"
    risk: critical
    freshness:
      strategy: version
    on_unknown: deny

policy_tests:
  - name: no dependency declared -> deny
    action:
      agent_id: test-bot
      operation: deploy_production
      dependencies: []
    state: []
    expect_decision: DENY
  - name: matching current version -> allow
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
        metadata:
          status: healthy
    expect_decision: ALLOW
  - name: version drift -> deny
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
        version: v2
        metadata:
          status: healthy
    expect_decision: DENY
`);
    const result = await cli(['policy', 'test']);
    expect(result.exitCode).toBe(0);
    expect(captured.out.join('')).toContain('3/3 passed');
  });

  it('policy test failing scenario exits 1', async () => {
    writeFileSync(join(dir, 'ssf.config.yaml'), `
firewall:
  mode: enforce
  storage:
    type: memory
actions:
  - name: p
    match:
      operation: "x*"
    freshness:
      strategy: ttl
      max_age: 10s

policy_tests:
  - name: wrong expectation
    action:
      operation: x1
    state: []
    expect_decision: ALLOW
`);
    const result = await cli(['policy', 'test', '--json']);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(captured.out.join(''));
    expect(parsed.failed).toBe(1);
  });

  it('audit lists records and verifies the hash chain (exit 0)', async () => {
    await cli(['init']);
    writeFileSync(join(dir, 'action.json'), JSON.stringify({
      agent_id: 'cli-audit',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [],
    }));
    await cli(['check', 'action.json']);
    const result = await cli(['audit', '--verify', '--limit', '10', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(captured.out.join(''));
    expect(parsed.verification.ok).toBe(true);
    expect(parsed.records.length).toBeGreaterThanOrEqual(2);
  });

  it('doctor reports health with exit code reflecting failures', async () => {
    await cli(['init']);
    const result = await cli(['doctor', '--json']);
    expect([0, 1]).toContain(result.exitCode);
    const parsed = JSON.parse(captured.out.join(''));
    expect(parsed.checks.length).toBeGreaterThanOrEqual(2);
    expect(parsed.healthy).toBe(result.exitCode === 0);
  });

  it('state inspect without a provider for the source exits 2 with a clear message', async () => {
    await cli(['init']);
    const result = await cli(['state', 'inspect', 'github:pull_request/org/repo#42']);
    expect(result.exitCode).toBe(2);
    expect(captured.err.join('')).toMatch(/no state provider|unavailable|error/i);
  });

  it('unknown command exits 2 and prints help', async () => {
    const result = await cli(['nonsense']);
    expect(result.exitCode).toBe(2);
    expect(captured.err.join('')).toContain('unknown command');
  });

  it('renders human-readable decision output per spec §53', async () => {
    await cli(['init']);
    writeFileSync(join(dir, 'action.json'), JSON.stringify({
      agent_id: 'cli-human',
      tool: 'deploy',
      operation: 'deploy_production',
      dependencies: [],
    }));
    await cli(['check', 'action.json']);
    const text = captured.out.join('');
    expect(text).toContain('STALE-STATE FIREWALL');
    expect(text).toContain('Action:');
    expect(text).toContain('Decision:');
    expect(text).toContain('Policy:');
    expect(text).toContain('Reason:');
  });
});

describe('CLI end-to-end with a live local HTTP provider', () => {
  it('check reports ALLOW while state is unchanged and DENY after mutation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-cli3-'));
    let body = JSON.stringify({ status: 'healthy', env: 'production', revision: 'r1' });
    let etag = 'W/"r1"';
    const server: Server = createServer((req, res) => {
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const port = address.port;

    try {
      writeFileSync(join(dir, 'ssf.config.yaml'), `
firewall:
  mode: enforce
  storage:
    type: memory
providers:
  http:
    enabled: true
    resources:
      deployment:
        url: http://127.0.0.1:${port}/deployments/{id}
        version:
          source: header
          name: etag
        metadata_paths:
          status: $.status
actions:
  - name: deploy-guard
    match:
      operation: "deploy*"
    risk: critical
    freshness:
      strategy: version
`);
      writeFileSync(join(dir, 'action.json'), JSON.stringify({
        agent_id: 'cli-bot',
        tool: 'deploy',
        operation: 'deploy_production',
        target: 'production',
        dependencies: [
          {
            source: 'http',
            resource: 'deployment',
            resource_id: 'prod',
            version: 'W/"r1"',
            observed_at: new Date().toISOString(),
          },
        ],
      }));
      const out: string[] = [];
      const err: string[] = [];
      const run = (argv: string[]) =>
        runCli({
          argv,
          cwd: dir,
          env: process.env,
          out: (t) => out.push(t),
          err: (t) => err.push(t),
        });

      const allowed = await run(['check', 'action.json', '--json']);
      expect(allowed.exitCode).toBe(0);
      const allowedJson = JSON.parse(out.join(''));
      expect(allowedJson.decision).toBe('ALLOW');
      expect(allowedJson.verdicts[0].verified_fresh).toBe(true);

      // External mutation: the deployment moved under the agent's feet.
      etag = 'W/"r2"';
      body = JSON.stringify({ status: 'degraded', env: 'production', revision: 'r2' });
      out.length = 0;

      const denied = await run(['check', 'action.json', '--json']);
      expect(denied.exitCode).toBe(1);
      const deniedJson = JSON.parse(out.join(''));
      expect(deniedJson.decision).toBe('DENY');
      expect(deniedJson.invalid_dependencies).toContain('http:deployment/prod');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
