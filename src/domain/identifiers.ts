import { randomBytes } from 'node:crypto';

/**
 * Generates a sortable, collision-resistant identifier.
 *
 * Format: `<prefix>_<base36 millisecond timestamp>_<base36 randomness>`
 * The timestamp component keeps ids lexicographically ordered by creation
 * time, which makes storage scans and audit forensics deterministic.
 */
export function newId(prefix: string, nowMs: number, random: (bytes: number) => Buffer = defaultRandom): string {
  const ts = nowMs.toString(36).padStart(9, '0');
  const rand = random(8).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

const defaultRandom = (bytes: number): Buffer => randomBytes(bytes);

export const ID_PREFIXES = {
  snapshot: 'snap',
  action: 'act',
  decision: 'dec',
  audit: 'evt',
  execution: 'exe',
} as const;
