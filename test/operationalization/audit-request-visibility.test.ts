/**
 * Audit request-visibility tests (sustained-dogfood milestone §19).
 *
 * An operator investigating an incident must be able to answer "what was
 * actually requested" from the persisted record alone — the audit ledger's
 * `action.proposed` payload carries tool/operation/dependencies but not the
 * intent arguments. The intent (with REDACTED arguments) is persisted at
 * validation time; these tests pin that it is retrievable through the
 * firewall's read-only `getAction` accessor (surfaced by
 * `ssf action inspect`), and that sensitive argument keys never survive
 * persistence unredacted.
 */

import { describe, expect, it } from 'vitest';
import { StaleStateFirewall } from '../../src/index.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { REDACTED } from '../../src/redaction/redact.js';
import type { FirewallRootConfigFile } from '../../src/config/schema.js';

const CONFIG: FirewallRootConfigFile = {
  firewall: { mode: 'enforce' },
  defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
  actions: [
    {
      name: 'update-deploy-config',
      match: { tool: 'ops', operation: 'update_deploy_config' },
      risk: 'HIGH',
      freshness: { strategy: 'version' },
    },
  ],
};

const INTENT = {
  agent_id: 'deploy-agent',
  tool: 'ops',
  operation: 'update_deploy_config',
  arguments: { path: 'configs/deploy.yaml', replicas: 3, api_token: 'super-secret-value' },
  dependencies: [
    { source: 'ops', resource: 'file', resource_id: 'configs/deploy.yaml', version: 'v1' },
  ],
};

function makeExecutor() {
  return {
    idempotency: 'non_idempotent' as const,
    atomicity: 'guaranteed' as const,
    execute: async () => ({ success: true }),
    conditionalExecutionSupported: () => true,
    conditionalExecute: async () => ({
      condition: 'satisfied' as const,
      success: true,
      output: 'v2',
    }),
  };
}

describe('audit request visibility (§19)', () => {
  it('the persisted action intent is retrievable with its (redacted) request arguments', async () => {
    const provider = new InMemoryStateProvider('ops');
    provider.put('file', 'configs/deploy.yaml', { content: 'replicas: 1' }, new Date().toISOString(), 'v1');
    const fw = await StaleStateFirewall.create({
      config: CONFIG,
      store: new MemoryStore(),
      providers: [provider],
    });
    try {
      await fw.execute(
        { ...INTENT, dependencies: [{ source: 'ops', resource: 'file', resource_id: 'configs/deploy.yaml', version: 'v1' }] },
        makeExecutor(),
        { actionId: 'visibility_1' },
      );

      const action = await fw.getAction('visibility_1');
      expect(action).not.toBeNull();
      expect(action?.operation).toBe('update_deploy_config');
      expect(action?.arguments).toEqual({
        path: 'configs/deploy.yaml',
        replicas: 3,
        api_token: REDACTED,
      });
      // The declared dependency versions must survive (what the agent claimed to have seen).
      expect(action?.dependencies?.[0]).toMatchObject({ source: 'ops', version: 'v1' });
    } finally {
      await fw.close();
    }
  });

  it('an unknown action id returns null instead of throwing (operator ergonomics)', async () => {
    const fw = await StaleStateFirewall.create({ config: CONFIG, store: new MemoryStore() });
    try {
      expect(await fw.getAction('no_such_action')).toBeNull();
    } finally {
      await fw.close();
    }
  });
});
