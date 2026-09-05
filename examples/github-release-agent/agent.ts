/**
 * Example: GitHub Release Agent (spec §49, §51).
 *
 * Scenario: an agent wants to merge PR #42 into main, then deploy.
 * Between observation and action, another engineer pushes a new commit —
 * the pull request's effective state changes. The firewall detects the
 * head-SHA drift and blocks the merge until the agent re-observes.
 *
 * Run: npm run build && node examples/github-release-agent/agent.ts
 *
 * The GitHub resources are simulated with the in-memory provider so the
 * example runs offline; the GitHubStateProvider speaks the same contract
 * against api.github.com (see docs/providers.md).
 */

import {
  StaleStateFirewall,
  InMemoryStateProvider,
  MemoryStore,
  ManualClock,
  BlockedActionError,
  type FirewallRootConfigFile,
} from 'stale-state-firewall';

const clock = new ManualClock('2026-09-05T12:00:00Z');
const github = new InMemoryStateProvider('github');

const config: FirewallRootConfigFile = {
  firewall: { mode: 'enforce', storage: { type: 'memory' } },
  actions: [
    {
      name: 'merge-pull-request',
      match: { tool: 'github', operation: 'merge*' },
      risk: 'HIGH',
      freshness: { strategy: 'version' },
      preconditions: [
        { field: 'state', operator: 'equals', value: 'open' },
        { field: 'review_status', operator: 'equals', value: 'approved' },
      ],
      execution: { deadline: '30s' },
    },
  ],
};

const firewall = await StaleStateFirewall.create({
  config,
  store: new MemoryStore(),
  providers: [github],
  clock,
});

// --- Simulated world -------------------------------------------------------
github.put('pull_request', 'acme/api#42', {
  state: 'open',
  review_status: 'approved',
  head_sha: 'abc123',
}, clock.nowIso());

// --- The agent observed the PR a moment ago --------------------------------
const observed = github.get('pull_request', 'acme/api#42')!;
console.log(`agent observes PR acme/api#42: review_status=${observed.metadata['review_status']} head=${observed.metadata['head_sha']}`);

// --- Meanwhile, another engineer pushes a commit ----------------------------
github.mutate('pull_request', 'acme/api#42', {
  head_sha: 'def456',
  review_status: 'pending',
}, clock.nowIso());
console.log('another actor pushes commit def456 (reviews reset to pending)');

// --- The agent attempts the merge using its OLD reasoning --------------------
const mergeTool = firewall.protect({
  name: 'github',
  run: async (input: { pr: string }) => {
    console.log(`-> merge executed for ${input.pr}`);
    return { merged: true };
  },
  toIntent: (input: { pr: string; observedVersion: string }) => ({
    agent_id: 'release-agent',
    operation: 'merge_pull_request',
    target: input.pr,
    dependencies: [
      {
        source: 'github',
        resource: 'pull_request',
        resource_id: input.pr,
        version: input.observedVersion,
        metadata: { state: 'open', review_status: 'approved' },
      },
    ],
  }),
  idempotency: 'non_idempotent',
});

try {
  await mergeTool.execute({ pr: 'acme/api#42', observedVersion: observed.version });
  console.log('UNEXPECTED: merge went through on stale state');
} catch (error) {
  if (error instanceof BlockedActionError) {
    const verdict = error.decision.verdicts[0];
    console.log(`firewall: ${error.decision.decision} — ${error.decision.reason}`);
    if (verdict) {
      console.log(`  observed version: ${verdict.observed_version}`);
      console.log(`  current  version: ${verdict.current_version}`);
    }
  } else {
    throw error;
  }
}

// --- The agent re-observes and retries: now the merge is safe ----------------
const fresh = github.get('pull_request', 'acme/api#42')!;
console.log(`agent re-observes PR: review_status=${fresh.metadata['review_status']}`);
console.log('review is pending after the new commit — a real agent must wait for re-approval.');
console.log('For this demo, a reviewer approves the new commit:');
github.mutate('pull_request', 'acme/api#42', { review_status: 'approved' }, clock.nowIso());

await mergeTool.execute({ pr: 'acme/api#42', observedVersion: github.get('pull_request', 'acme/api#42')!.version });
console.log('merge allowed on fresh, re-approved state');

const metrics = firewall.getMetrics();
console.log(`metrics: checked=${metrics.counters.actions_checked} allowed=${metrics.counters.actions_allowed} denied=${metrics.counters.actions_denied}`);

await firewall.close();
