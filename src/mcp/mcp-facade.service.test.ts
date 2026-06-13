import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { InboxItem } from '../control-plane/inbox.js';
import type { DbosService } from '../engine/dbos.service.js';
import type { PipelineService } from '../pipeline/develop-task.workflow.js';
import type { InboxService } from '../revisium/inbox.service.js';
import type { PlaybooksService } from '../revisium/playbooks.service.js';
import type { RolesService } from '../revisium/roles.service.js';
import type { RunService } from '../revisium/run.service.js';
import { MCP_TOOL_NAMES } from './mcp-capabilities.js';
import { McpFacadeService } from './mcp-facade.service.js';

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-1',
    kind: 'approval',
    runId: 'run-1',
    taskId: '',
    stepId: '',
    projectId: '',
    title: 'Plan approval',
    context: { topic: 'plan' },
    options: [],
    status: 'pending',
    answer: null,
    resolvedBy: '',
    createdAt: '2026-06-13T00:00:00.000Z',
    resolvedAt: '',
    ...overrides,
  };
}

function makeFacade(overrides: {
  runService?: Partial<RunService>;
  inboxService?: Partial<InboxService>;
  rolesService?: Partial<RolesService>;
  playbooksService?: Partial<PlaybooksService>;
  pipelineService?: Partial<PipelineService>;
  dbosService?: Partial<DbosService>;
} = {}): McpFacadeService {
  const runService: Partial<RunService> = {
    async createRun() {
      return { runId: 'run-1', taskId: 'task-1', stepId: 'step-1', eventId: 'event-1', status: 'ready' };
    },
    async getRun() {
      return { rowId: 'run-1', data: { id: 'run-1' } };
    },
    async showRun() {
      return {
        run: {
          runId: 'run-1',
          title: 'Run',
          status: 'ready',
          priority: 0,
          createdAt: '2026-06-13T00:00:00.000Z',
          description: '',
          scope: '',
          repos: [],
        },
        tasks: [],
      };
    },
    async listRunEvents() {
      return [];
    },
    async listRunAttempts() {
      return [];
    },
    async appendEvent() {},
    ...overrides.runService,
  };
  const inboxService: Partial<InboxService> = {
    async getInbox() {
      return makeInboxItem();
    },
    async resolveInbox(_id, answer) {
      return { status: 'pending' as const, answer };
    },
    async listInbox() {
      return [makeInboxItem()];
    },
    ...overrides.inboxService,
  };
  const rolesService: Partial<RolesService> = {
    async loadPipelinePolicy() {
      return { maxReviewIterations: 3, maxAttempts: 3, budgetUsd: 0, budgetTokens: 0 };
    },
    ...overrides.rolesService,
  };
  const pipelineService: Partial<PipelineService> = {
    async startDevelopTask(runId) {
      return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDevelopTask']>>;
    },
    ...overrides.pipelineService,
  };
  const dbosService: Partial<DbosService> = {
    async getWorkflowStatus() {
      return null;
    },
    async signal() {},
    ...overrides.dbosService,
  };
  return new McpFacadeService(
    runService as RunService,
    inboxService as InboxService,
    rolesService as RolesService,
    (overrides.playbooksService ?? {}) as PlaybooksService,
    pipelineService as PipelineService,
    dbosService as DbosService,
  );
}

test('McpFacadeService.getCapabilities exposes the registered product tool surface', () => {
  const facade = makeFacade();
  const capabilities = facade.getCapabilities();
  assert.equal(capabilities.auth, 'none');
  assert.deepEqual(capabilities.tools, [...MCP_TOOL_NAMES]);
  assert.ok(capabilities.tools.includes('create_run'));
  assert.ok(capabilities.tools.includes('approve_gate'));
  assert.ok(capabilities.tools.includes('simulate_route'));
});

