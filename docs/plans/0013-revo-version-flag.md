# Plan 0013 — `revo --version` / `-v` (print the version from `package.json`)

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** make the top-level `revo` CLI expose `-v, --version`, printing the version **sourced from
> `package.json`** via commander's `.version()`. Today `src/cli/index.ts:9` hardcodes `.version('0.0.1')` (a
> literal that silently drifts from `package.json`) and registers no short flag. Replace the literal with a
> runtime read of `package.json`, register `-v, --version`, and add a real test.
>
> **Out of scope (deferred / not this slice):**
> - A `revo version` **subcommand** (commander's option flag is what the task asks for; do not add a command).
> - Per-subcommand version flags, build/commit metadata, or a `--verbose` short flag (`-v` here is **version**).
> - Updating the stale plans index in [`./README.md`](./README.md) or [`../roadmap.md`](../roadmap.md) — `0012`
>   was not added there either; keep this slice to the feature.
> - Bumping the actual version number in `package.json` — this slice changes how the version is *read*, not its
>   value.

---

## Design decisions (made for the implementor — do not relitigate without sign-off)

1. **Read `package.json` at runtime with `readFileSync` + `import.meta.url`, NOT a static JSON import.**
   `tsconfig.json` has no `resolveJsonModule`, and `package.json` lives **outside** `rootDir: "src"`, so
   `import pkg from '../../package.json' with { type: 'json' }` would fail to compile and/or distort the `dist`
   layout. A runtime read sidesteps both.
2. **`'../../package.json'` is the correct relative path from a file at `src/cli/<name>`.** The running file is
   either `src/cli/…` (dev: `tsx src/cli/index.ts`, per the `revo` npm script) or `dist/cli/…` (prod: `bin/revo.js`
   imports `../dist/cli/index.js`). **Both sit exactly two levels below the repo root**, so `new URL('../../package.json',
   import.meta.url)` resolves to the repo-root `package.json` in both. The new helper module therefore **must** live
   directly under `src/cli/` (same depth as `index.ts`), not in a deeper folder.
3. **Extract a `buildProgram()` factory so the feature is testable.** `index.ts` calls
   `await program.parseAsync(process.argv)` at module top level (line 16); importing it from a test would parse the
   **test runner's** argv. Move program construction into a new `src/cli/program.ts` (`buildProgram()` +
   `readPackageVersion()`); `index.ts` becomes a thin entry that imports `buildProgram` and parses. This mirrors how
   `work.ts` exports `workCommand`/`makeResolveCwd` for `work.test.ts` to import directly.
4. **Use `-v, --version` (lowercase `-v`).** Commander's default version flag is `-V` (uppercase); the task asks
   for `-v`, so pass the flags string as the **second** argument to `.version()`. `-v` is a root-level global flag
   and does not collide with any subcommand option.
5. **Avoid explicit `any`.** ESLint uses `tseslint.configs.recommended` (the **non**-type-checked set), so the
   `no-unsafe-*` rules are off and `JSON.parse(...)` is fine — but `@typescript-eslint/no-explicit-any` is on. Use a
   typed cast (`as { version?: string }`), never `: any`.

---

## 0. Context you must read first

- `src/cli/index.ts` — the whole file (17 lines): the hardcoded `.version('0.0.1')` (line 9), the four
  `register*(program)` calls (lines 11–14), and the top-level `await program.parseAsync(process.argv)` (line 16).
- `bin/revo.js` — `import '../dist/cli/index.js';` — proves the prod entry runs `dist/cli/index.js` (Design 2).
- `package.json` — `"version": "0.0.1"` (line 3); the `revo` script `tsx src/cli/index.ts` (line 14); `test` runs
  every `src/**/*.test.ts` (line 21); `verify` = typecheck + lint:ci + test:cov (line 28).
- `src/cli/commands/work.ts` + `src/cli/commands/work.test.ts` — the in-repo pattern for a CLI module that exports
  functions and a sibling `*.test.ts` that imports and exercises them with `node:test` + `node:assert/strict`.
- `tsconfig.json` — `module/moduleResolution: NodeNext`, `rootDir: "src"`, **no** `resolveJsonModule` (Design 1).
- `eslint.config.mjs` — `tseslint.configs.recommended` only (Design 5).

Key fact: commander's `.version(str, flags)` registers a flag whose handler writes `str + "\n"` through the
configured output (`configureOutput().writeOut`) and then exits — under `.exitOverride()` it throws a
`CommanderError` with `code === 'commander.version'` instead of calling `process.exit`. The test in Step 3 relies on
this.

---

## 1. Create `src/cli/program.ts` (version reader + program factory)

**Files to create:**

- `src/cli/program.ts`

**Implementation notes** — move the construction currently inline in `index.ts` into a factory, and add the reader:

```ts
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { registerBootstrap } from './commands/bootstrap.js';
import { registerRevisium } from './commands/revisium.js';
import { registerRun } from './commands/run.js';
import { registerWork } from './commands/work.js';

// Read the version from package.json at runtime. A static JSON import is avoided: tsconfig has no
// resolveJsonModule and package.json lives outside rootDir ("src"). '../../package.json' is correct
// from this file in BOTH dev (tsx src/cli/program.ts) and the built output (dist/cli/program.js) —
// each sits exactly two levels below the repo root (bin/revo.js runs dist/cli/index.js).
export function readPackageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json is missing a "version" field');
  }
  return pkg.version;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('revo')
    .description('Agent orchestrator CLI')
    .version(readPackageVersion(), '-v, --version', 'Print the revo version');
  registerRevisium(program);
  registerBootstrap(program);
  registerRun(program);
  registerWork(program);
  return program;
}
```

