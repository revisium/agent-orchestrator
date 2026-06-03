import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRole, loadModelProfile } from './definitions.js';
import { ControlPlaneError } from './errors.js';
import type { ControlPlaneTransport } from './client-transport.js';

function makeTransport(rows: Record<string, Record<string, unknown>>): ControlPlaneTransport {
  return {
    mode: 'head' as const,
    async assertReady() {},
    async listRows() { return { edges: [] }; },
    async getRow(table, rowId) {
      const key = `${table}/${rowId}`;
      const data = rows[key];
      if (!data) {
        const err = Object.assign(new Error(`not found: ${key}`), { statusCode: 404 });
        throw err;
      }
      return { id: rowId, data };
    },
    async createRow() { throw new Error('read-only'); },
    async updateRow() { throw new Error('read-only'); },
    async patchRow() { throw new Error('read-only'); },
  };
}

test('loadRole: deserializes a roles row', async () => {
  const transport = makeTransport({
    'roles/architect': {
      id: 'architect',
      name: 'architect',
      system_prompt: 'Plan the work.',
      model_level: 'standard',
      effort: 'high',
      runner: 'claude-code',
      allowed_tools: ['read', 'write'],
      scope_rules: '{"allow":["src"]}',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const role = await loadRole('architect', transport);

  assert.equal(role.name, 'architect');
  assert.equal(role.systemPrompt, 'Plan the work.');
  assert.equal(role.modelLevel, 'standard');
  assert.equal(role.effort, 'high');
  assert.equal(role.runner, 'claude-code');
  assert.deepEqual(role.allowedTools, ['read', 'write']);
  assert.deepEqual(role.scopeRules, { allow: ['src'] });
});

test('loadRole: empty scope_rules deserializes to {}', async () => {
  const transport = makeTransport({
    'roles/developer': {
      id: 'developer',
      name: 'developer',
      system_prompt: 'Implement.',
      model_level: 'standard',
      effort: 'medium',
      runner: 'claude-code',
      allowed_tools: [],
      scope_rules: '',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const role = await loadRole('developer', transport);

  assert.deepEqual(role.scopeRules, {});
});

test('loadRole: throws ROW_NOT_FOUND when row is missing', async () => {
  const transport = makeTransport({});

  await assert.rejects(
    () => loadRole('unknown-role', transport),
    (err: unknown) => {
      const e = err as { statusCode?: number };
      return e.statusCode === 404;
    },
  );
});

test('loadModelProfile: deserializes a model_profiles row', async () => {
  const transport = makeTransport({
    'model_profiles/standard': {
      id: 'standard',
      level: 'standard',
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
      params: '{"temperature":0.2}',
      cost_per_input: 3,
      cost_per_output: 15,
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const profile = await loadModelProfile('standard', transport);

  assert.equal(profile.level, 'standard');
  assert.equal(profile.provider, 'anthropic');
  assert.equal(profile.modelId, 'claude-sonnet-4-6');
  assert.deepEqual(profile.params, { temperature: 0.2 });
  assert.equal(profile.costPerInput, 3);
  assert.equal(profile.costPerOutput, 15);
});

test('loadModelProfile: empty params deserializes to {}', async () => {
  const transport = makeTransport({
    'model_profiles/cheap': {
      id: 'cheap',
      level: 'cheap',
      provider: 'anthropic',
      model_id: 'claude-haiku-4-5-20251001',
      params: '',
      cost_per_input: 0.8,
      cost_per_output: 4,
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const profile = await loadModelProfile('cheap', transport);

  assert.deepEqual(profile.params, {});
});

test('loadModelProfile: throws ROW_NOT_FOUND when row is missing', async () => {
  const transport = makeTransport({});

  await assert.rejects(
    () => loadModelProfile('unknown-level', transport),
    (err: unknown) => {
      const e = err as { statusCode?: number };
      return e.statusCode === 404;
    },
  );
});

test('loadRole: throws VALIDATION_FAILURE for invalid model_level', async () => {
  const transport = makeTransport({
    'roles/bad-role': {
      id: 'bad-role',
      name: 'bad-role',
      system_prompt: 'Bad.',
      model_level: 'ultra-expensive',
      effort: 'low',
      runner: 'claude-code',
      allowed_tools: [],
      scope_rules: '',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  await assert.rejects(
    () => loadRole('bad-role', transport),
    (err: unknown) =>
      err instanceof ControlPlaneError &&
      err.code === 'VALIDATION_FAILURE' &&
      err.message.includes('ultra-expensive'),
  );
});
