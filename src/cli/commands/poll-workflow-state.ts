/**
 * poll-workflow-state.ts — shared polling helper used by `run start` and `inbox resolve`.
 *
 * After enqueueing or signaling a DBOS workflow, the CLI must wait for either:
 *   - a terminal DBOS status (SUCCESS / ERROR / CANCELLED / MAX_RECOVERY_ATTEMPTS_EXCEEDED), or
 *   - a parked gate (pending inbox approval row for this runId).
 *
 * Extracted from run.ts / inbox.ts to eliminate duplication (Sonar CPD).
 * Used by both the run-start path (§3.6) and the gate-resolve path (§3.7).
 */

import type { InboxService } from '../../revisium/inbox.service.js';

/** DBOS terminal workflow statuses. MAX_RECOVERY_ATTEMPTS_EXCEEDED included per G10. */
export const TERMINAL_STATUSES = new Set([
  'SUCCESS',
  'ERROR',
  'CANCELLED',
  'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
]);

/**
 * DbosStatusProvider — minimal interface for querying DBOS workflow status.
 * Accepted by pollWorkflowState so callers need not import DbosService directly.
 */
export type DbosStatusProvider = {
  getWorkflowStatus: (id: string) => Promise<{ status: string } | null>;
};

/**
 * pollWorkflowState — poll until the workflow is terminal or parked at a gate.
 *
 * @param runId       - Workflow / run ID to observe.
 * @param dbosService - DBOS status provider (getWorkflowStatus).
 * @param inboxSvc    - Inbox service for pending-approval detection.
 * @param maxAttempts - Maximum poll iterations before giving up (default 40).
 * @param intervalMs  - Delay between iterations in ms (default 500).
 */
export async function pollWorkflowState(
  runId: string,
  dbosService: DbosStatusProvider,
  inboxSvc: InboxService,
  maxAttempts = 40,
  intervalMs = 500,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
      }
      return;
    }

    // Still running a step — wait and retry.
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  // Timed out — report unknown state.
  console.log('note:     timed out waiting for settled state; check status with: revo run show');
}
