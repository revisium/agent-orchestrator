import { Command } from 'commander';
import { registerBootstrap } from './commands/bootstrap.js';
import { registerRevisium } from './commands/revisium.js';
import { registerRun } from './commands/run.js';
import { registerWork } from './commands/work.js';

const program = new Command();

program.name('revo').description('Agent orchestrator CLI').version('0.0.1');

registerRevisium(program);
registerBootstrap(program);
registerRun(program);
registerWork(program);

await program.parseAsync(process.argv);
