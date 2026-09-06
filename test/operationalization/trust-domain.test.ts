/**
 * Trust-domain separation tests (continuous-dogfood milestone §10).
 *
 * Each trust domain must have an independently appropriate authorization /
 * state store. The store is the replay / authorization / audit scope
 * (`action_id` is the primary key in every store table), so accidental
 * cross-environment sharing would mix audit trails and widen replay scope.
 * The firewall cannot restructure storage retroactively — but it must make
 * the store identity VISIBLE so a misconfiguration is detectable from
 * `ssf doctor` output alone. These tests pin that visibility.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StaleStateFirewall } from '../../src/index.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';

const BASE_CONFIG: FirewallRootConfigFile = {
  firewall: { mode: 'enforce' },
  defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
  actions: [
    { name: 'noop', match: { operation: 'noop' }, risk: 'LOW', freshness: { strategy: 'ttl', max_age: '60s' } },
  ],
};

describe('trust-domain visibility (§10)', () => {
  it('an explicit sqlite storage path is surfaced resolved and absolute', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssf-td-'));
    const dbPath = join(dir, 'env-a.db');
    const fw = await StaleStateFirewall.create({
      config: { ...BASE_CONFIG, firewall: { mode: 'enforce', storage: { type: 'sqlite', path: dbPath } } },
    });
    try {
      expect(fw.storeDescription).toContain(`sqlite file=${resolve(dbPath)}`);
      expect(fw.storeDescription).toContain('one store per trust domain');
    } finally {
      await fw.close();
    }
  });

  it('the default storage resolves to ./ssf-state.db — the documented default trap must stay visible', async () => {
    const fw = await StaleStateFirewall.create({
      config: { ...BASE_CONFIG, firewall: { mode: 'enforce' } },
    });
    try {
      expect(fw.storeDescription).toContain(`sqlite file=${resolve('ssf-state.db')}`);
    } finally {
      await fw.close();
    }
  });

  it('a memory store is labelled per-process so it cannot be mistaken for shared infrastructure', async () => {
    const fw = await StaleStateFirewall.create({
      config: { ...BASE_CONFIG, firewall: { mode: 'enforce', storage: { type: 'memory' } } },
    });
    try {
      expect(fw.storeDescription).toContain('per-process');
    } finally {
      await fw.close();
    }
  });

  it('an injected store is labelled as such (the operator owns its scoping)', async () => {
    const fw = await StaleStateFirewall.create({
      config: BASE_CONFIG,
      store: new MemoryStore(),
    });
    try {
      expect(fw.storeDescription).toContain('injected store instance');
    } finally {
      await fw.close();
    }
  });

  it('two firewalls with distinct sqlite paths have independent authorization scope', async () => {
    // The core §10 property: separate store files = separate trust domains.
    // Each deployment's store identity is visibly distinct, so a doctor run
    // in each environment immediately reveals whether they share a file.
    const dir = mkdtempSync(join(tmpdir(), 'ssf-td-'));
    const make = (name: string) => StaleStateFirewall.create({
      config: { ...BASE_CONFIG, firewall: { mode: 'enforce', storage: { type: 'sqlite', path: join(dir, name) } } },
    });
    const a = await make('domain-a.db');
    const b = await make('domain-b.db');
    try {
      expect(a.storeDescription).not.toEqual(b.storeDescription);
      expect(a.storeDescription).toContain('domain-a.db');
      expect(b.storeDescription).toContain('domain-b.db');
    } finally {
      await a.close();
      await b.close();
    }
  });
});
