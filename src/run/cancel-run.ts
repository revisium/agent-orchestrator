import type { ControlPlaneDataAccess } from '../control-plane/index.js';

export type CancelRunResult = {
  runId: string;
  previousStatus: string;
  status: 'cancelled';
};

export async function cancelRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date },
): Promise<CancelRunResult | null> {
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const previousStatus = typeof row.data.status === 'string' ? row.data.status : '';
  const nowIso = (opts?.now ?? new Date()).toISOString();

  await da.patchRow('task_runs', runId, [
    { op: 'replace', path: 'status', value: 'cancelled' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  return { runId, previousStatus, status: 'cancelled' };
}
