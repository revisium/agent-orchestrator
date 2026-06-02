import type { ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/index.js';

export type RunSummary = {
  runId: string;
  title: string;
  status: string;
  priority: number;
  createdAt: string;
};

export type StepSummary = {
  stepId: string;
  role: string;
  kind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
};

export type TaskSummary = {
  taskId: string;
  title: string;
  status: string;
  roleHint: string;
  steps: StepSummary[];
};

export type RunDetail = {
  run: RunSummary & { description: string; scope: string; repos: string[] };
  tasks: TaskSummary[];
};

export type EventSummary = {
  eventId: string;
  type: string;
  actor: string;
  createdAt: string;
  taskId: string;
  stepId: string;
};

const IN_PROCESS_CAP = 500;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x));
}

function toRunSummary(row: ControlPlaneRow): RunSummary {
  return {
    runId: row.rowId,
    title: str(row.data.title),
    status: str(row.data.status),
    priority: num(row.data.priority),
    createdAt: str(row.data.created_at ?? row.createdAt),
  };
}

function toRunDetail(row: ControlPlaneRow): RunDetail['run'] {
  return {
    ...toRunSummary(row),
    description: str(row.data.description),
    scope: str(row.data.scope),
    repos: strArr(row.data.repos),
  };
}

function toTaskSummary(row: ControlPlaneRow): Omit<TaskSummary, 'steps'> {
  return {
    taskId: row.rowId,
    title: str(row.data.title),
    status: str(row.data.status),
    roleHint: str(row.data.role_hint),
  };
}

function toStepSummary(row: ControlPlaneRow): StepSummary {
  return {
    stepId: row.rowId,
    role: str(row.data.role),
    kind: str(row.data.kind),
    status: str(row.data.status),
    attemptCount: num(row.data.attempt_count),
    maxAttempts: num(row.data.max_attempts),
  };
}

function toEventSummary(row: ControlPlaneRow): EventSummary {
  return {
    eventId: row.rowId,
    type: str(row.data.type),
    actor: str(row.data.actor),
    createdAt: str(row.data.created_at ?? row.createdAt),
    taskId: str(row.data.task_id),
    stepId: str(row.data.step_id),
  };
}

export async function listRuns(
  da: ControlPlaneDataAccess,
  filter?: { status?: string; limit?: number },
): Promise<RunSummary[]> {
  await da.assertReady();
  const rows = await da.listRows('task_runs', {
    first: IN_PROCESS_CAP,
    orderBy: [{ field: 'createdAt', direction: 'desc' }],
  });
  if (rows.length === IN_PROCESS_CAP) {
    process.stderr.write(`warning: task_runs results may be incomplete (cap=${IN_PROCESS_CAP})\n`);
  }
  let result = rows.map(toRunSummary);
  if (filter?.status) result = result.filter((r) => r.status === filter.status);
  if (filter?.limit !== undefined) result = result.slice(0, filter.limit);
  return result;
}

export async function showRun(da: ControlPlaneDataAccess, runId: string): Promise<RunDetail | null> {
  await da.assertReady();
  const runRow = await da.getRow('task_runs', runId);
  if (!runRow) return null;

  const allTasks = await da.listRows('tasks', {
    first: IN_PROCESS_CAP,
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
  });
  if (allTasks.length === IN_PROCESS_CAP) {
    process.stderr.write(`warning: tasks results may be incomplete (cap=${IN_PROCESS_CAP})\n`);
  }
  const tasks = allTasks.filter((t) => str(t.data.run_id) === runId);

  const taskIds = new Set(tasks.map((t) => t.rowId));
  const allSteps = await da.listRows('steps', {
    first: IN_PROCESS_CAP,
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
  });
  if (allSteps.length === IN_PROCESS_CAP) {
    process.stderr.write(`warning: steps results may be incomplete (cap=${IN_PROCESS_CAP})\n`);
  }
  const stepsByTaskId = new Map<string, StepSummary[]>();
  for (const step of allSteps) {
    const tid = str(step.data.task_id);
    if (!taskIds.has(tid)) continue;
    const list = stepsByTaskId.get(tid) ?? [];
    list.push(toStepSummary(step));
    stepsByTaskId.set(tid, list);
  }

  return {
    run: toRunDetail(runRow),
    tasks: tasks.map((t) => ({ ...toTaskSummary(t), steps: stepsByTaskId.get(t.rowId) ?? [] })),
  };
}

