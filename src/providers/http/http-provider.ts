/**
 * Generic HTTP state provider (spec §17).
 *
 * Serves arbitrary HTTP state sources. Each named resource is configured
 * with a URL template, optional headers (with env() indirection for
 * credentials — values are never logged), version extraction (header or
 * JSON dot-path), server timestamp extraction, and metadata field mapping.
 *
 * Version signals, in priority order:
 *   - configured version extraction (ETag header, JSON revision field, ...)
 *   - the HTTP ETag header
 *   - Last-Modified header
 *   - content hash over the canonical response body
 *
 * Conditional verification uses If-None-Match / If-Modified-Since when a
 * version signal is available; a 304 response is fresh verification that
 * the resource is unchanged (provenance: conditional_304).
 */

import type { StateProvider, ConditionalMutationRequest, ConditionalMutationResult } from '../types.js';
import type { StateDependency, StateSnapshot, StateProvenance } from '../../domain/state.js';
import { newId, ID_PREFIXES } from '../../domain/identifiers.js';
import { sha256Hex } from '../../engine/hashing.js';
import { ProviderUnavailableError, ProviderResponseError } from '../../domain/errors.js';
import type { HttpResourceConfig } from '../../config/schema.js';

export class HttpStateProvider implements StateProvider {
  readonly name = 'http';
  private readonly resources: Record<string, HttpResourceConfig>;

  constructor(resources: Record<string, HttpResourceConfig>) {
    this.resources = resources;
  }

  supports(ref: { source: string; resource: string }): boolean {
    return ref.source === this.name && this.resources[ref.resource] !== undefined;
  }

  supportsConditionalVerification(): boolean {
    return true;
  }

  /**
   * Conditional execution (If-Match) is available ONLY for resources whose
   * config declares a mutation endpoint. A generic HTTP endpoint provides no
   * atomicity guarantee unless the operator has verified the server honors
   * If-Match (RFC 9110 preconditions); that is an explicit configuration act,
   * not an assumption (milestone: atomic effect assurance, §14).
   */
  supportsConditionalExecution(): boolean {
    return Object.values(this.resources).some((r) => r.mutation !== undefined);
  }

