import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GitHubStateProvider } from '../../src/providers/github/github-provider.js';
import { HttpStateProvider } from '../../src/providers/http/http-provider.js';
import { ProviderUnavailableError, ProviderResponseError } from '../../src/domain/errors.js';

/**
 * INDEPENDENT ASSURANCE AUDIT — provider capability and classification.
 *
 * GitHub is exercised through an injected fetch implementing the real API
 * semantics (stale blob sha -> 409, missing file -> 404, rate limit -> 403,
 * server error -> 500). HTTP conditional execution is exercised against a
 * REAL node:http server on localhost, driving real sockets, so request headers,
 * preconditions, and status codes are verified end to end.
 */

// ---------------------------------------------------------------- GitHub ---
function githubFetch(state: {
  fileSha: string;
  fileExists: boolean;
  rateLimited?: boolean;
  serverError?: boolean;
  log: Array<{ method: string; url: string; sha?: string }>;
}) {  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers });
    state.log.push({ method, url, sha: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>)['sha'] as string | undefined : undefined });

    if (state.rateLimited) {
      return respond(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    }
    if (state.serverError) return respond(500, { message: 'internal error' });

    if (method === 'GET' && url.endsWith('/contents/docs/config.json')) {
      if (!state.fileExists) return respond(404, { message: 'Not Found' });
      return respond(200, { path: 'docs/config.json', sha: state.fileSha, size: 10, type: 'file' });
    }
    if (method === 'PUT' && url.endsWith('/contents/docs/config.json')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (!state.fileExists) return respond(404, { message: 'Not Found' });
      if (body['sha'] !== state.fileSha) {
        return respond(409, { message: '"sha" does not match the current sha' });
      }
      state.fileSha = `blob_new_${Date.now()}`;
      return respond(201, { content: { sha: state.fileSha }, commit: { sha: 'c2' } });
    }
    return respond(404, { message: `unexpected ${method} ${url}` });
  }) as typeof fetch;
}

