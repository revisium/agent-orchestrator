import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { cancelRun } from './cancel-run.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';

function makeFake(
  runRows: ControlPlaneRow[],
  opts: { assertReadyError?: Error; throwConflictOnEvent?: boolean } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
  // Track which event ids were created (for ROW_CONFLICT dedup testing)
  const createdEventIds = new Set<string>();
  // In-memory store for stateful getRow (applies patches so subsequent reads see the update).
  const store = new Map<string, Record<string, unknown>>(
    runRows.map((r) => [`${String('task_runs')}:${r.rowId}`, { ...r.data }]),
  );

  const da: ControlPlaneDataAccess = {
    async assertReady() {
      if (opts.assertReadyError) throw opts.assertReadyError;
    },
    async listRows() {
      return [];
    },
    async getRow(table, rowId) {
      calls.push(`getRow:${table}:${rowId}`);
      const key = `${String(table)}:${rowId}`;
      const data = store.get(key) ?? runRows.find((r) => r.rowId === rowId)?.data ?? null;
      return data ? { rowId, data } : null;
    },
    async createRow(table, rowId, data) {
      calls.push(`create:${table}:${rowId}`);
      if (table === 'events' && opts.throwConflictOnEvent) {
        if (createdEventIds.has(rowId)) {
          throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
        }
        createdEventIds.add(rowId);
      }
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
      // Apply patches to in-memory store so subsequent getRow calls see the updated state.
      const key = `${String(table)}:${rowId}`;
      const existing = store.get(key) ?? runRows.find((r) => r.rowId === rowId)?.data;
      if (existing) {
        const updated = { ...existing };
        for (const op of ops) {
          if (op.op === 'replace') {
            updated[op.path] = op.value;
          }
        }
        store.set(key, updated);
      }
      return { rowId, data: { id: rowId } };
    },
  };
  return { da, calls, patches, creates };
}

const RUN = (status: string): ControlPlaneRow => ({
  rowId: 'run-a',
  data: { id: 'run-a', title: 'Run A', status, priority: 0, repos: ['r'] },
});

test('unknown runId returns null and writes zero rows', async () => {
  const { da, calls } = makeFake([]);
  const result = await cancelRun(da, 'nope');
  assert.equal(result, null);
  assert.ok(calls.includes('getRow:task_runs:nope'), 'getRow should be called');
  assert.ok(!calls.some((c) => c.startsWith('patch:')), 'no patch should be called');
  assert.ok(!calls.some((c) => c.startsWith('update:')), 'no update should be called');
  assert.ok(!calls.some((c) => c.startsWith('create:')), 'no create should be called');
});

test('known run patches status to cancelled', async () => {
  const { da, patches } = makeFake([RUN('running')]);
  const now = new Date('2026-06-04T00:00:00.000Z');
  const result = await cancelRun(da, 'run-a', { now });
  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'running', status: 'cancelled' });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].table, 'task_runs');
  assert.equal(patches[0].rowId, 'run-a');
  assert.ok(patches[0].ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'cancelled'));
  assert.ok(patches[0].ops.some((op) => op.op === 'replace' && op.path === 'updated_at' && op.value === '2026-06-04T00:00:00.000Z'));
});

test('read precedes write', async () => {
  const { da, calls } = makeFake([RUN('running')]);
  await cancelRun(da, 'run-a');
  const getIdx = calls.indexOf('getRow:task_runs:run-a');
  const patchIdx = calls.indexOf('patch:task_runs:run-a');
  assert.ok(getIdx >= 0, 'getRow must appear in calls');
  assert.ok(patchIdx >= 0, 'patch must appear in calls');
  assert.ok(getIdx < patchIdx, 'getRow must appear before patch');
});

test('assertReady is honored and blocks getRow and patch', async () => {
  const { da, calls } = makeFake([], { assertReadyError: new Error('down') });
  await assert.rejects(() => cancelRun(da, 'run-a'), /down/);
  assert.ok(!calls.some((c) => c.startsWith('getRow:')), 'no getRow should run');
  assert.ok(!calls.some((c) => c.startsWith('patch:')), 'no patch should run');
});

