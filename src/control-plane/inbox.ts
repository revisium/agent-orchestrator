import { randomUUID } from 'node:crypto';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from './data-access.js';
import { compactStamp } from './steps.js'; // index does NOT re-export compactStamp

// ─────────────────────────── Step 1: buildInboxRow ───────────────────────────

export type InboxKind = 'approval' | 'question' | 'alert';

// Plain object — the data-access layer serializes inbox.context to a JSON string (json-fields.ts).
export type InboxContext = {
  run_id: string;
  task_id: string;
  step_id: string;
  attempt_id: string;
  role: string;
  lesson: string;
  output: unknown;
};

export type InboxRow = {
  id: string;
  kind: InboxKind;
  run_id: string;
  task_id: string;
  step_id: string;
  project_id: string;
  title: string;
  context: InboxContext; // plain object; layer serializes
  options: string[];
  status: 'pending';
  created_at: string;
};

const TITLE_MAX = 120;

function deriveTitle(role: string, lesson: string): string {
  const trimmed = lesson.trim();
  if (trimmed === '') return `${role || 'step'} needs approval`;
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
}

export function buildInboxRow(args: {
  now: Date;
  idSuffix: string;
  kind?: InboxKind;
  context: InboxContext;
}): InboxRow {
  const { now, idSuffix, context } = args;
  const id = `inbox_${compactStamp(now)}_${idSuffix}`;
  return {
    id,
    kind: args.kind ?? 'approval',
    run_id: context.run_id,
    task_id: context.task_id,
    step_id: context.step_id,
    // Inbox is global (never split per project); no per-project routing this slice, so the empty
    // string is an intentional "no project association", not a forgotten field.
    project_id: '',
    title: deriveTitle(context.role, context.lesson),
    context,
    options: [],
    status: 'pending',
    created_at: now.toISOString(),
  };
}

// ─────────────────────── Step 4: listInbox + formatter ───────────────────────

export type InboxItem = {
  inboxId: string;
  kind: string;
  status: string;
  runId: string;
  stepId: string;
  title: string;
  lesson: string; // pulled from context.lesson for the list view
  createdAt: string;
};

const GLOBAL_CAP = 500;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function contextLesson(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  const lesson = (value as Record<string, unknown>).lesson;
  return typeof lesson === 'string' ? lesson : '';
}

function toInboxItem(row: ControlPlaneRow): InboxItem {
  const data = row.data;
  return {
    inboxId: row.rowId,
    kind: str(data.kind),
    status: str(data.status),
    runId: str(data.run_id),
    stepId: str(data.step_id),
    title: str(data.title),
    lesson: contextLesson(data.context),
    createdAt: str(data.created_at ?? row.createdAt),
  };
}

