/**
 * Dogfood regression tests (milestone: internal dogfood + production simulation).
 *
 * Each test pins a defect found during real-usage dogfooding, following the
 * fix discipline: reproduce -> regression test -> fix -> rerun.
 *
 *  DF-1: GitHubStateProvider constructed directly (public export) applied no
 *        defaults; an omitted timeoutMs made every request fail with
 *        AbortSignal.timeout(undefined) ("The delay argument must be a
 *        number"). Fix: constructor applies the config-path defaults.
 *  DF-2: urlFor() had no 'file' case, so conditional (If-None-Match) fetches
 *        of GitHub FILES hit the repo root and compared the claimed blob sha
 *        against the REPO object's weak etag -> INVALID on every real file
 *        validation (fail-closed, but it made the file CAS guarantee unusable
 *        against the real API; tests using simulated responses missed the wrong URL).
 *  DF-3: executeApprovedAction's approval binding compared tool, operation,
 *        target and dependency refs but NOT the arguments payload — an
 *        approved escalation could be executed with swapped arguments.
 *  DF-4: the execution.condition_failed audit event recorded the expected
 *        state and a single observed_version but neither the refused ref nor
 *        the executor's refusal message — a multi-dependency condition
 *        failure was not attributable from the audit trail alone.
 */

import { describe, expect, it } from 'vitest';
import { GitHubStateProvider } from '../../src/providers/github/github-provider.js';
import { canonicalJson } from '../../src/engine/hashing.js';
import { redactDeep } from '../../src/redaction/redact.js';
import { harness, track } from '../helpers/harness.js';
import { createProtectedTool, BlockedActionError } from '../../src/index.js';
import type { ActionExecutor, ActionIntentInput } from '../../src/domain/action.js';
import type { StateDependency } from '../../src/domain/state.js';

function fileRef(version: string | null): StateDependency {
  return {
    source: 'github',
    resource: 'file',
    resource_id: 'o/r@p/file.txt',
    observed_at: new Date().toISOString(),
    version,
    content_hash: null,
    metadata: {},
  };
}

