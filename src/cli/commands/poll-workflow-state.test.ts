/**
 * poll-workflow-state.test.ts — unit tests for pollWorkflowState (0006).
 *
 * Coverage:
 *   - wait:false (default): returns on first park — unchanged behavior preserved.
 *   - wait:true: loops past RUNNING iterations and returns at gate / terminal.
 *   - Cap honored: loop exits after maxAttempts even in wait:true mode.
 *   - Default cap: the REAL pollWorkflowState with no overrides exits after 40 attempts
 *     (wait:false default). Changing DEFAULT_MAX_ATTEMPTS breaks this test.
 *   - SIGINT: trips the abort flag, loop returns normally (no process.exit),
 *     so the caller's cleanup (app.close) can run.
 *
 * All fakes are in-memory; no daemon, no DBOS, no Revisium.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pollWorkflowState, type DbosStatusProvider, TERMINAL_STATUSES } from './poll-workflow-state.js';
import type { InboxService } from '../../revisium/inbox.service.js';
import type { InboxItem } from '../../control-plane/inbox.js';

// Re-export for assertions about the default cap constant value.
// Importing TERMINAL_STATUSES confirms the module loads correctly; DEFAULT_MAX_ATTEMPTS
// is internal — we assert the observable behaviour: exactly 40 status polls before timeout.

// ─── helpers ────────────────────────────────────────────────────────────────

/** Build a fake DbosStatusProvider returning the given status sequence (null = not finished). */
function fakeDbos(statuses: Array<{ status: string } | null>): DbosStatusProvider & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async getWorkflowStatus(_id: string) {
      const idx = callCount < statuses.length ? callCount : statuses.length - 1;
      callCount++;
      return statuses[idx] ?? null;
    },
  };
}

type PendingItem = Pick<InboxItem, 'id' | 'context'>;

/**
 * Build a fake InboxService that returns pending items after a given number of calls.
 * beforePark: number of calls that return empty list; on/after that call, return the pending item.
 */
function fakeInbox(
  beforePark: number,
  pendingItem?: PendingItem,
): InboxService & { listCallCount: number } {
  let listCallCount = 0;

  const fakeItem: InboxItem = {
    id: pendingItem?.id ?? 'inbox_gate_smoke',
    kind: 'approval',
    runId: 'run-poll-1',
    taskId: 'task-1',
    stepId: '',
    projectId: '',
    title: 'Gate',
    context: pendingItem?.context ?? { topic: 'plan' },
    options: ['approve', 'reject'],
    status: 'pending',
    answer: null,
    resolvedBy: '',
    createdAt: '2026-06-09T00:00:00Z',
    resolvedAt: '',
  };

  // We only need to implement the listInbox method for pollWorkflowState.
  const svc = {
    get listCallCount() {
      return listCallCount;
    },
    async listInbox(_filter?: { runId?: string; status?: string }): Promise<InboxItem[]> {
      const call = listCallCount;
      listCallCount++;
      if (call >= beforePark && pendingItem !== undefined) {
        return [fakeItem];
      }
      return [];
    },
  } as unknown as InboxService & { listCallCount: number };

  return svc;
}

// ─── wait:false tests ─────────────────────────────────────────────────────────

test('pollWorkflowState wait:false — returns on first pending gate (default behavior preserved)', async () => {
  // First attempt: not terminal, pending gate → should return immediately.
  const dbos = fakeDbos([null]);
  const inbox = fakeInbox(0, { id: 'inbox-plan-1', context: { topic: 'plan' } });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  try {
    await pollWorkflowState('run-1', dbos, inbox, { wait: false, intervalMs: 1 });
    assert.ok(
      logs.some((l) => l.includes('parked')),
      `expected parked log; got: ${JSON.stringify(logs)}`,
    );
    // Only one attempt — returns on first park
    assert.equal(dbos.callCount, 1, 'getWorkflowStatus should be called exactly once');
  } finally {
    console.log = origLog;
  }
});

test('pollWorkflowState wait:false — returns on first terminal status', async () => {
  const dbos = fakeDbos([{ status: 'SUCCESS' }]);
  const inbox = fakeInbox(999); // never parks
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  try {
    await pollWorkflowState('run-1', dbos, inbox, { wait: false, intervalMs: 1 });
    assert.ok(
      logs.some((l) => l.includes('SUCCESS')),
      `expected SUCCESS log; got: ${JSON.stringify(logs)}`,
    );
    assert.equal(dbos.callCount, 1, 'should return after first terminal');
  } finally {
    console.log = origLog;
  }
});

