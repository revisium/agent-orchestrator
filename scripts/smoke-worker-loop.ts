import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createControlPlaneDataAccess } from '../src/control-plane/index.js';
import { loadRole, loadModelProfile } from '../src/control-plane/definitions.js';
import { claimNextStep, startAttempt } from '../src/control-plane/steps.js';

const require = createRequire(import.meta.url);
const tsxPackagePath = require.resolve('tsx/package.json');
const tsxPackage = require(tsxPackagePath) as { bin: string | Record<string, string> };
const tsxBin = typeof tsxPackage.bin === 'string' ? tsxPackage.bin : tsxPackage.bin.tsx;
if (!tsxBin) throw new Error('Could not resolve tsx CLI path from package.json');
const tsxCliPath = join(dirname(tsxPackagePath), tsxBin);

type CliResult = { stdout: string; stderr: string; status: number | null };

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, 'src/cli/index.ts', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
}

function matchId(output: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(output);
  if (!match?.[1]) throw new Error(`Could not parse ${label} from CLI output:\n${output}`);
  return match[1];
}

const da = createControlPlaneDataAccess();
await da.assertReady();

// ─── Smoke 1: verify loadRole/loadModelProfile read from committed head ───────

const architect = await loadRole('architect');
if (architect.name !== 'architect') throw new Error(`Expected architect, got ${architect.name}`);
if (!architect.systemPrompt) throw new Error('architect.systemPrompt is empty');

const standard = await loadModelProfile('standard');
if (standard.level !== 'standard') throw new Error(`Expected standard, got ${standard.level}`);
if (!standard.modelId) throw new Error('standard.modelId is empty');

console.log(`smoke1: loadRole/loadModelProfile OK (architect system prompt length=${architect.systemPrompt.length}, model=${standard.modelId})`);

// ─── Smoke 2: architect step → developer step via revo work --once ─────────────

const createResult = await runCli([
  'run', 'create', '--title', `Worker loop smoke ${Date.now()}`, '--repo', '.', '--description', 'Plan 0007 smoke',
]);
if (createResult.status !== 0) throw new Error(`revo run create failed:\n${createResult.stderr}`);

const runId = matchId(createResult.stdout, /^created run (\S+)$/m, 'run id');
const taskId = matchId(createResult.stdout, /^task (\S+)$/m, 'task id');
const archStepId = matchId(createResult.stdout, /^step (\S+) ready$/m, 'step id');

console.log(`smoke2a: run=${runId} task=${taskId} archStep=${archStepId}`);

// Run work --once up to 3 times: earlier smokes may leave ready steps in the queue.
// The loop is dumb — it claims by priority/age, so older steps may come first.
let archProcessed = false;
for (let attempt = 0; attempt < 3; attempt++) {
  const workResult1 = await runCli(['work', '--once', '--worker-id', 'smoke-worker']);
  if (workResult1.status !== 0) throw new Error(`revo work --once failed (pass 1):\nstdout:\n${workResult1.stdout}\nstderr:\n${workResult1.stderr}`);
  const archStepRow = await da.getRow('steps', archStepId);
  if (archStepRow?.data.status === 'succeeded') { archProcessed = true; break; }
}
if (!archProcessed) {
  const archStepRow = await da.getRow('steps', archStepId);
  throw new Error(`Expected architect step succeeded after work, got ${String(archStepRow?.data.status)}`);
}

// A developer step should have been created
const allSteps = await da.listRows('steps');
const devSteps = allSteps.filter(
  (s) => String(s.data.run_id) === runId && String(s.data.role) === 'developer',
);
if (devSteps.length === 0) throw new Error('No developer step was created by the stub runner');
const devStepId = devSteps[0]?.rowId;
if (!devStepId) throw new Error('Developer step rowId is undefined');

console.log(`smoke2b: architect step succeeded, developer step created=${devStepId}`);

// ─── Smoke 3: developer step → no more steps ───────────────────────────────────

