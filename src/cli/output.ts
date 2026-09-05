/**
 * CLI output rendering (spec §20, §53).
 *
 * Human output makes state transitions obvious: every dependency shows its
 * observed vs current version, staleness, and the reasons that drove the
 * decision. `--json` emits machine-readable output on stdout.
 */

import type { DecisionRecord } from '../domain/decision.js';

const MARKS: Record<string, string> = {
  FRESH: '✓',
  AGING: '~',
  STALE: '⚠',
  INVALID: '✗',
  UNKNOWN: '?',
};

export function renderDecisionHuman(record: DecisionRecord): string {
  const lines: string[] = [];
  lines.push('STALE-STATE FIREWALL');
  lines.push(`Action:      ${record.operation}${record.target ? ` ${record.target}` : ''}`);
  lines.push(`Agent:       ${record.agent_id}`);
  lines.push(`Risk:        ${record.risk_level}`);
  lines.push(`Mode:        ${record.mode}`);
  lines.push('Dependencies:');
  if (record.verdicts.length === 0) {
    lines.push('  (none declared)');
  }
  for (const verdict of record.verdicts) {
    const mark = MARKS[verdict.staleness] ?? '?';
    lines.push(`  ${mark} ${verdict.dependency.source}:${verdict.dependency.resource}/${verdict.dependency.resource_id}`);
    lines.push(`      strategy ${verdict.strategy}, staleness ${verdict.staleness}`);
    if (verdict.observed_version !== null || verdict.current_version !== null) {
      lines.push(`      observed version: ${verdict.observed_version ?? '(not declared)'}`);
      lines.push(`      current  version: ${verdict.current_version ?? '(unavailable)'}`);
    }
    if (verdict.age_ms !== null) {
      lines.push(`      age: ${verdict.age_ms}ms (max ${verdict.max_age_ms ?? 'n/a'})`);
    }
    for (const precondition of verdict.preconditions) {
      const pm = precondition.passed ? '✓' : '✗';
      lines.push(`      ${pm} ${precondition.field} ${precondition.operator} — ${precondition.reason}`);
    }
    lines.push(`      ${verdict.reason}`);
  }
  lines.push(`Decision:    ${record.decision}${record.would_have_decided ? ` (would have been ${record.would_have_decided})` : ''}`);
  lines.push(`Policy:      ${record.policy_name} (schema v${record.policy_version})`);
  lines.push('Reason:');
  lines.push(`  ${record.reason}`);
  if (record.expires_at) {
    lines.push(`Authorization valid until: ${record.expires_at}`);
  }
  return lines.join('\n');
}

export function renderError(message: string): string {
  return `error: ${message}`;
}
