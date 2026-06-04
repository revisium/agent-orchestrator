# Plan 0017 — PR identity: idempotent integrator + poller by-branch PR resolution

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** make the integrator → ci-poller handoff survive a re-run. Today the
> integrator parses `gh pr create` output for a PR number and the poller trusts that number
> blindly; a re-run of the integrator hits `a pull request already exists for branch X` and
> fails, and the poller has no way to recover a PR identity from a branch. This slice (1) makes
> the integrator **find-or-create** by branch (reuse the open PR for its head branch instead of
> failing), and (2) teaches the poller to **resolve the PR number from a head branch** when
> `pr_number` is missing or stale. The integrator change is a **role-prompt edit only** (roles are
> data); the poller change is the **only** code in this slice. The loop, `WorkerDeps`, the
> `ScriptRunner`, and the judge (`pr-watcher`) are unchanged.
>
> **Out of scope:**
> - Real Sonar issue integration — Plan 0018 (separate slice; the `fetchSonarIssues` stub stays as-is here).
> - `attemptId`-keyed idempotency for the integrator's `git push` / commit (Plan 0008 open findings) —
>   this slice makes the PR *create* idempotent by branch, not the push.
> - Renaming `pr-watcher` → `pr-judge` — a separate ADR (still deferred from Plan 0011).
> - Multi-repo head-branch namespacing — Plan 0010.
> - Inbox / approval resolution UI — Plan 0009. (`needsHuman: true` parks via the existing path.)

---

## 0. Context you must read first

- `control-plane/bootstrap.config.json:628` — the `integrator` role `system_prompt`. Its final
  sentence currently sets `nextSteps` to one `ci-poller` step with
  `input: { pr_number: <N>, repo: '<owner/repo>', sonar_project: '<key-or-omit>', poll_count: 0 }`.
  It instructs "Work on a feature branch off freshly fetched origin/master" but does **not** name
  the branch deterministically and does **not** handle the "PR already exists" case.
- `src/poller/pr-readiness.ts:7-14` — the `PollInput` type (`pr_number` is currently a required
  `number`; there is no `head_branch`).
- `src/poller/pr-readiness.ts:69-77` — the injectable `ExecGhFn` seam and `defaultExecGh` (calls the
  `gh` CLI with a 60 s OS timeout). All PR resolution must go through this same seam — tests inject
  a fake `execGh`, never the network.
- `src/poller/pr-readiness.ts:85-92` — `parseGhJson<T>(raw, label)`: the only JSON parse path; reuse
  it for the new `gh pr list` parse so a non-JSON response throws the same descriptive error.
- `src/poller/pr-readiness.ts:217-250` — `run()` signature and the first `gh pr view <pr_number>`
  call. PR resolution must happen **before** this `pr view` call, since `pr view` needs a number.
- `src/poller/pr-readiness.ts:255-268` — the existing `MERGED` (clean stop) / `CLOSED` (needsHuman)
  terminal-state handling; the new "0 PRs found" case mirrors the `CLOSED` `needsHuman` shape.
- `src/poller/pr-readiness.test.ts:41-56` — `makeFullResponses` routes fake `gh` calls by substring
  of the joined args; the new `gh pr list` branch needs a route here (`key.includes('pr list')`).
- `src/control-plane/steps.ts:8-25` — the `Step` type; `step.taskId` / `step.modelProfile` are what
  the poller copies onto every re-queued `nextSteps` entry (the `ScriptRunner` has no
  `normalizeNextSteps`, so every `NewStepSpec` field is set explicitly).

Key facts:

1. The poller already owns a single injectable `gh` seam (`ExecGhFn`). `gh pr list --head <branch>
   --state open --json number,baseRefName,state` goes through the *same* seam — no new dependency,
   no new transport, and unit tests stay network-free.
2. `gh pr create` is **not** idempotent: a second create on the same head branch exits non-zero with
   `a pull request already exists for branch X`. `gh pr list --head <branch> --state open` **is**
   the idempotent primitive — it returns `[]` or the existing PR(s).
3. The integrator is a `claude-code` runner with `Bash` access; it already runs `gh`. Making it
   find-or-create is a **prompt** change (data), not code — consistent with invariant 2 (roles are
   data; adding behaviour to a role must not touch the loop).
4. The poller hands `nextSteps[0].input` forward verbatim; `createSteps` copies it into the child
   step's `input`. So whatever the integrator puts in the ci-poller step input (incl. `head_branch`)
   is exactly what the poller's first invocation parses, and the poller re-queues it forward on every
   poll (it already spreads `...input` — see `pr-readiness.ts:291,328`).

---

## Design decisions (do not relitigate)

