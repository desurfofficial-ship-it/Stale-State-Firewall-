#!/usr/bin/env node
import { runCli } from './run.js';

const io = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  out: (text: string) => process.stdout.write(`${text}\n`),
  err: (text: string) => process.stderr.write(`${text}\n`),
};

runCli(io).then((result) => {
  process.exitCode = result.exitCode;
}).catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
