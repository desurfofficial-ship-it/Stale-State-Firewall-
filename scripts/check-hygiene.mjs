#!/usr/bin/env node
// Repository hygiene gate: the spec (§75) requires a tree free of
// unfinished-work markers and hardcoded secrets. This script enforces that.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SCOPES = ['src', 'test', 'examples', 'scripts', 'docs'];
const EXTS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.md', '.yaml', '.yml', '.json']);

const FORBIDDEN = [
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /\bHACK\b/,
  /placeholder/i,
  /\bmock(ing|ed|s)?\b/i,
  /\bfake(?!r)\b/i,
  /\bstub(bed|s)?\b/i,
  /\bnot implemented\b/i,
  /throw new Error\(\s*['"]unreachable/i,
];

// Secret-shape detectors (defense in depth; tokens must come from env only).
const SECRET_SHAPES = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /npm_[A-Za-z0-9]{20,}/,
  /sk-or-v1-[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'coverage') continue;
      yield* walk(p);
    } else {
      yield p;
    }
  }
}

const violations = [];
for (const scope of SCOPES) {
  for (const file of walk(join(ROOT, scope))) {
    if (!EXTS.has(extname(file))) continue;
    if (file === fileURLToPath(import.meta.url)) continue; // this script must encode the patterns it scans for
    const text = readFileSync(file, 'utf8');
    const rel = file.slice(ROOT.length + 1);
    for (const pattern of FORBIDDEN) {
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (pattern.test(line)) {
          violations.push(`${rel}:${i + 1}: forbidden marker /${pattern.source}/ -> ${line.trim().slice(0, 120)}`);
        }
      });
    }
    for (const pattern of SECRET_SHAPES) {
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (pattern.test(line)) {
          violations.push(`${rel}:${i + 1}: potential hardcoded secret -> ${line.trim().slice(0, 80)}...`);
        }
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`hygiene check FAILED (${violations.length} violation(s)):`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('hygiene check passed: no forbidden markers, no secret-shaped strings.');
