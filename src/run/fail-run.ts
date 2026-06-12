/**
 * fail-run.ts — patch task_runs to `failed` + write a run_failed event (0008 #2).
 *
 * Proven gap (2026-06-10 live dogfood): when a pipeline step threw, DBOS retried then went to
 * ERROR, but NO failure event was written and the Revisium run-row stayed `ready` — the run-row
 * "meaning" lied about a workflow that had actually failed. This verb closes that gap: on a
 * terminal workflow failure the workflow body calls failRun, mirroring cancel-run.ts.
 *
 * EVENT-FIRST ordering + deterministic id + ROW_CONFLICT no-op make it replay-safe (mirrors
 * cancel-run.ts exactly): the run_failed event is written BEFORE the status patch, so a replay
 * that re-runs the body re-derives the same event id, hits ROW_CONFLICT, and still idempotently
 * applies the status patch. previous_status is captured on the FIRST execution and preserved.
 *
 * SECRET BOUNDARY: the failure reason is run through redactTokens before persisting — a gh/git
 * error string could echo a token, and events live in Revisium (where secrets must never land).
 */
import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import { redactTokens } from '../runners/gh-identity.js';

export type FailRunResult = {
  runId: string;
  previousStatus: string;
  status: 'failed';
};

/** Cap the persisted reason so a giant stack/stderr dump can't bloat the event row. */
const REASON_MAX = 2_000;

export async function failRun(
  da: ControlPlaneDataAccess,
  runId: string,
  reason: string,
  opts?: { now?: Date; actor?: string; source?: string },
): Promise<FailRunResult | null> {
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const prev = typeof row.data.status === 'string' ? row.data.status : '';

  // Already failed — the event exists with the true prior status (ROW_CONFLICT guarantees it).
  // Skip both writes (no fresh updated_at on replay).
  if (prev === 'failed') {
    return { runId, previousStatus: prev, status: 'failed' };
  }

  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = opts?.actor ?? 'pipeline';
  const source = opts?.source ?? 'workflow-failure';
  const safeReason = redactTokens(reason).slice(0, REASON_MAX);

  // EVENT-FIRST: deterministic id (no timestamp) + ROW_CONFLICT no-op (mirror cancel-run.ts).
  const eventId = `event_${fnv1a64Hex(`${runId}|run_failed`)}`;
  try {
    await da.createRow('events', eventId, {
      id: eventId,
      run_id: runId,
      type: 'run_failed',
      payload: { source, reason: safeReason, previous_status: prev },
      actor,
      created_at: nowIso,
    });
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') {
      // Event already written (true prior status preserved) — ensure the status patch is applied.
      await da.patchRow('task_runs', runId, [
        { op: 'replace', path: 'status', value: 'failed' },
        { op: 'replace', path: 'updated_at', value: nowIso },
      ]);
      return { runId, previousStatus: prev, status: 'failed' };
    }
    throw e;
  }

  await da.patchRow('task_runs', runId, [
    { op: 'replace', path: 'status', value: 'failed' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  return { runId, previousStatus: prev, status: 'failed' };
}