// C1 (0004 review): already-cancelled run must NOT re-patch task_runs (read-then-guard).
// The RUN mutation is skipped when status is already 'cancelled', making the call
// replay-idempotent on the run row (no fresh updated_at on replay).
test('C1: already-cancelled run skips task_runs patch but returns result (read-then-guard)', async () => {
  const { da, patches } = makeFake([RUN('cancelled')]);
  const result = await cancelRun(da, 'run-a', { now: new Date('2026-06-04T00:00:00.000Z') });
  assert.ok(result !== null);
  assert.equal(result.previousStatus, 'cancelled');
  assert.equal(result.status, 'cancelled');
  // C1: NO patch to task_runs when already cancelled.
  const runPatches = patches.filter((p) => p.table === 'task_runs');
  assert.equal(runPatches.length, 0, 'task_runs must NOT be patched when already cancelled (C1)');
});

// A10a (G3-note): UPDATED in place — old timestamp-id assertion replaced with deterministic id.
// The new id is `event_${fnv1a64Hex(`${runId}|run_cancelled`)}` (no timestamp, replay-safe).
// `idSuffix` is still accepted for back-compat but no longer influences the id.
test('known run emits a run_cancelled event with deterministic id (G3)', async () => {
  const { da, creates } = makeFake([RUN('running')]);
  const now = new Date('2026-06-04T00:00:00.000Z');
  await cancelRun(da, 'run-a', { now, idSuffix: 'abc123ef' });

  const events = creates.filter((c) => c.table === 'events');
  assert.equal(events.length, 1, 'exactly one event row written');
  const event = events[0];
  assert.ok(event);
  // A10a: deterministic id — no timestamp, no idSuffix in the id.
  const expectedId = `event_${fnv1a64Hex('run-a|run_cancelled')}`;
  assert.equal(event.rowId, expectedId, `event id must be deterministic: expected ${expectedId}`);
  assert.equal(event.data.id, event.rowId);
  assert.equal(event.data.type, 'run_cancelled');
  assert.equal(event.data.run_id, 'run-a');
  assert.equal(event.data.actor, 'cli');
  assert.equal(event.data.created_at, '2026-06-04T00:00:00.000Z');
  assert.deepEqual(event.data.payload, { source: 'revo run cancel', previous_status: 'running' });
});

// A10b (G3): double-cancel ROW_CONFLICT no-op — second call does not throw; exactly one event row.
test('double-cancel: second cancelRun swallows ROW_CONFLICT and returns result (G3 idempotent)', async () => {
  // First call: creates the event row.
  const { da: da1, creates: creates1 } = makeFake([RUN('running')], { throwConflictOnEvent: true });
  const result1 = await cancelRun(da1, 'run-a');
  assert.ok(result1 !== null, 'first cancel must succeed');
  assert.equal(result1.status, 'cancelled');
  const events1 = creates1.filter((c) => c.table === 'events');
  assert.equal(events1.length, 1, 'first cancel: exactly one event row');

  // Second call on the same da (throwConflictOnEvent=true simulates ROW_CONFLICT for a duplicate id).
  // The second call must NOT throw and must still return the cancelled result.
  const result2 = await cancelRun(da1, 'run-a');
  assert.ok(result2 !== null, 'second cancel must not throw');
  assert.equal(result2.status, 'cancelled');
  // Only one event was actually created (second was swallowed).
  const events2 = creates1.filter((c) => c.table === 'events');
  assert.equal(events2.length, 1, 'double-cancel: still exactly one event row (ROW_CONFLICT swallowed)');
});

// C1 (0004 review): double-cancel patches task_runs status AT MOST ONCE (2nd call is no-op on run row).
// Uses a stateful fake so the second cancelRun sees the already-cancelled status from the first call.
test('C1: double-cancel patches task_runs at most once (2nd call is no-op on run row)', async () => {
  // The stateful fake applies patchRow changes to its store, so the second cancelRun
  // reads 'cancelled' (set by the first call) and skips the run patch.
  const { da, patches } = makeFake([RUN('running')], { throwConflictOnEvent: true });

  const result1 = await cancelRun(da, 'run-a');
  assert.ok(result1 !== null, 'first cancel must succeed');
  assert.equal(result1.previousStatus, 'running');

  const result2 = await cancelRun(da, 'run-a');
  assert.ok(result2 !== null, 'second cancel must succeed');
  assert.equal(result2.previousStatus, 'cancelled', 'second call sees already-cancelled status');

  // task_runs patched exactly once (the first call only).
  const runPatches = patches.filter((p) => p.table === 'task_runs');
  assert.equal(runPatches.length, 1, 'task_runs must be patched at most once across two cancelRun calls (C1)');
});
