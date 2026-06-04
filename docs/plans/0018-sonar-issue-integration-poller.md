# Plan 0018 — Real SonarCloud issue integration in the poller (replace the stub)

> **Audience:** an implementing coding agent. Follow the steps **in order**.
> Each step lists exact files, implementation notes, a **Verify** command, and stop conditions.
> Do not skip Verify. If reality contradicts this plan, **stop and report**, do not guess.
>
> **This slice only:** replace the `fetchSonarIssues` STUB in the poller with a real fetch against
> the SonarCloud web API for the PR, so the judge sees the **all-severity OPEN issue list and
> TO_REVIEW security hotspots** — not just the green/red SonarCloud *quality-gate* check verdict.
> We hit this live: a passing gate hid 16 open issues. Under our zero-tolerance policy (every new
> Sonar issue fixed or suppressed), the issues themselves must reach the judge. The poller GATHERS
> the issues deterministically (zero LLM); the `pr-watcher` judge DECIDES. Transport is a direct
> HTTPS call to `sonarcloud.io` with a `SONAR_TOKEN` (gh cannot reach sonarcloud.io), behind a new
> injectable seam so unit tests need no network. The loop, `WorkerDeps`, and the `ScriptRunner` are
> unchanged.
>
> **Out of scope:**
> - PR identity / by-branch resolution — Plan 0017 (independent; composes but designed separately).
> - A curated review-bot allow-list (CodeRabbit/SonarCloud comment recognition) — Plan 0011 follow-up.
> - Self-hosted SonarQube (non-`sonarcloud.io`) host support — only `SONAR_HOST_URL` is parameterised;
>   on-prem auth quirks are deferred.
> - Auto-suppressing issues / writing back to Sonar — the poller only READS.

---

## 0. Context you must read first

- `src/poller/pr-readiness.ts:138-145` — the `fetchSonarIssues(_sonarProject)` STUB: it returns
  `{ issues: [], unavailable: true }` and explicitly does **not** call `gh` (the comment explains
  `gh api` only reaches `api.github.com`, never `sonarcloud.io`). This is what we replace.
- `src/poller/pr-readiness.ts:44-65` — `CiSummary` and `SonarIssue` types. `CiSummary` already has
  `sonar_issues: SonarIssue[]` and an optional `sonar_unavailable?: boolean`. We add
  `sonar_hotspots_to_review`.
- `src/poller/pr-readiness.ts:150-213` — `buildJudgeResult`: lines 158-165 call the stub guarded by
  `if (input.sonar_project)`. This is the only call site; it assembles `ci_summary` and emits the
  `pr-watcher` judge step. The new fetch is wired in here.
- `src/poller/pr-readiness.ts:217-222` — `run()` signature: `run(input, step, execGh = defaultExecGh)`.
  The new Sonar seam is added as a fourth defaulted parameter, mirroring how `execGh` is injected.
- `scripts/sonar-issues-local.sh` — the **proven transport**: `curl -fsS -u "${SONAR_TOKEN}:"`
  against `${SONAR_HOST_URL:-https://sonarcloud.io}/api/issues/search` with
  `componentKeys=<projectKey>`, `resolved=false`, `pageSize=500`, and `pullRequest=<N>`. Copy its
  query shape; do not reinvent it.
- `sonar-project.properties` — `sonar.projectKey=revisium_agent-orchestrator`,
  `sonar.organization=revisium`. The poller's `sonar_project` input is this project key.
- `.env.sonar.example` — `SONAR_TOKEN=` and `SONAR_HOST_URL=https://sonarcloud.io`. `SONAR_TOKEN`
  is the credential; `.env.sonar` is git-ignored and sourced by the existing scripts.
- `control-plane/bootstrap.config.json:658` — the `pr-watcher` `system_prompt`. It already consumes
  `ci_passed`, `sonar_issues`, `reviewDecision`, `human_reviews`, `human_comments`, `bot_comments`,
  and its stopping criterion already includes "`sonar_issues` is empty". We extend it for hotspots
  and for the `sonar_unavailable` case.
- `src/cli/commands/work.ts:110-121` — the `runnerMode === 'auto'` wiring. The poller already reads
  `process.env['MAX_POLLS']` directly (`pr-readiness.ts:224`), so `SONAR_TOKEN` is read the same way
  inside the poller — **no `work.ts` change is needed**.

