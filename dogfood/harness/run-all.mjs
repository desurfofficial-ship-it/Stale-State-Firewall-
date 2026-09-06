#!/usr/bin/env node
/**
 * Continuous internal dogfood harness (operationalization milestone §14–16).
 *
 *   npm run dogfood              # deterministic scenarios (offline)
 *   npm run dogfood -- --with-github   # include the live GitHub scenario (needs SSF_GITHUB_TOKEN)
 *
 * Runs a curated suite of REALISTIC development-action scenarios against the
 * PUBLIC SDK surface only (no internal test helpers), classifies every step
 * as EXPECTED_SECURITY_BLOCK / EXPECTED_SUCCESS / DOCUMENTED_BOUNDARY /
 * UNEXPECTED_FAILURE / SECURITY_FAILURE, prints a table, writes
 * dogfood/reports/harness-report.json, and exits non-zero when anything is
 * not as expected. State is fully resettable (fresh DBs per run).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEP, SCENARIO_VERDICT, scenarioVerdict } from './verdicts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOGFOOD_DIR = path.resolve(HERE, '..');
const REPORTS_DIR = path.join(DOGFOOD_DIR, 'reports');
const SCENARIOS_DIR = path.join(HERE, 'scenarios');
const SANDBOX_SERVER = path.join(DOGFOOD_DIR, 'scripts', 'sandbox-http-server.mjs');

const WITH_GITHUB = process.argv.includes('--with-github');
const SCENARIO_TIMEOUT_MS = 120_000;

const say = (line) => process.stdout.write(line + '\n');

function loadScenarios() {
  const files = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.mjs')).sort();
  return files.map((f) => ({ file: f, url: path.join(SCENARIOS_DIR, f) }));
}

async function startSandbox() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SANDBOX_SERVER, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('sandbox server did not become ready')), 15000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const match = /sandbox-ready (\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    });
    child.stderr.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`sandbox server exited early (code ${code}): ${out.slice(0, 400)}`));
    });
  });
}

async function main() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const startedAt = new Date().toISOString();

  const sandbox = await startSandbox();
  const ctx = { sandboxPort: sandbox.port, say };

  const selected = [];
  for (const { file, url } of loadScenarios()) {
    const mod = await import(url);
    if (mod.default?.kind === 'live-github' && !WITH_GITHUB) continue;
    selected.push({ file, mod: mod.default });
  }

  say('='.repeat(100));
  say('SSF CONTINUOUS DOGFOOD HARNESS');
  say(`started ${startedAt} | scenarios: ${selected.length}${WITH_GITHUB ? ' (incl. live GitHub)' : ' (offline; pass --with-github for the live GitHub scenario)'}`);
  say('='.repeat(100));

  const results = [];
  for (const { mod } of selected) {
    say('');
    say(`[${mod.id}] ${mod.title}`);
    const t0 = Date.now();
    let result;
    try {
      // Guard against a hanging scenario blocking the whole run.
      result = await Promise.race([
        mod.run(ctx),
        new Promise((_resolve, reject) => {
          const t = setTimeout(() => reject(new Error(`scenario exceeded ${SCENARIO_TIMEOUT_MS}ms`)), SCENARIO_TIMEOUT_MS);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
    } catch (error) {
      result = {
        steps: [{ name: 'scenario execution', verdict: STEP.UNEXPECTED_FAILURE, detail: `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}` }],
      };
    }
    const steps = result?.steps ?? [];
    const skipped = result?.skipped;
    const verdict = skipped ? SCENARIO_VERDICT.SKIPPED : scenarioVerdict(steps);
    for (const step of steps) {
      const mark = {
        [STEP.EXPECTED_SECURITY_BLOCK]: '  BLOCK (expected) ',
        [STEP.EXPECTED_SUCCESS]: '  SUCCESS (expected)',
        [STEP.DOCUMENTED_BOUNDARY]: '  BOUNDARY (documented)',
        [STEP.UNEXPECTED_FAILURE]: '  UNEXPECTED FAILURE',
        [STEP.SECURITY_FAILURE]: '  SECURITY FAILURE ',
      }[step.verdict] ?? '  ?';
      say(`  ${mark} ${step.name}`);
      if (step.detail) say(`      ${String(step.detail).slice(0, 300)}`);
    }
    if (skipped) say(`  SKIPPED: ${skipped}`);
    const duration = Date.now() - t0;
    say(`  == ${verdict} (${duration}ms)`);
    results.push({ id: mod.id, title: mod.title, verdict, duration_ms: duration, steps, skipped: skipped ?? null });
  }

  sandbox.child.kill();

  const counts = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const stepCounts = {};
  for (const r of results) for (const s of r.steps) stepCounts[s.verdict] = (stepCounts[s.verdict] ?? 0) + 1;

  const failed = results.filter((r) => r.verdict === SCENARIO_VERDICT.SECURITY_FAILURE || r.verdict === SCENARIO_VERDICT.UNEXPECTED_FAILURE || r.verdict === SCENARIO_VERDICT.ERROR);

  say('');
  say('='.repeat(100));
  say('SUMMARY');
  say(`  scenarios: ${results.length} | ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' | '));
  say('  steps:     ' + Object.entries(stepCounts).map(([k, v]) => `${k}=${v}`).join(' | '));
  const report = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    with_github: WITH_GITHUB,
    scenario_counts: counts,
    step_counts: stepCounts,
    results,
  };
  const reportPath = path.join(REPORTS_DIR, 'harness-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  say(`  report:    dogfood/reports/harness-report.json`);

  if (failed.length > 0) {
    say('');
    say(`HARNESS RESULT: FAIL — ${failed.length} scenario(s) not as expected:`);
    for (const f of failed) say(`  - ${f.id}: ${f.verdict}`);
    process.exitCode = 1;
  } else {
    say('');
    say('HARNESS RESULT: PASS — every expected block blocked, every legitimate action succeeded, boundaries documented.');
  }
}

main().catch((error) => {
  say(`harness error: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
