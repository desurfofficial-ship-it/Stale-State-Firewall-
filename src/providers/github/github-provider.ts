/**
 * GitHub state provider (spec §18, §65).
 *
 * The first serious real-world integration. Supported resources:
 *   pull_request  owner/repo#42      version = head SHA (+ ETag)
 *   issue         owner/repo#42      version = ETag
 *   branch        owner/repo@name    version = commit SHA
 *   ci_status     owner/repo@sha     version = combined-status SHA
 *   deployment    owner/repo@env     version = latest deployment id
 *   release       owner/repo@tag     version = release id
 *
 * Design rules (spec §18):
 * - Prefer stable identifiers: commit SHA, ETag, deployment id, updated_at.
 * - No single signal is assumed universally authoritative; snapshots carry
 *   every signal the API exposes (version, ETag, content hash).
 * - Conditional requests (If-None-Match) yield fresh "unchanged" verification.
 * - Rate limiting, timeouts, and errors surface as typed provider failures,
 *   which the firewall maps to UNKNOWN -> fail closed (invariant 7).
 * - The token comes exclusively from the environment (GITHUB_TOKEN or
 *   SSF_GITHUB_TOKEN) and is never logged.
 */

import type { StateProvider } from '../types.js';
import type { StateDependency, StateSnapshot, StateProvenance } from '../../domain/state.js';
import { newId, ID_PREFIXES } from '../../domain/identifiers.js';
import { sha256Hex } from '../../engine/hashing.js';
import { ProviderUnavailableError, ProviderResponseError } from '../../domain/errors.js';

