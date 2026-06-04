# Plan 0013 — `revo run cancel <runId>` (flip a run's status to `cancelled`)

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** add a `revo run cancel <runId>` subcommand that sets the run's `task_runs.status`
> to `'cancelled'` (a terminal status already allowed by the schema). Implement a single read/write
> function `cancelRun(da, runId)` in a new `src/run/cancel-run.ts`, register the subcommand in
> `src/cli/commands/run.ts` alongside `create`/`list`/`show`/`events`, handle an unknown `runId` cleanly
> (the same "run not found" + `exitCode = 1` shape `run show` uses), and add real unit tests.
>
> **Out of scope (deferred / not this slice):**
> - **Emitting a `run_cancelled` event** into the `events` table. `createRunWorkflow` emits `run_created`,
>   so an audit event for cancellation is natural — but the task scopes this slice to the status flip only.
>   Adding the event (id generation + `createRow('events', …)` + its own test) is a clean follow-up slice;
>   note it in the report so it is not lost.
> - **Cancelling child rows** (`tasks` / `steps` of the run) or stopping an in-flight worker. The loop stays
>   dumb; a worker that has already claimed a step is not interrupted here. Cascading cancellation to
>   `tasks`/`steps` and lease/claim interaction is its own concern (relates to Plan 0006 step verbs).
> - **A terminal-state guard / `--force`.** Re-cancelling an already-`cancelled` (or `completed`/`failed`)
>   run simply re-writes `status: 'cancelled'`; this slice reports the previous status but does not refuse.
>   A "cannot cancel a completed run" policy is a later decision, not invented here.
> - Numbering: `0009` (inbox + CLI), `0010` (multi-repo), `0011` (GitHub integration) are **reserved by
>   name** in [`../roadmap.md`](../roadmap.md) (lines 35–37); `0012` is taken (`run create --role`). This
>   slice takes the next free number, `0013`.

---

## Design decisions (made for the implementor — do not relitigate without sign-off)

1. **`cancelRun` lives in a NEW `src/run/cancel-run.ts`, not in `inspect-run.ts`.** `inspect-run.ts` is
   semantically read-only — it has an explicit test *"all inspect functions record zero writes"*
   (`src/run/inspect-run.test.ts:319`). A write verb does not belong there. Mirror the existing split:
   writes that create a run live in `src/run/create-run.ts`; the cancel write lives in its own
   `src/run/cancel-run.ts`. The CLI imports `cancelRun` from there.
2. **Update via `patchRow`, not `updateRow`.** Every status transition in the codebase uses
   `da.patchRow(table, id, [{ op: 'replace', path: 'status', value: … }, { op: 'replace', path:
   'updated_at', value: nowIso }])` — see `src/control-plane/steps.ts:190-195` (claim),
   `:232-236` (start), `:398-404` (fail). `patchRow` touches only the named fields, so it cannot clobber
   `title`/`repos`/`priority`/etc. `updateRow` replaces the whole `data` object and would require
   re-sending every field. Use `patchRow`. (`task_runs` is **not** a JSON-field table — `jsonFields` in
   `src/control-plane/json-fields.ts:10-14` lists only `steps`/`events`/`inbox` — so a plain
   `status`/`updated_at` patch passes through `serializePatches` unchanged.)
3. **`'cancelled'` is a real, allowed terminal status.** `docs/control-plane-schema.md:44`:
   `Status: pending → planning → ready → running → (completed | failed | awaiting_approval | paused |
   cancelled)`. Do not introduce a new status string.
4. **Unknown `runId` → return `null`, CLI prints `run not found: <id>` and sets `exitCode = 1`.** This is
   exactly how `runShow` (`src/cli/commands/run.ts:130-134`) and `runEvents`
   (`src/cli/commands/run.ts:158-162`) already behave. The read uses `da.getRow('task_runs', runId)`,
   which returns `null` for a missing row (`src/control-plane/data-access.ts:84-86`). Detect missing
   **before** writing, so an unknown id writes **zero** rows.
