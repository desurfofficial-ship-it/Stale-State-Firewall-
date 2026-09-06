/**
 * Dogfood shared fixtures (milestone: internal dogfood + production simulation).
 *
 * This library uses ONLY the public SDK surface (`stale-state-firewall`
 * package self-reference) — the same paths a real internal consumer uses.
 * No internal test helpers. Executors here are what an honest integrator
 * writes: they forward the firewall-authorized expected state to the
 * provider's own conditional mutation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Convenience alias. The SDK now exports `refKey` as a RUNTIME helper
 * (operationalization milestone §12 resolved the earlier friction finding
 * where it was exported as a type only); scenarios can import it from
 * `stale-state-firewall` directly.
 */
import { refKey as sdkRefKey } from 'stale-state-firewall';
export const refKeyOf = (ref) => sdkRefKey(ref);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOGFOOD_DIR = path.resolve(HERE, '..');
export const REPO_DIR = path.resolve(DOGFOOD_DIR, '..');
export const REPORTS_DIR = path.join(DOGFOOD_DIR, 'reports');
export const RECORDS_DIR = path.join(REPORTS_DIR, 'records');
export const STATE_DIR = path.join(REPORTS_DIR, 'state');
export const TELEMETRY_FILE = path.join(REPORTS_DIR, 'telemetry.jsonl');

