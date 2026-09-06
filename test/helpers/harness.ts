import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { ManualClock } from '../../src/engine/clock.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';
import type { Clock } from '../../src/engine/clock.js';

export interface HarnessOptions {
  config?: Partial<FirewallRootConfigFile>;
  clock?: Clock;
}

export interface Harness {
  firewall: StaleStateFirewall;
  provider: InMemoryStateProvider;
  clock: ManualClock;
  nowIso: string;
}

export const ENFORCE_CONFIG: FirewallRootConfigFile = {
  firewall: { mode: 'enforce', storage: { type: 'memory' } },
  defaults: {
    on_unknown: 'revalidate',
    on_stale: 'revalidate',
    on_invalid: 'deny',
  },
  actions: [
    {
      name: 'deploy-production',
      match: { operation: 'deploy*' },
      risk: 'CRITICAL',
      freshness: { strategy: 'version' },
      preconditions: [{ field: 'status', operator: 'equals', value: 'healthy' }],
      on_unknown: 'deny',
      execution: { deadline: '10s', require_fresh_at_execution: true },
    },
    {
      name: 'merge-pr',
      match: { tool: 'github', operation: 'merge*' },
      risk: 'HIGH',
      freshness: { strategy: 'version' },
      execution: { deadline: '30s' },
    },
    {
      name: 'add-comment',
      match: { operation: 'add_comment' },
      risk: 'LOW',
      freshness: { strategy: 'ttl', max_age: '30s' },
    },
  ],
};

/** Builds a fully wired firewall + in-memory provider + manual clock. */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = options.clock instanceof ManualClock ? options.clock : new ManualClock('2026-09-05T12:00:00Z');
  const provider = new InMemoryStateProvider('memory');
  const config: FirewallRootConfigFile = {
    ...ENFORCE_CONFIG,
    ...options.config,
    firewall: { ...ENFORCE_CONFIG.firewall, ...(options.config?.firewall ?? {}) },
    defaults: { ...ENFORCE_CONFIG.defaults, ...(options.config?.defaults ?? {}) },
    actions: options.config?.actions ?? ENFORCE_CONFIG.actions,
  };
  const firewall = await StaleStateFirewall.create({
    config,
    store: new MemoryStore(),
    providers: [provider],
    clock,
  });
  return { firewall, provider, clock, nowIso: clock.nowIso() };
}

export function track(memory: InMemoryStateProvider, resource: string, id: string, metadata: Record<string, unknown>, atIso: string): void {
  memory.put(resource, id, metadata, atIso);
}