5. **`cancelRun` calls `assertReady()` first**, like every other run-layer entry point (`listRuns`
   `inspect-run.ts:117`, `showRun` `:132`, `createRunWorkflow` `create-run.ts:173`). It accepts an optional
   `{ now?: Date }` so the test can assert a deterministic `updated_at` (mirrors `CreateRunInput.now`,
   `create-run.ts:13`).
6. **Default data access (`draft`) permits writes.** `createControlPlaneDataAccess()` defaults to
   `'draft'` (`src/control-plane/data-access.ts:133-135`); `guardHead` only blocks `'head'`
   (`:60-64`). `createRun` already writes through this default, so the cancel CLI uses the same
   `createControlPlaneDataAccess()` with no options.

---

## 0. Context you must read first

- `src/cli/commands/run.ts` — the command surface. Note: the `inspect-run` import (line 4); the
  `ShowOptions` type (lines 21–23); `runShow` (lines 126–151) including its "not found" branch
  (lines 130–134) and its `catch` block (lines 140–150) — you will **copy this catch block shape**;
  `runEvents` (lines 153–180); and `registerRun` (lines 182–218) where `create`/`list`/`show`/`events`
  are wired (the `events` block is lines 210–217). `createControlPlaneDataAccess` is imported on line 2.
- `src/control-plane/steps.ts:190-195` — the canonical `patchRow` status-transition shape you will copy
  (`{ op: 'replace', path: 'status', … }` + `updated_at`).
- `src/control-plane/data-access.ts` — `ControlPlaneDataAccess` type (lines 26–33): `assertReady`,
  `getRow`, `patchRow` are the three methods `cancelRun` needs. `getRow` returns `null` when absent
  (lines 84–86). `patchRow` rethrows a friendly `ROW_NOT_FOUND` if the row vanished between read and
  write (lines 121–127) — acceptable; the pre-read is the primary guard.
- `src/run/inspect-run.test.ts` — the fake-data-access harness you will base the new test's fake on:
  `makeRow` (lines 7–9), `createFakeDataAccess` (lines 21–92) with its `writes`/`calls` capture arrays
  and the `patchRow` stub (lines 87–90), and `captureStderr` is not needed here. Your new test file
  defines its own small fake (do not import from the `.test.ts`).
- `src/run/create-run.ts` — for the `now?: Date` option precedent (line 13) and `assertReady` ordering
  (line 173).
- `docs/control-plane-schema.md:42-44` — `task_runs` fields and the allowed status list.

Key facts:

1. `task_runs` is a runtime table (committed schema, runtime rows) — never versioned. A status flip is a
   runtime write, consistent with the versioning boundary in `CLAUDE.md` / `docs/control-plane-schema.md`.
2. `cancelRun` is read-then-write (get to check existence, then patch). At MVP single-actor scale this is
   acceptable — the same read-then-write pattern `claimNextStep` uses (`steps.ts:142`).

---

## 1. Add `src/run/cancel-run.ts` with the `cancelRun` read/write function

**Files to change:**

- `src/run/cancel-run.ts` (new)

**Implementation notes:**

Create the file with a single exported function and a small result type:

```ts
import type { ControlPlaneDataAccess } from '../control-plane/index.js';

export type CancelRunResult = {
  runId: string;
  previousStatus: string;
  status: 'cancelled';
};

// Reads the run to confirm it exists, then patches status → 'cancelled'.
// Returns null when no run with `runId` exists (caller prints "run not found").
export async function cancelRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date },
): Promise<CancelRunResult | null> {
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const previousStatus = typeof row.data.status === 'string' ? row.data.status : '';
  const nowIso = (opts?.now ?? new Date()).toISOString();

  await da.patchRow('task_runs', runId, [
    { op: 'replace', path: 'status', value: 'cancelled' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  return { runId, previousStatus, status: 'cancelled' };
}
```

