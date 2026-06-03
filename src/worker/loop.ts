import { randomUUID } from 'node:crypto';
import {
  claimNextStep,
  startAttempt,
  writeResult,
  createSteps,
  failStep,
  recoverInFlight,
  compactStamp,
  type Step,
  type NewStep,
} from '../control-plane/steps.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { RunAgent, AttemptResult } from './runner.js';
import { buildContext } from './build-context.js';

async function processClaimedStep(
  deps: WorkerDeps,
  workerId: string,
  step: Step,
): Promise<{ attemptId: string; result: AttemptResult } | null> {
  const { da, loadRole, loadModelProfile, runAgent } = deps;
  const role = await loadRole(step.role);
  const profile = await loadModelProfile(role.modelLevel);
  const context = await buildContext(da, step, role);
  const { attemptId } = await startAttempt(da, step, { workerId, modelProfile: profile.modelId });
  try {
    const result = await runAgent({ role, profile, context, attemptId, step });
    return { attemptId, result };
  } catch (err) {
    await failStep(da, step, attemptId, {
      lesson: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    return null;
  }
}

async function handleResult(
  da: ControlPlaneDataAccess,
  step: Step,
  attemptId: string,
  result: AttemptResult,
): Promise<void> {
  if (result.needsHuman) {
    await parkForHuman(da, step, attemptId, result);
    return;
  }
  await writeResult(da, step, attemptId, result.output, result.costs);
  const nextSteps: NewStep[] = result.nextSteps.map((ns) => ({ ...ns, runId: step.runId }));
  await createSteps(da, nextSteps);
}

export type WorkerDeps = {
  da: ControlPlaneDataAccess;
  loadRole: (name: string) => Promise<Role>;
  loadModelProfile: (level: string) => Promise<ModelProfile>;
  runAgent: RunAgent;
};

export type WorkerOptions = {
  workerId: string;
  roles: string[];
  once?: boolean;
  idleSleepMs?: number;
  maxCycles?: number;
  signal?: AbortSignal;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function parkForHuman(
  da: ControlPlaneDataAccess,
  step: Step,
  attemptId: string,
  result: AttemptResult,
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const st = compactStamp(now);
  const sfx = randomUUID().replaceAll('-', '').slice(0, 8);

  // Minimal inbox parking: mark step awaiting_approval, clear lease, append event.
  // Full pushInbox (inbox row creation + resolution workflow) is deferred.
  await da.patchRow('steps', step.id, [
    { op: 'replace', path: 'status', value: 'awaiting_approval' },
    { op: 'replace', path: 'lease_owner', value: '' },
    { op: 'replace', path: 'lease_expires_at', value: '' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);
  await da.createRow('events', `event_${st}_step-needs-human_${sfx}`, {
    id: `event_${st}_step-needs-human_${sfx}`,
    run_id: step.runId,
    task_id: step.taskId,
    step_id: step.id,
    type: 'step_needs_human',
    payload: { attempt_id: attemptId, lesson: result.lesson },
    actor: 'orchestrator',
    created_at: nowIso,
  });
}

export async function runWorker(deps: WorkerDeps, opts: WorkerOptions): Promise<void> {
  const { da } = deps;
  const { workerId, roles, once, idleSleepMs = 5000, maxCycles, signal } = opts;

  // 1. Recovery on startup: reclaim any steps this worker left orphaned.
  await recoverInFlight(da, workerId);

  let cycles = 0;

  while (true) {
    if (signal?.aborted) break;
    if (maxCycles !== undefined && cycles >= maxCycles) break;

    // 2. Claim next ready step
    const step = await claimNextStep(da, workerId, roles);

    if (!step) {
      if (once) break;
      await sleep(idleSleepMs, signal);
      continue;
    }

    // 3-6. Load role/profile, build context, start attempt, run agent
    const processed = await processClaimedStep(deps, workerId, step);
    if (!processed) {
      if (once) break;
      continue;
    }

    // 7. Write result or park for human — the loop does NOT branch on role name here
    await handleResult(da, step, processed.attemptId, processed.result);

    cycles++;
    if (once) break;
  }
}
