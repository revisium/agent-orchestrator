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
 * CR-A (0004 CR): EVENT-FIRST ordering — the run_cancelled event is written BEFORE the
 * task_runs status patch. This preserves correct `previous_status` on replay:
 *   1. Read run → capture prev = run.status.
 *   2. If prev === 'cancelled': the event already exists (ROW_CONFLICT no-op) with the TRUE
 *      prior status written on the first run. Skip the status patch too. Return.
 *   3. createRow the deterministic event with previous_status: prev (FIRST write — immutable
 *      because ROW_CONFLICT means the first write always wins on replay).
 *   4. idempotently patch task_runs.status → 'cancelled' (only if not already cancelled).
 * If a replay stops between steps 3 and 4, the next replay re-reads prev, sees the event
 * already exists (ROW_CONFLICT no-op at step 3), and idemptently applies the patch at step 4.
 * The event's `previous_status` is ALWAYS the true prior status captured on the FIRST execution.
 *
 * CR-B (0004 CR): caller-aware actor/source — the pipeline gate reject path passes
 * actor:'pipeline', source:'plan-gate-reject'; the CLI `run cancel` path keeps the
 * default actor:'cli', source:'revo run cancel'. Thread via opts.
 *
 * C1 (0004 review): read-then-guard — if the run is already cancelled, skip both the
 * event write (ROW_CONFLICT no-op) and the task_runs patch (C1: no fresh updated_at on replay).
 *
 * The `opts.idSuffix` parameter is kept for signature back-compat (0002 `run cancel` CLI
 * passes it) but no longer influences the event id — it is intentionally unused here.
 */
export async function cancelRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date; idSuffix?: string; actor?: string; source?: string },
): Promise<CancelRunResult | null> {
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const prev = typeof row.data.status === 'string' ? row.data.status : '';

  // CR-A step 2: already cancelled — event already exists with the correct previous_status
  // from the first run (ROW_CONFLICT ensures it; idSuffix-free deterministic id). Skip both
  // the event write and the status patch (C1: no non-deterministic updated_at on replay).
  if (prev === 'cancelled') {
    return { runId, previousStatus: prev, status: 'cancelled' };
  }

  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = opts?.actor ?? 'cli';
  const source = opts?.source ?? 'revo run cancel';

  // CR-A step 3: write the event FIRST with the true prior status captured above.
  // Deterministic id + ROW_CONFLICT no-op (mirrors append-event.ts:69-72):
  //   - First execution: inserts the event with previous_status = prev (the real prior status).
  //   - Any replay: ROW_CONFLICT swallowed — the FIRST insert's previous_status is preserved.
  // G3: fully deterministic event id (no timestamp) — replay-safe (mirrors append-event.ts:56).
  const eventId = `event_${fnv1a64Hex(`${runId}|run_cancelled`)}`;
  try {
    await da.createRow('events', eventId, {
      id: eventId,
      run_id: runId,
      type: 'run_cancelled',
      payload: { source, previous_status: prev },
      actor,
      created_at: nowIso,
    });
  } catch (e) {
    // Idempotent on workflow-body replay (mirror append-event.ts:69-72). Same event already exists → no-op.
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') {
      // Event already exists with the correct previous_status from the first run.
      // Still need to ensure the status patch is applied (step 4 may not have run yet).
      await da.patchRow('task_runs', runId, [
        { op: 'replace', path: 'status', value: 'cancelled' },
        { op: 'replace', path: 'updated_at', value: nowIso },
      ]);
      return { runId, previousStatus: prev, status: 'cancelled' };
    }
    throw e;
  }

  // CR-A step 4: patch the status AFTER the event is durably written.
  // C1: this path is only reached when prev !== 'cancelled' (checked at step 2 above),
  // so the patch is always meaningful (not a 'cancelled' → 'cancelled' re-write).
  await da.patchRow('task_runs', runId, [
    { op: 'replace', path: 'status', value: 'cancelled' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  return { runId, previousStatus: prev, status: 'cancelled' };
}
