import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from './errors.js';
import {
  createControlPlaneDataAccessForTransport,
  type ControlPlaneDataAccess,
  type PatchOperation,
} from './data-access.js';
import type { RestTransport } from './rest-transport.js';

type CapturedRequest = {
  path: string;
  method: string;
  body: unknown;
};

function fakeRow(id: string, data: Record<string, unknown>) {
  return { id, data, createdAt: '2026-05-31T00:00:00.000Z', updatedAt: '2026-05-31T00:00:00.000Z' };
}

function createFakeAccess(handler?: (request: CapturedRequest) => unknown): {
  access: ControlPlaneDataAccess;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const transport: RestTransport = {
    async assertReady() {},
    request: async <T>(path: string, options: Parameters<RestTransport['request']>[1] = {}) => {
      const captured = { path, method: options.method ?? 'GET', body: options.body };
      requests.push(captured);
      if (handler) return handler(captured) as T;
      return fakeRow('row-1', { id: 'row-1' }) as T;
    },
  };
  return { access: createControlPlaneDataAccessForTransport(transport), requests };
}

test('list rows posts query options to the draft row list path', async () => {
  const { access, requests } = createFakeAccess(() => ({
    edges: [{ node: fakeRow('run-1', { id: 'run-1', title: 'Run' }) }],
  }));

  const rows = await access.listRows('task_runs', { first: 1, where: { data: { path: 'status', eq: 'pending' } } });

  assert.equal(requests[0]?.path, '/tables/task_runs/rows');
  assert.equal(requests[0]?.method, 'POST');
  assert.deepEqual(requests[0]?.body, { first: 1, where: { data: { path: 'status', eq: 'pending' } } });
  assert.deepEqual(rows[0]?.data, { id: 'run-1', title: 'Run' });
});

test('list rows defaults first to 100', async () => {
  const { access, requests } = createFakeAccess(() => ({ edges: [] }));

  await access.listRows('task_runs');

  assert.deepEqual(requests[0]?.body, { first: 100 });
});

test('get/create/update/patch use expected paths, methods, and bodies', async () => {
  const { access, requests } = createFakeAccess((request) => {
    if (request.path.includes('/steps/')) {
      return fakeRow('step-1', { id: 'step-1', input: '{"a":1}', output: '{"done":true}' });
    }
    return fakeRow('row-1', { id: 'row-1' });
  });

  await access.getRow('steps', 'step-1');
  await access.createRow('steps', 'step-1', { input: { a: 1 }, output: null });
  await access.updateRow('steps', 'step-1', { input: { a: 2 }, output: null });
  await access.patchRow('steps', 'step-1', [{ op: 'replace', path: 'output', value: { done: true } }]);

  assert.deepEqual(
    requests.map(({ path, method }) => ({ path, method })),
    [
      { path: '/tables/steps/row/step-1', method: 'GET' },
      { path: '/tables/steps/row/step-1', method: 'POST' },
      { path: '/tables/steps/row/step-1', method: 'PUT' },
      { path: '/tables/steps/row/step-1', method: 'PATCH' },
    ],
  );
  assert.deepEqual(requests[1]?.body, { data: { id: 'step-1', input: '{"a":1}', output: 'null' } });
  assert.deepEqual(requests[2]?.body, { data: { id: 'step-1', input: '{"a":2}', output: 'null' } });
  assert.deepEqual(requests[3]?.body, { patches: [{ op: 'replace', path: 'output', value: '{"done":true}' }] });
});

test('JSON-ish fields deserialize after reads', async () => {
  const { access } = createFakeAccess(() => fakeRow('event-1', { id: 'event-1', payload: '[{"ok":true}]' }));

  const row = await access.getRow('events', 'event-1');

  assert.deepEqual(row?.data.payload, [{ ok: true }]);
});

test('unsupported table id is rejected', async () => {
  const { access } = createFakeAccess();

  await assert.rejects(
    () => access.listRows('attempts' as never),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('get missing row returns null while update and patch missing rows throw ROW_NOT_FOUND', async () => {
  const { access } = createFakeAccess(() => {
    throw new ControlPlaneError('ROW_NOT_FOUND', 'missing', { status: 404 });
  });

  assert.equal(await access.getRow('task_runs', 'missing'), null);
  await assert.rejects(
    () => access.updateRow('task_runs', 'missing', { title: 'Missing' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND',
  );
  await assert.rejects(
    () => access.patchRow('task_runs', 'missing', [{ op: 'replace', path: 'title', value: 'Missing' }]),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND',
  );
});

test('duplicate and validation errors pass through as explicit codes', async () => {
  const duplicate = createFakeAccess(() => {
    throw new ControlPlaneError('ROW_CONFLICT', 'duplicate', { status: 400 });
  }).access;
  const invalid = createFakeAccess(() => {
    throw new ControlPlaneError('VALIDATION_FAILURE', 'invalid', { status: 422 });
  }).access;

  await assert.rejects(
    () => duplicate.createRow('task_runs', 'run-1', { title: 'Run' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'ROW_CONFLICT',
  );
  await assert.rejects(
    () => invalid.createRow('task_runs', 'run-1', { title: 'Run' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('nested JSON-ish patch paths are rejected before transport', async () => {
  const { access, requests } = createFakeAccess();
  const patches: PatchOperation[] = [{ op: 'replace', path: 'input.repo.path', value: 'repo-value' }];

  await assert.rejects(
    () => access.patchRow('steps', 'step-1', patches),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
  assert.equal(requests.length, 0);
});
