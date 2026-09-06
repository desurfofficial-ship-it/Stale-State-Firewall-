import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GitHubStateProvider } from '../../src/providers/github/github-provider.js';
import { HttpStateProvider } from '../../src/providers/http/http-provider.js';
import { ProviderUnavailableError, ProviderResponseError } from '../../src/domain/errors.js';


/**
 * Milestone: ATOMIC EFFECT ASSURANCE — provider capability contract tests.
 *
 * Only genuine provider-enforced conditionality counts: the condition must
 * be evaluated by the external system inside the mutation call itself
 * (GitHub Contents API blob-sha check; HTTP If-Match preconditions).
 */

describe('github provider: conditional execution via Contents API (blob-sha CAS)', () => {
  let calls: Array<{ method: string; url: string; sha?: string; ifMatch?: string }>;
  let fileSha: string;
  let fileContent: string;
  let fileExists: boolean;
  let provider: GitHubStateProvider;

  const fileRef = { source: 'github', resource: 'file', resource_id: 'octo/hello@docs/config.json' };

  beforeAll(() => {
    calls = [];
    fileSha = 'blob1111111111111111111111111111111111111';
    fileContent = '{"replicas":2}';
    fileExists = true;

    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers });

      if (method === 'GET' && url.endsWith('/contents/docs/config.json')) {
        calls.push({ method, url });
        if (!fileExists) return respond(404, { message: 'Not Found' });
        return respond(200, { path: 'docs/config.json', sha: fileSha, size: fileContent.length, type: 'file' });
      }
      if (method === 'PUT' && url.endsWith('/contents/docs/config.json')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        calls.push({ method, url, sha: body['sha'] as string });
        if (!fileExists) return respond(404, { message: 'Not Found' });
        if (body['sha'] !== fileSha) {
          // GitHub rejects a write against a stale blob sha.
          return respond(409, { message: '"sha" does not match the current sha' });
        }
        fileSha = 'blob2222222222222222222222222222222222222';
        fileContent = Buffer.from(String(body['content']), 'base64').toString('utf8');
        return respond(201, { content: { sha: fileSha }, commit: { sha: 'commitnew' } });
      }
      return respond(404, { message: `unexpected ${method} ${url}` });
    }) as typeof fetch;

    provider = new GitHubStateProvider({ apiBase: 'https://api.github.invalid', timeoutMs: 1000, includeReviews: false, fetchImpl, token: 't' });
  });

  it('GC1 declares the conditional-execution capability', () => {
    expect(provider.supportsConditionalExecution()).toBe(true);
  });

  it('GC2 getState for a file reports the blob sha as the version signal', async () => {
    const snap = await provider.getState(
      { ...fileRef, version: null, content_hash: null, observed_at: null, metadata: {} },
      new Date().toISOString(),
    );
    expect(snap.version).toBe('blob1111111111111111111111111111111111111');
    expect(snap.metadata['sha']).toBe(snap.version);
    // The file content is NOT copied into metadata (no sensitive payloads).
    expect(JSON.stringify(snap.metadata)).not.toContain('replicas');
  });

  it('GC3 conditionalExecute with the CURRENT sha: GitHub applies the mutation atomically', async () => {
    const result = await provider.conditionalExecute({
      ref: fileRef,
      expected_version: 'blob1111111111111111111111111111111111111',
      changes: { content: '{"replicas":3}', message: 'scale up' },
    });
    expect(result.outcome).toBe('executed');
    if (result.outcome === 'executed') {
      expect(result.version).toBe('blob2222222222222222222222222222222222222');
    }
    // The authorized sha was sent to GitHub INSIDE the mutation call.
    expect(calls.some((c) => c.method === 'PUT' && c.sha === 'blob1111111111111111111111111111111111111')).toBe(true);
    expect(fileContent).toBe('{"replicas":3}');
  });

  it('GC4 conditionalExecute with a STALE sha: GitHub refuses and no side effect occurs', async () => {
    // The file moved on (a colleague pushed between authorization and execution).
    const authorizedSha = 'blob2222222222222222222222222222222222222';
    fileSha = 'blobExternal99999999999999999999999999999999';
    const result = await provider.conditionalExecute({
      ref: fileRef,
      expected_version: authorizedSha,
      changes: { content: '{"replicas":9}' },
    });
    expect(result.outcome).toBe('condition_failed');
    expect(fileContent).toBe('{"replicas":3}'); // the stale write never landed
    fileSha = 'blob2222222222222222222222222222222222222';
  });

  it('GC5 conditionalExecute on a deleted file: condition failed (the authorized state no longer exists)', async () => {
    fileExists = false;
    const result = await provider.conditionalExecute({
      ref: fileRef,
      expected_version: 'blob2222222222222222222222222222222222222',
      changes: { content: '{"replicas":9}' },
    });
    expect(result.outcome).toBe('condition_failed');
    if (result.outcome === 'condition_failed') {
      expect(result.current_version).toBeNull();
    }
    fileExists = true;
  });

  it('GC6 a provider crash (5xx) is an error, NOT a condition failure', async () => {
    const breaking = new GitHubStateProvider({
      apiBase: 'https://api.github.invalid',
      timeoutMs: 1000,
      includeReviews: false,
      token: 't',
      fetchImpl: (async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 })) as typeof fetch,
    });
    await expect(
      breaking.conditionalExecute({
        ref: fileRef,
        expected_version: 'blob2222222222222222222222222222222222222',
        changes: { content: 'x' },
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('GC7 resources without conditional mutation semantics are refused honestly', async () => {
    await expect(
      provider.conditionalExecute({
        ref: { source: 'github', resource: 'pull_request', resource_id: 'octo/hello#42' },
        expected_version: 'abc',
        changes: {},
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });
});

describe('http provider: conditional execution via If-Match preconditions', () => {
  let server: Server;
  let baseUrl: string;
  let etag: string;
  let value: string;
  let observedRequests: Array<{ method: string; ifMatch: string | null; body: string | null }>;

  const resourceConfig = () => ({
    items: {
      url: `${baseUrl}/items/{id}`,
      version: { source: 'header' as const, name: 'etag' },
      mutation: {
        method: 'PUT' as const,
        condition_failed_status: [412, 409],
      },
    },
    plain: {
      url: `${baseUrl}/items/{id}`,
    },
  });

  beforeAll(async () => {
    etag = 'v1';
    value = 'state-a';
    observedRequests = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        observedRequests.push({ method: req.method ?? '', ifMatch: req.headers['if-match'] ?? null, body: body || null });
        if (req.method === 'GET') {
          if (req.url === '/items/1') {
            res.writeHead(200, { etag, 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: value }));
          } else {
            res.writeHead(404);
            res.end();
          }
          return;
        }
        if (req.method === 'PUT') {
          const preconditions = req.headers['if-match'];
          if (preconditions !== etag) {
            // The server refuses the stale precondition: NO side effect.
            res.writeHead(412, { etag });
            res.end(JSON.stringify({ error: 'precondition failed' }));
            return;
          }
          value = String(JSON.parse(body || '{}')['status'] ?? value);
          etag = `v${Number(etag.slice(1)) + 1}`;
          res.writeHead(200, { etag, 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: value }));
          return;
        }
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('HC1 capability is declared only for resources with a configured conditional mutation', () => {
    const withMutation = new HttpStateProvider(resourceConfig());
    const withoutMutation = new HttpStateProvider({ plain: { url: `${baseUrl}/items/{id}` } });
    expect(withMutation.supportsConditionalExecution()).toBe(true);
    expect(withoutMutation.supportsConditionalExecution()).toBe(false);
  });

  it('HC2 conditionalExecute sends If-Match with the AUTHORIZED version; the server applies the mutation', async () => {
    const provider = new HttpStateProvider(resourceConfig());
    const result = await provider.conditionalExecute({
      ref: { source: 'http', resource: 'items', resource_id: '1' },
      expected_version: 'v1',
      changes: { status: 'state-b' },
    });
    expect(result.outcome).toBe('executed');
    if (result.outcome === 'executed') {
      expect(result.version).toBe('v2'); // post-mutation version from the response
    }
    expect(observedRequests.at(-1)).toMatchObject({ method: 'PUT', ifMatch: 'v1' });
    expect(value).toBe('state-b');
  });

  it('HC3 the server refusing the precondition (412) is a condition failure, not an error', async () => {
    const provider = new HttpStateProvider(resourceConfig());
    // The authorized version v1 is now stale: the state moved to v2.
    const result = await provider.conditionalExecute({
      ref: { source: 'http', resource: 'items', resource_id: '1' },
      expected_version: 'v1',
      changes: { status: 'state-c' },
    });
    expect(result.outcome).toBe('condition_failed');
    if (result.outcome === 'condition_failed') {
      expect(result.current_version).toBe('v2'); // the server's current etag
    }
    expect(value).toBe('state-b'); // the stale write never landed
  });

  it('HC4 a server crash (500) is a provider error, NOT a condition failure', async () => {
    const crashing = new HttpStateProvider({
      items: {
        url: `${baseUrl}/items/{id}`,
        // The test server only implements GET and PUT: PATCH hits its 500 branch.
        mutation: { method: 'PATCH' },
      },
    });
    await expect(
      crashing.conditionalExecute({
        ref: { source: 'http', resource: 'items', resource_id: '1' },
        expected_version: 'v2',
        changes: {},
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    // A 500 is not in the condition-failure status set: the operation's
    // outcome is unknown, and the provider reports an error rather than
    // pretending the condition failed (crash != condition failure).
  });

  it('HC5 resources without a mutation config cannot be conditionally executed', async () => {
    const provider = new HttpStateProvider({ plain: { url: `${baseUrl}/items/{id}` } });
    await expect(
      provider.conditionalExecute({
        ref: { source: 'http', resource: 'plain', resource_id: '1' },
        expected_version: 'v1',
        changes: {},
      }),
    ).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it('HC6 a deadline miss (server never answers) is a provider-unavailable failure, never a condition failure or silent success', async () => {
    const hanging = createServer(() => {
      /* intentionally never responds */
    });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const hangingUrl = `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`;
    try {
      const provider = new HttpStateProvider({
        items: {
          url: `${hangingUrl}/items/{id}`,
          version: { source: 'header', name: 'etag' },
          mutation: { method: 'PUT', condition_failed_status: [412, 409] },
        },
      });
      await expect(
        provider.conditionalExecute({
          ref: { source: 'http', resource: 'items', resource_id: '1' },
          expected_version: 'v1',
          changes: { status: 'x' },
        }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});