export interface GitHubProviderOptions {
  apiBase: string;
  timeoutMs: number;
  includeReviews: boolean;
  /** Injectable fetch (tests run a simulated GitHub API); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  token?: string;
}

interface ParsedId {
  owner: string;
  repo: string;
  number?: string;
  branch?: string;
  sha?: string;
  environment?: string;
  tag?: string;
}

function parseResourceId(resource: string, resourceId: string): ParsedId {
  if (resource === 'pull_request' || resource === 'issue') {
    const match = /^([^/]+)\/([^#]+)#(.+)$/.exec(resourceId);
    if (!match) {
      throw new ProviderResponseError('github', `${resource} id must be "owner/repo#number", got "${resourceId}"`);
    }
    return { owner: match[1]!, repo: match[2]!, number: match[3]! };
  }
  const match = /^([^/]+)\/([^@]+)@(.+)$/.exec(resourceId);
  if (!match) {
    throw new ProviderResponseError('github', `${resource} id must be "owner/repo@ref", got "${resourceId}"`);
  }
  const base = { owner: match[1]!, repo: match[2]! };
  switch (resource) {
    case 'branch':
      return { ...base, branch: match[3] };
    case 'ci_status':
      return { ...base, sha: match[3] };
    case 'deployment':
      return { ...base, environment: match[3] };
    case 'release':
      return { ...base, tag: match[3] };
    default:
      throw new ProviderResponseError('github', `unsupported resource "${resource}"`);
  }
}

export class GitHubStateProvider implements StateProvider {
  readonly name = 'github';
  private readonly options: GitHubProviderOptions;
  private readonly etags = new Map<string, string>();

  constructor(options: GitHubProviderOptions) {
    this.options = options;
  }

  supports(ref: { source: string; resource: string }): boolean {
    return (
      ref.source === this.name &&
      ['pull_request', 'issue', 'branch', 'ci_status', 'deployment', 'release'].includes(ref.resource)
    );
  }

  supportsConditionalVerification(): boolean {
    return true;
  }

  private token(): string | null {
    if (this.options.token) return this.options.token;
    return process.env.SSF_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
  }

  async getState(ref: StateDependency, nowIso: string): Promise<StateSnapshot> {
    const conditional = await this.tryConditional(ref, nowIso);
    if (conditional) return conditional;

    const parsed = parseResourceId(ref.resource, ref.resource_id);
    switch (ref.resource) {
      case 'pull_request':
        return this.fetchPullRequest(ref, parsed, nowIso);
      case 'issue':
        return this.fetchIssue(ref, parsed, nowIso);
      case 'branch':
        return this.fetchBranch(ref, parsed, nowIso);
      case 'ci_status':
        return this.fetchCiStatus(ref, parsed, nowIso);
      case 'deployment':
        return this.fetchDeployment(ref, parsed, nowIso);
      case 'release':
        return this.fetchRelease(ref, parsed, nowIso);
      default:
        throw new ProviderResponseError('github', `unsupported resource "${ref.resource}"`);
    }
  }

  async getConditional(ref: StateDependency, nowIso: string): Promise<StateSnapshot | null> {
    return this.tryConditional(ref, nowIso);
  }

  private async tryConditional(ref: StateDependency, nowIso: string): Promise<StateSnapshot | null> {
    if (ref.version === null) return null;
    const parsed = parseResourceId(ref.resource, ref.resource_id);
    const url = this.urlFor(ref.resource, parsed);
    const response = await this.request(url, ref.version);
    if (response.status === 304) {
      const provenance: StateProvenance = {
        provider: this.name,
        retrieved_at: nowIso,
        time_source: 'client',
        validation_method: 'conditional_304',
      };
      return {
        snapshot_id: newId(ID_PREFIXES.snapshot, Date.parse(nowIso)),
        source: ref.source,
        resource: ref.resource,
        resource_id: ref.resource_id,
        observed_at: ref.observed_at ?? nowIso,
        version: ref.version,
        content_hash: ref.content_hash,
        metadata: ref.metadata,
        provenance,
        unchanged_since_observed: true,
      };
    }
    if (response.status >= 200 && response.status < 300) {
      const body = await response.json();
      return this.buildSnapshot(ref, body, response, nowIso);
    }
    if (response.status === 404) {
      throw new ProviderUnavailableError('github', `resource not found: ${ref.resource_id}`, { status: 404 });
    }
    throw await this.errorFrom(response, url);
  }

  private async fetchPullRequest(ref: StateDependency, parsed: ParsedId, nowIso: string): Promise<StateSnapshot> {
    const url = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    const response = await this.request(url, null);
    if (response.status === 404) {
      throw new ProviderUnavailableError('github', `pull request not found: ${ref.resource_id}`, { status: 404 });
    }
    if (!response.ok) {
      throw await this.errorFrom(response, url);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const snapshot = this.buildSnapshot(ref, body, response, nowIso);

    if (this.options.includeReviews) {
      const reviewUrl = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/reviews?per_page=100`;
      const reviewResponse = await this.request(reviewUrl, null);
      if (reviewResponse.ok) {
        const reviews = (await reviewResponse.json()) as Array<Record<string, unknown>>;
        (snapshot.metadata as Record<string, unknown>)['review_status'] = aggregateReviews(reviews);
      }
    }
    return snapshot;
  }

  private async fetchIssue(ref: StateDependency, parsed: ParsedId, nowIso: string): Promise<StateSnapshot> {
    const url = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
    const response = await this.request(url, null);
    if (response.status === 404) {
      throw new ProviderUnavailableError('github', `issue not found: ${ref.resource_id}`, { status: 404 });
    }
    if (!response.ok) {
      throw await this.errorFrom(response, url);
    }
    const body = await response.json();
    return this.buildSnapshot(ref, body, response, nowIso);
  }

  private async fetchBranch(ref: StateDependency, parsed: ParsedId, nowIso: string): Promise<StateSnapshot> {
    const url = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(parsed.branch ?? '')}`;
    const response = await this.request(url, null);
    if (!response.ok) {
      if (response.status === 404) {
        throw new ProviderUnavailableError('github', `branch not found: ${ref.resource_id}`, { status: 404 });
      }
      throw await this.errorFrom(response, url);
    }
    const body = await response.json();
    return this.buildSnapshot(ref, body, response, nowIso);
  }

  private async fetchCiStatus(ref: StateDependency, parsed: ParsedId, nowIso: string): Promise<StateSnapshot> {
    const url = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}/commits/${parsed.sha}/status`;
    const response = await this.request(url, null);
    if (!response.ok) {
      throw await this.errorFrom(response, url);
    }
    const body = await response.json();
    return this.buildSnapshot(ref, body, response, nowIso);
  }

  private async fetchDeployment(ref: StateDependency, parsed: ParsedId, nowIso: string): Promise<StateSnapshot> {
    const url = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}/deployments?environment=${encodeURIComponent(parsed.environment ?? '')}&per_page=1`;
    const response = await this.request(url, null);
    if (!response.ok) {
      throw await this.errorFrom(response, url);
    }
    const deployments = (await response.json()) as Array<Record<string, unknown>>;
    const latest = deployments[0];
    if (!latest) {
      throw new ProviderResponseError('github', `no deployment found for environment "${parsed.environment}"`);
    }
    const statusesUrl = typeof latest['statuses_url'] === 'string' ? latest['statuses_url'] : null;
    let deploymentState: string | null = null;
    if (statusesUrl) {
      const statusResponse = await this.request(statusesUrl, null);
      if (statusResponse.ok) {
        const statuses = (await statusResponse.json()) as Array<Record<string, unknown>>;
        const newest = statuses[0];
        deploymentState = newest ? String(newest['state']) : null;
      }
    }
    const merged: Record<string, unknown> = {
      ...latest,
      state: deploymentState,
      environment: parsed.environment,
    };
    const snapshot = this.buildSnapshot(ref, merged, response, nowIso);
    snapshot.version = latest['id'] !== undefined ? String(latest['id']) : snapshot.version;
    snapshot.metadata['state'] = deploymentState;
    return snapshot;
  }

  private async fetchRelease(ref: StateDependency, parsed: ParsedId, nowIso: string): Promise<StateSnapshot> {
    const url = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}/releases/tags/${encodeURIComponent(parsed.tag ?? '')}`;
    const response = await this.request(url, null);
    if (!response.ok) {
      if (response.status === 404) {
        throw new ProviderUnavailableError('github', `release not found: ${ref.resource_id}`, { status: 404 });
      }
      throw await this.errorFrom(response, url);
    }
    const body = (await response.json()) as Record<string, unknown>;
    const snapshot = this.buildSnapshot(ref, body, response, nowIso);
    snapshot.version = body['id'] !== undefined ? String(body['id']) : snapshot.version;
    return snapshot;
  }

  private buildSnapshot(ref: StateDependency, body: unknown, response: Response, nowIso: string): StateSnapshot {
    const etag = response.headers.get('etag');
    if (etag) {
      this.etags.set(refKeyOf(ref), etag);
    }
    const metadata = extractMetadata(ref.resource, body);
    const provenance: StateProvenance = {
      provider: this.name,
      retrieved_at: nowIso,
      time_source: 'server',
      validation_method: 'full_fetch',
    };
    return {
      snapshot_id: newId(ID_PREFIXES.snapshot, Date.parse(nowIso)),
      source: ref.source,
      resource: ref.resource,
      resource_id: ref.resource_id,
      observed_at: typeof metadata['updated_at'] === 'string' ? metadata['updated_at'] : nowIso,
      version: pickVersion(ref.resource, metadata, etag),
      content_hash: `sha256:${sha256Hex(JSON.stringify(metadata))}`,
      metadata,
      provenance,
    };
  }

  private urlFor(resource: string, parsed: ParsedId): string {
    const base = `${this.options.apiBase}/repos/${parsed.owner}/${parsed.repo}`;
    switch (resource) {
      case 'pull_request':
        return `${base}/pulls/${parsed.number}`;
      case 'issue':
        return `${base}/issues/${parsed.number}`;
      case 'branch':
        return `${base}/branches/${encodeURIComponent(parsed.branch ?? '')}`;
      case 'ci_status':
        return `${base}/commits/${parsed.sha}/status`;
      case 'release':
        return `${base}/releases/tags/${encodeURIComponent(parsed.tag ?? '')}`;
      default:
        return base;
    }
  }

  private async request(url: string, etag: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'stale-state-firewall',
    };
    const token = this.token();
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }
    if (etag) {
      headers['if-none-match'] = etag;
    }
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      return await doFetch(url, { headers, signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderUnavailableError('github', message, { url: sanitizeUrl(url) });
    }
  }

  private async errorFrom(response: Response, url: string): Promise<ProviderUnavailableError> {
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const resetAt = resetHeader ? new Date(Number(resetHeader) * 1000).toISOString() : 'unknown';
      return new ProviderUnavailableError('github', `rate limit exhausted; resets at ${resetAt}`, {
        status: 403,
        url: sanitizeUrl(url),
      });
    }
    let detail = '';
    try {
      const body = (await response.json()) as Record<string, unknown>;
      detail = typeof body['message'] === 'string' ? `: ${body['message']}` : '';
    } catch {
      detail = '';
    }
    return new ProviderUnavailableError('github', `HTTP ${response.status}${detail}`, {
      status: response.status,
      url: sanitizeUrl(url),
    });
  }
}

function refKeyOf(ref: { source: string; resource: string; resource_id: string }): string {
  return `${ref.source}:${ref.resource}/${ref.resource_id}`;
}

/** Version signal priority per resource (spec §18: no single universal signal). */
function pickVersion(resource: string, metadata: Record<string, unknown>, etag: string | null): string | null {
  if (resource === 'pull_request') {
    return metadata['head_sha'] as string | null ?? etag;
  }
  if (resource === 'branch') {
    return metadata['commit_sha'] as string | null ?? etag;
  }
  if (resource === 'ci_status') {
    return metadata['sha'] as string | null ?? etag;
  }
  if (resource === 'issue') {
    return etag ?? (metadata['updated_at'] as string | null);
  }
  return etag;
}

function extractMetadata(resource: string, body: unknown): Record<string, unknown> {
  const b = body as Record<string, unknown>;
  switch (resource) {
    case 'pull_request':
      return {
        state: b['state'],
        draft: b['draft'],
        merged: b['merged'],
        mergeable_state: b['mergeable_state'],
        head_sha: (b['head'] as Record<string, unknown> | undefined)?.['sha'] ?? null,
        base_sha: (b['base'] as Record<string, unknown> | undefined)?.['sha'] ?? null,
        updated_at: b['updated_at'],
        commits: b['commits'],
      };
    case 'issue':
      return { state: b['state'], state_reason: b['state_reason'], updated_at: b['updated_at'], labels: b['labels'] };
    case 'branch': {
      const commit = b['commit'] as Record<string, unknown> | undefined;
      return {
        commit_sha: commit?.['sha'] ?? null,
        protected: b['protected'],
        updated_at: (commit as Record<string, unknown> | undefined)?.['sha'] ? undefined : undefined,
      };
    }
    case 'ci_status':
      return { state: b['state'], sha: b['sha'], total_count: b['total_count'] };
    case 'deployment':
    case 'release':
      return { ...b };
    default:
      return {};
  }
}

/** Aggregates PR reviews into a deterministic review_status signal. */
export function aggregateReviews(reviews: Array<Record<string, unknown>>): string {
  const latestByUser = new Map<string, string>();
  for (const review of reviews) {
    const user = review['user'] as Record<string, unknown> | undefined;
    const login = user?.['login'];
    const state = review['state'];
    if (typeof login === 'string' && typeof state === 'string') {
      if (state === 'APPROVED' || state === 'CHANGES_REQUESTED' || state === 'DISMISSED') {
        latestByUser.set(login, state);
      }
    }
  }
  const states = [...latestByUser.values()];
  if (states.length === 0) return 'pending';
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return 'pending';
}

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
