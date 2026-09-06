import { describe, it, expect } from 'vitest';
import { evaluateFreshness, UnavailableCurrentState } from '../../src/engine/freshness.js';
import { resolveFreshness } from '../../src/engine/resolved-policy.js';
import type { StateDependency } from '../../src/domain/state.js';
import type { StateSnapshot } from '../../src/domain/state.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');

function dependency(overrides: Partial<StateDependency> = {}): StateDependency {
  return {
    source: 'memory',
    resource: 'thing',
    resource_id: 'a1',
    version: 'v1',
    content_hash: null,
    observed_at: new Date(NOW - 1_000).toISOString(),
    metadata: {},
    ...overrides,
  };
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    snapshot_id: 'snap_test',
    source: 'memory',
    resource: 'thing',
    resource_id: 'a1',
    observed_at: new Date(NOW).toISOString(),
    version: 'v1',
    content_hash: 'sha256:x',
    metadata: {},
    provenance: {
      provider: 'memory',
      retrieved_at: new Date(NOW).toISOString(),
      time_source: 'client',
      validation_method: 'full_fetch',
    },
    ...overrides,
  };
}

function freshness(config: Parameters<typeof resolveFreshness>[0]): ReturnType<typeof resolveFreshness> {
  return resolveFreshness(config, undefined, undefined, 'test');
}

