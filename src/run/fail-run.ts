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
import { redactTokens } from '../runners/gh-identity.js';
import { recordTerminalRunStatus } from './terminal-run-status.js';

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
  // Reason is token-redacted before persistence — a gh/git error could echo a token, and events
  // live in Revisium (where secrets must never land). Capped so a stack dump can't bloat the row.
  const safeReason = redactTokens(reason).slice(0, REASON_MAX);

  const result = await recordTerminalRunStatus(da, runId, {
    status: 'failed',
    eventType: 'run_failed',
    actor: opts?.actor ?? 'pipeline',
    payload: { source: opts?.source ?? 'workflow-failure', reason: safeReason },
    now: opts?.now ?? new Date(),
  });
  if (!result) return null;
  return { runId, previousStatus: result.previousStatus, status: 'failed' };
}