export async function listRunEvents(
  da: ControlPlaneDataAccess,
  runId: string,
  filter?: { type?: string; limit?: number },
): Promise<EventSummary[]> {
  await da.assertReady();
  const allEvents = await da.listRows('events', {
    first: IN_PROCESS_CAP,
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
  });
  if (allEvents.length === IN_PROCESS_CAP) {
    process.stderr.write(`warning: events results may be incomplete (cap=${IN_PROCESS_CAP})\n`);
  }
  let events = allEvents.filter((e) => str(e.data.run_id) === runId).map(toEventSummary);
  if (filter?.type) events = events.filter((e) => e.type === filter.type);
  if (filter?.limit !== undefined) events = events.slice(0, filter.limit);
  return events;
}

// ─────────────────────── formatters ───────────────────────

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function formatRunList(runs: RunSummary[]): string {
  const COL = { id: 27, status: 8, pri: 5, ts: 22, title: 0 };
  const header =
    pad('RUN', COL.id) +
    pad('STATUS', COL.status) +
    pad('PRI', COL.pri) +
    pad('CREATED', COL.ts) +
    'TITLE';
  const lines = runs.map((r) => {
    const ts = r.createdAt ? r.createdAt.slice(0, 20) + 'Z' : '';
    return (
      pad(r.runId, COL.id) +
      pad(r.status, COL.status) +
      pad(String(r.priority), COL.pri) +
      pad(ts, COL.ts) +
      r.title
    );
  });
  const summary = `(${runs.length} run${runs.length === 1 ? '' : 's'})`;
  return [header, ...lines, summary].join('\n');
}

export function formatRunDetail(detail: RunDetail): string {
  const r = detail.run;
  const ts = r.createdAt ? r.createdAt.slice(0, 20) + 'Z' : '';
  const lines: string[] = [
    `run     ${r.runId}`,
    `status  ${r.status}`,
    `title   ${r.title}`,
    `created ${ts}`,
  ];
  if (r.description) lines.push(`desc    ${r.description}`);
  if (r.scope) lines.push(`scope   ${r.scope}`);
  if (r.repos.length > 0) lines.push(`repos   ${r.repos.join(', ')}`);
  lines.push('');

  for (const task of detail.tasks) {
    lines.push(`  task     ${task.taskId}`);
    lines.push(`  title    ${task.title}`);
    lines.push(`  status   ${task.status}`);
    lines.push(`  role     ${task.roleHint}`);
    for (const step of task.steps) {
      lines.push(`    step     ${step.stepId}`);
      lines.push(`    role     ${step.role}  kind=${step.kind}  status=${step.status}  attempts=${step.attemptCount}/${step.maxAttempts}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatEventList(events: EventSummary[]): string {
  const COL = { id: 45, type: 16, actor: 14, ts: 22 };
  const header =
    pad('EVENT', COL.id) +
    pad('TYPE', COL.type) +
    pad('ACTOR', COL.actor) +
    'CREATED';
  const lines = events.map((e) => {
    const ts = e.createdAt ? e.createdAt.slice(0, 20) + 'Z' : '';
    return (
      pad(e.eventId, COL.id) +
      pad(e.type, COL.type) +
      pad(e.actor, COL.actor) +
      ts
    );
  });
  const summary = `(${events.length} event${events.length === 1 ? '' : 's'})`;
  return [header, ...lines, summary].join('\n');
}