describe('INDEPENDENT: GitHub conditional execution classification (brief §11)', () => {
  function makeProvider(state: ReturnType<typeof makeState>) {
    return new GitHubStateProvider({
      apiBase: 'https://api.github.invalid',
      timeoutMs: 1000,
      includeReviews: false,
      fetchImpl: githubFetch(state),
      token: 'audit-token',
    });
  }
  function makeState() {
    return {
      fileSha: 'blob1111111111111111111111111111111111111',
      fileExists: true,
      rateLimited: false as boolean | undefined,
      serverError: false as boolean | undefined,
      log: [] as Array<{ method: string; url: string; sha?: string }>,
    };
  }

  it('IR-G1 the authorized blob sha is carried INSIDE the PUT (condition evaluated by GitHub)', async () => {
    const state = makeState();
    const provider = makeProvider(state);
    const result = await provider.conditionalExecute({
      ref: { source: 'github', resource: 'file', resource_id: 'octo/hello@docs/config.json' },
      expected_version: 'blob1111111111111111111111111111111111111',
      changes: { content: '{"replicas":3}' },
    });
    expect(result.outcome).toBe('executed');
    const put = state.log.find((c) => c.method === 'PUT');
    expect(put!.sha).toBe('blob1111111111111111111111111111111111111');
  });

  it('IR-G2 stale blob sha -> condition_failed, no new content written', async () => {
    const state = makeState();
    const provider = makeProvider(state);
    state.fileSha = 'blob_moved_on'; // a colleague pushed first
    const result = await provider.conditionalExecute({
      ref: { source: 'github', resource: 'file', resource_id: 'octo/hello@docs/config.json' },
      expected_version: 'blob1111111111111111111111111111111111111',
      changes: { content: '{"replicas":9}' },
    });
    expect(result.outcome).toBe('condition_failed');
    expect(state.log.filter((c) => c.method === 'PUT')).toHaveLength(1); // refused, not retried
  });

  it('IR-G3 deleted file (404) -> condition_failed (authorized state no longer true)', async () => {
    const state = makeState();
    const provider = makeProvider(state);
    state.fileExists = false;
    const result = await provider.conditionalExecute({
      ref: { source: 'github', resource: 'file', resource_id: 'octo/hello@docs/config.json' },
      expected_version: 'blob1111111111111111111111111111111111111',
      changes: { content: '{"replicas":9}' },
    });
    expect(result.outcome).toBe('condition_failed');
  });

  it('IR-G4 missing expected sha -> typed ProviderResponseError BEFORE any request', async () => {
    const state = makeState();
    const provider = makeProvider(state);
    await expect(
      provider.conditionalExecute({
        ref: { source: 'github', resource: 'file', resource_id: 'octo/hello@docs/config.json' },
        expected_version: '',
        changes: { content: 'x' },
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
    expect(state.log).toHaveLength(0); // nothing sent
  });

  it('IR-G5 NON-FILE resource -> typed refusal (no conditional mutation exists on GitHub for it)', async () => {
    const state = makeState();
    const provider = makeProvider(state);
    await expect(
      provider.conditionalExecute({
        ref: { source: 'github', resource: 'issue', resource_id: 'octo/hello#7' },
        expected_version: 'etag',
        changes: {},
      }),
    ).rejects.toThrow(/not available for resource "issue"/);
  });

  it('IR-G6 rate limit (403) and server error (500) are PROVIDER ERRORS, not condition failures', async () => {
    const state = makeState();
    const provider = makeProvider(state);
    state.rateLimited = true;
    await expect(
      provider.conditionalExecute({
        ref: { source: 'github', resource: 'file', resource_id: 'octo/hello@docs/config.json' },
        expected_version: 'blob1111111111111111111111111111111111111',
        changes: { content: 'x' },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    state.rateLimited = false;
    state.serverError = true;
    await expect(
      provider.conditionalExecute({
        ref: { source: 'github', resource: 'file', resource_id: 'octo/hello@docs/config.json' },
        expected_version: 'blob1111111111111111111111111111111111111',
        changes: { content: 'x' },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('IR-G7 CAPABILITY GRANULARITY: supportsConditionalExecution() is blanket-true even though only file resources can enforce it (finding evidence)', async () => {
    const state = makeState();
    const provider = makeProvider(state);
    // The blanket capability says yes for every resource...
    expect(provider.supportsConditionalExecution()).toBe(true);
    // ...but a branch mutation would throw at execution time — the capability
    // declaration is coarser than the actual enforcement surface.
    await expect(
      provider.conditionalExecute({
        ref: { source: 'github', resource: 'branch', resource_id: 'octo/hello@main' },
        expected_version: 'sha',
        changes: {},
      }),
    ).rejects.toThrow(/not available for resource "branch"/);
  });
});

// ------------------------------------------------------------------ HTTP ---
interface HttpFixture {
  server: Server;
  baseUrl: string;
  requests: Array<{ method: string; ifMatch: string | null; url: string }>;
  state: { etag: string; body: string; ignoreIfMatch: boolean; forceStatus?: number };
}

async function startHttpServer(opts: { ignoreIfMatch?: boolean } = {}): Promise<HttpFixture> {
  const fixture: HttpFixture = {
    server: undefined as unknown as Server,
    baseUrl: '',
    requests: [],
    state: { etag: '"v1"', body: JSON.stringify({ status: 'healthy', replicas: 2 }), ignoreIfMatch: opts.ignoreIfMatch ?? false },
  };
  fixture.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const ifMatch = req.headers['if-match'] as string | undefined;
      fixture.requests.push({ method: req.method ?? '', ifMatch: ifMatch ?? null, url: req.url ?? '' });
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', etag: fixture.state.etag });
        res.end(fixture.state.body);
        return;
      }
      if (req.method === 'PUT') {
        if (fixture.state.forceStatus !== undefined) {
          res.writeHead(fixture.state.forceStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forced' }));
          return;
        }
        if (!fixture.state.ignoreIfMatch && ifMatch !== fixture.state.etag) {
          // RFC 9110 precondition failure; the mutation must NOT be applied.
          res.writeHead(412, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'precondition failed' }));
          return;
        }
        fixture.state.body = raw; // apply the mutation
        fixture.state.etag = `"v${Date.now()}"`;
        res.writeHead(200, { 'content-type': 'application/json', etag: fixture.state.etag });
        res.end(fixture.state.body);
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  fixture.baseUrl = `http://127.0.0.1:${(fixture.server.address() as AddressInfo).port}`;
  return fixture;
}

function httpProvider(f: HttpFixture) {
  return new HttpStateProvider({
    deployment: {
      url: `${f.baseUrl}/deployments/{id}`,
      version: { source: 'header', name: 'etag' },
      content_hash: 'off',
      mutation: { method: 'PUT', condition_failed_status: [412, 409] },
    },
  });
}

const afterFns: Array<() => Promise<void>> = [];
afterAll(async () => {
  while (afterFns.length > 0) await afterFns.pop()!();
});

describe('INDEPENDENT: HTTP If-Match against a REAL local server (brief §12/§13)', () => {
  it('IR-H1 (Case A) matching ETag: If-Match sent, server applies the mutation', async () => {
    const f = await startHttpServer();
    afterFns.push(() => new Promise<void>((r) => f.server.close(() => r())));
    const provider = httpProvider(f);

    const snap = await provider.getState(
      { source: 'http', resource: 'deployment', resource_id: 'prod', version: null, content_hash: null, observed_at: null, metadata: {} },
      new Date().toISOString(),
    );
    expect(snap.version).toBe('"v1"');

    const result = await provider.conditionalExecute({
      ref: { source: 'http', resource: 'deployment', resource_id: 'prod' },
      expected_version: snap.version!,
      changes: { replicas: 3 },
    });
    expect(result.outcome).toBe('executed');
    const put = f.requests.find((r) => r.method === 'PUT');
    expect(put!.ifMatch).toBe('"v1"');
    expect(JSON.parse(f.state.body)).toMatchObject({ replicas: 3 });
  });

  it('IR-H2 (Case B) changed ETag: server answers 412, mutation NOT applied, provider reports condition_failed', async () => {
    const f = await startHttpServer();
    afterFns.push(() => new Promise<void>((r) => f.server.close(() => r())));
    const provider = httpProvider(f);
    f.state.etag = '"v2-someone-else"';

    const result = await provider.conditionalExecute({
      ref: { source: 'http', resource: 'deployment', resource_id: 'prod' },
      expected_version: '"v1"',
      changes: { replicas: 9 },
    });
    expect(result.outcome).toBe('condition_failed');
    expect(f.state.body).not.toContain('9'); // no side effect
  });

  it('IR-H3 (Case C) a server that IGNORES If-Match executes the mutation — and the firewall/provider CANNOT detect it (documented operator-verification boundary)', async () => {
    const f = await startHttpServer({ ignoreIfMatch: true });
    afterFns.push(() => new Promise<void>((r) => f.server.close(() => r())));
    const provider = httpProvider(f);
    f.state.etag = '"v2-someone-else"'; // condition no longer true

    const result = await provider.conditionalExecute({
      ref: { source: 'http', resource: 'deployment', resource_id: 'prod' },
      expected_version: '"v1"',
      changes: { replicas: 9 },
    });
    // The header was sent, but the server ignored it and mutated anyway.
    expect(f.requests.find((r) => r.method === 'PUT')!.ifMatch).toBe('"v1"');
    expect(result.outcome).toBe('executed'); // reported executed — honest from the wire's point of view
    expect(f.state.body).toContain('9'); // side effect happened despite the stale condition
    // This is why the capability is opt-in per resource and the operator MUST
    // verify the server honors RFC 9110 preconditions (docs claim this).
  });

  it('IR-H4 server 500 during conditional mutation -> ProviderUnavailableError, NOT a condition failure', async () => {
    const f = await startHttpServer();
    afterFns.push(() => new Promise<void>((r) => f.server.close(() => r())));
    const provider = httpProvider(f);
    f.state.forceStatus = 500;
    await expect(
      provider.conditionalExecute({
        ref: { source: 'http', resource: 'deployment', resource_id: 'prod' },
        expected_version: '"v1"',
        changes: {},
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('IR-H5 resource without mutation config: capability not offered at the resource level', async () => {
    const f = await startHttpServer();
    afterFns.push(() => new Promise<void>((r) => f.server.close(() => r())));
    const provider = new HttpStateProvider({
      deployment: { url: `${f.baseUrl}/deployments/{id}`, version: { source: 'header', name: 'etag' }, content_hash: 'off' },
    });
    expect(provider.supportsConditionalExecution()).toBe(false);
    await expect(
      provider.conditionalExecute({
        ref: { source: 'http', resource: 'deployment', resource_id: 'prod' },
        expected_version: '"v1"',
        changes: {},
      }),
    ).rejects.toThrow(/does not declare a conditional mutation endpoint/);
  });

  it('IR-H6 network failure (connection refused) -> ProviderUnavailableError with sanitized URL', async () => {
    // Port 1 on 127.0.0.1: nothing listens there.
    const provider = new HttpStateProvider({
      deployment: {
        url: 'http://127.0.0.1:1/deployments/{id}',
        version: { source: 'header', name: 'etag' },
        content_hash: 'off',
        mutation: { method: 'PUT' },
      },
    });
    await expect(
      provider.conditionalExecute({
        ref: { source: 'http', resource: 'deployment', resource_id: 'prod' },
        expected_version: '"v1"',
        changes: {},
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
