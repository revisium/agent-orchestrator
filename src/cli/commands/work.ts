import { Command } from 'commander';
import { ControlPlaneError, createControlPlaneDataAccess, loadRole, loadModelProfile } from '../../control-plane/index.js';
import { stubRunAgent } from '../../worker/stub-runner.js';
import { runWorker } from '../../worker/loop.js';
import { resolveWorkerId } from '../../worker/worker-id.js';

type WorkOptions = {
  once?: boolean;
  roles?: string;
  workerId?: string;
  idleSleep?: string;
};

function formatCause(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const status = error.status === undefined ? '' : ` status=${error.status}`;
    return `${error.code}${status}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function printHint(error: ControlPlaneError): void {
  if (error.code === 'DAEMON_NOT_RUNNING') {
    console.error('Run: revo revisium start');
  }
  if (error.code === 'BOOTSTRAP_NOT_APPLIED') {
    console.error('Run: revo bootstrap --commit');
  }
}

export async function workCommand(options: WorkOptions): Promise<void> {
  const roles = options.roles ? options.roles.split(',').map((r) => r.trim()).filter(Boolean) : ['architect', 'developer'];
  if (roles.length === 0) {
    console.error('Error: --roles produced an empty list; provide at least one role name');
    process.exitCode = 1;
    return;
  }
  const workerId = resolveWorkerId(options.workerId);
  const idleSleepMs = options.idleSleep === undefined ? 5000 : Number(options.idleSleep);
  if (!Number.isFinite(idleSleepMs) || idleSleepMs < 0) {
    console.error(`Error: --idle-sleep must be a non-negative number, got: ${String(options.idleSleep)}`);
    process.exitCode = 1;
    return;
  }
  const once = options.once ?? false;

  const abortController = new AbortController();
  process.once('SIGINT', () => {
    console.log('\nStopping after current step…');
    abortController.abort();
  });

  try {
    const da = createControlPlaneDataAccess();
    await da.assertReady();

    await runWorker(
      {
        da,
        loadRole: (name) => loadRole(name),
        loadModelProfile: (level) => loadModelProfile(level),
        runAgent: stubRunAgent,
      },
      {
        workerId,
        roles,
        once,
        idleSleepMs,
        signal: abortController.signal,
      },
    );
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      console.error(`Error: ${formatCause(error)}`);
      printHint(error);
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    process.exitCode = 1;
  }
}

export function registerWork(program: Command): void {
  program
    .command('work')
    .description('Run the worker loop (processes ready steps using the stub runner)')
    .option('--once', 'Process one step then exit; exit immediately when idle')
    .option('--roles <csv>', 'Comma-separated list of roles to claim', 'architect,developer')
    .option('--worker-id <id>', 'Override the stable worker identity')
    .option('--idle-sleep <ms>', 'Milliseconds to sleep when no step is available', '5000')
    .action(workCommand);
}