export async function listInbox(
  da: ControlPlaneDataAccess,
  filter?: { status?: string; limit?: number },
): Promise<InboxItem[]> {
  await da.assertReady();
  const rows = await da.listRows('inbox', {
    first: GLOBAL_CAP,
    orderBy: [{ field: 'createdAt', direction: 'desc' }],
  });
  let items = rows.map(toInboxItem);
  // Default view is pending-only (the human's queue); explicit --status overrides.
  const status = filter?.status ?? 'pending';
  if (status !== 'all') items = items.filter((i) => i.status === status);
  if (filter?.limit !== undefined) items = items.slice(0, filter.limit);
  return items;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function ageOf(createdAt: string, now: Date): string {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return '';
  const deltaMs = Math.max(0, now.getTime() - created);
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function formatInboxList(items: InboxItem[], opts?: { now?: Date }): string {
  const now = opts?.now ?? new Date();
  const COL = { id: 45, kind: 10, step: 27, age: 6 };
  const header =
    pad('INBOX', COL.id) + pad('KIND', COL.kind) + pad('STEP', COL.step) + pad('AGE', COL.age) + 'TITLE';
  const lines = items.map((i) =>
    pad(i.inboxId, COL.id) +
    pad(i.kind, COL.kind) +
    pad(i.stepId, COL.step) +
    pad(ageOf(i.createdAt, now), COL.age) +
    i.title,
  );
  const summary = `(${items.length} item${items.length === 1 ? '' : 's'})`;
  return [header, ...lines, summary].join('\n');
}

// ──────────────────────── Step 5: resolveInbox verb ──────────────────────────

export type ResolveDecision = 'approve' | 'reject';

export type ResolveInboxResult = {
  inboxId: string;
  stepId: string;
  decision: ResolveDecision;
  previousStatus: string; // the inbox row's prior status
  stepReadied: boolean; // true iff we actually flipped the step this call
  stepStatus: string; // the step's status AFTER this call ('ready'|'dead'|observed|'missing')
  alreadyResolved: boolean;
};

// Atomic-ish pending→resolved transition built on getRow/patchRow (data-access has NO CAS primitive,
// data-access.ts:26-33). Correct under the SINGLE-WORKER assumption (one resolution path at a time —
// the CLI is the only caller this slice). A true conditional / compare-and-set primitive (e.g.
// patchRowIf(table, id, when, patch)) would slot in HERE later WITHOUT touching resolveInbox — this is
// the only call site that changes. Returns true iff THIS call won the transition (flipped
// pending→resolved); false if the row is missing or already resolved.
async function transitionInboxToResolved(
  da: ControlPlaneDataAccess,
  inboxId: string,
  patch: PatchOperation[],
): Promise<boolean> {
  const current = await da.getRow('inbox', inboxId);
  if (!current) return false;
  if (str(current.data.status) !== 'pending') return false;
  await da.patchRow('inbox', inboxId, patch);
  return true;
}

function approveStepPatch(nowIso: string): PatchOperation[] {
  return [
    { op: 'replace', path: 'status', value: 'ready' },
    { op: 'replace', path: 'run_after', value: '' }, // immediately claimable
    { op: 'replace', path: 'lease_owner', value: '' },
    { op: 'replace', path: 'lease_expires_at', value: '' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ];
}

function rejectStepPatch(nowIso: string, deadReason: string): PatchOperation[] {
  return [
    { op: 'replace', path: 'status', value: 'dead' },
    { op: 'replace', path: 'dead_reason', value: deadReason },
    { op: 'replace', path: 'lease_owner', value: '' },
    { op: 'replace', path: 'lease_expires_at', value: '' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ];
}

function losingResult(
  inboxId: string,
  stepId: string,
  decision: ResolveDecision,
  previousStatus: string,
): ResolveInboxResult {
  return { inboxId, stepId, decision, previousStatus, stepReadied: false, stepStatus: '', alreadyResolved: true };
}

// Step guard (read-precedes-write, the cancel-run discipline): flip the step ONLY if it is still
// awaiting_approval. If it advanced / was cancelled / completed / missing, leave it alone.
async function flipParkedStep(
  da: ControlPlaneDataAccess,
  stepId: string,
  decision: ResolveDecision,
  nowIso: string,
  deadReason: string,
): Promise<{ stepReadied: boolean; stepStatus: string }> {
  if (!stepId) return { stepReadied: false, stepStatus: 'missing' };
  const step = await da.getRow('steps', stepId);
  const observed = step ? str(step.data.status) || 'missing' : 'missing';
  if (observed !== 'awaiting_approval') return { stepReadied: false, stepStatus: observed };
  const patch = decision === 'approve' ? approveStepPatch(nowIso) : rejectStepPatch(nowIso, deadReason);
  await da.patchRow('steps', stepId, patch);
  return { stepReadied: true, stepStatus: decision === 'approve' ? 'ready' : 'dead' };
}

export async function resolveInbox(
  da: ControlPlaneDataAccess,
  inboxId: string,
  opts: { decision: ResolveDecision; answer?: string; resolvedBy?: string; now?: Date; idSuffix?: string },
): Promise<ResolveInboxResult | null> {
  await da.assertReady();

  const inbox = await da.getRow('inbox', inboxId);
  if (!inbox) return null;

  const stepId = str(inbox.data.step_id);
  const previousStatus = str(inbox.data.status);
  const decision = opts.decision;

  // Already resolved (or some other state): no-op, no step patch, no event.
  if (previousStatus !== 'pending') {
    return losingResult(inboxId, stepId, decision, previousStatus);
  }

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const resolvedBy = opts.resolvedBy && opts.resolvedBy.length > 0 ? opts.resolvedBy : 'human';
  const answered = Boolean(opts.answer && opts.answer.length > 0);
  const answerText = opts.answer ?? '';

  // 1. WIN the atomic pending→resolved transition FIRST. Only the winner flips the step + emits the
  //    event. A loser (status moved off 'pending' between our read and the re-read) is a clean no-op.
  const inboxPatch: PatchOperation[] = [
    { op: 'replace', path: 'status', value: 'resolved' },
    { op: 'replace', path: 'resolved_by', value: resolvedBy },
    { op: 'replace', path: 'resolved_at', value: nowIso },
  ];
  if (answered) inboxPatch.push({ op: 'replace', path: 'answer', value: { text: answerText } }); // plain obj; layer serializes
  const won = await transitionInboxToResolved(da, inboxId, inboxPatch);
  if (!won) {
    return losingResult(inboxId, stepId, decision, previousStatus);
  }

  // 2. STEP GUARD: flip the parked step only if it is still awaiting_approval.
  const deadReason = answered ? answerText : 'rejected by human';
  const { stepReadied, stepStatus } = await flipParkedStep(da, stepId, decision, nowIso, deadReason);

  // 3. Append the resolution event (mirror cancel-run.ts:32-40 id + actor shape). Only the winner here.
  const suffix = opts.idSuffix && opts.idSuffix.length > 0 ? opts.idSuffix : randomUUID().replaceAll('-', '').slice(0, 8);
  const eventId = `event_${compactStamp(now)}_inbox-resolved_${suffix}`;
  await da.createRow('events', eventId, {
    id: eventId,
    run_id: str(inbox.data.run_id),
    task_id: str(inbox.data.task_id),
    step_id: stepId,
    type: 'inbox_resolved',
    payload: { inbox_id: inboxId, decision, answered, resolved_by: resolvedBy, step_readied: stepReadied, step_status: stepStatus },
    actor: 'cli',
    created_at: nowIso,
  });

  return { inboxId, stepId, decision, previousStatus, stepReadied, stepStatus, alreadyResolved: false };
}
