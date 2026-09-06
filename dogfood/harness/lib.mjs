/**
 * Harness-local helpers. Scenarios use ONLY the public SDK surface
 * (`stale-state-firewall`), exactly like a real internal consumer; the
 * fixtures library provides reset + honest executor plumbing.
 */

import { StaleStateFirewall, MemoryStore, InMemoryStateProvider, ManualClock } from 'stale-state-firewall';
import { freshDb } from '../fixtures/lib.mjs';

export { freshDb };

/**
 * Builds a firewall around a fresh in-memory world. `world` seeds realistic
 * development state (deploy config, CI pipeline, lockfile, deployment).
 */
export async function makeFirewall({
  policies,
  defaults = { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
  mode = 'enforce',
  source = 'memory',
} = {}) {
  const provider = new InMemoryStateProvider(source);
  const clock = new ManualClock('2026-09-06T09:00:00Z');
  const firewall = await StaleStateFirewall.create({
    config: {
      firewall: { mode, storage: { type: 'memory' } },
      defaults,
      actions: policies,
    },
    store: new MemoryStore(),
    providers: [provider],
    clock,
  });
  return { firewall, provider, clock, nowIso: clock.nowIso() };
}

/** The version an agent observed for a resource (public provider read). */
export function observeVersion(provider, resource, id) {
  const snap = provider.get(resource, id);
  if (!snap) throw new Error(`resource ${resource}/${id} not seeded`);
  return snap.version;
}

/** Marks a step list with a running log; scenarios return { steps }. */
export function steps() {
  const list = [];
  return {
    push(name, verdict, detail) {
      list.push({ name, verdict, detail });
      return list;
    },
    list,
  };
}
