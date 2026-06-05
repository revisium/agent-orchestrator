import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from './data-access.js';
import type { RuntimeTable } from './tables.js';
import { compactStamp } from './steps.js';
import {
  buildInboxRow,
  listInbox,
  formatInboxList,
  resolveInbox,
  type InboxContext,
} from './inbox.js';

// ─── shared fake DA (cancel-run.test.ts pattern) ─────────────────────────────

function makeFake(
  seedRows: Partial<Record<RuntimeTable, ControlPlaneRow[]>>,
  opts: { assertReadyError?: Error; onPatch?: (table: RuntimeTable, rowId: string) => void } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
  const tables = seedRows;
  function rowsFor(table: RuntimeTable): ControlPlaneRow[] {
    return tables[table] ?? [];
  }
  const da: ControlPlaneDataAccess = {
    async assertReady() {
      if (opts.assertReadyError) throw opts.assertReadyError;
    },
    async listRows(table) {
      calls.push(`list:${table}`);
      return rowsFor(table);
    },
    async getRow(table, rowId) {
      calls.push(`getRow:${table}:${rowId}`);
      return rowsFor(table).find((r) => r.rowId === rowId) ?? null;
    },
    async createRow(table, rowId, data) {
      calls.push(`create:${table}:${rowId}`);
      creates.push({ table, rowId, data });
      return { rowId, data };
    },
    async updateRow(table, rowId, data) {
      calls.push(`update:${table}:${rowId}`);
      return { rowId, data };
    },
    async patchRow(table, rowId, ops) {
      calls.push(`patch:${table}:${rowId}`);
      patches.push({ table, rowId, ops });
      // Apply patches to the in-memory row so subsequent re-reads reflect the new state.
      const row = rowsFor(table).find((r) => r.rowId === rowId);
      if (row) {
        for (const op of ops) {
          if (op.op === 'replace' || op.op === 'add') row.data[op.path] = op.value;
          else if (op.op === 'remove') delete row.data[op.path];
        }
      }
      opts.onPatch?.(table, rowId);
      return { rowId, data: { id: rowId } };
    },
  };
  return { da, calls, patches, creates };
}

function inboxRow(overrides: Record<string, unknown> = {}): ControlPlaneRow {
  return {
    rowId: 'inbox-1',
    data: {
      id: 'inbox-1',
      kind: 'approval',
      run_id: 'run-1',
      task_id: 'task-1',
      step_id: 'step-1',
      project_id: '',
      title: 'needs sign-off',
      context: { run_id: 'run-1', task_id: 'task-1', step_id: 'step-1', attempt_id: 'a1', role: 'developer', lesson: 'needs sign-off', output: { q: 1 } },
      options: [],
      status: 'pending',
      ...overrides,
    },
  };
}

function stepRow(status: string): ControlPlaneRow {
  return {
    rowId: 'step-1',
    data: { id: 'step-1', run_id: 'run-1', task_id: 'task-1', role: 'developer', status, run_after: '', lease_owner: 'w1', lease_expires_at: 'x', dead_reason: '' },
  };
}

// ─── Step 1: buildInboxRow ───────────────────────────────────────────────────

const CTX: InboxContext = {
  run_id: 'run-9',
  task_id: 'task-9',
  step_id: 'step-9',
  attempt_id: 'attempt-9',
  role: 'reviewer',
  lesson: 'please approve the plan',
  output: { question: 'ok?' },
};