Key facts:

1. `gh api` injects GitHub auth and only talks to `api.github.com` — it can never query
   `sonarcloud.io`. Sonar needs its own transport + credential. This is why the stub exists.
2. Node `>=24.11.1` (see AGENTS.md) ships a global `fetch`. The real Sonar fetch uses `fetch`
   directly — no new dependency, no `curl` subprocess.
3. SonarCloud authenticates with a user token. The existing scripts use HTTP basic auth with the
   token as username and empty password (`-u "${SONAR_TOKEN}:"`). SonarCloud also accepts
   `Authorization: Bearer <token>`. We use **basic auth** to match the proven script exactly (see
   Design decision 2).
4. The poller is synchronous-ish today (`execGh` is `execFileSync`), but `run()` is already `async`
   and `buildJudgeResult` can be made `async` — `fetch` is async. The `ScriptRunner` already awaits
   `module.run`, so making the internals async is invisible to the loop.
5. `sonar_project` absent → no Sonar call at all (existing behaviour, preserved). `sonar_project`
   present but token missing / Sonar unreachable → `sonar_unavailable: true` (degrade, never crash,
   never silently pass).

---

## Design decisions (do not relitigate)

1. **The poller GATHERS; the judge DECIDES.** The poller fetches OPEN/CONFIRMED issues and TO_REVIEW
   hotspots and puts the raw lists into `ci_summary`. It applies **no** severity threshold and makes
   **no** READY/NEEDS_WORK call. Zero-tolerance enforcement is the judge's job (Step 4). This keeps
   the deterministic/LLM split from Plan 0011 intact.
2. **Transport: direct HTTPS to `SONAR_HOST_URL` (default `https://sonarcloud.io`) via global
   `fetch`, basic auth `SONAR_TOKEN:` (token as username, empty password).** This mirrors
   `scripts/sonar-issues-local.sh` byte-for-byte on the wire, so the same token that works for local
   `sonar:issues:local` works for the poller. `SONAR_TOKEN` and `SONAR_HOST_URL` come from the
   process environment (env / `.env.sonar`), read inside the poller exactly as `MAX_POLLS` is.
3. **The Sonar fetch is an injectable seam (`FetchSonarFn`), defaulted to the real implementation.**
   Unit tests inject a fake — no network, no token. Same pattern as `ExecGhFn`. The real default
   reads `SONAR_TOKEN`/`SONAR_HOST_URL` from env at call time.
4. **Graceful degradation is explicit and three-valued, never silent.** No token → `sonar_unavailable`.
   Non-2xx / network error / non-JSON → `sonar_unavailable`. A successful empty result →
   `sonar_issues: []`, `sonar_hotspots_to_review: []`, NOT unavailable. The judge must distinguish
   "Sonar said clean" from "we could not ask Sonar".
5. **Under `sonar_unavailable`, the judge surfaces to a human — it must NOT declare READY.** A PR
   whose Sonar status is unknown is not provably clean; zero-tolerance cannot be asserted, so the
   judge sets `needsHuman` rather than passing.
6. **Two endpoints, both PR-scoped:** issues (`/api/issues/search?componentKeys=<key>&pullRequest=<N>
   &statuses=OPEN,CONFIRMED&ps=500`) AND hotspots (`/api/hotspots/search?projectKey=<key>
   &pullRequest=<N>&status=TO_REVIEW&ps=500`). Both go through the one seam; either failing →
   `sonar_unavailable`.

---

## 1. Extend the Sonar result types and `CiSummary`

**Files to change:**

- `src/poller/pr-readiness.ts`

**Implementation notes:**

Add a hotspot type alongside `SonarIssue` (currently lines 61-65) and extend `CiSummary`
(lines 44-59):

```ts
type SonarIssue = {
  severity: string;     // BLOCKER | CRITICAL | MAJOR | MINOR | INFO
  message: string;
  component: string;
  rule?: string;        // e.g. typescript:S1234 — useful context for the developer step
  line?: number;
};

type SonarHotspot = {
  message: string;
  component: string;
  line?: number;
  securityCategory?: string;
  vulnerabilityProbability?: string;  // HIGH | MEDIUM | LOW
};
```

