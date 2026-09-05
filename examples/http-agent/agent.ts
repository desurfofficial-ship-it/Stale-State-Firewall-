/**
 * Example: HTTP Agent (spec §17, §19).
 *
 * Scenario: an agent works against a generic HTTP API that exposes an
 * ETag. It observes a deployment record, the API changes it, and the
 * agent's next action is blocked until it re-observes. Demonstrates the
 * generic HTTP provider with ETag versioning and conditional (304)
 * verification.
 *
 * Run: npm run build && node examples/http-agent/agent.ts
 */

import { createServer, type Server } from 'node:http';
import {
  StaleStateFirewall,
  MemoryStore,
  ManualClock,
  BlockedActionError,
  type FirewallRootConfigFile,
} from 'stale-state-firewall';

// --- A tiny deployment API with ETag versioning ------------------------------
const clock = new ManualClock('2026-09-05T12:00:00Z');
let deployment = { status: 'healthy', environment: 'production', revision: 'r1', updated_at: clock.nowIso() };
let etag = 'W/"dep-r1"';

const server: Server = createServer((req, res) => {
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', etag });
  res.end(JSON.stringify(deployment));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('no port');
const port = address.port;

const config: FirewallRootConfigFile = {
  firewall: { mode: 'enforce', storage: { type: 'memory' } },
  providers: {
    http: {
      enabled: true,
      resources: {
        deployment: {
          url: `http://127.0.0.1:${port}/deployments/{id}`,
          version: { source: 'header', name: 'etag' },
          metadata_paths: { status: '$.status', environment: '$.environment' },
        },
      },
    },
  },
  actions: [
    {
      name: 'scale-deployment',
      match: { tool: 'ops', operation: 'scale*' },
      risk: 'HIGH',
      freshness: { strategy: 'version' },
      preconditions: [{ field: 'status', operator: 'equals', value: 'healthy' }],
    },
  ],
};

const firewall = await StaleStateFirewall.create({ config, store: new MemoryStore(), clock });

// --- Inspect current state through the firewall (ssf state inspect parity) ---
const inspection = await firewall.inspectState({
  source: 'http',
  resource: 'deployment',
  resource_id: 'prod',
  version: null,
  content_hash: null,
  observed_at: null,
});
console.log(`current deployment state: status=${inspection.snapshot.metadata['status']} version=${inspection.snapshot.version}`);
console.log(inspection.note);

const scaleTool = firewall.protect({
  name: 'ops',
  run: async (input: { replicas: number }) => {
    console.log(`-> scaled to ${input.replicas} replicas`);
    return { scaled: true };
  },
  toIntent: (input: { replicas: number; observedVersion: string }) => ({
    agent_id: 'ops-agent',
    operation: 'scale_deployment',
    target: 'prod',
    dependencies: [
      {
        source: 'http',
        resource: 'deployment',
        resource_id: 'prod',
        version: input.observedVersion,
      },
    ],
  }),
  idempotency: 'non_idempotent',
});

// --- Action on fresh state is allowed ----------------------------------------
const currentEtag = inspection.snapshot.version ?? etag;
await scaleTool.execute({ replicas: 5, observedVersion: currentEtag });
console.log('scale allowed on fresh state (conditional 304 verified the world is unchanged)');

// --- The deployment degrades; the agent's cached version is now stale --------
deployment = { ...deployment, status: 'degraded', revision: 'r2' };
etag = 'W/"dep-r2"';
console.log('deployment degrades (revision r2)');

try {
  await scaleTool.execute({ replicas: 8, observedVersion: currentEtag });
  console.log('UNEXPECTED: scale went through on stale state');
} catch (error) {
  if (error instanceof BlockedActionError) {
    const v = error.decision.verdicts[0];
    console.log(`firewall: ${error.decision.decision} — ${error.decision.reason}`);
    if (v) console.log(`  observed: ${v.observed_version}  current: ${v.current_version}`);
  } else {
    throw error;
  }
}

await firewall.close();
await new Promise<void>((resolve) => server.close(() => resolve()));
