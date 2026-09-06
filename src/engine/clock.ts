/**
 * Clock abstraction (spec §27).
 *
 * - Provider server timestamps are preferred for state age.
 * - Local durations are computed from an injectable clock so tests and
 *   policy-test fixtures are fully deterministic.
 * - Clock-skew tolerance is explicit and configurable, never implicit.
 */

export interface Clock {
  /** Current wall-clock milliseconds since Unix epoch. */
  nowMs(): number;
  /** Current wall-clock instant as ISO 8601 UTC. */
  nowIso(): string;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }
}

/**
 * Manually advanced clock for deterministic tests and `ssf policy test`
 * fixtures. Monotonic: time never moves backwards.
 */
export class ManualClock implements Clock {
  private currentMs: number;

  constructor(startMs: number | string) {
    this.currentMs = typeof startMs === 'number' ? startMs : Date.parse(startMs);
    if (!Number.isFinite(this.currentMs)) {
      throw new Error(`ManualClock: invalid start instant: ${String(startMs)}`);
    }
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('ManualClock: time cannot move backwards');
    }
    this.currentMs += ms;
  }

  setTo(ms: number | string): void {
    const next = typeof ms === 'number' ? ms : Date.parse(ms);
    if (!Number.isFinite(next)) {
      throw new Error(`ManualClock: invalid instant: ${String(ms)}`);
    }
    if (next < this.currentMs) {
      throw new Error('ManualClock: time cannot move backwards');
    }
    this.currentMs = next;
  }
}
