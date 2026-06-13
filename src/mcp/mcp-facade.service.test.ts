import test from 'node:test';
import assert from 'node:assert/strict';
import { McpFacadeService } from './mcp-facade.service.js';
import { MCP_TOOL_NAMES } from './mcp-capabilities.js';
import type { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';

test('McpFacadeService.getCapabilities exposes the MCP transport surface', () => {
  const facade = new McpFacadeService({} as TaskControlPlaneApiService);
  const capabilities = facade.getCapabilities();

  assert.equal(capabilities.transport, 'stdio');
  assert.equal(capabilities.auth, 'none');
  assert.deepEqual(capabilities.tools, [...MCP_TOOL_NAMES]);
  assert.ok(capabilities.tools.includes('create_run'));
  assert.ok(capabilities.tools.includes('approve_gate'));
  assert.ok(capabilities.tools.includes('simulate_route'));
});

test('McpFacadeService delegates product operations to TaskControlPlaneApiService', async () => {
  let received: unknown;
  const api = {
    async createRun(input: unknown) {
      received = input;
      return { runId: 'run-1', started: false };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.createRun({ title: 'Task', repo: '.', start: false });

  assert.deepEqual(received, { title: 'Task', repo: '.', start: false });
  assert.deepEqual(result, { runId: 'run-1', started: false });
});