Keep the same registration order as today's `index.ts` (revisium, bootstrap, run, work). Return a **fresh**
`Command` each call (so tests don't share parser/exit state).

**Verify:**

```bash
npm run typecheck
```

`typecheck` clean.

**Stop conditions:**

- Do **not** place this file deeper than `src/cli/` — `'../../package.json'` depends on the `src/cli/` depth
  (Design 2).
- Do **not** switch to a static `import ... with { type: 'json' }` or enable `resolveJsonModule` (Design 1) — that
  is a different decision and out of scope.

---

## 2. Slim `src/cli/index.ts` down to a thin entry

**Files to change:**

- `src/cli/index.ts`

**Implementation notes** — replace the entire body with:

```ts
import { buildProgram } from './program.js';

await buildProgram().parseAsync(process.argv);
```

The top-level `await` is already how the file works today (it is an ESM module); only the construction moves to
`program.ts`. No `register*` imports remain in `index.ts`.

**Verify:**

```bash
npm run typecheck
npm run revo -- --version      # prints 0.0.1 (the package.json version), then exits 0
npm run revo -- -v             # same
npm run revo -- --help         # the options list shows: -v, --version
```

`--version` and `-v` both print the `package.json` version on its own line and exit 0; `--help` lists the
`-v, --version` flag. None of these touch the control plane / daemon.

**Stop conditions:**

- If `--version` prints anything other than the current `package.json` version (e.g. a stale `0.0.1` literal lingers
  somewhere), **stop and report** — the literal must be gone.

---

## 3. Real test for the reader and the flag

**Files to create:**

- `src/cli/program.test.ts`

**Implementation notes** — use `node:test` + `node:assert/strict` (match `work.test.ts`). Read the expected version
independently from `package.json` so the test stays correct across version bumps and proves the value is **sourced**,
not hardcoded:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CommanderError } from 'commander';
import { buildProgram, readPackageVersion } from './program.js';

function expectedVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

test('readPackageVersion: returns the version from package.json (not a hardcoded literal)', () => {
  assert.equal(readPackageVersion(), expectedVersion());
});

for (const flag of ['--version', '-v']) {
  test(`buildProgram: ${flag} prints the package.json version and exits via commander`, () => {
    const program = buildProgram().exitOverride();
    let out = '';
    program.configureOutput({ writeOut: (s) => { out += s; }, writeErr: () => {} });
    assert.throws(
      () => program.parse(['node', 'revo', flag]),
      (err: unknown) => err instanceof CommanderError && err.code === 'commander.version',
      `${flag} should trigger commander's version exit`,
    );
    assert.equal(out.trim(), expectedVersion(), `${flag} must print the package.json version`);
  });
}
```

Notes:
- Use synchronous `program.parse(...)` (not `parseAsync`): commander handles `--version` during option parsing and
  throws **before** any async subcommand action runs, so there is no floating promise.
- `configureOutput.writeErr` is stubbed to keep test output quiet; `writeOut` captures the printed version.

**Verify:**

```bash
npm run typecheck
npm test
```

All suites green, including the three new cases (`readPackageVersion`, `--version`, `-v`).

**Stop conditions:**

- The test must not spawn a subprocess or contact the daemon — import `buildProgram`/`readPackageVersion` directly,
  like `work.test.ts`.

---

## 4. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
npm run verify                 # = typecheck + lint:ci + test:cov (must be clean, 0 lint warnings)
npm run revo -- --version      # prints the package.json version, exits 0
npm run revo -- -v             # same
npm run revo -- --help         # lists -v, --version
git diff --check
```

**Slice is done when:** `revo --version` and `revo -v` print the version read from `package.json` (no hardcoded
`'0.0.1'` literal remains in `src/cli/`), `--help` lists `-v, --version`, the new `program.test.ts` plus the full
existing suite pass with zero lint warnings, and `index.ts` is a thin entry delegating to `buildProgram()`.

---

## 5. Delivery (PR)

Per the task's delivery context:

- The work belongs **on the existing branch `feat/revo-version-via-loop`** (the current branch). Commit the new and
  changed files there — do **not** branch off a fresh `master`, which would lose the work.
- **gh account:** `revisium-io`. **Base:** `master`. **PR body:** empty. **Never force-push.** **No `Co-Authored-By`
  trailer.**
- Files in the diff: `src/cli/program.ts` (new), `src/cli/index.ts` (changed), `src/cli/program.test.ts` (new), and
  this plan `docs/plans/0013-revo-version-flag.md`.

---

## 6. Report back / open findings

Report:

1. That the hardcoded `.version('0.0.1')` is replaced by `readPackageVersion()` and `-v, --version` is registered.
2. The new testable seam (`src/cli/program.ts` → `buildProgram()`/`readPackageVersion()`) and that `index.ts` is now
   a thin entry.
3. Verify outputs: `npm run verify`, `revo --version`, `revo -v`, `revo --help`, and the PR URL.

Deferred (out-of-scope above): a `revo version` subcommand; build/commit metadata; `resolveJsonModule`/static JSON
import; updating the plans index / roadmap.
