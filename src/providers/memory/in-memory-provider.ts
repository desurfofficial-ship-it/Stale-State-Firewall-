/**
 * In-memory state provider (spec §16, §65).
 *
 * A real StateProvider implementation backed by mutable local state. It
 * exists for tests, examples, policy-test fixtures, and offline simulation.
 * It fully implements the provider contract, including version bumping,
 * conditional verification, and provenance. It is never used to enforce
 * decisions in production paths unless an operator explicitly configures it.
 */

import type { StateProvider, ConditionalMutationRequest, ConditionalMutationResult } from '../types.js';
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
  /** Timestamp recorded for CAS mutations (settable for deterministic tests). */
  private lastMutationClock: string | null = null;

  constructor(sourceName = 'memory') {
    this.sourceName = sourceName;
  }

  /** Pins the timestamp used by subsequent conditionalExecute mutations. */
  setMutationClock(atIso: string | null): void {
    this.lastMutationClock = atIso;
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
   * This provider performs mutations whose check and write happen inside one
   * synchronous operation: conditional execution is genuinely supported.
   */
  supportsConditionalExecution(): boolean {
    return true;
  }

  /**
   * Deterministic atomic compare-and-swap mutation (milestone: atomic effect
   * assurance). The version comparison and the mutation happen SYNCHRONOUSLY
   * in the same call — the JS event loop cannot interleave another operation
   * between them, so no separate get() then set() race exists. When the
   * resource is not at `expected_version`, nothing is mutated and the
   * provider reports condition_failed with the version it actually saw.
   */
  conditionalExecute(request: ConditionalMutationRequest): Promise<ConditionalMutationResult> {
    const key = this.key(request.ref.resource, request.ref.resource_id);
    const existing = this.resources.get(key);

    // ---- atomic check-and-mutate: no await between compare and write ------
    if (!existing || existing.version !== request.expected_version) {
      // Unknown or changed resource: the authorized state is not true, the
      // provider refuses. current_version is null for unknown resources.
      return Promise.resolve({ outcome: 'condition_failed', current_version: existing?.version ?? null });
    }

    this.versionCounter += 1;
    const newVersion = `v${this.versionCounter}`;
    const previousVersion = existing.version;
    this.resources.set(key, {
      ...existing,
      version: newVersion,
      metadata: { ...existing.metadata, ...request.changes },
      updated_at: this.lastMutationClock ?? existing.updated_at,
    });
    const log = this.mutations.get(key) ?? [];
    log.push({
      at: this.lastMutationClock ?? existing.updated_at,
      previous_version: previousVersion,
      new_version: newVersion,
      changes: request.changes,
    });
    this.mutations.set(key, log);
    return Promise.resolve({ outcome: 'executed', version: newVersion });
  }

  /**
   * Registers or replaces a resource. Version semantics are deliberate and
   * differ by case (FL-9):
   * - NEW resource, `version` omitted: a monotonic v-counter is assigned.
   * - EXISTING resource, `version` omitted: the CURRENT version is KEPT —
   *   a content replace that is invisible to CAS comparisons held at the
   *   old version. This is a re-seeding convenience for fixtures; it is NOT
   *   an external-actor mutation and must never be used to simulate one.
   * - An explicit `version` argument always wins (tests pin exact versions).
   * To simulate a concurrent external actor, use `mutate()`: it always
   * advances the version, so stale CAS comparisons honestly report
   * condition_failed.
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
