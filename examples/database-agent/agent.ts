/**
 * Example: Database Agent (spec §50).
 *
 * Scenario: an agent reads customer.status = active and decides to delete
 * the account. Before execution, support suspends the customer. The
 * firewall re-verifies the customer record immediately before the side
 * effect and blocks the deletion.
 *
 * Run: npm run build && node examples/database-agent/agent.ts
 */

import {
  StaleStateFirewall,
  InMemoryStateProvider,
  MemoryStore,
  ManualClock,
  BlockedActionError,
  type FirewallRootConfigFile,
} from 'stale-state-firewall';

const clock = new ManualClock('2026-09-05T12:00:00Z');
const database = new InMemoryStateProvider('database');

const config: FirewallRootConfigFile = {
  firewall: { mode: 'enforce', storage: { type: 'memory' } },
  risk_defaults: {
    rules: [{ match: 'delete*', risk: 'CRITICAL' }],
    default: 'MEDIUM',
  },
  actions: [
    {
      name: 'delete-customer',
      match: { tool: 'crm', operation: 'delete*' },
      risk: 'CRITICAL',
      freshness: { strategy: 'version' },
      preconditions: [{ field: 'status', operator: 'equals', value: 'active' }],
      on_unknown: 'deny',
      execution: { deadline: '10s', require_fresh_at_execution: true },
    },
  ],
};

const firewall = await StaleStateFirewall.create({
  config,
  store: new MemoryStore(),
  providers: [database],
  clock,
});

database.put('customer', 'cust_1001', { status: 'active', plan: 'enterprise' }, clock.nowIso());

const customer = database.get('customer', 'cust_1001')!;
console.log(`agent observes customer cust_1001: status=${customer.metadata['status']}`);
console.log('agent decides: delete customer (e.g., GDPR request)');

// --- Support suspends the account while the agent is thinking ---------------
database.mutate('customer', 'cust_1001', { status: 'suspended' }, clock.nowIso());
console.log('support suspends the customer (billing dispute)');

const deleteTool = firewall.protect({
  name: 'crm',
  run: async (input: { customerId: string }) => {
    console.log(`-> deleted ${input.customerId}`);
    return { deleted: true };
  },
  toIntent: (input: { customerId: string; observedVersion: string }) => ({
    agent_id: 'crm-agent',
    operation: 'delete_customer',
    target: input.customerId,
    dependencies: [
      {
        source: 'database',
        resource: 'customer',
        resource_id: input.customerId,
        version: input.observedVersion,
        metadata: { status: 'active' },
      },
    ],
  }),
  idempotency: 'non_idempotent',
});

try {
  await deleteTool.execute({ customerId: 'cust_1001', observedVersion: customer.version });
  console.log('UNEXPECTED: deletion went through on stale state');
} catch (error) {
  if (error instanceof BlockedActionError) {
    console.log(`firewall: ${error.decision.decision} — ${error.decision.reason}`);
    console.log(`  policy: ${error.decision.policy_name}, risk: ${error.decision.risk_level}`);
  } else {
    throw error;
  }
}

const metrics = firewall.getMetrics();
console.log(`metrics: denied=${metrics.counters.actions_denied} stale_events=${metrics.counters.stale_state_events}`);

await firewall.close();