In `CiSummary` add:

```ts
sonar_hotspots_to_review: SonarHotspot[];
```

Keep `sonar_issues: SonarIssue[]` and `sonar_unavailable?: boolean` as they are.

**Verify:**

```bash
npm run typecheck
```

**Stop conditions:**

- Do not make `sonar_hotspots_to_review` optional — emit `[]` when there are none or when Sonar was
  not queried, so the judge can rely on the field always being an array (consistency with
  `sonar_issues`, which is always present).

---

## 2. The real Sonar fetch behind an injectable seam

**Files to change:**

- `src/poller/pr-readiness.ts`
- `src/poller/pr-readiness.test.ts`

**Implementation notes:**

Define the seam next to `ExecGhFn` (line 69) and replace the stub `fetchSonarIssues` (lines 138-145):

```ts
export type SonarResult = {
  issues: SonarIssue[];
  hotspots: SonarHotspot[];
  unavailable: boolean;
};

// projectKey = the sonar.projectKey (PollInput.sonar_project); prNumber = the PR being judged.
export type FetchSonarFn = (projectKey: string, prNumber: number) => Promise<SonarResult>;
```

Real default implementation (`defaultFetchSonar`), mirroring `scripts/sonar-issues-local.sh`:

```ts
export async function defaultFetchSonar(projectKey: string, prNumber: number): Promise<SonarResult> {
  const token = process.env['SONAR_TOKEN'];
  if (!token) return { issues: [], hotspots: [], unavailable: true };  // no creds → degrade
  const host = process.env['SONAR_HOST_URL'] ?? 'https://sonarcloud.io';
  const auth = 'Basic ' + Buffer.from(`${token}:`).toString('base64');  // matches curl -u "TOKEN:"

  try {
    const issuesUrl =
      `${host}/api/issues/search?componentKeys=${encodeURIComponent(projectKey)}` +
      `&pullRequest=${prNumber}&statuses=OPEN,CONFIRMED&ps=500`;
    const hotspotsUrl =
      `${host}/api/hotspots/search?projectKey=${encodeURIComponent(projectKey)}` +
      `&pullRequest=${prNumber}&status=TO_REVIEW&ps=500`;

    const [issuesRes, hotspotsRes] = await Promise.all([
      fetch(issuesUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) }),
      fetch(hotspotsUrl, { headers: { Authorization: auth }, signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!issuesRes.ok || !hotspotsRes.ok) return { issues: [], hotspots: [], unavailable: true };

    const issuesJson = (await issuesRes.json()) as { issues?: Array<Record<string, unknown>> };
    const hotspotsJson = (await hotspotsRes.json()) as { hotspots?: Array<Record<string, unknown>> };

    const issues: SonarIssue[] = (issuesJson.issues ?? []).map((i) => ({
      severity: String(i['severity'] ?? 'UNKNOWN'),
      message: String(i['message'] ?? ''),
      component: String(i['component'] ?? ''),
      rule: i['rule'] ? String(i['rule']) : undefined,
      line: typeof i['line'] === 'number' ? (i['line'] as number) : undefined,
    }));
    const hotspots: SonarHotspot[] = (hotspotsJson.hotspots ?? []).map((h) => ({
      message: String(h['message'] ?? ''),
      component: String(h['component'] ?? ''),
      line: typeof h['line'] === 'number' ? (h['line'] as number) : undefined,
      securityCategory: h['securityCategory'] ? String(h['securityCategory']) : undefined,
      vulnerabilityProbability: h['vulnerabilityProbability'] ? String(h['vulnerabilityProbability']) : undefined,
    }));
    return { issues, hotspots, unavailable: false };
  } catch {
    return { issues: [], hotspots: [], unavailable: true };  // network / timeout / JSON error → degrade
  }
}
```

> **Confirm the response shape before trusting the parser.** The mappers above assume SonarCloud's
> documented `issues[]` / `hotspots[]` fields. Verify against the live shape in the smoke (Step 5);
> if a field name differs, **stop and report** and fix the mapper against the observed JSON.

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- Do not throw from `defaultFetchSonar` — every failure path returns `unavailable: true`. A throw
  here would crash a poll instead of degrading.
