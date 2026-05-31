import { ControlPlaneError } from './errors.js';
import { deserializeData, serializeData, serializePatches, type PatchOperation } from './json-fields.js';
import { createRestTransport, type RestTransport } from './rest-transport.js';
import { isRuntimeTable, type RuntimeTable } from './tables.js';

export type ListRowsOptions = {
  first?: number;
  after?: string;
  where?: Record<string, unknown>;
  orderBy?: Array<Record<string, unknown>>;
};

export type ControlPlaneRow<TData extends object = Record<string, unknown>> = {
  rowId: string;
  data: TData;
  readonly?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ControlPlaneDataAccess = {
  assertReady(): Promise<void>;
  listRows(table: RuntimeTable, options?: ListRowsOptions): Promise<ControlPlaneRow[]>;
  getRow(table: RuntimeTable, rowId: string): Promise<ControlPlaneRow | null>;
  createRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>): Promise<ControlPlaneRow>;
  updateRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>): Promise<ControlPlaneRow>;
  patchRow(table: RuntimeTable, rowId: string, patches: PatchOperation[]): Promise<ControlPlaneRow>;
};

type EndpointRow = {
  id: string;
  readonly?: boolean;
  createdAt?: string;
  updatedAt?: string;
  data?: Record<string, unknown>;
};

type EndpointList = {
  edges?: Array<{ node?: EndpointRow }>;
};

function assertRuntimeTable(table: RuntimeTable): void {
  if (!isRuntimeTable(table)) {
    throw new ControlPlaneError('VALIDATION_FAILURE', `Unsupported runtime table: ${String(table)}`, {
      details: { table },
    });
  }
}

function rowPath(table: RuntimeTable, rowId: string): string {
  return `/tables/${encodeURIComponent(table)}/row/${encodeURIComponent(rowId)}`;
}

function mapRow(table: RuntimeTable, row: EndpointRow): ControlPlaneRow {
  return {
    rowId: row.id,
    data: deserializeData(table, row.id, row.data ?? {}),
    readonly: row.readonly,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createControlPlaneDataAccessForTransport(transport: RestTransport): ControlPlaneDataAccess {
  return {
    assertReady: () => transport.assertReady(),

    async listRows(table, options = {}) {
      assertRuntimeTable(table);
      const body = { first: 100, ...options };
      const result = await transport.request<EndpointList>(`/tables/${encodeURIComponent(table)}/rows`, {
        method: 'POST',
        body,
      });
      return (result.edges ?? []).map((edge) => {
        if (!edge.node) {
          throw new ControlPlaneError('HTTP_ERROR', `Malformed list response for ${table}`, { details: result });
        }
        return mapRow(table, edge.node);
      });
    },

    async getRow(table, rowId) {
      assertRuntimeTable(table);
      try {
        return mapRow(table, await transport.request<EndpointRow>(rowPath(table, rowId)));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') return null;
        throw error;
      }
    },

    async createRow(table, rowId, data) {
      assertRuntimeTable(table);
      const serialized = serializeData(table, rowId, data);
      return mapRow(
        table,
        await transport.request<EndpointRow>(rowPath(table, rowId), { method: 'POST', body: { data: serialized } }),
      );
    },

    async updateRow(table, rowId, data) {
      assertRuntimeTable(table);
      const serialized = serializeData(table, rowId, data);
      try {
        return mapRow(
          table,
          await transport.request<EndpointRow>(rowPath(table, rowId), { method: 'PUT', body: { data: serialized } }),
        );
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') {
          throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot update missing row: ${table}/${rowId}`, {
            status: error.status,
            details: error.details,
          });
        }
        throw error;
      }
    },

    async patchRow(table, rowId, patches) {
      assertRuntimeTable(table);
      const serialized = serializePatches(table, patches);
      try {
        return mapRow(
          table,
          await transport.request<EndpointRow>(rowPath(table, rowId), { method: 'PATCH', body: { patches: serialized } }),
        );
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') {
          throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot patch missing row: ${table}/${rowId}`, {
            status: error.status,
            details: error.details,
          });
        }
        throw error;
      }
    },
  };
}

export function createControlPlaneDataAccess(): ControlPlaneDataAccess {
  return createControlPlaneDataAccessForTransport(createRestTransport());
}

export type { PatchOperation } from './json-fields.js';
