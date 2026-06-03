import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createControlPlaneDataAccess } from '../src/control-plane/index.js';
import { loadRole, loadModelProfile } from '../src/control-plane/definitions.js';
import { startAttempt, toStr, type Step } from '../src/control-plane/steps.js';

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

async function pollUntilSucceeded(stepId: string, label: string, workerId = 'smoke-worker'): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runCli(['work', '--once', '--worker-id', workerId]);
    if (result.status !== 0) throw new Error(`revo work --once failed (${label}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const row = await da.getRow('steps', stepId);
    if (row?.data.status === 'succeeded') return;
  }
  const row = await da.getRow('steps', stepId);
  throw new Error(`Expected ${label} step succeeded after work, got ${String(row?.data.status)}`);
}
await da.assertReady();

async function createSmokeRun(label: string, description: string): Promise<{ runId: string; taskId: string; archStepId: string }> {
  const result = await runCli(['run', 'create', '--title', `${label} ${Date.now()}`, '--repo', '.', '--description', description]);
  if (result.status !== 0) throw new Error(`revo run create (${label}) failed:\n${result.stderr}`);
  return {
    runId: matchId(result.stdout, /^created run (\S+)$/m, 'run id'),
    taskId: matchId(result.stdout, /^task (\S+)$/m, 'task id'),
    archStepId: matchId(result.stdout, /^step (\S+) ready$/m, 'step id'),
  };
}

// ─── Smoke 1: verify loadRole/loadModelProfile read from committed head ───────

const architect = await loadRole('architect');
if (architect.name !== 'architect') throw new Error(`Expected architect, got ${architect.name}`);
if (!architect.systemPrompt) throw new Error('architect.systemPrompt is empty');

const standard = await loadModelProfile('standard');
if (standard.level !== 'standard') throw new Error(`Expected standard, got ${standard.level}`);
if (!standard.modelId) throw new Error('standard.modelId is empty');

console.log(`smoke1: loadRole/loadModelProfile OK (architect system prompt length=${architect.systemPrompt.length}, model=${standard.modelId})`);

// ─── Smoke 2: architect step → developer step via revo work --once ─────────────

const { runId, taskId, archStepId } = await createSmokeRun('Worker loop smoke', 'Plan 0007 smoke');

console.log(`smoke2a: run=${runId} task=${taskId} archStep=${archStepId}`);

// Run work --once up to 3 times: earlier smokes may leave ready steps in the queue.
// The loop is dumb — it claims by priority/age, so older steps may come first.
await pollUntilSucceeded(archStepId, 'architect step (pass 1)');

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

await pollUntilSucceeded(devStepId, 'developer step (pass 2)');

// No additional steps should have been created for this run (developer returns none)
const allStepsAfter = await da.listRows('steps');
const runStepsAfter = allStepsAfter.filter((s) => String(s.data.run_id) === runId);
const nonTerminalSteps = runStepsAfter.filter((s) => !['succeeded', 'failed', 'dead'].includes(String(s.data.status)));
if (nonTerminalSteps.length > 0) {
  const stepsDesc = nonTerminalSteps.map((s) => `${s.rowId}(${String(s.data.status)})`).join(', ');
  throw new Error(`Unexpected non-terminal steps after developer: ${stepsDesc}`);
}

console.log('smoke3: developer step succeeded, no more steps (stub runner returned none)');

// ─── Smoke 4: recovery — claim+start without result, then revo work recovers it ──

const { runId: runId2, archStepId: archStepId2 } = await createSmokeRun('Worker loop recovery smoke', 'Plan 0007 recovery smoke');

// Simulate crash: directly claim+start archStepId2 without writing result.
// Scoped to the specific step created above so recovery is genuinely exercised.
const crashWorkerId = `smoke-crash-worker-${Date.now()}`;

const archRow2 = await da.getRow('steps', archStepId2);
if (!archRow2) throw new Error(`Expected step ${archStepId2} to exist before simulated crash`);

const claimTime = new Date();
const claimNowIso = claimTime.toISOString();
const leaseExpiresAt = new Date(claimTime.getTime() + 30_000).toISOString();
await da.patchRow('steps', archStepId2, [
  { op: 'replace', path: 'status', value: 'claimed' },
  { op: 'replace', path: 'lease_owner', value: crashWorkerId },
  { op: 'replace', path: 'lease_expires_at', value: leaseExpiresAt },
  { op: 'replace', path: 'updated_at', value: claimNowIso },
]);

const crashStep: Step = {
  id: archStepId2,
  taskId: toStr(archRow2.data.task_id),
  runId: runId2,
  role: toStr(archRow2.data.role),
  kind: toStr(archRow2.data.kind),
  status: 'claimed',
  input: archRow2.data.input ?? null,
  output: null,
  modelProfile: toStr(archRow2.data.model_profile),
  runAfter: toStr(archRow2.data.run_after),
  attemptCount: Number(archRow2.data.attempt_count ?? 0),
  maxAttempts: Number(archRow2.data.max_attempts ?? 3),
  priority: Number(archRow2.data.priority ?? 0),
  leaseOwner: crashWorkerId,
  leaseExpiresAt,
  deadReason: '',
};
const crashStepId = archStepId2;

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
