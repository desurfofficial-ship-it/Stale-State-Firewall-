import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpStateProvider } from '../../src/providers/http/http-provider.js';
import { GitHubStateProvider } from '../../src/providers/github/github-provider.js';
import { InMemoryStateProvider } from '../../src/providers/memory/in-memory-provider.js';
import type { StateProvider } from '../../src/providers/types.js';
import type { StateDependency } from '../../src/domain/state.js';
import { ProviderUnavailableError } from '../../src/domain/errors.js';
import { sha256Hex } from '../../src/engine/hashing.js';

/**
 * Provider contract suite (spec §16, §65): every provider implementation
 * must satisfy the same behavioral contract, regardless of backend.
 */
export function providerContract(name: string, make: () => { provider: StateProvider; seed: () => void; mutate: () => void }) {
  describe(`provider contract: ${name}`, () => {
    it('reports support accurately', () => {
      const { provider, seed } = make();
      seed();
      expect(provider.supports({ source: provider.name, resource: 'thing', resource_id: 'a' })).toBe(true);
      expect(provider.supports({ source: 'unknown-source', resource: 'thing', resource_id: 'a' })).toBe(false);
    });

    it('getState returns a complete snapshot with provenance and version', async () => {
      const { provider, seed } = make();
      seed();
      const snap = await provider.getState(dep(provider.name), nowIso());
      expect(snap.version).toBeTruthy();
      expect(snap.observed_at).toBeTruthy();
      expect(snap.provenance.provider).toBe(provider.name);
      expect(snap.provenance.retrieved_at).toBeTruthy();
      expect(snap.metadata).toBeDefined();
    });

    it('detects external mutation through version change', async () => {
      const { provider, seed, mutate } = make();
      seed();
      const before = (await provider.getState(dep(provider.name), nowIso())).version;
      mutate();
      const after = (await provider.getState(dep(provider.name), nowIso())).version;
      expect(after).not.toBe(before);
    });

    it('conditional verification confirms unchanged state for the live version', async () => {
      const { provider, seed } = make();
      if (!provider.supportsConditionalVerification?.()) return;
      seed();
      const current = await provider.getState(dep(provider.name), nowIso());
      const conditional = await provider.getConditional?.(
        { ...dep(provider.name), version: current.version },
        nowIso(),
      );
      if (conditional) {
        expect(conditional.unchanged_since_observed).toBe(true);
        expect(conditional.version).toBe(current.version);
      }
    });
  });
}

const dep = (source: string): StateDependency => ({
  source, resource: 'thing', resource_id: 'a',
  version: null, content_hash: null, observed_at: null, metadata: {},
});
const nowIso = () => new Date().toISOString();

providerContract('memory', () => {
  const provider = new InMemoryStateProvider('memory');
  return {
    provider,
    seed: () => provider.put('thing', 'a', { status: 'ok' }, new Date().toISOString()),
    mutate: () => provider.mutate('thing', 'a', { status: 'changed' }, new Date().toISOString()),
  };
});

// FL-9 regression: the memory fixture's seeding helper (put) and its
// external-actor simulation primitive (mutate) have deliberately different
// version semantics. These tests pin both so the distinction can never
// silently regress into a CAS-invisible interference path.
describe('memory provider: put/mutate version semantics (FL-9)', () => {
  it('the interference primitive mutate() always advances the version, so a stale CAS refuses', async () => {
    const provider = new InMemoryStateProvider('memory');
    provider.put('file', 'f', { content: 'v0' }, nowIso());
    const authorizedVersion = provider.get('file', 'f')!.version;

    // A concurrent external actor changes the resource while an action is
    // authorized against `authorizedVersion`.
    const bumped = provider.mutate('file', 'f', { content: 'v1' }, nowIso());
    expect(bumped).not.toBe(authorizedVersion);
    expect(provider.get('file', 'f')!.version).toBe(bumped);

    // The authorization computed against the stale version MUST be refused
    // by the provider's atomic CAS.
    const result = await provider.conditionalExecute({
      ref: { source: 'memory', resource: 'file', resource_id: 'f' },
      expected_version: authorizedVersion,
      changes: { content: 'agent-write' },
    });
    expect(result.outcome).toBe('condition_failed');
    expect(result.current_version).toBe(bumped);
  });

  it('put() on an EXISTING resource is deliberately version-preserving (documented re-seeding semantics)', () => {
    const provider = new InMemoryStateProvider('memory');
    provider.put('file', 'f', { content: 'v0' }, nowIso());
    const seeded = provider.get('file', 'f')!.version;

    // Re-seed content without an explicit version: the version is KEPT.
    // This is a fixture convenience, documented on put() — never a
    // substitute for mutate() when simulating interference.
    provider.put('file', 'f', { content: 'v1' }, nowIso());
    expect(provider.get('file', 'f')!.version).toBe(seeded);
    expect(provider.get('file', 'f')!.metadata).toEqual({ content: 'v1' });

    // An explicit version argument always wins.
    provider.put('file', 'f', { content: 'v2' }, nowIso(), 'v-pinned');
    expect(provider.get('file', 'f')!.version).toBe('v-pinned');
  });
});