- Do not read `SONAR_TOKEN` at module top-level — read it inside the function so tests and the env
  injection in Step 5 control it per-call.
- Do not hard-code the host; honour `SONAR_HOST_URL` (default `https://sonarcloud.io`).

---

## 3. Wire the fetch into `buildJudgeResult` and `run()`

**Files to change:**

- `src/poller/pr-readiness.ts`
- `src/poller/pr-readiness.test.ts`

**Implementation notes:**

Thread the seam through `run()` and `buildJudgeResult`. `run()` gains a fourth defaulted parameter:

```ts
export async function run(
  input: PollInput,
  step: Step,
  execGh: ExecGhFn = defaultExecGh,
  fetchSonar: FetchSonarFn = defaultFetchSonar,
): Promise<AttemptResult>
```

Make `buildJudgeResult` `async` and accept `fetchSonar`. Replace the stub block (current lines
158-165):

```ts
let sonar_issues: SonarIssue[] = [];
let sonar_hotspots_to_review: SonarHotspot[] = [];
let sonar_unavailable: boolean | undefined;

if (input.sonar_project) {
  const sonar = await fetchSonar(input.sonar_project, input.pr_number);  // pr_number resolved upstream
  sonar_issues = sonar.issues;
  sonar_hotspots_to_review = sonar.hotspots;
  if (sonar.unavailable) sonar_unavailable = true;
}
```

> **Interaction with Plan 0017:** if 0017 has landed, `input.pr_number` may be optional and resolved
> earlier in `run()` into a local `prNumber`; pass that resolved number into `buildJudgeResult` /
> `fetchSonar` instead of `input.pr_number`. If 0017 has not landed, `input.pr_number` is the number.
> Use whichever the merged code exposes — do not assume.

Add `sonar_hotspots_to_review` to the `ci_summary` object (it currently lists `sonar_issues`,
`human_reviews`, etc. at lines 187-198) and `await buildJudgeResult(...)` at the call site
(line 339).

**Unit tests to add/update** (`pr-readiness.test.ts`) — inject a fake `fetchSonar` as the 4th arg to
`run`:

- `sonar_project` present + fake returns `{ issues: [<2 issues>], hotspots: [], unavailable: false }`
  → judge step `input.sonar_issues` has 2 entries, `sonar_hotspots_to_review` is `[]`,
  `sonar_unavailable` absent.
- `sonar_project` present + fake returns one TO_REVIEW hotspot → `sonar_hotspots_to_review` has 1
  entry.
- `sonar_project` present + fake returns `{ unavailable: true }` → `sonar_unavailable: true`, judge
  step still emitted, `sonar_issues`/`sonar_hotspots_to_review` are `[]`.
- `sonar_project` absent → `fetchSonar` is **never called** (assert via a call counter), both arrays
  `[]`, no `sonar_unavailable`.
- Update the **existing** `'Sonar API unavailable: sonar_unavailable:true flag'` test
  (`pr-readiness.test.ts:183-201`): it currently simulates failure via a thrown `gh` call on a
  `sonarcloud` URL — that path no longer exists. Re-point it to inject a `fetchSonar` that returns
  `{ unavailable: true }`. Update the `'sonar_project absent'` test (lines 164-181) similarly — it
  no longer needs a `sonarcloud` route in the `execGh` fake; assert the injected `fetchSonar` is not
  called.
- `defaultFetchSonar` no-token path: with `SONAR_TOKEN` deleted from `process.env`, calling
  `defaultFetchSonar('k', 1)` resolves to `{ issues: [], hotspots: [], unavailable: true }` and makes
  no network call (no `fetch` reachable assertion needed — the no-token guard returns before `fetch`).

**Verify:**

```bash
npm run typecheck
npm test
```

**Stop conditions:**

- Do not change the `execGh` reviews/comments gathering. Only the Sonar block and the `ci_summary`
  assembly change.
- Keep `costs: []` — the poller remains zero-LLM, zero-cost even with the real Sonar fetch.
- Do not add `SONAR_TOKEN` to `work.ts` wiring; the poller reads env directly (see §0 key fact /
  `MAX_POLLS` precedent).

---