1. **Branch identity is deterministic and integrator-owned.** The integrator derives its feature
   branch name from the task (e.g. `task/<taskId>` or a slug it already uses) and uses that **same**
   name on a re-run. The poller never invents a branch; it only consumes the `head_branch` the
   integrator passes. The branch is the durable PR key, the PR number is a cache of it.
2. **Find-or-create lives in the integrator prompt, not in code.** `gh pr list --head <branch>
   --state open` → reuse `.number` if present, else `gh pr create`. Never fail on "already exists".
   No poller/loop code implements this; it is a role-data edit.
3. **`pr_number` becomes optional in `PollInput`; `head_branch` is the recovery key.** When
   `pr_number` is absent/falsy, OR when `gh pr view <pr_number>` reports the PR does not exist, the
   poller resolves the number from `head_branch` via `gh pr list`. If neither a valid `pr_number`
   nor a `head_branch` is available, that is `needsHuman` — never a silent pass.
4. **Resolution ambiguity fails toward a human, with a lesson.** 0 open PRs for the branch →
   `needsHuman` (nothing to watch). >1 → pick the one whose `baseRefName` equals the target base
   (default `master`, overridable via `base_branch`); if still >1 after that filter → `needsHuman`
   with a lesson naming the candidate numbers. The poller GATHERS deterministically and parks on
   ambiguity; it never guesses an identity.
5. **The deterministic / LLM split is unchanged.** PR resolution is pure string/number logic over
   `gh` JSON — zero LLM, `costs: []`. The judge (`pr-watcher`) is untouched by this slice.

---

## 1. Add `head_branch` / `base_branch` to `PollInput`

**Files to change:**

- `src/poller/pr-readiness.ts`

**Implementation notes:**

Change the `PollInput` type (currently lines 7-14). Make `pr_number` optional and add the two
branch fields:

```ts
export type PollInput = {
  pr_number?: number;        // optional: resolved from head_branch when missing/stale
  repo: string;              // "owner/repo"
  head_branch?: string;      // the PR's head branch — the durable identity key for resolution
  base_branch?: string;      // target base for >1-PR disambiguation (default "master")
  sonar_project?: string;
  poll_count: number;
  poll_interval_ms?: number;
  max_polls?: number;
};
```

`repo`, `poll_count` stay required. Do **not** remove `pr_number`; downstream `output` and
re-queue payloads still carry it once resolved (see Step 2).

**Verify:**

```bash
npm run typecheck
```

**Stop conditions:**

- Do not add a `head_branch` default. An absent `head_branch` is a valid state (the integrator may
  not have set it on an old in-flight step) — resolution only triggers when `pr_number` is also
  missing/stale, and that combination is the `needsHuman` case in Step 2.

---

## 2. PR-number resolution in the poller

**Files to change:**

- `src/poller/pr-readiness.ts`
- `src/poller/pr-readiness.test.ts`

**Implementation notes:**

Add a helper near the other helpers (after `parseGhJson`, before `run`):

```ts
type PrListEntry = { number: number; baseRefName: string; state: string };

/**
 * Resolves the open PR number for a head branch. Returns:
 *  - { pr_number } on a unique match (or unique after base-branch tie-break);
 *  - { needsHuman, lesson } when 0 PRs, or >1 still ambiguous after base filtering.
 * Pure over the injected execGh — no network in tests.
 */
function resolvePrByBranch(
  repo: string,
  headBranch: string,
  baseBranch: string,
  execGh: ExecGhFn,
): { pr_number: number } | { needsHuman: true; lesson: string } {
  const raw = execGh([
    'pr', 'list', '--repo', repo, '--head', headBranch, '--state', 'open',
    '--json', 'number,baseRefName,state',
  ]);
  const prs = parseGhJson<PrListEntry[]>(raw, `pr list --head ${headBranch}`);

  if (prs.length === 0) {
    return { needsHuman: true, lesson: `No open PR found for head branch "${headBranch}" in ${repo} — manual review needed` };
  }
  if (prs.length === 1) return { pr_number: prs[0].number };

  const onBase = prs.filter((p) => p.baseRefName === baseBranch);
  if (onBase.length === 1) return { pr_number: onBase[0].number };

  const candidates = (onBase.length > 1 ? onBase : prs).map((p) => p.number).join(', ');
  return {
    needsHuman: true,
    lesson: `Ambiguous: ${prs.length} open PRs for head branch "${headBranch}" (base ${baseBranch}) — candidates #${candidates} — manual review needed`,
  };
}
```

In `run()` (currently lines 217-250), **before** the `gh pr view` call, resolve the effective PR
number:

```ts
const baseBranch = input.base_branch ?? 'master';
let prNumber = input.pr_number;

