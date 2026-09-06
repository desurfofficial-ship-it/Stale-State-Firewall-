#!/usr/bin/env node
/**
 * Independent security-boundary scanner (operational-closure §5).
 *
 * Scans (1) every tracked file in the working tree and (2) every commit of
 * every branch/tag reachable in git history for credential-shaped strings.
 *
 * NEVER prints matched values — only pattern class, file, and line number.
 * Exit code 0 = clean, 1 = findings (excluding allowlisted structural refs).
 */
import { execSync } from 'node:child_process';

const REPO = process.cwd();

// Credential-shaped patterns. Each has an allowlist of exact structural
// references that are NOT secret material (e.g. `${{ secrets.NAME }}`).
const PATTERNS = [
  { id: 'github-fine-grained-pat', re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { id: 'github-classic-pat', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: 'npm-token', re: /npm_[A-Za-z0-9]{20,}/ },
  { id: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'bearer-literal', re: /Bearer\s+[A-Za-z0-9_\-.]{25,}/ },
  { id: 'credentialed-url', re: /https?:\/\/[^\s/:@]+:[^\s/@]{8,}@/ },
  { id: 'generic-secret-assignment', re: /\b(SECRET|PASSWORD|API_KEY|APIKEY|ACCESS_TOKEN|AUTH_TOKEN)\b\s*[:=]\s*['"][A-Za-z0-9+/_\-=]{16,}['"]/i },
  { id: 'ssf-token-literal', re: /SSF_GITHUB_TOKEN\s*[:=]\s*['"][^'${\s}]{10,}['"]/ },
];

// Structural references that are config plumbing, not secret material.
const ALLOW = [
  /\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/, // workflow secret references
  /process\.env\.SSF_GITHUB_TOKEN/, // env-var reads
  /secrets\.SSF_GITHUB_TOKEN/, // named reference text
];

const redact = (s) => s.replaceAll(/[A-Za-z0-9+/_\-=]{8,}/g, '<redacted>');

function scanText(text, label) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        if (ALLOW.some((a) => a.test(line))) continue;
        findings.push({ pattern: p.id, where: `${label}:${i + 1}`, snippet: redact(line.trim()).slice(0, 80) });
      }
    }
  });
  return findings;
}

const all = [];

// 1. Working tree (tracked files only).
const tracked = execSync('git ls-files -z', { cwd: REPO, maxBuffer: 512 * 1024 * 1024 })
  .toString()
  .split('\0')
  .filter(Boolean);
for (const f of tracked) {
  let text;
  try {
    text = execSync(`git show :${JSON.stringify(f)}`, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString();
  } catch {
    continue;
  }
  all.push(...scanText(text, `tree:${f}`));
}

// 2. Full history: every commit on every ref.
const commits = execSync('git rev-list --all', { cwd: REPO, maxBuffer: 512 * 1024 * 1024 })
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);
for (const c of commits) {
  const names = execSync(`git diff-tree --no-commit-id --name-only -r --root ${c}`, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\n')
    .filter(Boolean);
  for (const f of names) {
    let blob;
    try {
      blob = execSync(`git show ${c}:${JSON.stringify(f)}`, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString();
    } catch {
      continue; // deletion / submodule
    }
    all.push(...scanText(blob, `history:${c.slice(0, 7)}:${f}`));
  }
}

console.log(`scanned tracked files: ${tracked.length}`);
console.log(`scanned history commits: ${commits.length}`);
if (all.length === 0) {
  console.log('FINDINGS: 0 (no credential-shaped strings outside structural references)');
  process.exit(0);
}
console.log(`FINDINGS: ${all.length}`);
const seen = new Set();
for (const f of all) {
  const key = `${f.pattern}|${f.where}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  [${f.pattern}] ${f.where} :: ${f.snippet}`);
}
process.exit(1);
