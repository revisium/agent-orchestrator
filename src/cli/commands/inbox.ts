import { Command } from 'commander';
import { ControlPlaneError, createControlPlaneDataAccess } from '../../control-plane/index.js';
import { listInbox, formatInboxList, resolveInbox, type ResolveDecision } from '../../control-plane/inbox.js';

type ListOptions = {
  status?: string;
  limit?: string;
  json: boolean;
};

type ResolveOptions = {
  approve: boolean;
  reject: boolean;
  answer?: string;
  by: string;
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
    console.error('Run: ./bin/revo.js revisium start');
  }
  if (error.code === 'BOOTSTRAP_NOT_APPLIED') {
    console.error('Run: ./bin/revo.js bootstrap --commit');
  }
}

function reportError(error: unknown): void {
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

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid --limit: ${value} (must be a positive integer)`);
  }
  return n;
}

async function inboxList(options: ListOptions): Promise<void> {
  try {
    const limit = parseLimit(options.limit);
    const da = createControlPlaneDataAccess();
    const items = await listInbox(da, { status: options.status, limit });
    if (options.json) {
      process.stdout.write(JSON.stringify(items, null, 2) + '\n');
    } else {
      console.log(formatInboxList(items));
    }
  } catch (error) {
    reportError(error);
  }
}

async function inboxResolve(id: string, options: ResolveOptions): Promise<void> {
  try {
    if (options.approve && options.reject) {
      console.error('Error: choose at most one of --approve / --reject');
      process.exitCode = 1;
      return;
    }
    const decision: ResolveDecision = options.reject ? 'reject' : 'approve';
    const da = createControlPlaneDataAccess();
    const result = await resolveInbox(da, id, { decision, answer: options.answer, resolvedBy: options.by });
    if (!result) {
      console.error(`inbox item not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyResolved) {
      console.log(`inbox ${id} already resolved`);
      return;
    }
    const verb = decision === 'approve' ? 'approved' : 'rejected';
    if (result.stepReadied) {
      const target = decision === 'approve' ? 'ready' : 'dead';
      console.log(`resolved ${id}: ${verb} → step ${result.stepId} ${target}`);
    } else {
      console.log(`resolved ${id}: ${verb}; step ${result.stepId} already ${result.stepStatus} — nothing to revive`);
    }
  } catch (error) {
    reportError(error);
  }
}

export function registerInbox(program: Command): void {
  const inbox = program.command('inbox').description('Manage the human-approval inbox');

  inbox
    .command('list')
    .description('List inbox items (pending by default)')
    .option('--status <status>', 'Filter by status (pending|resolved|all)', 'pending')
    .option('--limit <n>', 'Maximum number of results')
    .option('--json', 'Output as JSON', false)
    .action(inboxList);

  inbox
    .command('resolve')
    .description('Resolve an inbox item (approve resumes the chain; reject kills the step)')
    .argument('<id>', 'Inbox item id')
    .option('--approve', 'Approve: flip the parked step back to ready', false)
    .option('--reject', 'Reject: mark the parked step dead', false)
    .option('--answer <text>', 'Answer text recorded on the resolution (on reject it becomes the step dead_reason; on approve it is recorded only, not yet injected into the revived step)')
    .option('--by <actor>', 'Who is resolving (recorded as resolved_by)', 'human')
    .action(inboxResolve);
}
