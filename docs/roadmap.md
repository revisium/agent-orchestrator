# Roadmap & doc status

Living page: per-doc status, dependencies, and the build-slice roadmap. Updated as each slice lands. The
[docs index](./README.md) stays lean — this page absorbs the churn.

> **Pivot in effect.** The architecture moved from a hand-rolled dumb loop to a **NestJS host + DBOS durable
> engine + Revisium as source of truth** — see [adr/0001-execution-engine-and-host.md](./adr/0001-execution-engine-and-host.md).
> The pre-pivot plans (`0001–0018`) were dropped; this page tracks the new MVP slices and which reference docs are
> rewritten, partially superseded, or still in force.

## Doc status & dependencies

| Doc | Status | Notes |
| --- | --- | --- |
| [architecture-overview](./architecture-overview.md) | **Rewritten** | orienting doc, post-pivot |
| [adr/0001-execution-engine-and-host](./adr/0001-execution-engine-and-host.md) | **Accepted** | DBOS + NestJS decision |
| [control-plane-schema](./control-plane-schema.md) | Partially superseded | `steps`/`attempts` → DBOS; meaning tables stay |
| [inbox-and-gates](./inbox-and-gates.md) | Updated | gate mechanic via `DBOS.recv`/`send` |
| [open-questions](./open-questions.md) | Updated | Q1/Q3 resolved (engine concern); Q2/Q4/Q5 stand |
| [context-budget](./context-budget.md) | In force | `buildContext` reused as-is |
| [runner-contract](./runner-contract.md) | In force | runner abstraction reused |
| [repo-layer-contract](./repo-layer-contract.md) | Partially superseded | meaning verbs stay; progress verbs → DBOS |
| [multi-repo-strategies](./multi-repo-strategies.md) | Deferred | post-MVP (workflow-as-data) |
| [getting-started](./getting-started.md) | Rewritten in slice 0006 | two-process boot + DBOS |

## Build-slice roadmap — MVP (vertical slice)

Goal: prove **NestJS host + DBOS engine + Revisium SSOT** with one real pipeline end-to-end, CLI-driven,
two-process Postgres, human gates — a single run from `run create` to an open PR.

| Plan | Status | Scope |
| --- | --- | --- |
| [0001 — Nest host + DBOS bootstrap](./plans/0001-nest-host-and-dbos-bootstrap.md) | **Landed** | NestJS app, lifecycle, ensure Revisium up, create `dbos` db, `DBOS.launch`; prove Nest↔DBOS seam |
| [0002 — Revisium Nest module](./plans/0002-revisium-nest-module.md) | **Landed** | wrap existing data-access (roles/policy/inbox/run) as Nest providers |
| [0003 — DBOS pipeline workflow](./plans/0003-dbos-pipeline-workflow.md) | **Landed** | `developTask` workflow (code), steps call `runAgent`, stub runner end-to-end |
| [0004 — Human gates via DBOS + inbox](./plans/0004-human-gates-via-dbos-inbox.md) | **Landed** | plan + merge gates: `pushInbox` → `DBOS.recv`; `inbox resolve` → `DBOS.send` |
| [0005 — Real runners + integrator](./plans/0005-real-runners-and-integrator.md) | **Landed** | Claude Code runner as Nest service; integrator branch/commit/PR |
| [0006 — End-to-end MVP](./plans/0006-end-to-end-mvp.md) | **Landed** | one `revo` command boot→run→PR; dogfood; rewrite getting-started |
| [0007 — Publishable alpha](./plans/0007-publishable-alpha.md) | **Landed** | `@revisium/orchestrator` packaging + seed test (PR #35) |
| [0008 — Alpha hardening](./plans/0008-alpha-hardening.md) | **Landed** | gh-account pinning, failure surfacing, per-attempt observability, params-as-data (PR #37) |

Plan files under [docs/plans/](./plans/) keep their original authoring status headers (Draft, or "Landed —
retrospective record" for 0007/0008, which were documented after execution); this table is the source of truth
for landed status.

## Dogfooding ladder

How the orchestrator earns its own development work, stage by stage. Each stage has an entry bar and an exit
criterion; we do not skip rungs. **Rule: every new slice in this roadmap is tagged with the stage it is executed
in (D0/D1/…) — as a `Stage: Dn` marker in its roadmap-table Scope cell and in the plan file's status header.**
Slices 0001–0008 predate the ladder and are untagged. See [vision.md](./vision.md) for where the ladder leads.

- **D0 — playbook-driven manual development** *(current)*. Tasks run manually via the canonical agent playbook
  (Claude Code / Codex as orchestrator). Architecture, process, and vision work lives here.
- **D1 — revo runs satellite tasks on its own repo** *(enterable now)*. Small, low-risk, well-specified tasks —
  docs fixes, small tests, single-file refactors — via `revo run create --start --wait --live`, both gates on. Goal: collect
  failures as requirements. Exit: ~10 merged PRs authored by revo.
- **D2 — revo is the default for routine work.** All bugfix / small-feature tickets go through revo; the manual
  playbook process is reserved for architecture. Entry requires: PR-comment processing (the review-threads slice),
  `revo up` single process, MCP entry, digest.
- **D3 — full slices through revo.** Whole features plan → gate → code → review → PR. Entry requires: plan-gate
  comments (binary approve breaks on real features) and an analyst step (or an extended architect).
- **D4 — playbook/runtime convergence.** Workflow-as-data; roles/pipelines imported from
  `@revisium/agent-playbook`; manual-run markdown becomes generated adapter output. After D4 a manual playbook
  run and a revo run are the same thing by construction.

## After MVP (not scheduled yet)

- **Playbook import:** `revo playbook install` reading `@revisium/agent-playbook` catalogs — playbooks as named,
  versioned sets of roles + pipelines + policies (see [vision.md](./vision.md) glossary). Positioned between D1
  and D2 on the ladder.
- **Front-door adapters:** REST API (read-only dashboard first) + MCP server, over the same core. The MCP entry
  gates D2.
- **Workflow as data:** a generic "execute plan" DBOS workflow that reads the next steps from Revisium —
  restoring the "workflow = data" invariant (ADR-0001 §5). The core of D4.
- **Multi-repo strategies:** primitives / engine / strategies (the old `multi-repo-strategies.md` design).
- **Learning memory:** cross-task KB recall ("we solved something like this before") feeding `buildContext` —
  the differentiating "agent memory" angle.
- **Pollers + review threads:** Sonar / CodeRabbit / CI poll + comment sorter (reuse `src/poller/pr-readiness.ts`);
  PR-comment processing gates D2.
- **Worktree isolation** for parallel runs touching the same repo.
- **Single process:** extract `startRevisium()` to boot Revisium in-process (ADR-0001 deferred option). `revo up`
  as one process gates D2.
- **Post-MVP cleanup:** delete the legacy step-lifecycle verbs (`claimNextStep`/`startAttempt`/`writeResult`/
  `failStep`/`recoverInFlight`) and the dumb loop, now superseded by DBOS.
