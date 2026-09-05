import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization: object keys sorted lexicographically,
 * arrays in order, no insignificant whitespace. Two structurally equal
 * values always serialize to the same bytes, which makes content hashes
 * and audit hash chains deterministic.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (typeof value === 'number') {
    // Non-finite numbers must not coerce to null (JSON.stringify would emit
    // "null"), otherwise `equals` would treat NaN/Infinity as equal to null.
    if (!Number.isFinite(value)) {
      return JSON.stringify(`__nonfinite:${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => typeof record[k] !== 'undefined').sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k])}`);
    return `{${parts.join(',')}}`;
  }
  // Functions, symbols, bigint: not representable; degrade deterministically.
  return 'null';
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function contentHashOf(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}
