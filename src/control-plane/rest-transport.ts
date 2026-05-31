import { baseUrl, getConfig, isAlive, isHealthy, readRuntime } from '../config.js';
import { ControlPlaneError } from './errors.js';
import { runtimeTables } from './tables.js';

type RequestOptions = {
  method?: string;
  body?: unknown;
};

export type RestTransport = {
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  assertReady(): Promise<void>;
};

type EndpointRow = {
  id?: string;
};

type EndpointList<T> = {
  edges?: Array<{ node?: T }>;
};

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isDuplicateRowBody(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    'message' in details &&
    typeof details.message === 'string' &&
    details.message.startsWith('Rows already exist:')
  );
}

function errorForStatus(status: number, path: string, details: unknown): ControlPlaneError {
  if (status === 404) {
    return new ControlPlaneError('ROW_NOT_FOUND', `Row not found: ${path}`, { status, details });
  }
  if (status === 409 || (status === 400 && isDuplicateRowBody(details))) {
    return new ControlPlaneError('ROW_CONFLICT', `Row conflict: ${path}`, { status, details });
  }
  if (status === 400 || status === 422) {
    return new ControlPlaneError('VALIDATION_FAILURE', `Validation failure: ${path}`, { status, details });
  }
  return new ControlPlaneError('HTTP_ERROR', `HTTP ${status}: ${path}`, { status, details });
}

export function draftRestBaseUrl(httpPort: number): string {
  const { org, project, branch } = getConfig();
  return `${baseUrl(httpPort)}/endpoint/rest/${org}/${project}/${branch}/draft`;
}

export function headRestBaseUrl(httpPort: number): string {
  const { org, project, branch } = getConfig();
  return `${baseUrl(httpPort)}/endpoint/rest/${org}/${project}/${branch}/head`;
}

async function currentDraftBaseUrl(): Promise<string> {
  const runtime = readRuntime();
  if (!runtime || !isAlive(runtime.pid) || !(await isHealthy(runtime.httpPort))) {
    throw new ControlPlaneError('DAEMON_NOT_RUNNING', 'Local Revisium daemon is not running or healthy');
  }
  return draftRestBaseUrl(runtime.httpPort);
}

export function createRestTransport(): RestTransport {
  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${await currentDraftBaseUrl()}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new ControlPlaneError('DAEMON_NOT_RUNNING', `Failed to reach Revisium daemon: ${path}`, { details: error });
    }

    const body = await readBody(response);
    if (!response.ok) throw errorForStatus(response.status, path, body);
    return body as T;
  }

  async function assertReady(): Promise<void> {
    let tables: EndpointList<EndpointRow>;
    try {
      tables = await request<EndpointList<EndpointRow>>('/tables');
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 404) {
        throw new ControlPlaneError('REST_ENDPOINT_MISSING', 'Generated REST endpoint is missing', {
          status: error.status,
          details: error.details,
        });
      }
      throw error;
    }

    const tableIds = new Set((tables.edges ?? []).map((edge) => edge.node?.id).filter((id): id is string => !!id));
    const missing = runtimeTables.filter((table) => !tableIds.has(table));
    if (missing.length > 0) {
      throw new ControlPlaneError('BOOTSTRAP_NOT_APPLIED', 'Control-plane bootstrap is missing runtime tables', {
        details: { missing },
      });
    }
  }

  return { request, assertReady };
}
