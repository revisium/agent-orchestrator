import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { recordTerminalRunStatus } from './terminal-run-status.js';

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
  // CR-A/G3/C1: event-first, deterministic id, ROW_CONFLICT-idempotent, no fresh updated_at when
  // already cancelled — all provided by the shared writer (terminal-run-status.ts). `idSuffix` is
  // kept on the signature for back-compat (0002 `run cancel`) but does NOT influence the event id.
  const result = await recordTerminalRunStatus(da, runId, {
    status: 'cancelled',
    eventType: 'run_cancelled',
    actor: opts?.actor ?? 'cli',
    payload: { source: opts?.source ?? 'revo run cancel' },
    now: opts?.now ?? new Date(),
  });
  if (!result) return null;
  return { runId, previousStatus: result.previousStatus, status: 'cancelled' };
}