export function ensureDirs() {
  for (const dir of [REPORTS_DIR, RECORDS_DIR, STATE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Returns a FRESH SQLite database path: removes any prior DB/WAL/SHM files.
 * Dogfood lesson (spec §3): a dogfood environment must reset trivially, and
 * persisted live authorizations are REAL state — a rerun against the same DB
 * is correctly refused as a replay by the firewall.
 */
export function freshDb(name) {
  ensureDirs();
  const base = path.join(STATE_DIR, name);
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(base + suffix, { force: true });
  }
  return base;
}

/** Block classification taxonomy (dogfood spec §21). */
export const BLOCK_CLASS = {
  CORRECT_BLOCK: 'CORRECT_BLOCK',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
  MISCONFIGURATION: 'MISCONFIGURATION',
  PROVIDER_LIMITATION: 'PROVIDER_LIMITATION',
  INTEGRATION_BUG: 'INTEGRATION_BUG',
  SECURITY_BUG: 'SECURITY_BUG',
  UNKNOWN: 'UNKNOWN',
};

/** Verdicts for a scenario run. */
export const VERDICT = {
  PASS: 'PASS',
  PASS_WITH_FRICTION: 'PASS_WITH_FRICTION',
  FINDING: 'FINDING',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
  FALSE_NEGATIVE: 'FALSE_NEGATIVE',
  ERROR: 'ERROR',
};

let seq = 0;

/**
 * Per-scenario recorder: transcript, telemetry (§32), result record (§34).
 */
export function createRecorder(id, title) {
  ensureDirs();
  const startMs = Date.now();
  const startedAt = new Date().toISOString();
  const observations = [];
  const blockClassifications = [];
  const findings = [];
  const errorSamples = [];
  const latency = { validation_ms: [], execution_ms: [] };
  let expected = null;
  let actual = null;
  let verdict = VERDICT.ERROR;

  const say = (line) => process.stdout.write(`[${id}] ${line}\n`);

  function telemetry(fields) {
    const line = {
      ts: new Date().toISOString(),
      scenario: id,
      seq: ++seq,
      ...fields,
    };
    fs.appendFileSync(TELEMETRY_FILE, JSON.stringify(line) + '\n');
  }

  async function step(name, fn) {
    say(`--> ${name}`);
    const t0 = Date.now();
    try {
      const out = await fn();
      say(`    ok (${Date.now() - t0}ms)`);
      return out;
    } catch (error) {
      say(`    FAILED: ${error.message}`);
      throw error;
    }
  }

  function observe(text) {
    observations.push(text);
    say(`  · ${text}`);
  }

  function classifyBlock(blockClassification, detail) {
    blockClassifications.push({ classification: blockClassification, detail, at: new Date().toISOString() });
    say(`  [classified] ${blockClassification} — ${detail}`);
  }

  function recordFinding(severity, text) {
    findings.push({ severity, text });
    say(`  [finding ${severity}] ${text}`);
  }

  function sampleError(context, error) {
    errorSamples.push({
      context,
      name: error?.name,
      message: error?.message,
      code: error?.code ?? null,
      details: error?.details ?? null,
      decision_reason: error?.decision?.reason ?? null,
    });
  }

  function recordTelemetryForOutcome(outcome, provider, risk, extra = {}) {
    telemetry({
      provider,
      risk,
      decision: outcome.decision?.decision ?? null,
      conditional_capability: outcome.result?.conditional_execution ?? 'not_attempted',
      execution_outcome: outcome.executed
        ? (outcome.result?.success ? 'executed' : 'failed')
        : (outcome.result && !outcome.result.success ? 'failed' : 'not_executed'),
      condition_result: outcome.result?.conditional_execution ?? null,
      latency_ms: outcome.result?.duration_ms ?? null,
      ...extra,
    });
    if (outcome.result?.duration_ms != null) {
      latency.execution_ms.push(outcome.result.duration_ms);
    }
  }

  function finish(result) {
    verdict = result.verdict;
    expected = result.expected ?? null;
    actual = result.actual ?? null;
    if (result.findings) findings.push(...result.findings);
    const record = {
      id,
      title,
      started_at: startedAt,
      duration_ms: Date.now() - startMs,
      verdict,
      expected,
      actual,
      observations,
      block_classifications: blockClassifications,
      findings,
      error_samples: errorSamples,
      latency,
      notes: result.notes ?? null,
    };
    fs.writeFileSync(path.join(RECORDS_DIR, `${id}.json`), JSON.stringify(record, null, 2) + '\n');
    say(`== verdict: ${verdict} (record: dogfood/reports/records/${id}.json)`);
    return record;
  }

  return {
    id, title, say, telemetry, step, observe, classifyBlock, recordFinding,
    sampleError, recordTelemetryForOutcome, finish,
    get findings() { return findings; },
  };
}

export function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT: ${message}`);
  return true;
}

export function assertEqual(actual, wanted, message) {
  if (actual !== wanted) {
    throw new Error(`ASSERT: ${message} (wanted ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)})`);
  }
  return true;
}

export function assertNotEqual(actual, unwanted, message) {
  if (actual === unwanted) {
    throw new Error(`ASSERT: ${message} (must NOT be ${JSON.stringify(unwanted)})`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Realistic simulated world (in-memory provider stands in for real systems)
// ---------------------------------------------------------------------------

/**
 * Seeds a realistic development environment into an InMemoryStateProvider.
 * Sources mirror what a real agent workflow would depend on.
 */
export function seedDevWorld(provider, nowIso) {
  provider.put('file', 'configs/deploy.yaml', {
    path: 'configs/deploy.yaml',
    content: 'service: api\nreplicas: 2\nimage: registry/api:1.2.3\n',
    env: 'staging',
  }, nowIso);
  provider.put('lockfile', 'package-lock', {
    lodash: '4.17.20',
    express: '4.18.2',
  }, nowIso);
  provider.put('ci_pipeline', 'main', {
    status: 'passing',
    run_id: 4242,
    branch: 'main',
  }, nowIso);
  provider.put('image_tag', 'api', {
    tag: '1.2.3',
    digest: 'sha256:aaaaaaaaaaaaaaaa',
  }, nowIso);
  provider.put('deployment_policy', 'default', {
    canary_required: false,
    window: 'business-hours',
  }, nowIso);
  provider.put('deployment', 'api/staging', {
    status: 'idle',
    applied_image: 'registry/api:1.2.2',
  }, nowIso);
}

// ---------------------------------------------------------------------------
// Honest executors (what a real integrator writes against the public SDK)
// ---------------------------------------------------------------------------

/**
 * Builds an honest conditional executor bound to one provider.
 * `changesOf(intent)` derives the mutation payload from the intent.
 * `writes` lists the dependency refs (refKey strings) the effect WRITES —
 * the executor enforces the authorized condition for exactly those refs and
 * refuses (unavailable) if any written ref lacks an authorized version.
 * Read-only dependencies are NOT CAS-enforced (see DOGFOOD findings).
 */
export function conditionalExecutorFor(provider, { changesOf, writes, latencyMs = 0 }) {
  const supported =
    typeof provider.conditionalExecute === 'function' &&
    provider.supportsConditionalExecution?.() === true;
  return {
    idempotency: 'non_idempotent',
    atomicity: 'guaranteed',
    async execute(intent) {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const dep = intent.dependencies[0];
      const current = provider.get(dep.resource, dep.resource_id);
      const res = await provider.conditionalExecute({
        ref: dep,
        expected_version: current ? current.version : 'v0',
        changes: changesOf(intent),
      });
      return res.outcome === 'executed'
        ? { success: true, output: { version: res.version } }
        : { success: false, error: 'provider refused unconditional write' };
    },
    conditionalExecutionSupported: () => supported,
    async conditionalExecute(intent, expectedState) {
      if (!supported) {
        return { condition: 'unavailable', error: 'provider does not offer conditional execution' };
      }
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      for (const ref of writes) {
        const entry = expectedState.find((e) => e.ref === ref);
        if (!entry || entry.version === null) {
          return { condition: 'unavailable', error: `no authorized expected state for written ref ${ref}` };
        }
      }
      const dep = intent.dependencies.find((d) => writes.includes(refKeyOf(d)));
      if (!dep) {
        return { condition: 'unavailable', error: 'intent does not declare the written resource as a dependency' };
      }
      const entry = expectedState.find((e) => e.ref === refKeyOf(dep));
      const res = await provider.conditionalExecute({
        ref: dep,
        expected_version: entry.version,
        changes: changesOf(intent),
      });
      if (res.outcome === 'executed') {
        return { condition: 'satisfied', success: true, output: { version: res.version } };
      }
      return {
        condition: 'failed',
        ref: refKeyOf(dep),
        observed_version: res.current_version,
        error: `provider refused: resource ${refKeyOf(dep)} at version ${res.current_version}, authorized ${entry.version}`,
      };
    },
  };
}

/** A deliberately dishonest executor: fresh read instead of authorized CAS. */
export function freshReadExecutor(provider, { changesOf }) {
  return {
    idempotency: 'non_idempotent',
    atomicity: 'not_guaranteed',
    async execute(intent) {
      const dep = intent.dependencies[0];
      const current = provider.get(dep.resource, dep.resource_id);
      await provider.conditionalExecute({
        ref: dep,
        expected_version: current.version, // re-read: NOT the authorized state
        changes: changesOf(intent),
      });
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function auditEvents(tail, eventType) {
  return tail.filter((e) => e.event_type === eventType);
}

export function waitForLine(child, matcher, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`timed out waiting for "${matcher}" from child process`));
    }, timeoutMs);
    function onData(chunk) {
      if (chunk.toString().includes(matcher)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    }
    child.stdout.on('data', onData);
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
