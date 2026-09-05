/**
 * Red-team audit: storage, redaction, and configuration attacks.
 *
 * ST1 a replay attempt with a swapped intent must not overwrite the stored
 *     action row (forensic preservation)
 * ST2 action arguments are redacted before persistence (documented contract)
 * ST3 execution output is redacted before persistence (documented contract)
 * ST4 redaction cannot be bypassed by nesting secrets deeper than the
 *     traversal depth cap
 * C1  risk_defaults configuration is honored at runtime, not silently ignored
 * C3  on_stale: "allow" requires explicit acknowledgment, like unknown-allow
 * C5  execution deadlines beyond the platform timer range are rejected
 *     fail-fast instead of collapsing to a 1ms timer
 */
import { describe, it, expect } from 'vitest';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { ManualClock } from '../../src/engine/clock.js';
import { redactDeep } from '../../src/redaction/redact.js';
import { validateConfig } from '../../src/config/validation.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';

const CLOCK_START = '2026-09-05T12:00:00Z';

async function build(config: FirewallRootConfigFile, store = new MemoryStore()) {
  const clock = new ManualClock(CLOCK_START);
  const provider = new InMemoryStateProvider('memory');
  const firewall = await StaleStateFirewall.create({
    config,
    store,
    providers: [provider],
    clock,
  });
  return { firewall, provider, clock, nowIso: clock.nowIso(), store };
}

const BASE_CONFIG: FirewallRootConfigFile = {
  firewall: { mode: 'enforce', storage: { type: 'memory' } },
  defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
  actions: [
    {
      name: 'merge-pr',
      match: { operation: 'merge*' },
      risk: 'HIGH',
      freshness: { strategy: 'version' },
      execution: { deadline: '10s' },
    },
  ],
};

describe('audit: storage, redaction, and configuration', () => {
  it('ST1 a rejected action followed by a same-id replay with a different intent preserves the original action row', async () => {
    const { firewall, provider, store } = await build(BASE_CONFIG);
    provider.put('pr', '5', { state: 'open' }, CLOCK_START);
    const version = provider.get('pr', '5')!.version;
    provider.mutate('pr', '5', { state: 'closed' }, CLOCK_START);

    // First submission with action id X is DENIED (stale version).
    const denied = await firewall.execute(
      {
        agent_id: 'bot',
        tool: 'github',
        operation: 'merge_pull_request',
        target: 'org/repo#5',
        dependencies: [{ source: 'memory', resource: 'pr', resource_id: '5', version }],
      },
      { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
      { actionId: 'act_forensic_1' },
    );
    expect(denied.decision.decision).toBe('DENY');

    provider.mutate('pr', '5', { state: 'open' }, CLOCK_START);

    // Replay the same action id with swapped semantics.
    const swapped = {
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      target: 'org/repo#999',
      dependencies: [{ source: 'memory', resource: 'pr', resource_id: '999', version: provider.get('pr', '999')?.version ?? 'vX' }],
    };
    await firewall.execute(swapped, { idempotency: 'non_idempotent', execute: async () => ({ success: true }) }, { actionId: 'act_forensic_1' });

    const stored = await store.getAction('act_forensic_1');
    expect(stored).not.toBeNull();
    expect(stored!.target).toBe('org/repo#5');
  });

  it('ST2 action arguments are redacted before persistence', async () => {
    const { firewall, store } = await build(BASE_CONFIG);
    const decision = await firewall.check({
      agent_id: 'bot',
      tool: 'github',
      operation: 'merge_pull_request',
      arguments: { api_key: 'sk-super-secret-value', comment: 'ship it' },
      dependencies: [],
    });
    const stored = await store.getAction(decision.action_id);
    expect(stored).not.toBeNull();
    expect(stored!.arguments['api_key']).toBe('[REDACTED]');
    expect(stored!.arguments['comment']).toBe('ship it');
  });

  it('ST3 execution output is redacted before persistence', async () => {
    const { firewall, provider, store } = await build(BASE_CONFIG);
    provider.put('pr', '9', { state: 'open' }, CLOCK_START);
    const outcome = await firewall.execute(
      {
        agent_id: 'bot',
        tool: 'github',
        operation: 'merge_pull_request',
        dependencies: [{ source: 'memory', resource: 'pr', resource_id: '9', version: provider.get('pr', '9')!.version }],
      },
      {
        idempotency: 'non_idempotent',
        execute: async () => ({ success: true, output: { merge_token: 'ghs_live_secret', status: 'merged' } }),
      },
    );
    expect(outcome.executed).toBe(true);
    const executions = await store.listExecutions(outcome.decision.action_id);
    expect(executions).toHaveLength(1);
    const output = executions[0]!.output as Record<string, unknown>;
    expect(output['merge_token']).toBe('[REDACTED]');
    expect(output['status']).toBe('merged');
  });

  it('ST4 redaction cannot be bypassed by nesting beyond the traversal cap', () => {
    let deep: Record<string, unknown> = { token: 'sk-nested-secret' };
    for (let i = 0; i < 40; i++) {
      deep = { child: deep };
    }
    const redacted = redactDeep(deep) as Record<string, unknown>;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('sk-nested-secret');
  });

  it('C1 risk_defaults rules drive derived risk for intents without an explicit risk level', async () => {
    const { firewall } = await build({
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
      risk_defaults: {
        rules: [{ match: 'delete*', risk: 'CRITICAL' }],
        default: 'LOW',
      },
      actions: [],
    });
    const decision = await firewall.check({
      agent_id: 'bot',
      tool: 'db',
      operation: 'delete_all_rows',
      dependencies: [],
    });
    expect(decision.risk_level).toBe('CRITICAL');
  });

  it('C3 on_stale allow is rejected without explicit acknowledgment', () => {
    const violations = validateConfig({
      firewall: { mode: 'enforce' },
      defaults: { on_stale: 'allow' },
    });
    expect(violations.some((v) => v.path === '$.defaults.on_stale')).toBe(true);

    const acknowledged = validateConfig({
      firewall: { mode: 'enforce', acknowledge_unknown_allow: true },
      defaults: { on_stale: 'allow' },
    });
    expect(acknowledged).toHaveLength(0);
  });

  it('C5 execution deadlines beyond the platform timer range are rejected fail-fast', async () => {
    const tooFar: FirewallRootConfigFile = {
      firewall: { mode: 'enforce', storage: { type: 'memory' } },
      actions: [
        {
          name: 'far-future',
          match: { operation: 'merge*' },
          freshness: { strategy: 'version' },
          execution: { deadline: '30d' },
        },
      ],
    };
    await expect(build(tooFar)).rejects.toThrow(/deadline/i);
  });
});
