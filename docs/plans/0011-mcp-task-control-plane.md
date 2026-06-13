# Plan 0011 — MCP task development control plane

> **Status: Implemented in this PR.** Stage: D2-enabling. Adds a local stdio MCP
> front door over the existing Nest/DBOS/Revisium core.

## Goal

Expose Revo as tools inside the developer's own agent so task development can
be managed without babysitting a terminal:

- inspect local orchestrator health;
- validate repository context;
- create/start/resume/cancel runs;
- inspect run status, events, attempt logs, and digest;
- resolve inbox gates and questions;
- discover playbooks, roles, and pipelines;
- simulate the current route before creating a run.

## Product Boundary

This is not a generic Revisium MCP server. The MCP surface exposes product
operations only. It must not provide raw table CRUD for control-plane rows.

The first transport is local stdio:

- no authentication;
- no HTTP listener;
- no remote/shared server mode;
- the MCP process boots the same host services as `run start`, so DBOS signals
  and workflow starts go through the existing core.

If a remote MCP transport is introduced later, authentication and permission
checks become a new explicit plan.

## Tool Groups

- System: `get_status`, `doctor`, `get_capabilities`.
- Repositories: `validate_repository`, `get_repository_context`.
- Project binding: `get_project`.
- Runs: `create_run`, `start_run`, `resume_run`, `cancel_run`, `list_runs`,
  `get_run`, `get_run_events`, `get_run_log`, `get_run_digest`.
- Inbox and gates: `list_inbox`, `get_inbox_item`, `get_pending_decisions`,
  `approve_gate`, `reject_gate`, `answer_question`, `resolve_inbox_item`,
  `summarize_gate_risk`.
- Playbooks and method: `install_playbook`, `list_playbooks`, `list_roles`,
  `get_role`, `list_pipelines`, `get_pipeline`, `simulate_route`.

## Acceptance

- `revo mcp` starts a stdio MCP server and keeps the host context alive until
  the MCP transport closes.
- Gate approval/rejection resolves the inbox row and signals the parked DBOS
  workflow with the stored answer.
- `answer_question` refuses plan/merge gates so a workflow is not accidentally
  left parked after a table-only resolution.
- The MCP server uses the existing Nest services; it does not reimplement
  Revisium data access or workflow start logic.
- Local verification passes: typecheck, lint, tests, build.
