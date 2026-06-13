import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('McpModule depends on the task-control-plane API boundary, not core services directly', () => {
  const source = readFileSync(new URL('./mcp.module.ts', import.meta.url), 'utf8');

  assert.match(source, /TaskControlPlaneModule/);
  assert.doesNotMatch(source, /EngineModule/);
  assert.doesNotMatch(source, /RevisiumModule/);
  assert.doesNotMatch(source, /PipelineModule/);
});
