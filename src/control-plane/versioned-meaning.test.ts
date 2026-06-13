import test from 'node:test';
import assert from 'node:assert/strict';
import { createVersionedMeaningAccess, type VersionedMeaningScope } from './versioned-meaning.js';

function fakeScope(seed: Record<string, Record<string, unknown>> = {}) {
  const rows = new Map(Object.entries(seed));
  const calls: string[] = [];
  const scope: VersionedMeaningScope = {
    async getRow(table, rowId) {
      calls.push(`get:${table}/${rowId}`);
      const row = rows.get(`${table}/${rowId}`);
      if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { id: rowId, data: row };
    },
    async createRow(table, rowId, data) {
      calls.push(`create:${table}/${rowId}`);
      rows.set(`${table}/${rowId}`, data as Record<string, unknown>);
      return { id: rowId, data };
    },
    async updateRow(table, rowId, data) {
      calls.push(`update:${table}/${rowId}`);
      rows.set(`${table}/${rowId}`, data as Record<string, unknown>);
      return { id: rowId, data };
    },
    async commit(comment) {
      calls.push(`commit:${comment}`);
      return { id: 'rev-1' };
    },
  };
  return { scope, calls, rows };
}

test('createVersionedMeaningAccess: dry-run does not create a scope or write rows', async () => {
  let called = false;
  const access = createVersionedMeaningAccess({
    dryRun: true,
    scopeFactory: async () => {
      called = true;
      return fakeScope().scope;
    },
  });

  const op = await access.upsertRow({ table: 'playbooks', rowId: 'pb', data: { id: 'pb' } });
  const revision = await access.commit('commit');

  assert.equal(op.action, 'dry-run');
  assert.equal(revision, null);
  assert.equal(called, false);
});

test('createVersionedMeaningAccess: creates missing rows and updates existing rows', async () => {
  const fake = fakeScope({ 'roles/developer': { id: 'developer', name: 'old' } });
  const access = createVersionedMeaningAccess({ scopeFactory: async () => fake.scope });

  const created = await access.upsertRow({ table: 'playbooks', rowId: 'pb', data: { id: 'pb' } });
  const updated = await access.upsertRow({ table: 'roles', rowId: 'developer', data: { id: 'developer', name: 'new' } });
  await access.commit('Install playbook');

  assert.equal(created.action, 'create');
  assert.equal(updated.action, 'update');
  assert.deepEqual(fake.calls, [
    'get:playbooks/pb',
    'create:playbooks/pb',
    'get:roles/developer',
    'update:roles/developer',
    'commit:Install playbook',
  ]);
});
