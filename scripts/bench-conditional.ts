/**
 * Milestone §28: performance benchmark — legacy pre-execution verification
 * (TOCTOU re-check fetch + compare) vs provider-enforced conditional
 * execution (no extra verification fetch).
 *
 * Run: npm run build && node scripts/bench-conditional.ts
 */

import {
  StaleStateFirewall,
  InMemoryStateProvider,
  MemoryStore,
  ManualClock,
  type ActionExecutor,
  type FirewallRootConfigFile,
} from 'stale-state-firewall';

const REF = 'memory:deployment/prod';
const CONFIG: FirewallRootConfigFile = {
  firewall: { mode: 'enforce', storage: { type: 'memory' } },
  defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
  actions: [
    {
      name: 'deploy-production',
      match: { operation: 'deploy*' },
      risk: 'CRITICAL',
      freshness: { strategy: 'version' },
      on_unknown: 'deny',
      execution: { deadline: '10s', require_fresh_at_execution: true },
    },
  ],
};

function legacyExecutor(): ActionExecutor {
  return { idempotency: 'non_idempotent', execute: async () => ({ success: true }) };
}

function conditionalExecutor(provider: InMemoryStateProvider): ActionExecutor {
  return {
    idempotency: 'non_idempotent',
    conditionalExecutionSupported: () => true,
    async conditionalExecute(_intent, expectedState) {
      const entry = expectedState.find((e) => e.ref === REF);
      if (!entry || entry.version === null) {
        return { condition: 'unavailable' };
      }
      const result = await provider.conditionalExecute({
        ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
        expected_version: entry.version,
        changes: { status: 'deployed' },
      });
      return result.outcome === 'executed'
        ? { condition: 'satisfied', success: true, output: { version: result.version } }
        : { condition: 'failed', observed_version: result.current_version };
    },
    execute: async () => ({ success: true }),
  };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

async function bench(
  label: string,
  mode: 'legacy' | 'conditional',
  iterations: number,
): Promise<{ label: string; p50: number; p95: number; p99: number; mean: number }> {
  const clock = new ManualClock('2026-09-05T12:00:00Z');
  const provider = new InMemoryStateProvider('memory');
  const firewall = await StaleStateFirewall.create({
    config: CONFIG,
    store: new MemoryStore(),
    providers: [provider],
    clock,
  });

  // Warmup.
  for (let i = 0; i < 50; i++) {
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const version = provider.get('deployment', 'prod')!.version;
    await firewall.execute(
      {
        agent_id: 'bench',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
      },
      mode === 'legacy' ? legacyExecutor() : conditionalExecutor(provider),
    );
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
    const version = provider.get('deployment', 'prod')!.version;
    const start = performance.now();
    await firewall.execute(
      {
        agent_id: 'bench',
        tool: 'deploy',
        operation: 'deploy_production',
        dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version }],
      },
      mode === 'legacy' ? legacyExecutor() : conditionalExecutor(provider),
    );
    samples.push(performance.now() - start);
  }
  await firewall.close();

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const stats = { label, p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99), mean };
  console.log(
    `${label.padEnd(34)} p50=${stats.p50.toFixed(3)}ms  p95=${stats.p95.toFixed(3)}ms  p99=${stats.p99.toFixed(3)}ms  mean=${mean.toFixed(3)}ms  n=${iterations}`,
  );
  return stats;
}

const N = 2000;
console.log(`\n=== Conditional execution benchmark (in-memory provider, ${N} iterations) ===`);
const legacy = await bench('legacy (re-check fetch + CAS-free)', 'legacy', N);
const conditional = await bench('conditional (provider-enforced CAS)', 'conditional', N);
console.log(
  `\nDelta: conditional p50 ${((conditional.p50 / legacy.p50 - 1) * 100).toFixed(1)}% vs legacy ` +
    `(conditional removes one verification fetch; legacy keeps a redundant read whose result can be raced).`,
);