## 4. Update the `pr-watcher` judge prompt for hotspots + `sonar_unavailable`

**Files to change:**

- `control-plane/bootstrap.config.json` (the `pr-watcher` role row at line 658 — `system_prompt` only)

**Implementation notes:**

The current prompt already lists `sonar_issues` and includes "if ci_passed is true AND sonar_issues
is empty AND reviewDecision is not blocking … the PR is READY." Extend it to (a) consume
`sonar_hotspots_to_review`, (b) enforce zero-tolerance over ALL severities, and (c) handle
`sonar_unavailable` by surfacing to a human. Edit the prompt to add, in the structured-fields list,
`sonar_hotspots_to_review` and `sonar_unavailable`, and change the stopping criterion to text
equivalent to:

```text
Zero-tolerance Sonar policy: the PR is NOT ready if sonar_issues is non-empty (ANY severity —
BLOCKER through INFO) OR sonar_hotspots_to_review is non-empty. If either is non-empty, the verdict
is NEEDS_WORK and you must carry those issues/hotspots (component, line, rule, message) as findings
to the developer step. If sonar_unavailable is true, you CANNOT assert the PR is clean — do NOT
declare READY; set needsHuman true with an output explaining Sonar could not be reached, and
nextSteps []. Otherwise apply the full stopping criterion: READY only if ci_passed is true AND
sonar_issues is empty AND sonar_hotspots_to_review is empty AND sonar_unavailable is not true AND
reviewDecision is not blocking (neither CHANGES_REQUESTED nor REVIEW_REQUIRED) AND no human comment
is a blocking request-for-change.
```

Keep `model_level`, `effort`, `runner: "claude-code"`, `allowed_tools`, `scope_rules` unchanged.
Bump `updated_at` to `2026-06-04T00:00:00.000Z`.

**Verify:**

```bash
node -e "const c=require('./control-plane/bootstrap.config.json');const r=c.rows.find(x=>x.tableId==='roles'&&x.rowId==='pr-watcher');const p=r.data.system_prompt;if(!/sonar_hotspots_to_review/.test(p))throw new Error('pr-watcher prompt missing hotspots');if(!/sonar_unavailable/.test(p))throw new Error('pr-watcher prompt missing sonar_unavailable handling');console.log('OK pr-watcher prompt');"
```

**Stop conditions:**

- Change only the `pr-watcher` role's `system_prompt` (and `updated_at`). No schema/column changes.
- Do not weaken the existing `reviewDecision` / `human_reviews` handling — only add the Sonar
  hotspot + unavailable clauses.

---

## 5. Live smoke (manual — requires `SONAR_TOKEN` and a real PR)

**Files to change:**

- `scripts/smoke-pr-poller.ts` (extend the existing Plan 0011 smoke; `package.json` already has
  `smoke:pr-poller`)

**Implementation notes:**

This smoke is **not** in `npm test` — it needs a real `SONAR_TOKEN` (source `.env.sonar`) and a PR
that has a SonarCloud analysis. Extend the existing smoke:

1. Source `.env.sonar` (or require `SONAR_TOKEN` in env) and call
   `defaultFetchSonar('revisium_agent-orchestrator', <PR_NUMBER>)` directly.
2. Print the raw counts (`issues.length`, `hotspots.length`, `unavailable`) and the first few issues
   so the real SonarCloud `issues[]` / `hotspots[]` field shapes can be confirmed against Step 2's
   mapper.
3. Assert: with a valid token and a PR that has open issues, `unavailable` is `false` and
   `issues.length > 0` matches what the SonarCloud UI shows for that PR. With `SONAR_TOKEN` unset,
   `unavailable` is `true` and no network call is attempted.
4. Run the full `run(input, step, execGh, defaultFetchSonar)` against the real PR and confirm the
   emitted judge step's `input.sonar_issues` / `sonar_hotspots_to_review` are populated.

**Verify (manual):**

```bash
set -a; source .env.sonar; set +a
npm run smoke:pr-poller
```

**Stop conditions:**

- If the live SonarCloud JSON field names differ from Step 2's mapper, **stop and report** — fix the
  mapper against the observed shape before trusting the poller in production.
- Do not commit `.env.sonar` or any token. The smoke reads it from the (git-ignored) file/env only.

