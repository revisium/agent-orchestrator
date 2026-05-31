import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from './errors.js';
import { deserializeData, serializeData, serializePatches } from './json-fields.js';

test('steps input and output round-trip objects through strings', () => {
  const stored = serializeData('steps', 'step-1', {
    input: { repo: 'agent-orchestrator' },
    output: { result: true },
  });

  assert.equal(stored.id, 'step-1');
  assert.equal(stored.input, '{"repo":"agent-orchestrator"}');
  assert.equal(stored.output, '{"result":true}');
  assert.deepEqual(deserializeData('steps', 'step-1', stored), {
    id: 'step-1',
    input: { repo: 'agent-orchestrator' },
    output: { result: true },
  });
});

test('events payload round-trips arrays and objects', () => {
  const objectStored = serializeData('events', 'event-1', { payload: { ok: true } });
  const arrayStored = serializeData('events', 'event-2', { payload: [{ ok: true }] });

  assert.deepEqual(deserializeData('events', 'event-1', objectStored).payload, { ok: true });
  assert.deepEqual(deserializeData('events', 'event-2', arrayStored).payload, [{ ok: true }]);
});

test('inbox context and answer round-trip null and objects', () => {
  const stored = serializeData('inbox', 'inbox-1', {
    context: { question: 'ship?' },
    answer: null,
  });

  assert.equal(stored.context, '{"question":"ship?"}');
  assert.equal(stored.answer, 'null');
  assert.deepEqual(deserializeData('inbox', 'inbox-1', stored), {
    id: 'inbox-1',
    context: { question: 'ship?' },
    answer: null,
  });
});

test('empty JSON-ish fields deserialize to null', () => {
  assert.deepEqual(deserializeData('steps', 'step-1', { input: '', output: '' }), {
    input: null,
    output: null,
  });
});

test('invalid stored JSON throws validation failure', () => {
  assert.throws(
    () => deserializeData('events', 'event-1', { payload: '{' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('mismatched rowId and data.id throws validation failure', () => {
  assert.throws(
    () => serializeData('task_runs', 'run-1', { id: 'run-2' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('undefined fields are omitted on serialize', () => {
  assert.deepEqual(serializeData('steps', 'step-1', { input: undefined, output: null, title: undefined }), {
    id: 'step-1',
    output: 'null',
  });
});

test('whole JSON-ish field patches serialize and nested JSON-ish patches are rejected', () => {
  assert.deepEqual(serializePatches('steps', [{ op: 'replace', path: 'output', value: { ok: true } }]), [
    { op: 'replace', path: 'output', value: '{"ok":true}' },
  ]);

  assert.throws(
    () => serializePatches('steps', [{ op: 'replace', path: 'input.repo.path', value: 'repo-value' }]),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});
