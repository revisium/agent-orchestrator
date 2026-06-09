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

/**
 * DbosStatusProvider — minimal interface for querying DBOS workflow status.
 * Accepted by pollWorkflowState so callers need not import DbosService directly.
 */
export type DbosStatusProvider = {
  getWorkflowStatus: (id: string) => Promise<{ status: string } | null>;
};

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
};

/**
 * abortableSleep — sleep for intervalMs, but resolve early if abortFn returns true.
 * Uses a single timer; checked by polling abortFn isn't needed — the SIGINT handler
 * that flips the flag also resolves the promise via a shared resolve ref.
 */
function abortableSleep(intervalMs: number, earlyResolveRef: { resolve?: () => void }): Promise<void> {
  return new Promise<void>((resolve) => {
    earlyResolveRef.resolve = resolve;
    setTimeout(resolve, intervalMs);
  });
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
        console.log(
          `detached — the durable state is preserved; resume with: revo run start ${runId} --wait`,
        );
        return;
      }

      // Check for terminal DBOS status first.
      const wfStatus = await dbosService.getWorkflowStatus(runId);
      if (wfStatus && TERMINAL_STATUSES.has(wfStatus.status)) {
        console.log(`status:   ${wfStatus.status}`);
        return;
      }

      // Check for a parked gate (pending inbox approval row for this run).
      const pending = await inboxSvc.listInbox({ runId, status: 'pending' });
      if (pending.length > 0) {
        const gateRow = pending[0];
        if (gateRow) {
          const ctx = gateRow.context as Record<string, unknown> | null;
          const topic = typeof ctx?.topic === 'string' ? ctx.topic : '?';
          console.log(`parked:   run ${runId} is waiting at the '${topic}' gate`);
          console.log(`          resolve with: revo inbox resolve ${gateRow.id} --approve|--reject`);
          if (wait) {
            // In wait:true mode: print re-attach hint then return (operator must act at the gate).
            console.log(
              `          this viewer detached — the run's durable state is preserved; resume with: revo run start ${runId} --wait`,
            );
          }
        }
        return;
      }

      if (aborted) {
        console.log(
          `detached — the durable state is preserved; resume with: revo run start ${runId} --wait`,
        );
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