---

## 6. Final acceptance test

```bash
cd "$(git rev-parse --show-toplevel)"
npm install
npm run typecheck
npm run lint:ci
npm test
node -e "const c=require('./control-plane/bootstrap.config.json');const p=c.rows.find(x=>x.tableId==='roles'&&x.rowId==='pr-watcher').data.system_prompt;if(!/sonar_hotspots_to_review/.test(p)||!/sonar_unavailable/.test(p))throw new Error('pr-watcher prompt not updated');console.log('OK');"
npm run build
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
./bin/revo.js revisium start
./bin/revo.js bootstrap --commit
node --input-type=module -e "
import('./dist/control-plane/index.js').then(async m => {
  const pw = await m.loadRole('pr-watcher');
  console.assert(/sonar_hotspots_to_review/.test(pw.system_prompt), 'pr-watcher must consume hotspots');
  console.log('OK');
})"
git diff --check
./bin/revo.js revisium stop
```

**Slice is done when:** `fetchSonarIssues` is replaced by a real PR-scoped SonarCloud fetch
(`/api/issues/search` OPEN,CONFIRMED + `/api/hotspots/search` TO_REVIEW) behind an injectable
`FetchSonarFn` seam defaulted to a `fetch`-based implementation that reads `SONAR_TOKEN`/
`SONAR_HOST_URL` from env; the poller maps results into `ci_summary.sonar_issues` and
`ci_summary.sonar_hotspots_to_review`, degrades to `sonar_unavailable: true` (never crashes, never
silently passes) on missing-token / non-2xx / error; the `pr-watcher` prompt enforces zero-tolerance
over all severities + hotspots and surfaces `sonar_unavailable` to a human rather than declaring
READY; all unit tests pass at zero LLM/zero cost with no network; the loop, `WorkerDeps`, and
`ScriptRunner` are unchanged; and the manual smoke has confirmed the real SonarCloud JSON shape.

---

## 7. Report back / open findings

Report:

1. The transport/auth decision: direct HTTPS to `SONAR_HOST_URL` (default `https://sonarcloud.io`)
   via global `fetch`, basic auth `SONAR_TOKEN:` (mirroring `scripts/sonar-issues-local.sh`), token
   read from env inside the poller.
2. The `FetchSonarFn` seam and `SonarResult` shape; how `run()`/`buildJudgeResult` thread it; the
   three-valued degradation (`unavailable` vs clean-empty vs populated).
3. The deterministic/LLM split: poller GATHERS issues+hotspots (zero LLM, `costs: []`); judge DECIDES
   under zero-tolerance and on `sonar_unavailable`.
4. The two endpoints and exact query params used; the real SonarCloud JSON shape observed in the smoke.
5. The `pr-watcher` prompt change (hotspots + all-severity zero-tolerance + `sonar_unavailable`→human).
6. Validation: typecheck, lint, test, smoke output, confirmation of zero LLM cost and no network in
   unit tests.

Open findings / deferred:

- **Pagination** — `ps=500` (one page) matches the existing `sonar-issues-local.sh` cap. A PR with
  >500 open issues would truncate; log/handle multi-page if that ever occurs (today's PRs are far
  under). Surface the cap rather than silently truncating if `total > returned`.
- **New-issues-only vs all-open** — `pullRequest=<N>` already scopes to the PR's changed code per
  SonarCloud's PR analysis; confirm in the smoke that this matches the "new issues introduced by this
  PR" the gate uses, vs all open issues on the branch.
- **Self-hosted SonarQube** — only `SONAR_HOST_URL` is parameterised; on-prem token/auth differences
  are deferred.
- **Review-bot allow-list** — recognising the SonarCloud *comment* bot (vs reading the API) stays a
  Plan 0011 follow-up; this slice reads the API directly and no longer depends on the gate comment.

Needs human / ADR sign-off:

- **`SONAR_TOKEN` provisioning for the autonomous loop** — the unattended worker process must have
  `SONAR_TOKEN` in its environment (e.g. via `.env.sonar` or the service's secret store). Confirm how
  the token is injected for the long-running `revo work` process and that it is scoped read-only.
  Without it, every poll degrades to `sonar_unavailable` → every PR goes to a human.