test('pollWorkflowState — FAILURE terminal status surfaces the run_failed reason (0008 #2)', async () => {
  const dbos = fakeDbos([{ status: 'ERROR' }]);
  const inbox = fakeInbox(999);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  let readFailureCalls = 0;

  try {
    await pollWorkflowState('run-1', dbos, inbox, {
      wait: false,
      intervalMs: 1,
      readFailure: async (id: string) => {
        readFailureCalls++;
        assert.equal(id, 'run-1');
        return { runStatus: 'failed', reason: 'integrator: gh pr create failed' };
      },
    });
    assert.equal(readFailureCalls, 1, 'readFailure must be consulted on a FAILURE terminal status');
    assert.ok(logs.some((l) => l.includes('ERROR')), `expected status line; got ${JSON.stringify(logs)}`);
    assert.ok(
      logs.some((l) => l.includes('run failed: integrator: gh pr create failed')),
      `expected run-failed reason; got ${JSON.stringify(logs)}`,
    );
  } finally {
    console.log = origLog;
  }
});

test('pollWorkflowState — SUCCESS terminal does NOT consult readFailure (0008 #2)', async () => {
  const dbos = fakeDbos([{ status: 'SUCCESS' }]);
  const inbox = fakeInbox(999);
  const origLog = console.log;
  console.log = () => {};
  let readFailureCalls = 0;
  try {
    await pollWorkflowState('run-1', dbos, inbox, {
      wait: false,
      intervalMs: 1,
      readFailure: async () => {
        readFailureCalls++;
        return null;
      },
    });
    assert.equal(readFailureCalls, 0, 'readFailure must NOT be called on a non-failure terminal');
  } finally {
    console.log = origLog;
  }
});

