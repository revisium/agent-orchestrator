# Plan 0019 — Direct unit tests for parseOwnerRepo

> **Status: Draft.** Small, single-concern test slice.
> **Realizes:** direct, assertion-on-return-value coverage of the GitHub remote → `owner/repo` parser.

## Context

`parseOwnerRepo` lives at `src/runners/integrator.ts:128`:

```
function parseOwnerRepo(remoteUrl: string): string | null {
```

It is **internal (not exported)** and today is exercised only *indirectly*, via the `integrate()` path with a
remote-only fake (`src/runners/integrator.test.ts:657-740`, helper `makeRemoteOnlyDeps`). Those tests assert only
whether the remote parses (`!('needsHuman' in result)`) or rejects (`'needsHuman' in result`) — they never assert the
**returned `owner/repo` string** and they incur the cost/coupling of driving the whole integrate flow. This slice adds
direct unit tests that assert the exact return value, which requires exporting the function.

The two regexes it depends on are at `src/runners/integrator.ts:125-126`:

```
const GITHUB_SSH_RE = /^git@github\.com:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;
const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;
```

`parseOwnerRepo` `.trim()`s its input (lines 129, 131), so leading/trailing whitespace is part of its contract.

## Scope

1. Export `parseOwnerRepo` from `integrator.ts` (no behaviour change).
2. Add a direct unit-test block to `integrator.test.ts` that imports `parseOwnerRepo` and asserts its exact return
   value across SSH/HTTPS, `.git` stripping, dotted repo names, `http` vs `https`, whitespace trimming, and the
   `null` (reject) cases.

## Non-goals

- Do **not** remove or rewrite the existing indirect `regex:` tests (`integrator.test.ts:690-740`) — they still
  guard the `integrate()` → `resolveOwnerRepo` wiring. This slice only *adds* direct coverage.
- Do **not** export or test `slugify` / `branchName` (also internal) — out of scope; a later plan if wanted.
- Do **not** change the regexes or parsing behaviour.

## Files to change

- `src/runners/integrator.ts` — add `export` to the `parseOwnerRepo` declaration; add it to the header
  `Exposes:` doc comment (lines 6-12).
- `src/runners/integrator.test.ts` — import `parseOwnerRepo` and add a `parseOwnerRepo (direct)` test block.

## Tasks

1. **Export the function.**
   In `src/runners/integrator.ts`, change line 128 from:
   ```
   function parseOwnerRepo(remoteUrl: string): string | null {
   ```
   to:
   ```
   export function parseOwnerRepo(remoteUrl: string): string | null {
   ```
   Add a line to the header `Exposes:` block (between lines 6-12), e.g. after the `resolveExecutable` line:
   ```
    *   - parseOwnerRepo(remoteUrl)  — parse a GitHub SSH/HTTPS remote to "owner/repo" or null.
   ```
   **Verify:** `npx tsc -p tsconfig.build.json --noEmit` exits 0 (no unused-export or type errors).
   **Stop if:** the function is already exported (then only the test task remains) — re-grep before editing.

2. **Add `parseOwnerRepo` to the test import.**
   In `src/runners/integrator.test.ts`, extend the existing import from `./integrator.js` (lines 10-18) to include
   `parseOwnerRepo`.
   **Verify:** `npx tsx --test src/runners/integrator.test.ts` still loads (no import error).

3. **Add the direct test block.**
   Append a new section to `src/runners/integrator.test.ts` (after the existing `regex:` tests, near line 740),
   using `node:test` + `node:assert/strict` (already imported at lines 7-8). Assert exact return values, not just
   parse/reject. Cover at minimum:
   - `git@github.com:o/repo` → `'o/repo'`
   - `git@github.com:o/repo.git` → `'o/repo'` (`.git` stripped)
   - `git@github.com:my-org/my.repo` → `'my-org/my.repo'` (dotted + dashed)
   - `https://github.com/o/repo` → `'o/repo'`
   - `https://github.com/o/my.repo.git` → `'o/my.repo'` (`.git` stripped)
   - `http://github.com/o/repo` → `'o/repo'` (regex allows `https?`)
   - `'  git@github.com:o/repo  '` (surrounding whitespace) → `'o/repo'` (trim contract)
   - `git@github.com:o/re po.git` → `null` (space)
   - `https://github.com/o/repo/tree/main` → `null` (trailing path)
   - `https://github.com/o/` → `null` (missing repo segment)
   - `https://gitlab.com/o/repo` → `null` (non-github host)
   - `''` → `null`
   Example shape (match the file's existing `test(...)` style):
   ```ts
   // ─── parseOwnerRepo (direct) ───────────────────────────────────────────────────
   test('parseOwnerRepo: SSH plain → owner/repo', () => {
     assert.equal(parseOwnerRepo('git@github.com:o/repo'), 'o/repo');
   });
   ```
   **Verify:** `npx tsx --test src/runners/integrator.test.ts` — all tests pass; the new `parseOwnerRepo:` tests
   appear in the output count.
   **Stop if:** any new direct test reveals a parsing result that contradicts the existing indirect tests — do not
   "fix" the regex to make a test pass; surface the discrepancy to a human instead.

## Acceptance

- `npx tsx --test src/runners/integrator.test.ts` green, with the new `parseOwnerRepo:` cases present.
- `npm test` green (full suite).
- `npm run lint:ci` (if present) + `npx tsc -p tsconfig.build.json --noEmit` clean.
- No change to `parseOwnerRepo`/regex behaviour; existing indirect `regex:` tests untouched and still passing.
