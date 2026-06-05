# Plan 0009 — Inbox: surface human-approval parks and resolve them by status-flip

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** when a step returns `needsHuman`, the loop's `parkForHuman`
> (`src/worker/loop.ts:100-135`) flips the step to `awaiting_approval`, clears the lease, closes the
> attempt, and appends a `step_needs_human` event — but writes **no `inbox` row** (its own comment at
> `loop.ts:117-118` says "Full pushInbox (inbox row creation + resolution workflow) is deferred"). So a
> human has no queue to see pending approvals and no way to resume the chain. This slice closes that:
> (1) `parkForHuman` also creates a `pending` `inbox` row; (2) `revo inbox list` shows pending items;
> (3) `revo inbox resolve <id> [--approve|--reject] [--answer "<text>"]` performs a **status change** —
> the project invariant that "a human decision is a status change" (`docs/inbox-and-gates.md:6`) — by
> flipping the parked step from `awaiting_approval` back to `ready` so `claimNextStep` re-picks it
> (`src/control-plane/steps.ts:165,179`), setting `inbox.status: resolved`, and appending a resolution
> event. The loop stays runner-agnostic and the schema layer stays the only place that knows raw
> table shapes.
>
> **Out of scope (deferred — note, do not build):**
> - Rich / web UI, push notifications (`docs/inbox-and-gates.md` § Mechanics, the "MVP can skip push" bullet).
> - Multi-queue / per-project routing (`inbox` is global by design — `control-plane-schema.md:67`, "never split per project"). Inbox rows carry `project_id: ''` this slice.
> - Routing escalation (architect-first vs human) and reviewer-comment sorting (`inbox-and-gates.md:31-42`).
> - Question/answer **threading** beyond a single resolution: `--answer` stores one answer payload;
>   multi-turn Q&A is later.
> - Re-dispatch semantics beyond flipping the parked step back to `ready`. We do **not** create a fresh
>   "carry the answer + context" step here; the existing parked step is revived as-is (the answer lives
>   on the inbox row + event for now). `buildContext` wiring of the answer into the revived step's
>   prompt is a follow-up (see open findings).
> - `routing_policy.requires_human` gates (the *proactive* approval path) — this slice only handles the
>   **reactive** `needsHuman` park.

---

## 0. Context you must read first

- `src/worker/loop.ts:100-135` — `parkForHuman(da, step, attemptId, result)`. It already mints a
  timestamp id stem: `const st = compactStamp(now)` (line 108) and `const sfx =
  randomUUID().replaceAll('-', '').slice(0, 8)` (line 109). It pauses the attempt (lines 112-115),
  patches the step to `awaiting_approval` + clears lease (lines 119-124), and appends a
  `step_needs_human` event (lines 125-134). The deferral comment is **lines 117-118**:
  ```ts
  // Minimal inbox parking: mark step awaiting_approval, clear lease, append event.
  // Full pushInbox (inbox row creation + resolution workflow) is deferred.
  ```
  This is the seam we extend in Step 2. `result.lesson` and `result.output` are the reason + agent
  output to capture (the event already carries `lesson` at line 131).
- `src/worker/runner.ts:6-13` — `AttemptResult`: `{ output: unknown; artifacts?; nextSteps; costs;
  needsHuman?: boolean; lesson?: string }`. `needsHuman` + `lesson` are optional; `output` is the
  agent's structured output. These are the only fields `parkForHuman` reads.
- `src/poller/pr-readiness.ts:464-465` — a representative `needsHuman` emitter (an **`AttemptResult`**,
  the shape `parkForHuman` receives):
  ```ts
  if (resolved.kind === 'needsHuman') {
    return { output: { verdict: resolved.verdict }, nextSteps: [], needsHuman: true, lesson: resolved.lesson, costs: [] };
  }
  ```
  Confirms the contract: `needsHuman: true`, a human-readable `lesson`, and an `output` object the
  inbox `context` should preserve. The other `AttemptResult` `needsHuman` emitters are the draft-timeout
  block (`pr-readiness.ts:475-481`) and the CI-timeout block (`pr-readiness.ts:514`). **Do not** confuse
  these with the internal `OpenPrResult` `{ kind: 'needsHuman', verdict, lesson }` returns at lines
  289 / 292 / 307 — those are an *internal* union consumed inside `run()`, not an `AttemptResult`, and
  carry no `needsHuman: true` boolean.
- `docs/control-plane-schema.md:23` — `inbox` is **Runtime** ("draft writes, never committed").
- `docs/control-plane-schema.md:65-68` — `inbox` columns:
  `id, kind (approval|question|alert), run_id, task_id, step_id, project_id, title, context,
  options[], status (pending|resolved), answer, resolved_by, created_at, resolved_at`. "`context` and
  `answer` store serialized JSON." "Global, never split per project."
- `control-plane/bootstrap.config.json:325-395` — the **authoritative** `inbox` table schema. Confirm
  the exact property names before writing: `id, kind, run_id, task_id, step_id, project_id, title,
  context, options[], status` (`default: "pending"`), `answer, resolved_by, created_at, resolved_at`.
  `required: []`. **This step changes no schema** — the table already exists; do not edit it.
- `src/control-plane/tables.ts:1-9` — `runtimeTables` already includes `'inbox'` (line 7). So
  `da.createRow('inbox', …)`, `da.getRow('inbox', …)`, `da.listRows('inbox', …)`, and
  `da.patchRow('inbox', …)` all pass `assertRuntimeTable` with no change.
- `src/control-plane/json-fields.ts:13` — `inbox: ['context', 'answer']`. The data-access layer
  **already** JSON-serializes `context`/`answer` on write and parses them on read. So callers pass and
  receive **plain objects** for those two fields — never `JSON.stringify` them at the call site
  (that would double-encode). This is the schema-knowledge seam from invariant 4.
- `src/control-plane/data-access.ts:26-33` — the `ControlPlaneDataAccess` surface is **`assertReady`,
  `listRows`, `getRow`, `createRow`, `updateRow`, `patchRow`** — **there is NO conditional / compare-and-set
  / guarded-patch primitive**. `patchRow` (lines 114-129) is an unconditional replace; `createRow`
  (lines 90-95) throws `ROW_CONFLICT` if the row id already exists (see the `ROW_CONFLICT` error code,
  `errors.ts:4`). So an atomic "flip only if currently pending" transition (Step 5, atomic resolve) and
  an idempotent "create only if absent" park (Step 2) must be **built on top of these primitives** —
  read-then-write under the documented single-worker assumption — not assumed to exist.
- `src/control-plane/errors.ts:1-7` — `ControlPlaneErrorCode` includes `ROW_CONFLICT` and
  `ROW_NOT_FOUND`. `createRow` surfaces `ROW_CONFLICT` on a duplicate id; `getRow`/`patchRow`/`updateRow`
  map `ROW_NOT_FOUND` (data-access lines 85, 104-108, 121-125). The deterministic-id park (Step 2) relies
  on `ROW_CONFLICT` being catchable to make a crash-retry idempotent.
- `src/control-plane/steps.ts:143-198` — `claimNextStep`: server filter `status === 'ready'` (line
  165) and the authoritative in-process re-filter `toStr(d.status) === 'ready'` (line 179). A step
  flipped back to `ready` (and whose `run_after` is empty / past — line 181) is re-picked on the next
  loop turn. **This is why resolve = flip-to-ready works.**
