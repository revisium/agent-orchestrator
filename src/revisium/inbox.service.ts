import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport, ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { createControlPlaneDataAccessForTransport } from '../control-plane/data-access.js';
import {
  pushInbox,
  listInbox,
  getInbox,
  resolveInbox,
  type NewInboxItem,
  type InboxFilter,
  type InboxItem,
  type ResolveInboxResult,
} from '../control-plane/inbox.js';
import { REVISIUM_TRANSPORT_DRAFT } from './tokens.js';

/**
 * InboxService — thin DI wrapper over the pure inbox verbs.
 * Injects the DRAFT transport (inbox is a runtime/draft table).
 *
 * G3: da is initialized in the constructor BODY (not a class-field initializer).
 * Same pattern as RunService — field-init runs before parameter property assignment
 * under ES2023/NodeNext emit.
 *
 * PURE: no DBOS imports or calls. The DBOS signal (DBOS.send) is layered in 0004.
 */
@Injectable()
export class InboxService {
  private readonly da: ControlPlaneDataAccess;

  constructor(
    @Inject(REVISIUM_TRANSPORT_DRAFT) private readonly draftTransport: ControlPlaneTransport,
  ) {
    // Must build da in the constructor body — see G3 note above.
    this.da = createControlPlaneDataAccessForTransport(this.draftTransport);
  }

  /**
   * pushInbox — insert an inbox row. Returns the inbox id.
   *
   * G1 (0004): accepts `opts.id` — when present, used verbatim (deterministic gate path).
   * 0002 CLI callers pass no opts → timestamp+suffix path unchanged (backward-compatible).
   */
  pushInbox(item: NewInboxItem, opts?: { id?: string }): Promise<string> {
    return pushInbox(this.da, item, opts);
  }

  listInbox(filter?: InboxFilter): Promise<InboxItem[]> {
    return listInbox(this.da, filter);
  }

  getInbox(id: string): Promise<InboxItem | null> {
    return getInbox(this.da, id);
  }

  /**
   * resolveInbox — pure status flip + step unblock.
   *
   * G2 (0004): now returns the STORED decision `{ status, answer }`.
   * Gate CLI callers use `result.answer` to signal WHAT IS RECORDED.
   * 0002 non-gate callers ignore the return — backward-compatible.
   */
  resolveInbox(itemId: string, answer: unknown, resolvedBy: string): Promise<ResolveInboxResult> {
    return resolveInbox(this.da, itemId, answer, resolvedBy);
  }
}