Do not emit an event, touch `tasks`/`steps`, or add a terminal-state guard (all out of scope above).

**Verify:**

```bash
npm run typecheck
```

`typecheck` clean.

**Stop conditions:**

- Do not place `cancelRun` in `inspect-run.ts` (Design decision 1) — that file's zero-writes invariant
  must stay true.
- Do not use `updateRow` (Design decision 2).

---

## 2. Register `run cancel` in the CLI and add the `runCancel` action

**Files to change:**

- `src/cli/commands/run.ts`

**Implementation notes:**

1. Add the import near the existing run-layer imports (lines 2–4):
   ```ts
   import { cancelRun } from '../../run/cancel-run.js';
   ```
2. Add a `runCancel` action function. Model the "not found" branch and the `catch` block **exactly** on
   `runShow` (lines 126–151) — same `ControlPlaneError` / `Error` / `String` ladder, same
   `printHint(error, false)`, same `process.exitCode = 1`:
   ```ts
   async function runCancel(runId: string): Promise<void> {
     try {
       const da = createControlPlaneDataAccess();
       const result = await cancelRun(da, runId);
       if (!result) {
         console.error(`run not found: ${runId}`);
         process.exitCode = 1;
         return;
       }
       if (result.previousStatus === 'cancelled') {
         console.log(`run ${result.runId} already cancelled`);
       } else {
         console.log(`cancelled run ${result.runId} (was ${result.previousStatus})`);
       }
     } catch (error) {
       if (error instanceof ControlPlaneError) {
         console.error(`Error: ${formatCause(error)}`);
         printHint(error, false);
       } else if (error instanceof Error) {
         console.error(`Error: ${error.message}`);
       } else {
         console.error(`Error: ${String(error)}`);
       }
       process.exitCode = 1;
     }
   }
   ```
3. In `registerRun` (lines 182–218), after the `events` block (ends line 217) add:
   ```ts
   run
     .command('cancel')
     .description('Cancel a run')
     .argument('<runId>', 'Run ID')
     .action(runCancel);
   ```

Do not add `--json` or other options — cancel takes only the positional `<runId>` for this slice.

**Verify:**

```bash
npm run typecheck
npm run revo -- run cancel --help
```

`typecheck` clean; `--help` shows `Usage: revo run cancel [options] <runId>` and the description, and runs
**without** the daemon (commander `--help` does not touch the control plane).

**Stop conditions:**

- Do not introduce a second `createControlPlaneDataAccess({ revision: … })` — the default (`draft`) is
  the write-capable mode (Design decision 6).

---

## 3. Real unit tests for `cancelRun`

**Files to change:**

- `src/run/cancel-run.test.ts` (new)

**Implementation notes:**

Use `node:test` + `node:assert/strict` like the other `src/run/*.test.ts` files. Define a small local
fake data access (do **not** import from `inspect-run.test.ts`) that records writes and captures the
patch operations so you can assert the exact patch payload. Sketch:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { cancelRun } from './cancel-run.js';

function makeFake(
  runRows: ControlPlaneRow[],
  opts: { assertReadyError?: Error } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const da: ControlPlaneDataAccess = {
    async assertReady() { if (opts.assertReadyError) throw opts.assertReadyError; },
    async listRows() { return []; },
    async getRow(table, rowId) {
      calls.push(`getRow:${table}:${rowId}`);
      return runRows.find((r) => r.rowId === rowId) ?? null;
    },
    async createRow(table, rowId, data) { calls.push(`create:${table}:${rowId}`); return { rowId, data }; },
    async updateRow(table, rowId, data) { calls.push(`update:${table}:${rowId}`); return { rowId, data }; },
    async patchRow(table, rowId, ops) {
      calls.push(`patch:${table}:${rowId}`);
      patches.push({ table, rowId, ops });
      return { rowId, data: { id: rowId } };
    },
  };
  return { da, calls, patches };
}

