# Plan 0002 - Control-plane data access for draft runtime rows

> **Audience:** an implementing coding agent (low-capability model). Follow the steps **in order**.
> Each step lists the exact files to create/change, implementation notes, a **Verify** command, and stop
> conditions. Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** a small TypeScript data-access layer for runtime rows in the control plane, using the
> generated REST endpoint verified in Plan 0001. Runtime writes target the **draft** revision and are **never
> committed**. **Out of scope:** worker loop, runners, model providers, planner, task scheduling, leases/claiming,
> `@revisium/client` abstraction work, and committing runtime rows.

---

## 0. Context you must read first (do not skip)

Read these real files before writing code. They are the ground truth for this slice:

- `docs/plans/0001-revisium-daemon-and-bootstrap.md` - daemon/bootstrap slice and REST endpoint discovery.
- `docs/getting-started.md` - how to start the local standalone and find the resolved port.
- `docs/control-plane-schema.md` - runtime/versioned boundary and table fields.
- `docs/architecture-overview.md` - invariants, especially "schema knowledge is sealed in one layer".
- `docs/repo-layer-contract.md` - broader future contract; this slice implements only the row-level foundation.
- `control-plane/bootstrap.config.json` - authoritative table schemas and string-encoded JSON-ish fields.
- `src/cli/config.ts` - current config/runtime helpers.
- `src/cli/commands/revisium.ts` and `src/cli/commands/bootstrap.ts` - current daemon/bootstrap behavior.

Key facts already confirmed by Plan 0001:

1. The daemon writes the live HTTP port to `~/.revisium-orchestrator/runtime.json`.
   Do **not** hardcode `19222`; it is only the preferred port.
2. The generated REST endpoint base is:
   `http://localhost:<port>/endpoint/rest/admin/control-plane/master/draft`
3. The table list path is:
   `/endpoint/rest/admin/control-plane/master/draft/tables`
4. Free-form JSON fields did **not** support `additionalProperties: true` in the bootstrap schema. They are
   stored as strings.
5. Runtime rows are draft state. Do not commit them, and do not run any command that creates a revision after
   runtime smoke rows have been written.

This plan intentionally does **not** implement the full `repo-layer-contract.md` method set. It creates the small
REST row foundation needed by the next executable workflow.

---

## 1. Scope and non-goals

### In scope

Create a minimal, boring TypeScript data-access layer for these runtime tables only:

- `task_runs`
- `tasks`
- `steps`
- `events`
- `inbox`

Support these operations:

- list rows
- get row
- create row
- update row
- patch row

Use the generated REST endpoint on the **draft** revision:

```text
http://localhost:<resolvedPort>/endpoint/rest/admin/control-plane/master/draft
```

Expected REST paths for this slice:

```text
GET  /tables                                      # endpoint/bootstrap readiness check
POST /tables/<tableId>/rows                      # list/query rows
GET  /tables/<tableId>/row/<rowId>               # get one row
POST /tables/<tableId>/row/<rowId>               # create one row
PUT  /tables/<tableId>/row/<rowId>               # replace one row's data
PATCH /tables/<tableId>/row/<rowId>              # patch one row's data
```

The list path is a `POST`, not a `GET`, because the endpoint accepts pagination/filter/sort in the request body.
Verify this against the live endpoint before coding the wrapper.

### Out of scope

Do not implement any of these in this slice:

- worker loop
- runners
- model providers
- planner
- task scheduling
- leases or claiming (`claimNextStep`, atomic conditional update, reapers)
- attempts or cost ledger access
- versioned reads for `roles`, `model_profiles`, or `routing_policy`
- `@revisium/client` abstraction, unless you first prove it is already ready, appropriate, and smaller than the
  REST wrapper. The default for this slice is **do not add it**.
- any command that commits runtime rows

---

## 2. Baseline verification - prove the live endpoint shape first

**Files to create/change:** none.

**Implementation notes:**

Start the daemon and bootstrap the schema before creating runtime rows. If you need a fully clean run, stop the
daemon and remove `~/.revisium-orchestrator` before this step. It is acceptable to run `bootstrap --commit`
here only because no runtime rows should exist yet in a clean control plane.

Use the resolved port from `runtime.json`; do not assume the preferred port.

**Verify:**

```bash
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
PORT=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(require('node:os').homedir() + '/.revisium-orchestrator/runtime.json', 'utf8')).httpPort)")
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://localhost:${PORT}/endpoint/rest/admin/control-plane/master/draft/tables"
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'content-type: application/json' \
  -d '{"first":1}' \
  "http://localhost:${PORT}/endpoint/rest/admin/control-plane/master/draft/tables/task_runs/rows"
```

Expected:

- first `curl` prints `200`
- second `curl` prints `200`

**Stop conditions:**

