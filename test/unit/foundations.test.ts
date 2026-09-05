import { describe, it, expect } from 'vitest';
import { ManualClock } from '../../src/engine/clock.js';
import { assessAge, classifyByAge, worstOfAll } from '../../src/engine/staleness.js';
import { parseDurationMs, formatDurationMs } from '../../src/engine/duration.js';
import { globMatch } from '../../src/engine/glob.js';
import { canonicalJson, sha256Hex, contentHashOf } from '../../src/engine/hashing.js';
import { newId } from '../../src/domain/identifiers.js';
import { resolvePath, evaluatePrecondition } from '../../src/engine/preconditions.js';

describe('clock', () => {
  it('advances monotonically and never moves backwards', () => {
    const clock = new ManualClock('2026-09-05T00:00:00Z');
    expect(clock.nowIso()).toBe('2026-09-05T00:00:00.000Z');
    clock.advance(1500);
    expect(clock.nowMs()).toBe(Date.parse('2026-09-05T00:00:01.500Z'));
    expect(() => clock.setTo(0)).toThrow();
  });
});

describe('staleness math (spec §8)', () => {
  it('classifies age into FRESH / AGING / STALE bands', () => {
    expect(classifyByAge(1_000, 10_000, 0.75)).toBe('FRESH');
    expect(classifyByAge(7_500, 10_000, 0.75)).toBe('FRESH');
    expect(classifyByAge(7_501, 10_000, 0.75)).toBe('AGING');
    expect(classifyByAge(9_999, 10_000, 0.75)).toBe('AGING');
    expect(classifyByAge(10_000, 10_000, 0.75)).toBe('STALE');
    expect(classifyByAge(60_000, 10_000, 0.75)).toBe('STALE');
  });

  it('treats future timestamps beyond skew tolerance as anomalous', () => {
    const now = Date.parse('2026-09-05T00:00:00Z');
    const ok = assessAge('2026-09-05T00:00:02Z', now, 5_000);
    expect(ok.anomaly).toBeNull();
    expect(ok.ageMs).toBe(0);
    const bad = assessAge('2026-09-05T00:00:10Z', now, 5_000);
    expect(bad.anomaly).toBe('future_timestamp');
    expect(bad.ageMs).toBeNull();
  });

  it('aggregates with INVALID ranked worst', () => {
    expect(worstOfAll(['FRESH', 'FRESH', 'AGING'])).toBe('AGING');
    expect(worstOfAll(['FRESH', 'STALE'])).toBe('STALE');
    expect(worstOfAll(['STALE', 'UNKNOWN'])).toBe('UNKNOWN');
    expect(worstOfAll(['UNKNOWN', 'INVALID'])).toBe('INVALID');
  });
});

describe('duration parsing', () => {
  it('parses every supported unit', () => {
    expect(parseDurationMs(500)).toBe(500);
    expect(parseDurationMs('500ms')).toBe(500);
    expect(parseDurationMs('10s')).toBe(10_000);
    expect(parseDurationMs('2m')).toBe(120_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
    expect(parseDurationMs('7d')).toBe(604_800_000);
  });

  it('rejects malformed durations instead of coercing', () => {
    expect(() => parseDurationMs('10 s')).toThrow();
    expect(() => parseDurationMs('-5s')).toThrow();
    expect(() => parseDurationMs('abc')).toThrow();
    expect(() => parseDurationMs(undefined, 'f')).toThrow();
  });

  it('round-trips common durations', () => {
    expect(formatDurationMs(10_000)).toBe('10s');
    expect(formatDurationMs(500)).toBe('500ms');
  });
});

describe('glob matching', () => {
  it('supports *, ?, and literals with anchoring', () => {
    expect(globMatch('deploy*', 'deploy_production')).toBe(true);
    expect(globMatch('deploy*', 'undeploy_production')).toBe(false);
    expect(globMatch('merge_pull_request', 'merge_pull_request')).toBe(true);
    expect(globMatch('merge_pull_request', 'merge_pull_request_now')).toBe(false);
    expect(globMatch('v?.*', 'v1.2')).toBe(true);
    expect(globMatch('v?.*', 'v12.3')).toBe(false);
  });
});

describe('canonical hashing', () => {
  it('serializes keys in sorted order regardless of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: { z: 1, y: [2, 1] } })).toBe('{"a":{"y":[2,1],"z":1}}');
  });

  it('produces stable content hashes', () => {
    expect(contentHashOf({ x: 1 })).toBe(contentHashOf({ x: 1 }));
    expect(contentHashOf({ x: 1 })).not.toBe(contentHashOf({ x: 2 }));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('identifiers', () => {
  it('generates sortable, prefixed, unique ids', () => {
    const t0 = Date.parse('2026-09-05T00:00:00Z');
    const a = newId('act', t0);
    const b = newId('act', t0 + 5);
    expect(a.startsWith('act_')).toBe(true);
    expect(a < b).toBe(true);
    const c = newId('act', t0);
    expect(c).not.toBe(a);
  });
});

describe('precondition plumbing', () => {
  it('resolves dot paths including array segments', () => {
    const metadata = { deployment: { status: 'healthy' }, checks: [{ state: 'passed' }] };
    expect(resolvePath(metadata, 'deployment.status').value).toBe('healthy');
    expect(resolvePath(metadata, 'checks.0.state').value).toBe('passed');
    expect(resolvePath(metadata, 'checks.1.state').found).toBe(false);
    expect(resolvePath(metadata, 'deployment.missing').found).toBe(false);
  });

  it('exists treats JSON null as present; missing fields fail other operators closed', () => {
    expect(evaluatePrecondition({ field: 'a', operator: 'exists' }, { a: null }).passed).toBe(true);
    expect(evaluatePrecondition({ field: 'a', operator: 'not_exists' }, {}).passed).toBe(true);
    const missing = evaluatePrecondition({ field: 'a', operator: 'equals', value: 1 }, {});
    expect(missing.passed).toBe(false);
    expect(missing.reason).toContain('absent');
  });
});
