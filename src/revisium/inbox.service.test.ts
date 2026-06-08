/**
 * inbox.service.test.ts — 5.4 InboxService
 *
 * Fake draft transport; assert da is draft, G3 constructor-body pattern,
 * delegate to verbs correctly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneTransport, TransportRow, TransportList } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { InboxService } from './inbox.service.js';

function makeFakeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data, createdAt: '2026-06-07T10:00:00.000Z', updatedAt: '2026-06-07T10:00:00.000Z' };
}

const INBOX_ROW_DATA: Record<string, unknown> = {
  id: 'inbox-1', kind: 'approval', status: 'pending',
  title: 'T', run_id: '', task_id: '', step_id: '',
  project_id: '', context: 'null', answer: 'null',
  resolved_by: '', resolved_at: '', created_at: '2026-06-07T10:00:00.000Z',
  options: '[]',
};

function makeDraftTransport(rows: Record<string, TransportRow> = {}): ControlPlaneTransport {
  const store: Record<string, TransportRow> = { ...rows };
  const createCalls: string[] = [];
  const patchCalls: string[] = [];

  const transport: ControlPlaneTransport & { createCalls: string[]; patchCalls: string[] } = {
    mode: 'draft' as const,
    createCalls,
    patchCalls,
    async assertReady() {},
    async listRows(): Promise<TransportList> {
      return { edges: Object.values(store).map((node) => ({ node })) };
    },
    async getRow(_table, rowId): Promise<TransportRow> {
      const row = store[rowId];
      if (!row) throw new ControlPlaneError('ROW_NOT_FOUND', `not found: ${rowId}`, { status: 404 });
      return row;
    },
    async createRow(_table, rowId, data): Promise<TransportRow> {
      createCalls.push(rowId);
      const row = makeFakeRow(rowId, data as Record<string, unknown>);
      store[rowId] = row;
      return row;
    },
    async updateRow(_table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
    async patchRow(_table, rowId, patches): Promise<TransportRow> {
      patchCalls.push(rowId);
      const row = store[rowId];
      if (row?.data) {
        for (const op of patches) {
          if (op.op === 'replace') row.data[op.path] = op.value;
        }
      }
      return row ?? makeFakeRow(rowId, {});
    },
  };
  return transport;
}

test('G3 fix: InboxService constructor wires da correctly (no undefined transport)', () => {
  const transport = makeDraftTransport();
  assert.doesNotThrow(() => new InboxService(transport));
});

test('InboxService uses draft transport mode (edge 7)', () => {
  const transport = makeDraftTransport();
  assert.equal(transport.mode, 'draft');
  const svc = new InboxService(transport);
  assert.ok(svc instanceof InboxService);
});

test('InboxService.pushInbox delegates to pushInbox verb and returns id', async () => {
  const transport = makeDraftTransport();
  const svc = new InboxService(transport);
  const id = await svc.pushInbox({
    kind: 'approval',
    title: 'Approve this',
    context: { env: 'staging' },
  });
  assert.ok(typeof id === 'string');
  assert.ok(id.startsWith('inbox_'));
});

test('InboxService.listInbox delegates to listInbox verb', async () => {
  const transport = makeDraftTransport({
    'inbox-1': makeFakeRow('inbox-1', INBOX_ROW_DATA),
  });
  const svc = new InboxService(transport);
  const items = await svc.listInbox();
  assert.ok(Array.isArray(items));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.id, 'inbox-1');
});

test('InboxService.getInbox returns item when found, null when missing', async () => {
  const transport = makeDraftTransport({
    'inbox-1': makeFakeRow('inbox-1', INBOX_ROW_DATA),
  });
  const svc = new InboxService(transport);

  const found = await svc.getInbox('inbox-1');
  assert.ok(found !== null);
  assert.equal(found.id, 'inbox-1');

  const missing = await svc.getInbox('nope');
  assert.equal(missing, null);
});

test('InboxService.resolveInbox delegates to resolveInbox verb (pure, no DBOS)', async () => {
  const inboxId = 'inbox-r';
  const stepId = 'step-r';
  const transport = makeDraftTransport({
    [inboxId]: makeFakeRow(inboxId, {
      ...INBOX_ROW_DATA, id: inboxId, step_id: stepId, status: 'pending',
    }),
    [stepId]: makeFakeRow(stepId, { id: stepId, status: 'awaiting_approval', input: 'null' }),
  });
  const svc = new InboxService(transport);

  await assert.doesNotReject(() => svc.resolveInbox(inboxId, 'approve', 'alice'));
});

test('InboxService.resolveInbox propagates ROW_NOT_FOUND for unknown id', async () => {
  const transport = makeDraftTransport();
  const svc = new InboxService(transport);
  await assert.rejects(
    () => svc.resolveInbox('nope', null, 'alice'),
    (err: unknown) => err instanceof ControlPlaneError && err.code === 'ROW_NOT_FOUND',
  );
});

// ─── 0004: opts.id forwarding + resolveInbox return type ─────────────────────

test('InboxService.pushInbox with opts.id forwards id to the pure verb (deterministic gate path)', async () => {
  const transport = makeDraftTransport();
  const svc = new InboxService(transport);
  const deterministicId = 'inbox_cafebabecafebabe';
  const id = await svc.pushInbox(
    { kind: 'approval', title: 'Gate', context: { topic: 'plan' } },
    { id: deterministicId },
  );
  assert.equal(id, deterministicId, 'service must return the supplied deterministic id verbatim');
});

test('InboxService.pushInbox without opts.id uses timestamp+suffix (0002 back-compat)', async () => {
  const transport = makeDraftTransport();
  const svc = new InboxService(transport);
  const id = await svc.pushInbox({ kind: 'approval', title: 'Gate', context: {} });
  assert.ok(typeof id === 'string', 'id must be a string');
  assert.ok(id.startsWith('inbox_'), 'id must start with inbox_');
  // NOT the deterministic id (no fixed suffix expected)
  assert.notEqual(id, 'inbox_cafebabecafebabe');
});

test('InboxService.resolveInbox returns { status, answer } (G2 forward)', async () => {
  const inboxId = 'inbox-rt';
  const stepId = 'step-rt';
  const transport = makeDraftTransport({
    [inboxId]: makeFakeRow(inboxId, {
      ...INBOX_ROW_DATA, id: inboxId, step_id: stepId, status: 'pending',
    }),
    [stepId]: makeFakeRow(stepId, { id: stepId, status: 'awaiting_approval', input: 'null' }),
  });
  const svc = new InboxService(transport);

  const result = await svc.resolveInbox(inboxId, 'approve', 'alice');

  // G2: must return the stored decision.
  assert.ok(typeof result === 'object' && result !== null, 'must return an object');
  assert.ok('status' in result, 'must have status');
  assert.ok('answer' in result, 'must have answer');
  // status was 'pending' before this call.
  assert.equal(result.status, 'pending', 'status before call must be pending');
});
