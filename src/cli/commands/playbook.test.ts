import test from 'node:test';
import assert from 'node:assert/strict';
import { installPlaybookCore } from './playbook.js';
import type { PlaybookInstallResult } from '../../playbook/playbook-installer.js';

function makeResult(partial: Partial<PlaybookInstallResult> = {}): PlaybookInstallResult {
  return {
    playbookId: 'pb',
    name: 'PB',
    version: '1.0.0',
    source: 'local:/tmp/pb',
    roles: 2,
    pipelines: 1,
    operations: [],
    committed: false,
    dryRun: false,
    ...partial,
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  const originalLog = console.log;
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  console.log = (message?: unknown) => {
    out += `${String(message ?? '')}\n`;
  };
  try {
    await fn();
    return out;
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
  }
}

test('installPlaybookCore: prints human-readable install result', async () => {
  const out = await captureStdout(() =>
    installPlaybookCore(
      '../agents',
      { commit: false, dryRun: true, json: false },
      { install: async () => makeResult({ dryRun: true }) },
    ),
  );

  assert.match(out, /playbook: pb/);
  assert.match(out, /dry-run: no rows written/);
});

test('installPlaybookCore: forwards options and prints JSON', async () => {
  let received: unknown;
  const out = await captureStdout(() =>
    installPlaybookCore(
      '../agents',
      { commit: true, dryRun: false, json: true, name: 'custom', version: '2.0.0' },
      {
        install: async (options) => {
          received = options;
          return makeResult({ committed: true, revisionId: 'rev-1' });
        },
      },
    ),
  );

  assert.deepEqual(received, {
    source: '../agents',
    commit: true,
    dryRun: false,
    name: 'custom',
    version: '2.0.0',
  });
  assert.equal(JSON.parse(out).revisionId, 'rev-1');
});
