/* Isolated repro: require_conditional_execution with a legacy executor. */
import { StaleStateFirewall } from '../src/sdk/firewall.js';
import { InMemoryStateProvider } from '../src/providers/memory/in-memory-provider.js';
import { MemoryStore } from '../src/storage/memory/memory-store.js';
import { ManualClock } from '../src/engine/clock.js';

const clock = new ManualClock('2026-09-05T12:00:00Z');
const provider = new InMemoryStateProvider('memory');
const firewall = await StaleStateFirewall.create({
  config: {
    firewall: { mode: 'enforce', storage: { type: 'memory' } },
    defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
    actions: [
      {
        name: 'deploy-production',
        match: { operation: 'deploy*' },
        risk: 'CRITICAL',
        freshness: { strategy: 'version' },
        on_unknown: 'deny',
        execution: { deadline: '10s', require_conditional_execution: true },
      },
    ],
  },
  store: new MemoryStore(),
  providers: [provider],
  clock,
});

provider.put('deployment', 'prod', { status: 'healthy' }, clock.nowIso());
const versionX = provider.get('deployment', 'prod')!.version;

const outcome = await firewall.execute(
  {
    agent_id: 'repro',
    tool: 'deploy',
    operation: 'deploy_production',
    dependencies: [{ source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionX }],
  },
  { idempotency: 'non_idempotent', execute: async () => ({ success: true }) },
);

console.log('decision:', outcome.decision.decision);
console.log('reason:', outcome.decision.reason);
console.log('executed:', outcome.executed);
console.log('conditional_execution:', outcome.result?.conditional_execution);
console.log('policy_name:', outcome.decision.policy_name);
await firewall.close();
