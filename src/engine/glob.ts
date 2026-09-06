/**
 * Minimal deterministic glob matcher used for policy matchers and provider
 * resource patterns. Supported syntax:
 *   `*` matches any run of characters (including none)
 *   `?` matches exactly one character
 * Everything else is a literal. Matching is case-sensitive. Patterns are
 * anchored at both ends.
 */
export function globMatch(pattern: string, value: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(value);
}

export function globToRegex(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') {
      out += '.*';
    } else if (ch === '?') {
      out += '.';
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`, 's');
}

export function isGlobPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}
