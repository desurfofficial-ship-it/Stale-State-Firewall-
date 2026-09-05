/**
 * In-memory state provider (spec §16, §65).
 *
 * A real StateProvider implementation backed by mutable local state. It
 * exists for tests, examples, policy-test fixtures, and offline simulation.
 * It fully implements the provider contract, including version bumping,
 * conditional verification, and provenance. It is never used to enforce
 * decisions in production paths unless an operator explicitly configures it.
 */

import type { StateProvider } from '../types.js';
import type { StateDependency, StateSnapshot, StateProvenance } from '../../domain/state.js';
import { newId, ID_PREFIXES } from '../../domain/identifiers.js';
import { contentHashOf } from '../../engine/hashing.js';

export interface InMemoryResource {
  /** Current version marker; bumped on every mutation. */
  version: string;
  /** Structured metadata visible to preconditions. */
  metadata: Record<string, unknown>;
  /** ISO timestamp of the last mutation. */
  updated_at: string;
  /** Optional server timestamp override for observed_at. */
  server_time?: string;
  /** Whether conditional (unchanged) verification is simulated as supported. */
  supports_conditional?: boolean;
}

export interface InMemoryMutation {
  at: string;
  previous_version: string;
  new_version: string;
  changes: Record<string, unknown>;
}

export class InMemoryStateProvider implements StateProvider {
  readonly name = 'memory';
  private readonly sourceName: string;
  private readonly resources = new Map<string, InMemoryResource>();
  private readonly mutations = new Map<string, InMemoryMutation[]>();
  private versionCounter = 0;

  constructor(sourceName = 'memory') {
    this.sourceName = sourceName;
  }

  get source(): string {
    return this.sourceName;
  }

  supports(ref: { source: string; resource: string; resource_id: string }): boolean {
    return ref.source === this.sourceName && this.resources.has(this.key(ref.resource, ref.resource_id));
  }

  supportsConditionalVerification(): boolean {
    return true;
  }

  /**
   * Registers or replaces a resource. When `version` is omitted a monotonic
   * v-counter is used; fixtures and tests may pin explicit versions.
   * `serverTimeIso` marks the resource as carrying a provider-server stamp
   * (provenance time_source "server") for the given observation timestamp.
   */
  put(
    resource: string,
    resourceId: string,
    metadata: Record<string, unknown>,
    updatedAtIso: string,
    version?: string,
    serverTimeIso?: string,
  ): void {
    const key = this.key(resource, resourceId);
    const existing = this.resources.get(key);
    this.versionCounter += 1;
    this.resources.set(key, {
      version: version ?? (existing ? existing.version : `v${this.versionCounter}`),
      metadata,
      updated_at: updatedAtIso,
      server_time: serverTimeIso ?? existing?.server_time,
      supports_conditional: existing?.supports_conditional ?? true,
    });
  }

  /** Simulates an external actor mutating the resource; version is bumped. */
  mutate(resource: string, resourceId: string, changes: Record<string, unknown>, atIso: string): string {
    const key = this.key(resource, resourceId);
    const existing = this.resources.get(key);
    if (!existing) {
      throw new Error(`in-memory provider: cannot mutate unknown resource ${resource}/${resourceId}`);
    }
    this.versionCounter += 1;
    const newVersion = `v${this.versionCounter}`;
    const previousVersion = existing.version;
    this.resources.set(key, {
      ...existing,
      version: newVersion,
      metadata: { ...existing.metadata, ...changes },
      updated_at: atIso,
    });
    const log = this.mutations.get(key) ?? [];
    log.push({ at: atIso, previous_version: previousVersion, new_version: newVersion, changes });
    this.mutations.set(key, log);
    return newVersion;
  }

  get(resource: string, resourceId: string): InMemoryResource | null {
    return this.resources.get(this.key(resource, resourceId)) ?? null;
  }

  mutationLog(resource: string, resourceId: string): InMemoryMutation[] {
    return [...(this.mutations.get(this.key(resource, resourceId)) ?? [])];
  }

  async getState(ref: StateDependency, nowIso: string): Promise<StateSnapshot> {
    const key = this.key(ref.resource, ref.resource_id);
    const resource = this.resources.get(key);
    if (!resource) {
      throw new Error(`in-memory provider: unknown resource ${ref.resource}/${ref.resource_id}`);
    }
    const provenance: StateProvenance = {
      provider: this.name,
      retrieved_at: nowIso,
      time_source: resource.server_time ? 'server' : 'client',
      validation_method: 'full_fetch',
    };
    return {
      snapshot_id: newId(ID_PREFIXES.snapshot, Date.parse(nowIso)),
      source: ref.source,
      resource: ref.resource,
      resource_id: ref.resource_id,
      observed_at: resource.server_time ?? resource.updated_at,
      version: resource.version,
      content_hash: contentHashOf(resource.metadata),
      metadata: { ...resource.metadata },
      provenance,
    };
  }

  async getConditional(ref: StateDependency, nowIso: string): Promise<StateSnapshot | null> {
    if (ref.version === null) return null;
    const key = this.key(ref.resource, ref.resource_id);
    const resource = this.resources.get(key);
    if (!resource) return null;
    const resourceWithSupport = resource as InMemoryResource & { supports_conditional?: boolean };
    if (resourceWithSupport.supports_conditional === false) return null;

    if (resource.version === ref.version) {
      const provenance: StateProvenance = {
        provider: this.name,
        retrieved_at: nowIso,
        time_source: resource.server_time ? 'server' : 'client',
        validation_method: 'conditional_304',
      };
      return {
        snapshot_id: newId(ID_PREFIXES.snapshot, Date.parse(nowIso)),
        source: ref.source,
        resource: ref.resource,
        resource_id: ref.resource_id,
        observed_at: ref.observed_at ?? resource.updated_at,
        version: resource.version,
        content_hash: contentHashOf(resource.metadata),
        metadata: { ...resource.metadata },
        provenance,
        unchanged_since_observed: true,
      };
    }
    return null; // changed -> full fetch will report the drift
  }

  private key(resource: string, resourceId: string): string {
    return `${resource}::${resourceId}`;
  }
}