- `src/control-plane/steps.ts:56-69` — `compactStamp(date)` → `YYYYMMDDTHHMMSSmmmZ`. **Exported from
  `steps.ts` only; it is NOT re-exported via `src/control-plane/index.ts`** (the index re-export block,
  lines 14-25, lists `claimNextStep / startAttempt / writeResult / createSteps / failStep /
  recoverInFlight` + their types — `compactStamp` is absent). So every module that needs it imports it
  directly from `'../control-plane/steps.js'` — exactly as `cancel-run.ts:3` does
  (`import { compactStamp } from '../control-plane/steps.js'`). **All new control-plane/run modules in
  this plan import `compactStamp` from `./steps.js` / `../control-plane/steps.js`, never from the
  index.** The deterministic-id pattern to mirror: `event_${compactStamp(now)}_<type>_${suffix}` (see
  `cancel-run.ts:32`, `steps.ts:261`).
- `src/run/cancel-run.ts:11-43` — **the precedent** for a status-flip CLI workflow that also appends an
  event. Note the exact shape to mirror: `await da.assertReady()` first (line 17); `getRow` →
  `return null` if missing (lines 19-20); capture `previousStatus` (line 21); `opts?: { now?: Date;
  idSuffix?: string }` (line 13) for deterministic tests; suffix fallback at line 31
  (`rawSuffix && rawSuffix.length > 0 ? rawSuffix : randomUUID()…`); event id at line 32
  (`event_${compactStamp(now)}_run-cancelled_${suffix}`); event row written via `createRow('events', …)`
  with `actor: 'cli'` (lines 33-40); returns a small result object (lines 42).
- `src/run/cancel-run.test.ts:1-112` — the **test pattern** to mirror: a hand-rolled fake
  `ControlPlaneDataAccess` (`makeFake`, lines 7-41) that records `calls`, `patches`, `creates`; asserts
  read-precedes-write (lines 70-78), `assertReady` honored (lines 80-85), deterministic event id with a
  fixed `now` + `idSuffix` (lines 96-111). No daemon, no network.
