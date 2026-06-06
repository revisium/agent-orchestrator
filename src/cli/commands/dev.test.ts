/**
 * Unit tests for src/cli/commands/dev.ts.
 *
 * CR1 (path traversal guard): sanitizeWorkflowID() must reject any id that could
 * cause path traversal (e.g. '../evil', './foo', 'a/b'), and must accept valid ids
 * including the ТЗ resume-test id 'wf-resume-1'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeWorkflowID } from './dev.js';

// ── sanitizeWorkflowID — CR1 path-traversal guard ────────────────────────────

test('sanitizeWorkflowID: accepts valid id with letters and digits', () => {
  assert.equal(sanitizeWorkflowID('abc123'), 'abc123');
});

test('sanitizeWorkflowID: accepts id with hyphens (ТЗ resume-test id wf-resume-1)', () => {
  // The ТЗ acceptance-test id must always be accepted — the regex ^[A-Za-z0-9_-]+$ includes hyphen.
  assert.equal(sanitizeWorkflowID('wf-resume-1'), 'wf-resume-1');
});

test('sanitizeWorkflowID: accepts id with underscores', () => {
  assert.equal(sanitizeWorkflowID('dev_ping_001'), 'dev_ping_001');
});

test('sanitizeWorkflowID: accepts mixed-case id', () => {
  assert.equal(sanitizeWorkflowID('DevPing-ABC_123'), 'DevPing-ABC_123');
});

test('sanitizeWorkflowID: accepts single-character id', () => {
  assert.equal(sanitizeWorkflowID('x'), 'x');
});

test('sanitizeWorkflowID: throws on path traversal "../evil"', () => {
  assert.throws(
    () => sanitizeWorkflowID('../evil'),
    TypeError,
    'path traversal id must throw TypeError',
  );
});

test('sanitizeWorkflowID: throws on path traversal "../../etc/passwd"', () => {
  assert.throws(
    () => sanitizeWorkflowID('../../etc/passwd'),
    TypeError,
  );
});

test('sanitizeWorkflowID: throws on id containing "/"', () => {
  assert.throws(
    () => sanitizeWorkflowID('a/b'),
    TypeError,
    'slash in id must throw (path separator)',
  );
});

test('sanitizeWorkflowID: throws on id with space', () => {
  assert.throws(() => sanitizeWorkflowID('my workflow'), TypeError);
});

test('sanitizeWorkflowID: throws on empty string', () => {
  assert.throws(() => sanitizeWorkflowID(''), TypeError);
});

test('sanitizeWorkflowID: throws on id with dot', () => {
  assert.throws(() => sanitizeWorkflowID('foo.bar'), TypeError);
});

test('sanitizeWorkflowID: returns the same string it receives (no mutation)', () => {
  const id = 'stable-id-42';
  const result = sanitizeWorkflowID(id);
  assert.equal(result, id, 'sanitizeWorkflowID must return the input string unchanged when valid');
  assert.strictEqual(result, id, 'must be the exact same string value');
});
