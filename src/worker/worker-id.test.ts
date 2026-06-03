import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveWorkerId } from './worker-id.js';

test('resolveWorkerId: creates dataDir if it does not exist', () => {
  const parentDir = mkdtempSync(join(tmpdir(), 'test-worker-id-parent-'));
  const dir = join(parentDir, 'nested', 'data');
  try {
    const id = resolveWorkerId(undefined, dir);
    assert.ok(id.startsWith('worker-'), 'id should start with worker-');
    assert.ok(existsSync(join(dir, 'worker-id')), 'worker-id file should exist in created dir');
    assert.equal(readFileSync(join(dir, 'worker-id'), 'utf8').trim(), id);
  } finally {
    rmSync(parentDir, { recursive: true });
  }
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'test-worker-id-'));
}

test('resolveWorkerId: returns override when provided', () => {
  const id = resolveWorkerId('custom-worker-id');
  assert.equal(id, 'custom-worker-id');
});

test('resolveWorkerId: generates and persists id on first call', () => {
  const dir = tempDir();
  try {
    const id = resolveWorkerId(undefined, dir);
    assert.ok(id.startsWith('worker-'), 'id should start with worker-');
    assert.ok(existsSync(join(dir, 'worker-id')), 'worker-id file should exist');
    assert.equal(readFileSync(join(dir, 'worker-id'), 'utf8').trim(), id);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('resolveWorkerId: returns same id on subsequent calls (stable across restarts)', () => {
  const dir = tempDir();
  try {
    const id1 = resolveWorkerId(undefined, dir);
    const id2 = resolveWorkerId(undefined, dir);
    assert.equal(id1, id2, 'worker id must be stable across calls');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('resolveWorkerId: override takes precedence over persisted id', () => {
  const dir = tempDir();
  try {
    resolveWorkerId(undefined, dir);
    const overrideId = resolveWorkerId('forced-id', dir);
    assert.equal(overrideId, 'forced-id');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
