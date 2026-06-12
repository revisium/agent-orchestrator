/**
 * poll-workflow-state.ts — shared polling helper used by `run start` and `inbox resolve`.
 *
 * After enqueueing or signaling a DBOS workflow, the CLI must wait for either:
 *   - a terminal DBOS status (SUCCESS / ERROR / CANCELLED / MAX_RECOVERY_ATTEMPTS_EXCEEDED), or
 *   - a parked gate (pending inbox approval row for this runId).
 *
 * Extracted from run.ts / inbox.ts to eliminate duplication (Sonar CPD).
 * Used by both the run-start path (§3.6) and the gate-resolve path (§3.7).
 *
 * 0006: PollOpts added with wait/maxAttempts/intervalMs.
 *   - wait:false (default): return on first terminal or first pending gate (unchanged behavior).
 *   - wait:true: loop through RUNNING step transitions, exit at gate (print resolve + re-attach
 *     hint) or at terminal; generous cap (2400 × 500ms ≈ 20 min).
 *   SIGINT handling: sets an aborted flag so the loop returns normally, letting index.ts finally
 *   { app.close() } run. Never calls process.exit(0).
 */

import type { InboxService } from '../../revisium/inbox.service.js';

/** DBOS terminal workflow statuses. MAX_RECOVERY_ATTEMPTS_EXCEEDED included per G10. */
export const TERMINAL_STATUSES = new Set([
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
]);

/** Default cap for wait:false mode (40 × 500ms = 20s). */
const DEFAULT_MAX_ATTEMPTS = 40;

/** Default interval between poll iterations in ms. */
const DEFAULT_INTERVAL_MS = 500;

/** Cap for wait:true mode: 2400 × 500ms ≈ 20 min. */
const WAIT_MAX_ATTEMPTS = 2400;

/** Shared detach/re-attach message printed by both the SIGINT path and the gate path. */
const DETACH_MSG = (runId: string) =>
  `detached — the durable state is preserved; resume with: revo run start ${runId} --wait`;

/**
 * DbosStatusProvider — minimal interface for querying DBOS workflow status.
 * Accepted by pollWorkflowState so callers need not import DbosService directly.
 */
export type DbosStatusProvider = {
  getWorkflowStatus: (id: string) => Promise<{ status: string } | null>;
};

/** DBOS terminal statuses that mean the workflow FAILED (vs. SUCCESS / CANCELLED). */
const FAILURE_STATUSES = new Set(['ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']);

/**
 * RunFailureReader — optional reader so --wait can SHOW the run_failed reason instead of a bare
 * "status: ERROR" (0008 #2). Returns the Revisium run-row status + the persisted failure reason.
 * Injected (not imported) to keep this helper free of a RunService dependency.
 */
export type RunFailureReader = (runId: string) => Promise<{ runStatus?: string; reason?: string } | null>;

/**
 * PollOpts — options for pollWorkflowState (0006).
 *
 * wait:false (default): return on first terminal status or first pending gate.
 * wait:true: loop through RUNNING step transitions, exit at gate or terminal; generous cap.
 * maxAttempts / intervalMs: override defaults (both call sites pass no overrides).
 */
export type PollOpts = {
  wait?: boolean;
  maxAttempts?: number;
  intervalMs?: number;
  /** Optional reader to surface the run_failed reason on a FAILURE terminal status (0008 #2). */
  readFailure?: RunFailureReader;
};

/**
 * abortableSleep — sleep for intervalMs, but resolve early if the SIGINT handler
 * calls earlyResolveRef.resolve(). Uses a single timer; no polling loop needed.
 */
function abortableSleep(intervalMs: number, earlyResolveRef: { resolve?: () => void }): Promise<void> {
  return new Promise<void>((resolve) => {
    earlyResolveRef.resolve = resolve;
    setTimeout(resolve, intervalMs);
  });
}