test('buildInboxRow: deterministic id, defaults, and passthrough context', () => {
  const now = new Date('2026-06-04T00:00:00.000Z');
  const row = buildInboxRow({ now, idSuffix: 'abc123ef', context: CTX });
  assert.equal(row.id, `inbox_${compactStamp(now)}_abc123ef`);
  assert.equal(row.id, 'inbox_20260604T000000000Z_abc123ef');
  assert.equal(row.kind, 'approval');
  assert.equal(row.status, 'pending');
  assert.equal(row.project_id, '');
  assert.deepEqual(row.options, []);
  assert.equal(row.created_at, '2026-06-04T00:00:00.000Z');
  // ids copied from context
  assert.equal(row.run_id, 'run-9');
  assert.equal(row.task_id, 'task-9');
  assert.equal(row.step_id, 'step-9');
  // context passed through UNSERIALIZED (a plain object)
  assert.equal(typeof row.context, 'object');
  assert.deepEqual(row.context, CTX);
  assert.deepEqual(row.context.output, { question: 'ok?' });
});

test('buildInboxRow: kind override', () => {
  const row = buildInboxRow({ now: new Date('2026-06-04T00:00:00.000Z'), idSuffix: 's', kind: 'question', context: CTX });
  assert.equal(row.kind, 'question');
});

test('buildInboxRow: title is the (trimmed) lesson', () => {
  const row = buildInboxRow({ now: new Date(), idSuffix: 's', context: { ...CTX, lesson: '  hello  ' } });
  assert.equal(row.title, 'hello');
});

test('buildInboxRow: title falls back to "<role> needs approval" on empty lesson', () => {
  const row = buildInboxRow({ now: new Date(), idSuffix: 's', context: { ...CTX, lesson: '   ' } });
  assert.equal(row.title, 'reviewer needs approval');
});

test('buildInboxRow: title falls back to "step needs approval" when role also empty', () => {
  const row = buildInboxRow({ now: new Date(), idSuffix: 's', context: { ...CTX, role: '', lesson: '' } });
  assert.equal(row.title, 'step needs approval');
});

test('buildInboxRow: long lesson is truncated with an ellipsis', () => {
  const lesson = 'x'.repeat(200);
  const row = buildInboxRow({ now: new Date(), idSuffix: 's', context: { ...CTX, lesson } });
  assert.equal(row.title.length, 120);
  assert.ok(row.title.endsWith('…'));
  assert.equal(row.title, 'x'.repeat(119) + '…');
});

// ─── Step 4: listInbox + formatInboxList ─────────────────────────────────────

function seededInbox(): ControlPlaneRow[] {
  return [
    {
      rowId: 'inbox-pending',
      createdAt: '2026-06-04T00:00:00.000Z',
      data: {
        id: 'inbox-pending', kind: 'approval', run_id: 'run-1', step_id: 'step-1', status: 'pending',
        title: 'approve me', created_at: '2026-06-04T00:00:00.000Z',
        context: { lesson: 'needs sign-off' },
      },
    },
    {
      rowId: 'inbox-resolved',
      createdAt: '2026-06-03T00:00:00.000Z',
      data: {
        id: 'inbox-resolved', kind: 'question', run_id: 'run-2', step_id: 'step-2', status: 'resolved',
        title: 'old item', created_at: '2026-06-03T00:00:00.000Z',
        context: { lesson: 'already done' },
      },
    },
  ];
}

test('listInbox: default returns only pending items', async () => {
  const { da } = makeFake({ inbox: seededInbox() });
  const items = await listInbox(da);
  assert.equal(items.length, 1);
  assert.equal(items[0].inboxId, 'inbox-pending');
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].lesson, 'needs sign-off');
  assert.equal(items[0].stepId, 'step-1');
});

test('listInbox: status=all returns both', async () => {
  const { da } = makeFake({ inbox: seededInbox() });
  const items = await listInbox(da, { status: 'all' });
  assert.equal(items.length, 2);
});

test('listInbox: status=resolved returns only resolved', async () => {
  const { da } = makeFake({ inbox: seededInbox() });
  const items = await listInbox(da, { status: 'resolved' });
  assert.equal(items.length, 1);
  assert.equal(items[0].inboxId, 'inbox-resolved');
});

test('listInbox: limit slices the result', async () => {
  const { da } = makeFake({ inbox: seededInbox() });
  const items = await listInbox(da, { status: 'all', limit: 1 });
  assert.equal(items.length, 1);
});