- `src/run/inspect-run.ts:113-181` — the **list/format precedent** to mirror (the *shape*, not the
  location): `listRuns`/`listRunEvents` call `da.assertReady()`, `da.listRows(table, { first:
  GLOBAL_CAP, orderBy })`, map rows to a summary type, filter/slice in process. `GLOBAL_CAP = 500`
  (line 43); `str`/`num`/`strArr` defensive readers at lines 45-56. Formatters
  `formatRunList`/`formatEventList` (lines 189-261) use a `pad(s, width)` helper and a trailing
  `(N items)` summary line. Mirror this for `listInbox` + `formatInboxList` — but per invariant 4 those
  two now live in **`src/control-plane/inbox.ts`** (a TYPED control-plane verb), not `src/run/*`,
  because they hold inbox-column knowledge (`context`, `status`, `created_at`). `inspect-run.ts`
  pre-dates the sealed-schema decision (#4 below) and keeps its raw reads as a known wart; do **not**
  copy that placement.
- `src/cli/commands/run.ts:183-252` — `runCancel` (the CLI action: build `da`, call the workflow,
  branch on `null` → "not found", print result; `try/catch` with `formatCause`/`printHint`/
  `process.exitCode = 1`) and `registerRun` (lines 210-252) — the `program.command('run')` →
  `.command('cancel').argument('<runId>').action(runCancel)` registration pattern.
- `src/cli/program.ts:21-32` — `buildProgram()` imports `registerRevisium / registerBootstrap /
  registerRun / registerWork` (lines 3-6) and calls them inside `buildProgram()` (lines 27-30). A new
  `import { registerInbox } from './commands/inbox.js';` and a `registerInbox(program);` call are added
  here (Step 6) following that exact `register*` pattern.
- `src/worker/loop.test.ts:217-242` — the existing `'loop: needsHuman parks step…'` test. It seeds a
  step, runs `needsHuman: true`, and asserts step → `awaiting_approval`, lease cleared, attempt
  `paused`. We extend it (Step 3) to also assert an `inbox` row was created. The tracked fake DA
  (`createTrackedDA`, lines 12-56) already supports `createRow`/`patchRow`/`listRows`/`getRow` for any
  table including `inbox`.
- `docs/roadmap.md` — **locate rows by content, not line number** (line numbers drift): the reserved
  build-slice row begins `| 0009 — inbox + CLI | Not written | pushInbox/resolveInbox …` (currently
  line 35), and the docs row begins `| [inbox-and-gates](./inbox-and-gates.md) | Draft | Plan 0009
  (TBD) | …` (currently line 17). Both updated in Step 6 — grep for `0009 — inbox + CLI` and
  `inbox-and-gates` to find them.

**Confirmed free:** `docs/plans/0009-*.md` and `0010-*.md` do not exist on disk (only `0001`-`0008`,
`0011`-`0018`). This plan takes **0009**.

Key facts:

1. **The data-access layer is the only place that knows raw table shapes** (invariant 4). The `inbox`
   table is already a `RuntimeTable` (`tables.ts:7`) and `context`/`answer` are already declared JSON
   fields (`json-fields.ts:13`). So callers write/read `inbox` through `createRow` / `patchRow` /
   `getRow` / `listRows` and pass **plain objects** for `context`/`answer` — no raw JSON, no new schema
   knowledge leaks out of the data-access seam. **Concretely (the #4 fix): the inbox/steps column
   literals and JSON-patch paths live ONLY in `src/control-plane/*` (`inbox.ts`: `buildInboxRow`,
   `listInbox`/`formatInboxList`, `resolveInbox` + its guarded transition helper). The CLI
   (`src/cli/commands/inbox.ts`) and `src/run/*` stay THIN — they parse flags, call the typed
   control-plane verb, and format output, holding ZERO raw column names or patch-paths.** Invariant 4 is
   the reason the resolve verb and read-model are control-plane verbs, not CLI/run logic.
2. **Resolve = status change, not re-dispatch.** Flipping the parked step `awaiting_approval → ready`
   (and clearing `run_after` so it is immediately claimable) is sufficient for the loop to resume the
   chain, because `claimNextStep` selects on `status === 'ready'` (`steps.ts:165,179`). No loop change
   is needed for resume.
3. **The inbox write belongs in `parkForHuman`, not in a workflow file.** Parking is
   lifecycle mechanics that already mutates attempt + step + events atomically-in-sequence in one place
   (`loop.ts:111-134`); the inbox row is the fourth runtime side-effect of the *same* park event and
   shares its `st`/`sfx` id stem. Splitting it into a separate workflow would duplicate the timestamp/
   suffix and risk a partial park. We keep it inline but extract the **inbox-row construction** into a
   tiny pure helper in the control-plane inbox module (`buildInboxRow` in `src/control-plane/inbox.ts`,
   the schema seam) so the loop holds no column literals beyond calling `createRow('inbox', …)` —
   honoring invariant 4 without adding a daemon-coupled seam.
   (Justification for the loop seam over a standalone workflow: it is one indivisible park, not a
   separately-invokable verb like `cancelRun`.)
4. **Deterministic ids + crash-retry idempotency (the #5 fix).** Inbox id mirrors the event-id stamping
   already in `parkForHuman`: `inbox_${compactStamp(now)}_${sfx}` reusing the **same** `st`/`sfx` the
   park event uses, so a given park yields one stable inbox id. Because the id is derived from the park
   (step/attempt + the park's `compactStamp` stem) and not freshly random, a re-park after a crash —
   between the step-flip/event-append and the inbox write — recomputes the **same** id. The inbox write
   therefore catches `ROW_CONFLICT` (`errors.ts:4`; `createRow` data-access:90-95) and treats an existing
   row for this park as **success, not failure** — guaranteeing *exactly one pending row per park* under
   crash-retry. Resolution event id mirrors `cancel-run.ts:32`:
   `event_${compactStamp(now)}_inbox-resolved_${suffix}`, with the same `idSuffix` test hook.
5. **The loop stays runner-agnostic and the resolve workflow is injectable/testable.** `resolveInbox`
   takes a `ControlPlaneDataAccess` and `opts?: { now?; idSuffix? }` exactly like `cancelRun`; unit
   tests use a fake DA, no daemon.
6. **`--reject` is in-scope as a simple variant** (not deferred): reject resolves the inbox item
   (`status: resolved`, records `answer` + `resolved_by`) but flips the parked step to a terminal state
   rather than reviving it — see Design decision 4 for the exact target status.

---

## Design decisions (do not relitigate)

1. **All inbox/steps schema logic lives in `src/control-plane/inbox.ts`; only triggers live elsewhere
   (invariant-4 seal — the #4 fix).** A single new control-plane module `src/control-plane/inbox.ts`
   holds **every** piece that knows raw inbox/steps columns or patch-paths:
   - `buildInboxRow(args)` — a pure (no-I/O) constructor for the pending row;
   - `listInbox(da, filter?)` + `formatInboxList(items, opts?)` — the read-model (was wrongly placed in
     `src/run/inbox.ts`);
   - `resolveInbox(da, inboxId, opts)` + its guarded pending→resolved transition helper (was wrongly
     placed in `src/run/resolve-inbox.ts`).
   The loop calls `da.createRow('inbox', row.id, row)` with a fully-formed object from `buildInboxRow`
   and holds **zero** column literals; the CLI (`src/cli/commands/inbox.ts`) calls `listInbox` /
   `resolveInbox` and holds **zero** column literals or patch-paths. `parkForHuman` is the *trigger* for
   the inbox write (not its schema owner) because the inbox row is the fourth side-effect of the single
   park event (attempt-pause, step-flip, event-append, inbox-create), sharing one `st`/`sfx` id stem.
   **Why control-plane and not `src/run/*`:** the resolve verb mutates `steps` *and* `inbox` and embeds
   the JSON-patch shapes — that is exactly the schema knowledge invariant 4 forbids outside the
   data-access layer. (`cancel-run.ts` lives in `src/run/` and touches `task_runs`/`events` columns
   directly — a pre-existing wart. This slice does **not** propagate it; new schema-touching verbs go in
   control-plane.)
2. **`kind` is `approval` for this slice.** The schema allows `approval|question|alert`
   (`schema-doc:66`). The `needsHuman` park is, semantically, "a human must approve resuming this
   chain" → `kind: 'approval'`. We do **not** try to infer `question`/`alert` from the agent output in
   this slice (no classifier exists). The field is set explicitly so a later classifier can vary it.
3. **`context` captures everything needed to resolve without re-reading other tables:** a plain object
   `{ run_id, task_id, step_id, attempt_id, role, lesson, output }` (the data-access layer serializes
   it). `lesson` = `result.lesson` (the reason); `output` = `result.output` (the agent output);
   `role` = `step.role`. `title` is a short human label derived from `lesson` (truncated) or
   `"<role> needs approval"` when `lesson` is empty.
4. **Resolve is a status change, guarded on BOTH the inbox row and the step (the #2 + #3 fixes).**
   The inbox `status: resolved` outcomes:
   - `--approve` (default when neither flag given): flip the parked step `awaiting_approval → ready`,
     clear `run_after` + lease so `claimNextStep` re-picks it; the chain resumes.
   - `--reject`: flip the parked step `awaiting_approval → dead` with `dead_reason` = the answer (or
     `"rejected by human"`); the chain does **not** resume. (`dead` is the existing terminal step status
     — `schema-doc:52` / `steps.ts:409`.) Out of scope: any compensating cleanup of sibling steps.
   - `--answer "<text>"` (allowed with either, and alone defaults to approve): stores the human text in
     `inbox.answer` (a plain object `{ text }` — serialized by the layer). With `--approve` the revived
     step carries the answer only via the inbox/event for now (re-dispatch-with-answer is deferred).
   All set `resolved_by` (a CLI-provided actor, default `"human"`), `resolved_at`, and append an
   `inbox_resolved` event carrying `{ inbox_id, step_id, decision: approve|reject, answered: bool }`.

   **Step-status guard (read-precedes-write, the cancel-run.ts pattern — #2 fix):** `resolveInbox`
   **must `getRow('steps', stepId)`** and flip the step **only if `step.status ===
   'awaiting_approval'`**. If the step has advanced (`completed` / `dead` / `claimed` / `cancelled` /
   `running`) or is missing, do **not** patch the step. The inbox row is still resolved + the
   `inbox_resolved` event still emitted (a stale-queue item must still clear), and the result carries
   `stepReadied: false` + `stepStatus: <observed-or-'missing'>` so the CLI can report "step already
   advanced; nothing to revive". This prevents re-readying a step the loop has since completed — the
   same read-then-conditional-write discipline `cancelRun` uses on `task_runs`.

5. **Atomic pending→resolved transition + idempotent re-resolve (the #3 fix).** Two resolvers both
   reading `pending` must NOT both patch + emit duplicate `inbox_resolved` events. The
   `inbox` pending→resolved flip is therefore a **conditional / compare-and-set**: it succeeds only if
   the row is currently `pending`; the **step flip and the resolution event happen ONLY for the resolver
   that wins the transition.** A second (losing) resolver is a no-op — no step patch, no duplicate event
   — and reports `alreadyResolved: true`. Because the data-access layer has **no** conditional-patch
   primitive today (only `getRow`/`patchRow` — `data-access.ts:26-33`), this slice specifies a **minimal
   guarded transition helper in `src/control-plane/inbox.ts`**: re-read the row, verify `status ===
   'pending'`, then `patchRow` to `resolved`. It documents the **single-worker assumption** (one
   resolution path at a time) explicitly, but is **structured so a true conditional/CAS primitive slots
   in later** (the helper is the only call site that would change — see open findings: full-CAS when
   multi-worker). Resolving an already-`resolved` item is a no-op that reports "already resolved" (CLI
   string mirrors `run.ts:192-194`'s already-cancelled handling). Resolving a missing id returns `null`
   → CLI prints "inbox item not found" + exit 1.
6. **No new schema, no committed rows.** `inbox`/`steps`/`events` are runtime rows (versioning
   boundary, `AGENTS.md`); nothing here touches `control-plane/bootstrap.config.json`'s schema or any
   versioned row. The data-access `guardHead` (`data-access.ts:60-64`) already blocks accidental head
   writes.

---

## 1. `buildInboxRow` pure helper in the control-plane inbox module

**Files to change:**

- `src/control-plane/inbox.ts` (new)
- `src/control-plane/inbox.test.ts` (new)
- `src/control-plane/index.ts`

**Implementation notes:**

Create `src/control-plane/inbox.ts` holding the schema-aware constructors/types for inbox rows, so the
loop and CLI never embed column literals. Mirror the field set from `control-plane/bootstrap.config.json:325-395`
and the JSON-field rule from `json-fields.ts:13` (pass **plain objects** for `context`/`answer`).

```ts
import { compactStamp } from './steps.js';

export type InboxKind = 'approval' | 'question' | 'alert';

// Plain object — the data-access layer serializes inbox.context to a JSON string (json-fields.ts).
export type InboxContext = {
  run_id: string;
  task_id: string;
  step_id: string;
  attempt_id: string;
  role: string;
  lesson: string;
  output: unknown;
};

export type InboxRow = {
  id: string;
  kind: InboxKind;
  run_id: string;
  task_id: string;
  step_id: string;
  project_id: string;
  title: string;
  context: InboxContext;   // plain object; layer serializes
  options: string[];
  status: 'pending';
  created_at: string;
};

const TITLE_MAX = 120;

function deriveTitle(role: string, lesson: string): string {
  const trimmed = lesson.trim();
  if (trimmed === '') return `${role || 'step'} needs approval`;
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
}

export function buildInboxRow(args: {
  now: Date;
  idSuffix: string;
  kind?: InboxKind;
  context: InboxContext;
}): InboxRow {
  const { now, idSuffix, context } = args;
  const id = `inbox_${compactStamp(now)}_${idSuffix}`;
  return {
    id,
    kind: args.kind ?? 'approval',
    run_id: context.run_id,
    task_id: context.task_id,
    step_id: context.step_id,
    project_id: '',
    title: deriveTitle(context.role, context.lesson),
    context,
    options: [],
    status: 'pending',
    created_at: now.toISOString(),
  };
}
```

Note on `project_id`: it is set **explicitly to the empty string `''`** in this slice. The inbox is
global (`schema-doc:67`, "never split per project") and there is no per-project routing here, so a
parked row carries **no** project association — `project_id: ''` makes that intentional emptiness
explicit (not a forgotten field). Per-project routing is deferred (see open findings).

Export `buildInboxRow`, `InboxRow`, `InboxContext`, `InboxKind` from `src/control-plane/index.ts`
(append to the existing export block, lines 14-25, alongside the `steps.js` re-exports). Since this
module also imports `compactStamp` from `./steps.js`, confirm there is no import cycle (it is a leaf;
`steps.js` does not import `inbox.js`).

Add `src/control-plane/inbox.test.ts`: assert the id is `inbox_${compactStamp(now)}_${suffix}` for a
fixed `now`/`suffix`; `kind` defaults to `'approval'`; `status` is `'pending'`; `title` is the
truncated lesson and falls back to `"<role> needs approval"` on empty lesson; `context` is passed
through **unserialized** (a plain object) and `run_id`/`task_id`/`step_id` are copied from it.

**Verify:**

```bash
npm run typecheck
npx tsx --test src/control-plane/inbox.test.ts
```

**Stop conditions:**

- Do **not** `JSON.stringify` `context` here — the data-access layer does that on write
  (`json-fields.ts:39`). Double-encoding would make `revo inbox list` show a string-in-a-string.
- Do **not** add `answer`/`resolved_by`/`resolved_at` to the *pending* row — those are written by
  resolution (Step 5). Keep the `status` literal type `'pending'` so a miswrite is a type error.
- Do **not** import `ControlPlaneDataAccess` here — this module is pure (no I/O), like a builder.

---

## 2. `parkForHuman` creates the inbox row

**Files to change:**

- `src/worker/loop.ts`

**Implementation notes:**

In `parkForHuman` (`loop.ts:100-135`), after the existing `step_needs_human` event `createRow` (ends
line 134) and reusing the **same** `st`/`sfx` minted at lines 108-109, add the inbox write. Import
`buildInboxRow` (and the `da.createRow('inbox', …)` call). Replace the deferral comment at lines
117-118 with a one-line note that the inbox row is now created below.

```ts
import { ControlPlaneError } from '../control-plane/index.js';
import { buildInboxRow } from '../control-plane/inbox.js';
// …
const inbox = buildInboxRow({
  now,
  idSuffix: sfx,
  context: {
    run_id: step.runId,
    task_id: step.taskId,
    step_id: step.id,
    attempt_id: attemptId,
    role: step.role,
    lesson: result.lesson ?? '',
    output: result.output,
  },
});
// Deterministic id (inbox_<stamp>_<sfx>, same stem as the park event) → a crash-retry recomputes the
// SAME id, so an existing row for this park is SUCCESS, not failure: exactly one pending row per park.
try {
  await da.createRow('inbox', inbox.id, inbox);
} catch (err) {
  if (!(err instanceof ControlPlaneError && err.code === 'ROW_CONFLICT')) throw err;
  // Row already exists from a prior park attempt — idempotent no-op.
}
```

Ordering: keep attempt-pause → step-flip → event-append → **inbox-create** last. Rationale to encode in
a comment: the inbox row is the human-visible artifact; if a write fails mid-park the step is already
`awaiting_approval` and the event records the park, so a missing inbox row is recoverable/visible,
whereas a missing step-flip would silently keep the step claimed. The deterministic id (not a fresh
random) is what makes the retry reconcile to the **same** row instead of creating a duplicate.

**Verify:**

```bash
npm run typecheck
npx tsx --test src/worker/loop.test.ts
```

**Stop conditions:**

- Do **not** change the step-flip, attempt-pause, or event-append already present (lines 112-134) —
  only **append** the inbox write. The existing `'loop: needsHuman parks step…'` assertions
  (`loop.test.ts:233-241`) must still pass unchanged.
- Do **not** mint a new timestamp/suffix for the inbox row — reuse `st`/`sfx` so one park = one stable
  inbox id (Design decision 4). (`buildInboxRow` calls `compactStamp(now)` itself; pass the same `now`
  and `sfx`.)
- Do **not** route a `createRow('inbox', …)` failure through `failStep` — `parkForHuman` is already
  past the point of return; let a *genuine* failure propagate like the other park writes (the step is
  already parked). **Exception:** a `ROW_CONFLICT` is **not** a failure — it means a prior park already
  created this row (same deterministic id). Catch it and continue (idempotent retry). Every other error
  code re-throws.
- Do **not** mint a fresh random id for the inbox row — the determinism is load-bearing for the
  ROW_CONFLICT idempotency above. Reuse `st`/`sfx` (pass the same `now`/`sfx` to `buildInboxRow`).
- The loop must remain runner-agnostic: no `role`/`kind` branching, no runner-specific fields.

---

## 3. Extend the loop park test for the inbox row

**Files to change:**

- `src/worker/loop.test.ts`

**Implementation notes:**

Extend the existing `'loop: needsHuman parks step and creates no next steps'` test
(`loop.test.ts:217-242`). The runner result there is
`{ output: { question: 'approve?' }, nextSteps: [], costs: [], needsHuman: true }`. Add a `lesson`
(e.g. `lesson: 'needs sign-off'`) to that result, then after the existing assertions add:

- `tracked.rows('inbox')` has exactly one row.
- That row's `data.status === 'pending'`, `data.kind === 'approval'`, `data.step_id === 'step-1'`,
  `data.run_id` / `data.task_id` match the seeded step.
- `data.context` round-trips as a **plain object** (the tracked fake DA stores what it is given;
  assert `context.lesson === 'needs sign-off'` and `context.output` deep-equals `{ question: 'approve?' }`,
  and `context.step_id === 'step-1'`).
- The inbox `rowId` starts with `inbox_` and shares the timestamp stem with the `step_needs_human`
  event row (both minted from the same `st`). (Assert `rowId.startsWith('inbox_')`; a strict
  cross-id-stem assertion is optional — the fake DA does not inject a fixed clock here.)

> Note: the tracked fake DA (`loop.test.ts:33-38`) stores `data` verbatim and does **not** run
> `json-fields` serialization, so `context` stays a plain object in the test — assert it as an object,
> not a JSON string. (Real serialization is covered by `json-fields.test.ts` and the data-access tests.)

**Verify:**

```bash
npx tsx --test src/worker/loop.test.ts
```

**Stop conditions:**

- Do not weaken the existing park assertions (status `awaiting_approval`, lease cleared, attempt
  `paused`) — only add the inbox assertions.

---

## 4. `listInbox` + formatter (read model) — in `src/control-plane/inbox.ts`

**Files to change:**

- `src/control-plane/inbox.ts` (the module created in Step 1 — **append** `listInbox` +
  `formatInboxList` + `InboxItem` here; this is a control-plane verb, NOT `src/run/*`, per invariant 4
  / Design decision 1)
- `src/control-plane/inbox.test.ts` (the test file from Step 1 — append the read-model cases)

**Implementation notes:**

Mirror `inspect-run.ts`'s list/format precedent (lines 113-261) for **shape**, but the code lives in
`src/control-plane/inbox.ts` because it reads raw inbox columns (`context`, `status`, `created_at`).
Within the module, import the data-access types from the sibling `./data-access.js` (or relative
`./index.js` re-exports); do **not** reach back through `src/run/*`. Append to `src/control-plane/inbox.ts`:

```ts
import type { ControlPlaneDataAccess, ControlPlaneRow } from './data-access.js';

export type InboxItem = {
  inboxId: string;
  kind: string;
  status: string;
  runId: string;
  stepId: string;
  title: string;
  lesson: string;       // pulled from context.lesson for the list view
  createdAt: string;
};

const GLOBAL_CAP = 500;

export async function listInbox(
  da: ControlPlaneDataAccess,
  filter?: { status?: string; limit?: number },
): Promise<InboxItem[]> {
  await da.assertReady();
  const rows = await da.listRows('inbox', {
    first: GLOBAL_CAP,
    orderBy: [{ field: 'createdAt', direction: 'desc' }],
  });
  let items = rows.map(toInboxItem);
  // Default view is pending-only; explicit --status overrides.
  const status = filter?.status ?? 'pending';
  if (status !== 'all') items = items.filter((i) => i.status === status);
  if (filter?.limit !== undefined) items = items.slice(0, filter.limit);
  return items;
}
```

`toInboxItem(row)` reads `row.data` defensively (use the `str`/`num` helper pattern from
`inspect-run.ts:45-56`); `lesson` comes from the **deserialized** `context` object
(`data.context` is already a parsed object on read — `json-fields.ts:50-67`; guard for `null`/non-object
and fall back to `''`). `createdAt` = `str(row.data.created_at ?? row.createdAt)`.

`formatInboxList(items, opts?: { now?: Date })`: mirror `formatEventList` (`inspect-run.ts:243-261`) —
a padded header `INBOX  KIND  STEP  AGE  TITLE`, one line per item, trailing `(N item(s))` summary. AGE
= a compact human delta from `createdAt` to `now` (e.g. `5m`, `2h`, `3d`); keep it simple and pure so
it is testable with an injected `now`.

In `src/control-plane/inbox.test.ts` (fake-DA pattern from `cancel-run.test.ts:7-41`): seed two inbox
rows (one `pending`, one `resolved`); assert default `listInbox` returns only the pending one; `status:
'all'` returns both; `status: 'resolved'` returns only the resolved; `limit` slices; `lesson` is read
from `context.lesson`; `formatInboxList` renders a header + one row + summary and a deterministic AGE
with a fixed `now`.

**Verify:**

```bash
npm run typecheck
npx tsx --test src/control-plane/inbox.test.ts
```

**Stop conditions:**

- Do **not** re-`JSON.parse` `context` — the data-access layer already returns it parsed
  (`json-fields.ts:61`). Treat `data.context` as a possibly-`null` object and guard.
- Keep the default view **pending-only** (the human's queue); `--status all|resolved` is the override.
- Do not query per-run; the inbox is global (`schema-doc:67`). No `where: run_id` filter.

---

## 5. `resolveInbox` verb (atomic status-flip + step guard + event) — in `src/control-plane/inbox.ts`

**Files to change:**

- `src/control-plane/inbox.ts` (the module from Steps 1 & 4 — **append** `resolveInbox` + the guarded
  transition helper here; this is a control-plane verb, NOT `src/run/*`, per invariant 4)
- `src/control-plane/inbox.test.ts` (append the resolve cases)

**Implementation notes:**

Mirror `cancel-run.ts:11-43` for the **structure** (assertReady → getRow → null guard → capture prev →
… → event → return), but two things differ from `cancelRun`: the transition is **atomic** (#3) and the
step flip is **guarded on `step.status`** (#2). **Import `compactStamp` from `./steps.js`, NOT from the
index** (the index does not re-export it — §0). Append to `src/control-plane/inbox.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { ControlPlaneDataAccess } from './data-access.js';
import { compactStamp } from './steps.js';        // index does NOT re-export compactStamp

export type ResolveDecision = 'approve' | 'reject';

export type ResolveInboxResult = {
  inboxId: string;
  stepId: string;
  decision: ResolveDecision;
  previousStatus: string;          // the inbox row's prior status
  stepReadied: boolean;            // true iff we actually flipped the step this call
  stepStatus: string;              // the step's status AFTER this call ('ready'|'dead'|observed|'missing')
  alreadyResolved: boolean;
};

// Atomic-ish pending→resolved transition built on getRow/patchRow (data-access has NO CAS primitive,
// data-access.ts:26-33). Single-worker assumption documented; a true conditional/CAS slots in here
// later WITHOUT touching resolveInbox (this is the only call site that changes — see open findings).
// Returns true iff THIS call won the transition (flipped pending→resolved); false if already resolved.
async function transitionInboxToResolved(
  da: ControlPlaneDataAccess,
  inboxId: string,
  patch: Array<{ op: 'replace'; path: string; value: unknown }>,
): Promise<boolean> {
  const current = await da.getRow('inbox', inboxId);
  if (!current) return false;
  if ((typeof current.data.status === 'string' ? current.data.status : '') !== 'pending') return false;
  await da.patchRow('inbox', inboxId, patch);
  return true;
}

export async function resolveInbox(
  da: ControlPlaneDataAccess,
  inboxId: string,
  opts: { decision: ResolveDecision; answer?: string; resolvedBy?: string; now?: Date; idSuffix?: string },
): Promise<ResolveInboxResult | null> {
  await da.assertReady();

  const inbox = await da.getRow('inbox', inboxId);
  if (!inbox) return null;

  const stepId = typeof inbox.data.step_id === 'string' ? inbox.data.step_id : '';
  const previousStatus = typeof inbox.data.status === 'string' ? inbox.data.status : '';
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const resolvedBy = opts.resolvedBy && opts.resolvedBy.length > 0 ? opts.resolvedBy : 'human';
  const decision = opts.decision;

  // Already resolved (or some other resolver won): no-op, no step patch, no event.
  if (previousStatus !== 'pending') {
    return { inboxId, stepId, decision, previousStatus, stepReadied: false, stepStatus: '', alreadyResolved: true };
  }

  // 1. WIN the atomic pending→resolved transition FIRST. Only the winner flips the step + emits the
  //    event. A loser (status moved off 'pending' between our read and the re-read) is a clean no-op.
  const answered = Boolean(opts.answer && opts.answer.length > 0);
  const inboxPatch: Array<{ op: 'replace'; path: string; value: unknown }> = [
    { op: 'replace', path: 'status', value: 'resolved' },
    { op: 'replace', path: 'resolved_by', value: resolvedBy },
    { op: 'replace', path: 'resolved_at', value: nowIso },
  ];
  if (answered) inboxPatch.push({ op: 'replace', path: 'answer', value: { text: opts.answer } }); // plain obj; layer serializes
  const won = await transitionInboxToResolved(da, inboxId, inboxPatch);
  if (!won) {
    return { inboxId, stepId, decision, previousStatus, stepReadied: false, stepStatus: '', alreadyResolved: true };
  }

  // 2. STEP GUARD (read-precedes-write, the cancel-run discipline): flip the step ONLY if it is still
  //    awaiting_approval. If it advanced/was cancelled/completed/missing, leave it — still resolve+emit.
  let stepReadied = false;
  let stepStatus = 'missing';
  if (stepId) {
    const step = await da.getRow('steps', stepId);
    const observed = step && typeof step.data.status === 'string' ? step.data.status : 'missing';
    stepStatus = observed;
    if (observed === 'awaiting_approval') {
      const stepPatch =
        decision === 'approve'
          ? [
              { op: 'replace', path: 'status', value: 'ready' },
              { op: 'replace', path: 'run_after', value: '' },   // immediately claimable
              { op: 'replace', path: 'lease_owner', value: '' },
              { op: 'replace', path: 'lease_expires_at', value: '' },
              { op: 'replace', path: 'updated_at', value: nowIso },
            ]
          : [
              { op: 'replace', path: 'status', value: 'dead' },
              { op: 'replace', path: 'dead_reason', value: answered ? (opts.answer as string) : 'rejected by human' },
              { op: 'replace', path: 'lease_owner', value: '' },
              { op: 'replace', path: 'lease_expires_at', value: '' },
              { op: 'replace', path: 'updated_at', value: nowIso },
            ];
      await da.patchRow('steps', stepId, stepPatch);
      stepReadied = true;
      stepStatus = decision === 'approve' ? 'ready' : 'dead';
    }
  }

  // 3. Append the resolution event (mirror cancel-run.ts:32-40 id + actor shape). Only the winner reaches here.
  const suffix = opts.idSuffix && opts.idSuffix.length > 0 ? opts.idSuffix : randomUUID().replaceAll('-', '').slice(0, 8);
  const eventId = `event_${compactStamp(now)}_inbox-resolved_${suffix}`;
  await da.createRow('events', eventId, {
    id: eventId,
    run_id: typeof inbox.data.run_id === 'string' ? inbox.data.run_id : '',
    task_id: typeof inbox.data.task_id === 'string' ? inbox.data.task_id : '',
    step_id: stepId,
    type: 'inbox_resolved',
    payload: { inbox_id: inboxId, decision, answered, resolved_by: resolvedBy, step_readied: stepReadied, step_status: stepStatus },
    actor: 'cli',
    created_at: nowIso,
  });

  return { inboxId, stepId, decision, previousStatus, stepReadied, stepStatus, alreadyResolved: false };
}
```

> `serializePatches` (`json-fields.ts:72-83`) JSON-encodes a top-level `answer` patch value
> automatically (`answer` ∈ `jsonFields.inbox`). So pass `{ text: … }` as a plain object. The patch
> arrays are typed as `Array<{ op: 'replace'; path: string; value: unknown }>` to satisfy
> `PatchOperation[]` (`json-fields.ts:4-8`) without an `as never` cast — confirm it types cleanly.

> **On the atomic transition (#3):** the data-access layer has **no** conditional-patch /
> compare-and-set primitive (only `getRow`/`patchRow`/`createRow` — `data-access.ts:26-33`).
> `transitionInboxToResolved` is therefore a re-read-then-patch guard that is correct **under the
> single-worker assumption** (one resolution path at a time — the CLI is the only caller this slice).
> It is the **only** place that would change when a true conditional/CAS lands (e.g. a
> `patchRowIf(table, id, when, patch)` primitive): `resolveInbox` stays identical. Document this
> assumption in a comment. This kills the stale-read double-patch + DUPLICATE `inbox_resolved` event:
> the step flip and the event live **after** the won transition, so a second resolver (which loses the
> transition) emits nothing.

Append to `src/control-plane/inbox.test.ts` (fake-DA from `cancel-run.test.ts`; seed an `inbox` row
with `status: 'pending'` + a `step_id`, and the corresponding `steps` row with `status:
'awaiting_approval'`):

- **approve:** step patched to `ready`, `run_after` cleared, lease cleared; inbox patched to
  `resolved` + `resolved_by` + `resolved_at`; one `inbox_resolved` event with `decision: 'approve'`,
  `answered: false`, `step_readied: true`. Result `stepReadied: true`, `stepStatus: 'ready'`.
  Deterministic event id with fixed `now`/`idSuffix` (`event_<stamp>_inbox-resolved_<suffix>`).
- **approve + answer:** inbox `answer` patch present with value `{ text: '<answer>' }`; event
  `answered: true`.
- **reject:** step patched to `dead` with `dead_reason` = answer-or-default; inbox `resolved`; event
  `decision: 'reject'`; result `stepStatus: 'dead'`.
- **STEP ADVANCED — step `completed`:** seed the `steps` row `status: 'completed'`. Assert: **no** step
  patch (recorder shows no `patch:steps:`), inbox **is** resolved, **one** `inbox_resolved` event
  emitted, result `stepReadied: false` + `stepStatus: 'completed'`, `alreadyResolved: false`.
- **STEP ADVANCED — step `claimed`:** same as above with `stepStatus: 'claimed'`, no step patch.
- **STEP ADVANCED — step `dead`:** same with `stepStatus: 'dead'`, no step patch (do not re-kill).
- **STEP MISSING — no `steps` row:** no step patch, inbox resolved + event emitted, result
  `stepReadied: false` + `stepStatus: 'missing'`.
- **missing inbox id:** `resolveInbox(da, 'nope', …)` returns `null`, zero patches/creates (mirror
  `cancel-run.test.ts:48-56`).
- **already resolved:** seed inbox `status: 'resolved'`; returns `alreadyResolved: true`, **no** step
  patch, **no** event, **no** inbox patch (assert via call recorder).
- **DOUBLE-RESOLVE / no duplicate event:** simulate two resolutions of the same pending row. Drive the
  loser by having `transitionInboxToResolved`'s re-read return a row whose `status` is already
  `'resolved'` (e.g. the fake DA flips its stored status on the first `patch:inbox:` so the second
  call's re-read sees `resolved`). Assert: **exactly one** `inbox_resolved` event total, **exactly one**
  `patch:inbox:`, and the second call returns `alreadyResolved: true` with **no** step patch.
- **read precedes write** and **assertReady honored** (mirror `cancel-run.test.ts:70-85`).

**Verify:**

```bash
npm run typecheck
npx tsx --test src/control-plane/inbox.test.ts
```

**Stop conditions:**

- Do **not** flip the step inside the *already-resolved* / *transition-lost* short-circuits — re-resolve
  must be a no-op (a second `--approve` must not re-ready a step the loop may have since completed).
- Do **not** flip the step unless `step.status === 'awaiting_approval'` — a `completed`/`claimed`/`dead`/
  `cancelled`/missing step is left alone (still resolve the inbox + emit the event). This is the #2 guard.
- Do **not** emit the `inbox_resolved` event or patch the step for a resolver that **lost** the atomic
  transition — only the winner does (this is what prevents the duplicate event, #3).
- Do **not** add new step statuses — reuse `ready` (claimable) and `dead` (`steps.ts:409` /
  `schema-doc:52`). The loop is untouched; resume is purely the `claimNextStep` `ready` filter
  (`steps.ts:165,179`).
- Do **not** `JSON.stringify` the `answer` value — the layer serializes it (Step 1 / `json-fields.ts`).
- Keep the verb runner-agnostic and free of CLI/`console` calls (that lives in Step 6).

---

## 6. `revo inbox list` / `revo inbox resolve` CLI + docs/roadmap

**Files to change:**

- `src/cli/commands/inbox.ts` (new)
- `src/cli/program.ts`
- `docs/roadmap.md`
- `docs/inbox-and-gates.md`

**Implementation notes:**

Create `src/cli/commands/inbox.ts` mirroring `run.ts` (`formatCause`/`printHint` error handling at
lines 32-48; `parseLimit` at lines 95-102; the per-action `try/catch` + `process.exitCode = 1`
pattern). Import the verbs + formatter from the **control-plane** module (Steps 4-5), not `src/run/*`:
`import { listInbox, formatInboxList, resolveInbox } from '../../control-plane/inbox.js';` and
`import { createControlPlaneDataAccess, ControlPlaneError } from '../../control-plane/index.js';`. The
CLI holds **no** raw column literals or patch-paths. Two actions + a `registerInbox(program)`:

```ts
export function registerInbox(program: Command): void {
  const inbox = program.command('inbox').description('Manage the human-approval inbox');

  inbox
    .command('list')
    .description('List inbox items (pending by default)')
    .option('--status <status>', 'Filter by status (pending|resolved|all)', 'pending')
    .option('--limit <n>', 'Maximum number of results')
    .option('--json', 'Output as JSON', false)
    .action(inboxList);

  inbox
    .command('resolve')
    .description('Resolve an inbox item (approve resumes the chain; reject kills the step)')
    .argument('<id>', 'Inbox item id')
    .option('--approve', 'Approve: flip the parked step back to ready', false)
    .option('--reject', 'Reject: mark the parked step dead', false)
    .option('--answer <text>', 'Answer text stored on the resolution (NOT yet injected into the revived step — see note)')
    .option('--by <actor>', 'Who is resolving (recorded as resolved_by)', 'human')
    .action(inboxResolve);
}
```

- `inboxList`: build `da = createControlPlaneDataAccess()`, call `listInbox(da, { status, limit })`;
  `--json` → `JSON.stringify(items, null, 2)`; else `console.log(formatInboxList(items))`. Reuse the
  `ControlPlaneError`/`printHint` catch from `run.ts:114-124`.
- `inboxResolve`: validate the flag combination — `--approve` and `--reject` together is an error
  (print `Error: choose at most one of --approve / --reject` + exit 1). Decision = `reject` if
  `--reject` else `approve` (default; `--answer` alone defaults to approve). Call
  `resolveInbox(da, id, { decision, answer, resolvedBy: by })`. On `null` → `inbox item not found:
  <id>` + exit 1. On `alreadyResolved` → `inbox <id> already resolved`. Otherwise branch on the
  result's `stepReadied`: if `true`, print e.g. `resolved <id>: approved → step <stepId> ready` /
  `rejected → step <stepId> dead`; if `false` (the step had already advanced or was missing), print a
  distinct line e.g. `resolved <id>: <decision>; step <stepId> already <stepStatus> — nothing to
  revive` so the operator is not misled into thinking a completed step was re-queued.
- **`--answer` help wording (#6d):** do **NOT** advertise `--answer` as functional on `--approve`.
  Answer-into-context on resume is **deferred** (open findings) — on approve the answer is stored on the
  inbox row + event only and is not yet wired into the revived step's prompt. The `--answer` option help
  text must reflect that it is recorded, not acted on. (On `--reject` the answer additionally becomes the
  step's `dead_reason`, which IS functional.)

Register in `program.ts`: add `import { registerInbox } from './commands/inbox.js';` and call
`registerInbox(program);` inside `buildProgram()` next to the other `register*` calls (lines 27-30).

`docs/roadmap.md` (**locate rows by content — line numbers drift**): update the build-slice table.
`grep` for the row beginning `| 0009 — inbox + CLI | Not written | …` (currently line 35): change
Status to `Draft` and add a linked title pointing at this plan file, e.g.:
`| [0009 — inbox + CLI](./plans/0009-inbox-human-approval-resolution.md) | Draft | parkForHuman writes
an inbox row; revo inbox list/resolve flips the parked step back to ready (approve) or dead (reject) |`.
Also `grep` for the docs row beginning `| [inbox-and-gates](./inbox-and-gates.md) | Draft | Plan 0009
(TBD) | …` (currently line 17) — drop the `(TBD)` from its "Realized by" cell.

`docs/inbox-and-gates.md` (**locate by content**): bump the **Status note** — the line reading
`> **Status: DRAFT.** Built with the inbox slice.` (currently line 3) — to reflect that the reactive
`needsHuman` park is now realized by Plan 0009. Update the **"Realized by:"** line (currently line 7,
`> **Realized by:** … (Plan TBD).`) to point at this plan instead of "Plan TBD". Add one sentence under
the `## Mechanics` heading noting that `revo inbox list` shows the queue and `revo inbox resolve
--approve` revives the parked step by flipping it to `ready` (the proactive plan/merge gates via
`routing_policy` remain deferred). **Note** the existing Mechanics bullet (currently lines 23-25) frames
resume as "a fresh narrow run carrying the context + answer (not a resumed session)"; this slice instead
**revives the existing parked step as-is** (answer-into-context deferred). Either soften that bullet to
match this slice or add a one-line "this slice: step revived as-is; carry-the-answer is a follow-up"
caveat — do not leave the doc claiming a capability this slice does not build. Keep the doc otherwise
intact.

**Verify:**

```bash
npm run typecheck
npm run build
./bin/revo.js inbox --help
./bin/revo.js inbox list --help
./bin/revo.js inbox resolve --help
```

(`inbox --help` must list `list` and `resolve`; `resolve --help` must show `--approve`, `--reject`,
`--answer`, `--by`.)

**Stop conditions:**

- The CLI files must contain **no** raw inbox/step column literals — all reads/writes go through
  `listInbox`/`resolveInbox` (Steps 4-5). The CLI only parses flags and formats output.
- Do not register `inbox` under `run` — it is a top-level command group (`revo inbox …`), parallel to
  `revo run …`.
- Do not edit `control-plane/bootstrap.config.json` (no schema change; `inbox` table already exists).

---

## 7. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
npm run typecheck
npm run lint:ci
npm test
npm run build
./bin/revo.js revisium stop || true
rm -rf ~/.revisium-orchestrator
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
# inbox table exists from bootstrap; the queue is empty initially:
./bin/revo.js inbox list
# end-to-end park → list → resolve (drive a needsHuman park via the worker, then):
#   ID=$(./bin/revo.js inbox list --json | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d)[0].inboxId))")
#   ./bin/revo.js inbox resolve "$ID" --approve
#   ./bin/revo.js inbox list           # the item is gone from the pending view
#   ./bin/revo.js inbox list --status resolved   # it appears as resolved
#   ./bin/revo.js run show <runId>     # the parked step is back to ready (then claimed by the loop)
git diff --check
./bin/revo.js revisium stop
```

**Slice is done when:** a `needsHuman` park writes exactly one `pending` `inbox` row (`kind:
'approval'`, `context` = run/task/step/attempt ids + role + lesson + agent output) in addition to the
existing step-flip / attempt-pause / `step_needs_human` event; `revo inbox list` shows pending items
(id, kind, step, age, title) and `--status all|resolved` / `--limit` / `--json` work; `revo inbox
resolve <id> --approve` flips the parked step `awaiting_approval → ready` (cleared `run_after`/lease) so
`claimNextStep` resumes the chain, sets the inbox row `resolved` (+ `resolved_by`/`resolved_at`/optional
`answer`) and appends an `inbox_resolved` event; `--reject` resolves the item and marks the step `dead`;
`--answer "<text>"` attaches the answer; re-resolving is a safe no-op and a missing id exits 1; the
data-access layer remains the only place with inbox/step column knowledge; the loop stays
runner-agnostic; all workflows are unit-tested with a fake DA (no daemon, no network); and **no schema
or committed rows changed**.

---

## 8. Report back / open findings

Report:

1. Where the schema-touching logic lives — **all of it in `src/control-plane/inbox.ts`**
   (`buildInboxRow`, `listInbox`/`formatInboxList`, `resolveInbox` + `transitionInboxToResolved`); the
   loop and CLI hold zero column literals (invariant 4 / Design decision 1). The inbox WRITE is
   *triggered* by `parkForHuman` (one indivisible park, shared `st`/`sfx` id stem) but constructed by
   the control-plane helper.
2. The resolve = status-flip mechanics, **guarded twice**: (a) the `inbox` pending→resolved flip is an
   atomic compare-and-set (only the winner proceeds; a loser is a no-op with no duplicate event);
   (b) the STEP flip happens only if `step.status === 'awaiting_approval'` — approve → step `ready`
   (resumes via `claimNextStep`'s `ready` filter), reject → step `dead`; if the step already advanced/is
   missing, the inbox is still resolved + event still emitted, with `stepReadied: false` reported.
3. The `--reject` decision (in-scope simple variant: resolve + step `dead`, no sibling cleanup) and the
   `--answer` handling (plain `{ text }` object stored in `inbox.answer`; on approve it is recorded but
   **not** wired into the revived step — deferred; on reject it becomes `dead_reason`).
4. The deterministic ids: `inbox_<compactStamp>_<sfx>` (reusing the park's stem) — making a crash-retry
   reconcile to the **same** row via `ROW_CONFLICT` idempotency (exactly one pending row per park); and
   `event_<compactStamp>_inbox-resolved_<suffix>`.
5. Validation: typecheck, lint, test (loop park + the `src/control-plane/inbox.test.ts` cases:
   buildInboxRow + listInbox + resolveInbox incl. step-advanced/missing + double-resolve-no-duplicate),
   build, `inbox --help` surface; confirmation that no schema / committed rows changed.

Open findings / deferred:

- **Answer-into-context on resume (and `--answer` is NOT advertised as functional on approve).**
  `--approve --answer` revives the parked step as-is; the human answer lives on the inbox row + event
  but is **not** yet injected into the revived step's `buildContext` prompt. **The CLI help for
  `--answer` must therefore NOT claim it is acted on during approve** — it is recorded only (on reject it
  does become the step's `dead_reason`). Wiring the answer into the re-dispatched step's context (or
  creating a fresh "carry the answer" step) is the natural follow-up — needed before question/answer
  parks are truly actionable. This also keeps the slice consistent with the `inbox-and-gates.md`
  Mechanics bullet, which must be softened from "fresh narrow run carrying the context + answer" to
  "step revived as-is" for this slice.
- **`project_id` is empty this slice.** Inbox rows carry `project_id: ''` (set explicitly, not omitted):
  the inbox is global (`schema-doc:67`) and there is no per-project routing here. Per-project routing /
  populating `project_id` from the run's repo is deferred (and is also blocked by the "multi-queue /
  per-project routing" out-of-scope note).
- **Resolve ordering — step-status is the lock; inbox-`resolved` is the trailing write (follow-up fix
  to the Gitar EDGE finding).** `resolveInbox` no longer writes the inbox `resolved` first. The order is
  now: (1) top guard returns on missing / already-`resolved` inbox; (2) flip the step **only if**
  `step.status === 'awaiting_approval'`; (3) emit the `inbox_resolved` event; (4) **last**, stamp the
  inbox row `resolved`. The STEP'S status is the idempotency lock — a re-resolve sees the step no longer
  awaiting and skips the flip. Rationale and residual failure mode:
  - If the **step-flip (2) fails**, the inbox stays `pending`, so the whole resolve is **safely
    retryable with no stuck step**. This is the fix: the old "inbox-`resolved` FIRST" order left the
    step stuck in `awaiting_approval` forever after a step-patch failure (the inbox was already
    `resolved`, so a re-resolve no-op'd) — the worst failure mode.
  - **Residual:** if the **inbox-write (4) fails after** a successful flip+event, a retry sees the step
    is no longer awaiting (no re-flip) and re-emits **one extra `inbox_resolved` audit event**. A rare
    **duplicate audit event is the accepted least-bad failure mode** — strictly better than a silently
    stuck step. The **single-worker assumption** (the CLI is the only resolver this slice) still holds
    and is documented on `writeInboxResolved` (formerly `transitionInboxToResolved`). A true conditional
    / compare-and-set primitive in the data-access layer (e.g. `patchRowIf(table, id, when, patch)` —
    there is none today, `data-access.ts:26-33`) still slots in at that one call site **without** touching
    `resolveInbox`; adding it is the follow-up before multiple concurrent resolvers (multi-worker / a web
    UI + CLI racing) are safe.
- **`kind` is always `approval`.** No classifier distinguishes `question`/`alert`; the field is
  explicit so a later sorter (`inbox-and-gates.md:31-42`) can vary it.
- **Reject sibling cleanup.** `--reject` kills only the parked step (`dead`); sibling steps and the
  parent run status are untouched. Compensating teardown (fail the run/task) is out of scope.
- **No notification channel.** `revo inbox list` is pull-only; push (the "MVP can skip push" bullet in
  `inbox-and-gates.md` § Mechanics, currently lines 28-29) is deferred.
- **Proactive gates (`routing_policy.requires_human`).** This slice only handles the reactive
  `needsHuman` park; the plan/merge approval gates that *pre-empt* a step remain unbuilt.

Needs human / ADR sign-off:

- **Reject target status.** This plan flips a rejected step to `dead`. Confirm `dead` is the intended
  terminal for a human rejection (vs a new `rejected` status or a `skipped` flip). If a distinct
  terminal is wanted, it is a one-line schema-doc note + a `resolveInbox` value change — flag before
  relying on `dead` in production.
- **`resolved_by` provenance.** The CLI records `--by <actor>` (default `"human"`). Confirm whether a
  real operator identity (e.g. from env / auth) should be required rather than a free-text default.