/**
 * checkTerminalStatus — check if the workflow has reached a terminal DBOS status.
 * Prints the status line and returns true if terminal so the caller can stop.
 *
 * 0008 #2: on a FAILURE terminal status (ERROR / MAX_RECOVERY_ATTEMPTS_EXCEEDED), read the
 * Revisium run-row failure reason (if a reader is supplied) and surface it as a clear
 * "run failed" line — never a silent sleep→ERROR with no explanation.
 */
async function checkTerminalStatus(
  runId: string,
  dbosService: DbosStatusProvider,
  readFailure?: RunFailureReader,
): Promise<boolean> {
  const wfStatus = await dbosService.getWorkflowStatus(runId);
  if (!wfStatus || !TERMINAL_STATUSES.has(wfStatus.status)) {
    return false;
  }
  console.log(`status:   ${wfStatus.status}`);
  if (FAILURE_STATUSES.has(wfStatus.status) && readFailure) {
    try {
      const failure = await readFailure(runId);
      if (failure?.reason) {
        console.log(`run failed: ${failure.reason}`);
      } else if (failure?.runStatus && failure.runStatus !== 'failed') {
        // DBOS says failure but the run-row was never patched — surface the integrity gap.
        console.log(`note:     DBOS=${wfStatus.status} but run-row status=${failure.runStatus} (no run_failed reason recorded)`);
      }
    } catch {
      // A failure-reason read should never mask the terminal signal — ignore and stop anyway.
    }
  }
  return true;
}

/**
 * checkParkedGate — check if the workflow is parked at a gate (pending inbox row).
 * Prints the parked line, resolve hint, and (in wait:true mode) the re-attach hint.
 * Returns true if parked so the caller can stop.
 */
async function checkParkedGate(runId: string, inboxSvc: InboxService, wait: boolean): Promise<boolean> {
  const pending = await inboxSvc.listInbox({ runId, status: 'pending' });
  if (pending.length === 0) {
    return false;
  }
  const gateRow = pending[0];
  if (gateRow) {
    const ctx = gateRow.context as Record<string, unknown> | null;
    const topic = typeof ctx?.topic === 'string' ? ctx.topic : '?';
    console.log(`parked:   run ${runId} is waiting at the '${topic}' gate`);
    console.log(`          resolve with: revo inbox resolve ${gateRow.id} --approve|--reject`);
    if (wait) {
      console.log(`          ${DETACH_MSG(runId)}`);
    }
  }
  return true;
}

/**
 * pollWorkflowState — poll until the workflow is terminal or parked at a gate.
 *
 * @param runId       - Workflow / run ID to observe.
 * @param dbosService - DBOS status provider (getWorkflowStatus).
 * @param inboxSvc    - Inbox service for pending-approval detection.
 * @param opts        - Poll options (wait, maxAttempts, intervalMs).
 */
export async function pollWorkflowState(
  runId: string,
  dbosService: DbosStatusProvider,
  inboxSvc: InboxService,
  opts: PollOpts = {},
): Promise<void> {
  const wait = opts.wait ?? false;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  // Use a generous cap in wait:true mode so long-running steps don't time out prematurely.
  const maxAttempts = opts.maxAttempts ?? (wait ? WAIT_MAX_ATTEMPTS : DEFAULT_MAX_ATTEMPTS);

  // SIGINT abort: set a flag so the loop returns normally (no process.exit).
  // Also holds a reference to the current sleep's resolve so Ctrl-C wakes it early.
  let aborted = false;
  const sleepRef: { resolve?: () => void } = {};

  const onSigint = () => {
    aborted = true;
    if (sleepRef.resolve) {
      sleepRef.resolve();
    }
  };
  process.once('SIGINT', onSigint);

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (aborted) {
        console.log(DETACH_MSG(runId));
        return;
      }

      if (await checkTerminalStatus(runId, dbosService, opts.readFailure)) {
        return;
      }

      if (await checkParkedGate(runId, inboxSvc, wait)) {
        return;
      }

      // Still running a step — wait and retry.
      await abortableSleep(intervalMs, sleepRef);
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  // Timed out — report unknown state.
  console.log('note:     timed out waiting for settled state; check status with: revo run show');
}
