# Getting started

Run a local Revisium daemon as the orchestrator's control plane, bootstrap its schema, and drive the
architect→developer→reviewer→integrator pipeline from a single command.

## The model (two processes, one Postgres)

Two processes share one embedded Postgres server:

- **(a) Revisium standalone daemon** — owns the embedded Postgres; source of truth for *meaning*
  (roles, policy, inbox, events, cost rows). Runs as a background process managed by the `revo`
  CLI.
- **(b) NestJS host** — starts inside the CLI process when you run a host-requiring command (e.g.
  `run create --start`). It boots the **DBOS** engine, which connects to a separate `dbos` database
  on the same Postgres server and drives durable workflow execution.

One Postgres server, two databases: Revisium's own database + the `dbos` database the host creates
on first boot.

- **Revisium** holds *meaning* (versioned: roles/policy; draft: inbox/events).
- **DBOS** holds *progress* (which step ran, gate decisions, workflow state) — never in Revisium,
  never in files.

See [architecture-overview.md](./architecture-overview.md) and
[adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md).

## Prerequisites

- **Node.js `>=24.11.1 <25`** — check with `node --version`.
- `npm install` in `agent-orchestrator/` (installs the standalone runtime + native deps).
- `npm run build` (compiles TypeScript).
- `gh` auth + a clean target repo are needed only for the `--live` path (real Claude + real PR).
  The zero-cost stub path requires none of these.

## Step 1 — start the control plane

```bash
./bin/revo.js revisium start     # first run ~60–120s (downloads embedded PostgreSQL); later ~8s
./bin/revo.js revisium status    # running on http://localhost:<resolvedPort> — health OK
./bin/revo.js bootstrap --commit # creates the 10 control-plane tables and commits once
```

**Ports:** preferred HTTP `19222` / pg `15440`. If busy, the CLI scans upward and `start` prints
the **resolved** port; it is also persisted in `runtime.json`. Never hardcode a port.

On first boot the host will also create the `dbos` database automatically (idempotent).

## Step 2 — create a run and start the pipeline (stub path, zero cost)

```bash
./bin/revo.js run create --title "my task" --repo . --start --wait
```

This single command:
1. Creates the run in Revisium (mints a fresh `runId` — shown in the output).
2. Boots the in-CLI NestJS/DBOS host (ensure-Revisium → ensure `dbos` db → DBOS launch → ready).
3. Enqueues the durable `developTask` workflow (architect → developer → reviewer → integrator).
4. Attaches a live viewer that polls until the run parks at the **plan gate**, then prints:

```
parked:   run <runId> is waiting at the 'plan' gate
          resolve with: revo inbox resolve <gateId> --approve|--reject
```

**Re-attach note:** the `runId` printed in step 1 is the only identifier for this run.
To re-attach later (e.g. after a Ctrl-C), use `run start <thatId> --wait` — never a fresh
`run create`, which always mints a NEW run.

## Step 3 — resolve the plan gate

```bash
./bin/revo.js inbox list                                      # find the pending gate row
./bin/revo.js inbox resolve <gateId> --approve --wait        # approve + stay attached
```

With `--wait` the CLI stays attached through the developer/reviewer/integrator steps and surfaces
the **merge gate** prompt when the integrator finishes. Without `--wait` you may see a ~20s timeout
note before the merge gate opens — re-attach with:

```bash
./bin/revo.js run start <runId> --wait
```

## Step 4 — resolve the merge gate

```bash
./bin/revo.js inbox list                                      # find the merge gate row
./bin/revo.js inbox resolve <gateId> --approve               # approve to finish
```

Stub run: `prUrl = stub://pr/placeholder`.
Live run: a real draft PR URL.

## Live path (optional — costs money + makes real git changes)

```bash
./bin/revo.js run create --title "my task" --repo . --start --wait --live
```

> WARNING: --live runs real Claude (claude -p) and incurs token cost on
> architect/developer/reviewer, AND the real integrator will push a branch and open a draft PR.

Requires `gh` auth and a clean target repo (preflight blocks a dirty repo).

## Where state lives

```text
~/.revisium-orchestrator/
├── pgdata/          # embedded PostgreSQL (both Revisium DB + DBOS DB live here)
├── jwt-secret       # generated internal JWT secret
├── uploads/         # local file uploads
├── runtime.json     # { httpPort, pgPort, pid, startedAt } — written by `start`
└── standalone.log   # daemon stdout/stderr
```

**DBOS progress state lives in the `dbos` Postgres database** inside the embedded Postgres —
NOT in Revisium, NOT in a file. This state is durable across CLI restarts.

**Resume / re-attach:** `run start <existingRunId> --wait` — idempotent by `workflowID=runId`.
This resumes the SAME durable workflow from where it paused, with no duplicated steps or PRs.
A fresh `run create` (with or without `--start`) ALWAYS mints a new `runId` and starts a NEW run
— it is NOT a resume path.

## Ctrl-C safety

Pressing Ctrl-C on the `--wait` viewer preserves the run's durable state — it does NOT cancel
the workflow.

Because the host runs inside the CLI process, if this was the only host then **progress pauses**
on Ctrl-C (it does not keep running). The viewer returns cleanly on Ctrl-C so DBOS shuts down
normally via `app.close()`.

Resume with `revo run start <runId> --wait` — **not** `run show <runId>`, which is read-only and
does not boot a host or resume progress.

## Reset everything

```bash
./bin/revo.js revisium stop
rm -rf ~/.revisium-orchestrator
```

This wipes both the Revisium database AND the `dbos` database, since they share the embedded
Postgres.

## Next

- The system in one page: [architecture-overview.md](./architecture-overview.md)
- The tables you just created: [control-plane-schema.md](./control-plane-schema.md)
- Gate mechanics: [inbox-and-gates.md](./inbox-and-gates.md)