describe('http provider contract against a live local server', () => {
  let server: Server;
  let baseUrl: string;
  let currentEtag = 'W/"etag-1"';
  let currentBody: Record<string, unknown>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const inm = req.headers['if-none-match'];
      if (inm && inm === currentEtag) {
        res.writeHead(304, { etag: currentEtag });
        res.end();
        return;
      }
      if (req.url?.includes('/broken')) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      if (req.url?.includes('/notjson')) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('<html>not json</html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: currentEtag, 'last-modified': new Date().toUTCString() });
      res.end(JSON.stringify(currentBody));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function provider(): HttpStateProvider {
    return new HttpStateProvider({
      thing: {
        url: `${baseUrl}/things/{id}`,
        version: { source: 'header', name: 'etag' },
        observed_at: { source: 'json_path', name: 'updated_at', format: 'iso' },
        metadata_paths: { status: '$.status', environment: '$.env' },
      },
      broken: { url: `${baseUrl}/broken/{id}` },
      notjson: { url: `${baseUrl}/notjson/{id}` },
    });
  }

  it('serves full state with extracted version, timestamp, and metadata', async () => {
    currentEtag = 'W/"e1"';
    currentBody = { status: 'healthy', env: 'prod', updated_at: '2026-09-05T10:00:00Z' };
    const p = provider();
    const snap = await p.getState({ source: 'http', resource: 'thing', resource_id: '42', version: null, content_hash: null, observed_at: null, metadata: {} }, new Date().toISOString());
    expect(snap.version).toBe('W/"e1"');
    expect(snap.observed_at).toBe('2026-09-05T10:00:00.000Z');
    expect(snap.metadata['status']).toBe('healthy');
    expect(snap.content_hash).toBe(`sha256:${sha256Hex(JSON.stringify(currentBody))}`);
  });

  it('answers conditional verification with 304 -> unchanged_since_observed, never echoing agent metadata', async () => {
    currentEtag = 'W/"e2"';
    currentBody = { status: 'healthy', env: 'prod', updated_at: '2026-09-05T10:00:00Z' };
    const p = provider();
    const conditional = await p.getConditional!(
      {
        source: 'http', resource: 'thing', resource_id: '42',
        version: 'W/"e2"', content_hash: null, observed_at: null,
        // A 304 attests "unchanged since <etag>" but carries no server-vouched
        // content: agent-supplied metadata must never be echoed as current state.
        metadata: { status: 'fabricated', environment: 'staging' },
      },
      new Date().toISOString(),
    );
    expect(conditional).not.toBeNull();
    expect(conditional!.unchanged_since_observed).toBe(true);
    expect(conditional!.provenance.validation_method).toBe('conditional_304');
    expect(conditional!.metadata).toEqual({});
  });

  it('reports 304 snapshots with no metadata; the firewall forces a full fetch when preconditions need server-vouched fields', async () => {
    currentEtag = 'W/"e3"';
    currentBody = { status: 'healthy', env: 'prod', updated_at: '2026-09-05T10:00:00Z' };
    const p = provider();
    const conditional = await p.getConditional!(
      { source: 'http', resource: 'thing', resource_id: '42', version: 'W/"e3"', content_hash: null, observed_at: null, metadata: {} },
      new Date().toISOString(),
    );
    // A 304 cannot vouch for field values. The snapshot carries no metadata;
    // preconditions are only ever evaluated against full-fetch snapshots
    // (enforced by the firewall's fetch path, see audit test S1).
    expect(conditional!.unchanged_since_observed).toBe(true);
    expect(conditional!.provenance.validation_method).toBe('conditional_304');
    expect(conditional!.metadata).toEqual({});
  });

  it('server errors surface as ProviderUnavailableError, never silent success', async () => {
    const p = provider();
    await expect(
      p.getState({ source: 'http', resource: 'broken', resource_id: '1', version: null, content_hash: null, observed_at: null, metadata: {} }, new Date().toISOString()),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('non-JSON bodies surface as ProviderResponseError (malformed state, spec §26)', async () => {
    const p = provider();
    await expect(
      p.getState({ source: 'http', resource: 'notjson', resource_id: '1', version: null, content_hash: null, observed_at: null, metadata: {} }, new Date().toISOString()),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe('github provider contract against a simulated GitHub API', () => {
  let server: Server;
  let baseUrl: string;
  let prBody: Record<string, unknown>;
  let reviewsBody: Array<Record<string, unknown>>;
  let statusBody: Record<string, unknown>;
  let sawAuthHeader: string | null = null;

  beforeAll(async () => {
    server = createServer((req, res) => {
      sawAuthHeader = (req.headers['authorization'] as string) ?? null;
      if (req.url?.includes('/pulls/42/reviews')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reviewsBody));
        return;
      }
      if (req.url?.includes('/pulls/42')) {
        if (req.headers['if-none-match'] === 'W/"pr-1"') {
          res.writeHead(304, { etag: 'W/"pr-1"' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"pr-1"' });
        res.end(JSON.stringify(prBody));
        return;
      }
      if (req.url?.includes('/commits/abc123/status')) {
        res.writeHead(200, { 'content-type': 'application/json', etag: 'W/"st-1"' });
        res.end(JSON.stringify(statusBody));
        return;
      }
      if (req.url?.includes('/rate-limited')) {
        res.writeHead(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) });
        res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ message: 'Not Found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    prBody = {
      state: 'open',
      draft: false,
      merged: false,
      mergeable_state: 'clean',
      updated_at: '2026-09-05T09:00:00Z',
      head: { sha: 'abc123' },
      base: { sha: 'def456' },
    };
    reviewsBody = [
      { user: { login: 'alice' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-09-05T08:00:00Z' },
      { user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2026-09-05T08:30:00Z' },
      { user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2026-09-05T09:00:00Z' },
    ];
    statusBody = { state: 'success', sha: 'abc123', total_count: 3 };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const gh = () =>
    new GitHubStateProvider({
      apiBase: baseUrl,
      timeoutMs: 2000,
      includeReviews: true,
      token: 'token-from-env-only',
    });

  it('maps pull_request to head-SHA version + aggregated review status', async () => {
    const p = gh();
    const snap = await p.getState(
      { source: 'github', resource: 'pull_request', resource_id: 'org/repo#42', version: null, content_hash: null, observed_at: null, metadata: {} },
      new Date().toISOString(),
    );
    expect(snap.version).toBe('abc123');
    expect(snap.metadata['state']).toBe('open');
    expect(snap.metadata['review_status']).toBe('approved');
    expect(snap.observed_at).toBe('2026-09-05T09:00:00Z');
    expect(sawAuthHeader).toBe('Bearer token-from-env-only');
  });

  it('maps ci_status to the combined status state', async () => {
    const p = gh();
    const snap = await p.getState(
      { source: 'github', resource: 'ci_status', resource_id: 'org/repo@abc123', version: null, content_hash: null, observed_at: null, metadata: {} },
      new Date().toISOString(),
    );
    expect(snap.metadata['state']).toBe('success');
    expect(snap.metadata['sha']).toBe('abc123');
  });

  it('conditional verification uses If-None-Match and reports unchanged', async () => {
    const p = gh();
    const conditional = await p.getConditional!(
      { source: 'github', resource: 'pull_request', resource_id: 'org/repo#42', version: 'W/"pr-1"', content_hash: null, observed_at: null, metadata: {} },
      new Date().toISOString(),
    );
    expect(conditional?.unchanged_since_observed).toBe(true);
  });

  it('rate limiting surfaces as ProviderUnavailableError (fail closed downstream)', async () => {
    const p = new GitHubStateProvider({ apiBase: `${baseUrl}/rate-limited`, timeoutMs: 1000, includeReviews: false, token: 't' });
    await expect(
      p.getState({ source: 'github', resource: 'issue', resource_id: 'org/repo#1', version: null, content_hash: null, observed_at: null, metadata: {} }, new Date().toISOString()),
    ).rejects.toThrow(/rate limit/);
  });
});
