# Plan 0012 — MCP API service boundary

> **Status: Implemented in this PR.** Stage: D2-enabling. Aligns the MCP front
> door with the Nest/API-layer boundary from the agent playbook method.

## Goal

Keep MCP as a protocol adapter and move task-control-plane application behavior
behind a protocol-neutral Nest provider.

The target call path is:

```text
MCP tools -> McpFacadeService -> TaskControlPlaneApiService -> Run/Inbox/Playbook/Pipeline/DBOS services
```

This prepares later REST or UI adapters to use the same module API without
copying MCP-specific code.

## Scope

- Add a `TaskControlPlaneApiService` that owns product operations currently used
  by MCP tools.
- Add a `TaskControlPlaneModule` that imports the core Engine, Revisium, and
  Pipeline modules and exports the API service.
- Keep `McpFacadeService` as a thin MCP adapter for transport capabilities and
  method delegation.
- Make `McpModule` depend on `TaskControlPlaneModule`, not directly on core
  services.
- Preserve the existing MCP tool surface and behavior.

## Non-goals

- Do not introduce `@nestjs/cqrs` in this slice.
- Do not change MCP tool names, schemas, or auth behavior.
- Do not add raw Revisium CRUD.
- Do not add REST, GraphQL, or UI adapters.

## Architecture Notes

The agent method's backend API-layer rule treats MCP as transport. The transport
layer maps protocol input/output; application behavior belongs behind a module
API service. CQRS can be introduced later if a follow-up route approves it, but
this slice only creates the API service boundary.

## Acceptance

- `McpFacadeService` no longer injects `RunService`, `InboxService`,
  `RolesService`, `PlaybooksService`, `PipelineService`, or `DbosService`
  directly.
- `McpModule` imports the task-control-plane module instead of importing core
  service modules directly.
- Existing MCP tool behavior remains covered by tests.
- Local verification passes: build, typecheck, lint, tests, and MCP stdio smoke.
