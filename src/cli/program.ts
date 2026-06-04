import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { registerBootstrap } from './commands/bootstrap.js';
import { registerRevisium } from './commands/revisium.js';
import { registerRun } from './commands/run.js';
import { registerWork } from './commands/work.js';

// Read the version from package.json at runtime. A static JSON import is avoided: tsconfig has no
// resolveJsonModule and package.json lives outside rootDir ("src"). '../../package.json' is correct
// from this file in BOTH dev (tsx src/cli/program.ts) and the built output (dist/cli/program.js) —
// each sits exactly two levels below the repo root (bin/revo.js runs dist/cli/index.js).
export function readPackageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json is missing a "version" field');
  }
  return pkg.version;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('revo')
    .description('Agent orchestrator CLI')
    .version(readPackageVersion(), '-v, --version', 'Print the revo version');
  registerRevisium(program);
  registerBootstrap(program);
  registerRun(program);
  registerWork(program);
  return program;
}