test('pollWorkflowState — FAILURE with run-row not patched surfaces the integrity gap (0008 #2)', async () => {
  const dbos = fakeDbos([{ status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' }]);
  const inbox = fakeInbox(999);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    await pollWorkflowState('run-1', dbos, inbox, {
      wait: false,
      intervalMs: 1,
      readFailure: async () => ({ runStatus: 'ready' }), // no reason, run-row never patched
    });
    assert.ok(
      logs.some((l) => l.includes('run-row status=ready')),
      `expected integrity-gap note; got ${JSON.stringify(logs)}`,
    );
  } finally {
    console.log = origLog;
  }
});

test('pollWorkflowState wait:false — times out and prints note when no terminal/gate within cap', async () => {
  // status always null, inbox always empty
  const dbos = fakeDbos([null]);
  const inbox = fakeInbox(9999);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  try {
    await pollWorkflowState('run-1', dbos, inbox, { wait: false, maxAttempts: 3, intervalMs: 1 });
    assert.ok(
      logs.some((l) => l.includes('timed out')),
      `expected timed-out log; got: ${JSON.stringify(logs)}`,
    );
  } finally {
    console.log = origLog;
  }
});

// ─── wait:true tests ──────────────────────────────────────────────────────────

test('pollWorkflowState wait:true — loops past RUNNING iterations, returns at gate', async () => {
  // First 2 attempts: null (still running). 3rd attempt: gate appears.
  const dbos = fakeDbos([null, null, null]);
  const inbox = fakeInbox(2, { id: 'inbox-plan-2', context: { topic: 'plan' } });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  try {
    await pollWorkflowState('run-2', dbos, inbox, { wait: true, maxAttempts: 10, intervalMs: 1 });
    assert.ok(
      logs.some((l) => l.includes('parked')),
      `expected parked log; got: ${JSON.stringify(logs)}`,
    );
    // Should have looped past the first 2 RUNNING attempts
    assert.ok(dbos.callCount >= 3, 'should have polled at least 3 times before seeing gate');
  } finally {
    console.log = origLog;
  }
});

test('pollWorkflowState wait:true — returns at terminal status (SUCCESS)', async () => {
  // First 2 null, then SUCCESS
  const dbos = fakeDbos([null, null, { status: 'SUCCESS' }]);
  const inbox = fakeInbox(9999);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  try {
    await pollWorkflowState('run-2', dbos, inbox, { wait: true, maxAttempts: 10, intervalMs: 1 });
    assert.ok(
      logs.some((l) => l.includes('SUCCESS')),
      `expected SUCCESS log; got: ${JSON.stringify(logs)}`,
    );
    assert.equal(dbos.callCount, 3, 'should return after the third call (first SUCCESS)');
  } finally {
    console.log = origLog;
  }
});

test('pollWorkflowState wait:true — cap honored (no infinite loop)', async () => {
  // Never terminal, never parked — should time out at cap
  const dbos = fakeDbos([null]);
  const inbox = fakeInbox(9999);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  const maxAttempts = 5;
  try {
    await pollWorkflowState('run-cap', dbos, inbox, { wait: true, maxAttempts, intervalMs: 1 });
    assert.ok(
      logs.some((l) => l.includes('timed out')),
      `expected timed-out log; got: ${JSON.stringify(logs)}`,
    );
    // dbos.callCount may be up to maxAttempts (cap loop)
    assert.ok(dbos.callCount <= maxAttempts + 1, `callCount ${dbos.callCount} exceeded cap ${maxAttempts}`);
  } finally {
    console.log = origLog;
  }
});

// ─── wait:true — re-attach hint printed at gate ────────────────────────────────

test('pollWorkflowState wait:true — prints re-attach hint at gate', async () => {
  const dbos = fakeDbos([null]);
  const inbox = fakeInbox(0, { id: 'inbox-merge-1', context: { topic: 'merge' } });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  try {
    await pollWorkflowState('run-reattach', dbos, inbox, { wait: true, maxAttempts: 5, intervalMs: 1 });
    const hasReattach = logs.some((l) => l.includes('resume with'));
    assert.ok(hasReattach, `expected re-attach hint; got: ${JSON.stringify(logs)}`);
  } finally {
    console.log = origLog;
  }
});

// ─── SIGINT: returns normally, no process.exit ───────────────────────────────

test('pollWorkflowState SIGINT — trips abort flag, returns normally (no process.exit)', async () => {
  // Always RUNNING (null status, no pending gate) so the loop would run forever — SIGINT should abort it.
  const dbos = fakeDbos([null]);
  const inbox = fakeInbox(9999);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  // Track if process.exit was called (it must NOT be).
  let exitCalled = false;
  const origExit = process.exit;
  // @ts-expect-error — temporarily override to detect accidental calls
  process.exit = (..._args: unknown[]) => {
    exitCalled = true;
  };

  try {
    // Start poll with a generous cap, then emit SIGINT after a tiny delay.
    const pollPromise = pollWorkflowState('run-sigint', dbos, inbox, {
      wait: true,
      maxAttempts: 9999,
      intervalMs: 50,
    });

    // Emit SIGINT to trigger abort after first sleep begins
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    process.emit('SIGINT');

    await pollPromise; // must resolve (not throw, not hang)

    assert.ok(!exitCalled, 'process.exit must NOT be called on SIGINT — app.close() must be allowed to run');
    assert.ok(
      logs.some((l) => l.includes('detached')),
      `expected detached log; got: ${JSON.stringify(logs)}`,
    );
  } finally {
    console.log = origLog;
    process.exit = origExit;
  }
});

// ─── MAJOR D: default cap is 40 (wait:false), not test-covered until now ─────
//
// Drives the REAL pollWorkflowState with NO maxAttempts override and a 1ms interval
// so the loop completes in milliseconds. Counts how many times getWorkflowStatus is
// called — must equal 40, the DEFAULT_MAX_ATTEMPTS constant. If that constant is
// removed or changed, this test FAILS.

test('pollWorkflowState default wait:false cap — exactly 40 status-poll attempts before timeout', async () => {
  // Never terminal, never parked — drives the full loop to the timeout.
  const dbos = fakeDbos([null]); // always null (never-settling)
  const inbox = fakeInbox(9999); // never parks
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));

  try {
    // No maxAttempts/intervalMs override → uses production defaults (40 × 500ms).
    // We inject intervalMs=1 ONLY — maxAttempts is intentionally left as the default.
    await pollWorkflowState('run-default-cap', dbos, inbox, { intervalMs: 1 });

    assert.ok(
      logs.some((l) => l.includes('timed out')),
      `expected timed-out log; got: ${JSON.stringify(logs)}`,
    );
    // The loop runs from attempt=0 to attempt<40, calling getWorkflowStatus once per iteration.
    assert.equal(
      dbos.callCount,
      40,
      `default wait:false cap must be 40; actual getWorkflowStatus call count: ${dbos.callCount}`,
    );
  } finally {
    console.log = origLog;
  }
});

// TERMINAL_STATUSES is imported above — confirm it is a Set (module sanity check).
test('TERMINAL_STATUSES exported — sanity check module loads correctly', () => {
  assert.ok(TERMINAL_STATUSES instanceof Set, 'TERMINAL_STATUSES must be a Set');
  assert.ok(TERMINAL_STATUSES.has('SUCCESS'), 'TERMINAL_STATUSES must include SUCCESS');
});