test('listInbox: lesson read from context.lesson, guards non-object context', async () => {
  const rows: ControlPlaneRow[] = [
    { rowId: 'x', data: { id: 'x', status: 'pending', context: null } },
  ];
  const { da } = makeFake({ inbox: rows });
  const items = await listInbox(da);
  assert.equal(items[0].lesson, '');
});

test('listInbox: assertReady is honored before listRows', async () => {
  const { da, calls } = makeFake({ inbox: seededInbox() }, { assertReadyError: new Error('down') });
  await assert.rejects(() => listInbox(da), /down/);
  assert.ok(!calls.some((c) => c.startsWith('list:')), 'no list should run when assertReady fails');
});

test('formatInboxList: header + one row + summary with deterministic age', () => {
  const items = [
    { inboxId: 'inbox-pending', kind: 'approval', status: 'pending', runId: 'run-1', stepId: 'step-1', title: 'approve me', lesson: 'l', createdAt: '2026-06-04T00:00:00.000Z' },
  ];
  const out = formatInboxList(items, { now: new Date('2026-06-04T02:00:00.000Z') });
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('INBOX'));
  assert.ok(lines[0].includes('KIND'));
  assert.ok(lines[0].includes('AGE'));
  assert.ok(lines[1].includes('inbox-pending'));
  assert.ok(lines[1].includes('2h'), `expected age 2h in: ${lines[1]}`);
  assert.ok(lines[1].includes('approve me'));
  assert.equal(lines[2], '(1 item)');
});

test('formatInboxList: empty list shows header + plural summary', () => {
  const out = formatInboxList([], { now: new Date() });
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '(0 items)');
});

// ─── Step 5: resolveInbox ────────────────────────────────────────────────────

const NOW = new Date('2026-06-04T00:00:00.000Z');
const NOW_ISO = '2026-06-04T00:00:00.000Z';

test('resolveInbox: approve flips step to ready, resolves inbox, emits one event', async () => {
  const { da, patches, creates } = makeFake({ inbox: [inboxRow()], steps: [stepRow('awaiting_approval')] });
  const result = await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW, idSuffix: 'sfx12345' });
  assert.ok(result);
  assert.equal(result.stepReadied, true);
  assert.equal(result.stepStatus, 'ready');
  assert.equal(result.alreadyResolved, false);
  assert.equal(result.previousStatus, 'pending');

  // inbox patched to resolved + metadata
  const inboxPatch = patches.find((p) => p.table === 'inbox');
  assert.ok(inboxPatch);
  assert.ok(inboxPatch.ops.some((o) => o.path === 'status' && o.value === 'resolved'));
  assert.ok(inboxPatch.ops.some((o) => o.path === 'resolved_by' && o.value === 'human'));
  assert.ok(inboxPatch.ops.some((o) => o.path === 'resolved_at' && o.value === NOW_ISO));
  assert.ok(!inboxPatch.ops.some((o) => o.path === 'answer'), 'no answer patch when no answer given');

  // step patched to ready, lease + run_after cleared
  const stepPatch = patches.find((p) => p.table === 'steps');
  assert.ok(stepPatch);
  assert.ok(stepPatch.ops.some((o) => o.path === 'status' && o.value === 'ready'));
  assert.ok(stepPatch.ops.some((o) => o.path === 'run_after' && o.value === ''));
  assert.ok(stepPatch.ops.some((o) => o.path === 'lease_owner' && o.value === ''));

  // exactly one inbox_resolved event with deterministic id
  const events = creates.filter((c) => c.table === 'events');
  assert.equal(events.length, 1);
  assert.equal(events[0].rowId, 'event_20260604T000000000Z_inbox-resolved_sfx12345');
  assert.equal(events[0].data.type, 'inbox_resolved');
  assert.equal(events[0].data.actor, 'cli');
  assert.deepEqual(events[0].data.payload, {
    inbox_id: 'inbox-1', decision: 'approve', answered: false, resolved_by: 'human', step_readied: true, step_status: 'ready',
  });
});