test('McpFacadeService.approveGate records retryable signal state around the DBOS signal', async () => {
  const calls: Array<
    | { kind: 'event'; type: string; stepKey: string; payload: unknown }
    | { kind: 'signal'; workflowId: string; topic: string; payload: unknown; key?: string }
  > = [];
  const facade = makeFacade({
    runService: {
      async appendEvent(input) {
        calls.push({ kind: 'event', type: input.type, stepKey: input.stepKey, payload: input.payload });
      },
    },
    dbosService: {
      async signal(workflowId, topic, payload, key) {
        calls.push({ kind: 'signal', workflowId, topic, payload, key });
      },
    },
  });

  const result = await facade.approveGate({ inboxId: 'inbox-1', resolvedBy: 'tester' });

  assert.equal(result.signaled, true);
  assert.equal(result.topic, 'plan');
  assert.deepEqual(calls, [
    {
      kind: 'event',
      type: 'gate_signal_pending',
      stepKey: 'gate:plan',
      payload: { inboxId: 'inbox-1', topic: 'plan' },
    },
    {
      kind: 'signal',
      workflowId: 'run-1',
      topic: 'plan',
      payload: { decision: 'approve', resolvedBy: 'tester' },
      key: 'inbox-1',
    },
    {
      kind: 'event',
      type: 'gate_signaled',
      stepKey: 'gate:plan',
      payload: { inboxId: 'inbox-1', topic: 'plan' },
    },
  ]);
});

test('McpFacadeService.approveGate leaves pending signal state when DBOS signaling fails', async () => {
  const events: string[] = [];
  const facade = makeFacade({
    runService: {
      async appendEvent(input) {
        events.push(input.type);
      },
    },
    dbosService: {
      async signal() {
        throw new Error('signal failed');
      },
    },
  });

  await assert.rejects(() => facade.approveGate({ inboxId: 'inbox-1' }), /signal failed/);
  assert.deepEqual(events, ['gate_signal_pending']);
});

test('McpFacadeService.answerQuestion refuses gate rows so workflows are not left parked', async () => {
  const facade = makeFacade();
  await assert.rejects(
    () => facade.answerQuestion({ inboxId: 'inbox-1', answer: 'yes' }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('McpFacadeService.answerQuestion resolves non-gate questions without signaling DBOS', async () => {
  let signaled = false;
  const facade = makeFacade({
    inboxService: {
      async getInbox() {
        return makeInboxItem({ kind: 'question', context: { topic: 'clarification' }, runId: 'run-1' });
      },
    },
    dbosService: {
      async signal() {
        signaled = true;
      },
    },
  });

  const result = await facade.answerQuestion({ inboxId: 'inbox-1', answer: 'answer' });

  assert.equal(result.signaled, false);
  assert.equal(signaled, false);
});

test('McpFacadeService.createRun can immediately start the workflow', async () => {
  const starts: Array<{ runId: string; mode: string }> = [];
  const facade = makeFacade({
    pipelineService: {
      async startDevelopTask(runId, opts) {
        starts.push({ runId, mode: opts.runnerMode });
        return { workflowID: runId } as Awaited<ReturnType<PipelineService['startDevelopTask']>>;
      },
    },
  });

  const result = await facade.createRun({
    title: 'MCP task',
    repo: '.',
    start: true,
    runnerMode: 'script',
  });

  assert.equal(result.started, true);
  assert.deepEqual(starts, [{ runId: 'run-1', mode: 'script' }]);
});

test('McpFacadeService.validateRepository reports non-existent paths without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revo-mcp-test-'));
  const result = await makeFacade().validateRepository(join(dir, 'missing'));

  assert.equal(result.exists, false);
  assert.equal(result.isDirectory, false);
  assert.equal(result.gitRoot, '');
  assert.equal(result.error, 'Path does not exist.');
});

test('McpFacadeService.getRepositoryContext reports malformed package metadata without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revo-mcp-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'package.json'), '{ not json', 'utf8');

  const result = await makeFacade().getRepositoryContext(dir);

  assert.notEqual(result.gitRoot, '');
  assert.equal(result.packageName, '');
  assert.deepEqual(result.scripts, []);
  assert.match(result.packageError, /JSON/);
});

test('McpFacadeService.getRepositoryContext ignores non-object package scripts metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'revo-mcp-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', scripts: 'oops' }), 'utf8');

  const result = await makeFacade().getRepositoryContext(dir);

  assert.equal(result.packageName, 'pkg');
  assert.deepEqual(result.scripts, []);
  assert.equal(result.packageError, '');
});
