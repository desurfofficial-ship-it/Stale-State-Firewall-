/**
 * Red-team audit: state spoofing and provider trust attacks.
 *
 * S1  HTTP conditional-304 snapshots adopt agent-supplied metadata, so
 *     fabricated precondition inputs can pass without a full fetch
 * S2  GitHub ci_status version signal (commit SHA) is invariant while CI
 *     state changes: pending -> success is invisible to version freshness
 * D2  GitHub deployment version (deployment id) is invariant while the
 *     deployment status changes
 * S3  TTL strategy trusts the client-claimed observed_at: a mutation that
 *     happened AFTER the claimed observation must invalidate the claim
 * S3b documented limitation: an unversioned TTL claim of a recent
 *     observation cannot be distinguished from a real one when the state
 *     itself is unchanged (out of guarantee boundary)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { StaleStateFirewall } from '../../src/sdk/firewall.js';
import { HttpStateProvider } from '../../src/providers/http/http-provider.js';
import { GitHubStateProvider } from '../../src/providers/github/github-provider.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import { MemoryStore } from '../../src/storage/memory/memory-store.js';
import { ManualClock } from '../../src/engine/clock.js';

const CLOCK_START_MS = Date.parse('2026-09-05T12:00:00Z');

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('audit: state spoofing and provider trust', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('S1 fabricated metadata cannot ride a 304 conditional response past preconditions', async () => {
    const http = new HttpStateProvider({
      thing: {
        url: 'http://simulated.local/things/{id}',
        version: { source: 'header', name: 'etag' },
        metadata_paths: { status: '$.status' },
      },
    });

    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers(init?.headers ?? {});
      const etag = headers.get('if-none-match');
      if (etag === 'W/"v1"') {
        // Server attests "unchanged since W/"v1"" — it says nothing about WHAT
        // the resource contains; only the agent claims to know that.
        return new Response(null, { status: 304, headers: { etag: 'W/"v1"' } });
      }
      return jsonResponse({ status: 'blocked' }, 200, { etag: 'W/"v1"' });
    }) as typeof fetch;

    const clock = new ManualClock(CLOCK_START_MS);
    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          {
            name: 'publish-thing',
            match: { operation: 'publish*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            preconditions: [{ field: 'status', operator: 'equals', value: 'approved' }],
            execution: { deadline: '10s' },
          },
        ],
      },
      store: new MemoryStore(),
      providers: [http],
      clock,
    });

    let executorRan = false;
    const outcome = await firewall.execute(
      {
        agent_id: 'bot',
        tool: 'http',
        operation: 'publish_thing',
        dependencies: [
          {
            source: 'http',
            resource: 'thing',
            resource_id: '1',
            version: 'W/"v1"',
            metadata: { status: 'approved' }, // the agent's OWN claim, never verified by a 304
          },
        ],
      },
      {
        idempotency: 'non_idempotent',
        execute: async () => {
          executorRan = true;
          return { success: true };
        },
      },
    );

    expect(executorRan).toBe(false);
    expect(outcome.executed).toBe(false);
    expect(outcome.decision.decision).toBe('DENY');
  });

  it('S2 GitHub ci_status version signal must change when the CI state changes', async () => {
    const statuses = [
      { state: 'pending', sha: 'abc123', total_count: 1, etag: 'W/"st-1"' },
      { state: 'success', sha: 'abc123', total_count: 3, etag: 'W/"st-2"' },
    ];
    let call = 0;
    const provider = new GitHubStateProvider({
      apiBase: 'http://simulated.local',
      timeoutMs: 1000,
      includeReviews: false,
      fetchImpl: (async () => {
        const s = statuses[Math.min(call, statuses.length - 1)]!;
        call += 1;
        return jsonResponse({ state: s.state, sha: s.sha, total_count: s.total_count }, 200, { etag: s.etag });
      }) as typeof fetch,
    });
    const ref = { source: 'github', resource: 'ci_status', resource_id: 'org/repo@abc123', version: null, content_hash: null, observed_at: null, metadata: {} };
    const snap1 = await provider.getState(ref, new Date(CLOCK_START_MS).toISOString());
    const snap2 = await provider.getState(ref, new Date(CLOCK_START_MS + 1000).toISOString());
    // The underlying CI went pending -> success; a version signal that stays
    // equal reports stale state as authoritative current state.
    expect(snap2.version).not.toBe(snap1.version);
  });

  it('D2 GitHub deployment version signal must change when the deployment status changes', async () => {
    const states = ['in_progress', 'success'];
    let call = 0;
    const provider = new GitHubStateProvider({
      apiBase: 'http://simulated.local',
      timeoutMs: 1000,
      includeReviews: false,
      fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.includes('/deployments?')) {
          return jsonResponse([{ id: 777, statuses_url: 'http://simulated.local/statuses' }], 200, { etag: 'W/"dep-1"' });
        }
        if (url.includes('/statuses')) {
          const s = states[Math.min(call, states.length - 1)]!;
          call += 1;
          return jsonResponse([{ state: s }], 200);
        }
        return jsonResponse({ message: 'not found' }, 404);
      }) as typeof fetch,
    });
    const ref = { source: 'github', resource: 'deployment', resource_id: 'org/repo@production', version: null, content_hash: null, observed_at: null, metadata: {} };
    const snap1 = await provider.getState(ref, new Date(CLOCK_START_MS).toISOString());
    const snap2 = await provider.getState(ref, new Date(CLOCK_START_MS + 1000).toISOString());
    expect(snap2.version).not.toBe(snap1.version);
  });

  it('S3 a server-stamped mutation newer than the claimed observation must not pass TTL freshness', async () => {
    const clock = new ManualClock(CLOCK_START_MS);
    const provider = new InMemoryStateProvider('memory');
    // State was last mutated (server-stamped) at T0.
    provider.put('feature', 'flag', { enabled: false }, new Date(CLOCK_START_MS).toISOString(), 'v9', new Date(CLOCK_START_MS).toISOString());
    clock.advance(1000); // now = T0 + 1s

    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          { name: 'toggle-feature', match: { operation: 'toggle*' }, risk: 'HIGH', freshness: { strategy: 'ttl', max_age: '30s' } },
        ],
      },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });

    let executorRan = false;
    const outcome = await firewall.execute(
      {
        agent_id: 'bot',
        tool: 'features',
        operation: 'toggle_feature',
        dependencies: [
          {
            source: 'memory',
            resource: 'feature',
            resource_id: 'flag',
            // The agent claims it observed the flag 20s ago. The provider's
            // server stamp says the state changed AFTER that claim.
            observed_at: new Date(CLOCK_START_MS - 20_000).toISOString(),
          },
        ],
      },
      {
        idempotency: 'non_idempotent',
        execute: async () => {
          executorRan = true;
          return { success: true };
        },
      },
    );

    expect(executorRan).toBe(false);
    expect(outcome.decision.decision).toBe('DENY');
    expect(outcome.decision.invalid_dependencies.length).toBeGreaterThan(0);
  });

  it('S3b documented limitation: an unversioned TTL claim of a recent observation is not verifiable when state is unchanged', async () => {
    const clock = new ManualClock(CLOCK_START_MS);
    const provider = new InMemoryStateProvider('memory');
    // State last mutated 5 minutes ago and UNCHANGED since. An agent can lie
    // about having observed it "just now"; no comparable signal exists.
    provider.put('archive', 'bucket', { objects: 10 }, new Date(CLOCK_START_MS - 300_000).toISOString());
    clock.advance(1000);

    const firewall = await StaleStateFirewall.create({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        defaults: { on_unknown: 'revalidate', on_stale: 'revalidate', on_invalid: 'deny' },
        actions: [
          { name: 'write-archive', match: { operation: 'write*' }, risk: 'LOW', freshness: { strategy: 'ttl', max_age: '30s' } },
        ],
      },
      store: new MemoryStore(),
      providers: [provider],
      clock,
    });

    const decision = await firewall.check({
      agent_id: 'bot',
      tool: 'archive',
      operation: 'write_archive',
      dependencies: [
        { source: 'memory', resource: 'archive', resource_id: 'bucket', observed_at: new Date(CLOCK_START_MS - 1_000).toISOString() },
      ],
    });
    // Out of guarantee boundary (client-claimed timestamp, no comparable
    // signal, unchanged state). The firewall records what it relied on:
    expect(decision.decision).toBe('ALLOW');
    expect(decision.verdicts[0]?.strategy).toBe('ttl');
  });
});