- If the daemon is not healthy, stop and report `revo revisium status` and the last 50 log lines.
- If `/draft/tables` is not `200`, do not implement data access. Report whether the failure is `404`,
  connection refused, or another status.
- If `POST /tables/task_runs/rows` is not `200`, stop and report the actual list/query path discovered from the
  generated endpoint or Swagger/OpenAPI. Do not guess a path.

---

## 3. Move shared runtime config out of the CLI boundary

**Files to create/change:**

- Create `src/config.ts`
- Change `src/cli/config.ts`
- Change `src/cli/commands/revisium.ts` only if imports need adjustment
- Change `src/cli/commands/bootstrap.ts` only if imports need adjustment

**Implementation notes:**

The data-access layer must not import from `src/cli/...`. Promote the existing config/runtime helpers from
`src/cli/config.ts` into `src/config.ts` with no behavior change:

- `repoRoot`
- `RuntimeState`
- `getConfig`
- `readRuntime`
- `removeRuntime`
- `isAlive`
- `baseUrl`
- `healthUrl`
- `revisiumUri`
- `resolvePorts`
- `isPortFree`
- `findFreePort`
- `isHealthy`

Keep `src/cli/config.ts` as a compatibility re-export:

```ts
export * from '../config.js';
```

This keeps the CLI stable while giving non-CLI code a neutral import path.

**Verify:**

```bash
npm run typecheck
./bin/revo.js revisium status
```

Expected:

- typecheck passes
- `revo revisium status` still reports the same daemon state as before the move

**Stop conditions:**

- If moving the file changes `repoRoot` resolution under `tsx` or `dist`, stop and report the exact path
  mismatch. Do not paper over it with `process.cwd()`.
- If the CLI behavior changes, fix the import/refactor first before continuing.

---

## 4. Add the REST transport and explicit error model

**Files to create/change:**

- Create `src/control-plane/errors.ts`
- Create `src/control-plane/rest-transport.ts`
- Create `src/control-plane/index.ts`

**Implementation notes:**

Keep the transport small. It should only know how to:

- read the live daemon state from `readRuntime()`
- verify the pid is alive with `isAlive()`
- verify health via `isHealthy(httpPort)`
- build the draft REST base URL from `getConfig()` and the live port
- send JSON HTTP requests with a short timeout
- map HTTP/network failures into explicit data-access errors

Do **not** use `resolvePorts()` for runtime row writes. `resolvePorts()` falls back to preferred ports when no
live runtime exists; this layer should instead fail clearly with `DAEMON_NOT_RUNNING`.

Use a compact error shape:

```ts
export type ControlPlaneErrorCode =
  | 'DAEMON_NOT_RUNNING'
  | 'BOOTSTRAP_NOT_APPLIED'
  | 'REST_ENDPOINT_MISSING'
  | 'ROW_CONFLICT'
  | 'ROW_NOT_FOUND'
  | 'VALIDATION_FAILURE'
  | 'HTTP_ERROR';

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly status?: number;
  readonly details?: unknown;
}
```

Required behavior:

- no `runtime.json`, stale pid, failed `/api` health, or connection refused -> `DAEMON_NOT_RUNNING`
- healthy daemon but `GET /draft/tables` returns `404` -> `REST_ENDPOINT_MISSING`
- `GET /draft/tables` returns `200` but one of the five in-scope tables is absent -> `BOOTSTRAP_NOT_APPLIED`
- create conflict / duplicate row status from the endpoint -> `ROW_CONFLICT`
- get missing row -> return `null`; update/patch missing row -> `ROW_NOT_FOUND`
- schema or body validation failure (`400` or `422`) -> `VALIDATION_FAILURE`
- other non-2xx statuses -> `HTTP_ERROR`

Implement one readiness method, for example `assertControlPlaneReady()`, that checks the endpoint and required
tables before smoke tests and before callers perform row writes.

**Verify:**

```bash
npm run typecheck
```

If tests are added in step 7 before this is complete, also run:

```bash
npm test
```

**Stop conditions:**

- If the generated endpoint returns different status codes for duplicate rows or validation errors, report the
  actual status/body and update the error mapping in one place. Do not scatter status handling across methods.
- If `GET /draft/tables` cannot distinguish missing bootstrap from missing REST endpoint, report that ambiguity
  in the final report-back and include the best observable signals.

---

## 5. Add table definitions and JSON-ish field serialization

**Files to create/change:**

- Create `src/control-plane/tables.ts`
- Create `src/control-plane/json-fields.ts`
- Create `src/control-plane/json-fields.test.ts` if tests are added in this slice

**Implementation notes:**

Define the in-scope table ids as data, not scattered strings:

```ts
export const runtimeTables = ['task_runs', 'tasks', 'steps', 'events', 'inbox'] as const;
export type RuntimeTable = (typeof runtimeTables)[number];
```

Define the string-encoded JSON-ish fields exactly:

```ts
steps: ['input', 'output']
events: ['payload']
inbox: ['context', 'answer']
```

Rules:

- Public callers pass normal JS values for these fields.
- On create/update, if a JSON-ish field is present and not `undefined`, store `JSON.stringify(value)`.
- On create/update, omit fields whose value is `undefined`; do not serialize `undefined`.
- On read, missing or empty-string JSON-ish fields become `null`.
- On read, non-empty JSON-ish strings are parsed with `JSON.parse`.
- Invalid stored JSON in these fields is a `VALIDATION_FAILURE` with table, row id, and field path.
- Patch operations may replace a whole JSON-ish field. For example `{ op: 'replace', path: 'output', value: {...} }`
  serializes `value` before sending.
- Nested patch paths inside a JSON-ish field, such as `input.repo.path`, are out of scope. Callers must replace
  the full JSON-ish field for now.

Keep row identity clear:

- Revisium `rowId` is canonical.
- `data.id` is kept for readability.
- `createRow(table, rowId, data)` should set `data.id = rowId` when it is absent.
- If `data.id` is present and differs from `rowId`, throw `VALIDATION_FAILURE` before sending the request.

**Verify:**

```bash
npm run typecheck
npm test
```

Expected unit-test cases:

- `steps.input` and `steps.output` round-trip objects through strings
- `events.payload` round-trips arrays/objects
- `inbox.context` and `inbox.answer` round-trip `null` and objects
- empty string deserializes to `null`
- invalid JSON throws `VALIDATION_FAILURE`
- mismatched `rowId` and `data.id` throws `VALIDATION_FAILURE`
- nested JSON-ish patch paths are rejected

**Stop conditions:**

- If Revisium starts accepting real object schemas for these fields, do not switch silently. Report it as a schema
  migration candidate for a later plan.
- If the endpoint expects patch paths with a leading slash, report the observed syntax and adjust the wrapper
  consistently.

---

## 6. Implement the small row API

**Files to create/change:**

- Create `src/control-plane/data-access.ts`
- Change `src/control-plane/index.ts`
- Change `package.json` only if adding a test script in step 7

**Implementation notes:**

Export one factory and a small interface. Keep names boring:

```ts
export type ListRowsOptions = {
  first?: number;
  after?: string;
  where?: Record<string, unknown>;
  orderBy?: Array<Record<string, unknown>>;
};

export type PatchOperation = {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
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

export function createControlPlaneDataAccess(): ControlPlaneDataAccess;
```

Map methods to REST paths:

```text
listRows  -> POST  /tables/<tableId>/rows              body { first, after, where, orderBy }
getRow    -> GET   /tables/<tableId>/row/<rowId>
createRow -> POST  /tables/<tableId>/row/<rowId>       body { data }
updateRow -> PUT   /tables/<tableId>/row/<rowId>       body { data }
patchRow  -> PATCH /tables/<tableId>/row/<rowId>       body { patches }
```

Defaults:

- `listRows` defaults `first` to `100`.
- All methods reject table ids outside `runtimeTables`.
- All writes target `/draft/...`; no method accepts a revision parameter in this slice.
- No method calls `bootstrap`, `create_revision`, `revisiumUri()`, or any commit endpoint.
- No method imports `commander` or any CLI command module.

Keep the API table-level only. Do not add domain verbs like `claimNextStep`, `createTask`, or `pushInbox` yet.
Those are later slices built on top of this foundation.

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- If the generated endpoint response shape differs from `{ edges: [{ node }] }` for lists or row objects for
  single-row operations, stop and report the real shape before writing adapters.
- If `PATCH` cannot update a row through the generated endpoint, keep `updateRow` working, mark `patchRow` as
  blocked, and report the exact status/body.

---

## 7. Add focused tests without new tooling

**Files to create/change:**

- Change `package.json`
- Create `src/control-plane/json-fields.test.ts`
- Create `src/control-plane/data-access.test.ts`

**Implementation notes:**

Use existing dependencies only. The repo already has `tsx`; prefer Node's built-in test runner through `tsx`:

```json
"test": "tsx --test src/**/*.test.ts"
```

Unit tests should not require a live Revisium daemon. Use a tiny local HTTP server or mocked `fetch` for the
transport tests. Test only the boundary behavior:

- endpoint URLs use `/draft`
- list/get/create/update/patch methods use the expected HTTP methods and bodies
- unsupported table id is rejected
- duplicate/validation/not-found statuses map to the correct `ControlPlaneError.code`
- JSON-ish fields are serialized before writes and deserialized after reads

Do not add Jest, Vitest, Playwright, or any other test dependency in this slice.

