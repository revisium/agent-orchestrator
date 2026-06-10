# Plan 0007 — Direct unit tests for `slugify` and `branchName` helpers

**Status:** ready · **Owner role:** developer · **Kind:** implement
**Concern (single):** add direct, isolated unit tests for the two branch-name helpers in
`src/runners/integrator.ts`, exporting them so the test can call them without going through `integrate`.

## Why

`slugify` (`src/runners/integrator.ts:105`) and `branchName` (`src/runners/integrator.ts:116`) are currently
module-private and only exercised **indirectly** through `integrate` / `stubIntegrate`. There is no direct test of
their edge behavior (truncation at `SLUG_MAX`, empty-segment trimming, the
`slugify(title) || slugify(taskId) || 'task'` fallback chain). `grep -n 'slugify\|branchName'
src/runners/integrator.test.ts` returns nothing today, confirming the gap. This slice closes it.

## Current state (verbatim, confirmed this session)

`src/runners/integrator.ts`:

```
102	const SLUG_MAX = 40;
103	
104	/** Deterministic branch-name slug from title: lowercase, non-alnum runs → '-', trim/truncate. */
105	function slugify(title: string): string {
106	  return title
107	    .toLowerCase()
108	    .replace(/[^a-z0-9]+/g, '-')
109	    .split('-')
110	    .filter((seg) => seg.length > 0)
111	    .join('-')
112	    .slice(0, SLUG_MAX);
113	}
114	
115	/** Derive deterministic feature branch name from taskId + title. */
116	function branchName(taskId: string, title: string): string {
117	  const slug = slugify(title) || slugify(taskId) || 'task';
118	  return `feat/${taskId}-${slug}`;
119	}
```

Existing test import block, `src/runners/integrator.test.ts:10-18`:

```
import {
  integrate,
  stubIntegrate,
  preflightLive,
  resolveExecutable,
  type IntegratorInput,
  type IntegratorDeps,
  type ExecFn,
} from './integrator.js';
```

Tests run with the Node test runner via `tsx --test` (see `package.json` `"test"` script). New tests go in the
existing `integrator.test.ts` and are picked up automatically.

## Out of scope (later plans, do NOT touch)

- The separate `branchName` helper in `src/worker/git-worktree-manager.ts:10` (different signature; legacy worker
  area, already covered by `src/worker/git-worktree-manager.test.ts`).
- `parseOwnerRepo` / `resolveExecutable` and any other integrator internals.
- Refactoring the helpers' behavior — tests must capture **current** behavior, not change it.

---

## Steps

### Step 1 — Export `slugify` and `branchName`

**File:** `src/runners/integrator.ts`

- Line 105: change `function slugify(title: string): string {` → `export function slugify(title: string): string {`
- Line 116: change `function branchName(taskId: string, title: string): string {` →
  `export function branchName(taskId: string, title: string): string {`

Do not change the bodies. Internal callers (`branchName` calling `slugify` at line 117; `branchName` used at
`src/runners/integrator.ts:385`) keep working unchanged.

**Verify:**
```
cd /Users/anton/projects/revisium/agent-orchestrator && \
  grep -n 'export function slugify\|export function branchName' src/runners/integrator.ts && \
  npm run typecheck
```
**Stop if:** typecheck reports any new error, or either `export` line is missing.

### Step 2 — Add `slugify` + `branchName` to the test import

**File:** `src/runners/integrator.test.ts` (import block at lines 10-18)

Add `slugify,` and `branchName,` to the named imports from `'./integrator.js'` (place them at the top of the
import list, before `integrate,`).

**Verify:**
```
cd /Users/anton/projects/revisium/agent-orchestrator && \
  grep -n "slugify,\|branchName," src/runners/integrator.test.ts
```
**Stop if:** grep does not show both names in the import block.

### Step 3 — Append direct unit tests

**File:** `src/runners/integrator.test.ts` — append a new section at the **end** of the file (after the final
`resolveExecutable` test, current last line 834). Use `node:test` / `node:assert/strict`, already imported at the
top of the file (lines 7-8). Cover exactly these cases, all asserting **current** behavior:

`slugify`:
1. Normal title — `slugify('Add feature X')` → `'add-feature-x'`.
2. Leading/trailing/repeated non-alnum trimmed and collapsed — `slugify('  Hello,  World!! ')` → `'hello-world'`
   (no leading, trailing, or doubled `-`).
3. All-symbol input → empty string — `slugify('!!!')` → `''` and `slugify('')` → `''`.
4. Truncation — a title whose slug would exceed 40 chars (e.g. `'a'.repeat(50)`) yields a result with
   `length === 40` (assert `slugify('a'.repeat(50)).length === 40`).

`branchName`:
5. Normal — `branchName('task-001', 'Add feature X')` → `'feat/task-001-add-feature-x'`.
6. Empty title falls back to slug of taskId — `branchName('task-001', '')` → `'feat/task-001-task-001'`.
7. Title and taskId both yield empty slug → `'task'` literal —
   `branchName('!!!', '@@@')` → `'feat/!!!-task'`.

**Verify:**
```
cd /Users/anton/projects/revisium/agent-orchestrator && \
  npx tsx --test src/runners/integrator.test.ts
```
**Stop if:** any test fails. If case 6 or 7 surprises you, re-read lines 116-118 and assert what the code
actually produces — do NOT change the helper to match an assumption.

### Step 4 — Full gate

**Verify:**
```
cd /Users/anton/projects/revisium/agent-orchestrator && npm run verify
```
(`typecheck` + `lint:ci` + `test:cov`.)
**Stop if:** typecheck, lint, or any test fails.

## Done when

- `slugify` and `branchName` are exported from `src/runners/integrator.ts` (bodies unchanged).
- `src/runners/integrator.test.ts` has 7 new direct assertions (4 `slugify`, 3 `branchName`) and they pass.
- `npm run verify` is green.
