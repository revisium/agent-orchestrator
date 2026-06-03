import test from 'node:test';
import assert from 'node:assert/strict';
import { workCommand, makeResolveCwd } from './work.js';
import type { ControlPlaneDataAccess } from '../../control-plane/index.js';
import type { Step } from '../../control-plane/steps.js';

// ─── makeResolveCwd path-traversal guard ──────────────────────────────────────

const FAKE_STEP: Step = {
  id: 's-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'implement',
  status: 'claimed', input: null, output: null, modelProfile: 'standard', runAfter: '',
  attemptCount: 0, maxAttempts: 3, priority: 0, leaseOwner: '', leaseExpiresAt: '', deadReason: '',
};

function fakeDA(repoRef: string): ControlPlaneDataAccess {
  return {
    assertReady: async () => {},
    getRow: async (_table, _rowId) => ({ rowId: _rowId, data: { repo_ref: repoRef } }),
    listRows: async () => [],
    createRow: async () => ({ rowId: '', data: {} }),
    updateRow: async () => ({ rowId: '', data: {} }),
    patchRow: async () => ({ rowId: '', data: {} }),
  };
}

test('makeResolveCwd: throws when repo_ref uses .. to escape the workspace', async () => {
  const base = '/workspace/root';
  const resolveCwd = makeResolveCwd(fakeDA('../evil'), base);
  await assert.rejects(
    () => resolveCwd(FAKE_STEP),
    /resolves outside the workspace base/,
    'path traversal via ../ must be rejected',
  );
});

test('makeResolveCwd: throws when repo_ref is an absolute path outside the workspace', async () => {
  const base = '/workspace/root';
  const resolveCwd = makeResolveCwd(fakeDA('/etc'), base);
  await assert.rejects(
    () => resolveCwd(FAKE_STEP),
    /resolves outside the workspace base/,
    'absolute path escaping the workspace must be rejected',
  );
});

test('makeResolveCwd: resolves a normal relative repo_ref under the workspace base', async () => {
  const base = '/workspace/root';
  const resolveCwd = makeResolveCwd(fakeDA('my-repo'), base);
  const cwd = await resolveCwd(FAKE_STEP);
  assert.equal(cwd, '/workspace/root/my-repo', 'relative repo_ref resolves under base');
});

// ─── workCommand ──────────────────────────────────────────────────────────────

test('workCommand: exits with code 1 and logs an error when --roles produces an empty list', async () => {
  const errors: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    // ',,,' filters to empty after trim+filter — no role names remain.
    await workCommand({ roles: ',,,', once: true });
  } finally {
    console.error = origConsoleError;
  }

  try {
    assert.equal(process.exitCode, 1, 'exit code must be 1 when roles list is empty');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('roles')),
      'error message must mention roles',
    );
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});