**Verify:**

```bash
npm test
npm run typecheck
```

**Stop conditions:**

- If `tsx --test` cannot run Node test files in this repo, stop and report the exact issue. Do not add a new test
  framework without explicit approval.

---

## 8. Add one live smoke command for the runtime-row boundary

**Files to create/change:**

- Create `scripts/smoke-control-plane-data-access.ts`
- Change `package.json`

**Implementation notes:**

Add a script that exercises the data-access layer against the live standalone:

```json
"smoke:control-plane": "tsx scripts/smoke-control-plane-data-access.ts"
```

The smoke script should:

1. Call `assertReady()`.
2. Create one `task_runs` row.
3. Create one `tasks` row linked to the run.
4. Create one `steps` row with object `input` and `output: null`.
5. Patch that step's `output` with an object and read it back.
6. Create one `events` row with object `payload`.
7. Create one `inbox` row with object `context` and `answer: null`.
8. List rows from at least `task_runs` and confirm the smoke run is present in draft.
9. Fetch the same smoke step from the `head` endpoint with `curl` or `fetch` and confirm it is **not** present.

Use deterministic smoke ids with a timestamp suffix, for example `smoke-run-<Date.now()>`, so repeated runs do
not conflict unless the conflict behavior is being tested intentionally.

This script must not clean up by committing or creating a revision. Leaving draft smoke rows is acceptable for
the local MVP; they are runtime draft state.

**Verify:**

Run from a clean control plane when validating the whole slice:

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm run build
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:control-plane
```

Expected:

- smoke command exits `0`
- draft endpoint contains the created rows
- head endpoint does not contain the created smoke row

**Stop conditions:**

- If `head` cannot expose the REST endpoint after schema bootstrap, report that and verify the no-commit boundary
  by another observable mechanism before merging.
- If the smoke script requires running `bootstrap --commit` after smoke rows exist, stop. That would commit
  runtime rows and violates the architecture boundary.

---

## 9. Docs and index updates

**Files to create/change:**

- Change `docs/plans/README.md`
- Change `docs/roadmap.md` only if the repository convention requires plan status there in the same PR

**Implementation notes:**

Add Plan 0002 to the plans index. If you also touch the roadmap, keep the change scoped to marking Plan 0002 as
written/ready. Do not edit unrelated doc status.

Do **not** rewrite `repo-layer-contract.md` in this slice. It is the broader future contract and intentionally
goes beyond this REST row foundation.

**Verify:**

```bash
git diff --check
```

**Stop conditions:**

- If changing roadmap/doc status would require reconciling broader slice sequencing, leave it alone and report
  the open doc-status follow-up.

---

## 10. Final acceptance test (the whole slice)

Run from a clean state:

```bash
cd /Users/anton/projects/revisium/agent-orchestrator
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
npm install
npm run build
npm run typecheck
npm test
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
npm run smoke:control-plane
git diff --check
```

Then verify the runtime rows remain draft-only:

```bash
PORT=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(require('node:os').homedir() + '/.revisium-orchestrator/runtime.json', 'utf8')).httpPort)")
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://localhost:${PORT}/endpoint/rest/admin/control-plane/master/draft/tables/steps/row/<smoke-step-id>"
curl -sS -o /dev/null -w '%{http_code}\n' \
  "http://localhost:${PORT}/endpoint/rest/admin/control-plane/master/head/tables/steps/row/<smoke-step-id>"
```

Expected:

- draft returns `200`
- head returns `404` or the endpoint's documented not-found status

**Slice is done when:** typecheck and tests pass, the live smoke creates/reads/updates/patches rows through the
draft generated REST endpoint, JSON-ish fields round-trip correctly, the smoke row is absent from `head`, and no
runtime row commit occurred.

---

## 11. Report back / open findings (do NOT silently resolve)

When done, report:

1. Files created/changed.
2. Exact REST row-operation paths used.
3. Validation outputs for `npm run typecheck`, `npm test`, `npm run smoke:control-plane`, and `git diff --check`.
4. The observed error status/body for:
   - daemon not running
   - bootstrap not applied
   - REST endpoint missing
   - duplicate row create
   - schema validation failure
5. Whether `PATCH /tables/<tableId>/row/<rowId>` works for whole-field JSON-ish replacements.
6. Confirmation that smoke runtime rows were written to `draft` and not visible from `head`.

Open findings to leave for later slices unless they block this one:

- Whether `@revisium/client` is ready to replace this REST transport.
- Atomic claim/update semantics for multiple workers.
- Worker leases, reapers, and `recoverInFlight`.
- Domain verbs (`claimNextStep`, `createTask`, `pushInbox`, `resolveInbox`).
- Versioned reads for roles/model profiles/routing policy.
