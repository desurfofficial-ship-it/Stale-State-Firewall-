/**
 * Log redaction (spec §29).
 *
 * Never log: API keys, OAuth tokens, Authorization headers, secrets, or
 * sensitive tool arguments. Redaction is recursive and key-based; it runs
 * before anything is persisted or logged. Values under sensitive keys are
 * replaced wholesale — partial masking is not attempted, because partial
 * secrets are still secrets.
 */

const SENSITIVE_KEY_PATTERN =
  /^(.*(authorization|auth|token|secret|password|passwd|pwd|api[-_.]?key|apikey|credential|cookie|session[-_.]?id|private[-_.]?key|bearer|set[-_.]?cookie).*)$/i;

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Deeply clones a value, replacing every sensitive-keyed leaf with [REDACTED]. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 24) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactDeep(val, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}