const RUN = (status: string): ControlPlaneRow => ({
  rowId: 'run-a',
  data: { id: 'run-a', title: 'Run A', status, priority: 0, repos: ['r'] },
});
```

Cover these cases:

1. **Unknown runId → null, zero writes.** `makeFake([])`; `assert.equal(await cancelRun(da, 'nope'), null)`;
   assert `calls` contains `getRow:task_runs:nope` and **no** `patch:`/`update:`/`create:` entry.
2. **Known run → patches status to `cancelled`.** `makeFake([RUN('running')])`; call
   `cancelRun(da, 'run-a', { now: new Date('2026-06-04T00:00:00.000Z') })`; assert the result is
   `{ runId: 'run-a', previousStatus: 'running', status: 'cancelled' }`; assert exactly one patch to
   `task_runs/run-a` whose ops include `{ op: 'replace', path: 'status', value: 'cancelled' }` and
   `{ op: 'replace', path: 'updated_at', value: '2026-06-04T00:00:00.000Z' }`.
3. **Read precedes write.** Assert the `getRow:task_runs:run-a` entry appears **before** the
   `patch:task_runs:run-a` entry in `calls` (existence is checked before the write).
4. **`assertReady` is honored.** `makeFake([], { assertReadyError: new Error('down') })`;
   `await assert.rejects(() => cancelRun(da, 'run-a'), /down/)`; assert **no** `getRow`/`patch` ran
   (assertReady throws first).
5. **Already-cancelled run reports previousStatus `cancelled`.** `makeFake([RUN('cancelled')])`; result
   `previousStatus === 'cancelled'` and a patch is still issued (no terminal-state guard — Design
   decision / out-of-scope).

**Verify:**

```bash
npm run typecheck
npm test
```

All suites green, including the five new cases.

**Stop conditions:**

- Tests must use the in-file fake (no real daemon, no network), matching the other `src/run/*.test.ts`.

---

## 4. Final acceptance

```bash
cd "$(git rev-parse --show-toplevel)"
npm run typecheck
npm run lint:ci
npm test
npm run revo -- run cancel --help     # Usage: revo run cancel [options] <runId>
git diff --check
```

(`npm run verify` = typecheck + lint:ci + test:cov covers the first three in one command.)

**Slice is done when:** `revo run cancel <runId>` flips an existing run's `task_runs.status` to
`'cancelled'` via a single `patchRow` (status + updated_at), an unknown `runId` prints
`run not found: <id>` with exit code 1 and writes **zero** rows, the new `cancelRun` unit tests plus the
full existing suite pass, and lint is clean — with no event emission, no cascading to tasks/steps, and no
terminal-state guard (all explicitly deferred).

---

## 5. Delivery (PR)

When delivering as a PR (per the task input's DELIVERY CONTEXT):

- **Branch:** the work is already on `feat/run-cancel-via-loop` — commit the new/changed files **there**;
  do **not** branch off fresh `master`.
- **gh account:** `revisium-io`. **Base:** `master`. **PR body:** empty. **Never force-push.**
- **No `Co-Authored-By`** trailer.
- Files in the diff: `src/run/cancel-run.ts` (new), `src/run/cancel-run.test.ts` (new),
  `src/cli/commands/run.ts` (edited), `docs/plans/0013-run-cancel-subcommand.md` (this plan).

---

## 6. Report back / open findings

Report:

1. The new `cancelRun` location (`src/run/cancel-run.ts`) and confirmation it uses `patchRow`
   (status + updated_at), reads existence first, and returns `null` for an unknown run.
2. The CLI wiring (`run cancel <runId>`) and how unknown/`assertReady` errors surface (mirrors
   `run show`).
3. Validation outputs (typecheck / lint:ci / test, `run cancel --help`) and the PR URL.

Deferred (named / out-of-scope above): a `run_cancelled` audit event; cascading cancellation to
tasks/steps and worker interruption; a terminal-state guard / `--force`.