describe('freshness engine — TTL strategy (spec §7 Strategy A)', () => {
  const ttl = freshness({ strategy: 'ttl', max_age: '10s', aging_threshold: 0.75 });

  it('FRESH inside the window', () => {
    const result = evaluateFreshness({
      dependency: dependency({ observed_at: new Date(NOW - 5_000).toISOString() }),
      current: snapshot(),
      freshness: ttl,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('FRESH');
  });

  it('AGING approaching the boundary', () => {
    const result = evaluateFreshness({
      dependency: dependency({ observed_at: new Date(NOW - 8_000).toISOString() }),
      current: snapshot(),
      freshness: ttl,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('AGING');
  });

  it('STALE past the boundary -> REVALIDATE territory, not allow', () => {
    const result = evaluateFreshness({
      dependency: dependency({ observed_at: new Date(NOW - 11_000).toISOString() }),
      current: snapshot(),
      freshness: ttl,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('STALE');
  });

  it('missing observed_at is UNKNOWN, never FRESH', () => {
    const result = evaluateFreshness({
      dependency: dependency({ observed_at: null }),
      current: snapshot(),
      freshness: ttl,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('UNKNOWN');
  });

  it('future observed_at beyond skew tolerance is UNKNOWN (anti-fabrication)', () => {
    const result = evaluateFreshness({
      dependency: dependency({ observed_at: new Date(NOW + 60_000).toISOString() }),
      current: snapshot(),
      freshness: ttl,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('UNKNOWN');
    expect(result.reason).toContain('future');
  });

  it('clock-skew tolerance widens the effective boundary explicitly', () => {
    const skewy = freshness({ strategy: 'ttl', max_age: '10s', clock_skew_tolerance: '5s' });
    const result = evaluateFreshness({
      // observed 13s ago: past the 10s boundary, but the explicit 5s skew
      // tolerance widens the effective age to 8s (AGING band).
      dependency: dependency({ observed_at: new Date(NOW - 13_000).toISOString() }),
      current: snapshot(),
      freshness: skewy,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('AGING');

    const conservative = evaluateFreshness({
      // Same age with zero skew tolerance stays STALE: skew must be explicit.
      dependency: dependency({ observed_at: new Date(NOW - 13_000).toISOString() }),
      current: snapshot(),
      freshness: freshness({ strategy: 'ttl', max_age: '10s' }),
      preconditions: [],
      nowMs: NOW,
    });
    expect(conservative.staleness).toBe('STALE');
  });
});

describe('freshness engine — version strategy (spec §7 Strategy B)', () => {
  const version = freshness({ strategy: 'version' });

  it('FRESH when versions match', () => {
    const result = evaluateFreshness({
      dependency: dependency({ version: 'sha:abc' }),
      current: snapshot({ version: 'sha:abc' }),
      freshness: version,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('FRESH');
  });

  it('INVALID when the version changed, regardless of age', () => {
    const result = evaluateFreshness({
      dependency: dependency({ version: 'sha:abc', observed_at: new Date(NOW - 10).toISOString() }),
      current: snapshot({ version: 'sha:def' }),
      freshness: version,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('INVALID');
    expect(result.reason).toContain('sha:abc');
    expect(result.reason).toContain('sha:def');
  });

  it('UNKNOWN when the agent declares no version (fail closed)', () => {
    const result = evaluateFreshness({
      dependency: dependency({ version: null }),
      current: snapshot({ version: 'sha:abc' }),
      freshness: version,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('UNKNOWN');
  });

  it('UNKNOWN when the provider exposes no version', () => {
    const result = evaluateFreshness({
      dependency: dependency({ version: 'sha:abc' }),
      current: snapshot({ version: null }),
      freshness: version,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('UNKNOWN');
  });

  it('FRESH via conditional 304 verification (unchanged since observed)', () => {
    const result = evaluateFreshness({
      dependency: dependency({ version: 'etag-1' }),
      current: snapshot({ version: 'etag-1', unchanged_since_observed: true }),
      freshness: version,
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('FRESH');
    expect(result.reason).toContain('conditional');
  });
});

describe('freshness engine — hash strategy (spec §7 Strategy C)', () => {
  const hash = freshness({ strategy: 'hash' });

  it('FRESH on equal hashes; INVALID when the content hash differs', () => {
    const fresh = evaluateFreshness({
      dependency: dependency({ content_hash: 'sha256:same' }),
      current: snapshot({ content_hash: 'sha256:same' }),
      freshness: hash,
      preconditions: [],
      nowMs: NOW,
    });
    expect(fresh.staleness).toBe('FRESH');

    const changed = evaluateFreshness({
      dependency: dependency({ content_hash: 'sha256:old' }),
      current: snapshot({ content_hash: 'sha256:new' }),
      freshness: hash,
      preconditions: [],
      nowMs: NOW,
    });
    expect(changed.staleness).toBe('INVALID');
  });

  it('UNKNOWN when hashes are unavailable on either side', () => {
    expect(
      evaluateFreshness({ dependency: dependency({ content_hash: null }), current: snapshot(), freshness: hash, preconditions: [], nowMs: NOW }).staleness,
    ).toBe('UNKNOWN');
    expect(
      evaluateFreshness({ dependency: dependency({ content_hash: 'sha256:a' }), current: snapshot({ content_hash: null }), freshness: hash, preconditions: [], nowMs: NOW }).staleness,
    ).toBe('UNKNOWN');
  });
});

describe('freshness engine — preconditions strategy (spec §7 Strategy D)', () => {
  const prec = freshness({ strategy: 'preconditions' });

  it('FRESH when all invariants hold against current state', () => {
    const result = evaluateFreshness({
      dependency: dependency(),
      current: snapshot({ metadata: { status: 'healthy' } }),
      freshness: prec,
      preconditions: [{ field: 'status', operator: 'equals', value: 'healthy' }],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('FRESH');
  });

  it('INVALID when an invariant fails against current state', () => {
    const result = evaluateFreshness({
      dependency: dependency(),
      current: snapshot({ metadata: { status: 'degraded' } }),
      freshness: prec,
      preconditions: [{ field: 'status', operator: 'equals', value: 'healthy' }],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('INVALID');
  });
});

describe('freshness engine — hybrid strategy (spec §7 Strategy E)', () => {
  const hybrid = freshness({
    strategy: 'hybrid',
    max_age: '10s',
    hybrid: { ttl: true, version: true, hash: false, preconditions: true },
  });

  it('worst component wins across ttl + version + preconditions', () => {
    const staleButSameVersion = evaluateFreshness({
      dependency: dependency({ observed_at: new Date(NOW - 60_000).toISOString(), version: 'v1' }),
      current: snapshot({ version: 'v1', metadata: { status: 'ok' } }),
      freshness: hybrid,
      preconditions: [{ field: 'status', operator: 'equals', value: 'ok' }],
      nowMs: NOW,
    });
    expect(staleButSameVersion.staleness).toBe('STALE');

    const freshAgeButInvalidVersion = evaluateFreshness({
      dependency: dependency({ observed_at: new Date(NOW - 5).toISOString(), version: 'v1' }),
      current: snapshot({ version: 'v2', metadata: { status: 'ok' } }),
      freshness: hybrid,
      preconditions: [{ field: 'status', operator: 'equals', value: 'ok' }],
      nowMs: NOW,
    });
    expect(freshAgeButInvalidVersion.staleness).toBe('INVALID');
  });
});

describe('freshness engine — provider failures', () => {
  it('unavailable current state maps to UNKNOWN, never FRESH (invariant 7)', () => {
    const result = evaluateFreshness({
      dependency: dependency(),
      current: new UnavailableCurrentState('connection refused'),
      freshness: freshness({ strategy: 'ttl', max_age: '10s' }),
      preconditions: [],
      nowMs: NOW,
    });
    expect(result.staleness).toBe('UNKNOWN');
    expect(result.reason).toContain('connection refused');
  });
});
