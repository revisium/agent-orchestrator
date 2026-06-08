import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';

export type CancelRunResult = {
  runId: string;
  previousStatus: string;
  status: 'cancelled';
};

/**
 * cancelRun — patch task_runs to cancelled + write a run_cancelled event.
 *
 * G3 (0004): the event id is NOW DETERMINISTIC: `event_${fnv1a64Hex(`${runId}|run_cancelled`)}`.
 * This mirrors append-event.ts's pattern (22 chars ≤ 64; no timestamp).
 * createRow is wrapped in a ROW_CONFLICT catch so a workflow-body replay does NOT
 * duplicate or fail the event insert (idempotent under DBOS recovery).
 *
 * C1 (0004 review): read-then-guard — if the run is already cancelled, skip the
 * task_runs patch entirely and jump straight to the idempotent event ensure. This
 * makes the RUN mutation replay-safe: a second call on an already-cancelled run does
 * NOT produce a fresh updated_at write (which would be non-deterministic on replay).
 * The event is still ensured (ROW_CONFLICT no-op on replay).
 *
 * The `opts.idSuffix` parameter is kept for signature back-compat (0002 `run cancel` CLI
 * passes it) but no longer influences the event id — it is intentionally unused here.
 */
export async function cancelRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date; idSuffix?: string },
): Promise<CancelRunResult | null> {
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const previousStatus = typeof row.data.status === 'string' ? row.data.status : '';
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();

  // C1: skip the run patch when already cancelled — avoids a non-deterministic updated_at
  // write on workflow-body replay (the status patch re-writes 'cancelled' to 'cancelled' which
  // is harmless, but the fresh updated_at timestamp would differ per replay).
  if (previousStatus !== 'cancelled') {
    await da.patchRow('task_runs', runId, [
      { op: 'replace', path: 'status', value: 'cancelled' },
      { op: 'replace', path: 'updated_at', value: nowIso },
    ]);
  }

  // G3: fully deterministic event id (no timestamp) — replay-safe (mirrors append-event.ts:56).
  const cancelKey = runId + '|run_cancelled';
  const eventId = `event_${fnv1a64Hex(cancelKey)}`;
  try {
    await da.createRow('events', eventId, {
      id: eventId,
      run_id: runId,
      type: 'run_cancelled',
      payload: { source: 'revo run cancel', previous_status: previousStatus },
      actor: 'cli',
      created_at: nowIso,
    });
  } catch (e) {
    // Idempotent on workflow-body replay (mirror append-event.ts:69-72). Same event already exists → no-op.
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') {
      return { runId, previousStatus, status: 'cancelled' };
    }
    throw e;
  }

  return { runId, previousStatus, status: 'cancelled' };
}