if (!prNumber) {
  if (!input.head_branch) {
    return {
      output: { verdict: 'unresolved' },
      nextSteps: [],
      needsHuman: true,
      lesson: `ci-poller step has neither pr_number nor head_branch — cannot identify a PR to watch`,
      costs: [],
    };
  }
  const resolved = resolvePrByBranch(input.repo, input.head_branch, baseBranch, execGh);
  if ('needsHuman' in resolved) {
    return { output: { verdict: 'unresolved' }, nextSteps: [], needsHuman: true, lesson: resolved.lesson, costs: [] };
  }
  prNumber = resolved.pr_number;
}
```

Then use `prNumber` (not `input.pr_number`) in the `gh pr view` call and everywhere downstream.
**Stale-number recovery:** wrap the `gh pr view` parse so that a "no PR found"/404-style `gh` failure
falls back to branch resolution when `head_branch` is present:

```ts
// `gh pr view <N>` exits non-zero if the PR number is stale/deleted. If we have a head_branch,
// re-resolve from it once; otherwise surface to a human (never silently pass).
```

Implement that as: attempt `gh pr view` with `prNumber`; on a thrown error, if `input.head_branch`
is set and we have not already resolved from the branch this invocation, call `resolvePrByBranch`
and retry once; if resolution itself returns `needsHuman`, return that. If there is no `head_branch`,
let the original error propagate (the loop's `failStep` handles it) — this preserves today's
behaviour for callers that only pass `pr_number`.

**Carry `pr_number` forward and into the judge.** Every place the poller builds a re-queue or judge
`nextSteps` entry, the `input` must carry the resolved `pr_number` (and the spread `...input` already
carries `head_branch`/`base_branch` forward — confirm `input.pr_number` in the re-queue payload is
replaced with the resolved `prNumber` so a re-queued poll does not re-resolve every time):

```ts
input: { ...input, pr_number: prNumber, poll_count: input.poll_count + 1 }
```

**Unit tests to add** (`pr-readiness.test.ts`) — extend `makeFullResponses` to route
`key.includes('pr list')` to a configurable PR-list payload, then:

- `pr_number` absent + `head_branch` set + `gh pr list` returns one PR → uses that number, proceeds
  to the normal pending/terminal path (assert the judge/re-queue step carries `pr_number` = that number).
- `pr_number` absent + `head_branch` set + `gh pr list` returns `[]` → `needsHuman: true`,
  `nextSteps: []`, lesson mentions the branch name. `costs: []`.
- `pr_number` absent + `head_branch` set + 2 PRs, exactly one with `baseRefName === 'master'` →
  picks that one.
- `pr_number` absent + `head_branch` set + 2 PRs, both on `master` → `needsHuman: true`, lesson lists
  both candidate numbers.
- `pr_number` absent + `head_branch` absent → `needsHuman: true`, lesson mentions "neither pr_number
  nor head_branch".
- `base_branch` override: 2 PRs, one on `develop`, `base_branch: 'develop'` → picks the `develop` one.
- Stale `pr_number`: `gh pr view` throws, `head_branch` set, `gh pr list` returns one PR → recovers
  and proceeds (assert no throw, correct resolved number forwarded).
- Regression: `pr_number` present + valid (existing tests) still pass unchanged with **no** `gh pr
  list` call made (assert the list route is never hit when `pr_number` resolves via `pr view`).

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- Do not loop resolution: re-resolve from the branch **at most once** per `run()` invocation (guard
  with a boolean). A persistent `gh pr view` failure after one re-resolve must propagate / `needsHuman`,
  not retry forever.
- Do not change `defaultExecGh` or add a second `gh` seam. All `gh` access stays behind the single
  injected `ExecGhFn`.
- Do not touch `buildJudgeResult`'s Sonar/reviews/comments gathering — only thread the resolved
  `prNumber` into it (it currently reads `input.pr_number`; pass `prNumber` instead).

---

## 3. Integrator role: idempotent find-or-create + pass `head_branch` forward

**Files to change:**

- `control-plane/bootstrap.config.json` (the `integrator` role row at line 628 — `system_prompt` only)

**Implementation notes:**

Edit the `integrator` `system_prompt` so it (a) uses a **deterministic** branch name derived from the
task, (b) **finds-or-creates** the PR instead of failing on "already exists", and (c) passes
`head_branch` (and the base) into the ci-poller step input. Replace the final two sentences (the
branch + PR + nextSteps instructions) with text equivalent to:

```text
Choose a DETERMINISTIC feature branch name derived from the task (e.g. task/<taskId> or the existing
plan slug) so a re-run reuses the SAME branch. Fetch origin and run the gates. Stage ONLY this
change's files (check git status; never blind 'git add -A'). Commit with a clean message: NO
Co-Authored-By, NO summary footer. Push normally — NEVER force-push. Then FIND-OR-CREATE the PR
idempotently: run `gh pr list --head <branch> --state open --json number` first; if it returns an
existing PR, REUSE that number (do NOT call `gh pr create` — it fails with "a pull request already
exists"); only if the list is empty, run `gh pr create` with an empty body. Never treat "already
exists" as a failure. In your result: set output to the PR number and URL, and set nextSteps to one
ci-poller step (role 'ci-poller', kind 'poll', input: { pr_number: <N>, repo: '<owner/repo>',
head_branch: '<branch>', base_branch: '<base, usually master>', sonar_project: '<key-or-omit>',
poll_count: 0 }).
```

Keep `model_level`, `effort`, `runner: "claude-code"`, `allowed_tools`, `scope_rules` unchanged.
Bump `updated_at` to the current date (`2026-06-04T00:00:00.000Z`).

**Verify:**

```bash
node -e "const c=require('./control-plane/bootstrap.config.json');const r=c.rows.find(x=>x.tableId==='roles'&&x.rowId==='integrator');const p=r.data.system_prompt;if(!/gh pr list --head/.test(p))throw new Error('integrator prompt missing find-or-create');if(!/head_branch/.test(p))throw new Error('integrator prompt missing head_branch in ci-poller input');console.log('OK integrator prompt');"
```

> If the config root is not `rows` (confirm the actual top-level key in
> `control-plane/bootstrap.config.json` before running), adjust the accessor — the assertion is the
> point, not the exact path.

**Stop conditions:**

- This step changes **only** the `integrator` role's `system_prompt` (and its `updated_at`). Do not
  add new columns to the `roles` table or touch any other role.
- Do not commit runtime rows. Only the versioned `roles` row changes here (consistent with the
  versioning boundary).

---

## 4. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
npm run typecheck
npm run lint:ci
npm test
node -e "const c=require('./control-plane/bootstrap.config.json');const r=c.rows.find(x=>x.tableId==='roles'&&x.rowId==='integrator');if(!/gh pr list --head/.test(r.data.system_prompt))throw new Error('integrator not idempotent');console.log('OK');"
npm run build
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
node --input-type=module -e "
import('./dist/control-plane/index.js').then(async m => {
  const i = await m.loadRole('integrator');
  console.assert(/head_branch/.test(i.system_prompt), 'integrator must pass head_branch to ci-poller');
  console.log('OK');
})"
git diff --check
./bin/revo.js revisium stop
```

**Slice is done when:** `PollInput.pr_number` is optional and `head_branch`/`base_branch` are
accepted; the poller resolves a missing/stale PR number from the head branch via `gh pr list`
(through the existing `execGh` seam), parks to `needsHuman` with a clear lesson on 0-PR and
still-ambiguous >1-PR cases, and recovers a stale `pr_number` from `head_branch` once before
surfacing; the resolved `pr_number` is threaded into the judge and re-queue payloads; the integrator
role prompt finds-or-creates the PR idempotently and passes `head_branch`/`base_branch` into the
ci-poller step; all unit tests pass at zero LLM cost; and the loop, `WorkerDeps`, `ScriptRunner`, and
`pr-watcher` are unchanged.

---

## 5. Report back / open findings

Report:

1. The `PollInput` shape change (`pr_number` optional, `head_branch`/`base_branch` added) and the
   `resolvePrByBranch` resolution rules (0 / 1 / >1 + base tie-break).
2. The role-prompt-vs-code split: integrator = prompt-only find-or-create; poller = the only code.
3. The stale-`pr_number` recovery path (one re-resolve from `head_branch`, then `needsHuman`).
4. Confirmation that `pr_number`-present callers make no `gh pr list` call (regression preserved).
5. Validation: typecheck, lint, test, bootstrap role-load assertion, zero LLM cost for the poller.

Open findings / deferred:

- **`attemptId`-keyed push idempotency** — the PR *create* is now idempotent by branch, but a
  re-run still re-pushes the branch. Idempotent push/commit keyed on `attemptId` stays a Plan 0008
  follow-up.
- **Deterministic branch collisions across tasks** — `task/<taskId>` is unique by `taskId`; if two
  tasks ever target the same branch (e.g. a re-opened task), `gh pr list --head` could surface a PR
  from the other task. Out of scope; revisit if task→branch is ever many-to-one.
- **Multi-repo head namespacing** — `--head <branch>` is repo-scoped; cross-repo resolution is
  Plan 0010.

Needs human / ADR sign-off:

- **Branch-naming convention** — confirm `task/<taskId>` (vs an existing slug scheme) is the agreed
  deterministic name before relying on it as the durable PR key in production.