test('resolveInbox: approve + answer stores plain {text} object and marks answered', async () => {
  const { da, patches, creates } = makeFake({ inbox: [inboxRow()], steps: [stepRow('awaiting_approval')] });
  await resolveInbox(da, 'inbox-1', { decision: 'approve', answer: 'looks good', resolvedBy: 'alice', now: NOW });
  const inboxPatch = patches.find((p) => p.table === 'inbox');
  const answerOp = inboxPatch?.ops.find((o) => o.path === 'answer');
  assert.ok(answerOp);
  assert.deepEqual(answerOp.value, { text: 'looks good' });
  assert.ok(inboxPatch?.ops.some((o) => o.path === 'resolved_by' && o.value === 'alice'));
  const event = creates.find((c) => c.table === 'events');
  assert.equal((event?.data.payload as Record<string, unknown>).answered, true);
});

test('resolveInbox: reject flips step to dead with dead_reason = answer-or-default', async () => {
  const { da, patches } = makeFake({ inbox: [inboxRow()], steps: [stepRow('awaiting_approval')] });
  const result = await resolveInbox(da, 'inbox-1', { decision: 'reject', now: NOW });
  assert.equal(result?.stepStatus, 'dead');
  assert.equal(result?.stepReadied, true);
  const stepPatch = patches.find((p) => p.table === 'steps');
  assert.ok(stepPatch?.ops.some((o) => o.path === 'status' && o.value === 'dead'));
  assert.ok(stepPatch?.ops.some((o) => o.path === 'dead_reason' && o.value === 'rejected by human'));
});

test('resolveInbox: reject with answer uses the answer as dead_reason', async () => {
  const { da, patches } = makeFake({ inbox: [inboxRow()], steps: [stepRow('awaiting_approval')] });
  await resolveInbox(da, 'inbox-1', { decision: 'reject', answer: 'wrong approach', now: NOW });
  const stepPatch = patches.find((p) => p.table === 'steps');
  assert.ok(stepPatch?.ops.some((o) => o.path === 'dead_reason' && o.value === 'wrong approach'));
});

for (const advanced of ['completed', 'claimed', 'dead'] as const) {
  test(`resolveInbox: step already ${advanced} → no step patch, inbox resolved, event emitted`, async () => {
    const { da, patches, creates } = makeFake({ inbox: [inboxRow()], steps: [stepRow(advanced)] });
    const result = await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW });
    assert.equal(result?.stepReadied, false);
    assert.equal(result?.stepStatus, advanced);
    assert.equal(result?.alreadyResolved, false);
    assert.ok(!patches.some((p) => p.table === 'steps'), 'no step patch when step advanced');
    assert.ok(patches.some((p) => p.table === 'inbox'), 'inbox still resolved');
    assert.equal(creates.filter((c) => c.table === 'events').length, 1, 'one event still emitted');
  });
}

test('resolveInbox: step missing → no step patch, inbox resolved, event emitted', async () => {
  const { da, patches, creates } = makeFake({ inbox: [inboxRow()], steps: [] });
  const result = await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW });
  assert.equal(result?.stepReadied, false);
  assert.equal(result?.stepStatus, 'missing');
  assert.ok(!patches.some((p) => p.table === 'steps'));
  assert.equal(creates.filter((c) => c.table === 'events').length, 1);
});

test('resolveInbox: missing inbox id returns null and writes zero rows', async () => {
  const { da, calls, patches, creates } = makeFake({ inbox: [] });
  const result = await resolveInbox(da, 'nope', { decision: 'approve' });
  assert.equal(result, null);
  assert.ok(calls.includes('getRow:inbox:nope'));
  assert.equal(patches.length, 0);
  assert.equal(creates.length, 0);
});