describe('dogfood regressions', () => {
  it('DF-1: GitHubStateProvider applies defaults when constructed directly', async () => {
    const seen: Array<{ url: string }> = [];
    const probe = new GitHubStateProvider({
      fetchImpl: (async (url: Parameters<typeof fetch>[0]) => {
        seen.push({ url: String(url) });
        return new Response(JSON.stringify({ name: 'file.txt', path: 'p/file.txt', sha: 'b'.repeat(40), size: 1, type: 'file' }), {
          status: 200,
          headers: { etag: '"x"' },
        });
      }) as typeof fetch,
    });
    await probe.getState(fileRef(null), new Date().toISOString());
    // The default apiBase must be used (previously: "undefined/repos/...").
    expect(seen[0]?.url).toContain('https://api.github.com/repos/o/r/contents/p/file.txt');

    // AbortSignal.timeout must receive a number: a request through a hanging
    // fetchImpl must surface as a typed provider error, not a TypeError
    // ("The delay argument must be of type number").
    const hanging = new GitHubStateProvider({
      fetchImpl: ((_url: Parameters<typeof fetch>[0], init: RequestInit) => new Promise<Response>((_r, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted by test timeout')));
      })) as typeof fetch,
      timeoutMs: 20,
    });
    await expect(hanging.getState(fileRef(null), new Date().toISOString()))
      .rejects.toThrow(/provider "github" unavailable/i);
  });

  it('DF-2: conditional (If-None-Match) fetches of file resources target the file URL, not the repo root', async () => {
    const urls: string[] = [];
    const provider = new GitHubStateProvider({
      apiBase: 'https://api.github.com',
      timeoutMs: 1000,
      fetchImpl: (async (url: Parameters<typeof fetch>[0]) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({ name: 'file.txt', path: 'p/file.txt', sha: 'a'.repeat(40), size: 1, type: 'file' }),
          { status: 200, headers: { etag: `"${'a'.repeat(40)}"` } },
        );
      }) as typeof fetch,
    });
    const snap = await provider.getConditional(fileRef('a'.repeat(40)), new Date().toISOString());
    // The URL must be the FILE contents URL (previously the repo root, whose
    // repo object carries a weak etag that fails every version comparison).
    expect(urls[0]).toContain('/repos/o/r/contents/p/file.txt');
    expect(urls[0]).not.toMatch(/\/repos\/o\/r$/);
    expect(snap?.version).toBe('a'.repeat(40));
  });

  it('DF-3: an approved escalation cannot be executed with tampered arguments', async () => {
    const h = await harness({
      config: {
        firewall: { mode: 'enforce', storage: { type: 'memory' } },
        actions: [
          {
            name: 'purge',
            match: { tool: 'db', operation: '*' },
            risk: 'CRITICAL',
            freshness: { strategy: 'version' },
            on_unknown: 'escalate',
          },
        ],
      },
    });

    const executor = { idempotency: 'non_idempotent' as const, execute: async () => ({ success: true }) };

    // Force an escalation the public way: an unresolvable dependency state.
    const escIntent = {
      agent_id: 'bot',
      tool: 'db',
      operation: 'purge_table',
      arguments: { table: 'users', mode: 'single-row', row: 42 },
      dependencies: [{ source: 'unreachable', resource: 'x', resource_id: 'y' }],
    };
    const outcome = await h.firewall.execute(escIntent, executor, { actionId: 'act_df3' });
    expect(outcome.decision.decision).toBe('ESCALATE');
    const pending = await h.firewall.listEscalations('PENDING');
    const actionId = pending[0]!.action_id;
    await h.firewall.resolveEscalation(actionId, { approved: true, by: 'human' });

    // Tampered arguments must NOT inherit the approval.
    let smuggled = false;
    await expect(
      h.firewall.executeApproved(
        actionId,
        { ...escIntent, arguments: { table: 'users', mode: 'full-table', row: null } },
        { idempotency: 'non_idempotent' as const, execute: async () => { smuggled = true; return { success: true }; } },
      ),
    ).rejects.toThrow(/does not match the approved escalation/i);
    expect(smuggled).toBe(false);

    // The identical resubmission passes the binding (it then fails closed at
    // state re-verification because the dependency is still unverifiable —
    // an approval cannot conjure state).
    const legit = await h.firewall.executeApproved(actionId, escIntent, executor);
    expect(legit.executed).toBe(false);
    expect(legit.decision.decision).toBe('DENY');
  });

  it('DF-3 companion: redaction is deterministic, so argument binding ignores only secret VALUES', () => {
    // Redaction maps sensitive values to a marker; the canonical form of
    // redacted arguments is stable, so secret rotation alone cannot smuggle
    // a different payload past the binding, while non-secret differences
    // (mode) still change it.
    const base = () => canonicalJson(redactDeep({ table: 'users', token: 'secret-1' }));
    const rotated = () => canonicalJson(redactDeep({ table: 'users', token: 'secret-2' }));
    const escalated = () => canonicalJson(redactDeep({ table: 'users', token: 'secret-1', mode: 'full' }));
    expect(base()).toBe(base());
    expect(rotated()).toBe(base()); // secret values are redacted away
    expect(escalated()).not.toBe(base()); // operational differences remain visible
  });

  it('DF-4: a multi-dependency condition failure names the drifted ref in the audit trail', async () => {
    // S05 dogfood finding (P3): with several dependencies, the
    // execution.condition_failed audit event recorded only the expected-state
    // array and a single observed_version — a human reading the audit could
    // not attribute the refusal to a specific dependency. The executor now
    // reports the refused ref and the firewall persists it (failed_ref) plus
    // the executor's own refusal message (provider_error).
    const h = await harness();
    track(h.provider, 'deployment', 'prod', { status: 'healthy' }, h.nowIso);
    track(h.provider, 'config', 'feature-flag', { enabled: false }, h.nowIso);
    const versionProd = h.provider.get('deployment', 'prod')!.version;
    const versionFlag = h.provider.get('config', 'feature-flag')!.version;

    const REF_PROD = 'memory:deployment/prod';
    const executor: ActionExecutor = {
      idempotency: 'non_idempotent',
      conditionalExecutionSupported: () => true,
      async conditionalExecute(_intent, expectedState) {
        const entry = expectedState.find((e) => e.ref === REF_PROD);
        if (!entry || entry.version === null) {
          return { condition: 'unavailable', error: 'no authorized expected state for the written ref' };
        }
        const result = await h.provider.conditionalExecute({
          ref: { source: 'memory', resource: 'deployment', resource_id: 'prod' },
          expected_version: entry.version,
          changes: { status: 'deployed' },
        });
        if (result.outcome === 'executed') return { condition: 'satisfied', success: true };
        return {
          condition: 'failed',
          ref: REF_PROD,
          observed_version: result.current_version,
          error: `provider refused: resource ${REF_PROD} at version ${result.current_version}, authorized ${entry.version}`,
        };
      },
      async execute() {
        return { success: true };
      },
    };

    // The intent declares TWO dependencies; only the written one (prod) is
    // CAS-conditioned. A concurrent actor drifts it in the CAS window (the
    // same window the conditional-execution tests use).
    const intent: ActionIntentInput = {
      agent_id: 'release-bot',
      tool: 'deploy',
      operation: 'deploy_production',
      arguments: { env: 'prod' },
      dependencies: [
        { source: 'memory', resource: 'deployment', resource_id: 'prod', version: versionProd },
        { source: 'memory', resource: 'config', resource_id: 'feature-flag', version: versionFlag },
      ],
    };

    const realConditional = executor.conditionalExecute!.bind(executor);
    executor.conditionalExecute = async (i, expectedState) => {
      h.provider.mutate('deployment', 'prod', { status: 'changed-by-attacker' }, h.clock.nowIso());
      return realConditional(i, expectedState);
    };

    const outcome = await h.firewall.execute(intent, executor);
    expect(outcome.executed).toBe(false);
    expect(outcome.result!.conditional_execution).toBe('failed');

    const audit = await h.firewall.auditTail(50);
    const event = audit.find(
      (r) => r.event_type === 'execution.condition_failed' && r.payload['action_id'] === outcome.decision.action_id,
    );
    expect(event).toBeDefined();
    expect(event!.payload['failed_ref']).toBe(REF_PROD);
    expect(String(event!.payload['provider_error'])).toContain(REF_PROD);
    expect(String(event!.payload['provider_error'])).toContain('authorized');
  });

  it('DF-5 (DF-F1): protect() can express conditional execution — the ergonomic path reaches the provider CAS', async () => {
    // S15 dogfood finding: firewall.protect() could not express conditional
    // execution, so ProtectedTool executions ALWAYS took the legacy path —
    // the flagship guarantee was unreachable through the most ergonomic
    // integration API. The spec now carries conditionalExecutionSupported +
    // conditionalRun and the wrapper wires them into the executor.
    const h = await harness({
      config: {
        firewall: { mode: 'enforce' },
        actions: [{
          name: 'edit-config',
          match: { tool: 'edit-config', operation: '*' },
          risk: 'HIGH',
          freshness: { strategy: 'version' },
          execution: { require_conditional_execution: true },
        }],
      },
    });
    track(h.provider, 'file', 'configs/service.yaml', { content: 'replicas: 2' }, h.nowIso);
    const observed = h.provider.get('file', 'configs/service.yaml')!.version;

    let casCalls = 0;
    const editTool = createProtectedTool<{ content: string; observedVersion: string }, { applied: string }>(
      h.firewall,
      {
        name: 'edit-config',
        toIntent: (input) => ({
          agent_id: 'config-agent',
          operation: 'edit_service_config',
          arguments: { content: input.content },
          dependencies: [{ source: 'memory', resource: 'file', resource_id: 'configs/service.yaml', version: input.observedVersion }],
        }),
        idempotency: 'non_idempotent',
        atomicity: 'guaranteed',
        conditionalExecutionSupported: true,
        conditionalRun: async (input, expectedState) => {
          casCalls += 1;
          const entry = expectedState.find((e) => e.ref === 'memory:file/configs/service.yaml');
          if (!entry?.version) return { applied: false, error: 'no authorized expected state' };
          const res = await h.provider.conditionalExecute({
            ref: { source: 'memory', resource: 'file', resource_id: 'configs/service.yaml' },
            expected_version: entry.version,
            changes: { content: input.content },
          });
          return res.outcome === 'executed'
            ? { applied: true, output: { applied: input.content } }
            : { applied: false, ref: 'memory:file/configs/service.yaml', observed_version: res.current_version, error: 'provider refused' };
        },
        run: async () => {
          // Legacy path: must NOT be taken when conditional capability exists.
          throw new Error('legacy run() must not be called on the conditional path');
        },
      },
    );

    // Success path: the condition holds, the CAS applies, the output flows.
    const out = await editTool.execute({ content: 'replicas: 3', observedVersion: observed });
    expect(casCalls).toBe(1);
    expect(out.applied).toBe('replicas: 3');
    expect(h.provider.get('file', 'configs/service.yaml')!.metadata['content']).toBe('replicas: 3');

    // Stale path, made deterministic through protect(): hook the provider's
    // CAS so a concurrent mutation lands BETWEEN authorization and the
    // compare-and-swap (the same window the conditional-execution tests
    // use). The provider itself must refuse, and the wrapper must surface
    // BlockedActionError carrying the execution result (agent-usable).
    const realCas = h.provider.conditionalExecute.bind(h.provider);
    h.provider.conditionalExecute = async (request) => {
      h.provider.mutate('file', 'configs/service.yaml', { content: 'changed-by-other' }, h.clock.nowIso());
      return realCas(request);
    };
    const observedNow = h.provider.get('file', 'configs/service.yaml')!.version;

    const staleAttempt = editTool.execute({ content: 'replicas: 9', observedVersion: observedNow });
    await expect(staleAttempt).rejects.toThrow();

    // A refused attempt surfaces as BlockedActionError carrying the
    // execution result (agent-usable: what happened, what was observed).
    // Claim the CURRENT version so validation passes and the refusal lands
    // in the CAS window, not at validation.
    const current = h.provider.get('file', 'configs/service.yaml')!.version;
    try {
      await editTool.execute({ content: 'replicas: 9', observedVersion: current });
      expect.unreachable('the stale CAS must not execute');
    } catch (e) {
      expect(e).toBeInstanceOf(BlockedActionError);
      const blocked = e as BlockedActionError;
      expect(blocked.execution?.conditional_execution).toBe('failed');
      expect(blocked.execution?.observed_version).not.toBe(current);
    }
    expect(casCalls).toBe(3); // 1 success + 2 refused CAS runs; legacy run() never did
    expect(h.provider.get('file', 'configs/service.yaml')!.metadata['content']).toBe('changed-by-other');

    // Restore the honest provider and re-observe: a fresh attempt succeeds
    // through the same conditional hook.
    h.provider.conditionalExecute = realCas;
    const freshObserved = h.provider.get('file', 'configs/service.yaml')!.version;
    const fresh = await editTool.execute({ content: 'replicas: 4', observedVersion: freshObserved });
    expect(fresh.applied).toBe('replicas: 4');
    expect(casCalls).toBe(4);
  });
});
