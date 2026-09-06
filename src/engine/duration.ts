import { ConfigurationError } from '../domain/errors.js';

/**
 * Strict duration parser. Accepted forms:
 *   500      -> 500 ms
 *   "500ms"  -> 500 ms
 *   "10s"    -> 10_000 ms
 *   "2m"     -> 120_000 ms
 *   "1h"     -> 3_600_000 ms
 *   "7d"     -> 604_800_000 ms
 * Anything else is a ConfigurationError — malformed durations must be
 * rejected before enforcement, never silently coerced.
 */
export function parseDurationMs(input: string | number | undefined | null, field = 'duration'): number {
  if (input === undefined || input === null) {
    throw new ConfigurationError(`${field}: duration is required`);
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new ConfigurationError(`${field}: duration must be a finite non-negative number (ms), got ${input}`);
    }
    return Math.round(input);
  }
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new ConfigurationError(
      `${field}: invalid duration "${input}" (expected forms: 500ms, 10s, 2m, 1h, 7d)`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] as 'ms' | 's' | 'm' | 'h' | 'd';
  const multipliers: Record<typeof unit, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * multipliers[unit];
}

export function formatDurationMs(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
