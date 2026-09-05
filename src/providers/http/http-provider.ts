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

import type { StateProvider } from '../types.js';
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