let devProcessed = false;
for (let attempt = 0; attempt < 3; attempt++) {
  const workResult2 = await runCli(['work', '--once', '--worker-id', 'smoke-worker']);
  if (workResult2.status !== 0) throw new Error(`revo work --once failed (pass 2):\nstdout:\n${workResult2.stdout}\nstderr:\n${workResult2.stderr}`);
  const devStepRow = await da.getRow('steps', devStepId);
  if (devStepRow?.data.status === 'succeeded') { devProcessed = true; break; }
}
if (!devProcessed) {
  const devStepRow = await da.getRow('steps', devStepId);
  throw new Error(`Expected developer step succeeded after work, got ${String(devStepRow?.data.status)}`);
}

// No additional steps should have been created for this run (developer returns none)
const allStepsAfter = await da.listRows('steps');
const runStepsAfter = allStepsAfter.filter((s) => String(s.data.run_id) === runId);
const nonTerminalSteps = runStepsAfter.filter((s) => !['succeeded', 'failed', 'dead'].includes(String(s.data.status)));
if (nonTerminalSteps.length > 0) {
  throw new Error(`Unexpected non-terminal steps after developer: ${nonTerminalSteps.map((s) => `${s.rowId}(${String(s.data.status)})`).join(', ')}`);
}

console.log('smoke3: developer step succeeded, no more steps (stub runner returned none)');

// ─── Smoke 4: recovery — claim+start without result, then revo work recovers it ──

const createResult2 = await runCli([
  'run', 'create', '--title', `Worker loop recovery smoke ${Date.now()}`, '--repo', '.', '--description', 'Plan 0007 recovery smoke',
]);
if (createResult2.status !== 0) throw new Error(`revo run create (recovery) failed:\n${createResult2.stderr}`);

const runId2 = matchId(createResult2.stdout, /^created run (\S+)$/m, 'run id');
const archStepId2 = matchId(createResult2.stdout, /^step (\S+) ready$/m, 'step id');

// Simulate crash: directly claim+start the specific step without writing result.
// We use the crash worker id to scope recovery correctly.
const crashWorkerId = `smoke-crash-worker-${Date.now()}`;
const crashStep = await claimNextStep(da, crashWorkerId, ['architect']);
if (!crashStep) throw new Error('Expected a claimable architect step for recovery smoke');
// There may be steps from earlier in this smoke or from earlier smoke runs; accept any.
const crashStepId = crashStep.id;

await startAttempt(da, crashStep, { workerId: crashWorkerId });

const orphanedRow = await da.getRow('steps', crashStepId);
if (orphanedRow?.data.status !== 'running') throw new Error('Expected orphaned step to be running before recovery');

// Now run revo work with the crash worker-id: recovery fires on startup, resets the orphan.
// Then --once processes it.
const workResult3 = await runCli(['work', '--once', `--worker-id=${crashWorkerId}`]);
if (workResult3.status !== 0) throw new Error(`revo work --once failed (recovery pass):\nstdout:\n${workResult3.stdout}\nstderr:\n${workResult3.stderr}`);

const recoveredRow = await da.getRow('steps', crashStepId);
if (recoveredRow?.data.status !== 'succeeded') {
  throw new Error(`Expected step to be succeeded after recovery+work, got ${String(recoveredRow?.data.status)}`);
}

console.log(`smoke4: crash recovery OK (orphaned step ${crashStepId} recovered and processed)`);

// ─── Smoke 5: zero model cost (stub runner produces no cost_ledger rows) ────────

const costRows = await da.listRows('cost_ledger');
const smokeCostRows = costRows.filter((c) => String(c.data.run_id) === runId || String(c.data.run_id) === runId2);
if (smokeCostRows.length > 0) throw new Error(`Unexpected cost_ledger rows for smoke runs: ${smokeCostRows.length}`);

console.log('smoke5: zero model cost OK (no cost_ledger rows from stub runner)');

// ─── Smoke 6: no runtime commit (draft rows not visible from head) ───────────────

const headDa = createControlPlaneDataAccess({ revision: 'head' });
const headArchStep = await headDa.getRow('steps', archStepId);
if (headArchStep !== null) throw new Error(`Smoke step ${archStepId} unexpectedly visible from head (runtime commit!)`);

console.log('smoke6: no runtime commit OK (steps not visible from head)');

console.log(`
smoke:worker-loop PASSED
  run1=${runId}  archStep=${archStepId}  devStep=${devStepId}
  run2=${runId2} archStep2=${archStepId2} crashStep=${crashStepId} (recovery)
`);