  /**
   * Performs the configured mutation with an `If-Match: <expected_version>`
   * precondition. The condition is evaluated BY THE SERVER as part of the
   * mutation request itself: 412/409 (or the configured statuses) mean the
   * server refused the stale operation — no side effect occurred. Any other
   * non-2xx is a provider error, NOT a condition failure.
   */
  async conditionalExecute(request: ConditionalMutationRequest): Promise<ConditionalMutationResult> {
    const config = this.resources[request.ref.resource];
    if (!config || config.mutation === undefined) {
      throw new ProviderResponseError(
        this.name,
        `resource "${request.ref.resource}" does not declare a conditional mutation endpoint`,
      );
    }
    if (request.expected_version === '') {
      throw new ProviderResponseError(this.name, 'conditional mutation requires a non-empty expected version');
    }
    const mutation = config.mutation;
    const url = (mutation.url ?? config.url).replace('{id}', encodeURIComponent(request.ref.resource_id));
    const headers: Record<string, string> = {
      ...resolveHeaders(config.headers),
      'content-type': 'application/json',
      // THE CONDITION: the server must refuse the operation unless its
      // current representation still matches this validator.
      'if-match': request.expected_version,
    };
    const body = JSON.stringify({ ...(mutation.body ?? {}), ...request.changes });
    const timeoutMs = config.timeout_ms ?? 5000;

    let response: Response;
    try {
      response = await fetch(url, {
        method: mutation.method ?? 'PUT',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderUnavailableError(this.name, message, { url: sanitizeUrl(url) });
    }

    if (response.status >= 200 && response.status < 300) {
      return { outcome: 'executed', version: this.versionFromMutationResponse(config, response) };
    }
    const conditionFailedStatuses = mutation.condition_failed_status ?? [412, 409];
    if (conditionFailedStatuses.includes(response.status)) {
      // Server refused the stale operation; no side effect occurred.
      return { outcome: 'condition_failed', current_version: response.headers.get('etag') };
    }
    throw new ProviderUnavailableError(
      this.name,
      `conditional mutation on ${sanitizeUrl(url)} failed with HTTP ${response.status}`,
      { status: response.status },
    );
  }

  /** Extracts the post-mutation version signal (configured extraction, else ETag). */
  private versionFromMutationResponse(config: HttpResourceConfig, response: Response): string | null {
    const etag = response.headers.get('etag');
    if (config.version?.source === 'header') {
      const header = response.headers.get(config.version.name);
      if (header !== null) return header;
    }
    return etag;
  }

  async getState(ref: StateDependency, nowIso: string): Promise<StateSnapshot> {
    const config = this.resources[ref.resource];
    if (!config) {
      throw new ProviderResponseError(this.name, `resource "${ref.resource}" is not configured`);
    }
    const url = config.url.replace('{id}', encodeURIComponent(ref.resource_id));
    const headers = resolveHeaders(config.headers);
    const timeoutMs = config.timeout_ms ?? 5000;

    const response = await fetchWithTimeout(url, { headers, timeoutMs, conditionalVersion: null });
    if (!response.ok) {
      throw new ProviderUnavailableError(
        this.name,
        `GET ${sanitizeUrl(url)} failed with HTTP ${response.status}`,
        { status: response.status },
      );
    }

    const bodyText = await response.text();
    let body: unknown;
    try {
      body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
    } catch {
      throw new ProviderResponseError(this.name, 'response body is not valid JSON', { url: sanitizeUrl(url) });
    }

    return this.snapshotFrom(ref, config, response, body, bodyText, nowIso, false);
  }

  async getConditional(ref: StateDependency, nowIso: string): Promise<StateSnapshot | null> {
    if (ref.version === null) return null;
    const config = this.resources[ref.resource];
    if (!config) return null;

    const url = config.url.replace('{id}', encodeURIComponent(ref.resource_id));
    const headers = resolveHeaders(config.headers);
    const timeoutMs = config.timeout_ms ?? 5000;

    const response = await fetchWithTimeout(url, {
      headers,
      timeoutMs,
      conditionalVersion: ref.version,
    });

    if (response.status === 304) {
      // A 304 attests "unchanged since <etag>" — it carries NO content the
      // server vouches for. Preconditions therefore can never be evaluated on
      // this path (the firewall forces a full fetch when preconditions are
      // routed here), and the snapshot must not echo agent-supplied metadata
      // as if it were current state.
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
        metadata: {},
        provenance,
        unchanged_since_observed: true,
      };
    }
    if (response.ok) {
      const bodyText = await response.text();
      let body: unknown;
      try {
        body = bodyText.length > 0 ? JSON.parse(bodyText) : {};
      } catch {
        throw new ProviderResponseError(this.name, 'response body is not valid JSON', { url: sanitizeUrl(url) });
      }
      return this.snapshotFrom(ref, config, response, body, bodyText, nowIso, false);
    }
    throw new ProviderUnavailableError(this.name, `GET ${sanitizeUrl(url)} failed with HTTP ${response.status}`, {
      status: response.status,
    });
  }

  private snapshotFrom(
    ref: StateDependency,
    config: HttpResourceConfig,
    response: Response,
    body: unknown,
    bodyText: string,
    nowIso: string,
    unchanged: boolean,
  ): StateSnapshot {
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    let version: string | null = null;
    if (config.version) {
      const rawVersion =
        config.version.source === 'header'
          ? response.headers.get(config.version.name)
          : jsonPathValue(body, config.version.name);
      version = rawVersion === null || rawVersion === undefined ? null : String(rawVersion);
    }
    version ??= etag;
    version ??= lastModified;

    let observedAt = nowIso;
    if (config.observed_at) {
      const raw = jsonPathValue(body, config.observed_at.name);
      observedAt = normalizeTimestamp(raw, config.observed_at.format);
    }

    const metadata: Record<string, unknown> = {};
    for (const [key, path] of Object.entries(config.metadata_paths ?? {})) {
      metadata[key] = jsonPathValue(body, path);
    }

    const contentHash =
      config.content_hash === 'off' ? null : `sha256:${sha256Hex(bodyText)}`;

    const provenance: StateProvenance = {
      provider: this.name,
      retrieved_at: nowIso,
      time_source: config.observed_at ? 'server' : 'client',
      validation_method: unchanged ? 'conditional_304' : 'full_fetch',
    };

    return {
      snapshot_id: newId(ID_PREFIXES.snapshot, Date.parse(nowIso)),
      source: ref.source,
      resource: ref.resource,
      resource_id: ref.resource_id,
      observed_at: observedAt,
      version,
      content_hash: contentHash,
      metadata,
      provenance,
      ...(unchanged ? { unchanged_since_observed: true } : {}),
    };
  }
}

function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers ?? {})) {
    const match = /^env\(([A-Za-z_][A-Za-z0-9_]*)\)$/.exec(raw);
    out[key] = match ? (process.env[match[1]!] ?? '') : raw;
  }
  return out;
}

function normalizeTimestamp(raw: unknown, format: 'iso' | 'epoch_s' | 'epoch_ms'): string {
  if (raw === null || raw === undefined) {
    throw new ProviderResponseError('http', `observed_at field is missing from the response`);
  }
  if (format === 'epoch_s' && (typeof raw === 'number' || typeof raw === 'string')) {
    return new Date(Number(raw) * 1000).toISOString();
  }
  if (format === 'epoch_ms' && (typeof raw === 'number' || typeof raw === 'string')) {
    return new Date(Number(raw)).toISOString();
  }
  const parsed = Date.parse(String(raw));
  if (Number.isNaN(parsed)) {
    throw new ProviderResponseError('http', `observed_at value "${String(raw)}" is not a parseable timestamp`);
  }
  return new Date(parsed).toISOString();
}

/** Resolves a dot path like "deployment.status" or "items.0.state"; a leading "$." (JSONPath style) is tolerated. */
export function jsonPathValue(body: unknown, path: string): unknown {
  const normalized = path.startsWith('$.') ? path.slice(2) : path === '$' ? '' : path;
  if (normalized.length === 0) return body;
  let current: unknown = body;
  for (const segment of normalized.split('.')) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return null;
  }
  return current;
}

export async function fetchWithTimeout(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs: number; conditionalVersion: string | null },
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.conditionalVersion !== null) {
    headers['if-none-match'] = options.conditionalVersion;
  }
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(options.timeoutMs), redirect: 'follow' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderUnavailableError('http', message, { url: sanitizeUrl(url) });
  }
}

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