test('resolveInbox: already-resolved is a no-op (no step patch, no event, no inbox patch)', async () => {
  const { da, patches, creates } = makeFake({ inbox: [inboxRow({ status: 'resolved' })], steps: [stepRow('awaiting_approval')] });
  const result = await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW });
  assert.equal(result?.alreadyResolved, true);
  assert.equal(result?.stepReadied, false);
  assert.equal(patches.length, 0, 'no patches at all');
  assert.equal(creates.length, 0, 'no event');
});

test('resolveInbox: double-resolve emits no duplicate event (loser is a no-op)', async () => {
  // The fake DA applies patches in place, so after the first resolve the inbox row reads 'resolved'.
  // A second resolveInbox call therefore short-circuits at the previousStatus guard.
  const { da, patches, creates } = makeFake({ inbox: [inboxRow()], steps: [stepRow('awaiting_approval')] });
  const first = await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW, idSuffix: 'first1' });
  const second = await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW, idSuffix: 'second1' });
  assert.equal(first?.alreadyResolved, false);
  assert.equal(second?.alreadyResolved, true);
  assert.equal(creates.filter((c) => c.table === 'events').length, 1, 'exactly one inbox_resolved event total');
  assert.equal(patches.filter((p) => p.table === 'inbox').length, 1, 'exactly one inbox patch total');
  // second call must not re-patch the step
  assert.equal(patches.filter((p) => p.table === 'steps').length, 1, 'step patched only once');
});

test('resolveInbox: transition LOSER (status flips between read and re-read) emits nothing', async () => {
  // Simulate a race: the initial getRow sees 'pending', but the guarded re-read inside
  // transitionInboxToResolved sees 'resolved' (another resolver won between our two reads).
  const row = inboxRow();
  let reads = 0;
  const da: ControlPlaneDataAccess = {
    async assertReady() {},
    async listRows() { return []; },
    async getRow(table, rowId) {
      if (table === 'inbox' && rowId === 'inbox-1') {
        reads += 1;
        // first read: pending (top of resolveInbox); second read (inside transition helper): resolved
        return { rowId, data: { ...row.data, status: reads === 1 ? 'pending' : 'resolved' } };
      }
      return null;
    },
    async createRow(_t, rowId, data) { creates.push({ rowId, data }); return { rowId, data }; },
    async updateRow(_t, rowId, data) { return { rowId, data }; },
    async patchRow(_t, rowId, _ops) { patched.push(rowId); return { rowId, data: { id: rowId } }; },
  };
  const creates: Array<{ rowId: string; data: Record<string, unknown> }> = [];
  const patched: string[] = [];
  const result = await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW });
  assert.equal(result?.alreadyResolved, true, 'loser reports alreadyResolved');
  assert.equal(result?.stepReadied, false);
  assert.equal(patched.length, 0, 'loser performs no patch');
  assert.equal(creates.length, 0, 'loser emits no event');
});

test('resolveInbox: read precedes write', async () => {
  const { da, calls } = makeFake({ inbox: [inboxRow()], steps: [stepRow('awaiting_approval')] });
  await resolveInbox(da, 'inbox-1', { decision: 'approve', now: NOW });
  const getIdx = calls.indexOf('getRow:inbox:inbox-1');
  const patchIdx = calls.indexOf('patch:inbox:inbox-1');
  assert.ok(getIdx >= 0 && patchIdx >= 0);
  assert.ok(getIdx < patchIdx, 'getRow must precede patch');
});

test('resolveInbox: assertReady is honored and blocks all reads/writes', async () => {
  const { da, calls } = makeFake({ inbox: [inboxRow()] }, { assertReadyError: new Error('down') });
  await assert.rejects(() => resolveInbox(da, 'inbox-1', { decision: 'approve' }), /down/);
  assert.ok(!calls.some((c) => c.startsWith('getRow:')), 'no getRow when assertReady fails');
  assert.ok(!calls.some((c) => c.startsWith('patch:')), 'no patch when assertReady fails');
});
